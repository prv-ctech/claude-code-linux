// Run: node --test mods/oh-my-context-mod/test/
// Every test builds its own machine in a temp HOME; nothing here reads or writes the real config.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  paths, resolve, plan, routeSkill, withName, swap, apply, session, fullRestore, status,
} = require('../hooks/sync.js');
const R = require('../hooks/restore.js');

const homes = [];
after(() => homes.forEach(h => fs.rmSync(h, { recursive: true, force: true })));
const calls = [];
const ok = args => {
  calls.push(args);
  return { status: 0, stdout: 'oh-my-context 0.9.0' };
};
const w = (f, data) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data));
};
const r = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const t = f => fs.readFileSync(f, 'utf8');

// A machine with plugins: alpha (stdio server and a skill), beta (needs a keychain token),
// gamma (http server, a skill), delta (a skill), the mod itself; one user server, user skills.
function machine({ options = { direct_servers: 'gamma', direct_skills: 'keep-me, delta' } } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-my-context-mod-'));
  homes.push(home);
  const env = { HOME: home, API_KEY: 'k' };
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
  w(path.join(plug('oh-my-context-mod'), '.mcp.json'), { mcpServers: { 'oh-my-context': { command: '${CLAUDE_PLUGIN_ROOT}/bin/oh-my-context', args: ['serve'] } } });
  w(p.installed, { version: 2, plugins: Object.fromEntries(['alpha', 'beta', 'gamma', 'delta', 'oh-my-context-mod'].map(n => [`${n}@m`, [{ scope: 'user', installPath: plug(n) }]])) });
  w(p.settings, {
    enabledPlugins: { 'alpha@m': true, 'beta@m': true, 'gamma@m': true, 'delta@m': true, 'oh-my-context-mod@m': true },
    ...(options && { pluginConfigs: { 'oh-my-context-mod@m': { options } } }),
    skillOverrides: { mine: 'off' },
    theme: 'dark',
  });
  w(p.claudeJson, { mcpServers: { ctx: { type: 'http', url: 'https://c' } }, projects: { '/w': { disabledMcpServers: ['by-hand'] } } });
  w(p.gateway, { servers: { own: { transport: 'stdio', command: 'o' } } });
  w(path.join(p.skills, 'synced', 'id', 'user-skill', 'SKILL.md'), '---\nname: user-skill\ndescription: U\n---\n');
  w(path.join(p.skills, 'helper', 'SKILL.md'), '---\nname: helper\n---\n');
  w(path.join(p.skills, 'mine', 'SKILL.md'), '---\nname: mine\n---\n');
  return {
    home, env, p, plug,
    skillA: path.join(plug('alpha'), 'skills', 'do-a', 'SKILL.md'),
    skillKeep: path.join(plug('gamma'), 'skills', 'keep-me', 'SKILL.md'),
    skillSet: path.join(plug('delta'), 'skills', 'd1', 'SKILL.md'),
  };
}

// Adds plugin `name` with the given files (relative path -> content) and enables it at user scope.
function addPlugin(m, name, files, manifest = { name }) {
  for (const [rel, data] of Object.entries(files)) w(path.join(m.plug(name), rel), data);
  w(path.join(m.plug(name), '.claude-plugin', 'plugin.json'), manifest);
  const inst = r(m.p.installed);
  inst.plugins[`${name}@m`] = [{ scope: 'user', installPath: m.plug(name) }];
  w(m.p.installed, inst);
  const s = r(m.p.settings);
  s.enabledPlugins[`${name}@m`] = true;
  w(m.p.settings, s);
}

// Configs compared by content (the mod writes them pretty-printed), skills byte for byte.
const snapshot = m => [r(m.p.settings), r(m.p.claudeJson), ...[m.skillA, m.skillKeep, m.skillSet].map(t)];

test('resolve fills plugin vars, env and defaults, and reports the rest', () => {
  const missing = [];
  assert.deepStrictEqual(
    resolve({ a: '${R}/x', b: ['${E}', '${N:-d}', '${Z}'] }, { R: '/r' }, { E: 'e' }, missing),
    { a: '/r/x', b: ['e', 'd', '${Z}'] });
  assert.deepStrictEqual(missing, ['Z']);
});

test('plan skips the gateway in every form, the direct list and servers it cannot route', () => {
  const s = (key, cfg, plugin = 'p') => ({ key, server: key, plugin, cfg, vars: {}, pluginEnv: {}, env: {}, names: [key], prefix: `mcp__${key}` });
  const out = plan([
    s('oh-my-context', { command: '/x/bin/oh-my-context' }, 'oh-my-context-mod'),
    s('keep', { command: 'k' }),
    s('tok', { command: 't', env: { T: '${user_config.token}' } }),
    s('sse', { type: 'sse', url: 'u' }),
    s('py', { command: 'python3', args: ['-s', '-m', 'oh_my_context', 'serve'] }),
    s('cli', { command: 'python3', args: ['-m', 'oh_my_context.cli'] }),
    s('envwrap', { command: '/usr/bin/env', args: ['/opt/oh-my-context', 'serve'] }),
    s('oh-my-context', { command: 'anything' }, 'other'),
    // An upstream mcptoon gateway is never routed into this one either.
    s('mcptoon', { command: 'anything' }, 'other'),
    s('up-bin', { command: '/usr/local/bin/mcptoon', args: ['serve'] }),
    s('up-py', { command: 'python3', args: ['-s', '-m', 'mcptoon', 'serve'] }),
    s('up-cli', { command: 'python3', args: ['-m', 'mcptoon.cli'] }),
    s('up-wrap', { command: '/usr/bin/env', args: ['/opt/mcptoon', 'serve'] }),
    s('helper', { type: 'http', url: 'u', headersHelper: 'x' }),
    s('go', { command: 'g' }),
  ], ['keep']);
  assert.deepStrictEqual(out.map(o => o.forward), [...Array(14).fill(false), true]);
  assert.deepStrictEqual(out.map(o => o.reason).slice(4, 13), Array(9).fill('the gateway itself'));
  assert.match(out[2].reason, /user_config.token/);
  assert.strictEqual(out[3].reason, 'sse transport');
  assert.strictEqual(out[13].reason, 'headersHelper');
  assert.deepStrictEqual(out[14].entry, { transport: 'stdio', command: 'g', args: [], env: {}, claude_key: 'go', claude_prefix: 'mcp__go', timeout: 1800 });
  const longer = plan([{ ...s('go', { command: 'g' }), env: { MCP_TOOL_TIMEOUT: '1500' } }], []);
  assert.strictEqual(longer[0].entry.timeout, 2);
  // Claude's order: the server's own timeout (>= 1000 ms), MCP_TOOL_TIMEOUT, then the idle abort.
  const tmo = (cfg, env = {}) => plan([{ ...s('go', cfg), env }], [])[0].entry.timeout;
  assert.strictEqual(tmo({ command: 'g', timeout: 3600000 }, { MCP_TOOL_TIMEOUT: '1500' }), 3600);
  assert.strictEqual(tmo({ type: 'http', url: 'u', timeout: 3600000 }), 3600);
  assert.strictEqual(tmo({ command: 'g', timeout: 500 }), 1800);
  assert.strictEqual(tmo({ command: 'g' }, { CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: '60000' }), 60);
  assert.strictEqual(tmo({ command: 'g' }, { CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: '0' }), 100000);
});

