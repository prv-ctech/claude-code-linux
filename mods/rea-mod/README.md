# rea-mod

[REA](https://rea.tools) (npm `rea-agents`) for Claude Code, installed by the mod rather than the image.

| Part | What it does |
|---|---|
| `.mcp.json` | Registers the `rea` MCP server, run through `bin/rea mcp`. |
| `bin/rea` | On first use installs the pinned `rea-agents` with npm into the plugin data directory (`~/.claude/plugins/data/rea-mod-claude-code-linux`). Starts a background install of the analysis engines REA uses but never installs, each checked against a pinned SHA256: Temurin JDK 21, Ghidra 12.1.4, jadx-headless-mcp 0.7.1, Apktool 3.0.3. Once they are in place it sets `JAVA_HOME`, `GHIDRA_INSTALL_DIR`, `REA_JADX_MCP_JAR` and `REA_APKTOOL_COMMAND` for REA. |
| `commands/rea.md` | `/rea-mod:rea <task>` (type `/rea` and pick it) tells Claude to work on the task with REA's skill and MCP tools, for when the request does not say so. |
| `skills/reverse-engineer-anything` | REA's own skill, copied from the same `rea-agents` release. |

The first session installs REA in a few seconds; the engines (about 1 GB) arrive in the background. Restart the session once `tools.log` in the data directory says they are installed. The engines are the Linux x64 builds, the image's only platform.

## Updates

`.github/workflows/rea-mod.yml` runs `scripts/update-rea-mod.sh` every six hours. When npm's `rea-agents` `dist-tags.latest` moves, it changes `VERSION` in `bin/rea`, refreshes the skill from that release and bumps the plugin version. Claude Code installs that only with auto-update on for the marketplace, which is off by default for third-party marketplaces: turn it on once in `/plugin` → Marketplaces → `claude-code-linux` → Enable auto-update. The next start then installs the new `rea-agents`. The engine pins move by hand, when REA verifies a newer Ghidra or jadx.

Check: `CLAUDE_PLUGIN_DATA=... mods/rea-mod/bin/rea doctor --provider ghidra --json`

## Moving from the old in-image REA

Images before this mod installed `rea-agents` globally, and `rea setup` registered it in `~/.claude.json` as `/usr/local/bin/rea`, which newer images do not have. After installing this mod, remove the old registration, skill and engines from the home mount:

```bash
claude mcp remove rea -s user
rm -rf ~/.claude/skills/reverse-engineer-anything ~/tools
```

`~/tools` is where the old engines were placed by hand; check that nothing else of yours lives there first.
