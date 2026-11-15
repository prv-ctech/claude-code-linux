# oh-my-agent-mod (`/oma`)

DeepSeek's super-agent idea as a Claude Code plugin, adapted from the `deepseek-superagent` pack in this repo and fitted to this repo's Claude Code Linux desktop setup. You talk to one session, the **router**. It never builds anything itself. It turns what you ask for into tickets, hands each ticket to a **worker** in its own context window and git worktree, checks what comes back against the ticket's evals, merges it, fixes small bugs it finds, and only comes to you when there's a choice that changes what users get.

Its disciplines live inside the agents (test first, root cause before fixes, no claim without fresh evidence, independent review), and it works alongside oh-my-context (`/omc`): oma adds no MCP servers and no skills, injects one short line per session, and its agents find routed tools and hidden skills through the oh-my-context gateway.

## Install

```
/plugin install oh-my-agent-mod --marketplace prv-ctech/claude-code-linux
```

Or `claude plugin install oh-my-agent-mod@claude-code-linux` once this repo's marketplace is added. Start a new session afterwards: the hooks, agents and `/oma` load at session start.

## Use

In any project (a git repository), in a normal Claude Code chat:

```
/oma add password reset by email, and rate-limit failed logins
/oma                      resume: route ready tickets, or ask what to build
/oma 004                  start one ticket
/oma bug <bug>            quick fix here: repro, root cause, test, fix, commit, a row on the board (also /oma fix)
/oma build <feature>      force the full ticket pipeline
/oma approve 010 011      approve those tickets as written; nothing is built before this
/oma explore              blind first-time-user walk of a web app
/oma status               board and running jobs, changes nothing
/oma off                  end router mode in this session
```

While router mode is on, just talk to it: `what's running?`, `why did 002 fail?`, `the publish button seemed to do nothing on my phone` (it triages first: a small bug with a clear cause gets fixed right in the session, root cause and regression test first; anything bigger quietly goes to the reproducer or the ticket pipeline), `give workers 20 minutes before calling them stuck`.

## What happens