test('routeSkill leaves a one-line description and drops when_to_use, block scalars included', () => {
  const src = '---\nname: a\ndescription: |\n  line one\n\n  line two\nwhen_to_use: >\n  folded\n  more\nallowed-tools:\n- Read\n---\nbody\n';
  assert.strictEqual(routeSkill(src), '---\nname: a\ndescription: routed\nallowed-tools:\n- Read\n---\nbody\n');
  assert.strictEqual(routeSkill('---\nname: a\n---\nx'), '---\nname: a\ndescription: routed\n---\nx');
  assert.strictEqual(routeSkill('no frontmatter\n'), '---\ndescription: routed\n---\nno frontmatter\n');
  assert.strictEqual(routeSkill('---\r\nname: a\r\ndescription: long\r\n  more\r\n---\r\nx'), '---\r\nname: a\r\ndescription: routed\r\n---\r\nx');
  // Not understood: never guessed at.
  assert.strictEqual(routeSkill('---\nname: a\n'), null);
  assert.strictEqual(routeSkill('---\nname: a\nthis is not yaml\n---\n'), null);
  assert.strictEqual(routeSkill('---\ndescription: a\ndescription: b\n---\n'), null);
});

test('a BOM before the frontmatter is kept for Claude and left out of the catalog', () => {
  const bom = '\ufeff---\nname: x\ndescription: d\nallowed-tools: Bash\n---\nbody';
  assert.strictEqual(routeSkill(bom), '\ufeff---\nname: x\ndescription: routed\nallowed-tools: Bash\n---\nbody');
  assert.strictEqual(routeSkill('\ufeffrun\n'), '\ufeff---\ndescription: routed\n---\nrun\n');
  assert.strictEqual(withName(bom, 'p:x'), '---\nname: p:x\ndescription: d\nallowed-tools: Bash\n---\nbody');
  assert.strictEqual(routeSkill('---\nopen\n'), null);
});

test('withName sets the catalog name', () => {
  assert.strictEqual(withName('---\nname: b\ndescription: d\n---\nx', 'p:b'), '---\nname: p:b\ndescription: d\n---\nx');
  // No frontmatter: Claude describes it by its first body line, so the catalog does too.
  assert.strictEqual(withName('\n# Kube helper\nmore', 'p:b'), '---\nname: p:b\ndescription: "Kube helper"\n---\n\n# Kube helper\nmore');
});

test('swap keeps the person\'s entries and owns only what it added', () => {
  assert.deepStrictEqual(swap(['me', 'old'], ['old'], ['new', 'me']), { next: ['me', 'new'], owned: ['new'] });
});

