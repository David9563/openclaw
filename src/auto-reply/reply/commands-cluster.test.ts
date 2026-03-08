import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const hoisted = vi.hoisted(() => {
  const callGatewayMock = vi.fn();
  return { callGatewayMock };
});

vi.mock("../../gateway/call.js", () => ({
  callGateway: (args: unknown) => hoisted.callGatewayMock(args),
}));

const { handleClusterDelegationCommand } = await import("./commands-cluster.js");
const { buildCommandTestParams } = await import("./commands-spawn.test-harness.js");

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
  agents: {
    list: [{ id: "main", default: true }, { id: "writer", name: "Writer" }],
  },
} satisfies OpenClawConfig;

describe("cluster delegation command", () => {
  beforeEach(() => {
    hoisted.callGatewayMock.mockReset();
  });

  it("shows writer help for /writer without args", async () => {
    const params = buildCommandTestParams("/writer", baseCfg);
    const result = await handleClusterDelegationCommand(params, true);

    expect(result?.reply?.text).toContain("/writer 创建一个飞书文档");
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  });

  it("delegates explicit /writer tasks synchronously", async () => {
    hoisted.callGatewayMock.mockImplementation(async (request: { method: string }) => {
      if (request.method === "agent") {
        return { runId: "run-writer-1" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "https://feishu.cn/docx/writer-explicit" }],
            },
          ],
        };
      }
      throw new Error(`Unexpected method: ${request.method}`);
    });

    const params = buildCommandTestParams(
      "/writer 创建一个飞书文档，标题是 常用命令行速查",
      baseCfg,
    );
    const result = await handleClusterDelegationCommand(params, true);

    expect(result?.reply?.text).toBe("https://feishu.cn/docx/writer-explicit");
    expect(hoisted.callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({
          agentId: "writer",
          sessionKey: "agent:writer:main",
        }),
      }),
    );
  });

  it("auto-routes document/report intents to writer", async () => {
    hoisted.callGatewayMock.mockImplementation(async (request: { method: string }) => {
      if (request.method === "agent") {
        return { runId: "run-writer-2" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "已整理成飞书汇报。https://feishu.cn/docx/writer-auto" }],
            },
          ],
        };
      }
      throw new Error(`Unexpected method: ${request.method}`);
    });

    const params = buildCommandTestParams("把 smart-factory 当前进展整理成飞书汇报", baseCfg);
    const result = await handleClusterDelegationCommand(params, true);

    expect(result?.reply?.text).toContain("https://feishu.cn/docx/writer-auto");
    expect(hoisted.callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: "agent.wait" }),
    );
  });

  it("auto-routes review language like 复盘 to writer", async () => {
    hoisted.callGatewayMock.mockImplementation(async (request: { method: string }) => {
      if (request.method === "agent") {
        return { runId: "run-writer-3" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "复盘已整理。https://feishu.cn/docx/writer-retro" }],
            },
          ],
        };
      }
      throw new Error(`Unexpected method: ${request.method}`);
    });

    const params = buildCommandTestParams("帮我把这周的问题做个复盘", baseCfg);
    const result = await handleClusterDelegationCommand(params, true);

    expect(result?.reply?.text).toContain("https://feishu.cn/docx/writer-retro");
  });

  it("ignores unrelated messages", async () => {
    const params = buildCommandTestParams("帮我看下 smart-factory 的服务状态", baseCfg);
    const result = await handleClusterDelegationCommand(params, true);

    expect(result).toBeNull();
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  });
});
