#!/usr/bin/env node
// oh-my-context-mod: the code graph (codebase-memory-mcp, run behind the gateway). Argument: gate.
//
// gate is the PreToolUse hook on Grep, Glob and Bash: while a workspace has its graph, code search with
// Grep, Glob or a shell grep/rg/find is denied, and the reason names the graph tools to use. Anything
// it cannot read passes through: a hook error must never block the agent.
// sync.js and prompt.js use line() and startIndex() for the session start and subagent context.
//
// All of it is off unless the mod runs the graph server itself (state.json `graph`, set by sync.js):
// with the older codebase-memory-mod still enabled, that plugin's own hooks do this work.
//
// Escape hatch for the person, not the model: create the file gate-off under the cache dir
// (~/.cache/codebase-memory-mcp/gate-off) to lift the gate on this machine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { paths, readText, sha } = require('./restore.js');

// The names the tools had when codebase-memory-mod ran the server; kept so permission rules still match.
const PREFIX = 'mcp__plugin_codebase-memory-mod_codebase-memory-mcp';
const VIA = `the oh-my-context \`call\` tool (tool: ${PREFIX}__<name>)`;

const REASON = [
  'Code search is blocked here: this workspace has a codebase-memory graph (.codebase-memory/graph.db.zst).',
  `Use the codebase-memory tools instead, through ${VIA}:`,
  'search_graph for a symbol by name; trace_path for callers and callees; get_code_snippet for a symbol\'s source;',
  'get_file_outline for one file; search_code for literal text (file_pattern matches file names only; use path_filter, a regex, for a folder or path); query_graph for multi-hop questions.',
  'Read opens a file whose path is already known, and grep on named files (grep -n x src/a.js) is allowed.',
  'Without MCP tools, the same tools run in Bash: codebase-memory-mcp cli <tool> \'<json arguments>\'.',
  'If a codebase-memory tool returns an error, report that error to the user and stop; do not retry the search with grep.',
].join(' ');

// grep, rg, ag, ack, find or git grep as a command, after the start of a line, ; & ( ` or $(.
// A pipe into grep (git log | grep fix) stays allowed: that filters output, it is not code search.
const CODE_SEARCH = /(^|[;&(`]|\$\()[\s;&(`]*(grep|egrep|fgrep|rg|ag|ack|find|git\s+grep)(\s|$)/;

const cacheDir = (home = os.homedir()) => path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'codebase-memory-mcp');
const own = dir => fs.existsSync(path.join(dir, '.codebase-memory', 'graph.db.zst'));

// The git checkout `dir` sits in: { top, main } (main: the main checkout of a worktree), or {} outside git.
function checkout(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { encoding: 'utf8', timeout: 3000 });
  const [top, common] = r.status === 0 ? r.stdout.trim().split('\n') : [];
  return top && common ? { top, main: path.dirname(common) } : {};
}

// The folder whose graph serves `dir`: its own, its checkout root's (a session opened in a subfolder),
// else, for a git worktree (.codebase-memory/ is untracked, so a new worktree has none), the main
// checkout's. '' when none is indexed.
function graphDir(dir) {
  if (own(dir)) return path.resolve(dir);
  const { top, main } = checkout(dir);
  return [top, main].find(d => d && own(d)) || '';
}
const indexed = dir => !!graphDir(dir);

// The project a hook call belongs to. Claude Code gives hooks the project root; `cwd` moves with a
// `cd` in the shell, which must not switch the gate off or change which card a subagent gets.
const projectDir = (payload, env = process.env) => env.CLAUDE_PROJECT_DIR || (payload && payload.cwd) || process.cwd();

// The card sync.js saved for one project (what it has used comes first, so it is not shared).
const cardFile = (p, dir) => path.join(p.state, 'cards', `${sha(path.resolve(dir)).slice(0, 16)}.txt`);

const isFile = f => {
  try {
    return fs.statSync(f).isFile();
  } catch (e) {
    return false;
  }
};

// Whether this mod runs the graph server (and is not switched off).
function graphOn(p = paths()) {
  if (p.pluginData && fs.existsSync(path.join(p.pluginData, 'off'))) return false;
  try {
    return JSON.parse(readText(path.join(p.state, 'state.json')) || '{}').graph === true;
  } catch (e) {
    return false;
  }
}

