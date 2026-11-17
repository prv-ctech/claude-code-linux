# oh-my-agent router: running tickets

Read before routing a ticket, starting a reproducer or a first-timer, and after a compaction while any job runs. Part of `router.md`.

## Routing tickets

Route only tickets under your own `projectRoot` (`<projectRoot>/specs/tickets/`). A ticket of another project is reported to the user with the text `open /oma in <that project>` and never handed to a worker.

Ticket states: `draft` (written, not approved), `ready` (approved), then on your job list `running`, `passed`, `merging`, and finally `done` on the board (set by `oma merge`) or `blocked` (see "When a worker reports").

A ticket can start when its Status is `ready` and its Runs is `alongside`, or `waits for NNN` with NNN `done` on the board. It must also be in the state's `approval.approved` list: a hook refuses to start a worker on any other ticket. A ticket in `approval.pending` goes back to the user (see "Approval" in `router-interview.md`), whatever its Status says. `draft` tickets are never routed; only the ticket-writer changes them, in the review round above. Only `oma merge` sets a ticket `done` (the ticket-writer sets `draft` and `ready`), so a ticket you routed still reads `ready`: your job list says it's running.

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

`ticket | agent type | agent ID | status (running, follow-up sent, passed, queued, merging, merged, done, stopped, blocked) | branch | worktree`

Reproducer jobs go on it with a short bug name, the watch with its task ID. "What's running?" is answered from it in a few lines. After a compaction, rebuild it from `oma.mjs status` and your last notifications.

**The main checkout is one slot.** A merge (`oma merge`) and the first-timer both work in it: at most one of them at a time, the merge first. Queue the rest (status `queued`) and start the next when one reports. A ticket-writer only reads code and writes local ticket files, so it may run beside a first-timer; the exception is its first-run profile fill, which starts the app on a spare port in the main checkout, so it waits for the slot.
**At most one reproducer** (port 3090).
**No new worker or reproducer while a merge runs:** worktrees branch from this checkout's HEAD, and a merge that gets undone would ride along in the new branch. Queue them until `oma merge` has printed its result.
**`agentHosts: no`:** agents' browser cookies mix on `localhost`, so run at most one browser-using job (a worker, a first-timer, a reproducer) at a time; queue the rest.
Solo workers otherwise run side by side in their worktrees.

## When a worker reports

Its report (at most 8 lines): `Ticket: NNN-slug: PASS x/y` (or FAIL), `Branch`, `Worktree`, `Changed for users`, `Decisions I made that the ticket didn't cover` (including reviewer findings it rejected, with the evidence), `Stale notes`, `Blocked / needs a decision` (including reviewer findings it escalated).

A report that says it's blocked before testing (no results.md yet) is handled as blocked: settle or ask about what blocks it, and don't ask for missing check results.

Otherwise check it yourself before you trust it:

1. Read `<worktree>/specs/tickets/NNN-slug/eval.md`, `<worktree>/specs/tickets/NNN-slug/results.md` and `<worktree>/.oma/job/status.json`.
2. Confirm: every check in eval.md has a line in results.md (`A-n` per Automated check, `E-1`…`E-N`, `R-n` per Regression check), none missing or "not run"; every browser check names an evidence file (`evidence/E-n.md`, `R-n.md`) that exists under `<worktree>/specs/tickets/NNN-slug/evidence/`; every `A-n` line passes; the x/y matches results.md and status.json; nothing under Out of scope or Do not touch was changed (`git -C <worktree> diff --stat <branch>...HEAD`).
3. Decide:
   - **PASS and it holds up:** merge it yourself, with one command run in `projectRoot` (in the background when the project has a build or test command: it can take minutes): `oma merge <worker branch> specs/tickets/NNN-slug --worktree <path>`. Mark it `merging` (or `queued`, when another merge or the first-timer holds the slot). The command merges with `--no-ff`, runs install (when a manifest changed), lint, build and the whole test suite on the merged result, undoes the merge if one fails, and marks the ticket done. Its exit code and last line are the only pass signal for a ticket: never call a ticket merged from the worker's report alone.
   - **FAIL, or it doesn't hold up:** SendMessage to the same worker with exactly what's wrong, e.g. `E-3 has no result in results.md and evidence/E-3.md is missing. Run E-3, write its evidence file, update results.md, report again.`
   - **"Decisions I made" isn't "none":** log each in the decision ledger (`By: worker NNN`). A decision that changes what users see: check it against the intent files (`.oma/intent/`). In line with them, or not covered and harmless → accept it. Against them → send it back to the worker with the intent line. Small internal choices you accept yourself.
   - **An escalated reviewer finding** (a product question, or a P0 or P1 the worker rejected and the reviewer raised again): read the finding and the code it names. A product call → settle it from the intent files, and if they don't settle it, pick the option least surprising to a user and log it; a real defect → send it back to the worker; a wrong finding → accept the rejection and log it.
   - **"Stale notes" isn't "none":** append each to `.oma/stale.md` with the date and the ticket number, its `file:line` copied as the worker gave it (open the file when it gave none; never fill one in from memory). Never act on one or ask the user about one during a run, and it never holds up the merge.
   - **"Blocked / needs a decision" isn't "nothing":** failing checks listed there go back to the worker like a FAIL; only a real blocker or product question is yours: decide it from the ticket, the intent files or the codebase and resume the worker with the answer. If none of them settles it, the ticket ends `blocked` (below).