test('apply routes servers and skills; a full restore puts back exactly what it changed', () => {
  const m = machine();
  const { p, plug, env } = m;
  const before = snapshot(m);
  calls.length = 0;
  const res = apply(p, '/w', env, ok);

  const mc = r(p.gateway).servers;
  assert.deepStrictEqual(Object.keys(mc).sort(), ['alpha', 'ctx', 'own']);
  assert.deepStrictEqual(mc.alpha, {
    transport: 'stdio',
    command: `${plug('alpha')}/bin/a`,
    args: ['serve'],
    env: { CLAUDE_PLUGIN_ROOT: plug('alpha'), CLAUDE_PLUGIN_DATA: path.join(p.data, 'alpha-m'), URL: 'https://x' },
    claude_key: 'plugin:alpha:alpha',
    claude_prefix: 'mcp__plugin_alpha_alpha',
    timeout: 1800,
  });
  assert.deepStrictEqual(mc.ctx, { transport: 'http', url: 'https://c', claude_key: 'ctx', claude_prefix: 'mcp__ctx', timeout: 1800 });
  assert.strictEqual(fs.statSync(p.gateway).mode & 0o777, 0o600);

  const why = Object.fromEntries(res.servers.map(s => [s.key, s.forward || s.reason]));
  assert.strictEqual(why['plugin:beta:beta'], 'needs user_config.token');
  assert.strictEqual(why['plugin:gamma:gamma'], 'in direct_servers');
  assert.strictEqual(why['plugin:oh-my-context-mod:oh-my-context'], 'the gateway itself');
  assert.deepStrictEqual(r(p.claudeJson).projects['/w'].disabledMcpServers, ['by-hand', 'ctx', 'plugin:alpha:alpha']);

  assert.strictEqual(t(m.skillA), '---\nname: do-a\ndescription: routed\n---\nbody\n');
  // One skill kept by its name, a whole skill set kept by its plugin's name.
  assert.strictEqual(t(m.skillKeep), before[3]);
  assert.strictEqual(t(m.skillSet), before[4]);
  const s = r(p.settings);
  // The person's own override stays.
  assert.deepStrictEqual(s.skillOverrides, { mine: 'off', 'user-skill': 'name-only', helper: 'name-only' });
  assert.strictEqual(s.theme, 'dark');
  assert.ok(res.changed && res.filesChanged);

  // The catalog holds the originals under their Skill ids, and the index ran over it.
  const catalog = path.join(p.state, 'catalog');
  assert.strictEqual(t(path.join(catalog, 'alpha_do-a', 'SKILL.md')), '---\nname: alpha:do-a\ndescription: A\n---\nbody\n');
  assert.ok(fs.existsSync(path.join(catalog, 'user-skill', 'SKILL.md')));
  assert.deepStrictEqual(calls.at(-1), ['skills', 'index', catalog]);

  // A second start changes nothing.
  const again = apply(p, '/w', env, ok);
  assert.ok(!again.changed && !again.filesChanged);
  assert.match(status(p, '/w', env, ok), /forwarded {2}plugin:alpha:alpha/);
  assert.match(status(p, '/w', env, ok), /Guard .*: installed/);

  const out = fullRestore(p);
  assert.deepStrictEqual(out.failed, []);
  assert.deepStrictEqual(Object.keys(r(p.gateway).servers), ['own']);
  assert.deepStrictEqual(snapshot(m), before);
  assert.ok(!fs.existsSync(p.state));
});

test('route-all by default: blank settings keep only what cannot be routed direct', () => {
  const m = machine({ options: null });
  const res = apply(m.p, '/w', m.env, ok);
  const mc = r(m.p.gateway).servers;
  assert.deepStrictEqual(Object.keys(mc).sort(), ['alpha', 'ctx', 'gamma', 'own']);
  assert.deepStrictEqual(mc.gamma.headers, { k: 'k' });
  assert.deepStrictEqual(res.servers.filter(s => !s.forward).map(s => s.key).sort(), ['plugin:beta:beta', 'plugin:oh-my-context-mod:oh-my-context']);
  assert.match(t(m.skillKeep), /description: routed/);
  assert.match(t(m.skillSet), /description: routed/);
  assert.strictEqual(r(m.p.settings).skillOverrides.helper, 'name-only');
});

test('a server moved to direct_servers comes back on the next start', () => {
  const m = machine();
  apply(m.p, '/w', m.env, ok);
  const s = r(m.p.settings);
  s.pluginConfigs['oh-my-context-mod@m'].options.direct_servers = 'gamma,alpha';
  w(m.p.settings, s);
  apply(m.p, '/w', m.env, ok);
  assert.ok(!('alpha' in r(m.p.gateway).servers));
  assert.deepStrictEqual(r(m.p.claudeJson).projects['/w'].disabledMcpServers, ['by-hand', 'ctx']);
});

test('local-scope servers and project-scope plugins are routed for their project only', () => {
  const m = machine();
  const proj = fs.mkdtempSync(path.join(m.home, 'proj-'));
  const cj = r(m.p.claudeJson);
  cj.projects[proj] = { mcpServers: { loc: { command: 'l' } } };
  w(m.p.claudeJson, cj);
  w(path.join(proj, '.mcp.json'), { mcpServers: { pj: { command: 'pj' } } });
  w(path.join(proj, '.claude', 'settings.json'), { enabledPlugins: { 'eps@m': true, 'off@m': true } });
  w(path.join(proj, '.claude', 'settings.local.json'), { enabledPlugins: { 'off@m': false } });
  for (const n of ['eps', 'off']) {
    w(path.join(m.plug(n), '.mcp.json'), { mcpServers: { [n]: { command: n } } });
    w(path.join(m.plug(n), 'skills', `${n}-s`, 'SKILL.md'), `---\nname: ${n}-s\ndescription: E\n---\n`);
  }
  const inst = r(m.p.installed);
  inst.plugins['eps@m'] = [{ scope: 'project', projectPath: '/elsewhere', installPath: '/nope' }, { scope: 'project', projectPath: proj, installPath: m.plug('eps') }];
  inst.plugins['off@m'] = [{ scope: 'project', projectPath: proj, installPath: m.plug('off') }];
  w(m.p.installed, inst);

  const res = apply(m.p, proj, m.env, ok);
  const mc = r(m.p.gateway).servers;
  const real = fs.realpathSync(proj);
  assert.deepStrictEqual(mc['loc@local'], { transport: 'stdio', command: 'l', args: [], env: {}, claude_key: 'loc', claude_prefix: 'mcp__loc', timeout: 1800, cwd_only: real });
  assert.strictEqual(mc.eps.cwd_only, real);
  assert.strictEqual(mc.eps.claude_prefix, 'mcp__plugin_eps_eps');
  assert.ok(!('off' in mc), 'disabled in local settings');
  assert.strictEqual(res.servers.find(s => s.key === 'pj').reason, 'project .mcp.json');
  assert.deepStrictEqual(r(m.p.claudeJson).projects[proj].disabledMcpServers, ['ctx', 'loc', 'plugin:alpha:alpha', 'plugin:eps:eps']);
  assert.match(t(path.join(m.plug('eps'), 'skills', 'eps-s', 'SKILL.md')), /description: routed/);
  assert.doesNotMatch(t(path.join(m.plug('off'), 'skills', 'off-s', 'SKILL.md')), /routed/);

  // Another project's start keeps this project's entries and its skill patch.
  apply(m.p, '/w', m.env, ok);
  assert.ok('eps' in r(m.p.gateway).servers && 'loc@local' in r(m.p.gateway).servers);
  assert.match(t(path.join(m.plug('eps'), 'skills', 'eps-s', 'SKILL.md')), /description: routed/);
});

