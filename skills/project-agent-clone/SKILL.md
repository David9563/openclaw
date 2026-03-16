---
name: project-agent-clone
description: 'Create or reuse a dedicated project agent, copy the current workspace bootstrap files and skills into it, copy auth profiles so it can run immediately, then optionally hand the project task to that new agent. Use when: (1) the user explicitly asks to create a clone/分身 for a project; OR (2) the user asks to create or take over a development project AND the task involves frontend work (pages, UI, components, design, etc.) — in that case automatically create a project agent without waiting for the user to ask for a clone. Ask for the project path only when it is not already clear from context.'
metadata: { "openclaw": { "emoji": "🧬" } }
---

# Project Agent Clone

Use this skill when the user wants a **real project-specific agent**, not just a one-off skill run.

Typical requests:

- "Create a project clone for this repo and let it handle the work."
- "Spawn a dedicated agent for this project."
- "给这个项目创建一个分身，然后让它接手。"
- "帮我开发这个项目的前端页面。" ← auto-trigger: frontend work detected
- "接手这个项目，把页面做出来。" ← auto-trigger: frontend work detected
- "创建一个开发项目，做后台管理界面。" ← auto-trigger: frontend work detected

## What this skill does

It creates or reuses a dedicated OpenClaw agent for a project and syncs the important context:

- copies bootstrap files from the current workspace:
  - `AGENTS.md`
  - `SOUL.md`
  - `TOOLS.md`
  - `IDENTITY.md`
  - `USER.md`
- copies the current workspace `skills/`
- copies the current agent `auth-profiles.json`
- writes a `PROJECT.md` file in the new workspace
- updates the current agent's `subagents.allowAgents` so it can delegate to the new agent
- ensures the project agent has a coding-capable tool baseline so it can actually write code
- appends the new agent to `tools.agentToAgent.allow` when that global allowlist is present

After setup, if the user included real work to do, immediately delegate the task to the new agent with `sessions_spawn`.

## When to trigger automatically

Besides explicit "create a clone" requests, **auto-trigger this skill without waiting for the user to ask** when all of these are true:

1. The user asks main to create, start, or take over a development project.
2. The task clearly involves frontend work: pages, UI components, design, layout, admin panel, dashboard, etc.
3. A concrete project path is available or can be inferred.

In this case, treat the project agent clone as the **first step** before any actual development begins. Do not hand frontend work directly to `frontend-ui-designer` or `codex-dev-monitor` from main — instead, create the project agent first and let it own the frontend work.

## When to ask a question

Ask a short question only if the project path is unclear.

If the repo path is already obvious from the conversation or tool context, do **not** ask again.

## Setup step

Run the helper script:

```json
{
  "tool": "exec",
  "command": "node \"{baseDir}/scripts/create-project-agent.mjs\" --project-path \"<absolute-project-path>\" --task \"<original user request>\"",
  "background": false
}
```

The script prints JSON. Read it and extract:

- `agentId`
- `projectPath`
- `workspace`
- `created`
- `reused`

## Create Feishu group step

After the agent is set up, create a dedicated Feishu group so the user can talk directly to the project agent:

1. Call `feishu_chat` with `action: "create"`, `name: "项目-<agentId>"`, and `user_ids: [<requester open_id if known>]`.
2. The group name matches the agent id pattern — `autoGroupBinding` will bind the group to the agent automatically on the first message.
3. If the create call fails, skip silently and tell the user the group name to create manually: `项目-<agentId>`.

## Delegation step

Spawn the project agent in **session mode** so the user can continue the conversation directly in the Feishu group:

Default task template:

```text
Read AGENTS.md and PROJECT.md in your workspace first.
The project repo root is: <projectPath>
For multi-feature projects needing requirements analysis, prioritization, and task planning, use the `pm-agent` skill first.
For frontend/UI design, redesign, or polish work, use the `frontend-ui-designer` skill first.
When coding should run through Codex with progress tracking, use the `codex-dev-monitor` skill.
Report progress at each major milestone: after scaffold, after service/data layer, after each major page group, after final check.
Do not commit, push, or create branches unless the user explicitly asks.
Current assignment:
<original user request>
```

Guidelines:

- Default to `mode: "session"` for all project work so the user can follow up in the Feishu group.
- Use `mode: "run"` only for truly one-shot tasks where no follow-up is expected.
- Set `agentId` to the returned project agent id.

## Reporting back

Report three phases clearly:

1. project agent setup (created vs reused, agent id, project path, skills/auth synced)
2. Feishu group result — group name `项目-<agentId>` and whether it was created automatically
3. task handoff — confirm the agent is running in session mode

Tell the user: the project agent is live, and they can continue the conversation directly in the `项目-<agentId>` Feishu group.

## Notes

- This skill creates a **real configured agent**, not a temporary subagent only.
- The copied skills let the new agent keep specialized workflows like `codex-dev-monitor`.
- For page design and UI polish, the copied skills can also include `frontend-ui-designer`.
- If the user only wants a temporary one-off worker, do **not** use this skill; use normal `sessions_spawn` instead.
