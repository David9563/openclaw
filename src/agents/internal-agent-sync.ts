import crypto from "node:crypto";
import { AGENT_LANE_NESTED } from "./lanes.js";
import { callGateway } from "../gateway/call.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { extractAssistantText, stripToolMessages } from "../auto-reply/reply/commands-subagents/shared.js";

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export type InternalAgentSyncResult =
  | { kind: "ok"; reply: string; runId?: string }
  | { kind: "timeout"; runId?: string }
  | { kind: "error"; error: string; runId?: string };

export async function invokeInternalAgentSync(params: {
  requesterSessionKey: string;
  requesterChannel: string;
  agentId: string;
  sessionKey: string;
  message: string;
  timeoutMs: number;
  sourceTool?: string;
  historyLimit?: number;
  fallbackReply?: string;
}): Promise<InternalAgentSyncResult> {
  const idempotencyKey = crypto.randomUUID();
  let runId: string = idempotencyKey;

  try {
    const response = await callGateway<{ runId?: string }>({
      method: "agent",
      params: {
        message: params.message,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        idempotencyKey,
        deliver: false,
        channel: INTERNAL_MESSAGE_CHANNEL,
        lane: AGENT_LANE_NESTED,
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: params.requesterSessionKey,
          sourceChannel: params.requesterChannel,
          sourceTool: params.sourceTool ?? "sessions_send",
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
      params: { runId, timeoutMs: params.timeoutMs },
      timeoutMs: params.timeoutMs + 2_000,
    });
    waitStatus = readString(wait?.status);
    waitError = readString(wait?.error);
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    if (/gateway timeout|timed out/i.test(messageText)) {
      return { kind: "timeout", runId };
    }
    return { kind: "error", error: messageText, runId };
  }

  if (waitStatus === "timeout") {
    return { kind: "timeout", runId };
  }
  if (waitStatus === "error") {
    return { kind: "error", error: waitError ?? `${params.agentId} failed.`, runId };
  }

  try {
    const history = await callGateway<{ messages?: unknown[] }>({
      method: "chat.history",
      params: {
        sessionKey: params.sessionKey,
        limit: params.historyLimit ?? 50,
      },
    });
    const filtered = stripToolMessages(Array.isArray(history?.messages) ? history.messages : []);
    const lastAssistant = [...filtered]
      .reverse()
      .find((message) => readString((message as { role?: unknown })?.role) === "assistant");
    const reply = lastAssistant ? extractAssistantText(lastAssistant) : undefined;
    return {
      kind: "ok",
      reply: reply?.trim() || params.fallbackReply || `✅ ${params.agentId} 已完成任务。`,
      runId,
    };
  } catch (err) {
    return {
      kind: "error",
      error: err instanceof Error ? err.message : String(err),
      runId,
    };
  }
}