function inside(dir, target) {
  const abs = path.resolve(dir, target);
  return abs === dir || abs.startsWith(dir + path.sep);
}

// The search commands a shell line really runs on this workspace: [] when there are none.
// Text inside quotes and here-documents is not a command (a script that prints "grep", a commit
// message), and a search whose paths all lie outside the workspace (~/.claude, /var/log) is not a
// search of this code.
// shortcut: not a shell parser; `bash -c "grep ..."` and `eval` pass. The gate steers the model, it is
// no security boundary. Upgrade to a real word splitter if the model starts hiding searches in quotes.
function codeSearches(command, root, home = os.homedir(), cwd = root) {
  const held = [];
  const hold = text => `\u0000${held.push(text) - 1}\u0000`;
  const bare = String(command)
    .replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2(?=\n|$)/g, m => hold(m))
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, m => hold(m.slice(1, -1)));
  const found = [];
  const unhold = w => w.replace(/\u0000(\d+)\u0000/g, (_, i) => held[i]);
  // A variable set in the same call (D=/abs/dir; grep x $D/a.py) stands for its value.
  const vars = {};
  for (const a of bare.matchAll(/(?:^|[;&|\n(\s])([A-Za-z_]\w*)=(\S+)/g)) vars[a[1]] = unhold(a[2].replace(/[;&|)]+$/, ''));
  const expand = w => w.replace(/^\$(?:\{(\w+)\}|(\w+))/, (all, a, b) => (vars[a || b] !== undefined ? vars[a || b] : all));
  const start = cwd;
  // m: a command on a later line of the same call starts a line too.
  const re = new RegExp(CODE_SEARCH.source, 'gm');
  for (let m; (m = re.exec(bare));) {
    // A `cd` earlier in the same call moves the search: relative paths are read from there.
    cwd = start;
    for (const c of bare.slice(0, m.index).matchAll(/(?:^|[;&|\n(]\s*)cd\s+(\S+)/g)) {
      cwd = path.resolve(cwd, expand(unhold(c[1])).replace(/^(~|\$HOME)(?=\/|$)/, home));
    }
    const rest = bare.slice(m.index + m[0].length).split(/[;&|\n)]/)[0];
    const words = rest.split(/\s+/).filter(Boolean).map(unhold).map(expand);
    // A path is an absolute or home word, or a relative word that exists (src, ., ../logs). A relative
    // word that names nothing is the pattern; one that happens to name a file counts as a path, which
    // errs toward the gate.
    // grep, rg, ag and ack take the pattern as their first plain word: `grep -c . /etc/hostname` searches
    // /etc/hostname for ".", not the folder. find takes only paths before its first option.
    const plain = words.filter(w => !w.startsWith('-'));
    const paths = (/^find$/.test(m[2]) ? plain : plain.slice(1)).map(w => (/^(\/|~\/|~$|\$HOME\b)/.test(w)
      ? w.replace(/^(~|\$HOME)/, home)
      : fs.existsSync(path.resolve(cwd, w)) ? path.resolve(cwd, w) : null)).filter(Boolean);
    // No path at all: grep reads stdin or, with -r, the folder; find searches the folder. Both stay gated.
    if (paths.length && paths.every(p => !inside(root, p))) continue;
    // Named files only: that reads those files, as Read would, and costs less. It is not discovery.
    if (paths.length && paths.every(isFile)) continue;
    // No path, in a shell that has left the project: the search is somewhere else.
    if (!paths.length && !inside(root, cwd)) continue;
    found.push(m[2]);
  }
  return found;
}

function decide(payload, home = os.homedir(), env = process.env) {
  const cwd = path.resolve(payload.cwd || process.cwd());
  const proj = path.resolve(projectDir(payload, env));
  if (!indexed(proj)) return null;
  // The whole checkout is the graph's code, also when the session opened in a subfolder.
  const root = checkout(proj).top || proj;
  if (fs.existsSync(path.join(cacheDir(home), 'gate-off'))) return null;

  const input = payload.tool_input || {};
  if (payload.tool_name === 'Grep' || payload.tool_name === 'Glob') {
    const target = path.resolve(cwd, String(input.path || '.'));
    if (!inside(root, target)) return null;
    if (payload.tool_name === 'Grep' && isFile(target)) return null; // one named file: a read
    return REASON;
  }
  if (payload.tool_name === 'Bash' && codeSearches(input.command || '', root, home, cwd).length) return REASON;
  return null;
}

