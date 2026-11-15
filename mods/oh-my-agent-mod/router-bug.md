# oh-my-agent router: quick fix

Read when triage says quick. Part of `router.md`.

## Quick path

You fix it yourself, in this session, in the main checkout. No ticket, worktree, worker or merger. This is the one time you edit code and run git.

1. **Can it run now?** Not while a merger or first-timer works in the main checkout, or `mergeInProgress` is true, or `uncommittedTracked` lists files you'd touch (the fix's commit would capture the user's edits). Then queue it or route it to the reproducer instead, and say why in one line.
2. **Reproduce first:** a fast pass/fail check that shows the bug: a failing test, a `curl`, a command, or one browser check on mainPort (use the user's running server; if none, `oma serve <mainPort>`, and `oma stop <mainPort>` when done). Keep its output. Can't reproduce → say so and stop, or route it to the reproducer.
3. **Root cause in one sentence** before any edit: "X because Y", traced from the symptom to the code. No guesses tried one after another.
4. **Regression test first** when the profile has a test command (`oma cfg` shows it; `none` means no test): the smallest test that fails because of this cause. Run it and see it fail for that reason.
5. **One fix**, at the cause, following existing patterns. If it doesn't hold, restore the files and form a new hypothesis; after 3 failed fixes, restore everything and route it to the full pipeline.
6. **Grows past quick** (more files, a contract, a dependency, a design choice): restore the files and route it to the full pipeline, saying in one line why.
7. **Verify:** re-run the reproduction, then `oma run lint`, `oma run build`, `oma run test` (each prints `none (skipped)` when the profile has no such command; never skip one yourself). Read each output; every claim needs this run's output. No "should work".
8. **Check it in the app** (`web` or `api` apps; skip for `cli`). A passing unit test is not enough here. `oma up <mainPort>`; if it doesn't print 200, `oma serve <mainPort>` (and `oma stop <mainPort>` when done). Then look at the fixed behaviour: the page in the built-in browser for anything visual, or `curl` the page or endpoint when the browser tools aren't available. Quote what you saw in your report.
9. **Log** any decision you made that the bug report didn't settle in the decision ledger (`By: router`).
10. **Commit** only the files you fixed and the test (`git add <files>`, never `-A`, never `.oma/` or `specs/tickets/`): `git commit -m "Fix: <one line>"`. Never push.
11. **Report** in at most 4 lines: what was wrong, the cause, the fix (files), and the checks that passed.
