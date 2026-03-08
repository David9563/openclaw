import { resolveAgentIdFromSessionKey } from "../../agents/agent-scope.js";
import {
  matchInternalClusterDelegation,
  runInternalClusterDelegation,
} from "../../agents/internal-cluster-routing.js";
import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";
import { stopWithText } from "./commands-subagents/shared.js";

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function resolveRawCommandText(params: Parameters<CommandHandler>[0]): string {
  const ctx = params.ctx as Record<string, unknown>;
  return firstNonEmpty(
    typeof ctx.CommandBody === "string" ? ctx.CommandBody : undefined,
    typeof ctx.BodyForCommands === "string" ? ctx.BodyForCommands : undefined,
    typeof ctx.Body === "string" ? ctx.Body : undefined,
  );
}

export const handleClusterDelegationCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const currentAgentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const raw = resolveRawCommandText(params);
  const delegation = matchInternalClusterDelegation({
    agentId: currentAgentId,
    isGroup: params.isGroup,
    raw,
  });
  if (!delegation) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring ${delegation.route.command} delegation from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const delegated = await runInternalClusterDelegation({
    cfg: params.cfg,
    requesterSessionKey: params.sessionKey,
    requesterChannel: params.command.channel,
    delegation,
    sourceTool: "cluster_delegate",
  });
  return stopWithText(delegated.text);
};