test('plugin skills: backup, exact restore, re-patch after a cache replace and after an update', () => {
  const m = machine();
  const orig = '---\nname: big\ndescription: >-\n  a long\n  description\nwhen_to_use: |\n  when asked\nmodel: x\n---\nBody.\n';
  addPlugin(m, 'eps', { 'skills/big/SKILL.md': orig, 'extra/one/SKILL.md': '---\nname: one\ndescription: o\n---\n' }, { name: 'eps', skills: './extra' });
  const f = path.join(m.plug('eps'), 'skills', 'big', 'SKILL.md');
  const extra = path.join(m.plug('eps'), 'extra', 'one', 'SKILL.md');
  fs.chmodSync(f, 0o640);
  apply(m.p, '/w', m.env, ok);
  assert.strictEqual(t(f), '---\nname: big\nmodel: x\n---\nBody.\n'.replace('model', 'description: routed\nmodel'));
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o640);
  assert.match(t(extra), /description: routed/);
  assert.strictEqual(t(path.join(m.p.state, 'originals', `${R.sha(orig)}.md`)), orig);

  // The cache dir replaced by the same version: the original is back, and gets patched again.
  fs.writeFileSync(f, orig);
  apply(m.p, '/w', m.env, ok);
  assert.match(t(f), /description: routed/);

  // A plugin update: the new text becomes the original.
  const updated = orig.replace('Body.', 'New body.');
  fs.writeFileSync(f, updated);
  apply(m.p, '/w', m.env, ok);
  assert.match(t(f), /description: routed\nmodel: x\n---\nNew body\./);
  assert.strictEqual(R.loadState(m.p.state).files.filter(x => x.path === f).length, 1);

  fullRestore(m.p);
  assert.strictEqual(t(f), updated);
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o640);
});

test('plugin commands are routed like skills: still invocable, indexed, and put back', () => {
  const m = machine();
  const run = '---\ndescription: Run it\n---\nDo it.\n';
  addPlugin(m, 'cmds', { 'commands/run.md': run, 'commands/sub/bare.md': 'Bare.\n', 'other/x.md': 'X.\n', 'commands/self.md': '---\ndisable-model-invocation: false\n---\n' });
  const dir = path.join(m.plug('cmds'), 'commands');
  apply(m.p, '/w', m.env, ok);
  assert.strictEqual(t(path.join(dir, 'run.md')), '---\ndescription: routed\n---\nDo it.\n');
  assert.strictEqual(t(path.join(dir, 'sub', 'bare.md')), '---\ndescription: routed\n---\nBare.\n');
  assert.strictEqual(t(path.join(dir, 'self.md')), '---\ndisable-model-invocation: false\n---\n');
  assert.strictEqual(t(path.join(m.p.state, 'catalog', 'cmds_run', 'SKILL.md')), '---\nname: cmds:run\ndescription: Run it\n---\nDo it.\n');
  assert.ok(!fs.existsSync(path.join(m.p.state, 'catalog', 'cmds_self')));
  assert.match(status(m.p, '/w', m.env, ok), /Commands: 2 plugin command/);

  // A custom commands path replaces the default folder.
  w(path.join(m.plug('cmds'), '.claude-plugin', 'plugin.json'), { name: 'cmds', commands: ['./other/x.md'] });
  apply(m.p, '/w', m.env, ok);
  assert.strictEqual(t(path.join(dir, 'run.md')), run);
  assert.strictEqual(t(path.join(dir, 'sub', 'bare.md')), 'Bare.\n');
  assert.match(t(path.join(m.plug('cmds'), 'other', 'x.md')), /description: routed/);
  fullRestore(m.p);
  assert.strictEqual(t(path.join(m.plug('cmds'), 'other', 'x.md')), 'X.\n');
});

test('a command an earlier build flagged is re-routed from its backed-up original', () => {
  const m = machine();
  const run = '---\ndescription: Run it\n---\nDo it.\n';
  addPlugin(m, 'cmds', { 'commands/run.md': run });
  const f = path.join(m.plug('cmds'), 'commands', 'run.md');
  apply(m.p, '/w', m.env, ok);
  // What the earlier build left: the flagged text, journaled with the same original.
  const flagged = '---\ndescription: Run it\ndisable-model-invocation: true\n---\nDo it.\n';
  fs.writeFileSync(f, flagged);
  const st = R.loadState(m.p.state);
  st.files.find(x => x.path === f).patchedSha = R.sha(flagged);
  R.saveState(m.p.state, st);
  apply(m.p, '/w', m.env, ok);
  assert.strictEqual(t(f), '---\ndescription: routed\n---\nDo it.\n');
  fullRestore(m.p);
  assert.strictEqual(t(f), run);
});

test('a SKILL.md that cannot be read or parsed is left untouched and reported', () => {
  const m = machine();
  addPlugin(m, 'odd', { 'skills/weird/SKILL.md': '---\nname: weird\nnot: [yaml\nplain words\n---\n' });
  fs.mkdirSync(path.join(m.plug('odd'), 'skills', 'dir', 'SKILL.md'), { recursive: true });
  const res = apply(m.p, '/w', m.env, ok);
  assert.strictEqual(t(path.join(m.plug('odd'), 'skills', 'weird', 'SKILL.md')), '---\nname: weird\nnot: [yaml\nplain words\n---\n');
  assert.strictEqual(res.problems.length, 2);
  assert.match(res.problems.join('\n'), /dir\/SKILL.md: cannot be read/);
  assert.match(res.problems.join('\n'), /weird\/SKILL.md: frontmatter not understood/);
});

