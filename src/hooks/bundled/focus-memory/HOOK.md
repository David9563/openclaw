---
name: focus-memory
description: "Keep a small current-focus summary in memory.md from direct messages to main"
homepage: https://docs.openclaw.ai/automation/hooks#focus-memory
metadata:
  {
    "openclaw":
      {
        "emoji": "🧭",
        "events": ["message:preprocessed"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Focus Memory Hook

Keeps a tiny, always-injected `memory.md` summary up to date from recent direct
messages to `main`.

## What It Does

When the operator sends a direct message to `main`, this hook:

1. Extracts the most likely current project from the message
2. Updates the current request / desired next task
3. Maintains a short recent-projects and recent-requests list
4. Writes a compact summary to `<workspace>/memory.md`

Because `memory.md` is injected into the system prompt, `main` can use the
latest focus on future turns without needing a separate database.

## Scope

- **Agent**: `main` only
- **Chat type**: direct chats only
- **Source**: inbound `message:preprocessed`

## Output

- `memory.md`

## Enable

```bash
openclaw hooks enable focus-memory
```