Don't resume the same worker more than twice for the same problem. Then stop it (TaskStop if still running) and route the ticket once more to a fresh worker, adding one line on what the first one could not get past. If the fresh worker fails too, or the ticket needs a decision nothing settles, the ticket ends **blocked**: stop its worker, leave its branch and worktree, log why in the decision ledger, keep routing every ticket that doesn't wait for it, and list it in the final summary. After approval the run never stops to ask: a blocked ticket is how an open question reaches the user.

## After a merge

When `oma merge` ends with `MERGED ...` (exit 0):

1. Mark the ticket `merged`. A `test flaky` note in that line goes in the final summary.
2. Route every `ready` ticket the line lists after `waited for NNN:`.
3. Start the next queued merge.
4. Tell the user in one line what users can now do.

If it ends with `FAILED` for a reason that isn't the branch's fault, don't send it back to the worker: `dirty tree` (someone's uncommitted changes to tracked files in the main checkout) → tell the user in one line which files block merging and ask them to commit or stash them, then merge again; `dev server on <mainPort> blocks the build` → ask the user whether to stop their dev server; `nothing to merge` → re-check the worker's report; `not approved` → the ticket changed after the user approved it: show the user what changed (see "Approval" in `router-interview.md`); `base tests failing` → the test suite fails on `<branch>` without this ticket: tell the user in one line, and keep the ticket `passed` until they say how to go on; `not on a branch`, `a merge is already in progress`, `<base> moved`, or `main has local edits, merge left in place` → stop merging, tell the user in one line what the checkout needs (back on `<branch>`, or their edits committed and the build fixed or the merge undone), and resume when they say so.

Otherwise, on `CONFLICT` or `FAILED` (lint, build, test, install), don't resolve it yourself: a worker branch goes back to the worker that built it (SendMessage, with the command's last line and the error output above it; when that worker can't be resumed, a fresh worker with the same ticket and that line: merge the base branch (`<branch>`) into its own ticket branch in its own worktree, fix it there, report again), then merge again; a reproducer's fix goes back to the reproducer, or is dropped with one line to the user that the bug is still there.

## Bugs

- **The user mentions a bug in passing, or a visitor or the final review reports a defect:** quietly start a `reproducer`: the bug as reported, any repro steps, `Port: 3090`, `Test account: t090` (or `repro`, see the note under the ports table in `router.md`), `Browser name: repro`, `Base branch: <branch>`, and `Tickets being built right now: <from your job list>`. One at a time; queue the next.
- **`CONFIRMED + FIXED`:** tell the user in one line what was wrong and that a fix is landing, then merge it: `oma merge <fix branch>` (no ticket folder). The command gives the fix its own `done` row on the board.
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

A blind usability walk: an agent (Haiku) that has never seen the app, can't read its code, and uses it in the built-in browser as a brand-new visitor would. It finds what the evals can't: confusing pages, dead ends, unclear errors.

- **On request** (`/oma explore`, "walk it like a new user"): one visitor on the main checkout's app. Only for `web` apps; for `api` and `cli` say it doesn't apply. It takes the main-checkout slot (not while a merge runs). Prompt, exactly:
  ```
  App: http://localhost:<mainPort>
  Port: <mainPort>
  Project root: <projectRoot>
  ```
  Never add anything about the app, the tickets or what to look for: its value is that it knows nothing.
- **At the end of a run:** see "Stress stage".
- **`NOT RUN: <reason>`:** the walk didn't happen. Tell the user in one line why, and never report it as done.

## Final review

Once per run, when no job is running or queued and nothing on the board can start, and at least one ticket was merged in this run. Skip it for a run that only fixed bugs.

