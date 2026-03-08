import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AGENT_LANE_NESTED } from "../../agents/lanes.js";
import { splitArgsPreservingQuotes } from "../../daemon/arg-split.js";
import { execFileUtf8 } from "../../daemon/exec-file.js";
import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import { formatZonedTimestamp } from "../../infra/format-time/format-datetime.ts";
import { formatRelativeTimestamp } from "../../infra/format-time/format-relative.ts";
import { resolveConfigDir } from "../../utils.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";
import { extractAssistantText, stopWithText, stripToolMessages } from "./commands-subagents/shared.js";

const COMMAND = "/ops";
const PROJECT_OPS_AGENT_ID = "project-ops";
const PROJECT_OPS_SESSION_KEY = `agent:${PROJECT_OPS_AGENT_ID}:main`;
const DIRECT_ACTIONS = new Set<OpsAction>(["list", "status", "onboard", "pause", "resume", "run"]);
const PROJECT_TYPE_VALUES = new Set<OnboardProjectType>(["auto", "web", "service", "generic"]);

type OpsAction = "list" | "status" | "onboard" | "pause" | "resume" | "run" | "doctor" | "help";
type OnboardProjectType = "auto" | "web" | "service" | "generic";

type ParsedOpsCommand =
  | { action: "help" }
  | { action: "list" }
  | { action: "status"; projectId: string }
  | {
      action: "onboard";
      projectId: string;
      repoPath: string;
      projectType?: OnboardProjectType;
      scheduleEvery?: string;
      previewPort?: number;
      runNow: boolean;
    }
  | { action: "pause"; projectId: string }
  | { action: "resume"; projectId: string }
  | { action: "run"; projectId: string }
  | { action: "doctor"; projectId?: string };

type ParseOpsResult = { ok: true; command: ParsedOpsCommand } | { ok: false; error: string };

type ProjectSnapshot = {
  projectId: string;
  agentId?: string;
};

type ProjectView = {
  projectId: string;
  status?: string;
  repoPath?: string;
  projectType?: string;
  agentId?: string;
  previewPort?: number;
  cronId?: string;
  cronName?: string;
  cronEnabled?: boolean;
  cronLastStatus?: string;
  cronNextRunAtMs?: number;
  docUrl?: string;
};

type ProjectManagerResult = {
  ok: boolean;
  action?: string;
  error?: string;
  defaults?: Record<string, unknown>;
  projects?: ProjectView[];
  project?: ProjectView;
  cron?: {
    id?: string;
    name?: string;
    enabled?: boolean;
    nextRunAtMs?: number;
  };
  doc?: {
    token?: string;
    url?: string;
    blocked?: boolean;
    message?: string;
  };
  changed?: string[];
  runTriggered?: boolean;
  projectId?: string;
  cronId?: string;
  triggered?: boolean;
};

type ProjectManagerInvokeResult =
  | { kind: "ok"; payload: ProjectManagerResult }
  | { kind: "timeout" }
  | { kind: "error"; error: string; retryable: boolean };

type FallbackInvokeResult =
  | { kind: "ok"; reply: string }
  | { kind: "timeout"; runId?: string }
  | { kind: "error"; error: string };

const ACTION_TIMEOUT_MS: Record<Exclude<OpsAction, "help">, number> = {
  list: 30_000,
  status: 30_000,
  pause: 30_000,
  resume: 30_000,
  run: 30_000,
  onboard: 90_000,
  doctor: 90_000,
};

