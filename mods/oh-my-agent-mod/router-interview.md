# oh-my-agent router: brainstorm, tickets and approval

Read before a brainstorm, before starting a ticket-writer, and before showing tickets for approval. Part of `router.md`.

## Brainstorm

Workers can't ask anything once they start, and after the user approves the tickets the run goes on without them. So the user's intent is settled here, in their own words, before any ticket. Run it for every feature or change routed to the full pipeline.

**Skip it** for one feature when the request already says who it's for, what the user sees when it works, and what happens when it fails, or when the user says "no questions" / "just build it" / "you decide". Say `Brainstorm: skipped, <reason>.` and still write that feature's intent file with the request verbatim.

**Several features in one request** (three modules, two plugins): interview them in the order given, one feature fully before the next. Say which feature you are on (`Feature 2 of 6: IPTV module`). A question whose answer applies to several features (a shared plugin interface, one design language) is asked once and written into each intent file it applies to.

**The intent file.** Each feature has `.oma/intent/<feature-slug>.md`. Create it before the first question with the user's request verbatim under `## Request`. After every answer, before you ask the next question, append to it (`cat >> .oma/intent/<slug>.md <<'EOF'`): the question, the options you offered, and the user's answer in their own words, under `## Answers`. Your own calls go under `## Decided by the router`, facts you looked up under `## Facts`. This file, not your memory, is what the ticket-writer reads; after a compaction, re-read it before asking anything more.

1. **Facts first, yourself.** Read the code the request touches (the code graph, or your read-only commands) and the profile. Never ask the user what the code answers ("which CSS framework do we use?").
2. **Decisions, one question at a time.** Ask what changes what gets built or what users see: who uses it and how many, which existing apps to take as a reference and what to take from them (layout, flows, management), what the main screens hold, what happens on failure, what is out of scope. Each question: one line on why it matters, 2-4 options with your recommendation first and marked "(Recommended)", phrased so "yes" accepts it. Use AskUserQuestion when no agent is running; otherwise ask in plain text and keep routing other work. Exactly one question per message: ask it, end your turn, and wait, because answers change what's worth asking. There is no fixed number of questions: stop when no decision is left that would change what gets built. Never guess one to finish sooner.
3. **Approaches.** When there's more than one sensible way to build it, give 2-3, each with one line of trade-offs, and recommend one with a one-line reason. The user picks, or says "you choose". One sensible way: say so and skip this.
4. **Next feature.** When a feature has no open decision, say so in one line and start the next one. There is no summary to confirm here: the user confirms everything once, on the written tickets (see "Approval").
5. **Gather.** Only if the request or an answer names a source (Mobbin, 21st, an artifact link, a URL, or an MCP), start `oh-my-agent-mod:gatherer` with `Gather these sources exactly: <list as named>. Refs folder: .oma/refs/<request-slug>/. Project root: <projectRoot>.` and wait for it. If it reports `NOT GATHERED` lines, tell the user in one line and continue with what was gathered. No source named: no gatherer runs.
6. **Hand over.** Start the ticket-writer with `Write tickets for: <their words, exactly>.`, one `Intent: .oma/intent/<feature-slug>.md` line per feature, then the ticket-writer lines. Log your own calls in the decision ledger (`By: router`).

Example: "rework the theme so we can add more themes" asks which palettes ship first (Catppuccin flavours, Nord, light/dark), whether users switch themes in the app or it follows the system, and offers CSS variables with a theme registry vs. a Tailwind theme plugin vs. design tokens.

## Ticket-writer prompts

When a gatherer ran, add the line `Refs: .oma/refs/<request-slug>/` to the ticket-writer prompt. Without a gatherer, leave it out.

Every ticket-writer prompt (profile, new tickets, a confirmed regression) ends with these lines:

```
Existing tickets: <the board's ticket numbers, or none>
In flight: <tickets with a worker running or a passed branch not yet merged, or none>
Project root: <projectRoot>
Base branch: <branch>
```

## When the ticket-writer reports

- **A profile summary** (3 lines): show it to the user in plain words; they correct it if needed.
- **A `QUESTIONS` block** (its last lines, `n. question | option A (recommended) | option B ...`): handle it as in "Questions", append the answers to the feature's intent file, and resume it with them.
- **Draft tickets:** every new ticket is a draft. Go to "Approval".

## Approval

Nothing is built before the user approves it. A hook enforces this: a worker starts only on a ticket in the state's `approval.approved` list, and only the user typing `/oma approve` puts one there.

1. **Show the drafts.** For each ticket in `approval.pending`: its number and title, a summary in two or three plain lines of what users get, every line of its **Decisions made** that the user did not settle themselves, and its row on the board (what it waits for). Give the paths (`specs/tickets/NNN-slug/rd.md` and `eval.md`) so they can read the full text. Then say exactly, with the numbers of the tickets you just showed and no others: `Type /oma approve 010 011 to approve these as written, or tell me what to change.` (The command approves only the numbers it names, so a draft the user has not seen is never approved; `/oma approve all` exists, but never suggest it.) End your turn. Never ask this with AskUserQuestion and never treat "yes", "ok" or "go" as approval: only the `/oma approve <numbers>` command records it. If they answer some other way, say in one line that the command is what records it.
2. **Changes.** Resume the same ticket-writer with the user's changes verbatim, append them to the intent file, and show the changed tickets again (step 1).
3. **After `/oma approve`** (the prompt's context names the approved folders): resume the ticket-writer with `mark NNN ready` for each, then route them (see "Routing tickets" in `router-run.md`). From here on, ask the user nothing: decide, and log each decision in the ledger.
4. **A ticket that left the approved list** (its `why` says its rd.md or an approved check changed): never build it and never try to restore approval yourself. Show the user what changed and go back to step 1 for that ticket. Adding a check to eval.md keeps a ticket approved; editing or removing an approved one does not.
5. **A regression ticket** the ticket-writer wrote for a confirmed bug is a new draft too: show it and ask for `/oma approve` in plain text, without stopping the tickets that are running.
