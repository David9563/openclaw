import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const hoisted = vi.hoisted(() => {
  const execFileUtf8Mock = vi.fn();
  const callGatewayMock = vi.fn();
  return { execFileUtf8Mock, callGatewayMock };
});

vi.mock("../../daemon/exec-file.js", () => ({
  execFileUtf8: (...args: unknown[]) => hoisted.execFileUtf8Mock(...args),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: (args: unknown) => hoisted.callGatewayMock(args),
}));

const { handleOpsCommand } = await import("./commands-ops.js");
const { buildCommandTestParams } = await import("./commands-spawn.test-harness.js");

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

describe("/ops command", () => {
  beforeEach(() => {
    hoisted.execFileUtf8Mock.mockReset();
    hoisted.callGatewayMock.mockReset();
    vi.stubEnv("OPENCLAW_STATE_DIR", "/tmp/openclaw-state");
  });

  it("shows help when invoked without args", async () => {
    const params = buildCommandTestParams("/ops", baseCfg);
    const result = await handleOpsCommand(params, true);
    expect(result?.reply?.text).toContain("/ops list");
    expect(result?.reply?.text).toContain("/ops doctor [projectId]");
    expect(hoisted.execFileUtf8Mock).not.toHaveBeenCalled();
  });

  it("runs direct status with Chinese alias and renders the status card", async () => {
    hoisted.execFileUtf8Mock.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        action: "status",
        project: {
          projectId: "smart-factory",
          status: "active",
          agentId: "smart-factory",
          cronId: "cron-123",
          cronEnabled: true,
          cronNextRunAtMs: 1_800_000_000_000,
          docUrl: "https://docs.example/smart-factory",
          previewPort: 8123,
          repoPath: "d:\\smart-factory",
        },
      }),
      stderr: "",
    });

    const params = buildCommandTestParams("/ops 状态 smart-factory", baseCfg);
    const result = await handleOpsCommand(params, true);

    expect(result?.reply?.text).toContain("项目：smart-factory");
    expect(result?.reply?.text).toContain("cron：cron-123（已启用）");
    expect(result?.reply?.text).toContain("预览端口：8123");

    expect(hoisted.execFileUtf8Mock).toHaveBeenCalledOnce();
    const [, args] = hoisted.execFileUtf8Mock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(
      expect.arrayContaining(["-Action", "status", "-ProjectId", "smart-factory"]),
    );
  });

  it("passes onboard flags through to project-manager and renders the result", async () => {
    hoisted.execFileUtf8Mock.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        action: "onboard",
        project: {
          projectId: "demo",
          agentId: "demo",
          previewPort: 8123,
          cronId: "cron-demo",
        },
        cron: {
          id: "cron-demo",
          enabled: true,
        },
        doc: {
          url: "https://docs.example/demo",
        },
        runTriggered: true,
      }),
      stderr: "",
    });

    const params = buildCommandTestParams(
      '/ops 接管 demo "d:\\demo repo" --type web --every 15m --port 8123 --run-now',
      baseCfg,
    );
    const result = await handleOpsCommand(params, true);

    expect(result?.reply?.text).toContain("已接管 demo");
    expect(result?.reply?.text).toContain("agent：demo（新建）");
    expect(result?.reply?.text).toContain("首轮运行：已触发");

    const [, args] = hoisted.execFileUtf8Mock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(
      expect.arrayContaining([
        "-Action",
        "onboard",
        "-ProjectId",
        "demo",
        "-RepoPath",
        "d:\\demo repo",
        "-ProjectType",
        "web",
        "-ScheduleEvery",
        "15m",
        "-PreviewPort",
        "8123",
        "-RunNow",
      ]),
    );
  });

  it("falls back to project-ops when direct execution infrastructure fails", async () => {
    hoisted.execFileUtf8Mock.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "powershell.exe is not recognized as an internal or external command",
    });
    hoisted.callGatewayMock.mockImplementation(async (request: { method: string }) => {
      if (request.method === "agent") {
        return { runId: "run-ops-1" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "已通过 project-ops 完成列表查询。" }],
            },
          ],
        };
      }
      throw new Error(`Unexpected method: ${request.method}`);
    });

    const params = buildCommandTestParams("/ops list", baseCfg);
    const result = await handleOpsCommand(params, true);

    expect(result?.reply?.text).toContain("已通过 project-ops 完成列表查询");
    expect(hoisted.callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: "agent" }),
    );
  });

  it("uses fallback for doctor and waits synchronously for the reply", async () => {
    hoisted.callGatewayMock.mockImplementation(async (request: { method: string }) => {
      if (request.method === "agent") {
        return { runId: "run-doctor-1" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "诊断完成：项目健康，cron 正常。" }],
            },
          ],
        };
      }
      throw new Error(`Unexpected method: ${request.method}`);
    });

    const params = buildCommandTestParams("/ops doctor smart-factory", baseCfg);
    const result = await handleOpsCommand(params, true);

    expect(result?.reply?.text).toContain("诊断完成：项目健康，cron 正常。");
    expect(hoisted.execFileUtf8Mock).not.toHaveBeenCalled();
    expect(hoisted.callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({
          agentId: "project-ops",
          sessionKey: "agent:project-ops:main",
        }),
      }),
    );
  });

  it("returns a progress response when the direct path times out", async () => {
    hoisted.execFileUtf8Mock.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "Command failed: process timed out after 30000ms",
    });

    const params = buildCommandTestParams("/ops run smart-factory", baseCfg);
    const result = await handleOpsCommand(params, true);

    expect(result?.reply?.text).toContain("进行中");
    expect(result?.reply?.text).toContain("project-manager.ps1");
    expect(result?.reply?.text).toContain("/ops status smart-factory");
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  });
});
