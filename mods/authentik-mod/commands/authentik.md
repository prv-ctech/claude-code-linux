---
description: Work on this task in the connected authentik instance
argument-hint: <what to do in authentik>
---

Do this in authentik: $ARGUMENTS

- Load the `authentik` skill first and follow it.
- The tools are MCP tools named `mcp__plugin_authentik-mod_authentik__authentik_<domain>_<action>`. Their schemas are deferred: load the ones needed with one ToolSearch call before the first call.
- Start with `authentik_status` to confirm the connection, version and which domains and modes are on.
- Risky tools answer with a dry run until called again with `confirm: true`. Show the dry run to the user and wait for a yes first.
- If a tool is missing, say which domain or mode is off (read-only, `enabled_domains`, flows editing) and how to change it with `/plugin configure authentik-mod@claude-code-linux`. If a call fails with 403, name the permission the role lacks.
