# 008: Remove caveman-mod from the repo and from the user's Claude Code

**Status:** ready

## Summary
Delete `mods/caveman-mod` and every live reference to it in this repo, and uninstall it from the user's running Claude Code (plugin entry, output style setting, state files, cached copy), backing up every user file touched. Only after ticket 004 merged, so the user always has a reply mode.

## Why
oh-my-context-mod's reply modes (004) replace it; two mods injecting rules waste tokens and conflict.

## Functional requirements

### Repo
- **FR-1**: Delete the folder `mods/caveman-mod/` (all 10 tracked files).
- **FR-2**: `.claude-plugin/marketplace.json`: remove the `caveman-mod` plugin entry only; valid JSON; other entries unchanged.
- **FR-3**: Delete `.github/workflows/caveman-mod.yml`.
- **FR-4**: `.oma/project.md`: in the ```json block `test` command remove ` mods/caveman-mod/test/*.test.js` (rest unchanged; keep valid JSON, `oma cfg` prints it); remove any other line naming caveman-mod as a live component.
- **FR-5**: No tracked file outside `specs/tickets/` (history, left as is) contains `caveman` (case-insensitive) after this ticket.

### User's Claude Code (outside the repo; `C` = `$CLAUDE_CONFIG_DIR`, else `~/.claude`; on this machine `/config/.claude`)
Done by a one-time Node script the worker writes in its scratchpad (never committed), runs once after the repo change is merged-ready, and whose output it pastes into this ticket's results.md. Steps, in order, each idempotent:
- **FR-6**: Backup first: copy `C/settings.json`, `C/plugins/installed_plugins.json` and `C/oh-my-context-mod/reply.json` (if present) to `C/backups/remove-caveman-mod-<UTC yyyymmddHHMMSS>/` (dir 0700, files keep content). Abort with no change if any copy fails.
- **FR-7**: Run `claude plugin uninstall caveman-mod@claude-code-linux --scope user`. This removes its `enabledPlugins` key, its `installed_plugins.json` entry, its cache `C/plugins/cache/claude-code-linux/caveman-mod/` and data dir `C/plugins/data/caveman-mod-claude-code-linux/`. Afterwards check each of those four is gone; remove only what is left of exactly those (the key `enabledPlugins["caveman-mod@claude-code-linux"]` in settings.json, the `caveman-mod@claude-code-linux` key in installed_plugins.json, the two dirs).
- **FR-8**: Output style: let `prev` = `style.prev` from `C/caveman-mod.json` (on this machine `"Concise"`; null if missing). In `C/settings.json`: if `outputStyle` is `caveman-mod:ultracave`, set it to `oh-my-context-mod:reply-<mode>` when `C/oh-my-context-mod/reply.json` mode is not off (mode default ultra), else to `prev` (delete the key if prev is null). In `C/oh-my-context-mod/reply.json`: if `style.prev` is `caveman-mod:ultracave`, set it to `prev`. Touch no other key. Write via temp + rename; never write an unreadable settings.json.
- **FR-9**: Delete `C/caveman-mod.json`, the dir `C/caveman-mod-fired/`, and `C/plugins/data/caveman-mod-inline/`.
- **FR-10**: Print one line per action (`backed up`, `uninstalled`, `removed <path>`, `outputStyle: <old> -> <new>`, `already gone: <path>`). Nothing else in C is touched.

## Non-functional requirements
- **NFR-1**: Every other key of settings.json and installed_plugins.json is byte-for-byte equal in parsed JSON before/after except the keys named above.

## Edge cases & error handling
- Plugin already uninstalled: uninstall command error is ignored; checks of FR-7 still run.
- settings.json unparsable: stop, change nothing more, report.

## Out of scope
- Rewriting old tickets 001-003 or their results (history). Changing oh-my-context-mod.

## Affected areas
- `mods/caveman-mod/` (delete), `.claude-plugin/marketplace.json`, `.github/workflows/caveman-mod.yml` (delete), `.oma/project.md`; user files listed in FR-6..FR-9.

## Do not touch
- `mods/oh-my-context-mod/**`, `specs/tickets/001-003`, any other key or file in the user's config dir.

## Dependencies
- waits for 004 (the user must have reply modes before caveman-mod goes).

## Decisions made
- **Agreed with the user**: router decision 5 (remove completely, back up, exact files and keys).
- **Decided by the ticket writer**: removal script lives only in the worker's scratchpad (one-time, not shipped); output style moves to the omc reply style if reply mode is on, else back to the style the user had before caveman (`Concise` here); old tickets stay as history.
