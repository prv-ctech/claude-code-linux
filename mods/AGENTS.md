# Rules for every mod in this folder

A mod is a Claude Code plugin in `mods/<name>-mod/`, installed from this repo's marketplace. Claude Code expects all of this; a mod missing one of them does not install, update or run properly.

- **Manifest:** `.claude-plugin/plugin.json` with `name` (the folder name), `version` (semver), `description`, `author`, `license`. Run `claude plugin validate mods/<name>-mod` before committing.
- **Version bump:** an installed copy is keyed by `version`. Any change that should reach users needs a bump in the same PR, or installed copies never update.
- **Marketplace:** an entry in `/.claude-plugin/marketplace.json` (`name`, `source: ./mods/<name>-mod`, `description`). Users update from `main`, so nothing reaches them until it is merged there.
- **Layout:** `commands/*.md`, `skills/<name>/SKILL.md`, `hooks/hooks.json` and `.mcp.json` sit at the plugin root, not inside `.claude-plugin/`. Commands are Markdown with frontmatter, not `.toml`.
- **Paths:** reference files with `${CLAUDE_PLUGIN_ROOT}`. Write state, caches and installed dependencies to `${CLAUDE_PLUGIN_DATA}`, never into the plugin folder: updates replace it.
- **Config and secrets:** user settings go in `userConfig` in `plugin.json`, tokens with `"sensitive": true` (keychain). Never hardcode or commit a secret. Every setting must work left blank: the settings form leaves unset fields empty.
- **Dependencies:** pinned, with a lockfile, installed on first use by a wrapper in `bin/`. Never commit `node_modules` or binaries. Hooks and MCP servers keep stdout clean (it is the protocol) and log to stderr.
- **Docs and tests:** a `README.md` in the mod (what it is, settings, safety), and tests that run without network in CI (`.github/workflows/<name>.yml`, path-filtered to the mod).
- **Do not rename** a published mod or its MCP server name: users' settings and tool names depend on it.
