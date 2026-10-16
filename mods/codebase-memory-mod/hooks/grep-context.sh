#!/bin/sh
# PreToolUse for Grep and Glob: add a pointer to the graph tools when the project is indexed.
# JSON context only, no permissionDecision, so the tool call proceeds as normal. Silent when
# there is no index.
project="${CLAUDE_PROJECT_DIR:-$(pwd)}"
[ -f "${project}/.codebase-memory/graph.db.zst" ] || exit 0
printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"This project has a codebase-memory index. For symbol lookups, callers and call paths, search_graph and trace_path answer with fewer tokens than grep. Grep stays right for literal text."}}'
exit 0
