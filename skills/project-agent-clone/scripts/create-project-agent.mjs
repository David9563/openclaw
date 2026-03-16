import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md"];
const MANAGED_BLOCK_START = "<!-- openclaw-project-agent:start -->";
const MANAGED_BLOCK_END = "<!-- openclaw-project-agent:end -->";

function fail(message, details) {
  const payload = {
    ok: false,
    error: message,
    ...(details ? { details } : {}),
  };
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    projectPath: "",
    task: "",
    agentId: "",
    ownerAgentId: "",
    workspace: "",
    dryRun: false,
    copyAuth: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--project-path":
        options.projectPath = argv[++index] ?? "";
        break;
      case "--task":
        options.task = argv[++index] ?? "";
        break;
      case "--agent-id":
        options.agentId = argv[++index] ?? "";
        break;
      case "--owner-agent-id":
        options.ownerAgentId = argv[++index] ?? "";
        break;
      case "--workspace":
        options.workspace = argv[++index] ?? "";
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--no-copy-auth":
        options.copyAuth = false;
        break;
      default:
        fail(`Unknown argument: ${token}`);
    }
  }

  if (!options.projectPath.trim()) {
    fail("Missing required --project-path");
  }

  return options;
}

function slugify(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/g, "")
    .replace(/-+$/g, "")
    .replace(/-{2,}/g, "-");
  return normalized || "project";
}

function resolveStateDir() {
  const configured = process.env.OPENCLAW_STATE_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(os.homedir(), ".openclaw");
}

function resolveScriptDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function resolveLocalCliFromParents(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, "openclaw.mjs");
    try {
      if (requireFile(candidate)) {
        return candidate;
      }
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function requireFile(filePath) {
  return fsSync.existsSync(filePath);
}

function shellName(base) {
  return process.platform === "win32" ? `${base}.cmd` : base;
}

function resolveOpenClawInvocation() {
  const explicit = process.env.OPENCLAW_CLI?.trim();
  if (explicit) {
    return { command: process.execPath, args: [path.resolve(explicit)] };
  }

  const localCli = resolveLocalCliFromParents(resolveScriptDir());
  if (localCli) {
    return { command: process.execPath, args: [localCli] };
  }

  const npmRoot = spawnSync(shellName("npm"), ["root", "-g"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (npmRoot.status === 0) {
    const rootDir = npmRoot.stdout.trim();
    const candidate = path.join(rootDir, "openclaw", "openclaw.mjs");
    if (candidate && requireFile(candidate)) {
      return { command: process.execPath, args: [candidate] };
    }
  }

  return { command: shellName("openclaw"), args: [] };
}

function runOpenClaw(args, options = {}) {
  const cli = resolveOpenClawInvocation();
  const result = spawnSync(cli.command, [...cli.args, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: process.env,
    cwd: options.cwd ?? process.cwd(),
  });
  if (result.status !== 0) {
    fail("OpenClaw CLI command failed", {
      command: [cli.command, ...cli.args, ...args].join(" "),
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      status: result.status,
    });
  }
  return result.stdout.trim();
}

function tryRunOpenClaw(args, options = {}) {
  const cli = resolveOpenClawInvocation();
  const result = spawnSync(cli.command, [...cli.args, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: process.env,
    cwd: options.cwd ?? process.cwd(),
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    command: [cli.command, ...cli.args, ...args].join(" "),
  };
}

function parseJsonOutput(output, context) {
  try {
    return JSON.parse(output);
  } catch (error) {
    const lines = String(output ?? "").split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const candidate = lines.slice(index).join("\n").trim();
      if (!candidate || (!candidate.startsWith("{") && !candidate.startsWith("["))) {
        continue;
      }
      try {
        return JSON.parse(candidate);
      } catch {}
    }

    fail(`Failed to parse JSON output for ${context}`, {
      output,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function resolveOwnerAgent(agents, explicitOwnerId) {
  const explicit = explicitOwnerId.trim().toLowerCase();
  if (explicit) {
    const match = agents.find((entry) => String(entry.id).trim().toLowerCase() === explicit);
    if (match) {
      return match;
    }
    fail(`Owner agent not found: ${explicitOwnerId}`);
  }
  return agents.find((entry) => entry.isDefault) ?? agents[0] ?? null;
}

async function ensureDir(dirPath, dryRun) {
  if (dryRun) {
    return;
  }
  await fs.mkdir(dirPath, { recursive: true });
}

async function copyIfExists(source, target, dryRun) {
  try {
    await fs.access(source);
  } catch {
    return false;
  }
  if (!dryRun) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
  return true;
}

async function copyDirIfExists(sourceDir, targetDir, dryRun) {
  try {
    await fs.access(sourceDir);
  } catch {
    return false;
  }
  if (!dryRun) {
    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    await fs.cp(sourceDir, targetDir, { recursive: true, force: true });
  }
  return true;
}

async function updateManagedAgentsNote(workspaceDir, payload, dryRun) {
  const agPath = path.join(workspaceDir, "AGENTS.md");
  let content = "";
  try {
    content = await fs.readFile(agPath, "utf8");
  } catch {
    content = "";
  }

  const managedBlock = [
    MANAGED_BLOCK_START,
    "## Project Assignment",
    `- Project agent id: ${payload.agentId}`,
    `- Owner agent id: ${payload.ownerAgentId}`,
    `- Project path: ${payload.projectPath}`,
    "- Read `PROJECT.md` at the start of a new project run.",
    "- For multi-feature projects needing requirements analysis and task planning, prefer the `pm-agent` skill.",
    "- For frontend/UI design, redesign, or polish work, prefer the `frontend-ui-designer` skill.",
    "- For Codex-driven implementation with progress monitoring, prefer the `codex-dev-monitor` skill.",
    "- Do not commit, push, or create branches unless the user explicitly asks.",
    MANAGED_BLOCK_END,
  ].join("\n");

  const stripped = content.includes(MANAGED_BLOCK_START)
    ? content.replace(
        new RegExp(`${MANAGED_BLOCK_START}[\\s\\S]*?${MANAGED_BLOCK_END}\\n?`, "g"),
        "",
      )
    : content;
  const next = stripped.trimEnd()
    ? `${stripped.trimEnd()}\n\n${managedBlock}\n`
    : `${managedBlock}\n`;

  if (!dryRun) {
    await fs.writeFile(agPath, next, "utf8");
  }
}

async function writeProjectFile(workspaceDir, payload, dryRun) {
  const lines = [
    "# Project Assignment",
    "",
    `- Project agent id: ${payload.agentId}`,
    `- Owner agent id: ${payload.ownerAgentId}`,
    `- Project path: ${payload.projectPath}`,
    `- Created at: ${new Date().toISOString()}`,
    "- Do not commit, push, or create branches unless the user explicitly asks.",
  ];
  if (payload.task) {
    lines.push("", "## Requested Task", "", payload.task.trim());
  }
  if (!dryRun) {
    await fs.writeFile(path.join(workspaceDir, "PROJECT.md"), lines.join("\n") + "\n", "utf8");
  }
}

function maybeParseArray(raw) {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readConfigJson(pathExpr, context) {
  return parseJsonOutput(runOpenClaw(["config", "get", pathExpr, "--json"]), context);
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

function uniqueStrings(values) {
  return Array.from(new Set(normalizeStringArray(values)));
}

function arraysEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function setConfigValue(pathExpr, value, dryRun, options = {}) {
  if (dryRun) {
    return;
  }
  const args = ["config", "set", pathExpr];
  if (options.strictJson) {
    args.push(JSON.stringify(value), "--strict-json");
  } else {
    args.push(String(value));
  }
  runOpenClaw(args);
}

function resolveAgentConfigIndex(configAgents, agentId) {
  const targetId = String(agentId ?? "").trim().toLowerCase();
  return configAgents.findIndex(
    (entry) => String(entry?.id ?? "").trim().toLowerCase() === targetId,
  );
}

function ensureProjectAgentTooling(configAgents, agentIndex, dryRun) {
  if (agentIndex < 0) {
    return {
      updated: false,
      profileBefore: null,
      profileAfter: null,
      alsoAllowBefore: [],
      alsoAllowAfter: [],
      execDefaultsApplied: [],
    };
  }

  const entry = configAgents[agentIndex] ?? {};
  const tools =
    entry && typeof entry === "object" && entry.tools && typeof entry.tools === "object"
      ? entry.tools
      : {};
  const profileBefore = typeof tools.profile === "string" ? tools.profile.trim() : "";
  const shouldUpgradeProfile = !profileBefore || profileBefore === "messaging";
  const profileAfter = shouldUpgradeProfile ? "coding" : profileBefore || null;
  const alsoAllowBefore = uniqueStrings(tools.alsoAllow);
  const alsoAllowAfter = uniqueStrings([...alsoAllowBefore, "browser"]);
  const execTools =
    tools.exec && typeof tools.exec === "object" && !Array.isArray(tools.exec) ? tools.exec : {};
  const execDefaultsApplied = [];

  if (shouldUpgradeProfile) {
    setConfigValue(`agents.list[${agentIndex}].tools.profile`, "coding", dryRun);
  }

  if (!arraysEqual(alsoAllowBefore, alsoAllowAfter)) {
    setConfigValue(`agents.list[${agentIndex}].tools.alsoAllow`, alsoAllowAfter, dryRun, {
      strictJson: true,
    });
  }

  if (!execTools.host) {
    execDefaultsApplied.push("host");
    setConfigValue(`agents.list[${agentIndex}].tools.exec.host`, "gateway", dryRun);
  }
  if (!execTools.security) {
    execDefaultsApplied.push("security");
    setConfigValue(`agents.list[${agentIndex}].tools.exec.security`, "full", dryRun);
  }
  if (!execTools.ask) {
    execDefaultsApplied.push("ask");
    setConfigValue(`agents.list[${agentIndex}].tools.exec.ask`, "off", dryRun);
  }

  return {
    updated:
      shouldUpgradeProfile ||
      !arraysEqual(alsoAllowBefore, alsoAllowAfter) ||
      execDefaultsApplied.length > 0,
    profileBefore: profileBefore || null,
    profileAfter,
    alsoAllowBefore,
    alsoAllowAfter,
    execDefaultsApplied,
  };
}

function ensureAgentToAgentAllowlist(toolsConfig, agentId, dryRun) {
  const tools =
    toolsConfig && typeof toolsConfig === "object" && !Array.isArray(toolsConfig) ? toolsConfig : {};
  const agentToAgent =
    tools.agentToAgent &&
    typeof tools.agentToAgent === "object" &&
    !Array.isArray(tools.agentToAgent)
      ? tools.agentToAgent
      : {};
  const allowBefore = uniqueStrings(agentToAgent.allow);
  if (allowBefore.includes("*")) {
    return {
      updated: false,
      allowBefore,
      allowAfter: allowBefore,
    };
  }
  const allowAfter = uniqueStrings([...allowBefore, agentId]);
  const updated = !arraysEqual(allowBefore, allowAfter);
  if (updated) {
    setConfigValue("tools.agentToAgent.allow", allowAfter, dryRun, { strictJson: true });
  }
  return {
    updated,
    allowBefore,
    allowAfter,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const projectPath = path.resolve(opts.projectPath);
  const projectName = path.basename(projectPath);
  const stateDir = resolveStateDir();

  try {
    await fs.access(projectPath);
  } catch {
    fail(`Project path does not exist: ${projectPath}`);
  }

  const agents = parseJsonOutput(runOpenClaw(["agents", "list", "--json"]), "agents list");
  if (!Array.isArray(agents) || agents.length === 0) {
    fail("No agents found in OpenClaw config");
  }
  const configAgents = readConfigJson("agents.list", "config get agents.list");
  if (!Array.isArray(configAgents) || configAgents.length === 0) {
    fail("No configured agents found in OpenClaw config");
  }
  const globalToolsConfig = readConfigJson("tools", "config get tools");

  const owner = resolveOwnerAgent(agents, opts.ownerAgentId);
  if (!owner) {
    fail("Could not resolve owner agent");
  }

  const agentId = slugify(opts.agentId || `project-${projectName}`);
  const workspace =
    opts.workspace.trim() || path.join(stateDir, `workspace-${agentId}`);
  const agentDir = path.join(stateDir, "agents", agentId, "agent");

  const existing = agents.find((entry) => String(entry.id).trim().toLowerCase() === agentId);
  let created = false;
  let reused = false;
  let createdPayload = null;

  if (!existing) {
    if (!opts.dryRun) {
      createdPayload = parseJsonOutput(
        runOpenClaw(
          [
            "agents",
            "add",
            agentId,
            "--workspace",
            workspace,
            "--agent-dir",
            agentDir,
            "--non-interactive",
            "--json",
          ],
          {},
        ),
        "agents add",
      );
    }
    created = true;
  } else {
    reused = true;
  }

  const effectiveWorkspace = existing?.workspace || createdPayload?.workspace || workspace;
  const effectiveAgentDir = existing?.agentDir || createdPayload?.agentDir || agentDir;

  await ensureDir(effectiveWorkspace, opts.dryRun);

  const copiedBootstrapFiles = [];
  for (const fileName of BOOTSTRAP_FILES) {
    const copied = await copyIfExists(
      path.join(owner.workspace, fileName),
      path.join(effectiveWorkspace, fileName),
      opts.dryRun,
    );
    if (copied) {
      copiedBootstrapFiles.push(fileName);
    }
  }

  const copiedSkills = [];
  if (
    await copyDirIfExists(
      path.join(owner.workspace, "skills"),
      path.join(effectiveWorkspace, "skills"),
      opts.dryRun,
    )
  ) {
    copiedSkills.push("skills");
  }
  if (
    await copyDirIfExists(
      path.join(owner.workspace, ".agents", "skills"),
      path.join(effectiveWorkspace, ".agents", "skills"),
      opts.dryRun,
    )
  ) {
    copiedSkills.push(".agents/skills");
  }

  const payload = {
    agentId,
    ownerAgentId: owner.id,
    projectPath,
    workspace: effectiveWorkspace,
    agentDir: effectiveAgentDir,
    created,
    reused,
    dryRun: opts.dryRun,
    task: opts.task.trim(),
  };

  await updateManagedAgentsNote(effectiveWorkspace, payload, opts.dryRun);
  await writeProjectFile(effectiveWorkspace, payload, opts.dryRun);

  let authCopied = false;
  if (opts.copyAuth) {
    authCopied = await copyIfExists(
      path.join(owner.agentDir, "auth-profiles.json"),
      path.join(effectiveAgentDir, "auth-profiles.json"),
      opts.dryRun,
    );
  }

  const ownerIndex = resolveAgentConfigIndex(configAgents, owner.id);
  let allowAgentsBefore = [];
  let allowAgentsAfter = [];
  let allowlistUpdated = false;
  if (ownerIndex >= 0) {
    if (!opts.dryRun) {
      const raw = tryRunOpenClaw([
        "config",
        "get",
        `agents.list[${ownerIndex}].subagents.allowAgents`,
        "--json",
      ]);
      allowAgentsBefore = raw.ok ? maybeParseArray(raw.stdout) : [];
    }
    allowAgentsAfter = [...allowAgentsBefore];
    if (!allowAgentsAfter.includes("*") && !allowAgentsAfter.includes(agentId)) {
      allowAgentsAfter.push(agentId);
      allowlistUpdated = true;
      if (!opts.dryRun) {
        runOpenClaw([
          "config",
          "set",
          `agents.list[${ownerIndex}].subagents.allowAgents`,
          JSON.stringify(allowAgentsAfter),
          "--strict-json",
        ]);
      }
    }
  }

  const refreshedConfigAgents = opts.dryRun ? configAgents : readConfigJson("agents.list", "config get agents.list (post-create)");
  const targetAgentIndex = resolveAgentConfigIndex(refreshedConfigAgents, agentId);
  const tooling = ensureProjectAgentTooling(refreshedConfigAgents, targetAgentIndex, opts.dryRun);
  const refreshedToolsConfig = opts.dryRun
    ? globalToolsConfig
    : readConfigJson("tools", "config get tools (post-tooling)");
  const agentToAgent = ensureAgentToAgentAllowlist(refreshedToolsConfig, agentId, opts.dryRun);

  console.log(
    JSON.stringify(
      {
        ok: true,
        agentId,
        ownerAgentId: owner.id,
        projectPath,
        workspace: effectiveWorkspace,
        agentDir: effectiveAgentDir,
        created,
        reused,
        dryRun: opts.dryRun,
        copiedBootstrapFiles,
        copiedSkills,
        authCopied,
        allowlistUpdated,
        allowAgentsBefore,
        allowAgentsAfter,
        tooling,
        agentToAgent,
      },
      null,
      2,
    ),
  );
}

await main();