const ACTION_ALIASES = new Map<string, OpsAction>([
  ["list", "list"],
  ["ls", "list"],
  ["列表", "list"],
  ["列出", "list"],
  ["status", "status"],
  ["状态", "status"],
  ["onboard", "onboard"],
  ["接管", "onboard"],
  ["pause", "pause"],
  ["暂停", "pause"],
  ["resume", "resume"],
  ["恢复", "resume"],
  ["run", "run"],
  ["执行", "run"],
  ["doctor", "doctor"],
  ["诊断", "doctor"],
  ["help", "help"],
  ["帮助", "help"],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeProjectView(value: unknown): ProjectView | null {
  if (!isRecord(value)) {
    return null;
  }
  const projectId = readString(value.projectId);
  if (!projectId) {
    return null;
  }
  return {
    projectId,
    status: readString(value.status),
    repoPath: readString(value.repoPath),
    projectType: readString(value.projectType),
    agentId: readString(value.agentId),
    previewPort: readNumber(value.previewPort),
    cronId: readString(value.cronId),
    cronName: readString(value.cronName),
    cronEnabled: readBoolean(value.cronEnabled),
    cronLastStatus: readString(value.cronLastStatus),
    cronNextRunAtMs: readNumber(value.cronNextRunAtMs),
    docUrl: readString(value.docUrl),
  };
}

function normalizeProjectManagerResult(value: unknown): ProjectManagerResult | null {
  if (!isRecord(value)) {
    return null;
  }
  const ok = readBoolean(value.ok);
  if (ok == null) {
    return null;
  }
  const projectsRaw = Array.isArray(value.projects) ? value.projects : undefined;
  const project = normalizeProjectView(value.project) ?? undefined;
  return {
    ok,
    action: readString(value.action),
    error: readString(value.error),
    defaults: isRecord(value.defaults) ? value.defaults : undefined,
    projects: projectsRaw?.map((entry) => normalizeProjectView(entry)).filter((entry) => entry !== null),
    project,
    cron: isRecord(value.cron)
      ? {
          id: readString(value.cron.id),
          name: readString(value.cron.name),
          enabled: readBoolean(value.cron.enabled),
          nextRunAtMs: readNumber(value.cron.nextRunAtMs),
        }
      : undefined,
    doc: isRecord(value.doc)
      ? {
          token: readString(value.doc.token),
          url: readString(value.doc.url),
          blocked: readBoolean(value.doc.blocked),
          message: readString(value.doc.message),
        }
      : undefined,
    changed: Array.isArray(value.changed)
      ? value.changed.map((entry) => readString(entry)).filter((entry): entry is string => Boolean(entry))
      : undefined,
    runTriggered: readBoolean(value.runTriggered),
    projectId: readString(value.projectId),
    cronId: readString(value.cronId),
    triggered: readBoolean(value.triggered),
  };
}

function parseLooseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some shells prepend warnings before JSON; retry from the first object/array delimiter.
  }
  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (char !== "{" && char !== "[") {
      continue;
    }
    try {
      return JSON.parse(trimmed.slice(index));
    } catch {
      // Keep scanning until we find a parsable payload.
    }
  }
  return undefined;
}

function normalizeActionToken(token: string | undefined): OpsAction | undefined {
  if (!token) {
    return undefined;
  }
  return ACTION_ALIASES.get(token.trim().toLowerCase()) ?? ACTION_ALIASES.get(token.trim());
}

function parseFlagToken(token: string): { name: string; value?: string } | null {
  if (!token.startsWith("--")) {
    return null;
  }
  const withoutPrefix = token.slice(2);
  const eqIndex = withoutPrefix.indexOf("=");
  if (eqIndex === -1) {
    return { name: withoutPrefix.toLowerCase() };
  }
  return {
    name: withoutPrefix.slice(0, eqIndex).toLowerCase(),
    value: withoutPrefix.slice(eqIndex + 1),
  };
}

function renderOpsHelp(): string {
  return [
    "🛠️ /ops 同步命令",
    "- /ops list",
    "- /ops status <projectId>",
    "- /ops onboard <projectId> <repoPath> [--type auto|web|service|generic] [--every 15m] [--port 8123] [--run-now]",
    "- /ops pause <projectId>",
    "- /ops resume <projectId>",
    "- /ops run <projectId>",
    "- /ops doctor [projectId]",
    "- /ops help",
    "",
    "中文别名：",
    "- /ops 列表",
    "- /ops 状态 smart-factory",
    '- /ops 接管 demo "D:\\demo" --every 15m',
    "- /ops 暂停 smart-factory",
    "- /ops 恢复 smart-factory",
    "- /ops 执行 smart-factory",
  ].join("\n");
}

