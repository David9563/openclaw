import { resolveAgentConfig } from "./agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { invokeInternalAgentSync } from "./internal-agent-sync.js";

const MAIN_AGENT_ID = "main";
const WRITER_AGENT_ID = "writer";
const WRITER_SESSION_KEY = `agent:${WRITER_AGENT_ID}:main`;
const WRITER_TIMEOUT_MS = 90_000;
const WRITER_COMMAND = "/writer";

export type ClusterRouteMatch = {
  task: string;
  explicit: boolean;
};

export type ClusterRouteSpec = {
  command: string;
  agentId: string;
  sessionKey: string;
  timeoutMs: number;
  usage: string[];
  matches: (normalized: string, raw: string) => ClusterRouteMatch | null;
  buildPrompt: (task: string, explicit: boolean) => string;
  renderTimeout: (runId?: string) => string;
};

export type ResolvedClusterDelegation = {
  route: ClusterRouteSpec;
  task: string;
  explicit: boolean;
  usageOnly: boolean;
  normalized: string;
  raw: string;
};

export type ClusterDelegationOutcome =
  | { kind: "ok"; text: string; runId?: string }
  | { kind: "timeout"; text: string; runId?: string }
  | { kind: "error"; text: string; runId?: string };

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripLeadingPunctuation(value: string): string {
  return value.replace(/^[：:，,\s]+/, "").trim();
}

function startsWithPrefix(normalized: string, prefixes: string[]): string | undefined {
  for (const prefix of prefixes) {
    if (normalized.startsWith(prefix)) {
      return prefix;
    }
  }
  return undefined;
}

function matchWriterDelegation(normalized: string, raw: string): ClusterRouteMatch | null {
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith(WRITER_COMMAND)) {
    const task = stripLeadingPunctuation(raw.slice(WRITER_COMMAND.length));
    return { task, explicit: true };
  }

  const explicitPrefix = startsWithPrefix(normalized, [
    "@writer",
    "writer:",
    "让writer",
    "让 writer",
    "交给writer",
    "交给 writer",
    "委托writer",
    "委托 writer",
  ]);
  if (explicitPrefix) {
    const task = stripLeadingPunctuation(raw.slice(explicitPrefix.length));
    return { task, explicit: true };
  }

  const writingSignals = [
    "飞书文档",
    "飞书",
    "文档",
    "汇报",
    "周报",
    "月报",
    "日报",
    "复盘",
    "纪要",
    "总结",
    "sop",
    "runbook",
  ];
  const actionSignals = [
    "写",
    "创建",
    "新建",
    "整理",
    "生成",
    "输出",
    "起草",
    "沉淀",
    "更新",
    "补充",
    "汇报",
  ];
  const requestPrefixes = [
    "请",
    "帮我",
    "麻烦",
    "给我",
    "把",
    "做个",
    "做一份",
    "来个",
    "来一份",
    "写个",
    "写一份",
  ];

  if (!writingSignals.some((signal) => normalized.includes(signal))) {
    return null;
  }
  if (
    !actionSignals.some((signal) => normalized.includes(signal)) &&
    !requestPrefixes.some((prefix) => normalized.startsWith(prefix))
  ) {
    return null;
  }

  return { task: raw.trim(), explicit: false };
}

const WRITER_ROUTE: ClusterRouteSpec = {
  command: WRITER_COMMAND,
  agentId: WRITER_AGENT_ID,
  sessionKey: WRITER_SESSION_KEY,
  timeoutMs: WRITER_TIMEOUT_MS,
  usage: [
    "📝 /writer 同步写作委托",
    "- /writer 创建一个飞书文档，标题是 常用命令行速查",
    "- /writer 把 smart-factory 当前进展整理成周报",
    "- 也支持自然语言自动委托：写文档 / 飞书 / 汇报 / 周报 / 复盘 / 纪要 / 总结",
  ],
  matches: matchWriterDelegation,
  buildPrompt: (task, explicit) =>
    [
      "你是 writer。",
      "这是来自 main 的同步写作委托。",
      "直接完成任务，不要反问 writer 是否存在，也不要解释工具可用性。",
      "如果任务涉及飞书文档，优先直接创建或更新飞书文档。",
      "如果创建成功且用户只想要结果，直接返回最终文档 URL。",
      "如果失败，只返回简短错误。",
      explicit
        ? "这是一条显式 writer 委托，请按写作执行，不要改成咨询式回复。"
        : "这是一条主控自动路由到 writer 的写作任务，请直接产出最终结果。",
      "原始请求：",
      task,
    ].join("\n"),
  renderTimeout: (runId) =>
    [
      "⏳ writer 正在处理中",
      `- 已发送到：${WRITER_SESSION_KEY}`,
      ...(runId ? [`- 运行 ID：${runId.slice(0, 8)}`] : []),
      "- 请稍后再试，或直接继续补一句你要 writer 追加的内容。",
    ].join("\n"),
};

const CLUSTER_ROUTES: ClusterRouteSpec[] = [WRITER_ROUTE];

export function renderClusterRouteUsage(route: ClusterRouteSpec): string {
  return route.usage.join("\n");
}

export function matchInternalClusterDelegation(params: {
  agentId?: string;
  isGroup?: boolean;
  raw: string;
}): ResolvedClusterDelegation | null {
  if ((params.agentId ?? "").trim() !== MAIN_AGENT_ID) {
    return null;
  }
  if (params.isGroup) {
    return null;
  }

  const raw = params.raw.trim();
  if (!raw) {
    return null;
  }
  const normalized = normalizeSpaces(raw);
  for (const route of CLUSTER_ROUTES) {
    const match = route.matches(normalized, raw);
    if (!match) {
      continue;
    }
    return {
      route,
      task: match.task,
      explicit: match.explicit,
      usageOnly:
        !match.task || normalized === route.command || normalized === `${route.command} help`,
      normalized,
      raw,
    };
  }

  return null;
}

export async function runInternalClusterDelegation(params: {
  cfg: OpenClawConfig;
  requesterSessionKey: string;
  requesterChannel: string;
  delegation: ResolvedClusterDelegation;
  sourceTool?: string;
}): Promise<ClusterDelegationOutcome> {
  const { delegation } = params;
  if (delegation.usageOnly) {
    return { kind: "ok", text: renderClusterRouteUsage(delegation.route) };
  }

  if (!resolveAgentConfig(params.cfg, delegation.route.agentId)) {
    return {
      kind: "error",
      text: `⚠️ Internal agent "${delegation.route.agentId}" is not configured.`,
    };
  }

  const delegated = await invokeInternalAgentSync({
    requesterSessionKey: params.requesterSessionKey,
    requesterChannel: params.requesterChannel,
    agentId: delegation.route.agentId,
    sessionKey: delegation.route.sessionKey,
    message: delegation.route.buildPrompt(delegation.task, delegation.explicit),
    timeoutMs: delegation.route.timeoutMs,
    sourceTool: params.sourceTool ?? "cluster_delegate",
    fallbackReply: `✅ ${delegation.route.agentId} 已完成任务。`,
  });

  if (delegated.kind === "ok") {
    return { kind: "ok", text: delegated.reply, runId: delegated.runId };
  }
  if (delegated.kind === "timeout") {
    return {
      kind: "timeout",
      text: delegation.route.renderTimeout(delegated.runId),
      runId: delegated.runId,
    };
  }
  return {
    kind: "error",
    text: `⚠️ ${delegated.error}`,
    runId: delegated.runId,
  };
}
