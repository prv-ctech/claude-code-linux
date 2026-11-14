// Run: node --test mods/oh-my-context-mod/test/
// hooks/graph.js: the grep gate, the context line and the on/off switch, against temp folders.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { decide, CODE_SEARCH, graphOn, line, PREFIX } = require('../hooks/graph.js');

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

test('text in quotes and here-documents is not a search, and neither is a search outside the workspace', () => {
  const bash = command => decide(call('Bash', { command }), home);
  // The word inside a string, a script or a message.
  assert.strictEqual(bash('node -e \'console.log("a && grep z f")\''), null);
  assert.strictEqual(bash('git commit -m "drop the grep gate; find callers"'), null);
  assert.strictEqual(bash('python3 - <<\'E\'\nprint(1); grep = 2\nfind . -name x\nE'), null);
  assert.strictEqual(bash('node hooks/sync.js status 2>&1 | grep graph'), null);
  // Paths that all lie outside the workspace: config and logs, not this code.
  assert.strictEqual(bash('grep -n mod ~/.claude/settings.json'), null);
  assert.strictEqual(bash('find /var/log -name "*.log"'), null);
  assert.strictEqual(bash('rg token "$HOME/.config/app" /etc/app.conf'), null);
  // Still searches of this code.
  assert.ok(bash('grep -rn foo'));
  assert.ok(bash('grep -rn "foo bar" src'));
  assert.ok(bash(`grep foo ${ws}/src /etc/hosts`), 'one path inside is enough');
  assert.ok(bash('echo "x" && rg foo'));
  assert.ok(bash('python3 - <<E\nprint(1)\nE\ngrep -rn foo .'), 'after the here-document ends');
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

test('the denial and the context line send the agent to the gateway call tool under the old tool names', () => {
  const reason = decide(call('Grep', { pattern: 'x' }), home);
  assert.match(reason, /oh-my-context `call` tool \(tool: mcp__plugin_codebase-memory-mod_codebase-memory-mcp__<name>\)/);
  assert.strictEqual(PREFIX, 'mcp__plugin_codebase-memory-mod_codebase-memory-mcp');
  assert.match(line(ws), /^Code graph: this workspace is indexed .*search_graph.*blocked by a hook/);
  assert.strictEqual(line(bare), '', 'no graph and nothing started: nothing to say');
  assert.match(line(bare, true), /first index was started/);
});

test('the gate hook works only while the mod runs the graph server itself', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cbm-cfg-'));
  after(() => fs.rmSync(cfg, { recursive: true, force: true }));
  const state = path.join(cfg, 'oh-my-context-mod', 'state.json');
  const env = { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: cfg };
  const p = { state: path.dirname(state), pluginData: path.join(cfg, 'plugins', 'data', 'oh-my-context-mod-claude-code-linux') };
  const gate = () => spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'graph.js'), 'gate'], {
    input: JSON.stringify(call('Grep', { pattern: 'x' })), encoding: 'utf8', env,
  });
  assert.strictEqual(gate().stdout, '', 'no state: the older plugin, or nobody, runs the graph');
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.writeFileSync(state, JSON.stringify({ graph: true }));
  assert.strictEqual(graphOn(p), true);
  assert.strictEqual(JSON.parse(gate().stdout).hookSpecificOutput.permissionDecision, 'deny');
  fs.mkdirSync(p.pluginData, { recursive: true });
  fs.writeFileSync(path.join(p.pluginData, 'off'), '');
  assert.strictEqual(graphOn(p), false);
  assert.strictEqual(gate().stdout, '', '/omc off lifts the gate too');
});