1. **First `/oma` in a project** sets it up (idempotent): `.oma/project.md` (the profile every agent reads) and `.oma/watchdog-rules.md` from templates, `/.oma/`, `/specs/tickets/` and `/.claude/worktrees/` in `.gitignore` and `.dockerignore`, `/.oma/` and `/specs/tickets/` in `.worktreeinclude`, and `worktree.baseRef: "head"` in the session folder's `.claude/settings.local.json` (git-ignored) so workers branch from your checked-out commit. Everything lands on the branch checked out in the session (a desktop session running in its own worktree uses that worktree's branch); a detached HEAD or a repository with no commits is refused with a one-line reason.
2. **Triage and brainstorm.** The router sizes each request: a single small bug is fixed right in the session (repro, root cause, failing test, fix, verify, commit). Anything bigger goes to the pipeline, and each feature first gets an interview with you, one feature at a time: facts it can read itself are never asked, decisions come one question at a time with a recommended answer, and it stops only when no decision is left open. Every answer is written at once to `.oma/intent/<feature>.md`, so a compaction loses nothing and the ticket-writer reads your own words.
3. The **ticket-writer** (Opus) fills the profile in (checks the start command really serves on a spare port), reads the code, and writes `specs/tickets/NNN-slug/rd.md` + `eval.md` and `BOARD.md`. Questions only for choices that change what users see, batched (at most 4), asked by the router. Tickets stay local files (git-ignored, never committed) and start as drafts. The router shows you each one; **nothing is built until you type `/oma approve` with the ticket numbers it showed you** (`/oma approve 010 011`; `all` approves every draft on disk). That command, and nothing else, writes `.oma/approved.json` (a hash of each ticket's `rd.md`, of its `mockup.html` and of every part of its `eval.md`). A hook refuses to start a worker on a ticket that is not in it or that changed since: checks may be added later, approved ones may not be edited or removed. After approval the run goes on without asking you.
   Before you see them, the drafts get a **plan review**: `check.mjs --overlap` lists tickets that change the same paths, and two zero-context **plan-reviewer** agents read the tickets, your intent files and the code, one as a critic (flaws, security, false claims about the code), one for overengineering (it runs the `ponytail-audit` skill when that plugin is installed, else a built-in rule). They advise; the router fixes, rejects with evidence or escalates each finding and shows you what it rejected. With three or more features, one ticket-writer per feature runs side by side.
4. **Solo ticket** → a **worker** (Sonnet) in its own worktree on port 3100 + NNN builds it test-first, looks at its own pages in the built-in browser at phone, tablet and desktop width, runs every eval check itself, and has a fresh **reviewer** check the diff each round (findings rated P0-P3, each with the rule it breaks, a repro and file:line; the worker fixes, rejects with evidence or escalates each one, and stops early when it's stuck), fixes up to 3 rounds, writes `results.md` and evidence (local files), commits its code on its branch. A finish gate (SubagentStop hook) won't let it end until every check passes and its tree is clean, or it reports blocked with a note.
5. The router checks `results.md` against `eval.md` itself; follow-ups go to the same worker. On a pass the router runs **`oma merge`**, a script, not an agent: it merges (`--no-ff`), runs install when a manifest changed, then lint, build and **the project's whole test suite** on the merged result, undoes the merge if one fails, and marks the ticket done. Its exit code is the only pass signal: what a worker reports is never enough. A test that fails once and passes on a rerun is reported as flaky; a suite that also fails without the branch is reported as the base's problem, not sent back to the worker. A conflict is never resolved in your checkout: it goes back to the worker. The merge is refused when the worker's copy of the ticket differs from what you approved. A ticket two workers could not finish ends `blocked` and the run goes on without it.
6. Every ticket is built by one worker. Tickets that must agree on a shared shape are ordered with `waits for`.
7. Bugs go to the **reproducer**: reproduced twice, root cause first, fixed on its own branch when the fix is small, merged with `oma merge`. Every fix gets a row on the board, including a quick fix done in the session (`/oma bug <bug>`, or `/oma fix`), so the board lists everything that landed.
8. **Mockups.** A ticket that adds a new screen, flow or whole component gets a `mockup.html` (every state on one page, plus a phone frame, in the app's own styles). You approve it with the ticket; the worker and the reviewers open that same file. A tweak (bigger, moved, recoloured) gets none. Say "mockup" or "no mockup" to override.
9. **Final review**, once per run after everything is merged: three **final-reviewer** agents side by side, `code` (the whole diff against your intent files: what was not built, what breaks across tickets), `lean` (overengineering; `ponytail-audit` when installed) and, when the UI changed, `gui` (the built pages against their mockups at phone, tablet and desktop width; the `impeccable` audit when installed). They advise; the router decides.
10. **Stress stage**, for web apps: `oma stress up` starts a separate copy of the app (its own worktree, port 3080, its own data), and up to five blind **first-timer** agents on Haiku use it at once, each with a different persona: a new visitor, one per feature with your goal in your own words, a phone-only user, and a breaker (double submits, absurd input, back and reload mid-flow, two tabs, other people's ids). They cannot read code; a hook keeps them to the browser and to this app's ports. No finding changes code directly: each Blocker or Major goes to the reproducer, and only a confirmed, fixed bug in something an approved ticket promised is merged, at most 3 per run. The rest is listed for you with a recommendation. The stage is skipped, and says so, for an API or CLI or when every copy of the app shares one database. `/oma explore` still runs one blind walk on request.
11. **Decision ledger.** Every call an agent made without asking you is one line in `.oma/decisions.md`, so you can audit them instead of being asked each one.
12. **The watch.** The router runs `scripts/check.mjs --watch` under its Monitor tool: every 10 minutes it flags workers that went quiet, loop, are blocked or touch files outside their ticket, and checks the main app answers. Quiet rounds print nothing. The router answers "why did X fail" from the ticket's results and status files.

## Before a hands-off run

- **Permission mode:** agents inherit the session's mode. In default mode every agent stops for approvals; switch the session to **auto** for a run that goes without you (`/oma` reminds you once).
- **Browser:** agents open `http://<name>.localhost:<port>` in the built-in browser. If the pane asks to allow `localhost` sites, allow it once; a background agent can't answer that prompt and falls back to `http://localhost:<port>`.
- **Local only:** plans, tickets, results and `.oma/` are never committed or pushed and never enter a Docker build context. `/oma init` sets this up; every session start in a project with oma files re-checks it. Workers receive copies through `.worktreeinclude`.

## Agents

`oh-my-agent-mod:` `ticket-writer`, `plan-reviewer`, `worker`, `reviewer`, `reproducer`, `final-reviewer`, `first-timer`, `gatherer`. The router is your own session, following `router.md` after `/oma`; it reads `router-bug.md`, `router-interview.md` and `router-run.md` only when their phase starts, so a quick fix or a brainstorm does not load the whole pipeline.

Removed in 0.13.0: the `tester` (the worker runs its own checks and sees its own pages) and the `merger` agent (now the `oma merge` command). Removed in 0.10.0: agent teams (`teammate`), the `checker`'s browser walk after every merge, and the `inspector`. The blind first-timer walk at the end of a run stays.

## What changed from the original pack

| Original | Here |
|---|---|
| copy `.claude/` into each project, `claude --agent router` | install the plugin once; `/oma` in any session, any project |
| agent-browser (not installed here) | Claude Code's built-in browser: one tab per agent, `http://<name>.localhost:<port>` per agent so cookies never mix; evidence as text files |
| background watchdog agent + SendMessage | the router's own Monitor on `check.mjs --watch` |
| `settings.json` deny rules | a PreToolUse hook denying `git push` and `.env` reads for oma agents only (your own sessions keep pushing PRs), and keeping the first-timer blind (browser on local URLs only, no file or code access) |
| frontmatter Stop hook (ignored for plugin agents) | SubagentStop hook in `hooks/hooks.json` |
| `lsof`, `date -u`, hand-written JSON | the `oma` helper on the Bash PATH: `oma status`, `oma serve/up/stop/port`, `oma run lint|build|test|install`, `oma cfg` |
| interview one question at a time, draft → ready by hand | batched questions only for user-facing choices; ready by default |
| `main`, port 3000 | your checked-out branch, the profile's `mainPort` |

## References (gatherer)

When a request names a source (Mobbin, 21st, an artifact link, a URL, an MCP), the router starts the `gatherer` agent. It saves the raw originals into `.oma/refs/<request-slug>/` (`index.md`, `images/`, `code/`, `raw/`), git-ignored like the rest of `.oma/`. Tickets link the files in a References section; workers and the gui final reviewer compare against them and the reviewer flags contradictions.

## Safety

- Nothing is built without your approval: see `/oma approve` above. Upgrading from 0.10: tickets already on your board need one `/oma approve` before workers start on them.
- Nothing is pushed: `git push` is denied for every oma agent. Review with `git log <branch>` and push yourself.
- oma agents never read `.env` files; list a file the app needs in `.worktreeinclude`.
- Only `oma merge` (and a quick fix) commits to your branch, one at a time. It undoes its own merge with `git reset --keep` when lint, build or a test fails, which refuses rather than touch a file you edited meanwhile, and it refuses to start on a dirty tree. The ignore lines oma adds itself (to `.gitignore`, `.dockerignore`, `.worktreeinclude`) don't count as dirty: the merge drops them, merges, and adds them back, so a branch that edits the same file still merges.
- Agents never stop a dev server they didn't start (`oma stop` refuses).
- The only settings it edits: the project's git-ignored `.claude/settings.local.json`.
- oma agents can start only oma subagents, so the guard covers everything they run.

## With the code graph

- oma detects the code graph (run by oh-my-context-mod, or by the older codebase-memory-mod) plus a `.codebase-memory/` graph in the folder, and tells its agents (SubagentStart hook) to search code with the graph tools there: through oh-my-context's `call` tool, or directly while codebase-memory-mod is still enabled.
- The `.env` rule covers the graph tools too, called directly or through oh-my-context's `call`: `file_pattern`, `path_filter` and `file_path` may not target env files.
- Where there is no graph, or the plugin is off, oma leaves Grep, Glob and grep alone.
- When the main checkout has an untracked `.codebase-memory/`, init lists it in `.worktreeinclude` and `.gitignore`, so every worktree gets a copy; worktree agents index their own worktree as their own project (`index_repository`, `persistence: true`). A graph git already tracks is left alone.
- The SubagentStart hook also copies the main checkout's `.codebase-memory/` into a worktree that lacks one, so no `oma start` is needed after a plugin upgrade.
- Project guard: the router routes only tickets under its own project root, and a worker whose worktree lacks its ticket folder blocks at once.

## Development

```bash
node --test mods/oh-my-agent-mod/test/*.test.mjs
claude plugin validate mods/oh-my-agent-mod
```
