# 002: oh-my-agent works with codebase-memory-mod's code-search gate

**Status:** ready

## Summary
When codebase-memory-mod is enabled and the project has a `.codebase-memory/` graph, oh-my-agent (`/oma`) detects it, tells its own agents to search code with the graph tools instead of Grep, Glob and shell grep, never runs a command the gate would block, and applies its `.env` protection to the codebase-memory tools too. When the plugin is off or the folder has no graph, oma agents keep using Grep, Glob and grep as usual.

## Why
codebase-memory-mod's PreToolUse gate (`mods/codebase-memory-mod/hooks/gate.js`) denies Grep, Glob and shell `grep/rg/ag/ack/find/git grep` in any folder that holds `.codebase-memory/graph.db.zst`. oma's agents were written for a world where those always work:
- the merger's conflict-marker check is a shell `grep -rn ...` (`agents/merger.md` step 5), which the gate denies in the main checkout, where the merger runs;
- oma's guard (`scripts/guard.mjs`) keeps oma agents away from `.env` files for Bash, Read, Edit, Write and Grep, but an agent that moves to the graph tools (as the gate tells it to) can read env files through `search_code` or `get_file_outline` with no check at all;
- nothing tells an oma agent which mode it is in. Workers and the reproducer run in `.claude/worktrees/<name>`, which never has a graph (it is gitignored), so there Grep works and the graph describes the main checkout, not the worker's branch. The ticket-writer, merger, checker, inspector and teammates run in the main checkout, where Grep is blocked.

When a detail isn't covered here, favour: oma never fights the gate (it follows it when active and stays out of the way when not), and an agent always knows which code-search tools work where it is.

## User stories
- As a user with codebase-memory-mod on, I want `/oma` runs to finish without agents tripping over blocked Grep or grep calls, so that tickets merge without me stepping in.
- As a user, I want oma's "never read .env" rule to hold whichever search tool an agent uses.
- As a user without a graph in a project, I want oma agents to keep using Grep and grep normally.

## Functional requirements
- **FR-1**: `scripts/oma.mjs` must export `codeGraph(dir, { env = process.env, home = os.homedir() } = {})` returning `{ active, project, reason }`:
  - `reason` is `"plugin not enabled"` when codebase-memory-mod is not enabled (see FR-2), else `"no graph"` when `<dir>/.codebase-memory/graph.db.zst` does not exist, else `"gate off"` when the gate's escape file `<XDG_CACHE_HOME or home/.cache>/codebase-memory-mcp/gate-off` exists, else `"on"`.
  - `active` is `true` only when `reason` is `"on"`.
  - `project` is the codebase-memory project name when `active`, else `null`. The name is the absolute path of `dir` with every `/` replaced by `-` and leading `-` removed (`/workspaces/claude-code-linux` gives `workspaces-claude-code-linux`).
  - `dir` is used as given (resolved to an absolute path), exactly as the gate uses the session `cwd`; no walk up to the git root.
- **FR-2**: codebase-memory-mod counts as enabled when the last of these files that has an `enabledPlugins` key starting with `codebase-memory-mod@` sets it to `true`, read in this order: `<CLAUDE_CONFIG_DIR or home/.claude>/settings.json`, `<dir>/.claude/settings.json`, `<dir>/.claude/settings.local.json`. A missing or unparsable file is skipped.
- **FR-3**: `oma.mjs status` and `oma.mjs start` must add a `codeGraph` key to their JSON, holding `codeGraph(dir)` for the `--dir` they were given (or `CLAUDE_PROJECT_DIR`, or the cwd, as today).
- **FR-4**: A new hook mode `node scripts/oma.mjs subagent`, registered in `hooks/hooks.json` under `SubagentStart` with matcher `*`, must print, for an input whose `agent_type` starts with `oh-my-agent-mod:`:
  - when `codeGraph(cwd)` is active, one JSON object `{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":<text>}}` where text is exactly:
    `oh-my-agent code search: codebase-memory-mod is on and <cwd> has a graph, so Grep, Glob and shell grep/rg/ag/ack/find/git grep on code are blocked here. Use the codebase-memory tools (load them with ToolSearch: mcp__plugin_codebase-memory-mod_codebase-memory-mcp__search_graph, search_code, get_code_snippet, trace_path, get_file_outline) with project "<project>". Piping command output into grep stays allowed. A worktree under .claude/worktrees/ has no graph of its own: there Grep, Glob and grep work as usual, and the graph shows <cwd>, not your branch.`
  - when the reason is `"no graph"` or `"gate off"`, the same JSON shape with text exactly:
    `oh-my-agent code search: codebase-memory-mod is on but no graph applies in <cwd> (<reason>), so Grep, Glob and grep work as usual here.`
  - when the reason is `"plugin not enabled"`, nothing.
  `<cwd>` is the input's `cwd` (absolute), `<project>` and `<reason>` come from FR-1.
