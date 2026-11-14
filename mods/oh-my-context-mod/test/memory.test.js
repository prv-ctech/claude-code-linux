'use strict';
// Offline tests for hooks/memory.js (the deja-vu session memory the mod runs itself).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { memoryOn, run, LINE, PREFIX, HOOKS } = require('../hooks/memory.js');
const { context } = require('../hooks/prompt.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-memory-'));
const p = { state: path.join(dir, 'state'), pluginData: path.join(dir, 'data') };
fs.mkdirSync(p.state);
fs.mkdirSync(p.pluginData);
const setState = s => fs.writeFileSync(path.join(p.state, 'state.json'), JSON.stringify(s));
// A stand-in for bin/deja: prints the hook it was given and the payload it read.
const stub = path.join(dir, 'deja');
fs.writeFileSync(stub, '#!/bin/sh\nprintf "%s:" "$1"\ncat\n', { mode: 0o755 });

test('the memory hooks run only while the mod runs the memory server, and only the session-level ones', () => {
  assert.deepStrictEqual(HOOKS, ['hook-context', 'hook-precompact', 'hook-session-end']);
  assert.strictEqual(memoryOn(p), false, 'no state: another plugin may own the server');
  assert.strictEqual(run('hook-context', '{}', p, stub), '');
  setState({ memory: true });
  assert.strictEqual(memoryOn(p), true);
  assert.strictEqual(run('hook-context', '{"a":1}', p, stub), 'hook-context:{"a":1}', 'payload in, deja\'s answer out, untouched');
  assert.strictEqual(run('hook-prompt', '{}', p, stub), '', 'nothing per prompt');
  assert.strictEqual(run('hook-tool', '{}', p, stub), '', 'nothing per tool call');
  assert.strictEqual(run('hook-context', '{}', p, path.join(dir, 'missing')), '', 'a deja that cannot run says nothing');
  fs.writeFileSync(path.join(p.pluginData, 'off'), '');
  assert.strictEqual(memoryOn(p), false, '/omc off');
  assert.strictEqual(run('hook-context', '{}', p, stub), '');
  fs.rmSync(path.join(p.pluginData, 'off'));
});

test('a new context and a subagent are told how to reach the memory through the gateway', () => {
  assert.match(LINE, new RegExp(`oh-my-context \`call\` tool \\(tool: ${PREFIX}__deja, arguments: mode, q\\)`));
  assert.strictEqual(PREFIX, 'mcp__plugin_deja-vu_deja');
  setState({ memory: true });
  assert.ok(context({ cwd: dir }, p).includes(LINE));
  setState({ memory: false });
  assert.ok(!context({ cwd: dir }, p).includes('Memory:'));
});

test('session start fetches the binaries of the servers the mod runs, in the background', () => {
  const { fetchBuiltins } = require('../hooks/sync.js');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-fetch-'));
  const q = { state: path.join(d, 'state'), pluginData: path.join(d, 'data') };
  fs.mkdirSync(q.state);
  const started = [];
  const start = (bin, args, opts) => {
    started.push([path.basename(bin), args, opts.detached]);
    return { on() {}, unref() {} };
  };
  assert.deepStrictEqual(fetchBuiltins(q, start), [], 'another plugin runs them, or nobody: nothing to fetch');
  fs.writeFileSync(path.join(q.state, 'state.json'), JSON.stringify({ graph: true, memory: true }));
  assert.deepStrictEqual(fetchBuiltins(q, start), ['codebase-memory-mcp', 'deja']);
  assert.deepStrictEqual(started, [['codebase-memory-mcp', ['--version'], true], ['deja', ['--version'], true]]);
  fs.rmSync(d, { recursive: true, force: true });
});