function isGitRoot(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 3000 });
  return r.status === 0 && path.resolve(r.stdout.trim()) === path.resolve(dir);
}

// Starts the first index of a git workspace in the background. The hook returns at once; the
// index lands in .codebase-memory/ when the build finishes. The lock keeps two sessions from
// building the same workspace twice.
function startIndex(cwd) {
  if (cwd === os.homedir() || !isGitRoot(cwd)) return false;
  const lockDir = path.join(cacheDir(), 'indexing');
  const lock = path.join(lockDir, cwd.replace(/[^A-Za-z0-9]+/g, '-'));
  try {
    fs.mkdirSync(lockDir, { recursive: true });
    if (Date.now() - fs.statSync(lock).mtimeMs < 30 * 60 * 1000) return true;
  } catch (e) {
    /* no lock yet */
  }
  fs.writeFileSync(lock, String(process.pid));
  const log = fs.openSync(path.join(cacheDir(), 'index.log'), 'a');
  const bin = path.join(__dirname, '..', 'bin', 'codebase-memory-mcp');
  const args = ['cli', '--quiet', 'index_repository', JSON.stringify({ repo_path: cwd, persistence: true })];
  spawn(bin, args, { detached: true, stdio: ['ignore', log, log] }).unref();
  return true;
}

// The graph's project name, as the indexer wrote it next to the graph; '' when absent or not a plain name.
function projectName(cwd) {
  try {
    const name = JSON.parse(fs.readFileSync(path.join(cwd, '.codebase-memory', 'artifact.json'), 'utf8')).project;
    return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name) ? name : '';
  } catch { return ''; }
}

// What a new context is told about the graph in `cwd`, or '' when there is nothing to act on.
function line(cwd, started = false) {
  const gdir = graphDir(cwd);
  const top = checkout(cwd).top || path.resolve(cwd);
  if (!gdir) {
    return started ? 'Code graph: no index for this workspace yet. A first index was started in the background; it appears at .codebase-memory/graph.db.zst when done.' : '';
  }
  return `Code graph: this workspace is indexed (.codebase-memory/graph.db.zst). Code discovery goes through ${VIA}: `
    + 'search_graph (symbol by name; resolve exact names here first), trace_path (callers, callees), get_code_snippet (source of a symbol), '
    + 'get_file_outline, search_code (literal text; file_pattern matches file names only, like *.js, so narrow to a folder or path with path_filter, a regex), query_graph (multi-hop), get_architecture, detect_changes; '
    + (projectName(gdir) ? `\`project\` here is ${projectName(gdir)} (list_projects for others). ` : '`project` comes from list_projects. ')
    + (gdir !== path.resolve(cwd) && gdir !== top ? `This is a git worktree without its own index yet: the graph above is the main checkout's (${gdir}), so this branch's own edits are missing from it until index_repository runs on ${top}. ` : '')
    + 'Grep, Glob and shell grep, rg or find on code are blocked by a hook; Read opens a path already known. '
    + 'An agent without that `call` tool runs the same tools in Bash: codebase-memory-mcp cli <name> \'<json arguments>\'. '
    + 'Before deleting, renaming or changing the signature of a function: trace_path inbound and search_code for its name (the graph can miss dynamic callers). '
    + 'Before a claim that nothing uses a symbol, run check_index_coverage. A tool error is reported to the user, not worked around with grep. '
    + 'After a large pull, branch switch or rebase: index_repository (repo_path absolute, persistence: true). .codebase-memory/ is not committed unless asked.';
}

function main() {
  if (process.argv[2] !== 'gate') return;
  let payload = {};
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch (e) {
    return;
  }
  if (!graphOn()) return;
  const reason = decide(payload);
  if (!reason) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    /* never block a tool call over the gate */
  }
}

module.exports = { decide, graphDir, CODE_SEARCH, codeSearches, projectDir, cardFile, graphOn, startIndex, line, PREFIX };
