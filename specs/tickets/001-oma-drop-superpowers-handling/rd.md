# 001: Remove all superpowers handling from /oma

**Status:** ready

## Summary
oh-my-agent-mod stops managing the superpowers plugin entirely. It no longer turns superpowers off on session start, the `/oma restore-superpowers` argument is gone, the `keep_superpowers` setting is gone, and oma never edits the user's `settings.json`. This is for every person who installs oh-my-agent-mod.

## Why
The user removes the superpowers plugin themselves (they already have). Having oma switch another plugin off, keep a journal of it, and offer a command to undo that is code and text nobody needs, and it is the only reason oma ever writes the user's global `settings.json`. If a detail below is unclear, choose the option that removes more superpowers-related code and text, and keep every other `/oma` behaviour exactly as it is.

## User stories
- As an oh-my-agent user, I want `/oma` to leave my other plugins and my user `settings.json` alone, so I am the one who decides which plugins are installed.
- As an oh-my-agent user, I want the `/oma` hints, help and settings to show only what oma really does, so nothing mentions restoring a plugin I removed.

## Functional requirements
- **FR-1**: The SessionStart hook (`oma.mjs session`) must never read or write the user's `settings.json` and must never create `<CLAUDE_CONFIG_DIR>/oh-my-agent-mod/state.json`. On a `startup` source with no router session to resume, its additionalContext must be exactly the existing hint `oh-my-agent: /oma <what to build> runs the superagent (router, workers in worktrees, tester, reviewer, merger, checker).` This holds whatever `enabledPlugins` contains.
- **FR-2**: `oma.mjs` must no longer have a `restore-superpowers` subcommand. Running `node scripts/oma.mjs restore-superpowers` must exit with code 2 and print exactly `usage: oma.mjs <session|prompt|start|status> [--dir <project>]` on stderr. Any other unknown subcommand gives the same result.
- **FR-3**: `scripts/oma.mjs` must no longer contain or export `handOver`, `handOverLocked`, `restoreSuperpowers`, `withOmcLock`, `enabledAtUserScope`, `alive` or `sleep`, or the `// --- superpowers hand-over` section. `paths()` must return only the keys `claude`, `settings`, `data` and `sessions`, with no `state` key. The header comment must list only `session`, `prompt`, `start` and `status`, and the `session` line must not mention superpowers.
- **FR-4**: In `onPrompt`, the list of `/oma` arguments that pass through without turning router mode on must be exactly `['status', 'help']`.
- **FR-5**: `commands/oma.md` must have `argument-hint: "[what to build | status | off]"` and must no longer have the `restore-superpowers` bullet. The `off`, `status` and default (start) instructions stay word for word.
- **FR-6**: `.claude-plugin/plugin.json` must no longer have a `keep_superpowers` entry in `userConfig` (`review_tickets` stays unchanged). `version` must be `0.2.0`. `description` must be exactly: `oh-my-agent (/oma): one router session that never builds. It writes tickets with you, hands each to a worker in its own git worktree, has a tester and reviewer check it, merges it, walks it in Claude Code's built-in browser and fixes small bugs, coming to you only for decisions. Sets each project up on first /oma and works alongside oh-my-context (omc).`
- **FR-7**: The `oh-my-agent-mod` entry in `/.claude-plugin/marketplace.json` must have its description end in `Sets each project up on first /oma, works alongside oh-my-context.`, so the words `replaces superpowers` are gone. The rest of that description and all other entries stay unchanged.
- **FR-8**: `README.md` of the mod must not mention superpowers anywhere:
  - The intro paragraph (line 5) must start with `Its disciplines live inside the agents (test first, root cause before fixes, no claim without fresh evidence, independent review), and it works alongside oh-my-context (`/omc`):`. Everything after that colon stays as it is.
  - The `/oma restore-superpowers` line in the Use block is removed.
  - The Settings table has only the "Review tickets before building" row.
  - The Safety bullet about settings reads exactly: `- The only settings it edits: the project's git-ignored `.claude/settings.local.json`.`
