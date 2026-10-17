// Run: node --test mods/codebase-memory-mod/test/
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decide, CODE_SEARCH } = require('../hooks/gate.js');

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cbm-gate-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cbm-home-'));
fs.mkdirSync(path.join(ws, '.codebase-memory'));
fs.writeFileSync(path.join(ws, '.codebase-memory', 'graph.db.zst'), '');
const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'cbm-bare-'));
after(() => [ws, home, bare].forEach(d => fs.rmSync(d, { recursive: true, force: true })));

const call = (tool_name, tool_input, cwd = ws) => ({ tool_name, tool_input, cwd });

test('Grep and Glob are denied in an indexed workspace', () => {
  assert.ok(decide(call('Grep', { pattern: 'handleModeChange' }), home));
  assert.ok(decide(call('Glob', { pattern: '**/*.ts' }), home));
});

test('Grep and Glob pass when there is no graph', () => {
  assert.strictEqual(decide(call('Grep', { pattern: 'x' }, bare), home), null);
});

test('Grep and Glob outside the workspace pass', () => {
  assert.strictEqual(decide(call('Grep', { pattern: 'x', path: '/etc' }), home), null);
  assert.ok(decide(call('Grep', { pattern: 'x', path: 'src' }), home));
});

test('shell code search is denied, a pipe into grep is not', () => {
  assert.ok(decide(call('Bash', { command: 'grep -rn foo src' }), home));
  assert.ok(decide(call('Bash', { command: 'cd x && rg foo' }), home));
  assert.ok(decide(call('Bash', { command: 'git grep foo' }), home));
  assert.ok(decide(call('Bash', { command: 'find . -name "*.ts"' }), home));
  assert.strictEqual(decide(call('Bash', { command: 'git log | grep fix' }), home), null);
  assert.strictEqual(decide(call('Bash', { command: 'npm test' }), home), null);
});

test('the gate-off file lifts it for the person', () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'cbm-cache-'));
  const prev = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cache;
  try {
    fs.mkdirSync(path.join(cache, 'codebase-memory-mcp'), { recursive: true });
    fs.writeFileSync(path.join(cache, 'codebase-memory-mcp', 'gate-off'), '');
    assert.strictEqual(decide(call('Grep', { pattern: 'x' }), home), null);
  } finally {
    if (prev === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prev;
  }
});

test('CODE_SEARCH matches a command segment start only', () => {
  assert.ok(CODE_SEARCH.test('echo a; grep x'));
  assert.ok(!CODE_SEARCH.test('echo grepper'));
});
