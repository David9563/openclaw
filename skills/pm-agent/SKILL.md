---
name: pm-agent
description: 'Create or reuse a dedicated product-manager project agent, copy workspace bootstrap files and skills into it, then hand it the project so it can do requirements analysis, feature prioritization, task breakdown, and coordinated handoff to development agents. Use when: (1) the user explicitly asks for a product manager or PM agent for a project; OR (2) the user asks to create, plan, or start a development project of non-trivial scope (a system, application, product, or multi-feature work) — in that case automatically create a PM agent without waiting for the user to ask for one. Ask for the project path only when it is not already clear from context.'
metadata: { "openclaw": { "emoji": "📋" } }
---

# PM Agent

Use this skill when a development project needs **requirements clarity, prioritization, task planning, or coordinated delivery** before coding begins.

Typical requests:

- "帮我开发一个电商后台管理系统。" ← auto-trigger: dev project of real scope
- "接手这个项目，先把需求梳理清楚再做。" ← auto-trigger: PM work needed
- "给这个项目创建一个产品经理分身。"
- "Help me build a project management dashboard from scratch." ← auto-trigger
- "Plan out the features for this app and break them into tasks."

## What this skill does

It creates or reuses a dedicated PM project agent and syncs the important context:

- copies bootstrap files from the current workspace (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`)
- copies the current workspace `skills/` so the PM agent can delegate to `frontend-ui-designer` and `codex-dev-monitor`
- copies the current agent `auth-profiles.json`
- writes a `PROJECT.md` file in the new workspace
- updates the current agent's `subagents.allowAgents` so it can delegate to the PM agent
- ensures the PM agent has a coding-capable tool baseline

After setup, immediately delegate the project to the new PM agent.

## When to trigger automatically

Besides explicit "create a PM agent" requests, **auto-trigger this skill without waiting for the user to ask** when all of these are true:

1. The user asks main to create, plan, or start a development project.
2. The project has real scope: a system, application, product feature set, or multi-screen work.
3. A concrete project path is available or can be inferred.

Do not trigger for single-file bug fixes, small patches, or one-off script requests. Trigger for anything that would benefit from requirements clarity and phased execution.

When both `pm-agent` and `project-agent-clone` could apply, prefer `pm-agent` — it includes the PM role and orchestration layer on top of the agent clone.

## When to ask a question

Ask a short question only if the project path is unclear.

If the repo path is already obvious from the conversation or tool context, do **not** ask again.

## Setup step

Use the `project-agent-clone` script with a PM-specific agent id:

```json
{
  "tool": "exec",
  "command": "node \"{project-agent-clone:baseDir}/scripts/create-project-agent.mjs\" --project-path \"<absolute-project-path>\" --agent-id \"pm-<project-name>\" --task \"<original user request>\"",
  "background": false
}
```

The script prints JSON. Read it and extract:

- `agentId`
- `projectPath`
- `workspace`
- `created`
- `reused`

## Role configuration

When spawning the PM agent, give it the following role context in the task prompt:

```text
Read AGENTS.md and PROJECT.md in your workspace first.
The project repo root is: <projectPath>

You are acting as the product manager for this project. Your role combines:
- Sprint Prioritizer (references/sprint-prioritizer.md): prioritize features, plan sprints, write acceptance criteria
- Senior Project Manager (references/senior-pm.md): convert requirements into 30-90 min dev tasks, no scope inflation
- Project Shepherd (references/project-shepherd.md): coordinate handoffs to frontend-ui-designer and codex-dev-monitor

Read only the reference files needed for the current phase:
- requirements gathering / prioritization → start with references/sprint-prioritizer.md
- task breakdown / spec-to-task conversion → add references/senior-pm.md
- coordinating agent handoffs → add references/project-shepherd.md

Default workflow:
1. Clarify requirements — ask only what is genuinely blocking, not everything at once.
2. Prioritize features using RICE or MoSCoW; document your rationale.
3. Break sprint 1 features into 30-90 min tasks with clear acceptance criteria.
4. For frontend pages or UI components, hand off to the frontend-ui-designer skill first.
5. For implementation, hand off to codex-dev-monitor.
6. Report back to the owner agent at key milestones.

Do not commit, push, or create branches unless the user explicitly asks.
Current assignment:
<original user request>
```

## Create Feishu group step

After the agent is set up, create a dedicated Feishu group so the user can talk directly to the PM agent:

1. Call `feishu_chat` with `action: "create"`, `name: "项目-<agentId>"`, and `user_ids: [<requester open_id if known>]`.
2. The group name matches the agent id pattern — `autoGroupBinding` will bind the group to the PM agent automatically on the first message.
3. If the create call fails, skip silently and tell the user the group name to create manually: `项目-<agentId>`.

## Delegation step

Spawn the PM agent in **session mode** so the user can continue the conversation directly in the Feishu group:

Guidelines:

- Default to `mode: "session"` so the user can follow up, add requirements, or redirect work from the Feishu group.
- Use `mode: "run"` only if the user explicitly wants a one-shot plan with no follow-up.
- Set `agentId` to the returned PM agent id.

## Reporting back

Report three phases clearly:

1. PM agent setup (created vs reused, agent id, project path, skills/auth synced)
2. Feishu group result — group name `项目-<agentId>` and whether it was created automatically
3. task handoff — confirm the PM agent is running in session mode

Tell the user: the PM agent is live, and they can continue the conversation directly in the `项目-<agentId>` Feishu group.

## Notes

- The PM agent owns the **planning layer**: requirements, prioritization, task breakdown, and agent coordination.
- It does **not** write production code directly — it delegates to `frontend-ui-designer` and `codex-dev-monitor`.
- If the project is purely a frontend polish request with no planning needed, prefer `project-agent-clone` + `frontend-ui-designer` directly.
- If the user only wants a temporary one-off worker, do **not** use this skill; use normal `sessions_spawn` instead.
