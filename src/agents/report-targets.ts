import type { OpenClawConfig } from "../config/config.js";
import type { AgentReportTarget } from "../config/types.agents.js";
import { normalizeAgentId } from "../routing/session-key.js";

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeReportTarget(value: unknown): AgentReportTarget | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const channel = normalizeNonEmptyString((value as { channel?: unknown }).channel);
  const to = normalizeNonEmptyString((value as { to?: unknown }).to);
  if (!channel || !to) {
    return undefined;
  }
  const accountId = normalizeNonEmptyString((value as { accountId?: unknown }).accountId);
  return {
    channel: channel.toLowerCase(),
    to,
    accountId,
  };
}

function sameReportTarget(
  left: AgentReportTarget | undefined,
  right: AgentReportTarget | undefined,
): boolean {
  return (
    left?.channel === right?.channel &&
    left?.to === right?.to &&
    left?.accountId === right?.accountId
  );
}

export function resolveAgentPrimaryReportTarget(
  cfg: OpenClawConfig,
  agentId: string,
): AgentReportTarget | undefined {
  const normalizedAgentId = normalizeAgentId(agentId);
  const entry = cfg.agents?.list?.find(
    (candidate) => normalizeAgentId(candidate.id) === normalizedAgentId,
  );
  return normalizeReportTarget(entry?.reporting?.primaryTarget);
}

export function setAgentPrimaryReportTarget(
  cfg: OpenClawConfig,
  agentId: string,
  target: AgentReportTarget,
): { changed: boolean; config: OpenClawConfig } {
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedTarget = normalizeReportTarget(target);
  if (!normalizedTarget) {
    return { changed: false, config: cfg };
  }

  const existing = resolveAgentPrimaryReportTarget(cfg, normalizedAgentId);
  if (sameReportTarget(existing, normalizedTarget)) {
    return { changed: false, config: cfg };
  }

  const existingList = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  let found = false;
  const nextList = existingList.map((entry) => {
    if (normalizeAgentId(entry.id) !== normalizedAgentId) {
      return entry;
    }
    found = true;
    return {
      ...entry,
      reporting: {
        ...entry.reporting,
        primaryTarget: normalizedTarget,
      },
    };
  });

  if (!found) {
    nextList.push({
      id: normalizedAgentId,
      reporting: {
        primaryTarget: normalizedTarget,
      },
    });
  }

  return {
    changed: true,
    config: {
      ...cfg,
      agents: {
        ...cfg.agents,
        list: nextList,
      },
    },
  };
}
