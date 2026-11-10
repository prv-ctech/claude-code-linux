'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPLY = path.join(__dirname, '..', 'hooks', 'reply.js');
const HOOKS = path.join(__dirname, '..', 'hooks', 'hooks.json');

function setup(settings, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-reply-'));
  if (settings !== undefined) fs.writeFileSync(path.join(dir, 'settings.json'), settings);
  const run = (...args) => spawnSync('node', [REPLY, ...args], {
    encoding: 'utf8',
    env: { ...process.env, OMC_REPLY_MODE: '', ...env, CLAUDE_CONFIG_DIR: dir },
  });
  const style = () => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).outputStyle;
  const state = () => JSON.parse(fs.readFileSync(path.join(dir, 'oh-my-context-mod', 'reply.json'), 'utf8'));
  return { dir, run, style, state };
}

test('hooks print one JSON object with the right event (FR-1, FR-2)', () => {
  const t = setup('{"outputStyle":"Concise"}');
  const want = { session: 'SessionStart', prompt: 'UserPromptSubmit', tool: 'PostToolUse', subagent: 'SubagentStart' };
  for (const [m, ev] of Object.entries(want)) {
    const r = t.run(m);
    assert.strictEqual(r.status, 0);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.strictEqual(out.hookEventName, ev);
    if (m === 'session' || m === 'subagent') assert.ok(out.additionalContext.startsWith('REPLY MODE ULTRA:'));
    if (m === 'prompt') assert.ok(out.additionalContext.length > 50);
    if (m === 'tool') assert.ok(out.additionalContext.length <= 100);
  }
});

test('every level has a tool reminder of at most 100 chars and rules starting with its name (FR-2, FR-5)', () => {
  for (const level of ['lite', 'full', 'ultra', 'max']) {
    const t = setup('{}', { OMC_REPLY_MODE: level });
    assert.ok(JSON.parse(t.run('session').stdout).hookSpecificOutput.additionalContext.startsWith(`REPLY MODE ${level.toUpperCase()}:`));
    assert.ok(JSON.parse(t.run('tool').stdout).hookSpecificOutput.additionalContext.length <= 100);
  }
});

test('hooks.json holds the four reply hooks and keeps the old ones (FR-3)', () => {
  const h = JSON.parse(fs.readFileSync(HOOKS, 'utf8')).hooks;
  const cmds = ev => h[ev].flatMap(e => e.hooks.map(x => x.command));
  assert.ok(cmds('SessionStart').some(c => c.includes('sync.js" session')));
  assert.ok(cmds('SessionStart').some(c => c.endsWith('reply.js" session')));
  assert.ok(cmds('UserPromptSubmit').some(c => c.endsWith('prompt.js"')));
  assert.ok(cmds('UserPromptSubmit').some(c => c.endsWith('reply.js" prompt')));
  assert.ok(cmds('SubagentStart').some(c => c.includes('sync.js" epoch')));
  assert.ok(cmds('SubagentStart').some(c => c.endsWith('reply.js" subagent')));
  assert.ok(cmds('PostToolUse').some(c => c.endsWith('reply.js" tool')));
  assert.ok(cmds('PreToolUse').some(c => c.includes('permit.js')));
});

test('first session switches the style once and a later pick is kept (FR-7)', () => {
  const t = setup('{"outputStyle":"Concise"}');
  t.run('session');
  assert.strictEqual(t.style(), 'oh-my-context-mod:reply-ultra');
  assert.strictEqual(t.state().style.prev, 'Concise');
  assert.match(fs.readFileSync(path.join(t.dir, 'oh-my-context-mod', 'reply-fired', 'session.txt'), 'utf8'), /^\d{4}-\d\d-\d\dT/);
  fs.writeFileSync(path.join(t.dir, 'settings.json'), '{"outputStyle":"Explanatory"}');
  t.run('session');
  assert.strictEqual(t.style(), 'Explanatory');
});

test('mode command sets, reports, restores and rejects (FR-6)', () => {
  const t = setup('{"outputStyle":"Concise"}');
  assert.strictEqual(t.run('mode', 'max').stdout.trim(),
    'reply mode: max. Output style: oh-my-context-mod:reply-max. Takes effect from the next message.');
  assert.strictEqual(t.run('mode').stdout.trim(), 'reply mode: max');
  t.run('mode', 'lite');
  assert.strictEqual(t.state().style.prev, 'Concise'); // saved only once
  t.run('mode', 'off');
  assert.strictEqual(t.style(), 'Concise');
  assert.strictEqual(t.run('session').stdout, '');
  const before = fs.readFileSync(path.join(t.dir, 'oh-my-context-mod', 'reply.json'), 'utf8');
  const bad = t.run('mode', 'loud');
  assert.strictEqual(bad.status, 2);
  assert.strictEqual(bad.stdout.trim(), 'usage: /omc mode off|lite|full|ultra|max');
  assert.strictEqual(fs.readFileSync(path.join(t.dir, 'oh-my-context-mod', 'reply.json'), 'utf8'), before);
});

test('off deletes the key when it was unset, and leaves a style the user picked (FR-6)', () => {
  const t = setup('{}');
  t.run('mode', 'ultra');
  t.run('mode', 'off');
  assert.strictEqual(t.style(), undefined);
  const u = setup('{}');
  u.run('mode', 'ultra');
  fs.writeFileSync(path.join(u.dir, 'settings.json'), '{"outputStyle":"Explanatory"}');
  u.run('mode', 'off');
  assert.strictEqual(u.style(), 'Explanatory');
});

test('OMC_REPLY_MODE overrides output only and writes no state (FR-8)', () => {
  const t = setup('{}');
  t.run('mode', 'off');
  const r = spawnSync('node', [REPLY, 'subagent'], { encoding: 'utf8', env: { ...process.env, OMC_REPLY_MODE: 'max', CLAUDE_CONFIG_DIR: t.dir } });
  assert.ok(JSON.parse(r.stdout).hookSpecificOutput.additionalContext.startsWith('REPLY MODE MAX:'));
  assert.strictEqual(t.state().mode, 'off');
  assert.strictEqual(setup('{}', { OMC_REPLY_MODE: 'bogus' }).run('subagent').stdout.includes('REPLY MODE ULTRA:'), true);
});

test('corrupt files are never overwritten or crash (NFR-3)', () => {
  const t = setup('{oops');
  t.run('mode', 'ultra');
  assert.strictEqual(fs.readFileSync(path.join(t.dir, 'settings.json'), 'utf8'), '{oops');
  fs.writeFileSync(path.join(t.dir, 'oh-my-context-mod', 'reply.json'), '{oops');
  assert.strictEqual(t.run('mode').stdout.trim(), 'reply mode: ultra');
});

test('status lists mode, style and four events (FR-9)', () => {
  const t = setup('{}');
  const out = t.run('status').stdout;
  assert.match(out, /^reply mode: ultra\nstyle: default\nlast hook fire \(UTC\):\n/);
  assert.strictEqual(out.match(/never/g).length, 4);
});
