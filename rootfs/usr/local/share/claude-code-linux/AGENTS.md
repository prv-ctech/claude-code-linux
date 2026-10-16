# Codebase memory

The `codebase-memory-mcp` MCP server gives you a code graph of the workspace you are in: symbols, callers, call paths and architecture. Use it before grep for navigation.

## Start of work in a workspace

The workspace is the directory the session started in, for example `/workspaces/my-project`. Once per workspace:

1. If `<workspace>/.codebase-memory/graph.db.zst` exists, the workspace is indexed. Go to step 3.
2. If it is missing, build the index: call `index_repository` with `repo_path` set to the absolute workspace path and `persistence: true`. This writes `.codebase-memory/` into the workspace. Tell the user it was built.
3. Find the project with `list_projects`. Match the entry whose `root_path` is the workspace path. Its `name` is the path with `/` replaced by `-`, for example `workspaces-my-project`. Match on `root_path`, not on name alone.
4. Query that project with `search_graph`, `trace_path`, `get_code_snippet` or `query_graph`.

## Rules

- Do not `git add` or commit `.codebase-memory/` unless the user asks.
- Re-run `index_repository` for the workspace after a large `git pull`, branch switch or rebase.
- Do not pass a custom `name`, and do not change the server's config, unless the user asks.
- If the server fails, say so and fall back to grep.
