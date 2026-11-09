# Watchdog rules

The rules the oh-my-agent router follows when it judges its watch. The router runs the plugin's `check.mjs --watch` under its Monitor tool; every round the script checks the workers' status files and the main app, and prints a line only when something looks wrong (or a browser walk is due). The router judges each line against this file. Edit it any time in plain English, or ask the router to change a rule. Changes apply from the next round.

## Numbers you can change

`check.mjs` reads the json block below. Keep it valid JSON: if it can't be read, the script uses its built-in defaults (the values shown here) and the watch prints a warning line.

```json
{
  "roundIntervalMinutes": 10,
  "staleMinutes": 15,
  "staleMinutesByStep": { "testing": 30, "reviewing": 30 },
  "slowStepMinutes": 45,
  "evalRoundsWithoutProgress": 3,
  "appUrl": "http://localhost:3000",
  "healthPaths": [],
  "healthTimeoutSeconds": 30,
  "browserWalkEveryNRounds": 3,
  "repeatReportAfterMinutes": 60,
  "driftIgnore": [".oma/job/"]
}
```

- `roundIntervalMinutes`: minutes between rounds, 1 to 25. Takes effect when the router next re-arms its watch (within 30 minutes).
- `staleMinutes`: a worker counts as silent when its status file hasn't been updated for this long, for every step not in `staleMinutesByStep`.
- `staleMinutesByStep`: longer limits per step. A worker can't update its status while it waits on its tester and reviewer, so `testing` and `reviewing` get 30.
- `slowStepMinutes`: a worker counts as slow when it has been on one step this long.
- `evalRoundsWithoutProgress`: a worker counts as stuck when this many test rounds in a row end without fewer failing checks than its best round so far.
- `appUrl`, `healthPaths`, `healthTimeoutSeconds`: where the main checkout's app runs and which pages must answer 200 (pages that work without signing in). `[]` for an app with no server.
- `browserWalkEveryNRounds`: every round whose number divides by this, with the app answering and no team active, the watch prints a `walk-due` line and the router sends the checker to walk the core flows.
- `repeatReportAfterMinutes`: how long before the same problem is acted on again.
- `driftIgnore`: paths a worker may always change. Its own ticket folder always counts as allowed. Add the files tools rewrite on their own (project.md lists them).

## What counts as stuck

- Its status file's `updated` is older than the stale limit for its step, while the step is not `done` or `blocked`.
- It has been on the same step longer than `slowStepMinutes`.
- Its failing check count hasn't gone down for `evalRoundsWithoutProgress` test rounds.
- Its step is `blocked`. The `note` says why. Always needs action.

Not stuck: a `done` step however old; a worker that was slow once and moved on; a worktree with no status file younger than `staleMinutes` (still setting up).

Before acting on `stale` or `slow`, look at `git -C <worktree> log -3 --format='%cr %s'`: a worker that is committing but forgot its status is not stuck.

## What counts as drifting

Changing files its ticket doesn't list under `## Affected areas`. Use common sense first: a lockfile next to a listed manifest, a generated type file or a test next to a listed source file is fine. Act on it when the file belongs to another ticket's area or is a shared piece (database setup, auth, a shared schema, routing, middleware) the ticket doesn't mention. A ticket with no Affected areas list has nothing to compare against.

## App health

- Every page in `healthPaths` must return 200 on the main checkout's app.
- The app not running at all (`app-not-running`) is not a fault; skip health checks and the walk that round.
- While a team ticket is in progress (`team-active`), the team edits and restarts the main app: no walk, and `app-down` counts only when the script says a teammate's status file is also stale.
- A team status file whose ticket shows `done` on the board is a leftover; the script already skips it.

## What to act on and what to ignore

Act on: any stuck or blocked worker, drift into shared pieces or another ticket's area, the main app erroring or failing a step of the walk, a `warning` line about this file (tell the user once).

Ignore: anything that looks fine on a closer look, the same problem within `repeatReportAfterMinutes` unless it got worse, dev server warnings a user would never see, workers whose step is `done`.

Log every judged line to `.oma/job/watch-log.md`, one line each: what was flagged and what you did or why you ignored it.
