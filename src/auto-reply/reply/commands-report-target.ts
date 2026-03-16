import { syncAgentReportTarget } from "../../agents/report-target-sync.js";
import type { AgentReportTarget } from "../../config/types.agents.js";
import { logVerbose } from "../../globals.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { stopWithText } from "./commands-subagents/shared.js";
import type { CommandHandler } from "./commands-types.js";

const GROUP_LOCATION_RE = /(这里|这个群|本群|当前群|这个项目群)/;
const REPORT_SCOPE_RE = /(汇报|同步|进展|更新|开发和汇报|开发汇报|写作、修改、汇报|写作修改汇报)/;
const FUTURE_RE = /(以后|今后|后面|之后|从现在开始|默认)/;
const MIGRATION_RE = /(迁到|迁来|切到|切换到|改到|放到|发到|固定在)/;
const IN_THIS_GROUP_RE = /(都在这里|在这里进行|在这个群里进行|在本群进行|在当前群进行)/;

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function resolveRawCommandText(params: Parameters<CommandHandler>[0]): string {
  const ctx = params.ctx as Record<string, unknown>;
  return firstNonEmpty(
    typeof ctx.CommandBody === "string" ? ctx.CommandBody : undefined,
    typeof ctx.BodyForCommands === "string" ? ctx.BodyForCommands : undefined,
    typeof ctx.Body === "string" ? ctx.Body : undefined,
  );
}

function matchesPrimaryReportTargetIntent(raw: string): boolean {
  const normalized = normalizeSpaces(raw);
  if (!normalized || !GROUP_LOCATION_RE.test(normalized)) {
    return false;
  }
  if (
    REPORT_SCOPE_RE.test(normalized) &&
    (FUTURE_RE.test(normalized) || MIGRATION_RE.test(normalized))
  ) {
    return true;
  }
  return REPORT_SCOPE_RE.test(normalized) && IN_THIS_GROUP_RE.test(normalized);
}

function normalizeCurrentGroupTarget(
  params: Parameters<CommandHandler>[0],
): AgentReportTarget | undefined {
  const channel = params.sessionEntry?.deliveryContext?.channel ?? params.command.channel;
  const toFromSession = params.sessionEntry?.deliveryContext?.to;
  const accountId =
    params.sessionEntry?.deliveryContext?.accountId ??
    (typeof params.ctx.AccountId === "string" && params.ctx.AccountId.trim()
      ? params.ctx.AccountId.trim()
      : undefined);

  if (channel && toFromSession) {
    const normalizedTo =
      channel === "feishu" && /^group:/i.test(toFromSession)
        ? `chat:${toFromSession.slice("group:".length)}`
        : toFromSession;
    return {
      channel,
      to: normalizedTo,
      accountId,
    };
  }

  const parsed = parseAgentSessionKey(params.sessionKey);
  const rest = parsed?.rest.split(":").filter(Boolean) ?? [];
  if (rest.length >= 3 && (rest[1] === "group" || rest[1] === "channel")) {
    const to =
      rest[0] === "feishu" && rest[1] === "group" ? `chat:${rest[2]}` : `${rest[1]}:${rest[2]}`;
    return {
      channel: rest[0],
      to,
      accountId,
    };
  }

  return undefined;
}

function renderMigrationReply(params: {
  agentId: string;
  target: AgentReportTarget;
  configChanged: boolean;
  cronMatched: number;
  cronUpdated: number;
  cronFailed: number;
  alreadyCurrent: boolean;
}): string {
  const targetLabel = `${params.target.channel} / ${params.target.to}`;
  const lines = params.alreadyCurrent
    ? [`✅ \`${params.agentId}\` 的主汇报目标已经是当前群。`, `- 当前目标：${targetLabel}`]
    : [
        `✅ 已将 \`${params.agentId}\` 的主汇报目标切到当前群。`,
        `- 当前目标：${targetLabel}`,
        params.configChanged ? "- 后续新的例行汇报会默认发到这里" : undefined,
      ].filter(Boolean);

  if (params.cronMatched > 0) {
    lines.push(`- 已迁移 cron：${params.cronUpdated}/${params.cronMatched}`);
  } else {
    lines.push("- 现有 cron：无需迁移");
  }
  if (params.cronFailed > 0) {
    lines.push(`- 迁移失败：${params.cronFailed} 条，请稍后重试`);
  }

  return lines.join("\n");
}

export const handleReportTargetCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands || !params.isGroup) {
    return null;
  }

  const raw = resolveRawCommandText(params);
  if (!matchesPrimaryReportTargetIntent(raw)) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring report-target migration from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const target = normalizeCurrentGroupTarget(params);
  if (!target) {
    return stopWithText("⚠️ 当前群的投递目标无法识别，暂时不能迁移汇报。");
  }

  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  let syncResult;
  try {
    syncResult = await syncAgentReportTarget({
      cfg: params.cfg,
      agentId,
      target,
    });
  } catch (err) {
    return stopWithText(`⚠️ 汇报目标更新失败（${err instanceof Error ? err.message : String(err)}）。`);
  }

  return stopWithText(
    renderMigrationReply({
      agentId,
      target,
      configChanged: syncResult.configChanged,
      cronMatched: syncResult.cronMatched,
      cronUpdated: syncResult.cronUpdated,
      cronFailed: syncResult.cronFailed,
      alreadyCurrent: syncResult.alreadyCurrent,
    }),
  );
};
