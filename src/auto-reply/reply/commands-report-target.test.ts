import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const validateConfigObjectWithPluginsMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn());
const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    readConfigFileSnapshot: readConfigFileSnapshotMock,
    validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
    writeConfigFile: writeConfigFileMock,
  };
});

vi.mock("../../gateway/call.js", () => ({
  callGateway: (options: unknown) => callGatewayMock(options),
}));

const { handleReportTargetCommand } = await import("./commands-report-target.js");
const { buildCommandTestParams } = await import("./commands.test-harness.js");

function buildGroupParams(commandBody: string, cfg: OpenClawConfig) {
  const params = buildCommandTestParams(commandBody, cfg, {
    Provider: "feishu",
    Surface: "feishu",
  });
  return {
    ...params,
    isGroup: true,
    sessionKey: "agent:smart-factory:feishu:group:oc_group_smart_factory",
    sessionEntry: {
      sessionId: "sess-group-1",
      updatedAt: Date.now(),
      lastChannel: "feishu",
      lastTo: "chat:oc_group_smart_factory",
      deliveryContext: {
        channel: "feishu",
        to: "chat:oc_group_smart_factory",
        accountId: "default",
      },
    },
  };
}

describe("report target command", () => {
  beforeEach(() => {
    readConfigFileSnapshotMock.mockReset();
    validateConfigObjectWithPluginsMock.mockReset();
    writeConfigFileMock.mockReset();
    callGatewayMock.mockReset();
    validateConfigObjectWithPluginsMock.mockImplementation((config: unknown) => ({
      ok: true,
      config,
    }));
  });

  it("moves an agent's report target to the current group and migrates cron jobs", async () => {
    const cfg = {
      agents: {
        list: [{ id: "smart-factory" }],
      },
    } satisfies OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue({
      valid: true,
      resolved: cfg,
    });
    callGatewayMock.mockImplementation(async (request: { method: string }) => {
      if (request.method === "cron.list") {
        return {
          jobs: [
            {
              id: "cron-1",
              agentId: "smart-factory",
              delivery: {
                mode: "announce",
                channel: "feishu",
                to: "user:ou_old",
                accountId: "default",
              },
            },
          ],
          hasMore: false,
        };
      }
      if (request.method === "cron.update") {
        return { id: "cron-1" };
      }
      throw new Error(`Unexpected method: ${request.method}`);
    });

    const result = await handleReportTargetCommand(
      buildGroupParams("以后这个项目的开发和汇报都在这个群里进行", cfg),
      true,
    );

    expect(result?.reply?.text).toContain("主汇报目标切到当前群");
    expect(result?.reply?.text).toContain("已迁移 cron：1/1");
    expect(writeConfigFileMock).toHaveBeenCalledOnce();
    expect(writeConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: expect.objectContaining({
          list: [
            expect.objectContaining({
              id: "smart-factory",
              reporting: {
                primaryTarget: {
                  channel: "feishu",
                  to: "chat:oc_group_smart_factory",
                  accountId: "default",
                },
              },
            }),
          ],
        }),
      }),
    );
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "cron.update",
        params: expect.objectContaining({
          id: "cron-1",
          patch: {
            delivery: {
              mode: "announce",
              channel: "feishu",
              to: "chat:oc_group_smart_factory",
              accountId: "default",
            },
          },
        }),
      }),
    );
  });

  it("is idempotent when the group is already the primary report target", async () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "smart-factory",
            reporting: {
              primaryTarget: {
                channel: "feishu",
                to: "chat:oc_group_smart_factory",
                accountId: "default",
              },
            },
          },
        ],
      },
    } satisfies OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue({
      valid: true,
      resolved: cfg,
    });
    callGatewayMock.mockResolvedValue({
      jobs: [],
      hasMore: false,
    });

    const result = await handleReportTargetCommand(buildGroupParams("把汇报迁到这里", cfg), true);

    expect(result?.reply?.text).toContain("已经是当前群");
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it("ignores unrelated group messages", async () => {
    const cfg = {
      agents: {
        list: [{ id: "smart-factory" }],
      },
    } satisfies OpenClawConfig;

    const result = await handleReportTargetCommand(
      buildGroupParams("页面太丑了，继续改一下首页布局", cfg),
      true,
    );

    expect(result).toBeNull();
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });
});
