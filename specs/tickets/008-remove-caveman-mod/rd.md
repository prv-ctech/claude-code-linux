# 008: Remove caveman-mod from the repo

**Status:** done

## Summary
Delete `mods/caveman-mod` and every live reference to it in this repo. The uninstall from the user's Claude Code is ticket 009.

## Why
oh-my-context-mod's reply modes (004) replace it; two mods injecting rules waste tokens and conflict.

## Functional requirements

### Repo
- **FR-1**: Delete the folder `mods/caveman-mod/` (all 10 tracked files).
- **FR-2**: `.claude-plugin/marketplace.json`: remove the `caveman-mod` plugin entry only; valid JSON; other entries unchanged.
- **FR-3**: Delete `.github/workflows/caveman-mod.yml`.
- **FR-4**: `.oma/project.md`: in the ```json block `test` command remove ` mods/caveman-mod/test/*.test.js` (rest unchanged; keep valid JSON, `oma cfg` prints it); remove any other line naming caveman-mod as a live component.
- **FR-5**: No tracked file outside `specs/tickets/` (history, left as is) contains `caveman` (case-insensitive) after this ticket.

## Out of scope
- Rewriting old tickets 001-003 or their results (history). Changing oh-my-context-mod. Anything in the user's config dir (ticket 009).

## Affected areas
- `mods/caveman-mod/` (delete), `.claude-plugin/marketplace.json`, `.github/workflows/caveman-mod.yml` (delete), `.oma/project.md`.

## Do not touch
- `mods/oh-my-context-mod/**`, `specs/tickets/001-003`, anything in the user's config dir (`/config/.claude`).

## Dependencies
- waits for 004 (the user must have reply modes before caveman-mod goes).

## Decisions made
- **Agreed with the user**: router decision 5; then "008 removes it from the repo now; the uninstall from your Claude Code (settings, cache, state files, with backups) runs later, after you push and update oh-my-context. I run that part when you say so."
- **Decided by the ticket writer**: old tickets stay as history.
