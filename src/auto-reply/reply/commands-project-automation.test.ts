import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const { handleProjectAutomationCommand } = await import("./commands-project-automation.js");
const { buildCommandTestParams } = await import("./commands.test-harness.js");

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function readJson(filePath: string) {
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
}

describe("project automation pause command", () => {
  let rootDir = "";
  let workspaceDir = "";
  let stateDir = "";

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-pause-"));
    workspaceDir = path.join(rootDir, "workspace");
    stateDir = path.join(rootDir, "state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    await writeJson(path.join(workspaceDir, ".openclaw", "automation-state.json"), {
      project: {
        projectId: "production-control-platform",
        agentId: "production-control-platform",
      },
      cron: {
        id: "cron-prod-1",
        status: "active",
      },
    });

    await writeJson(path.join(stateDir, "cron", "jobs.json"), {
      version: 1,
      jobs: [
        {
          id: "cron-prod-1",
          agentId: "production-control-platform",
          enabled: true,
          state: {
            nextRunAtMs: 1_800_000_000_000,
          },
        },
      ],
    });

    await writeJson(path.join(stateDir, "workspace-project-ops", "PROJECTS.json"), {
      projects: [
        {
          projectId: "production-control-platform",
          agentId: "production-control-platform",
          cronId: "cron-prod-1",
          status: "active",
          cronEnabled: true,
        },
      ],
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  function buildParams(text: string) {
    return {
      ...buildCommandTestParams(
        text,
        baseCfg,
        {
          Provider: "feishu",
          Surface: "feishu",
        },
        {
          workspaceDir,
        },
      ),
      agentId: "production-control-platform",
      sessionKey: "agent:production-control-platform:feishu:group:oc_group_1",
      isGroup: true,
    };
  }

  it("hard-pauses managed project automation before replying", async () => {
    const result = await handleProjectAutomationCommand(
      buildParams("请你暂停现在的开发任务以及cron，直到我说恢复"),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("已先执行硬动作");
    expect(result?.reply?.text).toContain("cron-prod-1");

    const jobs = await readJson(path.join(stateDir, "cron", "jobs.json"));
    expect(jobs.jobs[0].enabled).toBe(false);
    expect(jobs.jobs[0].state.nextRunAtMs).toBeUndefined();

    const projects = await readJson(path.join(stateDir, "workspace-project-ops", "PROJECTS.json"));
    expect(projects.projects[0].status).toBe("paused");
    expect(projects.projects[0].cronEnabled).toBe(false);

    const automationState = await readJson(path.join(workspaceDir, ".openclaw", "automation-state.json"));
    expect(automationState.cron.status).toBe("paused");
    expect(typeof automationState.cron.pausedAt).toBe("number");
  });

  it("is idempotent when the cron is already paused", async () => {
    await writeJson(path.join(stateDir, "cron", "jobs.json"), {
      version: 1,
      jobs: [
        {
          id: "cron-prod-1",
          agentId: "production-control-platform",
          enabled: false,
          state: {},
        },
      ],
    });
    await writeJson(path.join(stateDir, "workspace-project-ops", "PROJECTS.json"), {
      projects: [
        {
          projectId: "production-control-platform",
          agentId: "production-control-platform",
          cronId: "cron-prod-1",
          status: "paused",
          cronEnabled: false,
        },
      ],
    });
    await writeJson(path.join(workspaceDir, ".openclaw", "automation-state.json"), {
      project: {
        projectId: "production-control-platform",
        agentId: "production-control-platform",
      },
      cron: {
        id: "cron-prod-1",
        status: "paused",
      },
    });

    const result = await handleProjectAutomationCommand(buildParams("先冻结这个项目"), true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("原本就是停用状态");
  });

  it("ignores unrelated messages and negated pause phrases", async () => {
    const unrelated = await handleProjectAutomationCommand(buildParams("继续优化这个页面布局"), true);
    const negated = await handleProjectAutomationCommand(buildParams("先不要暂停 cron"), true);

    expect(unrelated).toBeNull();
    expect(negated).toBeNull();

    const jobs = await readJson(path.join(stateDir, "cron", "jobs.json"));
    expect(jobs.jobs[0].enabled).toBe(true);
  });
});
