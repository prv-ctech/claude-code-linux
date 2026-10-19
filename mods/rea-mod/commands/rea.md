---
description: Work on this task with REA's reverse-engineering pipeline and tools
argument-hint: <what to analyze or find out>
---

Use REA for this task: $ARGUMENTS

- Load the `reverse-engineer-anything` skill first and follow its workflow.
- The tools are MCP tools named `mcp__plugin_rea-mod_rea__<tool>`. Their schemas are deferred: load the ones needed with one ToolSearch call before the first call.
- Base claims on REA's Evidence (decompilation, inspection, captures), not on guesses about the target. Say what REA could not cover.
- If the REA server is missing or a tool reports an engine (Ghidra, jadx, Apktool, Java) as unavailable, say so with the exact error. The engines install in the background on first use; the log is `~/.claude/plugins/data/rea-mod-claude-code-linux/tools.log`.
