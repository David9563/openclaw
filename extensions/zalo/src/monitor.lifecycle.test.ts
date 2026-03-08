import type { OpenClawConfig } from "openclaw/plugin-sdk/zalo";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedZaloAccount } from "./accounts.js";

const deleteWebhookMock = vi.fn(async () => ({ ok: true, result: true }));
const getUpdatesMock = vi.fn(() => new Promise(() => {}));

vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return {
    ...actual,
    deleteWebhook: deleteWebhookMock,
    getUpdates: getUpdatesMock,
  };
});

vi.mock("./runtime.js", () => ({
  getZaloRuntime: () => ({
    logging: {
      shouldLogVerbose: () => false,
    },
  }),
}));

describe("monitorZaloProvider lifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("stays alive in polling mode until abort", async () => {
    const { monitorZaloProvider } = await import("./monitor.js");
    const abort = new AbortController();
    const runtime = {
      log: vi.fn<(message: string) => void>(),
      error: vi.fn<(message: string) => void>(),
    };
    const account = {
      accountId: "default",
      config: {},
    } as unknown as ResolvedZaloAccount;
    const config = {} as OpenClawConfig;

    let settled = false;
    const run = monitorZaloProvider({
      token: "test-token",
      account,
      config,
      runtime,
      abortSignal: abort.signal,
    }).then(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(deleteWebhookMock).toHaveBeenCalledTimes(1);
    expect(getUpdatesMock).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    abort.abort();
    await run;

    expect(settled).toBe(true);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Zalo provider stopped mode=polling"),
    );
  });
});
