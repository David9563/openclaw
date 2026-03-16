import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentPrimaryReportTarget, setAgentPrimaryReportTarget } from "./report-targets.js";

describe("agent report targets", () => {
  it("resolves a configured primary report target", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "writer",
            reporting: {
              primaryTarget: {
                channel: "feishu",
                to: "group:oc_writer",
                accountId: "default",
              },
            },
          },
        ],
      },
    } satisfies OpenClawConfig;

    expect(resolveAgentPrimaryReportTarget(cfg, "writer")).toEqual({
      channel: "feishu",
      to: "group:oc_writer",
      accountId: "default",
    });
  });

  it("updates an existing agent target", () => {
    const cfg = {
      agents: {
        list: [{ id: "writer" }],
      },
    } satisfies OpenClawConfig;

    const result = setAgentPrimaryReportTarget(cfg, "writer", {
      channel: "feishu",
      to: "group:oc_writer",
    });

    expect(result.changed).toBe(true);
    expect(resolveAgentPrimaryReportTarget(result.config, "writer")).toEqual({
      channel: "feishu",
      to: "group:oc_writer",
      accountId: undefined,
    });
  });

  it("adds a missing agent entry when needed", () => {
    const cfg = {} satisfies OpenClawConfig;

    const result = setAgentPrimaryReportTarget(cfg, "main", {
      channel: "feishu",
      to: "group:oc_main",
    });

    expect(result.changed).toBe(true);
    expect(result.config.agents?.list).toEqual([
      {
        id: "main",
        reporting: {
          primaryTarget: {
            channel: "feishu",
            to: "group:oc_main",
          },
        },
      },
    ]);
  });

  it("is idempotent when the target is unchanged", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "writer",
            reporting: {
              primaryTarget: {
                channel: "feishu",
                to: "group:oc_writer",
              },
            },
          },
        ],
      },
    } satisfies OpenClawConfig;

    const result = setAgentPrimaryReportTarget(cfg, "writer", {
      channel: "feishu",
      to: "group:oc_writer",
    });

    expect(result.changed).toBe(false);
    expect(result.config).toBe(cfg);
  });
});