- **FR-5**: The `subagent` hook must print nothing for any `agent_type` that does not start with `oh-my-agent-mod:` (including a missing one), and nothing (exit 0) on unparsable input or any error.
- **FR-6**: `scripts/guard.mjs` `decide()` must deny, for oma agents only, a codebase-memory tool call (`tool_name` starting with `mcp__plugin_codebase-memory-mod_codebase-memory-mcp__`) whose `tool_input.file_pattern`, `tool_input.path_filter` or `tool_input.file_path` targets an env file: the value is an env file name by the existing `isEnvName`, or is a pattern containing `.env` right after the start, `/`, `*`, `{` or `,` that is not one of the allowed `.env.example|sample|template|dist|defaults` names. The reason text is `oh-my-agent agents never read .env files.` `hooks/hooks.json` must add `mcp__plugin_codebase-memory-mod_codebase-memory-mcp__.*` to the guard's PreToolUse matcher.
  Expected results (oma agent `oh-my-agent-mod:worker`):

  | tool (suffix after the prefix) | tool_input | result |
  |---|---|---|
  | search_code | `{"project":"p","pattern":"KEY","file_pattern":".env*"}` | deny |
  | search_code | `{"project":"p","pattern":"KEY","path_filter":"config/.env"}` | deny |
  | search_code | `{"project":"p","pattern":"KEY","file_pattern":"*.env"}` | deny |
  | get_file_outline | `{"project":"p","file_path":"deploy/.env.production"}` | deny |
  | search_code | `{"project":"p","pattern":"KEY","file_pattern":"*.ts"}` | allow (null) |
  | search_code | `{"project":"p","pattern":"KEY","file_pattern":".env.example"}` | allow (null) |
  | search_graph | `{"project":"p","name_pattern":"env"}` | allow (null) |
  | get_file_outline | `{"project":"p","file_path":"src/environment.ts"}` | allow (null) |
  The same calls from a non-oma `agent_type` (or none) are always allowed.
- **FR-7**: oma's guard must never deny Grep, Glob or a shell grep/rg/find for any reason other than the existing `.env` and `git push` rules, with or without a graph in the folder (oma leaves code-search blocking to codebase-memory-mod).
- **FR-8**: `agents/merger.md` step 5 must check for leftover conflict markers with `git diff --check -- <files>` (non-zero exit or any `leftover conflict marker` line means markers remain) instead of `grep -rn ...`.
- **FR-9**: No inline code span or fenced code line in `agents/*.md`, `router.md` or `commands/oma.md` that holds a command with arguments (contains whitespace) may match what codebase-memory-mod's gate treats as code search (its exported `CODE_SEARCH` regex from `mods/codebase-memory-mod/hooks/gate.js`). Bare tool names such as the browser's `find` tool are not commands. Today the only hit is the merger line FR-8 replaces.
- **FR-10**: `README.md` of oh-my-agent-mod must gain a short "With codebase-memory-mod" section (3 to 6 lines) saying: oma detects the plugin plus a `.codebase-memory/` graph, tells its agents to use the graph tools there, applies its `.env` rule to the graph tools, and leaves Grep/Glob/grep alone where there is no graph (agent worktrees never have one).
- **FR-11**: `version` in `mods/oh-my-agent-mod/.claude-plugin/plugin.json` goes from `0.2.0` to `0.3.0`.

