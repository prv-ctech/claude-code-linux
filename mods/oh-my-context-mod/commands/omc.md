---
description: Short for /oh-my-context-mod: show which MCP servers and skills run behind oh-my-context, or turn the mod on or off
argument-hint: "[status|on|off|mode <off|lite|full|ultra|max>|compress <file>|restore <file>]"
---

If the first word of `$ARGUMENTS` is `compress` or `restore`, do not run sync.js; follow the document flow below instead. If no file path follows (for example pasted text), reply `usage: /omc compress <file path>` and do nothing.

Restore: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/doc.js" restore <path>` and show its output.

Compress, in order:

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/doc.js" prepare <path>`. If it prints `refused:`, show that and stop. Otherwise it prints `backup:`, `candidate:` and the rewrite rules.
2. Read the file, rewrite it by those rules to the fewest tokens, and write the result to the candidate path.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/doc.js" apply <path>`. On `compressed:` show it and stop.
4. On `invalid:` fix only the listed problems in the candidate (no full rewrite) and run apply again, at most 2 retries.
5. If the third apply still fails, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/doc.js" abort <path>` (prints `left unchanged:`) and report the problems to the user.

If the first word of `$ARGUMENTS` is `mode`, run this Bash command instead and show its output as is:

node "${CLAUDE_PLUGIN_ROOT}/hooks/reply.js" $ARGUMENTS

Otherwise run this Bash command and show its output as is, without changing anything:

(cd "${CLAUDE_PROJECT_DIR}" && node "${CLAUDE_PLUGIN_ROOT}/hooks/sync.js" "$ARGUMENTS")

What each argument does (no argument means `status`):

- `status`: lists every MCP server of this project and what happens to it (`forwarded`, `forward*` = from the next session start, or `direct` with the reason), how many skills and commands are routed, whether the guard hooks are installed, the two settings and the paths in use. Changes nothing.
- `off`: puts everything back (MCP server switches, gateway entries, skill overrides, patched plugin skill and command files, guard hooks) and keeps the mod off until `on` (the switch is a file `off` in the plugin's data folder; uninstalling the plugin clears it). Claude shows every server and skill fully from the next session.
- `on`: turns the mod back on and applies the setup to this project now; it counts from the next session.
- `mode <off|lite|full|ultra|max>`: sets the terse reply mode (output style plus reminders in every prompt, tool result and subagent); `mode` alone shows the current one. `off` puts your previous output style back. Independent of `on` and `off`.
- `compress <file>`: rewrites a prose file (`.md`, `.markdown`, `.txt`, `.rst`, `.typ`, `.typst`, `.tex`, or no extension) to fewer tokens, keeping code, paths, numbers and headings byte for byte; the original is backed up outside the folder. `restore <file>` puts it back.