test('the gateway config is the owner\'s alone, new or existing', () => {
  const m = machine();
  fs.rmSync(m.p.gateway);
  const old = process.umask(0);
  try {
    apply(m.p, '/w', m.env, ok);
  } finally {
    process.umask(old);
  }
  assert.strictEqual(fs.statSync(m.p.gateway).mode & 0o777, 0o600);
  fs.chmodSync(m.p.gateway, 0o644);
  const s = r(m.p.settings);
  s.pluginConfigs['oh-my-context-mod@m'].options.direct_servers = 'gamma,alpha';
  w(m.p.settings, s);
  apply(m.p, '/w', m.env, ok);
  assert.strictEqual(fs.statSync(m.p.gateway).mode & 0o777, 0o600);
});

test('a config that does not parse stops apply before it writes anything', () => {
  const m = machine();
  const broken = t(m.p.claudeJson).slice(0, 20);
  fs.writeFileSync(m.p.claudeJson, broken);
  const before = [m.p.settings, m.p.gateway, m.skillA].map(t);
  assert.throws(() => apply(m.p, '/w', m.env, ok), /\.claude\.json is not valid JSON/);
  assert.strictEqual(t(m.p.claudeJson), broken);
  assert.deepStrictEqual([m.p.settings, m.p.gateway, m.skillA].map(t), before);
});

test('journal: a failure halfway through apply still lets restore undo everything', () => {
  const m = machine({ options: null });
  const before = snapshot(m);
  // The temp file of d1's atomic write is taken, so that write throws after earlier changes landed.
  const blocker = `${m.skillSet}.${process.pid}.tmp`;
  fs.mkdirSync(blocker);
  assert.throws(() => apply(m.p, '/w', m.env, ok), /EEXIST/);
  assert.match(t(m.skillA), /description: routed/);
  assert.ok('alpha' in r(m.p.gateway).servers);
  fs.rmdirSync(blocker);
  const out = fullRestore(m.p);
  assert.deepStrictEqual(out.failed, []);
  assert.deepStrictEqual(snapshot(m), before);
  assert.deepStrictEqual(Object.keys(r(m.p.gateway).servers), ['own']);
});

test('the lock waits for a live holder, takes over a dead one at once and a hung one late', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-my-context-lock-'));
  homes.push(dir);
  const lock = path.join(dir, '.lock');
  const age = (s) => {
    const old = (Date.now() - s * 1000) / 1000;
    fs.utimesSync(lock, old, old);
  };
  // A live holder (pid 1) keeps the lock, even past a minute: a slow apply is never overlapped.
  fs.writeFileSync(lock, '1 1');
  const t0 = Date.now();
  assert.throws(() => R.withLock(dir, () => 1, 300), /held by another session/);
  assert.ok(Date.now() - t0 >= 300);
  age(120);
  assert.throws(() => R.withLock(dir, () => 1, 300), /held by another session/);
  // Hung (or its pid reused): taken over after 5 minutes.
  age(400);
  assert.strictEqual(R.withLock(dir, () => 42, 300), 42);
  assert.ok(!fs.existsSync(lock));
  // A holder that died: taken over at once (2^22 + 1 is above Linux pid_max).
  fs.writeFileSync(lock, `${2 ** 22 + 1} ${Date.now()}`);
  assert.strictEqual(R.withLock(dir, () => 7, 300), 7);
});

test('a failed write leaves no temp file beside the target', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-my-context-tmp-'));
  homes.push(dir);
  const orig = fs.writeSync;
  fs.writeSync = () => {
    throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
  };
  try {
    assert.throws(() => R.writeJson(path.join(dir, 's.json'), { a: 1 }), /ENOSPC/);
  } finally {
    fs.writeSync = orig;
  }
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('the guard is installed once, and the person\'s own hooks stay as they are', () => {
  const m = machine();
  const s = r(m.p.settings);
  const own = { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }] };
  s.hooks = JSON.parse(JSON.stringify(own));
  w(m.p.settings, s);
  apply(m.p, '/w', m.env, ok);
  apply(m.p, '/w', m.env, ok);
  const h = r(m.p.settings).hooks;
  const guardFile = path.join(m.p.state, 'guard.js');
  const cmd = `node '${guardFile}' guard`;
  assert.deepStrictEqual(h.SessionStart, [own.SessionStart[0], { hooks: [{ type: 'command', command: cmd, timeout: 60 }] }]);
  assert.deepStrictEqual(h.ConfigChange, [{ matcher: 'user_settings|project_settings|local_settings', hooks: [{ type: 'command', command: cmd, timeout: 60 }] }]);
  assert.deepStrictEqual(h.PreToolUse, own.PreToolUse);
  assert.strictEqual(t(guardFile), t(path.join(__dirname, '..', 'hooks', 'restore.js')));
  fullRestore(m.p);
  assert.deepStrictEqual(r(m.p.settings).hooks, own);
});

test('guard: after an uninstall it restores everything, removes itself and its state, with plugin data gone', () => {
  const m = machine();
  const before = snapshot(m);
  apply(m.p, '/w', m.env, ok);
  const inst = r(m.p.installed);
  delete inst.plugins['oh-my-context-mod@m'];
  w(m.p.installed, inst);
  fs.rmSync(m.p.pluginData, { recursive: true, force: true });
  const run = spawnSync(process.execPath, [path.join(m.p.state, 'guard.js'), 'guard'], {
    input: JSON.stringify({ cwd: '/w', hook_event_name: 'SessionStart' }), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: m.home },
  });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.match(JSON.parse(run.stdout).systemMessage, /uninstalled: put back 2 MCP server switch.*next session/);
  assert.deepStrictEqual(snapshot(m), before);
  assert.ok(!fs.existsSync(m.p.state));
});