function parseOpsCommand(normalizedCommandBody: string): ParseOpsResult | null {
  if (!/^\/ops(?:\s|$)/i.test(normalizedCommandBody)) {
    return null;
  }

  const rest = normalizedCommandBody.slice(COMMAND.length).trim();
  if (!rest) {
    return { ok: true, command: { action: "help" } };
  }

  const tokens = splitArgsPreservingQuotes(rest);
  const action = normalizeActionToken(tokens[0]);
  if (!action) {
    return { ok: false, error: `Unknown /ops action: ${tokens[0]}` };
  }
  if (action === "help") {
    return { ok: true, command: { action: "help" } };
  }
  if (action === "list") {
    return { ok: true, command: { action: "list" } };
  }

  const args = tokens.slice(1);
  if (action === "status" || action === "pause" || action === "resume" || action === "run") {
    const projectId = args[0]?.trim();
    if (!projectId) {
      return { ok: false, error: `Usage: /ops ${action} <projectId>` };
    }
    return { ok: true, command: { action, projectId } };
  }

  if (action === "doctor") {
    return {
      ok: true,
      command: {
        action,
        projectId: args[0]?.trim() || undefined,
      },
    };
  }

  const positional: string[] = [];
  let projectType: OnboardProjectType | undefined;
  let scheduleEvery: string | undefined;
  let previewPort: number | undefined;
  let runNow = false;

  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    const flag = parseFlagToken(token);
    if (!flag) {
      positional.push(token);
      continue;
    }

    const resolveValue = () => {
      if (flag.value != null) {
        return flag.value;
      }
      const next = args[index + 1];
      if (!next || next.startsWith("--")) {
        return undefined;
      }
      index += 1;
      return next;
    };

    switch (flag.name) {
      case "type": {
        const value = resolveValue()?.trim().toLowerCase();
        if (!value || !PROJECT_TYPE_VALUES.has(value as OnboardProjectType)) {
          return { ok: false, error: "Usage: --type auto|web|service|generic" };
        }
        projectType = value as OnboardProjectType;
        break;
      }
      case "every": {
        const value = resolveValue()?.trim();
        if (!value) {
          return { ok: false, error: "Usage: --every <duration>" };
        }
        scheduleEvery = value;
        break;
      }
      case "port": {
        const value = resolveValue()?.trim();
        const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return { ok: false, error: "Usage: --port <number>" };
        }
        previewPort = parsed;
        break;
      }
      case "run-now":
        runNow = true;
        break;
      default:
        return { ok: false, error: `Unknown /ops flag: --${flag.name}` };
    }
  }

  const projectId = positional[0]?.trim();
  const repoPath = positional[1]?.trim();
  if (!projectId || !repoPath) {
    return {
      ok: false,
      error:
        "Usage: /ops onboard <projectId> <repoPath> [--type auto|web|service|generic] [--every 15m] [--port 8123] [--run-now]",
    };
  }

  return {
    ok: true,
    command: {
      action,
      projectId,
      repoPath,
      ...(projectType ? { projectType } : {}),
      ...(scheduleEvery ? { scheduleEvery } : {}),
      ...(previewPort != null ? { previewPort } : {}),
      runNow,
    },
  };
}

function resolveTimeoutMs(command: ParsedOpsCommand): number {
  if (command.action === "help") {
    return 0;
  }
  return ACTION_TIMEOUT_MS[command.action];
}

function resolveSuggestedCommand(command: ParsedOpsCommand): string {
  if ("projectId" in command && command.projectId) {
    return `/ops status ${command.projectId}`;
  }
  if (command.action === "list") {
    return "/ops list";
  }
  return "/ops help";
}

function renderNextRunLabel(nextRunAtMs?: number): string {
  if (nextRunAtMs == null || !Number.isFinite(nextRunAtMs)) {
    return "未计划";
  }
  const timestamp = new Date(nextRunAtMs);
  const absolute = formatZonedTimestamp(timestamp, { displaySeconds: true }) ?? timestamp.toISOString();
  const relative = formatRelativeTimestamp(nextRunAtMs, { dateFallback: true, fallback: "n/a" });
  return `${absolute} (${relative})`;
}

function renderProjectLine(project: ProjectView): string {
  const cronStatus =
    project.cronId != null
      ? `${project.cronId}${project.cronEnabled == null ? "" : project.cronEnabled ? " 已启用" : " 已暂停"}`
      : "未配置";
  return `- ${project.projectId} | agent ${project.agentId ?? "n/a"} | cron ${cronStatus} | status ${project.status ?? "unknown"} | doc ${project.docUrl ?? "-"}`;
}

function renderListResult(result: ProjectManagerResult): string {
  const projects = result.projects ?? [];
  if (projects.length === 0) {
    return "📦 暂无托管项目。使用 `/ops onboard <projectId> <repoPath>` 开始。";
  }
  return [`📦 托管项目：${projects.length}`, ...projects.map((project) => renderProjectLine(project))].join(
    "\n",
  );
}

