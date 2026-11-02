// Offline tests of hooks/ultracave.js against a temp CLAUDE_CONFIG_DIR.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'ultracave.js');
const STYLE = 'caveman-mod:ultracave';

function home(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caveman-'));
  const file = path.join(dir, 'settings.json');
  if (settings !== undefined) fs.writeFileSync(file, typeof settings === 'string' ? settings : JSON.stringify(settings));
  const run = mode => {
    const r = spawnSync('node', [HOOK, mode], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    return r.stdout;
  };
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const write = s => fs.writeFileSync(file, JSON.stringify(s));
  return { file, run, read, write };
}

test('first session switches the style once and injects the rules without frontmatter', () => {
  const h = home({ outputStyle: 'Concise', other: 1 });
  const out = JSON.parse(h.run('session')).hookSpecificOutput;
  assert.match(out.additionalContext, /^CAVEMAN ULTRACAVE:/);
  assert.deepStrictEqual(h.read(), { outputStyle: STYLE, other: 1 });
  // A style the user picks later is not undone by the next session.
  h.write({ outputStyle: 'Explanatory', other: 1 });
  h.run('session');
  assert.strictEqual(h.read().outputStyle, 'Explanatory');
});

test('off restores the previous style, on switches back', () => {
  const h = home({ outputStyle: 'Concise' });
  h.run('session');
  h.run('off');
  assert.strictEqual(h.read().outputStyle, 'Concise');
  assert.strictEqual(h.run('session'), ''); // off: no context, no style change
  assert.strictEqual(h.read().outputStyle, 'Concise');
  h.run('on');
  assert.strictEqual(h.read().outputStyle, STYLE);
  h.run('off');
  assert.strictEqual(h.read().outputStyle, 'Concise');
});

test('no previous style: off removes the key; a style picked meanwhile is kept', () => {
  const h = home({});
  h.run('on');
  assert.strictEqual(h.read().outputStyle, STYLE);
  h.run('off');
  assert.ok(!('outputStyle' in h.read()));
  h.run('on');
  h.write({ outputStyle: 'Explanatory' });
  h.run('off');
  assert.strictEqual(h.read().outputStyle, 'Explanatory');
});

test('unreadable settings.json is never overwritten', () => {
  const h = home('{ not json');
  h.run('on');
  assert.strictEqual(fs.readFileSync(h.file, 'utf8'), '{ not json');
});
