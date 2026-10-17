# codebase-memory-mod

Installs codebase-memory-mcp 0.12.0 on first use, registers its MCP server, and puts its graph first in every chat and subagent.

## What the hooks do

| Event | Hook | Effect |
|---|---|---|
| SessionStart | `hooks/context.js session` | Adds `AGENTS.md` to the context. If the workspace is a git root with no graph yet, starts the first index in the background. |
| UserPromptSubmit | `hooks/context.js prompt` | One-line reminder on every message. |
| SubagentStart | `hooks/context.js subagent` | Adds `AGENTS.md` to each subagent. |
| PreToolUse on `Grep\|Glob\|Bash` | `hooks/gate.js` | While `.codebase-memory/graph.db.zst` exists, denies Grep, Glob, and grep, rg, ag, ack, find or git grep as commands. The denial names the graph tools to use. |

Tests: `node --test mods/codebase-memory-mod/test/hooks.test.js`

## Turning the gate off

The gate is for the model's behavior. To lift it on this machine, create the file below. Delete it to turn the gate back on.

```bash
mkdir -p ~/.cache/codebase-memory-mcp && touch ~/.cache/codebase-memory-mcp/gate-off
```

## Logs

First-index output goes to `~/.cache/codebase-memory-mcp/index.log`.
