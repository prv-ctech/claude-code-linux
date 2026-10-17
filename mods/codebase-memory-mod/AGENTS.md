# Codebase memory

This workspace uses the codebase-memory graph for code discovery. Once the workspace is indexed, the graph is stored in `.codebase-memory/graph.db.zst`.

## Tools

The tools are MCP tools named `mcp__plugin_codebase-memory-mod_codebase-memory-mcp__<tool>`. Their schemas are deferred: load the ones needed with one ToolSearch call (`select:` and the full names) before the first call.

| Question | Tool |
|---|---|
| Find a symbol by name | `search_graph` with `name_pattern` |
| Who calls X / what X calls | `trace_path` with `direction` inbound, outbound or both |
| Source of one symbol | `get_code_snippet` with the qualified name from `search_graph` |
| Outline of one file | `get_file_outline` |
| Literal text, strings, comments | `search_code` |
| Multi-hop questions | `query_graph` |
| Module overview | `get_architecture` |
| What uncommitted changes affect | `detect_changes` |
| Dead code | `search_graph` with `max_degree: 0` and `exclude_entry_points: true` |

## Rules

- Code discovery in this workspace starts with these tools, in the main chat and in every subagent. A hook blocks Grep, Glob, and grep, rg, ag, ack or find on code while the graph exists.
- Read opens a file whose path is already known. Use it once the graph has given the location.
- Resolve exact names with `search_graph` before `trace_path` or `get_code_snippet`.
- Before a claim that nothing uses a symbol, run `check_index_coverage` on the files relied on.
- If a codebase-memory tool returns an error, report the exact error to the user and stop that line of work. Do not fall back to grep.
- Rebuild the index with `index_repository` (`repo_path` set to the absolute workspace path, `persistence: true`) after a large pull, a branch switch or a rebase.
- `.codebase-memory/` is not committed unless the user asks.