1. Start the `oh-my-agent-mod:final-reviewer` agents in one turn, side by side: `Lens: code`, `Lens: lean`, and, when a merged ticket changed what users see in a `web` app, `Lens: gui`. Each prompt, and nothing else:
   ```
   Lens: <code | lean | gui>
   Run base: <the `Run base:` sha from the decision ledger>
   Tickets: specs/tickets/NNN-slug, ...   (the ones merged in this run)
   Intent files: .oma/intent/<slug>.md, ...
   Project root: <projectRoot>
   App: http://localhost:<mainPort>       (gui only)
   Port: <mainPort>                        (gui only)
   ```
   The gui reviewer needs the app up on mainPort: check with `oma up <mainPort>`; if it isn't, the user's server is not running, so say in the final summary that the gui review did not run, and why.
2. **Triage every finding yourself**, as in "Plan review": they advise, you decide. A **B or M defect with a repro**, in something an approved ticket promised → a bug for the reproducer (see "Bugs"), counted against the run's fix limit below. Everything else (a mismatch with a mockup that needs a design call, waste to remove, an intent item that was not built, any N) → the final summary, each with your recommendation in one line. Never start a ticket-writer or a worker for these on your own: new work needs the user's approval.

## Stress stage

After the final review, for a `web` app in which at least one merged ticket changed what users see. Blind visitors with different personas use a separate copy of the app, so they find what reading code can't, and nothing they do touches the user's checkout or data.

1. **Start the copy:** `oma stress up` (in the background; it installs and starts the app in its own worktree on port 3080). `SKIPPED: <why>` → no stress stage: say why in the final summary. An error → run `oma stress down`, and say in the summary that the stage did not run.
2. **Send the visitors**, all in one turn, at most 5 (`agentHosts: no` → one at a time). One `new`, one `goal` per feature of this run (most important first) with the goal in the user's own words from its intent file, one `phone`, one `breaker`; drop `goal` visitors first to stay at 5. `subagent_type: oh-my-agent-mod:first-timer`, each prompt exactly:
   ```
   App: http://<visitor name>.localhost:3080     (http://localhost:3080 when agentHosts is no)
   Port: 3080
   Project root: <projectRoot>
   Visitor: v1                                   (v2, v3, ...)
   Started: yes
   Persona: <new | goal | phone | breaker>
   Goal: <the user's words, goal visitors only>
   Account: <the profile's "How to create one" steps, with <name> = the visitor name>
   ```
   Nothing else: not what was built, not what to look for.
3. **Stop the copy** when all have reported: `oma stress down`. Always, also after a failure.
4. **Findings.** No finding changes code directly. Merge duplicates across visitors, then for each **Blocker** and **Major**, one at a time: start a `reproducer` with the visitor's line as the bug report (see "Bugs"). A blind visitor can't tell a broken feature from one that was never built, so expect `NOT A BUG` and `NOT REPRODUCED` for some.
   - `CONFIRMED + FIXED`, and the fix restores something an approved ticket's rd.md promised → merge it (`oma merge <fix branch>`).
   - Anything else (`NO SIMPLE FIX`, `NOT A BUG`, a fix for something no ticket promised) → the final summary, never a ticket on your own.
   - **Fix limit:** at most 3 fixes merged without asking per run, counting the final review's too. Log each in the decision ledger as `stress fix n of 3`. Past the limit, the rest go to the summary.
   - Minor and Polish: one summary line with the report paths (`.oma/job/first-timer/<visitor>/report.md`).
5. **Rerun once** if a fix was merged in this stage: steps 1 to 3 again with the same visitors, then only report what is still there. Never a third time.

## When everything is done

When no job is running or queued and nothing on the board can start: run "Final review", then "Stress stage" (each says when it applies), then, when `.oma/stale.md` has lines, the sweep with scope `reported` (read `router-sweep.md`; it only verifies and proposes), then stop the watch (TaskStop) and give the user a short summary: what landed (one line per ticket or fix), every ticket that ended `blocked` and why, what the final review and the visitors found that you did not fix, each with your recommendation (the user decides; new work goes through tickets and `/oma approve`), stages that did not run and why, decisions logged in `.oma/decisions.md` this run (a count), the sweep's proposals for the stale notes workers reported, ending with its `Reply with the numbers to apply, or all.` line (nothing is changed before that), flaky tests, and that nothing was pushed (`git log <branch>` shows it all). The desktop app may be read later from a phone: keep it plain.
