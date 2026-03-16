import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveStateDir } from "../../../config/paths.js";
import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import type { HookHandler } from "../../hooks.js";
import { isMessagePreprocessedEvent } from "../../internal-hooks.js";

const log = createSubsystemLogger("hooks/focus-memory");
const GENERATED_STATE_RE = /<!--\s*openclaw:focus-memory-state\s*([\s\S]*?)-->/i;
const MAX_RECENT_ITEMS = 5;
const MAX_REQUEST_LENGTH = 160;

type FocusProject = {
  projectId?: string;
  agentId?: string;
  cronId?: string;
  status?: string;
};

type FocusState = {
  updatedAt?: string;
  activeProject?: FocusProject;
  currentRequest?: string;
  recentProjects: string[];
  recentRequests: string[];
};

type FocusUpdate = {
  activeProject?: FocusProject;
  currentRequest?: string;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeMessageText(value: string): string {
  return value
    .replace(/\\(?=[`*_\-])/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeProjectId(value: string): string | undefined {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, "")
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || undefined;
}

function parseStructuredProjectFields(raw: string): FocusProject {
  const project: FocusProject = {};
  const lines = raw.split("\n").map((line) => line.replace(/\\(?=[`*_\-])/g, "").trim());
  for (const line of lines) {
    const projectId = line.match(/^[-*]?\s*projectid\s*[:：]\s*(.+)$/i);
    if (projectId?.[1]) {
      project.projectId = normalizeProjectId(projectId[1]);
      continue;
    }
    const agentId = line.match(/^[-*]?\s*agent\s*[:：]\s*(.+)$/i);
    if (agentId?.[1]) {
      project.agentId = normalizeProjectId(agentId[1]);
      continue;
    }
    const cronId = line.match(/^[-*]?\s*cron\s*[:：]\s*([a-z0-9-]+)$/i);
    if (cronId?.[1]) {
      project.cronId = cronId[1].trim();
      continue;
    }
    const status = line.match(/^[-*]?\s*status\s*[:：]\s*(.+)$/i);
    if (status?.[1]) {
      project.status = status[1].trim();
    }
  }
  return project;
}

function parseInlineProjectId(raw: string): string | undefined {
  const explicit =
    raw.match(/\bprojectid\s*[:：]\s*([a-z0-9][a-z0-9._-]*)/i)?.[1] ??
    raw.match(/`([a-z0-9][a-z0-9._-]*)`/)?.[1];
  if (explicit) {
    return normalizeProjectId(explicit);
  }

  const englishLabel = raw.match(/([A-Za-z][A-Za-z0-9 _-]{2,40})\s*的(?:开发|页面|界面|前端)/u)?.[1];
  if (englishLabel) {
    return normalizeProjectId(englishLabel);
  }

  return undefined;
}

