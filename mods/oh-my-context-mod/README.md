# oh-my-context-mod

Routes every MCP server and skill Claude Code would load through one gateway, oh-my-context, so their tool names and skill descriptions stop filling the context. Every tool and skill still works as if it were loaded directly. Works in the Claude Code CLI and the desktop app (both read the same settings files).

The gateway is vendored in `vendor/oh_my_context` (Python, no dependencies), cut down to what this plugin runs. It needs `python3` 3.10 or newer and `node` on `PATH`; nothing is downloaded.

## What it does

On every session start, a hook (`hooks/sync.js session`) sets this up:

| What | How |
|---|---|
| MCP servers | Every server Claude would start (yours and local-scope ones in `~/.claude.json`, and each enabled plugin's, user or project scope) gets an entry in the gateway config and is turned off for this project with `disabledMcpServers` in `~/.claude.json`, the key the `/mcp` toggle writes. Claude then sees only the gateway's own tools. |
| Original tool names | The gateway's tools are `mcp__plugin_oh-my-context-mod_oh-my-context__<tool>` to Claude. `call` takes one of two forms: `tool` set to a routed tool's original Claude name (`mcp__github__create_issue`, `mcp__plugin_<plugin>_<server>__<tool>`), with `server` left out or naming the server that tool belongs to; or `server` plus the server's own tool name as `tool`. Any other form (a `name` argument, a bare tool name without `server`, a server that is not routed or does not match) is refused. `manifest` lists the routed tools and `inspect` shows one tool's parameters. These three and `resolve_skills` are loaded up front; the gateway's other tools stay deferred. |
| Results | A routed call returns what a direct call would: the server's own content blocks (text, images, resources) and its `structuredContent`, and an `isError` result stays an error. Results are not compressed; `{"compress": "smart"}` in the gateway's `settings.json` (next to its config, see Secrets below) turns the gateway's compression on from the next session. |
| Server instructions | A routed server's own instructions come with its first successful call instead of on every turn, and again after `/clear`, compaction, or a subagent starting or finishing (the SessionStart, SubagentStart and SubagentStop hooks tell the gateway a new context began). `inspect` shows them only for a server that is already running; it never starts one. |
| Prompts and resources | A routed server's prompts show as `/mcp__plugin_oh-my-context-mod_oh-my-context__<server>__<prompt>`, and its resources are listed and read through the gateway. Only servers known to offer them are asked, so a newly added server's prompts and resources appear after its first call or tool fetch. |
| Plugin skills | Each `SKILL.md` gets the one-line description `routed` (its `when_to_use` is dropped). The skill stays listed by name and the Skill tool still runs it. A file reached through a symlink is left as it is (but still indexed). |
| Your skills | Skills in `~/.claude/skills` get `skillOverrides: "name-only"`, unless you set an override for that skill yourself. |
| Plugin commands | Get the one-line description `routed`, like skills: listed by name only, still run by Claude and as `/name`. |
| Finding skills | The original `SKILL.md` files are copied to a catalog and indexed, named by the id the Skill tool takes (`superpowers:brainstorming`), so `resolve_skills` finds a skill by what it does. |
| Prompt hints | On each prompt, `hooks/prompt.js` asks `oh-my-context hint` (offline: the skill index and cached tool lists only) which routed skills and tools clearly fit, and adds their names as one line of context. Skipped for prompts under 12 characters, `/commands` and a line identical to the session's last one. |
| Permissions | `hooks/permit.js` runs before every `call`, maps it back to the original tool name and applies your permission rules for that name: deny, then ask, then allow, from managed, user, project and local settings (`mcp__server`, `mcp__server__tool` and `*` wildcards). Managed rules are read from `managed-settings.json` and `managed-settings.d/*.json` in `/etc/claude-code`, `/Library/Application Support/ClaudeCode` or `C:\Program Files\ClaudeCode`; MDM, registry and server-managed policies are not read. Project and local rules come from the project root (`CLAUDE_PROJECT_DIR`), not from where a Bash `cd` left the session. A tool name is matched the way Claude spells it (characters outside `A-Z a-z 0-9 _ -` become `_`), so a `call` with `tool: "mcp__fs__files.delete"` meets your rules for `mcp__fs__files_delete`. With no rule, the call asks, as Claude does for an MCP tool you have not allowed, in the `default`, `acceptEdits`, `plan` and `dontAsk` modes, and the prompt names the rule to add (`mcp__<server>` or `mcp__<server>__<tool>` in `permissions.allow`); in `auto` and `bypassPermissions` the hook says nothing and Claude decides. A call in any other form than the two above is denied. |
| Uninstall guard | Two hooks in your own `~/.claude/settings.json` (SessionStart and ConfigChange) run a copy of `hooks/restore.js` that puts everything back once the mod is disabled or uninstalled. See below. |

Each gateway entry also carries the tool timeout Claude would use: the server's own `timeout` (if 1000 ms or more), else `MCP_TOOL_TIMEOUT`, else 30 minutes. 30 minutes is how long Claude waits on a gateway call that sends no progress; `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` changes it, and `0` gives Claude's own default of about 28 hours. A local-scope server, or one from a plugin enabled only in a project, is served only in that project (`cwd_only` in its entry). A global server is not served in a project where Claude would not start it, because its plugin is disabled there or a local-scope or project `.mcp.json` server of the same name takes its place: its entry lists those projects in `cwd_except` (their real paths), written at each project's session start, and the project's own server is left on. Remote `http` servers use the proxy environment variables (`HTTPS_PROXY` and the like), as Claude does; loopback addresses stay direct.

Plugin skills, plugin commands and your skill overrides are shared by every project, so the mod changes them only while it is enabled at user scope. A mod enabled only in a project routes that project's MCP servers and the skills and commands of plugins enabled only there.

## What stays direct

| Server | Why |
|---|---|
| Listed in `direct_servers` | Your choice. |
| From a project's `.mcp.json` | The mod has no confirmed way to turn one of them off per project. |
| `sse` or `ws` transport | The gateway runs `stdio` and `http` servers only. |
| `http` server that signs in with OAuth | Claude holds and refreshes its tokens; the gateway cannot sign in. Recognized by its entry under `mcpOAuth` in `~/.claude/.credentials.json`, which Claude writes as soon as the server asks for sign-in (only the entry's name is read). If a routed server answers 401, the gateway's error says to add it to `direct_servers`. |
| Uses `headersHelper` | The helper runs inside Claude Code. |
| Needs a value the hook cannot fill | A `sensitive` plugin option that is not in Claude's file credential store (`~/.claude/.credentials.json`, `pluginSecrets`, used on Linux; a keychain on macOS is not read), or an env var that is not set and has no default. `/oh-my-context-mod` names the missing value, never the value itself. |
| The gateway itself | It never routes to itself, whatever form its command takes, nor to the upstream gateway it is derived from (see Credits). |

If `bin/oh-my-context` does not run (no Python 3.10+), the session-start hook puts everything back, because Claude would have no way to reach a routed server.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| MCP servers kept direct (`direct_servers`) | blank | Comma-separated servers that stay connected to Claude directly: a server name, a plugin name or `plugin:<plugin>:<server>`. Blank routes them all. Worth listing a server whose own hooks or skills tell Claude to call its tools by name, if Claude should skip the gateway step for it. |
| Skills kept fully listed (`direct_skills`) | blank | Comma-separated skills that keep their full description: a skill name, `<plugin>:<skill>`, or a plugin name for its whole skill set (its commands too). Blank routes them all. |

`/oh-my-context-mod` (or `/oh-my-context-mod status`, run from the project root) lists every server it found and what happens to each: `forwarded`, `forward*` (from the next session start in this project) or `direct` with the reason. `/oh-my-context-mod off` puts everything back and keeps it off until `/oh-my-context-mod on`. The switch is a file named `off` in the plugin's data folder, which Claude Code deletes on uninstall, so a reinstall starts on. While it is off, each session start says so in one line and retries anything a failed restore left behind.

## Install

```
/plugin install oh-my-context-mod --marketplace prv-ctech/claude-code-linux
```

Enabling the mod is all it takes. The first session start sets everything up. Claude Code reads MCP and skill config at launch, so what a start changes counts from the next session. Each project gets its server switches at its first session there.

### Coming from mcptoon-mod 0.1.0

This mod was published as `mcptoon-mod` up to 0.1.0. `mcptoon-mod` stays in the marketplace as 0.1.1, a restore-only stub (`mods/mcptoon-mod`): an update to it puts back 0.1.0's changes at the next session start, with 0.1.0's own restore, and says to install `oh-my-context-mod` and uninstall `mcptoon-mod`. It has no MCP server and no gateway. Install `oh-my-context-mod`, disable or uninstall the old one (`/plugin disable mcptoon-mod@claude-code-linux`) and start a new session:

- While `mcptoon-mod` is installed for this project and not disabled (an installed plugin with no `enabledPlugins` entry counts as enabled), `oh-my-context-mod` applies nothing, puts back anything it had set up, and its session-start line says to disable `mcptoon-mod`: both would route the same servers and skills.
- Once it is disabled, the next session start undoes 0.1.0's setup exactly as 0.1.0's own `off` did (its entries in `~/.mcptoon/config.json`, its `disabledMcpServers` entries, the `disable-model-invocation` lines in plugin skills, its `user-invocable-only` overrides), renames its `<plugins>/data/mcptoon-mod-claude-code-linux/state.json` to `state.v1-migrated.json`, carries an `off` switch over, then applies. A step that fails is retried at the next start.
- Uninstall `mcptoon-mod` after that. Uninstalling 0.1.0 first deletes its data folder, and with it the record of what it changed; 0.1.1 has already put those changes back by then.

## Disable or uninstall

Claude Code has no disable or uninstall event for plugins, so the mod installs a guard in your own `~/.claude/settings.json`:

```json
"SessionStart": [{ "hooks": [{ "type": "command", "command": "node '/home/you/.claude/oh-my-context-mod/guard.js' guard", "timeout": 60 }] }],
"ConfigChange": [{ "matcher": "user_settings|project_settings|local_settings", "hooks": [ ...the same hook... ] }]
```

The guard checks, in this order:

1. The mod is no longer in `installed_plugins.json`: everything goes back.
2. The mod is on for the session's project (its `.claude/settings.local.json`, then `.claude/settings.json`, then your user `enabledPlugins`): nothing happens.
3. The mod is set to `false` in your user `enabledPlugins`: everything goes back, unless a project the mod ran in still turns it on in its own settings.
4. The mod is off in this project only: that project's MCP server switches go back, and so do the files it patched for plugins enabled only in that project. Global plugin skills and commands and your skill overrides stay, since other projects still use them; they stay listed by name and still run.

After a full restore where every step went through, it removes its own two hooks and deletes `~/.claude/oh-my-context-mod`; a step that failed is retried the next time. That happens on the settings change or, at the latest, at the next session start.

The guard does not run when hooks are off (`disableAllHooks`) or the folder is not trusted. Then:

1. Before you disable or uninstall, run `/oh-my-context-mod off`, or
2. Afterwards, run the guard yourself: `node ~/.claude/oh-my-context-mod/guard.js guard </dev/null`, or
3. By hand, using `~/.claude/oh-my-context-mod/state.json`: remove the keys listed under `projects` from each project's `disabledMcpServers` in `~/.claude.json`; remove the `skillOverrides` listed under `overrides` and the two guard hooks from `~/.claude/settings.json`; copy each `originals/<origSha>.md` back over the `path` in `files` (or reinstall those plugins); then delete `~/.claude/oh-my-context-mod`.

With `CLAUDE_CONFIG_DIR` set, `~/.claude` above is that folder (and `.claude.json` sits inside it).

## Safety

- **Only what it added.** Every change is written to `~/.claude/oh-my-context-mod/state.json` before it is made, and putting back removes only that. Your own `disabledMcpServers` entries, skill overrides and hooks are left alone. A config file that does not parse is never rewritten. Files are written to a temp file and renamed, and one session at a time changes the setup (a lock in the state folder).
- **Files of other plugins.** It edits plugin `SKILL.md` and command files in `~/.claude/plugins/cache`. The original is saved in `~/.claude/oh-my-context-mod/originals/` first, and is written back only while the file still holds exactly the mod's version; a file changed since (a plugin update or a hand edit) stays as it is. Frontmatter it does not understand is left alone. A plugin update replaces its cache folder; the next session start routes the new files.
- **Secrets.** The gateway config holds the env and headers of the servers it runs, which can include tokens, plus any `sensitive` plugin option read from Claude's file credential store so that server can be routed (for example authentik-mod's token). Put a server in `direct_servers` to keep its token out of the gateway config. It lives in the plugin's data folder, `$CLAUDE_PLUGIN_DATA/home/config.json`, which Claude Code deletes on uninstall, and is created with mode `0600`, as are its `.bak` backups. When Claude does not set `CLAUDE_PLUGIN_DATA` (the Bash tool, `/oh-my-context-mod`), `bin/oh-my-context` and the hooks use the path Claude would: `~/.claude/plugins/data/oh-my-context-mod-claude-code-linux`, or `$CLAUDE_CODE_PLUGIN_CACHE_DIR/data/oh-my-context-mod-claude-code-linux` when that is set. `state.json` and the saved originals are `0600` too. From Claude's file credential store (`~/.claude/.credentials.json`) the mod reads two things: the `pluginSecrets` values of `sensitive` plugin options, to route the servers that need them, and the key names under `mcpOAuth`, to keep OAuth servers direct. It never reads OAuth tokens.
- **No network of its own.** No pip, no venv, no update check, no download. The gateway connects only to the servers it routes; `kb_index` indexes local files only, tokens are estimated without tiktoken (which downloads its encoding), and `oh-my-context hint` reads local files only.
- **Only the plugin's commands.** The vendored gateway keeps the four commands the plugin runs: `serve` (`.mcp.json`), `--version`, `skills index <dir>` (`hooks/sync.js`) and `hint` (`hooks/prompt.js`). Upstream's other commands, including every one that wrote agent configs, shell rc files, autostart entries, skill folders or the gateway config, downloaded something or left a process behind, are removed with their code; any other command line prints a usage line and exits 2. It never reads a project's `./.oh-my-context.json` or `.oh-my-context.toml`, so a cloned repo cannot make it run a command. The servers it starts get the environment Claude gave the gateway, without the launcher's own Python variables.
- **Permissions.** The gateway's own block on destructive tools is skipped for a `call` that resolved to an exact route, because `hooks/permit.js` applies your rules to it instead; a direct call under `{"exposure": "full"}` in `settings.json` (which also lists every routed tool) keeps the block. `hooks/permit.js` denies, and the gateway refuses, a call in any form other than the two it maps back to an original tool name, so no routed call runs without your rules being checked. Rules passed with `--settings` or `--disallowedTools` are not visible to the hook; Claude still applies them to `call` itself.

## Credits and licenses

- The gateway, oh-my-context, is derived from [mcptoon](https://github.com/activeing123/mcptoon) 0.8.33 by activeing123, Apache License 2.0. It ships in `vendor/oh_my_context` with mcptoon's license in `vendor/LICENSE` and its NOTICE, kept verbatim, in `vendor/NOTICE`, which also lists what we changed (renames and removed modules and commands included). Each changed file has a "Modified by oh-my-context-mod" header and each functional change an `oh-my-context-mod:` comment; upstream copyright lines stay. `vendor/oh_my_context/hint.py` is ours, under the same license.
- Everything outside `vendor/` (`hooks/`, `bin/`, `commands/`, `test/`) is the mod's own code, MIT License: `LICENSE`.

## Tests

Offline, against temp folders; run in CI by `.github/workflows/oh-my-context-mod.yml`:

```bash
node --test mods/oh-my-context-mod/test/*.test.js
PYTHONPATH=mods/oh-my-context-mod/vendor python3 -m unittest discover -s mods/oh-my-context-mod/test -p 'test_*.py'
```