function renderStatusResult(project: ProjectView): string {
  return [
    `📌 项目：${project.projectId}`,
    `- 状态：${project.status ?? "unknown"}`,
    `- agentId：${project.agentId ?? "n/a"}`,
    `- cron：${project.cronId ?? "未配置"}${project.cronEnabled == null ? "" : project.cronEnabled ? "（已启用）" : "（已暂停）"}`,
    `- 下次运行：${renderNextRunLabel(project.cronNextRunAtMs)}`,
    `- 文档：${project.docUrl ?? "未配置"}`,
    `- 预览端口：${project.previewPort ?? "未配置"}`,
    `- 仓库：${project.repoPath ?? "n/a"}`,
  ].join("\n");
}

function renderOnboardResult(result: ProjectManagerResult, existingProject?: ProjectSnapshot): string {
  const project = result.project;
  if (!project) {
    return "✅ 接管完成。";
  }
  const cronId = result.cron?.id ?? project.cronId ?? "未配置";
  const docUrl = result.doc?.url ?? project.docUrl;
  const docDetail =
    docUrl ??
    (result.doc?.blocked
      ? `未创建（${result.doc.message ?? "当前配置阻止自动建文档"}）`
      : `未创建${result.doc?.message ? `（${result.doc.message}）` : ""}`);
  return [
    `✅ 已接管 ${project.projectId}`,
    `- agent：${project.agentId ?? "n/a"}${existingProject ? "（复用）" : "（新建）"}`,
    `- cronId：${cronId}`,
    `- 文档：${docDetail}`,
    `- 首轮运行：${result.runTriggered ? "已触发" : "未触发"}`,
    `- 预览端口：${project.previewPort ?? "未配置"}`,
  ].join("\n");
}

function renderPauseOrResumeResult(result: ProjectManagerResult): string {
  const project = result.project;
  const cron = result.cron;
  const actionLabel = result.action === "resume" ? "已恢复" : "已暂停";
  return [
    `✅ ${actionLabel}${project?.projectId ? ` ${project.projectId}` : ""}`,
    `- cronId：${cron?.id ?? project?.cronId ?? "未配置"}`,
    `- cron：${cron?.enabled == null ? "未知" : cron.enabled ? "已启用" : "已暂停"}`,
    `- 最新状态：${project?.status ?? "unknown"}`,
    `- 下次运行：${renderNextRunLabel(cron?.nextRunAtMs ?? project?.cronNextRunAtMs)}`,
  ].join("\n");
}

function renderRunResult(result: ProjectManagerResult, statusProject?: ProjectView): string {
  const projectId = statusProject?.projectId ?? result.projectId ?? "项目";
  return [
    `✅ 已触发 ${projectId}`,
    `- cronId：${result.cronId ?? statusProject?.cronId ?? "未配置"}`,
    `- 最新状态：${statusProject?.status ?? "已触发"}`,
    `- cron：${statusProject?.cronEnabled == null ? "未知" : statusProject.cronEnabled ? "已启用" : "已暂停"}`,
    `- 下次运行：${renderNextRunLabel(statusProject?.cronNextRunAtMs)}`,
  ].join("\n");
}

function renderProjectManagerResult(params: {
  command: ParsedOpsCommand;
  result: ProjectManagerResult;
  existingProject?: ProjectSnapshot;
  runStatusProject?: ProjectView;
}): string {
  const { command, result } = params;
  if (!result.ok) {
    return `⚠️ ${result.error ?? "操作失败。"}`;
  }
  switch (command.action) {
    case "list":
      return renderListResult(result);
    case "status":
      return result.project ? renderStatusResult(result.project) : "⚠️ 未返回项目状态。";
    case "onboard":
      return renderOnboardResult(result, params.existingProject);
    case "pause":
    case "resume":
      return renderPauseOrResumeResult(result);
    case "run":
      return renderRunResult(result, params.runStatusProject);
    default:
      return "✅ 操作完成。";
  }
}

function renderInProgress(params: {
  command: ParsedOpsCommand;
  step: string;
  runId?: string;
}): string {
  return [
    "⏳ 进行中",
    `- 已执行到：${params.step}`,
    `- 建议下一条命令：${resolveSuggestedCommand(params.command)}`,
    ...(params.runId ? [`- 运行 ID：${params.runId.slice(0, 8)}`] : []),
  ].join("\n");
}

function renderDirectProgressStep(command: ParsedOpsCommand): string {
  return `正在本机执行 project-manager.ps1 的 ${command.action} 操作，尚未在 ${Math.round(resolveTimeoutMs(command) / 1000)} 秒内完成。`;
}

function renderFallbackProgressStep(command: ParsedOpsCommand): string {
  return `已将 ${command.action} 请求发送给 ${PROJECT_OPS_AGENT_ID}，等待 ${PROJECT_OPS_SESSION_KEY} 返回结果。`;
}

