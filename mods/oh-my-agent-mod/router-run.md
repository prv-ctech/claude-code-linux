# oh-my-agent router: running tickets

Read before routing a ticket, starting a reproducer or a first-timer, and after a compaction while any job runs. Part of `router.md`.

## Routing tickets

Route only tickets under your own `projectRoot` (`<projectRoot>/specs/tickets/`). A ticket of another project is reported to the user with the text `open /oma in <that project>` and never handed to a worker.

A ticket can start when its Status is `ready` and its Runs is `alongside`, or `waits for NNN` with NNN `done` on the board. It must also be in the state's `approval.approved` list: a hook refuses to start a worker on any other ticket. A ticket in `approval.pending` goes back to the user (see "Approval" in `router-interview.md`), whatever its Status says. `draft` tickets are never routed; only the ticket-writer changes them, in the review round above. Only the merger sets a ticket `done` (the ticket-writer sets `draft` and `ready`), so a ticket you routed still reads `ready`: your job list says it's running.

Start everything that can start, in one turn:

- **Solo**: one `worker` per ticket. The prompt is exactly:
  ```
  Ticket: specs/tickets/NNN-slug
  Port: <3100 + NNN, e.g. 3104 for 004, 3112 for 012, 3215 for 115>
  Test account: tNNN
  Browser name: wNNN
  Base branch: <branch>
  ```
- A ticket whose Mode says `team` (written by an older version) is routed the same way: one worker builds every block.

Then tell the user in one or two lines what started and what waits, and on what.

## Your job list

Keep it in your head and update it on every event, one row per job:

`ticket | agent type | agent ID | status (running, follow-up sent, passed, queued, merging, merged, checking, done, stopped, blocked) | branch | worktree`

Reproducer jobs go on it with a short bug name, the watch with its task ID. "What's running?" is answered from it in a few lines. After a compaction, rebuild it from `oma.mjs status` and your last notifications.

**The main checkout is one slot.** The merger and the first-timer both work in it: at most one of them at a time, merger first. Queue the rest (status `queued`) and start the next when one reports. A ticket-writer only reads code and writes local ticket files, so it may run beside a first-timer; the exception is its first-run profile fill, which starts the app on a spare port in the main checkout, so it waits for the slot.
**At most one reproducer** (port 3090).
**No new worker or reproducer while a merger runs:** worktrees branch from this checkout's HEAD, and a merge the merger undoes would ride along in the new branch. Queue them until the merger reports.
**`agentHosts: no`:** agents' browser cookies mix on `localhost`, so run at most one browser-using job (a worker in its building or testing step, a first-timer, a reproducer) at a time; queue the rest.
Solo workers otherwise run side by side in their worktrees.

## When a worker reports

Its report (at most 8 lines): `Ticket: NNN-slug: PASS x/y` (or FAIL), `Branch`, `Worktree`, `Changed for users`, `Decisions I made that the ticket didn't cover` (including reviewer findings it rejected, with the evidence), `Blocked / needs a decision` (including reviewer findings it escalated).

A report that says it's blocked before testing (no results.md yet) is handled as blocked: settle or ask about what blocks it, and don't ask for missing check results.

Otherwise check it yourself before you trust it:

