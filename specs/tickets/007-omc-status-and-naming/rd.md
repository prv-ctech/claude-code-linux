# 007: /omc status shows the whole mod, plus the naming check

**Status:** ready

## Summary
`/omc status` (also `/omc` with no argument) reports everything the mod does in one view: on/off, MCP servers direct vs routed (with reason), skills (hidden / listed by name only / direct), reply mode, tool-result compression, recovery store size and cap, tokens saved. An automated test fails if a forbidden upstream name appears anywhere in the mod.

## Why
One place to see what is active and what it saves. The naming test keeps the mod free of the upstream project's names for good.

## Functional requirements
- **FR-1**: `status()` in `mods/oh-my-context-mod/hooks/sync.js` keeps every current line (mod on/off + CLI, MCP servers list with `forwarded|forward*|direct` and reasons, Skills line, Commands line, Guard, Filters, Paths) and adds, after the Commands line, these lines in this order:
  - `Skills by name: direct: <comma list or none>; hidden: <comma list or none>; listed by name only: <count>` (names from the same skill plan status already computes; direct = matched by direct_skills).
  - `Reply mode: <off|lite|full|ultra|max> (style: <outputStyle or default>)`, read by running `node hooks/reply.js status` (ticket 004) or reading its state file the same way.
  - `Tool-result compression: <on|off>` (the gateway `compress` setting, default on per ticket 005).
  - `Recovery store: <size MiB, 1 decimal> MiB of <cap MiB> MiB, <entries> entries (<path>)`.
  - `Tokens saved by compression: <N>` (usage.json `saved_tokens`; 0 when missing).
  The gateway values come from one new CLI subcommand `oh-my-context stats` (in `vendor/oh_my_context/cli.py`) printing one JSON line `{"compress":"on","recovery":{"bytes":..,"cap":..,"entries":..,"path":".."},"saved_tokens":N}`, using `recovery.stats()` and `usage.saved_tokens()` from ticket 005. If the CLI fails, those three lines say `unknown (gateway CLI not runnable)`.
- **FR-2**: `commands/omc.md` and `commands/oh-my-context-mod.md`: the `status` bullet describes the new lines. No other behaviour change.
- **FR-3**: New test `mods/oh-my-context-mod/test/naming.test.js` (node:test): walks every file under `mods/oh-my-context-mod/` (git-tracked and untracked, skipping `__pycache__`, `.pyc`) and fails, naming the file and line, if any file name or content matches `/caveman|ultracave|megacave|\bcave\b|ccr/i`. Its own pattern is built from pieces (e.g. `['cave','man'].join('')`) so the test file itself passes.
- **FR-4**: Remove every remaining match the test finds under the mod (expected: none after 004-006; fix any left, including README and `vendor/NOTICE`).
- **FR-5**: README.md: new sections "Tool-result compression" (shapes, thresholds summary, TOON, marker format `<<omc:HANDLE>>`, `retrieve` with `query`, recovery store path, 512 MiB cap and `OMC_RECOVERY_MAX_BYTES`, no eviction, `compress` setting on/off) and "Status" (sample output). plugin.json version: next minor above base; description mentions compression, recovery, `/omc compress`, `/omc status`.
- **FR-6**: `test/sync.test.js` (or a new test) asserts the new status lines with a temp config, a stub gateway CLI and a stub reply state.

## Non-functional requirements
- **NFR-1**: `/omc status` still changes nothing on disk and finishes in < 5 s.

## Edge cases & error handling
- Recovery dir missing: `0.0 MiB of 512.0 MiB, 0 entries`.
- Reply state missing: `Reply mode: ultra` (004 default).

## Out of scope
- Live savings per server, history graphs, money figures.

## Affected areas
- `hooks/sync.js` (status only), `vendor/oh_my_context/cli.py`, `commands/omc.md`, `commands/oh-my-context-mod.md`, `test/naming.test.js` (new), `test/sync.test.js`, `README.md`, `.claude-plugin/plugin.json`.

## Do not touch
- `hooks/reply.js`, `scripts/doc.js`, `vendor/oh_my_context/recovery.py`, `shapes/`, `.claude-plugin/marketplace.json` (ticket 008 edits it; the marketplace description stays as is this round).

## Dependencies
- waits for 005 (recovery.stats, saved_tokens) and 006 (shared commands/README/plugin.json; 006 itself waits for 004).

## Decisions made
- **Agreed with the user**: router decisions 2e, 3.
- **Decided by the ticket writer**: status stays in sync.js and gets gateway numbers from a new `oh-my-context stats` CLI subcommand; naming test in Node so it runs in the existing test command.
