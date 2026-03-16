import type { OpenClawConfig } from "openclaw/plugin-sdk/feishu";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../../test-utils/plugin-runtime-mock.js";
import { resolveFeishuAccount } from "./accounts.js";
import { maybeAutoBindFeishuGroupByName } from "./auto-group-binding.js";

const { mockCreateFeishuClient } = vi.hoisted(() => ({
  mockCreateFeishuClient: vi.fn(),
}));

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

function createBaseConfig(): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "main" }, { id: "smart-factory" }, { id: "writer", name: "写作" }],
    },
    channels: {
      feishu: {
        appId: "cli_test",
        appSecret: "sec_test", // pragma: allowlist secret
        groupPolicy: "allowlist",
      },
    },
    bindings: [],
  } as OpenClawConfig;
}

describe("maybeAutoBindFeishuGroupByName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateFeishuClient.mockReturnValue({
      im: {
        chat: {
          get: vi.fn().mockResolvedValue({
            code: 0,
            data: { name: "项目-smart-factory" },
          }),
        },
      },
    });
  });

  it("binds a Feishu group to an existing agent by prefixed group name", async () => {
    const cfg = createBaseConfig();
    const runtime = createPluginRuntimeMock({
      config: {
        loadConfig: vi.fn(() => cfg),
        writeConfigFile: vi.fn(async () => {}),
      },
    });
    const account = resolveFeishuAccount({ cfg, accountId: "default" });

    const result = await maybeAutoBindFeishuGroupByName({
      cfg,
      runtime,
      account,
      chatId: "oc_smart",
      autoBindCfg: { enabled: true },
      ensureGroupAllowed: true,
      log: vi.fn(),
    });

    expect(result.created).toBe(true);
    expect(result.agentId).toBe("smart-factory");

    const written = vi.mocked(runtime.config.writeConfigFile).mock.calls[0]?.[0] as OpenClawConfig;
    expect(written.bindings).toEqual([
      expect.objectContaining({
        agentId: "smart-factory",
        match: expect.objectContaining({
          channel: "feishu",
          peer: { kind: "group", id: "oc_smart" },
        }),
      }),
    ]);
    expect((written.channels?.feishu as { groupAllowFrom?: string[] } | undefined)?.groupAllowFrom)
      .toContain("oc_smart");
  });

  it("supports explicit aliases for group names", async () => {
    const cfg = createBaseConfig();
    const runtime = createPluginRuntimeMock({
      config: {
        loadConfig: vi.fn(() => cfg),
        writeConfigFile: vi.fn(async () => {}),
      },
    });
    const account = resolveFeishuAccount({ cfg, accountId: "default" });
    mockCreateFeishuClient.mockReturnValue({
      im: {
        chat: {
          get: vi.fn().mockResolvedValue({
            code: 0,
            data: { name: "文档写作" },
          }),
        },
      },
    });

    const result = await maybeAutoBindFeishuGroupByName({
      cfg,
      runtime,
      account,
      chatId: "oc_writer",
      autoBindCfg: {
        enabled: true,
        aliases: { "文档写作": "writer" },
      },
      ensureGroupAllowed: false,
      log: vi.fn(),
    });

    expect(result.created).toBe(true);
    expect(result.agentId).toBe("writer");
  });

  it("does nothing when the group is already bound", async () => {
    const cfg = {
      ...createBaseConfig(),
      bindings: [
        {
          agentId: "smart-factory",
          match: {
            channel: "feishu",
            peer: { kind: "group", id: "oc_smart" },
          },
        },
      ],
    } as OpenClawConfig;
    const runtime = createPluginRuntimeMock({
      config: {
        loadConfig: vi.fn(() => cfg),
        writeConfigFile: vi.fn(async () => {}),
      },
    });
    const account = resolveFeishuAccount({ cfg, accountId: "default" });

    const result = await maybeAutoBindFeishuGroupByName({
      cfg,
      runtime,
      account,
      chatId: "oc_smart",
      autoBindCfg: { enabled: true },
      ensureGroupAllowed: true,
      log: vi.fn(),
    });

    expect(result.created).toBe(false);
    expect(vi.mocked(runtime.config.writeConfigFile)).not.toHaveBeenCalled();
  });

  it("does not bind when the name is ambiguous", async () => {
    const cfg = {
      ...createBaseConfig(),
      agents: {
        list: [
          { id: "writer", name: "内容" },
          { id: "content", name: "writer" },
        ],
      },
    } as OpenClawConfig;
    const runtime = createPluginRuntimeMock({
      config: {
        loadConfig: vi.fn(() => cfg),
        writeConfigFile: vi.fn(async () => {}),
      },
    });
    const account = resolveFeishuAccount({ cfg, accountId: "default" });
    mockCreateFeishuClient.mockReturnValue({
      im: {
        chat: {
          get: vi.fn().mockResolvedValue({
            code: 0,
            data: { name: "writer" },
          }),
        },
      },
    });

    const result = await maybeAutoBindFeishuGroupByName({
      cfg,
      runtime,
      account,
      chatId: "oc_ambiguous",
      autoBindCfg: { enabled: true },
      ensureGroupAllowed: true,
      log: vi.fn(),
    });

    expect(result.created).toBe(false);
    expect(result.reason).toBe("ambiguous-agent-match");
    expect(vi.mocked(runtime.config.writeConfigFile)).not.toHaveBeenCalled();
  });
});
