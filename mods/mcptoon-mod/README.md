# mcptoon-mod

Runs your MCP servers behind one [mcptoon](https://github.com/activeing123/mcptoon) gateway and takes skills out of Claude's skill listing, so tool names and skill descriptions stop filling the context. Works in the Claude Code CLI and the desktop app (both read the same settings files).

## What it does

On every session start, a hook:

1. Reads every enabled plugin's MCP servers (`.mcp.json` or `mcpServers` in `plugin.json`) and your own servers in `~/.claude.json`.
2. Writes each one into mcptoon's config (`~/.mcptoon/config.json`), with `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${user_config.*}` and `${VAR}` filled in the way Claude Code fills them.
3. Turns the original off for the current project with `disabledMcpServers` in `~/.claude.json`, the same key the `/mcp` toggle writes. Claude then sees only the gateway (`mcptoon_manifest`, `mcptoon_inspect`, `mcptoon_call` and the rest).
4. Hides plugin skills by adding `disable-model-invocation: true` to their `SKILL.md` in the plugin cache. User skills in `~/.claude/skills` get `skillOverrides: "user-invocable-only"`. mcptoon's own skill stays listed. You can still run a hidden skill yourself with `/<name>`.
5. Rebuilds mcptoon's skill index over all of them, so Claude finds a skill with `mcptoon skills resolve "<task>"` and reads its `SKILL.md`.

Claude Code reads MCP and skill config at launch, so a change made at one start shows from the next session. The setup is applied per project: the first session in a new project sets it up, the next one uses it.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| MCP servers kept direct (`direct_servers`) | `codebase-memory-mcp` | Comma-separated servers that stay connected to Claude directly. Use a server name, a plugin name or `plugin:<plugin>:<server>`. codebase-memory-mod is direct by default because its hooks name its tools. |
| Skills kept in Claude's listing (`direct_skills`) | `superpowers` | Comma-separated skills that stay listed. A skill name keeps one skill (`brainstorming`); a plugin name keeps that plugin's whole skill set (`superpowers`). superpowers is kept by default because its skills call each other through the Skill tool, which refuses a hidden skill. |

Blank values work: everything is moved.

`/mcptoon-mod` lists every server it found and what happens to each (`forwarded`, `forward*` = on the next start, `direct` with the reason). `/mcptoon-mod off` puts everything back. `/mcptoon-mod on` turns it on again.

## What stays direct by itself

- A server whose config needs a value the hook cannot read: a `sensitive` plugin option (kept in the keychain, for example authentik-mod's token) or an env var that is not set. `/mcptoon-mod` names the missing value.
- `sse` and `ws` servers, and servers with `headersHelper`.
- Plugins enabled only in a project's `.claude/settings.json`.
- The gateway itself.

## Safety

- **Run `/mcptoon-mod off` before you disable or uninstall the mod.** A disabled mod's hook does not run, so the servers it turned off would stay off and the skills it hid would stay hidden. To fix that by hand, delete the `plugin:...` entries from `disabledMcpServers` in `~/.claude.json` and remove the `disable-model-invocation: true` lines.
- The mod changes only what it added. Everything it adds is recorded in `${CLAUDE_PLUGIN_DATA}/state.json`. A server you turned off yourself in `/mcp`, a `skillOverrides` entry you set and a skill that sets `disable-model-invocation` itself are left alone.
- `~/.mcptoon/config.json` then holds the env and headers of the servers it runs, which can include tokens from `~/.claude.json`. The mod sets it to mode `0600`.
- If mcptoon does not run, the session-start hook puts everything back, because Claude would have no way to reach a hidden server.
- A plugin update replaces its cache folder, so its skills are listed again until the next session start.
- Skill sets like superpowers tell Claude to use the Skill tool, which refuses a hidden skill. superpowers stays listed by default; add any other such plugin to `direct_skills`. For a hidden skill the session-start note tells Claude to read its `SKILL.md` instead.

## mcptoon itself

If `mcptoon` is on your `PATH`, the mod uses it, so your own `mcptoon` commands and the gateway share one config. If not, `bin/mcptoon` installs the version pinned in `requirements.txt` into a venv in `${CLAUDE_PLUGIN_DATA}` on first use. That version has no runtime dependencies.

## Tests

```bash
node --test mods/mcptoon-mod/test/*.test.js
```