function resolveProjectOpsPaths() {
  const stateDir = resolveConfigDir();
  const workspace = path.join(stateDir, "workspace-project-ops");
  return {
    workspace,
    registryPath: path.join(workspace, "PROJECTS.json"),
    scriptPath: path.join(workspace, "scripts", "project-manager.ps1"),
  };
}

function resolvePowerShellExecutable(): string {
  return process.platform === "win32" ? "powershell.exe" : "pwsh";
}

function buildProjectManagerArgs(command: ParsedOpsCommand): string[] {
  if (command.action === "help" || command.action === "doctor") {
    return [];
  }
  const args = ["-Action", command.action];
  switch (command.action) {
    case "status":
    case "pause":
    case "resume":
    case "run":
      args.push("-ProjectId", command.projectId);
      break;
    case "onboard":
      args.push("-ProjectId", command.projectId, "-RepoPath", command.repoPath);
      if (command.projectType) {
        args.push("-ProjectType", command.projectType);
      }
      if (command.scheduleEvery) {
        args.push("-ScheduleEvery", command.scheduleEvery);
      }
      if (command.previewPort != null) {
        args.push("-PreviewPort", String(command.previewPort));
      }
      if (command.runNow) {
        args.push("-RunNow");
      }
      break;
    case "list":
      break;
  }
  return args;
}

function shouldFallbackProjectManagerError(error: string): boolean {
  return /project-manager\.ps1|powershell|pwsh|not recognized|cannot find|unable to parse json|exit code/i.test(
    error,
  );
}

