# 010: /omc is the only oh-my-context-mod command

**Status:** ready

## Summary
oh-my-context-mod registers two slash commands that do the same thing: `/oh-my-context-mod` and `/omc`. Remove the long one so `/omc` is the single main command, and make every hint, doc and description point to `/omc`.

## Why
Two entries with the same behaviour clutter the command list and confuse users. `/omc` is shorter and already the name newer docs use (`/omc mode`, `/omc compress`, `/omc status`).

## User stories
- As a user, I want one command for oh-my-context-mod in my command list, so that I know which one to type.

## Functional requirements
- **FR-1**: `mods/oh-my-context-mod/commands/oh-my-context-mod.md` must be deleted. Afterwards `commands/` holds only `omc.md`. No alias, redirect or stub for the long name is added anywhere. (The command file name decides the slash command; `omc.md` gives `/omc`.)
- **FR-2**: `commands/omc.md` must keep every subcommand working exactly as now: no argument / `status`, `on`, `off`, `mode <off|lite|full|ultra|max>`, `compress <file>`, `restore <file>`. Everything after its 4-line frontmatter must stay byte-identical to the current file (which equals the removed file's body).
- **FR-3**: The `description` in `commands/omc.md` frontmatter must be exactly `Show which MCP servers and skills run behind oh-my-context, or turn the mod on or off`. It must not contain `Short for` or `/oh-my-context-mod`.
- **FR-4**: No user-facing text in the mod or the repo marketplace may tell users to type `/oh-my-context-mod`; each such place says `/omc` instead, keeping the subcommand (`/oh-my-context-mod off` becomes `/omc off`). Known places (the worker must also run `search_code` for the literal `/oh-my-context-mod` to catch others):
  - `mods/oh-my-context-mod/.claude-plugin/plugin.json`: `description` and `userConfig.direct_servers.description`
  - `.claude-plugin/marketplace.json`: the oh-my-context-mod entry's `description`
  - `mods/oh-my-context-mod/README.md`: every command mention (status section, off/on, uninstall step 1, secrets paragraph, "Needs a value" row); the line "`/omc` is short for `/oh-my-context-mod` ..." is deleted
  - `mods/oh-my-context-mod/hooks/sync.js`: the problems line `(/oh-my-context-mod status)` becomes `(/omc status)`, and `OFF_LINE`'s `/oh-my-context-mod on routes them again.` becomes `/omc on routes them again.`
  - `mods/oh-my-context-mod/vendor/oh_my_context/client.py` and `native_tools.py`: user-facing messages that name the command
  - `mods/oh-my-context-mod/vendor/NOTICE`: change the line ending "to /oh-my-context-mod." only if it names the command; if it names the plugin, write `oh-my-context-mod` without the slash.
  Paths and identifiers that are the plugin name, not a command (`~/.claude/oh-my-context-mod/`, `oh-my-context-mod-claude-code-linux`, `mods/oh-my-context-mod/...`, `oh-my-context-mod:reply-<level>`, `.github/workflows/oh-my-context-mod.yml`) must stay unchanged.
- **FR-5**: `mods/oh-my-context-mod/.claude-plugin/plugin.json` `version` must go from `0.7.1` to `0.7.2`.
- **FR-6**: Tests using the old command name must use `/omc`: in `mods/oh-my-context-mod/test/hooks.test.js`, `ask('/oh-my-context-mod status please')` becomes `ask('/omc status please')` and still asserts `null`. Any test asserting `OFF_LINE` or the problems line text is updated to the new text.
- **FR-7**: `claude plugin validate mods/oh-my-context-mod` must pass with `commands/omc.md` as the only command.

## Non-functional requirements
- **NFR-1**: The project's full test command passes, including `mods/oh-my-context-mod/test/naming.test.js`.

## Edge cases & error handling
- After updating, typing `/oh-my-context-mod` gets Claude Code's normal unknown-command behaviour. Accepted by the user.
- If any code refers to `commands/oh-my-context-mod.md` or `oh-my-context-mod.md` by path (search with `search_code`), remove that reference.

## Out of scope
- Renaming the plugin, its folder, MCP server name, data folders or state paths (mods/AGENTS.md forbids it).
- Changing behaviour of any subcommand.
- Text of tickets 001-009.

## Affected areas
- `mods/oh-my-context-mod/commands/oh-my-context-mod.md`: deleted
- `mods/oh-my-context-mod/commands/omc.md`: description only
- `mods/oh-my-context-mod/.claude-plugin/plugin.json`: version, descriptions
- `.claude-plugin/marketplace.json`: oh-my-context-mod description
- `mods/oh-my-context-mod/README.md`: command mentions
- `mods/oh-my-context-mod/hooks/sync.js`: two user-facing strings
- `mods/oh-my-context-mod/vendor/oh_my_context/client.py`, `native_tools.py`, possibly `vendor/NOTICE`: message text
- `mods/oh-my-context-mod/test/hooks.test.js` (and any test asserting the changed strings)

## Do not touch
- `specs/tickets/001-*` to `009-*`
- Other mods

## Dependencies
None.

## Decisions made
- **Agreed with the user**: the long command is removed outright, no alias or redirect; `/omc` is the main command.
- **Decided by the ticket writer**: `/omc` description is the removed command's description verbatim; patch bump to 0.7.2; plugin-name paths stay; the README alias line is deleted, not reworded.
