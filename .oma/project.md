# Project profile

**Profile:** filled in

Every oh-my-agent agent reads this file for what depends on this project: how to install, lint, build, test and start it, how to make a test account, and which user flows matter most. `/oma` fills it in on its first run (the ticket-writer agent reads the project, replaces every double-brace placeholder, checks the start command on a spare port) and sets the line above to `**Profile:** filled in`. The router routes nothing until it says `filled in`.

The `oma` helper (on every session's PATH while the plugin is on) reads the json block below, so keep it valid JSON. Wherever a command needs a port, write `<port>`; agents swap in their own. A command the project doesn't have is `"none"`, and agents skip that step.

```json
{
  "appType": "cli",
  "install": "none",
  "lint": "for m in mods/*-mod; do claude plugin validate \"$m\" || exit 1; done",
  "build": "none",
  "test": "node --test mods/oh-my-agent-mod/test/*.test.mjs mods/caveman-mod/test/*.test.js mods/oh-my-context-mod/test/*.test.js mods/codebase-memory-mod/test/*.test.js && PYTHONPATH=mods/oh-my-context-mod/vendor python3 -m unittest discover -s mods/oh-my-context-mod/test -p 'test_*.py'",
  "start": "none",
  "upPath": "none",
  "mainPort": 3000,
  "agentHosts": "no"
}
```

- **App type:** `web` gets browser checks in Claude Code's built-in browser. `api` gets `curl` checks. `cli` (or a library) has no server: `start` is `none`, and its checks and Core flows are commands.
- **App is up when:** `oma up <port>` prints 200, which means `curl http://localhost:<port><upPath>` returns 200.
- **Agent hosts:** every agent opens the app at `http://<its browser name>.localhost:<port>` so its cookies never mix with another agent's (browsers keep cookies per host, not per port). `no` means the app refuses those hosts: agents then use `http://localhost:<port>` and sign in again at the start of every check run.

## The app

- **What it is:** A Docker image that runs Claude Desktop and Claude Code in a web browser on Unraid, plus a Claude Code plugin marketplace of "mods" (`mods/<name>-mod/`) installed into it.
- **Stack:** Dockerfile + POSIX shell (`rootfs/`, `scripts/`); mods are Claude Code plugins written in Node.js 22 ES modules (`.mjs`/`.js`, `node:test`) and Python 3 (oh-my-context-mod gateway). No database.
- **Codebase map:** `README.md` and `docs/MAINTAINING.md` for the image; `mods/AGENTS.md` for the rules every mod follows; `.claude-plugin/marketplace.json` lists the mods; each mod has its own `README.md`, `.claude-plugin/plugin.json`, `scripts/`, `commands/`, `hooks/` and `test/`.
- **Read before writing code:** `mods/AGENTS.md` (manifest, version bump on every user-facing change, layout, tests); the mod's own `README.md`.
- **Fresh worktree setup:** nothing (no dependencies to install for the mods the test command covers). A new worktree has none of the gitignored files and agents can't read `.env`. If the app needs one to start, list it in `.worktreeinclude` at the project root (`.gitignore` syntax); Claude Code copies matching gitignored files into every new worktree.
- **Local data is per folder:** yes (tests use temp homes and temp git repos).
- **One dev server per folder:** no (there is no dev server).
- **Build and dev server can run together in one folder:** yes (there is neither).

## Ports

| Who | Port | Where |
|---|---|---|
| Main checkout (you, checker, team tickets) | mainPort (3000) | the project folder |
| Worker on ticket NNN | 3100 + NNN (004 → 3104) | its worktree |
| Reproducer | 3090 | its worktree |

## Test accounts

- **How to create one:** none (no accounts; checks are commands).
- **How to sign in to an existing one:** none.
- **Names:** worker on ticket NNN → `tNNN`; team → `t050`; reproducer → `t090`; checker → `t000`.
- **Extra URLs agents should know:** none

## Core flows

The flows a user can't live without. The checker walks them after every merge and when the router's watch says a walk is due. 3 to 6 flows, one line of real steps each.

1. Mod tests pass: run the profile's `test` command from the project root; it exits 0 with `# fail 0` and Python `OK`.
2. Every mod manifest validates: run the profile's `lint` command; it exits 0.
3. `/oma status` works: `node mods/oh-my-agent-mod/scripts/oma.mjs status --dir .` prints JSON with `"ok": true` and exits 0.
4. The `oma` helper works: `node mods/oh-my-agent-mod/bin/oma cfg` prints this profile's JSON and exits 0.

## Patterns reviewers check

Project rules the reviewer holds every change to. Only ones that cause real bugs or duplication when broken.

- A user-facing change to a mod bumps `version` in its `.claude-plugin/plugin.json` (semver), or installed copies never update.
- Hooks keep stdout to the hook protocol and never fail a session: errors print nothing on stdout and exit 0.
- Mods write state to `${CLAUDE_PLUGIN_DATA}`, never into the plugin folder; paths use `${CLAUDE_PLUGIN_ROOT}`.
- Tests run offline (temp homes and repos, no network).
- No private values (IPs, hostnames, tokens) in code, docs or tests: placeholders only.

## Files

- **Never commit:** `.oma/job/`, `.claude/worktrees/`, `.codebase-memory/`, `.env`, `.claude/settings.local.json`, `__pycache__/`
- **Files tools rewrite on their own** (commit them with the work if they change, never count them as drift): none
