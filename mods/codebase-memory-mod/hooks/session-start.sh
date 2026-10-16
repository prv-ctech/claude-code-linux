#!/bin/sh
# SessionStart: say whether the project has a codebase-memory index. Plain stdout is
# added to context for SessionStart. Context only: never blocks, always exits 0.
project="${CLAUDE_PROJECT_DIR:-$(pwd)}"
if [ -f "${project}/.codebase-memory/graph.db.zst" ]; then
	echo "codebase-memory: ${project} has an index at .codebase-memory/graph.db.zst. Use the codebase-memory tools for symbols, callers and call paths. index_status shows whether it is fresh."
else
	echo "codebase-memory: ${project} has no index. index_repository with repo_path=${project} and persistence=true builds one and writes .codebase-memory/."
fi
exit 0
