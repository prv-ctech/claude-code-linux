#!/usr/bin/env node
// Context hook for codebase-memory-mod. Argument: session, prompt or subagent.
// Prints one JSON object with hookSpecificOutput.additionalContext. Claude Code adds that text
// to the model's context for SessionStart, UserPromptSubmit and SubagentStart alike.
// Plain stdout is not used: SubagentStart ignores it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const EVENTS = { session: 'SessionStart', prompt: 'UserPromptSubmit', subagent: 'SubagentStart' };
const mode = process.argv[2];

const cacheDir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'codebase-memory-mcp');

function readPayload() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch (e) {
    return {};
  }
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
  const lockDir = path.join(cacheDir, 'indexing');
  const lock = path.join(lockDir, cwd.replace(/[^A-Za-z0-9]+/g, '-'));
  try {
    fs.mkdirSync(lockDir, { recursive: true });
    if (Date.now() - fs.statSync(lock).mtimeMs < 30 * 60 * 1000) return true;
  } catch (e) {
    /* no lock yet */
  }
  fs.writeFileSync(lock, String(process.pid));
  const log = fs.openSync(path.join(cacheDir, 'index.log'), 'a');
  const bin = path.join(root, 'bin', 'codebase-memory-mcp');
  const args = ['cli', '--quiet', 'index_repository', JSON.stringify({ repo_path: cwd, persistence: true })];
  spawn(bin, args, { detached: true, stdio: ['ignore', log, log] }).unref();
  return true;
}

function emit(context) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: EVENTS[mode], additionalContext: context } }));
}

function main() {
  const payload = readPayload();
  const cwd = payload.cwd || process.cwd();
  const indexed = fs.existsSync(path.join(cwd, '.codebase-memory', 'graph.db.zst'));
  const started = !indexed && mode === 'session' && startIndex(cwd);

  if (mode === 'prompt') {
    emit(indexed
      ? 'codebase-memory: this workspace has a graph. Code discovery goes through the codebase-memory tools (search_graph, trace_path, get_code_snippet, search_code). Grep and Glob on code are blocked by a hook.'
      : 'codebase-memory: this workspace has no graph yet.');
    return;
  }

  const status = indexed
    ? 'Status: this workspace is indexed (.codebase-memory/graph.db.zst).'
    : started
      ? 'Status: no index yet. A first index was started in the background; it appears at .codebase-memory/graph.db.zst when done.'
      : 'Status: no index, and this directory is not a git repository root, so none was started.';
  const rules = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8').trimEnd();
  emit(`${rules}\n\n${status}`);
}

if (require.main === module) main();

module.exports = { startIndex };
