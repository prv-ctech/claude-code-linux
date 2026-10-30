// Run: node --test mods/mcptoon-mod/test/
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { paths, resolve, plan, patchSkill, unpatchSkill, swap, apply, restore, status } = require('../hooks/sync.js');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcptoon-mod-'));
after(() => fs.rmSync(home, { recursive: true, force: true }));
const env = { HOME: home, API_KEY: 'k' };
const ok = () => ({ status: 0, stdout: 'mcptoon 0.8.33' });
const w = (f, data) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data));
};
const r = f => JSON.parse(fs.readFileSync(f, 'utf8'));

// A machine with three plugins: one stdio server, one needing a keychain token, one kept direct.
const p = paths(home, {});
const plug = name => path.join(home, '.claude', 'plugins', 'cache', 'm', name, '1.0.0');
w(path.join(plug('alpha'), '.mcp.json'), { mcpServers: { alpha: { command: '${CLAUDE_PLUGIN_ROOT}/bin/a', args: ['serve'], env: { URL: '${user_config.url}' } } } });
w(path.join(plug('alpha'), '.claude-plugin', 'plugin.json'), { name: 'alpha', userConfig: { url: { type: 'string', default: 'https://x' } } });
w(path.join(plug('alpha'), 'skills', 'do-a', 'SKILL.md'), '---\nname: do-a\ndescription: A\n---\nbody\n');
w(path.join(plug('beta'), '.mcp.json'), { mcpServers: { beta: { command: 'b', env: { T: '${user_config.token}' } } } });
w(path.join(plug('beta'), '.claude-plugin', 'plugin.json'), { name: 'beta', userConfig: { token: { type: 'string', sensitive: true } } });
w(path.join(plug('gamma'), '.mcp.json'), { mcpServers: { gamma: { type: 'http', url: 'https://g', headers: { k: '${API_KEY}' } } } });
w(path.join(plug('gamma'), 'skills', 'keep-me', 'SKILL.md'), '---\nname: keep-me\n---\n');
w(path.join(plug('delta'), 'skills', 'd1', 'SKILL.md'), '---\nname: d1\n---\n');
w(path.join(plug('mcptoon-mod'), '.mcp.json'), { mcpServers: { mcptoon: { command: '${CLAUDE_PLUGIN_ROOT}/bin/mcptoon', args: ['serve'] } } });
w(p.installed, { plugins: Object.fromEntries(['alpha', 'beta', 'gamma', 'delta', 'mcptoon-mod'].map(n => [`${n}@m`, [{ installPath: plug(n) }]])) });
w(p.settings, {
  enabledPlugins: { 'alpha@m': true, 'beta@m': true, 'gamma@m': true, 'delta@m': true, 'mcptoon-mod@m': true },
  pluginConfigs: { 'mcptoon-mod@m': { options: { direct_servers: 'gamma', direct_skills: 'keep-me, delta' } } },
  skillOverrides: { mine: 'off' },
  theme: 'dark',
});
w(p.claudeJson, { mcpServers: { ctx: { type: 'http', url: 'https://c' } }, projects: { '/w': { disabledMcpServers: ['by-hand'] } } });
w(p.mcptoon, { servers: { own: { transport: 'stdio', command: 'o' } } });
w(path.join(p.skills, 'synced', 'id', 'user-skill', 'SKILL.md'), '---\nname: user-skill\n---\n');
w(path.join(p.skills, 'mcptoon', 'SKILL.md'), '---\nname: mcptoon\n---\n');
const skillA = path.join(plug('alpha'), 'skills', 'do-a', 'SKILL.md');
const skillKeep = path.join(plug('gamma'), 'skills', 'keep-me', 'SKILL.md');
const skillSet = path.join(plug('delta'), 'skills', 'd1', 'SKILL.md');

test('resolve fills plugin vars, env and defaults, and reports the rest', () => {
  const missing = [];
  assert.deepStrictEqual(
    resolve({ a: '${R}/x', b: ['${E}', '${N:-d}', '${Z}'] }, { R: '/r' }, { E: 'e' }, missing),
    { a: '/r/x', b: ['e', 'd', '${Z}'] });
  assert.deepStrictEqual(missing, ['Z']);
});

test('plan skips the gateway, the direct list and servers with unreadable values', () => {
  const s = (key, cfg, plugin = 'p') => ({ key, server: key, plugin, cfg, vars: {}, pluginEnv: {}, env: {} });
  const out = plan([
    s('mcptoon', { command: '/x/bin/mcptoon' }, 'mcptoon-mod'),
    s('keep', { command: 'k' }),
    s('tok', { command: 't', env: { T: '${user_config.token}' } }),
    s('sse', { type: 'sse', url: 'u' }),
    s('go', { command: 'g' }),
  ], ['keep']);
  assert.deepStrictEqual(out.map(o => o.forward), [false, false, false, false, true]);
  assert.match(out[2].reason, /user_config.token/);
});

