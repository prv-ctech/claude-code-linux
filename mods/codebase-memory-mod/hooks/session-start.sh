#!/bin/sh
# SessionStart: say whether the project has a codebase-memory index, then add the
# per-workspace instructions. Plain stdout is added to context. Context only: never blocks,
# always exits 0.
project="${CLAUDE_PROJECT_DIR:-$(pwd)}"
if [ -f "${project}/.codebase-memory/graph.db.zst" ]; then
	echo "codebase-memory: ${project} has an index at .codebase-memory/graph.db.zst. Use the codebase-memory tools for symbols, callers and call paths. index_status shows whether it is fresh."
else
	echo "codebase-memory: ${project} has no index. index_repository with repo_path=${project} and persistence=true builds one and writes .codebase-memory/."
fi
if [ -r "${CLAUDE_PLUGIN_ROOT}/AGENTS.md" ]; then
	cat "${CLAUDE_PLUGIN_ROOT}/AGENTS.md"
fi
exit 0
