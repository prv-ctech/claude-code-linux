# 009: Uninstall the old mod from the user's Claude Code

**Status:** draft

## Summary
Uninstall caveman-mod from the user's running Claude Code (plugin entry, output style setting, state files, cached copy), backing up every user file touched. Runs only once the installed oh-my-context-mod has reply modes.

## Why
008 removed caveman-mod from the repo. The installed copy still runs until uninstalled; it must go only after the user pushed main and updated oh-my-context-mod, else no reply mode remains and outputStyle names a missing style.

## Functional requirements

### User's Claude Code (outside the repo; `C` = `$CLAUDE_CONFIG_DIR`, else `~/.claude`; on this machine `/config/.claude`)
Done by a one-time Node script the worker writes in its scratchpad (never committed), runs once, and whose output it pastes into this ticket's results.md. Steps, in order, each idempotent:
- **FR-6**: Backup first: copy `C/settings.json`, `C/plugins/installed_plugins.json` and `C/oh-my-context-mod/reply.json` (if present) to `C/backups/remove-caveman-mod-<UTC yyyymmddHHMMSS>/` (dir 0700, files keep content). Abort with no change if any copy fails.
- **FR-7**: Run `claude plugin uninstall caveman-mod@claude-code-linux --scope user`. This removes its `enabledPlugins` key, its `installed_plugins.json` entry, its cache `C/plugins/cache/claude-code-linux/caveman-mod/` and data dir `C/plugins/data/caveman-mod-claude-code-linux/`. Afterwards check each of those four is gone; remove only what is left of exactly those (the key `enabledPlugins["caveman-mod@claude-code-linux"]` in settings.json, the `caveman-mod@claude-code-linux` key in installed_plugins.json, the two dirs).
- **FR-8**: Output style: let `prev` = `style.prev` from `C/caveman-mod.json` (on this machine `"Concise"`; null if missing). In `C/settings.json`: if `outputStyle` is `caveman-mod:ultracave`, set it to `oh-my-context-mod:reply-<mode>` when `C/oh-my-context-mod/reply.json` mode is not off (mode default ultra), else to `prev` (delete the key if prev is null). In `C/oh-my-context-mod/reply.json`: if `style.prev` is `caveman-mod:ultracave`, set it to `prev`. Touch no other key. Write via temp + rename; never write an unreadable settings.json.
- **FR-9**: Delete `C/caveman-mod.json`, the dir `C/caveman-mod-fired/`, and `C/plugins/data/caveman-mod-inline/`.
- **FR-10**: Print one line per action (`backed up`, `uninstalled`, `removed <path>`, `outputStyle: <old> -> <new>`, `already gone: <path>`). Nothing else in C is touched.

- **FR-0** (runs before FR-6): read `C/plugins/installed_plugins.json`, take the installPath of the `oh-my-context-mod@claude-code-linux` entry (the version installed). If `<installPath>/output-styles/reply-ultra.md` does not exist (or the entry is missing), print `stop: installed oh-my-context-mod <version> has no reply modes; push main and update the plugin first`, exit 1, change nothing (no backup either).

## Non-functional requirements
- **NFR-1**: Every other key of settings.json and installed_plugins.json is byte-for-byte equal in parsed JSON before/after except the keys named above.

## Edge cases & error handling
- Plugin already uninstalled: uninstall command error is ignored; checks of FR-7 still run.
- settings.json unparsable: stop, change nothing more, report.

## Edge cases & error handling
- Plugin already uninstalled: uninstall command error is ignored; checks of FR-7 still run.
- settings.json unparsable: stop, change nothing more, report.

- FR-0 fails: nothing is written, not even a backup.

## Out of scope
- Any repo file (008 did those). Changing oh-my-context-mod. Pushing or updating the plugin (the user does it).

## Affected areas
- User files only, listed in FR-6..FR-9. Nothing tracked in the repo except this ticket's results.

## Do not touch
- Every tracked repo file, any other key or file in the user's config dir.

## Dependencies
- waits for 008, and for the user to push main and run the oh-my-context-mod plugin update (router marks this ready then).

## Decisions made
- **Agreed with the user**: router decision 5 (remove completely, back up, exact files and keys); "008 removes it from the repo now; the uninstall from your Claude Code (settings, cache, state files, with backups) runs later, after you push and update oh-my-context. I run that part when you say so."
- **Decided by the ticket writer**: removal script lives only in the worker's scratchpad (one-time, not shipped); output style moves to the omc reply style if reply mode is on, else back to the style the user had before caveman (`Concise` here); guard checks the installed copy for `output-styles/reply-ultra.md`.