test('guard: disabled for one project restores that project only; enabled it does nothing', () => {
  const m = machine();
  const proj = fs.mkdtempSync(path.join(m.home, 'proj-'));
  apply(m.p, '/w', m.env, ok);
  apply(m.p, proj, m.env, ok);
  const before = [m.p.claudeJson, m.p.settings, m.skillA].map(t);
  assert.strictEqual(R.guard({ cwd: proj }, m.p.state), null);
  assert.deepStrictEqual([m.p.claudeJson, m.p.settings, m.skillA].map(t), before);

  w(path.join(proj, '.claude', 'settings.local.json'), { enabledPlugins: { 'oh-my-context-mod@m': false } });
  assert.match(R.guard({ cwd: proj }, m.p.state), /disabled in this project/);
  const cj = r(m.p.claudeJson);
  assert.ok(!(proj in cj.projects), 'the entry the mod created goes with its list');
  assert.deepStrictEqual(cj.projects['/w'].disabledMcpServers, ['by-hand', 'ctx', 'plugin:alpha:alpha']);
  assert.match(t(m.skillA), /description: routed/);
  assert.ok(fs.existsSync(path.join(m.p.state, 'state.json')));

  // Disabled at user scope: everything goes back.
  const s = r(m.p.settings);
  s.enabledPlugins['oh-my-context-mod@m'] = false;
  w(m.p.settings, s);
  assert.match(R.guard({ cwd: '/w' }, m.p.state), /is disabled: put back/);
  assert.strictEqual(t(m.skillA), '---\nname: do-a\ndescription: A\n---\nbody\n');
  assert.ok(!fs.existsSync(m.p.state));
});

test('restore skips a file that does not parse and restores the rest, then finishes later', () => {
  const m = machine();
  const before = snapshot(m);
  apply(m.p, '/w', m.env, ok);
  const good = t(m.p.claudeJson);
  fs.writeFileSync(m.p.claudeJson, '{ broken');
  const out = fullRestore(m.p);
  assert.match(out.failed.join('\n'), /\.claude\.json is not valid JSON/);
  assert.strictEqual(t(m.p.claudeJson), '{ broken');
  assert.strictEqual(t(m.skillA), before[2]);
  assert.deepStrictEqual(r(m.p.settings).skillOverrides, { mine: 'off' });
  // The guard stays until everything is back, so the failed step is retried.
  assert.ok(r(m.p.settings).hooks.SessionStart);
  assert.ok(fs.existsSync(path.join(m.p.state, 'state.json')));
  fs.writeFileSync(m.p.claudeJson, good);
  assert.deepStrictEqual(fullRestore(m.p).failed, []);
  assert.deepStrictEqual(snapshot(m), before);
});

test('session: applies, asks for a skill reload; off and a broken CLI', () => {
  const m = machine();
  const out = session(m.p, '/w', m.env, ok);
  assert.strictEqual(t(m.skillA), '---\nname: do-a\ndescription: routed\n---\nbody\n');
  assert.strictEqual(r(m.p.settings).skillOverrides['user-skill'], 'name-only');
  assert.deepStrictEqual(r(m.p.claudeJson).projects['/w'].disabledMcpServers, ['by-hand', 'ctx', 'plugin:alpha:alpha']);
  assert.strictEqual(out.reloadSkills, true);
  assert.match(out.additionalContext, /^oh-my-context-mod: 2 MCP server\(s\) routed through oh-my-context .* 3 skill\(s\) and 0 plugin command\(s\) listed by name only .*direct: plugin:beta:beta \(needs user_config.token\), plugin:gamma:gamma \(in direct_servers\)\. Changes made at this start count from the next session\.$/);

  // A broken CLI puts everything back.
  const bad = () => ({ status: 127, stdout: '' });
  assert.match(session(m.p, '/w', m.env, bad).additionalContext, /did not run, so every MCP server and skill is direct again/);
  assert.strictEqual(t(m.skillA), '---\nname: do-a\ndescription: A\n---\nbody\n');
  assert.ok(!fs.existsSync(m.p.state));

  // An off flag an earlier build kept in the state dir moves to plugin data; the state dir goes.
  R.saveState(m.p.state, { ...R.emptyState(), off: true });
  assert.match(session(m.p, '/w', m.env, ok).additionalContext, /^oh-my-context-mod: off;/);
  assert.strictEqual(t(m.skillA), '---\nname: do-a\ndescription: A\n---\nbody\n');
  assert.ok(fs.existsSync(path.join(m.p.pluginData, 'off')));
  assert.ok(!fs.existsSync(m.p.state));
});

test('off then uninstall leaves nothing behind, and a reinstall starts on', () => {
  const m = machine();
  const before = snapshot(m);
  apply(m.p, '/w', m.env, ok);
  const cli = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'sync.js'), 'off'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: m.home },
  });
  assert.strictEqual(cli.status, 0, cli.stderr);
  assert.deepStrictEqual(snapshot(m), before);
  assert.ok(!fs.existsSync(m.p.state), 'off removes the state dir');
  assert.ok(fs.existsSync(path.join(m.p.pluginData, 'off')));
  assert.match(session(m.p, '/w', m.env, ok).additionalContext, /^oh-my-context-mod: off;/);
  assert.ok(!fs.existsSync(m.p.state), 'an off session creates nothing');
  assert.match(status(m.p, '/w', m.env, ok), /^oh-my-context-mod: off/);
  // Uninstall deletes plugin data; a reinstall routes again.
  fs.rmSync(m.p.pluginData, { recursive: true, force: true });
  session(m.p, '/w', m.env, ok);
  assert.match(t(m.skillA), /description: routed/);
});

