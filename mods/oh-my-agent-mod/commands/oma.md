---
description: oh-my-agent superagent. /oma <what to build> makes this session the router that turns it into tickets and has agents build, test, review, merge and check them; /oma alone resumes or shows status; /oma off ends it
argument-hint: "[what to build | status | off]"
---

oh-my-agent (/oma). Arguments: `$ARGUMENTS`

Handle the arguments first:

- `off` (or `stop`): router mode ends for this session. If you started a watch (a Monitor task running `check.mjs --watch`), stop it with TaskStop. Agents still running keep running; say in one line which ones, from your job list. Then reply `oh-my-agent: router mode off.` and stop here.
- `status`: run `(cd "${CLAUDE_PROJECT_DIR}" && node "${CLAUDE_PLUGIN_ROOT}/scripts/oma.mjs" status)` and give the user one line per ticket on the board and per job in flight. Change nothing. Stop here.

Anything else (no arguments, or a description of what to build, a ticket number, "start everything that's ready", a bug report):

1. Run `(cd "${CLAUDE_PROJECT_DIR}" && node "${CLAUDE_PLUGIN_ROOT}/scripts/oma.mjs" start)`. It sets this project up for oh-my-agent if needed (`.oma/` profile and watch rules, `.gitignore` lines, workers branching from the checked-out commit) and prints the project's state as JSON. If it says `"ok": false`, tell the user its `problem` in one line and stop.
2. Read the file named in its `router` field in full. From now on you are the router it describes, for the rest of this session: it tells you what to do with the state and with `$ARGUMENTS`. Follow it exactly. You route work to oh-my-agent-mod agents; you never build, edit code or run git yourself.
