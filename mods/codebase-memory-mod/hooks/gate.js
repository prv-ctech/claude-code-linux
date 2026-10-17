#!/usr/bin/env node
// PreToolUse gate for codebase-memory-mod. While a workspace has its graph, code search with
// Grep, Glob or a shell grep/rg/find is denied, and the reason names the graph tools to use.
// Anything it cannot read passes through: a hook error must never block the agent.
//
// Escape hatch for the person, not the model: create the file gate-off under the cache dir
// (~/.cache/codebase-memory-mcp/gate-off) to lift the gate on this machine.
const fs = require('fs');
const os = require('os');
const path = require('path');

const REASON = [
  'Code search is blocked here: this workspace has a codebase-memory graph (.codebase-memory/graph.db.zst).',
  'Use the codebase-memory tools instead. Load them with ToolSearch, then:',
  'search_graph for a symbol by name; trace_path for callers and callees; get_code_snippet for a symbol\'s source;',
  'get_file_outline for one file; search_code for literal text; query_graph for multi-hop questions.',
  'Read opens a file whose path is already known.',
  'If a codebase-memory tool returns an error, report that error to the user and stop; do not retry the search with grep.',
].join(' ');

// grep, rg, ag, ack, find or git grep as a command, after the start of a line, ; & ( ` or $(.
// A pipe into grep (git log | grep fix) stays allowed: that filters output, it is not code search.
const CODE_SEARCH = /(^|[;&(`]|\$\()[\s;&(`]*(grep|egrep|fgrep|rg|ag|ack|find|git\s+grep)(\s|$)/;

function inside(dir, target) {
  const abs = path.resolve(dir, target);
  return abs === dir || abs.startsWith(dir + path.sep);
}

function decide(payload, home = os.homedir()) {
  const cwd = path.resolve(payload.cwd || process.cwd());
  if (!fs.existsSync(path.join(cwd, '.codebase-memory', 'graph.db.zst'))) return null;
  const escape = path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'codebase-memory-mcp', 'gate-off');
  if (fs.existsSync(escape)) return null;

  const input = payload.tool_input || {};
  if (payload.tool_name === 'Grep' || payload.tool_name === 'Glob') {
    if (input.path && !inside(cwd, String(input.path))) return null;
    return REASON;
  }
  if (payload.tool_name === 'Bash' && CODE_SEARCH.test(String(input.command || ''))) return REASON;
  return null;
}

function main() {
  let payload = {};
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch (e) {
    return;
  }
  const reason = decide(payload);
  if (!reason) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
}

if (require.main === module) main();

module.exports = { decide, CODE_SEARCH };