test('a project entry or list the mod created goes again once it is empty', () => {
  const m = machine();
  const proj = fs.mkdtempSync(path.join(m.home, 'proj-'));
  apply(m.p, proj, m.env, ok);
  assert.deepStrictEqual(r(m.p.claudeJson).projects[proj], { disabledMcpServers: ['ctx', 'plugin:alpha:alpha'] });
  fullRestore(m.p);
  assert.ok(!(proj in r(m.p.claudeJson).projects), 'restore drops the entry it created');

  // Every routed server moved to direct_servers: the list it created goes on the next start.
  const cj = r(m.p.claudeJson);
  cj.projects[proj] = { allowedTools: [] };
  w(m.p.claudeJson, cj);
  apply(m.p, proj, m.env, ok);
  const s = r(m.p.settings);
  s.pluginConfigs['oh-my-context-mod@m'].options.direct_servers = 'gamma,alpha,ctx';
  w(m.p.settings, s);
  apply(m.p, proj, m.env, ok);
  assert.deepStrictEqual(r(m.p.claudeJson).projects[proj], { allowedTools: [] });
  fullRestore(m.p);
  assert.deepStrictEqual(r(m.p.claudeJson).projects[proj], { allowedTools: [] });
});

test('a mod enabled only in a project leaves global skills, commands and user overrides alone', () => {
  const m = machine();
  const proj = fs.mkdtempSync(path.join(m.home, 'proj-'));
  addPlugin(m, 'cmds', { 'commands/run.md': 'Run.\n' });
  w(path.join(m.plug('pj'), 'skills', 'pj-s', 'SKILL.md'), '---\nname: pj-s\ndescription: P\n---\n');
  const inst = r(m.p.installed);
  inst.plugins['pj@m'] = [{ scope: 'project', projectPath: proj, installPath: m.plug('pj') }];
  w(m.p.installed, inst);
  // At user scope first, then moved to project scope.
  apply(m.p, proj, m.env, ok);
  assert.match(t(m.skillA), /description: routed/);
  const s = r(m.p.settings);
  delete s.enabledPlugins['oh-my-context-mod@m'];
  w(m.p.settings, s);
  w(path.join(proj, '.claude', 'settings.json'), { enabledPlugins: { 'oh-my-context-mod@m': true, 'pj@m': true } });
  const res = apply(m.p, proj, m.env, ok);
  assert.strictEqual(t(m.skillA), '---\nname: do-a\ndescription: A\n---\nbody\n');
  assert.strictEqual(t(path.join(m.plug('cmds'), 'commands', 'run.md')), 'Run.\n');
  assert.deepStrictEqual(r(m.p.settings).skillOverrides, { mine: 'off' });
  assert.match(t(path.join(m.plug('pj'), 'skills', 'pj-s', 'SKILL.md')), /description: routed/);
  assert.ok(res.servers.find(x => x.key === 'plugin:alpha:alpha').forward, 'MCP servers are still routed here');
  assert.match(status(m.p, proj, m.env, ok), /listed by name only; 1 would be on the next start/);

  // Disabled in that project: its project-only plugin files come back too.
  w(path.join(proj, '.claude', 'settings.local.json'), { enabledPlugins: { 'oh-my-context-mod@m': false } });
  assert.match(R.guard({ cwd: proj }, m.p.state), /disabled in this project: put back \d+ MCP server switch\(es\), 1 plugin skill/);
  assert.strictEqual(t(path.join(m.plug('pj'), 'skills', 'pj-s', 'SKILL.md')), '---\nname: pj-s\ndescription: P\n---\n');
});

test('guard: off at user scope but on in a project keeps that project routed', () => {
  const m = machine();
  const proj = fs.mkdtempSync(path.join(m.home, 'proj-'));
  const s = r(m.p.settings);
  s.enabledPlugins['oh-my-context-mod@m'] = false;
  w(m.p.settings, s);
  w(path.join(proj, '.claude', 'settings.local.json'), { enabledPlugins: { 'oh-my-context-mod@m': true } });
  for (let i = 0; i < 2; i++) {
    apply(m.p, proj, m.env, ok);
    assert.strictEqual(R.guard({ cwd: proj }, m.p.state), null);
    // Another project, where it is off, does not undo it either.
    assert.strictEqual(R.guard({ cwd: '/w' }, m.p.state), null);
    assert.deepStrictEqual(r(m.p.claudeJson).projects[proj].disabledMcpServers, ['ctx', 'plugin:alpha:alpha']);
  }
  // Turned off in that project too: now everything goes back.
  w(path.join(proj, '.claude', 'settings.local.json'), { enabledPlugins: { 'oh-my-context-mod@m': false } });
  assert.match(R.guard({ cwd: '/w' }, m.p.state), /is disabled: put back/);
  assert.ok(!fs.existsSync(m.p.state));
});

test('plugin files reached through a symlink are never rewritten', () => {
  const m = machine();
  // A linked SKILL.md, and a linked skill folder outside the plugin (a link-farm install).
  const src = path.join(m.home, 'src');
  w(path.join(src, 'do-b.md'), '---\nname: do-b\ndescription: B\n---\n');
  w(path.join(src, 'notes', 'SKILL.md'), '---\nname: notes\ndescription: N\n---\n');
  addPlugin(m, 'lnk', { 'skills/plain/SKILL.md': '---\nname: plain\ndescription: P\n---\n' });
  fs.mkdirSync(path.join(m.plug('lnk'), 'skills', 'do-b'));
  const linked = path.join(m.plug('lnk'), 'skills', 'do-b', 'SKILL.md');
  fs.symlinkSync(path.join(src, 'do-b.md'), linked);
  fs.symlinkSync(path.join(src, 'notes'), path.join(m.plug('lnk'), 'skills', 'notes'));
  apply(m.p, '/w', m.env, ok);
  assert.match(t(path.join(m.plug('lnk'), 'skills', 'plain', 'SKILL.md')), /description: routed/);
  assert.ok(fs.lstatSync(linked).isSymbolicLink());
  assert.strictEqual(t(path.join(src, 'do-b.md')), '---\nname: do-b\ndescription: B\n---\n');
  assert.strictEqual(t(path.join(src, 'notes', 'SKILL.md')), '---\nname: notes\ndescription: N\n---\n');
  // Still indexed under their ids.
  assert.ok(fs.existsSync(path.join(m.p.state, 'catalog', 'lnk_notes', 'SKILL.md')));
});