test('patchSkill and unpatchSkill round-trip, and a skill that sets the key is left alone', () => {
  for (const t of ['---\nname: a\n---\nbody\n', 'no frontmatter\n', '---\r\nname: a\r\n---\r\nx']) {
    assert.strictEqual(unpatchSkill(patchSkill(t)), t);
    assert.match(patchSkill(t), /disable-model-invocation: true/);
  }
  assert.strictEqual(patchSkill('---\ndisable-model-invocation: false\n---\n'), null);
});

test('swap keeps the person\'s entries and owns only what it added', () => {
  assert.deepStrictEqual(swap(['me', 'old'], ['old'], ['new', 'me']), { next: ['me', 'new'], owned: ['new'] });
});

test('apply moves servers and hides skills; restore puts back exactly what it changed', () => {
  const settingsBefore = fs.readFileSync(p.settings, 'utf8');
  const res = apply(p, '/w', env, ok);

  const mc = r(p.mcptoon).servers;
  assert.deepStrictEqual(Object.keys(mc).sort(), ['alpha', 'ctx', 'own']);
  assert.deepStrictEqual(mc.alpha, {
    transport: 'stdio',
    command: `${plug('alpha')}/bin/a`,
    args: ['serve'],
    env: { CLAUDE_PLUGIN_ROOT: plug('alpha'), CLAUDE_PLUGIN_DATA: path.join(p.data, 'alpha-m'), URL: 'https://x' },
  });
  assert.strictEqual(fs.statSync(p.mcptoon).mode & 0o777, 0o600);

  const why = Object.fromEntries(res.servers.map(s => [s.key, s.forward || s.reason]));
  assert.strictEqual(why['plugin:beta:beta'], 'needs user_config.token');
  assert.strictEqual(why['plugin:gamma:gamma'], 'in direct_servers');
  assert.strictEqual(why['plugin:mcptoon-mod:mcptoon'], 'the gateway itself');
  assert.deepStrictEqual(r(p.claudeJson).projects['/w'].disabledMcpServers, ['by-hand', 'ctx', 'plugin:alpha:alpha']);

  assert.match(fs.readFileSync(skillA, 'utf8'), /disable-model-invocation: true/);
  // One skill kept by its name, a whole skill set kept by its plugin's name.
  assert.doesNotMatch(fs.readFileSync(skillKeep, 'utf8'), /disable-model-invocation/);
  assert.doesNotMatch(fs.readFileSync(skillSet, 'utf8'), /disable-model-invocation/);
  const s = r(p.settings);
  assert.deepStrictEqual(s.skillOverrides, { mine: 'off', 'user-skill': 'user-invocable-only' });
  assert.strictEqual(s.theme, 'dark');
  assert.ok(res.changed);

  // A second start changes nothing.
  assert.ok(!apply(p, '/w', env, ok).changed);
  assert.match(status(p, '/w', env, ok), /forwarded {2}plugin:alpha:alpha/);

  restore(p, env);
  assert.deepStrictEqual(Object.keys(r(p.mcptoon).servers), ['own']);
  assert.deepStrictEqual(r(p.claudeJson).projects['/w'].disabledMcpServers, ['by-hand']);
  assert.strictEqual(fs.readFileSync(skillA, 'utf8'), '---\nname: do-a\ndescription: A\n---\nbody\n');
  assert.deepStrictEqual(r(p.settings), JSON.parse(settingsBefore));
});

test('a server moved to direct_servers comes back on the next start', () => {
  apply(p, '/w', env, ok);
  const s = r(p.settings);
  s.pluginConfigs['mcptoon-mod@m'].options.direct_servers = 'gamma,alpha';
  w(p.settings, s);
  apply(p, '/w', env, ok);
  assert.ok(!('alpha' in r(p.mcptoon).servers));
  assert.deepStrictEqual(r(p.claudeJson).projects['/w'].disabledMcpServers, ['by-hand', 'ctx']);
  restore(p, env);
});

test('a config that does not parse stops the mod before it writes anything', () => {
  const good = fs.readFileSync(p.claudeJson, 'utf8');
  const broken = good.slice(0, 20);
  fs.writeFileSync(p.claudeJson, broken);
  const before = [p.settings, p.mcptoon].map(f => fs.readFileSync(f, 'utf8'));
  try {
    assert.throws(() => apply(p, '/w', env, ok), /\.claude\.json is not valid JSON/);
    assert.throws(() => restore(p, env), /not valid JSON/);
    assert.strictEqual(fs.readFileSync(p.claudeJson, 'utf8'), broken);
    assert.deepStrictEqual([p.settings, p.mcptoon].map(f => fs.readFileSync(f, 'utf8')), before);
    assert.doesNotMatch(fs.readFileSync(skillA, 'utf8'), /disable-model-invocation/);
  } finally {
    fs.writeFileSync(p.claudeJson, good);
  }
});
