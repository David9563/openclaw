import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/feishu";
import { normalizeAgentId } from "openclaw/plugin-sdk/feishu";
import { createFeishuClient } from "./client.js";
import type { FeishuAutoGroupBindingConfig, FeishuConfig, ResolvedFeishuAccount } from "./types.js";

const DEFAULT_GROUP_NAME_PREFIXES = ["项目-", "project-", "group-", "agent-"];

export type MaybeAutoBindFeishuGroupResult = {
  created: boolean;
  updatedCfg: OpenClawConfig;
  agentId?: string;
  groupName?: string;
  reason?: string;
};

function normalizeMatchKey(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[–—]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildGroupNameVariants(groupName: string, prefixes?: string[]): string[] {
  const normalized = normalizeMatchKey(groupName);
  if (!normalized) {
    return [];
  }

  const variants = new Set<string>([normalized]);
  const configuredPrefixes = prefixes?.length ? prefixes : DEFAULT_GROUP_NAME_PREFIXES;
  for (const prefix of configuredPrefixes) {
    const normalizedPrefix = normalizeMatchKey(prefix);
    if (!normalizedPrefix) {
      continue;
    }
    if (!normalized.startsWith(normalizedPrefix)) {
      continue;
    }
    const trimmed = normalized.slice(normalizedPrefix.length).replace(/^-+/, "");
    if (trimmed) {
      variants.add(trimmed);
    }
  }
  return [...variants];
}

function listConfiguredAgents(cfg: OpenClawConfig): Array<{ id: string; name?: string }> {
  const configured = cfg.agents?.list?.filter(
    (entry): entry is { id: string; name?: string } =>
      Boolean(entry && typeof entry === "object" && typeof entry.id === "string" && entry.id.trim()),
  );
  if (configured && configured.length > 0) {
    return configured;
  }
  return [{ id: "main" }];
}

function resolveAgentIdFromGroupName(params: {
  cfg: OpenClawConfig;
  groupName: string;
  autoBindCfg: FeishuAutoGroupBindingConfig;
}): { agentId?: string; reason?: string } {
  const variants = buildGroupNameVariants(params.groupName, params.autoBindCfg.prefixes);
  if (variants.length === 0) {
    return { reason: "group-name-empty" };
  }

  const agents = listConfiguredAgents(params.cfg);
  const agentIds = new Set(agents.map((agent) => normalizeAgentId(agent.id)));

  const aliasCandidates = new Set<string>();
  for (const [alias, target] of Object.entries(params.autoBindCfg.aliases ?? {})) {
    const normalizedAlias = normalizeMatchKey(alias);
    if (!normalizedAlias || !variants.includes(normalizedAlias)) {
      continue;
    }
    const normalizedTarget = normalizeAgentId(target);
    if (agentIds.has(normalizedTarget)) {
      aliasCandidates.add(normalizedTarget);
    }
  }
  if (aliasCandidates.size === 1) {
    return { agentId: [...aliasCandidates][0] };
  }
  if (aliasCandidates.size > 1) {
    return { reason: "ambiguous-alias" };
  }

  const candidates = new Set<string>();
  for (const agent of agents) {
    const normalizedId = normalizeAgentId(agent.id);
    const keys = new Set<string>([normalizeMatchKey(agent.id)]);
    if (typeof agent.name === "string" && agent.name.trim()) {
      keys.add(normalizeMatchKey(agent.name));
    }
    if (variants.some((variant) => keys.has(variant))) {
      candidates.add(normalizedId);
    }
  }

  if (candidates.size === 1) {
    return { agentId: [...candidates][0] };
  }
  if (candidates.size > 1) {
    return { reason: "ambiguous-agent-match" };
  }
  return { reason: "no-agent-match" };
}

function hasExistingGroupBinding(cfg: OpenClawConfig, chatId: string): boolean {
  return (cfg.bindings ?? []).some(
    (binding) =>
      binding.match?.channel === "feishu" &&
      binding.match?.peer?.kind === "group" &&
      binding.match?.peer?.id === chatId,
  );
}

function appendUnique(values: readonly string[] | undefined, nextValue: string): string[] {
  const next = new Set((values ?? []).map((value) => value.trim()).filter(Boolean));
  next.add(nextValue);
  return [...next];
}

function shouldScopeBindingByAccount(feishuCfg?: FeishuConfig): boolean {
  return Object.keys(feishuCfg?.accounts ?? {}).length > 0;
}

function writeEffectiveGroupAllowFrom(params: {
  cfg: OpenClawConfig;
  accountId: string;
  effectiveGroupAllowFrom: string[];
}): OpenClawConfig {
  const currentFeishu = (params.cfg.channels?.feishu as FeishuConfig | undefined) ?? {};
  const accounts = currentFeishu.accounts;
  const hasAccountOverride =
    !!accounts && Object.prototype.hasOwnProperty.call(accounts, params.accountId);

  const nextFeishu: FeishuConfig = hasAccountOverride
    ? {
        ...currentFeishu,
        accounts: {
          ...accounts,
          [params.accountId]: {
            ...(accounts?.[params.accountId] ?? {}),
            groupAllowFrom: params.effectiveGroupAllowFrom,
          },
        },
      }
    : {
        ...currentFeishu,
        groupAllowFrom: params.effectiveGroupAllowFrom,
      };

  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      feishu: nextFeishu,
    },
  };
}