test('subagent hooks and /clear move the instructions epoch the gateway watches', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-my-context-mod-'));
  homes.push(home);
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '', CLAUDE_PLUGIN_DATA: '', OMC_HOME: '', OMC_CONFIG_FILE: '' };
  const epoch = path.join(paths(home, {}).pluginData, 'home', 'instructions-epoch');
  const cli = (args, input) => spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'sync.js'), ...args], { env, input, encoding: 'utf8' });
  assert.strictEqual(cli(['epoch']).status, 0);
  assert.ok(fs.existsSync(epoch));
  fs.utimesSync(epoch, new Date(0), new Date(0));
  cli(['session'], JSON.stringify({ source: 'clear', cwd: home }));
  assert.ok(fs.statSync(epoch).mtimeMs > 0);
  fs.utimesSync(epoch, new Date(0), new Date(0));
  cli(['session'], JSON.stringify({ source: 'startup', cwd: home }));
  assert.strictEqual(fs.statSync(epoch).mtimeMs, 0);
});

test('a sensitive option in Claude\'s file credential store routes the server, and the value is never printed', () => {
  const m = machine();
  w(m.p.credentials, { pluginSecrets: { 'beta@m': { token: 's3cret-value' } } });
  const out = session(m.p, '/w', m.env, ok);
  const gw = r(m.p.gateway).servers;
  const beta = Object.values(gw).find(s => s.claude_key === 'plugin:beta:beta');
  assert.ok(beta, 'beta is routed');
  assert.strictEqual(beta.env.T, 's3cret-value');
  assert.strictEqual(fs.statSync(m.p.gateway).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(out).includes('s3cret-value'));
  assert.ok(!status(m.p, '/w', m.env, ok).includes('s3cret-value'));
  // Without the store entry it stays direct, naming only the key.
  w(m.p.credentials, { pluginSecrets: {} });
  apply(m.p, '/w', m.env, ok);
  assert.ok(!Object.values(r(m.p.gateway).servers).some(s => s.claude_key === 'plugin:beta:beta'));
  assert.match(status(m.p, '/w', m.env, ok), /needs user_config\.token/);
});

test('an http server Claude signs in to with OAuth stays direct; key names are read, never tokens', () => {
  const m = machine({ options: null });
  w(m.p.credentials, { mcpOAuth: {
    'plugin:gamma:gamma|0123456789abcdef': { accessToken: 'tok-secret' },
    'ctx|fedcba9876543210': {},
    'plugin:alpha:alpha|0000000000000000': {},
  } });
  const res = apply(m.p, '/w', m.env, ok);
  const why = Object.fromEntries(res.servers.map(s => [s.key, s.forward || s.reason]));
  assert.strictEqual(why['plugin:gamma:gamma'], 'OAuth (signs in through Claude)');
  assert.strictEqual(why.ctx, 'OAuth (signs in through Claude)');
  // Only http: a stdio server never signs in through Claude's OAuth.
  assert.strictEqual(why['plugin:alpha:alpha'], true);
  assert.deepStrictEqual(Object.keys(r(m.p.gateway).servers).sort(), ['alpha', 'own']);
  assert.ok(!JSON.stringify(res).includes('tok-secret'));
  assert.match(status(m.p, '/w', m.env, ok), /direct {5}ctx {2}\(OAuth \(signs in through Claude\)\)/);
});

test('cwd_except: a global server is not served where a project-local one or a disabled plugin takes its place', () => {
  const m = machine();
  const proj = fs.mkdtempSync(path.join(m.home, 'proj-'));
  const real = fs.realpathSync(proj);
  // ctx is replaced by the project's own .mcp.json server, alpha's plugin is off in this project.
  w(path.join(proj, '.mcp.json'), { mcpServers: { ctx: { command: 'mine' } } });
  w(path.join(proj, '.claude', 'settings.local.json'), { enabledPlugins: { 'alpha@m': false } });
  apply(m.p, '/w', m.env, ok);
  apply(m.p, proj, m.env, ok);
  let gw = r(m.p.gateway).servers;
  assert.deepStrictEqual(gw.ctx.cwd_except, [real]);
  assert.deepStrictEqual(gw.alpha.cwd_except, [real]);
  // Neither is switched off in that project: Claude does not start them there anyway, and a
  // disabledMcpServers "ctx" would switch off the project's own ctx too.
  assert.ok(!(proj in r(m.p.claudeJson).projects));
  // Another project's start keeps the exception; it goes once the project no longer needs it.
  apply(m.p, '/w', m.env, ok);
  assert.deepStrictEqual(r(m.p.gateway).servers.ctx.cwd_except, [real]);
  fs.rmSync(path.join(proj, '.mcp.json'));
  fs.rmSync(path.join(proj, '.claude', 'settings.local.json'));
  apply(m.p, proj, m.env, ok);
  gw = r(m.p.gateway).servers;
  assert.ok(!('cwd_except' in gw.ctx) && !('cwd_except' in gw.alpha));

  // A local-scope server of the same name takes the user's place too.
  const cj = r(m.p.claudeJson);
  cj.projects[proj] = { ...(cj.projects[proj] || {}), mcpServers: { ctx: { command: 'loc' } } };
  w(m.p.claudeJson, cj);
  apply(m.p, proj, m.env, ok);
  gw = r(m.p.gateway).servers;
  assert.deepStrictEqual(gw.ctx.cwd_except, [real]);
  assert.strictEqual(gw['ctx@local'].cwd_only, real);
});

