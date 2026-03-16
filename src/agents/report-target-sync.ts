import type { OpenClawConfig } from "../config/config.js";
import {
  readConfigFileSnapshot,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../config/config.js";
import type { AgentReportTarget } from "../config/types.agents.js";
import type { CronJob } from "../cron/types.js";
import { callGateway } from "../gateway/call.js";
import { logVerbose } from "../globals.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  resolveAgentPrimaryReportTarget,
  setAgentPrimaryReportTarget,
} from "./report-targets.js";

async function loadLatestConfig(baseCfg: OpenClawConfig) {
  try {
    const snapshot = await readConfigFileSnapshot();
    if (snapshot.valid && snapshot.resolved && typeof snapshot.resolved === "object") {
      return snapshot.resolved;
    }
  } catch (err) {
    logVerbose(`report-target-sync: failed to read latest config snapshot: ${String(err)}`);
  }
  return baseCfg;
}

async function listAllCronJobs(): Promise<CronJob[]> {
  const jobs: CronJob[] = [];
  let offset = 0;
  const limit = 200;

  while (true) {
    const page = await callGateway<{
      jobs?: CronJob[];
      hasMore?: boolean;
      nextOffset?: number | null;
    }>({
      method: "cron.list",
      params: {
        includeDisabled: true,
        limit,
        offset,
      },
      timeoutMs: 10_000,
    });
    if (Array.isArray(page?.jobs)) {
      jobs.push(...page.jobs);
    }
    if (!page?.hasMore) {
      break;
    }
    offset = typeof page?.nextOffset === "number" ? page.nextOffset : offset + limit;
  }

  return jobs;
}

function needsCronMigration(job: CronJob, agentId: string, target: AgentReportTarget): boolean {
  if ((job.agentId ?? "").trim().toLowerCase() !== normalizeAgentId(agentId)) {
    return false;
  }
  if (job.delivery == null) {
    return false;
  }
  const mode = (job.delivery.mode ?? "announce").trim().toLowerCase();
  if (mode !== "announce") {
    return false;
  }
  const channel =
    typeof job.delivery.channel === "string" ? job.delivery.channel.trim().toLowerCase() : "";
  const to = typeof job.delivery.to === "string" ? job.delivery.to.trim() : "";
  const accountId =
    typeof job.delivery.accountId === "string" ? job.delivery.accountId.trim() : undefined;
  return channel !== target.channel || to !== target.to || accountId !== target.accountId;
}

async function migrateAgentCronReportTargets(params: {
  agentId: string;
  target: AgentReportTarget;
}): Promise<{ matched: number; updated: number; failed: number }> {
  const jobs = await listAllCronJobs();
  const candidates = jobs.filter((job) => needsCronMigration(job, params.agentId, params.target));
  let updated = 0;
  let failed = 0;

  for (const job of candidates) {
    try {
      await callGateway({
        method: "cron.update",
        params: {
          id: job.id,
          patch: {
            delivery: {
              mode: "announce",
              channel: params.target.channel,
              to: params.target.to,
              accountId: params.target.accountId ?? "",
            },
          },
        },
        timeoutMs: 10_000,
      });
      updated += 1;
    } catch (err) {
      failed += 1;
      logVerbose(`report-target-sync: failed to migrate cron ${job.id}: ${String(err)}`);
    }
  }

  return {
    matched: candidates.length,
    updated,
    failed,
  };
}

export type SyncAgentReportTargetResult = {
  target: AgentReportTarget;
  previousTarget?: AgentReportTarget;
  alreadyCurrent: boolean;
  configChanged: boolean;
  cronMatched: number;
  cronUpdated: number;
  cronFailed: number;
  config: OpenClawConfig;
};

export async function syncAgentReportTarget(params: {
  cfg: OpenClawConfig;
  agentId: string;
  target: AgentReportTarget;
}): Promise<SyncAgentReportTargetResult> {
  const latestCfg = await loadLatestConfig(params.cfg);
  const previousTarget = resolveAgentPrimaryReportTarget(latestCfg, params.agentId);
  const update = setAgentPrimaryReportTarget(latestCfg, params.agentId, params.target);

  if (update.changed) {
    const validated = validateConfigObjectWithPlugins(update.config);
    if (!validated.ok) {
      const issue = validated.issues[0];
      throw new Error(`report target update failed (${issue.path}: ${issue.message})`);
    }
    await writeConfigFile(validated.config);
  }

  const cronMigration = await migrateAgentCronReportTargets({
    agentId: params.agentId,
    target: params.target,
  });

  const alreadyCurrent =
    previousTarget?.channel === params.target.channel &&
    previousTarget?.to === params.target.to &&
    previousTarget?.accountId === params.target.accountId;

  return {
    target: params.target,
    previousTarget,
    alreadyCurrent,
    configChanged: update.changed,
    cronMatched: cronMigration.matched,
    cronUpdated: cronMigration.updated,
    cronFailed: cronMigration.failed,
    config: update.changed ? update.config : latestCfg,
  };
}