1. Read `<worktree>/specs/tickets/NNN-slug/eval.md`, `<worktree>/specs/tickets/NNN-slug/results.md` and `<worktree>/.oma/job/status.json`.
2. Confirm: every check in eval.md has a line in results.md (`A-n` per Automated check, `E-1`…`E-N`, `R-n` per Regression check), none missing or "not run"; every browser check names an evidence file (`evidence/E-n.md`, `R-n.md`) that exists under `<worktree>/specs/tickets/NNN-slug/evidence/`; every `A-n` line passes; the x/y matches results.md and status.json; nothing under Out of scope or Do not touch was changed (`git -C <worktree> diff --stat <branch>...HEAD`).
3. Decide:
   - **PASS and it holds up:** start a `merger`: `Merge branch <worker branch> for specs/tickets/NNN-slug. Worktree: <path>. Base branch: <branch>. Project root: <projectRoot>.` Mark it `merging` (or `queued`).
   - **FAIL, or it doesn't hold up:** SendMessage to the same worker with exactly what's wrong, e.g. `E-3 has no result in results.md and evidence/E-3.md is missing. Run E-3, write its evidence file, update results.md, report again.`
   - **"Decisions I made" isn't "none":** log each in the decision ledger (`By: worker NNN`). A decision that changes what users see → ask the user (see "Questions") before merging; small internal choices you accept yourself.
   - **An escalated reviewer finding** (a product question, or a P0 or P1 the worker rejected and the reviewer raised again): read the finding and the code it names. A product call → ask the user; a real defect → send it back to the worker; a wrong finding → accept the rejection and log it.
   - **"Blocked / needs a decision" isn't "nothing":** failing checks listed there go back to the worker like a FAIL; only a real blocker or product question is yours: decide it if the ticket or codebase settles it, else ask the user; then resume the worker with the answer.

Don't resume the same worker more than twice for the same problem. Then stop it (TaskStop if still running) and either re-route the ticket to a fresh worker with a sharper prompt, or ask the user the one question that unblocks it.

## After a merge

When the merger reports `MERGED`:

1. Mark the ticket `merged`.
2. Route every `ready` ticket that waited for this one.
3. Start the next queued merger.
4. Tell the user in one line what users can now do.

If the merger reports `FAILED` for a reason that isn't the branch's fault, don't send it back to the builder: `dirty tree` (someone's uncommitted changes to tracked files in the main checkout) → tell the user in one line which files block merging and ask them to commit or stash them, then merge again; `dev server on <mainPort> blocks the build` → ask the user whether to stop their dev server; `nothing to merge` → re-check the worker's report; `not on <base>`, `<base> moved`, or `main has local edits, merge left in place` → stop merging, tell the user in one line what the checkout needs (back on `<branch>`, or their edits committed and the build fixed or the merge undone), and resume when they say so.

Otherwise, if the merger reports `CONFLICT` or `FAILED`, don't resolve it yourself: a worker branch goes back to the worker that built it (SendMessage, with the merger's error: merge the base branch (`<branch>`) into its own ticket branch in its own worktree, fix it there, report again), then merge again; a reproducer's fix goes back to the reproducer, or is dropped with one line to the user that the bug is still there.

## Bugs