async function invokeProjectManager(
  command: ParsedOpsCommand,
  timeoutMs: number,
): Promise<ProjectManagerInvokeResult> {
  if (!DIRECT_ACTIONS.has(command.action)) {
    return { kind: "error", error: "Direct project-manager path not available for this action.", retryable: true };
  }
  const { scriptPath } = resolveProjectOpsPaths();
  const execResult = await execFileUtf8(
    resolvePowerShellExecutable(),
    ["-ExecutionPolicy", "Bypass", "-File", scriptPath, ...buildProjectManagerArgs(command)],
    {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  const outputText = [execResult.stdout, execResult.stderr].filter(Boolean).join("\n").trim();
  if (/timed out/i.test(outputText)) {
    return { kind: "timeout" };
  }

  const parsed = normalizeProjectManagerResult(parseLooseJson(outputText));
  if (parsed) {
    if (execResult.code === 0 && parsed.ok) {
      return { kind: "ok", payload: parsed };
    }
    return {
      kind: "error",
      error: parsed.error ?? `project-manager exited with code ${execResult.code}`,
      retryable: shouldFallbackProjectManagerError(parsed.error ?? outputText),
    };
  }

  if (execResult.code === 0) {
    return {
      kind: "error",
      error: "project-manager returned unexpected output.",
      retryable: true,
    };
  }

  return {
    kind: "error",
    error: outputText || `project-manager exited with code ${execResult.code}`,
    retryable: true,
  };
}

async function readExistingProjectSnapshot(projectId: string): Promise<ProjectSnapshot | undefined> {
  const { registryPath } = resolveProjectOpsPaths();
  try {
    const raw = await fs.readFile(registryPath, "utf8");
    const parsed = parseLooseJson(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.projects)) {
      return undefined;
    }
    const loweredTarget = projectId.trim().toLowerCase();
    for (const entry of parsed.projects) {
      if (!isRecord(entry)) {
        continue;
      }
      const candidateId = readString(entry.projectId);
      if (!candidateId || candidateId.toLowerCase() !== loweredTarget) {
        continue;
      }
      return {
        projectId: candidateId,
        agentId: readString(entry.agentId),
      };
    }
  } catch {
    // Best-effort only; onboarding can proceed without this hint.
  }
  return undefined;
}

async function tryLoadRunStatusProject(projectId: string): Promise<ProjectView | undefined> {
  const result = await invokeProjectManager({ action: "status", projectId }, 10_000);
  return result.kind === "ok" ? result.payload.project : undefined;
}

function buildFallbackPrompt(command: ParsedOpsCommand): string {
  const request = {
    source: COMMAND,
    sync: true,
    command,
    timeoutSeconds: Math.round(resolveTimeoutMs(command) / 1000),
  };
  const nextCommand = resolveSuggestedCommand(command);
  return [
    "你是 project-ops。",
    "请执行下面这个 /ops 回退请求，并直接返回最终结果。",
    '如果仍在进行中，请严格返回三部分：第一行“进行中”；第二行说明已执行到哪一步；第三行给出建议命令。',
    `建议命令：${nextCommand}`,
    "请求：",
    JSON.stringify(request, null, 2),
  ].join("\n");
}

async function invokeProjectOpsFallback(
  params: Parameters<CommandHandler>[0],
  command: ParsedOpsCommand,
  timeoutMs: number,
): Promise<FallbackInvokeResult> {
  const message = buildFallbackPrompt(command);
  const idempotencyKey = crypto.randomUUID();
  let runId: string = idempotencyKey;

  try {
    const response = await callGateway<{ runId?: string }>({
      method: "agent",
      params: {
        message,
        agentId: PROJECT_OPS_AGENT_ID,
        sessionKey: PROJECT_OPS_SESSION_KEY,
        idempotencyKey,
        deliver: false,
        channel: INTERNAL_MESSAGE_CHANNEL,
        lane: AGENT_LANE_NESTED,
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: params.sessionKey,
          sourceChannel: params.command.channel,
          sourceTool: "sessions_send",
        },
      },
      timeoutMs: 10_000,
    });
    if (typeof response?.runId === "string" && response.runId.trim()) {
      runId = response.runId;
    }
  } catch (err) {
    return {
      kind: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let waitStatus: string | undefined;
  let waitError: string | undefined;
  try {
    const wait = await callGateway<{ status?: string; error?: string }>({
      method: "agent.wait",
      params: { runId, timeoutMs },
      timeoutMs: timeoutMs + 2_000,
    });
    waitStatus = readString(wait?.status);
    waitError = readString(wait?.error);
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    if (/gateway timeout|timed out/i.test(messageText)) {
      return { kind: "timeout", runId };
    }
    return { kind: "error", error: messageText };
  }

  if (waitStatus === "timeout") {
    return { kind: "timeout", runId };
  }
  if (waitStatus === "error") {
    return { kind: "error", error: waitError ?? "project-ops failed." };
  }

  const history = await callGateway<{ messages?: unknown[] }>({
    method: "chat.history",
    params: { sessionKey: PROJECT_OPS_SESSION_KEY, limit: 50 },
  });
  const filtered = stripToolMessages(Array.isArray(history?.messages) ? history.messages : []);
  const lastAssistant = [...filtered]
    .reverse()
    .find((message) => readString((message as { role?: unknown })?.role) === "assistant");
  const reply = lastAssistant ? extractAssistantText(lastAssistant) : undefined;
  return {
    kind: "ok",
    reply: reply?.trim() || `✅ ${PROJECT_OPS_AGENT_ID} 已完成 ${command.action}。`,
  };
}

export const handleOpsCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const parsed = parseOpsCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(`Ignoring /ops from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
    return { shouldContinue: false };
  }

  if (!parsed.ok) {
    return stopWithText(`⚠️ ${parsed.error}\n\n${renderOpsHelp()}`);
  }

  const command = parsed.command;
  if (command.action === "help") {
    return stopWithText(renderOpsHelp());
  }

  const timeoutMs = resolveTimeoutMs(command);
  const existingProject =
    command.action === "onboard" ? await readExistingProjectSnapshot(command.projectId) : undefined;

  if (DIRECT_ACTIONS.has(command.action)) {
    const direct = await invokeProjectManager(command, timeoutMs);
    if (direct.kind === "ok") {
      const runStatusProject =
        command.action === "run" ? await tryLoadRunStatusProject(command.projectId) : undefined;
      return stopWithText(
        renderProjectManagerResult({
          command,
          result: direct.payload,
          existingProject,
          runStatusProject,
        }),
      );
    }
    if (direct.kind === "timeout") {
      return stopWithText(
        renderInProgress({
          command,
          step: renderDirectProgressStep(command),
        }),
      );
    }
    if (!direct.retryable) {
      return stopWithText(`⚠️ ${direct.error}`);
    }
  }

  const fallback = await invokeProjectOpsFallback(params, command, timeoutMs);
  if (fallback.kind === "ok") {
    return stopWithText(fallback.reply);
  }
  if (fallback.kind === "timeout") {
    return stopWithText(
      renderInProgress({
        command,
        step: renderFallbackProgressStep(command),
        runId: fallback.runId,
      }),
    );
  }
  return stopWithText(`⚠️ ${fallback.error}`);
};
