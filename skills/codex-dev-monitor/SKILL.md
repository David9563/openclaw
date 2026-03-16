---
name: codex-dev-monitor
description: 'Delegate coding work to Codex and keep monitoring progress until it finishes. Use when the user wants Codex to implement, refactor, debug, or review code while the parent agent keeps watching logs, reporting status changes, and surfacing blockers. Default path: launch Codex locally with `exec` + `process`. On Windows, if `codex` is not on PATH, fall back to the VS Code ChatGPT extension `codex.exe`. For persistent thread-bound Codex sessions, first read the ACP router skill and use `sessions_spawn` with `runtime:"acp"` and `agentId:"codex"`. Avoid for tiny edits that are faster to do directly.'
metadata: { "openclaw": { "emoji": "🛠️" } }
---

# Codex Dev Monitor

Use this skill when the user says things like:

- "Let Codex build this and keep me posted."
- "Use Codex to fix this bug and monitor progress."
- "Run Codex on this repo and tell me how it is going."
- "让 Codex 去写，并持续汇报进度。"

## Default path: local Codex + progress monitoring

Prefer the local Codex CLI for the minimal monitored workflow.

1. Resolve the target repo/workdir.
2. Start Codex in the background with `exec`.
3. Capture the returned `sessionId`.
4. Monitor with `process log` + `process poll`.
5. Report only meaningful progress changes, blockers, or completion.

Use `pty: true` for Codex runs.

Use `codex exec --full-auto "<task>"` by default.

- Do **not** use `--yolo` unless the user explicitly asks for no-sandbox / no-approval behavior.
- Keep the task concrete: scope, acceptance criteria, and repo context in one prompt.

## Minimal launch patterns

### If `codex` is on PATH

```json
{
  "tool": "exec",
  "command": "codex exec --full-auto \"Implement the requested change, run the relevant tests, and summarize files changed.\"",
  "workdir": "<repo>",
  "pty": true,
  "background": true
}
```

### Windows fallback: use the VS Code ChatGPT extension binary

If `codex` is missing from PATH on Windows, resolve the latest bundled binary under `~/.vscode/extensions/openai.chatgpt-*/bin/windows-x86_64/codex.exe` and invoke it through PowerShell:

```json
{
  "tool": "exec",
  "command": "$codex = Get-ChildItem \"$HOME/.vscode/extensions/openai.chatgpt-*/bin/windows-x86_64/codex.exe\" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName; if (-not $codex) { throw 'codex.exe not found' }; & $codex exec --full-auto \"Implement the requested change, run the relevant tests, and summarize files changed.\"",
  "workdir": "<repo>",
  "pty": true,
  "background": true
}
```

## Monitoring loop

After launch:

1. Save the `sessionId`.
2. Fetch logs first:

```json
{ "tool": "process", "action": "log", "sessionId": "<id>" }
```

3. Then check status:

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

4. If still running, wait with backoff before polling again.

Recommended cadence:

- first follow-up: ~2 seconds
- second follow-up: ~5 seconds
- then every ~10–20 seconds

Do **not** tight-loop identical `poll` calls. Report progress when:

- Codex starts a new phase
- Codex names files/tests it is touching
- Codex hits a blocker or asks for input
- the process exits

If Codex appears stuck, say so clearly and include the latest useful log excerpt in paraphrase.

## Reporting style

While Codex is running, give short progress updates such as:

- "Codex is scanning the repo and planning edits."
- "Codex started modifying auth and test files."
- "Codex is blocked on a failing test command."

When finished, include:

- result status
- files changed
- tests run / not run
- remaining risks or manual follow-ups

## Git repo rule

Codex works best inside a trusted git repo.

- If the target is a real project repo, run there.
- If the user wants scratch work, create a temp directory and `git init` before launching Codex.
- If the workdir is unclear, ask for the repo path instead of guessing.

## ACP path for persistent sessions

If the user explicitly wants a persistent Codex thread/session, do not use the local background-process path first.

Instead:

1. Read `extensions/acpx/skills/acp-router/SKILL.md`.
2. Use `sessions_spawn` with:
   - `runtime: "acp"`
   - `agentId: "codex"`
   - `mode: "session"` for persistent work
   - `thread: true` when the user wants a bound thread

Use the local `exec` + `process` path only for the minimal monitored workflow in the current agent session.

## Failure handling

- If `codex` is missing and the Windows fallback binary is missing too, report that Codex is unavailable locally.
- If the process exits immediately, inspect the first log output before retrying.
- If Codex asks a real product/engineering question, relay it to the user instead of guessing.
- If the task is small enough to do directly, skip delegation and just edit the code yourself.
