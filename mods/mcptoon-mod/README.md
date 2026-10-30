# mcptoon-mod (deprecated)

Replaced by [oh-my-context-mod](../oh-my-context-mod). Version 0.1.1 does one thing: at each session start it puts back what 0.1.0 changed (its entries in `~/.mcptoon/config.json`, its `disabledMcpServers` entries in `~/.claude.json`, the `disable-model-invocation` lines in plugin skills and its skill overrides), using the record 0.1.0 kept in its plugin data folder, and tells you what to do next. No MCP server, no gateway, nothing downloaded.

Next steps:

1. Install `oh-my-context-mod` from this marketplace.
2. Uninstall `mcptoon-mod` (`/plugin uninstall mcptoon-mod@claude-code-linux`).

Tests (offline): `node --test mods/mcptoon-mod/test/*.test.js`

License: MIT.
