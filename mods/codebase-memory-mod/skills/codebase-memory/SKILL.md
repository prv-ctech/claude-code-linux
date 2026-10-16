---
name: codebase-memory
description: Use the codebase-memory code graph for structural questions: where a symbol is defined or used, who calls a function, what a function calls, call chains, impact of a change, dead code, architecture. Triggers on: who calls X, what does X call, trace the call chain, find callers, show dependencies, impact analysis, dead code, unused functions, explore the codebase, understand the architecture, search the code graph.
---

# codebase-memory

The codebase-memory MCP server keeps a graph of the workspace: functions, classes, imports, routes and the edges between them. Graph answers are short and precise. Grep over a whole repo is not.

## Pick the tool

| Question | Call |
|---|---|
| Find a symbol by name | `search_graph(project, name_pattern=".*Name.*")` |
| Who calls X | `trace_path(function_name="X", direction="inbound")` |
| What X calls | `trace_path(function_name="X", direction="outbound")` |
| Full context around X | `trace_path(function_name="X", direction="both", depth=3)` |
| Source of a symbol | `get_code_snippet(qualified_name="<project>.<path>.<Name>")` |
| Outline of one file | `get_file_outline(file_path=...)` |
| Impact of local git changes | `detect_changes()` |
| Dead code | `search_graph(max_degree=0, exclude_entry_points=true)` |
| Multi-hop or Cypher | `query_graph` (add `LIMIT` for broad queries) |
| Module overview | `get_architecture(aspects=["all"])` |
| Literal text, comments, strings | `search_code` or Grep |

## Workflow

1. `list_projects`: find the project whose `root_path` is the working directory. Pass its `name` as `project`.
2. If the project is missing, or `index_status` says stale after a large pull or branch switch: `index_repository(repo_path=<absolute path>, persistence=true)`.
3. Discover the exact name with `search_graph`, then trace or snippet it.
4. Check cited files with `check_index_coverage` before claiming completeness.

## Rules

- Names for `trace_path` must be exact. Resolve them with `search_graph` first.
- `search_graph` returns 50 rows per page. Check `has_more` and page with `offset`.
- `trace_path` with `direction="outbound"` misses cross-service callers. Use `both` when that matters.
- Absence is not proof. For "nothing calls this", check coverage and grep the reported gaps.
- Use grep for literals and for files the graph does not cover.