## Non-functional requirements
- **NFR-1**: The `subagent` hook finishes within its 5 second timeout; it reads at most three settings files and does two `existsSync` checks (no git calls, no network).
- **NFR-2**: Hooks keep stdout to the hook protocol: any error prints nothing on stdout and exits 0 (profile pattern).
- **NFR-3**: New tests run offline against temp homes and temp folders (`fs.mkdtempSync`), never the real `~/.claude` or `~/.cache`.

## Edge cases & error handling
- Settings file with invalid JSON: skipped, next file decides; if none decides, the plugin counts as not enabled.
- `enabledPlugins` has `codebase-memory-mod@claude-code-linux: false` in `.claude/settings.local.json` but `true` in the user settings: not enabled (local wins).
- Key under another marketplace (`codebase-memory-mod@other-market: true`): counts (any key starting `codebase-memory-mod@`).
- `.codebase-memory/` exists but holds no `graph.db.zst`: `"no graph"`.
- Input with no `cwd`: use `process.cwd()`.
- `tool_input` missing or a field that is not a string: no deny from FR-6.

## Out of scope
- Any change to `mods/codebase-memory-mod/` (its gate, context hook or AGENTS.md).
- Building or refreshing a graph for agent worktrees, or pointing workers at a per-worktree graph.
- Routing calls through the oh-my-context gateway (`mcp__plugin_oh-my-context-mod_oh-my-context__call`) in the guard.
- Telling the router (the user's own session) anything new; it never searches code.
- Changing what the gate blocks.

## Affected areas
- `mods/oh-my-agent-mod/scripts/oma.mjs`: `codeGraph()`, `codeGraph` key in `projectState()`, new `subagent` mode in `main()` and its usage line.
- `mods/oh-my-agent-mod/scripts/guard.mjs`: FR-6 in `decide()`.
- `mods/oh-my-agent-mod/hooks/hooks.json`: `SubagentStart` entry, guard matcher.
- `mods/oh-my-agent-mod/agents/merger.md`: step 5 marker check.
- `mods/oh-my-agent-mod/README.md`: new section.
- `mods/oh-my-agent-mod/.claude-plugin/plugin.json`: version.
- `mods/oh-my-agent-mod/test/codegraph.test.mjs` (new) and `mods/oh-my-agent-mod/test/scripts.test.mjs` (guard cases).

## Do not touch
- `mods/codebase-memory-mod/`: read-only reference.
- `mods/caveman-mod/`: ticket 003 owns it.
- `.oma/`, `specs/` (except this ticket's own results and evidence).

## Dependencies
- None. The test command in `.oma/project.md` already runs `mods/oh-my-agent-mod/test/*.test.mjs`, so a new test file there is picked up.

## Decisions made
- **Agreed with the user**: oma follows codebase-memory's rules only when the plugin is enabled AND the folder has a `.codebase-memory` graph; otherwise native Grep/Glob/grep stay allowed (router notes).
- **Decided by the ticket writer**:
  - Detection mirrors the gate exactly (same file, same escape file, folder as given) so oma and the gate never disagree.
  - The hint reaches oma agents through a SubagentStart hook (one line), not by editing every agent file; the line also covers worktrees because the SubagentStart `cwd` may be the main checkout even for worktree agents.
  - Nothing is injected when codebase-memory-mod is not enabled, to keep context lean.
  - The `.env` rule is extended to the graph tools' `file_pattern`, `path_filter` and `file_path` fields; other graph tools (search_graph, trace_path, query_graph) are left alone.
  - The merger uses `git diff --check` for conflict markers (tested: exit 2 with `leftover conflict marker` lines when markers remain, exit 0 once resolved).
  - Version bump to 0.3.0 (new behaviour).
