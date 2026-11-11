// Run: node --test mods/oh-my-agent-mod/test/
// codeGraph() and the SubagentStart hook against temp homes and folders, no network.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, tmp, write, run, repo } from './helpers.mjs';
import { codeGraph, onSubagent } from '../scripts/oma.mjs';

const OMA = path.join(ROOT, 'scripts', 'oma.mjs');
const ON = { enabledPlugins: { 'codebase-memory-mod@claude-code-linux': true } };
const OFF = { enabledPlugins: { 'codebase-memory-mod@claude-code-linux': false } };

// A temp home (user settings), cache and project folder, with a graph and the plugin on.
function fx() {
  const t = tmp('oma-cg-');
  const proj = fs.realpathSync(fs.mkdirSync(path.join(t, 'proj'), { recursive: true }) || path.join(t, 'proj'));
  write(path.join(proj, '.codebase-memory', 'graph.db.zst'), '');
  write(path.join(t, 'cfg', 'settings.json'), ON);
  const env = { CLAUDE_CONFIG_DIR: path.join(t, 'cfg'), XDG_CACHE_HOME: path.join(t, 'cache') };
  return { t, proj, env, opts: { env, home: path.join(t, 'home') } };
}

test('codeGraph reports each reason and the project name', () => {
  const { t, proj, opts } = fx();
  const name = proj.replace(/\//g, '-').replace(/^-+/, '');
  assert.deepStrictEqual(codeGraph(proj, opts), { active: true, project: name, reason: 'on' });
  write(path.join(t, 'cache', 'codebase-memory-mcp', 'gate-off'), '');
  assert.deepStrictEqual(codeGraph(proj, opts), { active: false, project: null, reason: 'gate off' });
  fs.rmSync(path.join(t, 'cache'), { recursive: true });
  fs.rmSync(path.join(proj, '.codebase-memory', 'graph.db.zst'));
  assert.strictEqual(codeGraph(proj, opts).reason, 'no graph');
  write(path.join(t, 'cfg', 'settings.json'), {});
  assert.strictEqual(codeGraph(proj, opts).reason, 'plugin not enabled');
});

test('codeGraph settings: later files win, broken ones are skipped, any marketplace counts', () => {
  const { t, proj, opts } = fx();
  write(path.join(proj, '.claude', 'settings.local.json'), OFF);
  assert.strictEqual(codeGraph(proj, opts).reason, 'plugin not enabled');
  fs.rmSync(path.join(proj, '.claude', 'settings.local.json'));
  write(path.join(proj, '.claude', 'settings.json'), '{not json');
  assert.strictEqual(codeGraph(proj, opts).reason, 'on');
  write(path.join(t, 'cfg', 'settings.json'), { enabledPlugins: { 'codebase-memory-mod@other-market': true } });
  assert.strictEqual(codeGraph(proj, opts).reason, 'on');
  write(path.join(t, 'cfg', 'settings.json'), '{not json');
  assert.strictEqual(codeGraph(proj, opts).reason, 'plugin not enabled');
});

test('status carries a codeGraph key', () => {
  const { proj, env } = fx();
  const r = run('node', [OMA, 'status', '--dir', proj], { env: { ...process.env, ...env } });
  // proj is not a git repo here: the state is a problem
  assert.strictEqual(JSON.parse(r.stdout).ok, false);
  // a throwaway git repo with the graph, so the result never depends on the host checkout
  const g = repo();
  write(path.join(g, '.codebase-memory', 'graph.db.zst'), '');
  const s = JSON.parse(run('node', [OMA, 'status', '--dir', g], { env: { ...process.env, ...env } }).stdout);
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.codeGraph.reason, 'on');
});

test('subagent hook text for oma agents, silence otherwise', () => {
  const { t, proj, env } = fx();
  const sub = (input, e = env) => run('node', [OMA, 'subagent'], { input: typeof input === 'string' ? input : JSON.stringify(input), env: { ...process.env, ...e } });
  const W = 'oh-my-agent-mod:worker';
  const name = proj.replace(/\//g, '-').replace(/^-+/, '');

  const blind = sub({ agent_type: 'oh-my-agent-mod:first-timer', cwd: proj });
  assert.strictEqual(blind.stdout, '', 'the first-timer gets no code or file context');
  const on = sub({ agent_type: W, cwd: proj });
  assert.strictEqual(on.status, 0);
  const o = JSON.parse(on.stdout).hookSpecificOutput;
  assert.strictEqual(o.hookEventName, 'SubagentStart');
  assert.ok(o.additionalContext.startsWith('oh-my-agent local files:'), 'every oma agent learns the local-files rule');
  assert.ok(o.additionalContext.includes(`oh-my-agent code search: codebase-memory-mod is on and ${proj} has a graph`));
  assert.ok(o.additionalContext.includes(`with project "${name}"`));
  assert.ok(o.additionalContext.endsWith(`and use the project name it returns, not "${name}".`));

  fs.rmSync(path.join(proj, '.codebase-memory', 'graph.db.zst'));
  const ng = JSON.parse(sub({ agent_type: 'oh-my-agent-mod:merger', cwd: proj }).stdout).hookSpecificOutput.additionalContext;
  assert.ok(ng.endsWith(`oh-my-agent code search: codebase-memory-mod is on but no graph applies in ${proj} (no graph), so Grep, Glob and grep work as usual here.`));
  write(path.join(proj, '.codebase-memory', 'graph.db.zst'), '');

  const quiet = r => { assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, ''); };
  quiet(sub({ agent_type: 'general-purpose', cwd: proj }));
  quiet(sub({ cwd: proj }));
  quiet(sub('not json'));
  // codebase-memory-mod off: no code-search text, but the local-files rule still reaches the agent.
  const off = onSubagent({ agent_type: W, cwd: proj }, { env: { ...env, CLAUDE_CONFIG_DIR: path.join(t, 'nothing') }, home: t });
  assert.match(off, /^oh-my-agent local files:/);
  assert.ok(!off.includes('code search'));
});
