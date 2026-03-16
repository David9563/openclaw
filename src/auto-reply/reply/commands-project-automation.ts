import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfigDir } from "../../utils.js";
import type { CommandHandler } from "./commands-types.js";
import { stopWithText } from "./commands-subagents/shared.js";

const AUTOMATION_STATE_PATH = path.join(".openclaw", "automation-state.json");

const PAUSE_KEYWORDS = [/暂停/, /停止/, /冻结/, /\bpause\b/i, /\bstop\b/i, /\bfreeze\b/i];
const PAUSE_NEGATIONS = [
  /不要暂停/,
  /别暂停/,
  /不要停止/,
  /别停止/,
  /不要冻结/,
  /别冻结/,
  /不要停/,
  /别停/,
  /\bdo not pause\b/i,
  /\bdon't pause\b/i,
  /\bdo not stop\b/i,
  /\bdon't stop\b/i,
  /\bdo not freeze\b/i,
  /\bdon't freeze\b/i,
];

type ManagedProjectState = {
  path: string;
  json: Record<string, unknown>;
  projectId: string;
  agentId?: string;
  cronId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function readJsonIfExists(filePath: string): Promise<unknown | undefined> {
  try {
    const text = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
    return JSON.parse(text);
  } catch (error) {
    const code = error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : "";
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function loadManagedProjectState(workspaceDir: string): Promise<ManagedProjectState | null> {
  const statePath = path.join(workspaceDir, AUTOMATION_STATE_PATH);
  const raw = await readJsonIfExists(statePath);
  if (!isRecord(raw)) {
    return null;
  }
  const project = isRecord(raw.project) ? raw.project : undefined;
  const cron = isRecord(raw.cron) ? raw.cron : undefined;
  const projectId = readString(project?.projectId);
  const cronId = readString(cron?.id);
  if (!projectId || !cronId) {
    return null;
  }
  return {
    path: statePath,
    json: raw,
    projectId,
    agentId: readString(project?.agentId),
    cronId,
  };
}

function shouldPauseAutomation(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/")) {
    return false;
  }
  if (PAUSE_NEGATIONS.some((pattern) => pattern.test(trimmed))) {
    return false;
  }
  return PAUSE_KEYWORDS.some((pattern) => pattern.test(trimmed));
}

async function pauseManagedProjectAutomation(params: {
  workspaceDir: string;
}): Promise<{
  projectId: string;
  cronId: string;
  cronDisabled: boolean;
  cronAlreadyDisabled: boolean;
  projectRegistryUpdated: boolean;
  automationStateUpdated: boolean;
}> {
  const managed = await loadManagedProjectState(params.workspaceDir);
  if (!managed) {
    throw new Error("managed project automation state not found");
  }

  const configDir = resolveConfigDir();
  const cronStorePath = path.join(configDir, "cron", "jobs.json");
  const registryPath = path.join(configDir, "workspace-project-ops", "PROJECTS.json");
  const now = Date.now();

  let cronDisabled = false;
  let cronAlreadyDisabled = false;
  const cronStore = await readJsonIfExists(cronStorePath);
  if (isRecord(cronStore) && Array.isArray(cronStore.jobs)) {
    const job = cronStore.jobs.find(
      (entry) => isRecord(entry) && readString(entry.id) === managed.cronId,
    ) as Record<string, unknown> | undefined;
    if (job) {
      if (job.enabled === false) {
        cronAlreadyDisabled = true;
      } else {
        job.enabled = false;
        cronDisabled = true;
      }
      job.updatedAtMs = now;
      if (isRecord(job.state)) {
        delete job.state.nextRunAtMs;
      }
      await writeJson(cronStorePath, cronStore);
    }
  }

  let projectRegistryUpdated = false;
  const registry = await readJsonIfExists(registryPath);
  if (isRecord(registry) && Array.isArray(registry.projects)) {
    const project = registry.projects.find(
      (entry) =>
        isRecord(entry) &&
        (readString(entry.projectId) === managed.projectId ||
          readString(entry.cronId) === managed.cronId ||
          (managed.agentId && readString(entry.agentId) === managed.agentId)),
    ) as Record<string, unknown> | undefined;
    if (project) {
      const wasPaused = readString(project.status) === "paused" && project.cronEnabled === false;
      project.status = "paused";
      project.cronEnabled = false;
      if (!wasPaused) {
        projectRegistryUpdated = true;
      }
      await writeJson(registryPath, registry);
    }
  }

  let automationStateUpdated = false;
  const cron = isRecord(managed.json.cron) ? managed.json.cron : undefined;
  if (cron) {
    const wasPaused = readString(cron.status) === "paused";
    cron.status = "paused";
    cron.pausedAt = now;
    if (!wasPaused) {
      automationStateUpdated = true;
    }
  }
  await writeJson(managed.path, managed.json);

  return {
    projectId: managed.projectId,
    cronId: managed.cronId,
    cronDisabled,
    cronAlreadyDisabled,
    projectRegistryUpdated,
    automationStateUpdated,
  };
}

function renderPauseReply(result: {
  projectId: string;
  cronId: string;
  cronDisabled: boolean;
  cronAlreadyDisabled: boolean;
  projectRegistryUpdated: boolean;
  automationStateUpdated: boolean;
}): string {
  const cronStatus = result.cronDisabled
    ? "已硬停"
    : result.cronAlreadyDisabled
      ? "原本就是停用状态"
      : "已写入暂停状态";
  const updates = [
    result.projectRegistryUpdated ? "PROJECTS 已改为 paused" : undefined,
    result.automationStateUpdated ? "automation-state 已改为 paused" : undefined,
  ].filter(Boolean);

  return [
    "✅ 已先执行硬动作，再回复你。",
    `- 项目：${result.projectId}`,
    `- cron：${result.cronId}（${cronStatus}）`,
    `- 托管状态：${updates.length > 0 ? updates.join("；") : "已确认暂停态"}`,
    "后续我不会继续自动开发；等你明确说“恢复开发”或“恢复 cron”再继续。",
  ].join("\n");
}

export const handleProjectAutomationCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands || !params.command.isAuthorizedSender) {
    return null;
  }
  if (!shouldPauseAutomation(params.command.commandBodyNormalized)) {
    return null;
  }

  const managed = await loadManagedProjectState(params.workspaceDir);
  if (!managed) {
    return null;
  }

  const result = await pauseManagedProjectAutomation({
    workspaceDir: params.workspaceDir,
  });
  return stopWithText(renderPauseReply(result));
};
