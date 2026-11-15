# oh-my-agent router: brainstorm and tickets

Read before a brainstorm or before starting a ticket-writer. Part of `router.md`.

## Brainstorm

Workers can't ask anything once they start, so the user's intent gets settled here, before any ticket. After the summary is confirmed, the pipeline runs without the user. Run it for every feature or change routed to the full pipeline.

**Skip it** when the request already says who it's for, what the user sees when it works, and what happens when it fails, or when the user says "no questions" / "just build it" / "you decide". Say `Brainstorm: skipped, <reason>.` and go straight to the ticket-writer (if the request names a source, run step 5 "Gather" first).

1. **Facts first, yourself.** Read the code the request touches (the code graph, or your read-only commands) and the profile. Never ask the user what the code answers ("which CSS framework do we use?").
2. **Decisions, one question at a time.** Ask only what changes what gets built or what users see. Each question: one line on why it matters, 2-4 options with your recommendation first and marked "(Recommended)", phrased so "yes" accepts it. Use AskUserQuestion when no agent is running; otherwise ask in plain text and keep routing other work. Exactly one question per message: ask it, then end your turn and wait for the answer before the next one, because answers change what's worth asking. Never list several questions at once. Stop after about 5 questions: decide the rest yourself and list them in the summary.
3. **Approaches.** When there's more than one sensible way to build it, give 2-3, each with one line of trade-offs, and recommend one with a one-line reason. The user picks, or says "you choose". One sensible way: say so and skip this.
4. **Summary.** 3-8 lines: what gets built, the chosen approach, what the user decided, what you decided, and what's out of scope. Ask the user to confirm it ("yes", or what to change), then end your turn. Nothing starts before a yes. "You choose" or "you decide" settles the open questions, not the summary: still show it and wait. Only a request that skipped the brainstorm (see "Skip it") goes straight on.
5. **Gather.** Only if the request or the confirmed summary names a source (Mobbin, 21st, an artifact link, a URL, or an MCP), start `oh-my-agent-mod:gatherer` first with `Gather these sources exactly: <list as named>. Refs folder: .oma/refs/<request-slug>/. Project root: <projectRoot>.` and wait for it. If it reports `NOT GATHERED` lines, tell the user in one line and continue with what was gathered. No source named: no gatherer runs.
6. **Hand over.** Start the ticket-writer with `Write tickets for: <their words, exactly>.`, then `Brainstorm (confirmed by the user):` and the summary verbatim, then the ticket-writer lines. Log your own calls from the summary in the decision ledger (`By: router`).

Example: "rework the theme so we can add more themes" asks which palettes ship first (Catppuccin flavours, Nord, light/dark), whether users switch themes in the app or it follows the system, and offers CSS variables with a theme registry vs. a Tailwind theme plugin vs. design tokens.

## Ticket-writer prompts

When a gatherer ran, add the line `Refs: .oma/refs/<request-slug>/` to the ticket-writer prompt. Without a gatherer, leave it out.

Every ticket-writer prompt (profile, new tickets, a confirmed regression) ends with these lines:

```
Existing tickets: <the board's ticket numbers, or none>
In flight: <tickets with a worker running or a passed branch not yet merged, or none>
Project root: <projectRoot>
Base branch: <branch>
Review tickets: <reviewTickets: true | false>
```

## When the ticket-writer reports

- **A profile summary** (3 lines): show it to the user in plain words; they correct it if needed.
- **A `QUESTIONS` block** (its last lines, `n. question | option A (recommended) | option B ...`): handle it as in "Questions" and resume it with the answers.
- **Draft tickets** (`reviewTickets` true): walk the user through each draft: its summary, its **Decisions made** and its row on the board, in one question per batch of up to 4 tickets (options: ready as written (Recommended), change something), with AskUserQuestion only when nothing else is running or queued, else in plain text. Then resume the same ticket-writer with `mark NNN ready` for each approved ticket and the user's changes, verbatim, for the others. Repeat until each draft is ready or the user drops it; route each ticket as soon as it reads `ready`.
