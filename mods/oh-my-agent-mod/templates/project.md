# Project profile

**Profile:** not filled in

Every oh-my-agent agent reads this file for what depends on this project: how to install, lint, build, test and start it, how to make a test account, and which user flows matter most. `/oma` fills it in on its first run (the ticket-writer agent reads the project, replaces every double-brace placeholder, checks the start command on a spare port) and sets the line above to `**Profile:** filled in`. The router routes nothing until it says `filled in`.

The `oma` helper (on every session's PATH while the plugin is on) reads the json block below, so keep it valid JSON. Wherever a command needs a port, write `<port>`; agents swap in their own. A command the project doesn't have is `"none"`, and agents skip that step.

```json
{
  "appType": "{{web | api | cli}}",
  "install": "{{e.g. npm install}}",
  "lint": "{{e.g. npm run lint, or none}}",
  "build": "{{e.g. npm run build, or none}}",
  "test": "{{e.g. npm test, or none}}",
  "start": "{{e.g. npm run dev -- --port <port> --host 0.0.0.0, or none}}",
  "upPath": "{{a page that returns 200 without signing in, e.g. /login, or none}}",
  "mainPort": 3000,
  "agentHosts": "{{yes | no: whether http://<name>.localhost:<port> serves the app (checked at setup)}}"
}
```

- **App type:** `web` gets browser checks in Claude Code's built-in browser. `api` gets `curl` checks. `cli` (or a library) has no server: `start` is `none`, and its checks and Core flows are commands.
- **App is up when:** `oma up <port>` prints 200, which means `curl http://localhost:<port><upPath>` returns 200.
- **Agent hosts:** every agent opens the app at `http://<its browser name>.localhost:<port>` so its cookies never mix with another agent's (browsers keep cookies per host, not per port). `no` means the app refuses those hosts: agents then use `http://localhost:<port>` and sign in again at the start of every check run.

## The app

- **What it is:** {{one line a new teammate would understand}}
- **Stack:** {{language, framework and version, database}}
- **Codebase map:** {{where to start reading}}
- **Read before writing code:** {{docs that override what a model knows, or "none"}}
- **Fresh worktree setup:** {{what a brand-new copy needs before it runs, usually `oma run install`}}. A new worktree has none of the gitignored files and agents can't read `.env`. If the app needs one to start, list it in `.worktreeinclude` at the project root (`.gitignore` syntax); Claude Code copies matching gitignored files into every new worktree.
- **Local data is per folder:** {{yes / no. No when every copy shares one database server: test account names must then be unique across tickets, and the team and reproducer accounts below change to `team` and `repro`.}}
- **One dev server per folder:** {{yes / no. Yes for Next.js (it locks .next/dev/lock).}}
- **Build and dev server can run together in one folder:** {{yes / no}}

## Ports

| Who | Port | Where |
|---|---|---|
| Main checkout (you, checker, team tickets) | mainPort (3000) | the project folder |
| Worker on ticket NNN | 3100 + NNN (004 → 3104) | its worktree |
| Reproducer | 3090 | its worktree |

## Test accounts

- **How to create one:** {{exact steps with `<name>` for the account name and `<host>` for the agent's host, or "none"}}
- **How to sign in to an existing one:** {{…}}
- **Names:** worker on ticket NNN → `tNNN`; team → `t050`; reproducer → `t090`; checker → `t000`.
- **Extra URLs agents should know:** {{e.g. published sites, or "none"}}

## Core flows

The flows a user can't live without. The checker walks them after every merge and when the router's watch says a walk is due. 3 to 6 flows, one line of real steps each.

1. {{e.g. Sign up, log out, log back in.}}
2. {{…}}

## Patterns reviewers check

Project rules the reviewer holds every change to. Only ones that cause real bugs or duplication when broken.

- {{…}}

## Reviewers ignore

Things that look like bugs but are deliberate or owned elsewhere. The reviewer never reports them.

- Generated files and lockfiles; anything under `.oma/` or `specs/tickets/`.
- {{deliberate product decisions that look like bugs, e.g. "light theme only", or "none"}}

## Files

- **Never commit:** `.oma/`, `specs/tickets/`, `.claude/worktrees/`, {{e.g. `node_modules/`, `.next/`, `.env*`}}
- **Files tools rewrite on their own** (commit them with the work if they change, never count them as drift): {{or "none"}}
