// Run: node --test mods/mcptoon-mod/test/
// The 0.1.1 restore against a temp HOME; nothing here reads or writes the real config.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const w = (f, data) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data));
};
const r = f => JSON.parse(fs.readFileSync(f, 'utf8'));

test('session start puts back 0.1.0\'s changes, never sets off, and says what to do next', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcptoon-mod-'));
  try {
    const data = path.join(home, 'data');
    const skill = path.join(home, 'p', 'skills', 'a', 'SKILL.md');
    w(skill, '---\nname: a\ndisable-model-invocation: true\n---\nbody\n');
    w(path.join(home, '.mcptoon', 'config.json'), { servers: { alpha: { command: 'a' }, own: { command: 'o' } } });
    w(path.join(home, '.claude.json'), { projects: { '/w': { disabledMcpServers: ['by-hand', 'plugin:alpha:alpha'] } } });
    w(path.join(home, '.claude', 'settings.json'), { skillOverrides: { u: 'user-invocable-only', mine: 'off' }, theme: 'dark' });
    w(path.join(data, 'state.json'), { off: false, servers: ['alpha'], projects: { '/w': ['plugin:alpha:alpha'] }, skills: [skill], overrides: ['u'] });
    const run = () => spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'sync.js'), 'session'], {
      input: '{}', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_DATA: data },
    });
    const out = run();
    assert.strictEqual(out.status, 0, out.stderr);
    assert.strictEqual(JSON.parse(out.stdout).hookSpecificOutput.additionalContext,
      'mcptoon-mod 0.1.1 put back its 0.1.0 changes. Install oh-my-context-mod from this marketplace, then uninstall mcptoon-mod.');
    assert.deepStrictEqual(Object.keys(r(path.join(home, '.mcptoon', 'config.json')).servers), ['own']);
    assert.deepStrictEqual(r(path.join(home, '.claude.json')).projects['/w'].disabledMcpServers, ['by-hand']);
    assert.strictEqual(fs.readFileSync(skill, 'utf8'), '---\nname: a\n---\nbody\n');
    assert.deepStrictEqual(r(path.join(home, '.claude', 'settings.json')), { skillOverrides: { mine: 'off' }, theme: 'dark' });
    assert.deepStrictEqual(r(path.join(data, 'state.json')), { off: false, servers: [], projects: {}, skills: [], overrides: [] });
    // Nothing left to undo: the next start rewrites nothing.
    const before = fs.statSync(path.join(home, '.claude.json')).mtimeMs;
    fs.utimesSync(path.join(home, '.claude.json'), new Date(0), new Date(0));
    assert.strictEqual(run().status, 0);
    assert.strictEqual(fs.statSync(path.join(home, '.claude.json')).mtimeMs, 0);
    assert.ok(before > 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
