import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { HookHandler } from "../../hooks.js";
import { createHookEvent } from "../../hooks.js";

let handler: HookHandler;
let suiteWorkspaceRoot = "";
let workspaceCaseCounter = 0;

async function createCaseWorkspace(prefix = "case"): Promise<string> {
  const dir = path.join(suiteWorkspaceRoot, `${prefix}-${workspaceCaseCounter}`);
  workspaceCaseCounter += 1;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function makeConfig(workspaceDir: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
      },
    },
  } satisfies OpenClawConfig;
}

async function runMessage(params: {
  workspaceDir: string;
  bodyForAgent: string;
  sessionKey?: string;
  isGroup?: boolean;
}): Promise<string> {
  const event = createHookEvent("message", "preprocessed", params.sessionKey ?? "agent:main:main", {
    cfg: makeConfig(params.workspaceDir),
    channelId: "feishu",
    bodyForAgent: params.bodyForAgent,
    body: params.bodyForAgent,
    isGroup: params.isGroup ?? false,
  });
  await handler(event);
  return fs.readFile(path.join(params.workspaceDir, "memory.md"), "utf8");
}

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-focus-memory-"));
});

afterAll(async () => {
  if (!suiteWorkspaceRoot) {
    return;
  }
  await fs.rm(suiteWorkspaceRoot, { recursive: true, force: true });
  suiteWorkspaceRoot = "";
  workspaceCaseCounter = 0;
});

describe("focus-memory hook", () => {
  it("writes current project focus from explicit project metadata", async () => {
    const workspaceDir = await createCaseWorkspace("project-metadata");
    const content = await runMessage({
      workspaceDir,
      bodyForAgent: [
        "- projectId: smart-factory",
        "- agent: smart-factory",
        "- cron: cron-123",
        "- status: active",
        "给这个项目挂载一个内容，就是页面太丑了，需要重新设计，很多元素都是堆叠在一起的，没有美感",
      ].join("\n"),
    });

    expect(content).toContain("`smart-factory`");
    expect(content).toContain("Active agent: `smart-factory`");
    expect(content).toContain("Project status: active");
    expect(content).toContain("页面太丑了，需要重新设计");
  });

  it("keeps the active project when follow-up messages use deictic language", async () => {
    const workspaceDir = await createCaseWorkspace("project-followup");
    await runMessage({
      workspaceDir,
      bodyForAgent: "Smart Factory 的开发到了百分百了，我现在需要他去调整界面",
    });
    const content = await runMessage({
      workspaceDir,
      bodyForAgent: "这个项目继续改页面，把布局和视觉层级都重新做一下",
    });

    expect(content).toContain("`smart-factory`");
    expect(content).toContain("这个项目继续改页面，把布局和视觉层级都重新做一下");
  });

  it("tracks recent requests in recency order with dedupe", async () => {
    const workspaceDir = await createCaseWorkspace("recent-requests");
    await runMessage({
      workspaceDir,
      bodyForAgent: "smart-factory 的页面需要重设计",
    });
    await runMessage({
      workspaceDir,
      bodyForAgent: "帮我把 smart-factory 当前进展整理成飞书汇报",
    });
    const content = await runMessage({
      workspaceDir,
      bodyForAgent: "smart-factory 的页面需要重设计",
    });

    const redesignIndex = content.indexOf("smart-factory 的页面需要重设计");
    const reportIndex = content.indexOf("帮我把 smart-factory 当前进展整理成飞书汇报");
    expect(redesignIndex).toBeGreaterThan(-1);
    expect(reportIndex).toBeGreaterThan(-1);
    expect(redesignIndex).toBeLessThan(reportIndex);
  });

  it("ignores group messages", async () => {
    const workspaceDir = await createCaseWorkspace("group-ignore");
    await runMessage({
      workspaceDir,
      bodyForAgent: "smart-factory 的页面需要重设计",
    });
    const before = await fs.readFile(path.join(workspaceDir, "memory.md"), "utf8");
    await runMessage({
      workspaceDir,
      bodyForAgent: "群里这条不应该改焦点",
      isGroup: true,
    });
    const after = await fs.readFile(path.join(workspaceDir, "memory.md"), "utf8");
    expect(after).toBe(before);
  });

  it("ignores non-main sessions", async () => {
    const workspaceDir = await createCaseWorkspace("non-main-ignore");
    const event = createHookEvent("message", "preprocessed", "agent:writer:main", {
      cfg: makeConfig(workspaceDir),
      channelId: "feishu",
      bodyForAgent: "writer 这边的消息不该写 main 的 focus memory",
      body: "writer 这边的消息不该写 main 的 focus memory",
      isGroup: false,
    });
    await handler(event);
    await expect(fs.readFile(path.join(workspaceDir, "memory.md"), "utf8")).rejects.toThrow();
  });
});