- **FR-9**: `test/oma.test.mjs` must no longer import or test any removed function. It must contain a test named `session start never touches the user settings` that does the following:
  - writes a user `settings.json` whose `enabledPlugins` includes `oh-my-agent-mod@claude-code-linux: true` and `x@y: true`;
  - calls `onSession` with `source: 'startup'`;
  - asserts that the returned text matches the startup hint, that `settings.json` is byte-identical afterwards, and that `<claude>/oh-my-agent-mod` does not exist.

  The test's header comment must not mention the hand-over. No file in `mods/oh-my-agent-mod/` may contain the word `superpowers`, in any letter case.

## Non-functional requirements
- **NFR-1**: Nothing else in `/oma` changes:
  - `oma.mjs start`, `oma.mjs status`, the `prompt` hook (router on, `/oma off`, permission-mode warning) and the compaction/resume reminder behave as before;
  - every existing non-superpowers test in `test/oma.test.mjs` and `test/scripts.test.mjs` passes unchanged;
  - `node --test mods/oh-my-agent-mod/test/*.test.mjs` exits 0.
- **NFR-2**: `claude plugin validate mods/oh-my-agent-mod` exits 0.

## Edge cases & error handling
- A user's `settings.json` still holds `"superpowers@...": false` from an earlier oma version: oma leaves it as it is (it never reads or writes that file now).
- A leftover `~/.claude/oh-my-agent-mod/state.json` from an earlier version: oma ignores it and does not delete it.
- `/oma restore-superpowers` typed after the update: no special handling. The prompt hook treats it like any other `/oma <text>` (router mode on). The command text has no bullet for it, so the router reads it as a request.
- A broken (unparseable) user `settings.json`: the session hook still prints the startup hint and exits 0, because it no longer reads that file.

## Out of scope
- Cleaning up existing users' `settings.json` superpowers entries or deleting their old `state.json`.
- The superpowers mentions in `mods/oh-my-context-mod/` (README, `test/test_gateway.py`, `test/hooks.test.js`) and the `superpowers-dev` marketplace fixture in `scripts/selfcheck.sh`. They belong to other parts of the repo and are not about `/oma`.
- The `deepseek-superagent/` folder.
- A CHANGELOG file (the repo keeps none; the version bump is the record).
- Any other change to `/oma` arguments, router.md or the agents.

## Affected areas
- `mods/oh-my-agent-mod/scripts/oma.mjs`: remove the hand-over and restore code, `paths().state`, the `restore-superpowers` branch and usage text, the header lines, `'restore-superpowers'` in `onPrompt`, and the hand-over call in `onSession` (drop its now-unused `env` parameter).
- `mods/oh-my-agent-mod/test/oma.test.mjs`: remove the three superpowers tests and their imports, update the header comment, and add the FR-9 test.
- `mods/oh-my-agent-mod/commands/oma.md`: argument-hint and bullet.
- `mods/oh-my-agent-mod/.claude-plugin/plugin.json`: `keep_superpowers` removed, description, version `0.2.0`.
- `mods/oh-my-agent-mod/README.md`: intro, Use block, Settings table, Safety bullet.
- `.claude-plugin/marketplace.json`: the oh-my-agent-mod description only.

## Do not touch
- `mods/oh-my-context-mod/`, `scripts/selfcheck.sh`, `deepseek-superagent/`: out of scope (see above).
- `mods/oh-my-agent-mod/scripts/check.mjs`, `finish-gate.mjs`, `guard.mjs`, `bin/oma`, `router.md`, `agents/`, `templates/`, `hooks/hooks.json`: they do not involve superpowers.
- `.oma/`, `specs/`: oh-my-agent's own files for this repo.

## Dependencies
- None.

## Decisions made
- **Agreed with the user**: Remove all superpowers handling: the session-start hand-over, `restore-superpowers`, the `keep_superpowers` setting, the state.json journal and every text naming them, so oma never edits the user's `settings.json`.
- **Decided by the ticket writer**:
  - Version goes 0.1.0 → 0.2.0, a minor bump because a setting and a subcommand are removed.
  - Leftover user files (old superpowers entries in `settings.json`, old `state.json`) are left alone rather than cleaned up.
  - `/oma restore-superpowers` gets no deprecation message.
  - The exact new wording of the plugin and marketplace descriptions and the README lines is as given in FR-6 to FR-8.
  - The new test uses a neutral plugin id (`x@y`), so the mod folder has no `superpowers` text at all.
  - `onSession` drops its unused `env` parameter. Callers that pass a third argument are harmless.