function addBinding(params: {
  cfg: OpenClawConfig;
  account: ResolvedFeishuAccount;
  chatId: string;
  agentId: string;
}): OpenClawConfig {
  const currentFeishu = params.cfg.channels?.feishu as FeishuConfig | undefined;
  const match = {
    channel: "feishu" as const,
    ...(shouldScopeBindingByAccount(currentFeishu) ? { accountId: params.account.accountId } : {}),
    peer: {
      kind: "group" as const,
      id: params.chatId,
    },
  };

  return {
    ...params.cfg,
    bindings: [...(params.cfg.bindings ?? []), { agentId: params.agentId, match }],
  };
}

async function loadFreshConfig(
  runtime: PluginRuntime,
  fallback: OpenClawConfig,
): Promise<OpenClawConfig> {
  try {
    const latest = await Promise.resolve(runtime.config.loadConfig());
    if (latest && typeof latest === "object") {
      return latest as OpenClawConfig;
    }
  } catch {
  }
  return fallback;
}

async function fetchFeishuGroupName(account: ResolvedFeishuAccount, chatId: string): Promise<string> {
  const client = createFeishuClient(account);
  const res = await client.im.chat.get({ path: { chat_id: chatId } });
  if (res.code !== 0) {
    throw new Error(res.msg || `Failed to fetch Feishu chat info for ${chatId}`);
  }
  return typeof res.data?.name === "string" ? res.data.name.trim() : "";
}

export async function maybeAutoBindFeishuGroupByName(params: {
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
  account: ResolvedFeishuAccount;
  chatId: string;
  autoBindCfg: FeishuAutoGroupBindingConfig;
  ensureGroupAllowed: boolean;
  log: (msg: string) => void;
}): Promise<MaybeAutoBindFeishuGroupResult> {
  const latestCfg = await loadFreshConfig(params.runtime, params.cfg);
  if (hasExistingGroupBinding(latestCfg, params.chatId)) {
    return { created: false, updatedCfg: latestCfg, reason: "binding-exists" };
  }

  let groupName = "";
  try {
    groupName = await fetchFeishuGroupName(params.account, params.chatId);
  } catch (err) {
    params.log(
      `feishu[${params.account.accountId}]: autoGroupBinding failed to fetch chat info for ${params.chatId}: ${String(err)}`,
    );
    return {
      created: false,
      updatedCfg: latestCfg,
      reason: "chat-info-error",
    };
  }

  if (!groupName) {
    return {
      created: false,
      updatedCfg: latestCfg,
      reason: "group-name-empty",
    };
  }

  const target = resolveAgentIdFromGroupName({
    cfg: latestCfg,
    groupName,
    autoBindCfg: params.autoBindCfg,
  });
  if (!target.agentId) {
    params.log(
      `feishu[${params.account.accountId}]: autoGroupBinding no match for group "${groupName}" (${params.chatId}) reason=${target.reason ?? "unknown"}`,
    );
    return {
      created: false,
      updatedCfg: latestCfg,
      groupName,
      reason: target.reason,
    };
  }

  let nextCfg = addBinding({
    cfg: latestCfg,
    account: params.account,
    chatId: params.chatId,
    agentId: target.agentId,
  });

  if (params.ensureGroupAllowed) {
    nextCfg = writeEffectiveGroupAllowFrom({
      cfg: nextCfg,
      accountId: params.account.accountId,
      effectiveGroupAllowFrom: appendUnique(params.account.config.groupAllowFrom, params.chatId),
    });
  }

  await params.runtime.config.writeConfigFile(nextCfg);

  params.log(
    `feishu[${params.account.accountId}]: autoGroupBinding matched group "${groupName}" (${params.chatId}) -> agent ${target.agentId}`,
  );
  return {
    created: true,
    updatedCfg: nextCfg,
    groupName,
    agentId: target.agentId,
  };
}
