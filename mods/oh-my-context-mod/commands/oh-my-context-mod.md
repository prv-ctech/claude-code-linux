---
description: Show which MCP servers and skills run behind oh-my-context, or turn the mod on or off
argument-hint: "[status|on|off]"
---

Run this Bash command and show its output as is, without changing anything:

(cd "${CLAUDE_PROJECT_DIR}" && node "${CLAUDE_PLUGIN_ROOT}/hooks/sync.js" "$ARGUMENTS")

What each argument does (no argument means `status`):

- `status`: lists every MCP server of this project and what happens to it (`forwarded`, `forward*` = from the next session start, or `direct` with the reason), how many skills and commands are routed, whether the guard hooks are installed, the two settings and the paths in use. Changes nothing.
- `off`: puts everything back (MCP server switches, gateway entries, skill overrides, patched plugin skill and command files, guard hooks) and keeps the mod off until `on` (the switch is a file `off` in the plugin's data folder; uninstalling the plugin clears it). Claude shows every server and skill fully from the next session.
- `on`: turns the mod back on and applies the setup to this project now; it counts from the next session.