function stripProjectMetadataLines(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/\\(?=[`*_\-])/g, "").trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^[-*]?\s*(projectid|agent|cron|status)\s*[:：]/i.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripGenericPreambles(raw: string): string {
  let text = stripProjectMetadataLines(raw);
  text = text.replace(
    /^(?:给|把|向|往)?(?:这个|当前|该)?项目(?:挂载|追加|记录|同步)(?:一条|一个)?(?:新的)?(?:任务|内容)?(?:，|,|：|:)?\s*/i,
    "",
  );
  text = text.replace(
    /^(?:让|叫)?(?:main|writer)?\s*(?:去)?(?:处理|记录|写|创建)?(?:，|,|：|:)?\s*/i,
    "",
  );
  if (/^(?:任务|需求|问题|重点)/.test(text)) {
    text = text.replace(/^(?:任务|需求|问题|重点)(?:是|为)?(?:，|,|：|:)?\s*/i, "");
  }
  const genericCarrier = text.match(/^.{0,32}?就是(.+)$/);
  if (genericCarrier?.[1] && /(?:挂载|任务|内容|需求|重点)/.test(text.slice(0, genericCarrier.index ?? 0 + 2))) {
    text = genericCarrier[1].trim();
  }
  return text.trim();
}

function summarizeRequest(raw: string): string | undefined {
  const text = stripGenericPreambles(normalizeMessageText(raw));
  if (!text) {
    return undefined;
  }
  if (
    /^(?:好|好的|ok|收到|继续|嗯|嗯嗯|谢谢|辛苦|是的|对|对的|可以|行|好的继续)[!！。.,，\s]*$/i.test(
      text,
    )
  ) {
    return undefined;
  }
  const sentence = text.split(/(?<=[。！？!?])\s+/u)[0] ?? text;
  const compact = sentence.replace(/\s+/g, " ").trim();
  return compact.length > MAX_REQUEST_LENGTH
    ? `${compact.slice(0, MAX_REQUEST_LENGTH - 1).trimEnd()}…`
    : compact;
}

function parseState(content: string): FocusState {
  const json = content.match(GENERATED_STATE_RE)?.[1]?.trim();
  if (!json) {
    return { recentProjects: [], recentRequests: [] };
  }
  try {
    const parsed = JSON.parse(json) as Partial<FocusState>;
    return {
      updatedAt: readString(parsed.updatedAt),
      activeProject:
        parsed.activeProject && typeof parsed.activeProject === "object"
          ? {
              projectId: readString(parsed.activeProject.projectId),
              agentId: readString(parsed.activeProject.agentId),
              cronId: readString(parsed.activeProject.cronId),
              status: readString(parsed.activeProject.status),
            }
          : undefined,
      currentRequest: readString(parsed.currentRequest),
      recentProjects: Array.isArray(parsed.recentProjects)
        ? parsed.recentProjects.map((item) => readString(item)).filter((item): item is string => Boolean(item))
        : [],
      recentRequests: Array.isArray(parsed.recentRequests)
        ? parsed.recentRequests.map((item) => readString(item)).filter((item): item is string => Boolean(item))
        : [],
    };
  } catch {
    return { recentProjects: [], recentRequests: [] };
  }
}

function dedupePush(items: string[], value: string | undefined): string[] {
  if (!value) {
    return items.slice(0, MAX_RECENT_ITEMS);
  }
  return [value, ...items.filter((item) => item !== value)].slice(0, MAX_RECENT_ITEMS);
}

function mergeProject(prev?: FocusProject, next?: FocusProject): FocusProject | undefined {
  const merged = {
    projectId: next?.projectId ?? prev?.projectId,
    agentId: next?.agentId ?? prev?.agentId,
    cronId: next?.cronId ?? prev?.cronId,
    status: next?.status ?? prev?.status,
  };
  return merged.projectId || merged.agentId || merged.cronId || merged.status ? merged : undefined;
}

function mergeState(prev: FocusState, update: FocusUpdate, timestamp: Date): FocusState {
  const nextProject = mergeProject(prev.activeProject, update.activeProject);
  return {
    updatedAt: timestamp.toISOString(),
    activeProject: nextProject,
    currentRequest: update.currentRequest ?? prev.currentRequest,
    recentProjects: dedupePush(prev.recentProjects, nextProject?.projectId),
    recentRequests: dedupePush(prev.recentRequests, update.currentRequest),
  };
}

function renderState(state: FocusState): string {
  const lines: string[] = [
    "<!-- openclaw:focus-memory-state",
    JSON.stringify(state, null, 2),
    "-->",
    "# Current Focus",
    "",
    `- Updated: ${state.updatedAt ?? "unknown"}`,
    `- Active project: ${state.activeProject?.projectId ? `\`${state.activeProject.projectId}\`` : "none"}`,
    `- Active agent: ${state.activeProject?.agentId ? `\`${state.activeProject.agentId}\`` : "none"}`,
    `- Project status: ${state.activeProject?.status ?? "unknown"}`,
    `- Current request: ${state.currentRequest ?? "none"}`,
    "",
    "## Recent Projects",
  ];
  if (state.recentProjects.length === 0) {
    lines.push("- none");
  } else {
    for (const item of state.recentProjects) {
      lines.push(`- \`${item}\``);
    }
  }
  lines.push("", "## Recent Requests");
  if (state.recentRequests.length === 0) {
    lines.push("- none");
  } else {
    for (const item of state.recentRequests) {
      lines.push(`- ${item}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function buildUpdate(rawText: string): FocusUpdate | null {
  const normalized = normalizeMessageText(rawText);
  if (!normalized) {
    return null;
  }
  const structured = parseStructuredProjectFields(normalized);
  const inlineProjectId = parseInlineProjectId(normalized);
  const activeProject = mergeProject(undefined, {
    ...structured,
    projectId: structured.projectId ?? inlineProjectId,
  });
  const currentRequest = summarizeRequest(normalized);
  if (!activeProject && !currentRequest) {
    return null;
  }
  return {
    activeProject,
    currentRequest,
  };
}

const updateFocusMemory: HookHandler = async (event) => {
  if (!isMessagePreprocessedEvent(event)) {
    return;
  }
  if (resolveAgentIdFromSessionKey(event.sessionKey) !== "main") {
    return;
  }
  if (event.context.isGroup) {
    return;
  }

  const rawText = readString(event.context.bodyForAgent) ?? readString(event.context.body);
  if (!rawText) {
    return;
  }

  const update = buildUpdate(rawText);
  if (!update) {
    return;
  }

  try {
    const cfg = event.context.cfg as OpenClawConfig | undefined;
    const workspaceDir = cfg
      ? resolveAgentWorkspaceDir(cfg, "main")
      : path.join(resolveStateDir(process.env, os.homedir()), "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    const focusFile = path.join(workspaceDir, "memory.md");
    const previous = await fs.readFile(focusFile, "utf8").catch(() => "");
    const prevState = parseState(previous);
    const nextState = mergeState(prevState, update, event.timestamp);
    await writeFileWithinRoot({
      rootDir: workspaceDir,
      relativePath: "memory.md",
      data: renderState(nextState),
      encoding: "utf8",
      mkdir: true,
    });
  } catch (err) {
    log.error(`Failed to update focus memory: ${err instanceof Error ? err.message : String(err)}`);
  }
};

export default updateFocusMemory;
