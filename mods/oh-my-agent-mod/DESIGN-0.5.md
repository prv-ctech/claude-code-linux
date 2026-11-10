# oh-my-agent 0.5 design (draft for review)

Status: draft, nothing built yet. Sources studied: deepseek-superagent (our base), obra/superpowers, mattpocock/skills, Anthropic code-review loop (`.reference/code-review`), Google EGM Lite (`.reference/egm`), Vercel CEO pack (`.reference/vercel-ceo`).

## Problems to solve

1. Every request runs the full pipeline (ticket, worktree, worker, tester, reviewer, merger, checker). A one-file bug such as "manga card cover posters don't render" takes about 10 minutes and many tokens when it could take 1.
2. Vague requests ("rework the theme so we can add more themes") get no real interview. The router never asks about palettes, scope or approaches before tickets are written.

## What each source contributes

| Source | Best idea | Take it? |
|---|---|---|
| deepseek-superagent | Router never builds; finish gate; watchdog; `Runs` field; reproducer's "simple fix" test (≤3 files, local, no contract change) | Keep all. It has no size triage, which is our gap. |
| superpowers | Brainstorm hard gate: one question at a time, ask only when the answer changes the build, 2-3 approaches with a recommendation. Systematic debugging: no fix before root cause, one hypothesis, failing test first, 3 failed fixes means rethink. Verification before completion: no claim without fresh output. | Yes: brainstorm gate, quick-fix discipline, verification rule. |
| mattpocock | Grilling: facts are looked up by the agent, only decisions go to the user; each question has a recommended answer so "yes" accepts it; stop only when the user confirms a summary. diagnosing-bugs: build a fast pass/fail repro loop first. | Yes: recommended-answer format, facts-vs-decisions split, confirm-summary stop. |
| Anthropic code-review | P0-P3 severity by impact; every finding needs a repro, a named rule and file:line, else it is a question; an ignore list; do-not-repeat finding IDs; stop when open findings stop falling; risk tiers scale effort. | Yes: reviewer format and stuck rule. |
| Google EGM | Zero-context "goldfish" reviewers read only the spec and repo; triage each finding FIX / REJECT (with evidence) / ESCALATE; decision ledger with `By: agent|human`; proportion check ("small change needs a short spec"). | Yes: triage verbs, ledger, proportion check. Spec review by goldfish: later, optional. |
| Vercel CEO | first-timer agent: blind first-time user, no code access, reports friction with Blocker/Major/Minor/Polish and a first-person line; breaker agent (adversarial); triage buckets Fix now / Needs you / Spec gap. | Yes: first-timer as a checker mode. Breaker: later. |

## The new flow

```
user request
  -> router triage (always first, no tool cost beyond reading)
       quick   -> inline fix in the router's own session
       medium  -> one worker in a worktree, short ticket, no interview unless vague
       large   -> brainstorm gate -> ticket-writer -> full pipeline (today's flow)
```

### 1. Triage (router, new section)

The router classifies every request before acting and states the class in one line, so the user can override it.

- **quick**: one bug or tweak, clear symptom, cause likely in at most 3 files, no new dependency, no schema or contract change, not touching a ticket being built. (Same thresholds as the reproducer's simple-fix test.)
- **medium**: one feature or bug with a clear outcome but more than quick allows, or a quick fix that grew.
- **large**: several bugs or features, a vague request, a design choice with more than one sensible answer, or anything touching shared contracts.

Overrides: `/oma fix <bug>` forces quick, `/oma build <feature>` forces the full flow. If a quick fix grows past the thresholds while working, stop, restore the files, and move up a class (superpowers rule: when small grows, move up a size).

### 2. Quick path (new skill `oma-quickfix`, run inline by the router)

This is the one place the router edits code, so the router rule "never builds" gets one written exception.

1. Reproduce: build a fast pass/fail check (failing test, curl, or one browser check on the main dev server). No repro means ask the user, or hand it to the reproducer.
2. Root cause in one sentence before any edit ("X because Y").
3. Failing regression test when the project has a test command.
4. One fix. If it fails, form a new hypothesis; after 3 failed fixes, stop and escalate to the full pipeline.
5. Verify: re-run the repro, lint, build and test, and read their output. No "should work".
6. Commit on the current branch with `Fix: <one line>`. No worktree, no ticket, no merger. Report: cause, fix, evidence, in at most 4 lines.

### 3. Brainstorm gate (new skill `oma-brainstorm`, before the ticket-writer)

Runs for every large request and for a medium one that is vague. It skips when the request already names the actor, the expected result and the behaviour on failure.

1. Look up facts yourself (codebase-memory, the project profile). Never ask the user what the code answers.
2. Ask decisions one at a time, each with 2-4 options and the recommended one first, phrased so "yes" accepts it. Ask only when the answer changes what gets built.
3. Offer 2-3 approaches with trade-offs and one recommendation. Example for themes: CSS variables with a theme registry; Tailwind theme plugin; design tokens file; plus which palettes (Catppuccin, Nord, ...).
4. Write a short summary and wait for the user to confirm it. Only then hand it to the ticket-writer, with the answers recorded in rd.md under Decisions made as `By: human`.
5. From here on the pipeline runs without asking, as today.

The ticket-writer's own interview shrinks to filling gaps the brainstorm left, and it applies the proportion check: a small change gets a short ticket.

### 4. Reviewer upgrade

- Every finding: severity P0-P3 by impact, a named rule (FR id, project pattern, or CLAUDE.md rule), file:line, and a repro or observable path. A finding with none of these becomes a question, not a finding.
- Reviewer reads an ignore list in the project profile first.
- Rounds after the first see only the diff since the last round, plus the IDs already raised.
- Worker triages each finding FIX / REJECT (with file:line evidence) / ESCALATE. A rejected P0 or P1 that comes back is escalated to the router.
- Stuck rule: the same finding open two rounds, or the open count not falling for two rounds, ends the loop and reports to the router.

### 5. First-timer checker mode

The checker gains a `first-timer` mode: no code, specs or git access, only the app URL. It infers what the app is for, tries to use it as a new user (empty fields, back button, refresh mid-flow, keyboard only, phone and desktop widths) and reports friction as Blocker / Major / Minor / Polish with one first-person line and evidence. Blindness is enforced by a PreToolUse hook that allows only the built-in browser tools. It runs after large merges and on request (`/oma explore`). Findings go to the router, which sends Blockers to the reproducer and lists the rest for the user.

### 6. Decision ledger

Every decision an agent makes without the user goes to `.oma/decisions.md` as one line: date, ticket, decision, reason, `By: agent`. The router shows new lines in its next report, so the user can audit instead of being asked.

## Not taking (and why)

- Spec review by four goldfish reviewers (EGM): too many tokens for most tickets. Revisit for large tickets only.
- Breaker agent and pathrunner (Vercel): useful, but need per-project data backup rules. Later.
- Asking whole question rounds (mattpocock): conflicts with one question at a time, which the user asked for.

## Build order

1. Triage and the quick path (fixes the biggest pain).
2. Brainstorm gate.
3. Reviewer upgrade.
4. First-timer mode.
5. Decision ledger.

Each step ships as its own version with tests, and step 1 gets a real end-to-end run on a scratch project before release.

## Open questions for the user

1. Should the quick path commit on the current branch, or leave the fix uncommitted for you to review?
2. Should first-timer run automatically after every large merge, or only on request?
