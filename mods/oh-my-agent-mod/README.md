# oh-my-agent-mod (`/oma`)

DeepSeek's super-agent idea as a Claude Code plugin, adapted from the `deepseek-superagent` pack in this repo and fitted to this repo's Claude Code Linux desktop setup. You talk to one session, the **router**. It never builds anything itself. It turns what you ask for into tickets, hands each ticket to a **worker** in its own context window and git worktree, checks what comes back against the ticket's evals, merges it, has it walked in Claude Code's built-in browser, fixes small bugs it finds, and only comes to you when there's a choice that changes what users get.

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
/oma fix <bug>            quick fix here: repro, root cause, test, fix, commit
/oma build <feature>      force the full ticket pipeline
/oma status               board and running jobs, changes nothing
/oma off                  end router mode in this session
```

While router mode is on, just talk to it: `what's running?`, `why did 002 fail?`, `the publish button seemed to do nothing on my phone` (it triages first: a small bug with a clear cause gets fixed right in the session, root cause and regression test first; anything bigger quietly goes to the reproducer or the ticket pipeline), `give workers 20 minutes before calling them stuck`.

## What happens

1. **First `/oma` in a project** sets it up (idempotent): `.oma/project.md` (the profile every agent reads) and `.oma/watchdog-rules.md` from templates, `/.oma/`, `/specs/tickets/` and `/.claude/worktrees/` in `.gitignore` and `.dockerignore`, `/.oma/` and `/specs/tickets/` in `.worktreeinclude`, and `worktree.baseRef: "head"` in the session folder's `.claude/settings.local.json` (git-ignored) so workers branch from your checked-out commit. Everything lands on the branch checked out in the session (a desktop session running in its own worktree uses that worktree's branch); a detached HEAD or a repository with no commits is refused with a one-line reason.
2. The **ticket-writer** (Opus) fills the profile in (checks the start command really serves on a spare port), reads the code, and writes `specs/tickets/NNN-slug/rd.md` + `eval.md` and `BOARD.md`. Questions only for choices that change what users see, batched (at most 4), asked by the router. Tickets stay local files (git-ignored, never committed) and are built straight away (set *Review tickets* to keep them draft until you approve).
3. **Solo ticket** → a **worker** (Sonnet) in its own worktree on port 3100 + NNN builds it test-first, has the **tester** run every eval check and the **reviewer** check the diff, fixes up to 3 rounds, writes `results.md` and evidence (local files), commits its code on its branch. A finish gate (SubagentStop hook) won't let it end until every check passes and its tree is clean, or it reports blocked with a note.
4. The router checks `results.md` against `eval.md` itself; follow-ups go to the same worker. On a pass the **merger** merges (`--no-ff`), runs lint and build, undoes the merge if either fails, marks the ticket done; the **checker** walks the feature and the core flows in the built-in browser.
5. **Team tickets** (agent teams on: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) get one **teammate** per block of the ticket, agreeing on a `contract.md`. Without agent teams they run as solo tickets.
6. Bugs go to the **reproducer**: reproduced twice, root cause first, fixed on its own branch when the fix is small, merged by the merger.
7. **The watch.** The router runs `scripts/check.mjs --watch` under its Monitor tool: every 10 minutes it flags workers that went quiet, loop, are blocked or touch files outside their ticket, checks the main app answers, and says when a browser walk is due. Quiet rounds print nothing. The **inspector** (Haiku) answers "why did X fail".

## Before a hands-off run

- **Permission mode:** agents inherit the session's mode. In default mode every agent stops for approvals; switch the session to **auto** for a run that goes without you (`/oma` reminds you once).
- **Browser:** agents open `http://<name>.localhost:<port>` in the built-in browser. If the pane asks to allow `localhost` sites, allow it once; a background agent can't answer that prompt and falls back to `http://localhost:<port>`.
- **Local only:** plans, tickets, results and `.oma/` are never committed or pushed and never enter a Docker build context. `/oma init` sets this up; every session start in a project with oma files re-checks it. Workers receive copies through `.worktreeinclude`.

## Agents

`oh-my-agent-mod:` `ticket-writer`, `worker`, `tester`, `reviewer`, `merger`, `checker`, `reproducer`, `teammate`, `inspector`. The router is your own session, following `router.md` after `/oma`.

## What changed from the original pack

| Original | Here |
|---|---|
| copy `.claude/` into each project, `claude --agent router` | install the plugin once; `/oma` in any session, any project |
| agent-browser (not installed here) | Claude Code's built-in browser: one tab per agent, `http://<name>.localhost:<port>` per agent so cookies never mix; evidence as text files |
| background watchdog agent + SendMessage | the router's own Monitor on `check.mjs --watch`; inspector for questions |
| `settings.json` deny rules | a PreToolUse hook denying `git push` and `.env` reads for oma agents only (your own sessions keep pushing PRs) |
| frontmatter Stop hook (ignored for plugin agents) | SubagentStop hook in `hooks/hooks.json` |
| `lsof`, `date -u`, hand-written JSON | the `oma` helper on the Bash PATH: `oma status`, `oma serve/up/stop/port`, `oma run lint|build|test|install`, `oma cfg` |
| interview one question at a time, draft → ready by hand | batched questions only for user-facing choices; ready by default |
| `main`, port 3000 | your checked-out branch, the profile's `mainPort` |

## Settings

| Setting | Blank (default) | Set to `true` |
|---|---|---|
| Review tickets before building | tickets are built straight away | new tickets stay draft until you approve them |

## Safety

- Nothing is pushed: `git push` is denied for every oma agent. Review with `git log <branch>` and push yourself.
- oma agents never read `.env` files; list a file the app needs in `.worktreeinclude`.
- Only the merger commits to your branch (code only), staging by path, one at a time. The merger undoes its own merge with `git reset --keep` when lint or build fails, which refuses rather than touch a file you edited meanwhile.
- The checker and agents never stop a dev server they didn't start (`oma stop` refuses).
- The only settings it edits: the project's git-ignored `.claude/settings.local.json`.
- oma agents can start only oma subagents, so the guard covers everything they run.

## With codebase-memory-mod

- oma detects codebase-memory-mod plus a `.codebase-memory/` graph in the folder, and tells its agents (SubagentStart hook) to search code with the graph tools there.
- The `.env` rule covers the graph tools too: `file_pattern`, `path_filter` and `file_path` may not target env files.
- Where there is no graph, or the plugin is off, oma leaves Grep, Glob and grep alone; agent worktrees never have a graph.

## Development

```bash
node --test mods/oh-my-agent-mod/test/*.test.mjs
claude plugin validate mods/oh-my-agent-mod
```