- **The user mentions a bug in passing, or the first-timer reports a Blocker:** quietly start a `reproducer`: the bug as reported, any repro steps, `Port: 3090`, `Test account: t090` (or `repro`, see the note under the ports table in `router.md`), `Browser name: repro`, `Base branch: <branch>`, and `Tickets being built right now: <from your job list>`. One at a time; queue the next.
- **`CONFIRMED + FIXED`:** tell the user in one line what was wrong and that a fix is landing, then start a `merger`: `Merge fix branch <fix branch>. No ticket. Worktree: <path>. Base branch: <branch>. Project root: <projectRoot>.`
- **`CONFIRMED, NO SIMPLE FIX`:** a real regression. Start a `ticket-writer` to make it a ticket (`Write one ticket for this confirmed regression: <the reproducer's line>.` plus the ticket-writer lines), and tell the user in one plain line what's broken for users.
- **`NOT A BUG`:** the report asked for something that was never built. Never make a ticket for it on your own: tell the user in one line what was expected and what exists, and that you can brainstorm it as a feature if they want it.
- **`NOT REPRODUCED`:** say nothing; keep it in the job list. Except when its reason is that it couldn't run (`check not runnable`, `built-in browser not available`, `port 3090 busy`, `isn't running in its own worktree`, `app did not start`): that's not an answer about the bug. Fix the cause if it's yours (port busy: another reproducer still running → wait for it), else tell the user in one line that the bug couldn't be checked and why.

## The watch

Instead of a separate watchdog agent, you watch through the Monitor tool:

- Start one Monitor with the `watchCommand` from the state JSON, `timeout_ms: 1800000`, description `oh-my-agent watch`. It runs a round at once and then every `roundIntervalMinutes` (from `.oma/watchdog-rules.md`), prints nothing on quiet rounds, and exits by itself before 30 minutes.
- **When the watch ends** (exit or deadline notice): re-arm it the same way while any job is running or queued. When nothing is running or queued, leave it off; arm it again when you next start an agent. Never run two.
- **Each event** is one or more JSON lines. Judge each against `.oma/watchdog-rules.md` (read it once, re-read when it changes):
  - `blocked`: always real; handle it like a blocked report.
  - `stale` / `slow`: look at the worker's status file and `git -C <worktree> log -3 --format='%cr %s'`. Committing but not updating status → not stuck. Really stuck → SendMessage the worker what the watch saw; if it doesn't move, stop it and re-route.
  - `drift`: judge with the rules (lockfiles, generated files and tests next to listed files are fine; another ticket's area or a shared piece isn't). Real drift → tell the worker to revert those files.
  - `app-down`: route a `reproducer` if it's a real break on the base branch (confirm once with `curl`).
  - `app-not-running`: not a fault; note it.
  - `warning`: about the watch itself or its rules file; tell the user once per distinct warning.
  - A detail ending `(first flagged N min ago)`: you've seen it; act again only after `repeatReportAfterMinutes` or if it got worse.
- Append one line per judged item to `.oma/job/watch-log.md` (`echo '<line>' >> .oma/job/watch-log.md`).
- Tell the user only when a watch line leads to a decision they need to make.

**Rule changes** ("give workers 20 minutes before calling them stuck"): make the smallest edit to `.oma/watchdog-rules.md` (numbers inside its json block, which must stay valid JSON), then tell the user in one line the old and new value and when it takes effect.

## First-timer

A blind usability walk: an agent that has never seen the app, can't read its code, and uses it in the built-in browser as a brand-new visitor would. It finds what the evals can't: confusing pages, dead ends, unclear errors.

- **When:** when the user asks (`/oma explore`, "walk it like a new user"), and once at the end of a run in which at least one ticket that changed what users see landed in a `web` app. Only for `web` apps; for `api` and `cli` say it doesn't apply.
- It uses the main checkout's app, so it takes the main-checkout slot (not while a merger runs).
- **Prompt:** `subagent_type: oh-my-agent-mod:first-timer`, exactly:
  ```
  App: http://localhost:<mainPort>
  Port: <mainPort>
  Project root: <projectRoot>
  ```
  Never add anything about the app, the tickets or what to look for: its value is that it knows nothing.
- **`NOT RUN: <reason>`:** the walk didn't happen. Tell the user in one line why (no built-in browser in this session, or the app didn't start), and never report it as done.
- **Its report:** goals tried (completed / struggled / gave up) and friction lines `Blocker | Major | Minor | Polish`. Blockers: start a `reproducer` for each, with the first-timer's line as the bug report. A first-timer can't tell a broken feature from one that was never built, so expect `NOT A BUG` for some. Major: tell the user in one line each and offer a ticket. A goal it `gave up` on with no Blocker line explaining it: tell the user in one line. Minor and Polish: one summary line ("6 smaller usability notes in .oma/job/first-timer/report.md"). Never start fixes for Minor or Polish on your own.

## When everything is done

When no job is running or queued and nothing on the board can start, run the first-timer if "First-timer" says it's due (and report it when it's back), then stop the watch (TaskStop), and give the user a short summary: what landed (one line per ticket or fix), decisions logged in `.oma/decisions.md` this run (a count), anything still draft or blocked and why, and that nothing was pushed (`git log <branch>` shows it all). The desktop app may be read later from a phone: keep it plain.
