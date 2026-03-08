import type { OpenClawConfig } from "openclaw/plugin-sdk/zalo";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedZaloAccount } from "./accounts.js";

const getWebhookInfoMock = vi.fn(async () => ({ ok: true, result: { url: "" } }));
const deleteWebhookMock = vi.fn(async () => ({ ok: true, result: { url: "" } }));
const getUpdatesMock = vi.fn(() => new Promise(() => {}));

vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return {
    ...actual,
    deleteWebhook: deleteWebhookMock,
    getWebhookInfo: getWebhookInfoMock,
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

    expect(getWebhookInfoMock).toHaveBeenCalledTimes(1);
    expect(deleteWebhookMock).not.toHaveBeenCalled();
    expect(getUpdatesMock).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    abort.abort();
    await run;

    expect(settled).toBe(true);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Zalo provider stopped mode=polling"),
    );
  });

  it("deletes an existing webhook before polling", async () => {
    getWebhookInfoMock.mockResolvedValueOnce({
      ok: true,
      result: { url: "https://example.com/hooks/zalo" },
    });

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

    const run = monitorZaloProvider({
      token: "test-token",
      account,
      config,
      runtime,
      abortSignal: abort.signal,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(getWebhookInfoMock).toHaveBeenCalledTimes(1);
    expect(deleteWebhookMock).toHaveBeenCalledTimes(1);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Zalo polling mode ready (webhook disabled)"),
    );

    abort.abort();
    await run;
  });

  it("continues polling when webhook inspection returns 404", async () => {
    const { ZaloApiError } = await import("./api.js");
    getWebhookInfoMock.mockRejectedValueOnce(new ZaloApiError("Not Found", 404, "Not Found"));

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

    const run = monitorZaloProvider({
      token: "test-token",
      account,
      config,
      runtime,
      abortSignal: abort.signal,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(getWebhookInfoMock).toHaveBeenCalledTimes(1);
    expect(deleteWebhookMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("webhook inspection unavailable; continuing without webhook cleanup"),
    );
    expect(runtime.error).not.toHaveBeenCalled();

    abort.abort();
    await run;
  });
});
