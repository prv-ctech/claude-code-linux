// Run: node --test mods/oh-my-context-mod/test/
// permit.js and prompt.js against temp files and a stubbed `oh-my-context hint`.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { decide, ruleMatches, ruleFiles } = require('../hooks/permit.js');
const { hint, SUBAGENT_HINT } = require('../hooks/prompt.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-my-context-hooks-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const w = (f, data) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data));
};

const user = path.join(dir, 'user.json');
const project = path.join(dir, 'project.json');
w(user, { permissions: { allow: ['mcp__plugin_alpha_alpha__*', 'mcp__ctx__wipe_cache'], ask: ['mcp__ctx'], deny: ['Bash(rm *)'] } });
w(project, { permissions: { deny: ['mcp__plugin_alpha_alpha__drop_db'] } });
const opts = {
  files: [path.join(dir, 'missing-managed.json'), user, project],
  servers: { alpha: { claude_prefix: 'mcp__plugin_alpha_alpha' }, b: { claude_prefix: 'mcp__b' } },
};
const call = (toolInput, mode = 'default') => decide({ tool_input: toolInput, permission_mode: mode }, opts);

test('permit maps a routed call to its original tool and applies deny > ask > allow', () => {
  assert.deepStrictEqual(call({ server: 'alpha', tool: 'drop_db' }), {
    decision: 'deny', reason: 'routed call to mcp__plugin_alpha_alpha__drop_db: your deny rule "mcp__plugin_alpha_alpha__drop_db" applies',
  });
  assert.strictEqual(call({ server: 'alpha', tool: 'read', arguments: {} }).decision, 'allow');
  assert.strictEqual(call({ server: 'alpha', tool: 'mcp__plugin_alpha_alpha__read' }).decision, 'allow');
  assert.strictEqual(call({ tool: 'mcp__ctx__query' }).decision, 'ask');
  // ask beats allow for the same tool.
  assert.strictEqual(call({ tool: 'mcp__ctx__wipe_cache' }).decision, 'ask');
});

test('permit: no rule asks, as Claude would, except in auto and bypassPermissions mode', () => {
  assert.deepStrictEqual(call({ server: 'b', tool: 'list_items' }), {
    decision: 'ask', reason: 'routed call to mcp__b__list_items: no permission rule matches it; allow "mcp__b" or "mcp__b__list_items" to skip this prompt',
  });
  for (const mode of ['default', 'acceptEdits', 'plan', 'dontAsk']) assert.strictEqual(call({ tool: 'mcp__b__list' }, mode).decision, 'ask', mode);
  for (const mode of ['auto', 'bypassPermissions']) assert.strictEqual(call({ server: 'b', tool: 'deleteItem' }, mode), null, mode);
});

test('permit: an mcp__ name is normalized like Claude\'s, so a deny rule cannot be dodged', () => {
  const files = [user, project];
  w(project, { permissions: { deny: ['mcp__fs__files_delete'] } });
  try {
    for (const mode of ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions']) {
      const d = decide({ tool_input: { tool: 'mcp__fs__files.delete' }, permission_mode: mode }, { files, servers: {} });
      assert.strictEqual(d.decision, 'deny', mode);
    }
  } finally {
    w(project, { permissions: { deny: ['mcp__plugin_alpha_alpha__drop_db'] } });
  }
});

test('permit maps exactly the two forms the gateway runs and denies every other', () => {
  const denied = ti => {
    const d = call(ti, 'bypassPermissions');
    assert.strictEqual(d && d.decision, 'deny', JSON.stringify(ti));
    return d.reason;
  };
  assert.match(denied({}), /pass `tool` as the original tool name \(mcp__<server>__<tool>\), or `server` plus `tool`/);
  // server_tool or bare names: the gateway would have to guess the server.
  denied({ name: 'b_wipe' });
  denied({ tool: 'b_x' });
  denied({ name: 'mcp__b__x' });
  denied({ server: 'alpha', name: 'b_wipe' });
  // A `name` next to a valid form, or a server that is not the one the mcp__ name belongs to.
  denied({ tool: 'mcp__b__list', name: 'mcp__plugin_alpha_alpha__drop_db' });
  denied({ server: 'alpha', tool: 'x', name: 'mcp__plugin_alpha_alpha__drop_db' });
  denied({ server: 'alpha', tool: 'mcp__b__wipe' });
  denied({ server: 'unknown', tool: 'delete' });
  denied({ tool_name: 'mcp__b__x' });
  assert.strictEqual(call({ server: 'b', tool: 'mcp__b__list' }, 'auto'), null);
  assert.strictEqual(call({ tool: 'mcp__b__list' }, 'auto'), null);
});

test('permit reads managed drop-ins, and project rules from the project root, not a cd', () => {
  const managedDir = path.join(dir, 'managed');
  w(path.join(managedDir, 'managed-settings.d', '10-policy.json'), { permissions: { deny: ['mcp__b__wipe'] } });
  w(path.join(managedDir, 'managed-settings.d', '.hidden.json'), { permissions: { allow: ['mcp__b'] } });
  const files = ruleFiles({ managedDir, settings: user }, '/proj');
  assert.deepStrictEqual(files, [path.join(managedDir, 'managed-settings.json'), path.join(managedDir, 'managed-settings.d', '10-policy.json'),
    user, '/proj/.claude/settings.json', '/proj/.claude/settings.local.json']);
  assert.strictEqual(decide({ tool_input: { server: 'b', tool: 'wipe' } }, { files, servers: opts.servers }).decision, 'deny');

  const home = path.join(dir, 'home');
  const proj = path.join(dir, 'proj');
  w(path.join(home, '.claude', 'oh-my-context-mod', 'state.json'), { paths: { gateway: path.join(home, 'gw.json') } });
  w(path.join(home, 'gw.json'), { servers: { gh: { claude_prefix: 'mcp__gh' } } });
  w(path.join(proj, '.claude', 'settings.json'), { permissions: { deny: ['mcp__gh__delete_repo'] } });
  w(path.join(proj, 'sub', '.claude', 'settings.json'), { permissions: { allow: ['mcp__gh'] } });
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'permit.js')], {
    input: JSON.stringify({ cwd: path.join(proj, 'sub'), permission_mode: 'default', tool_input: { server: 'gh', tool: 'delete_repo' } }),
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, CLAUDE_PROJECT_DIR: proj },
  });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.strictEqual(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('permit rule forms', () => {
  assert.ok(ruleMatches('mcp__b', 'mcp__b__x'));
  assert.ok(!ruleMatches('mcp__b', 'mcp__bb__x'));
  assert.ok(ruleMatches('mcp__*__write*', 'mcp__b__write_file'));
  assert.ok(!ruleMatches('mcp__b__x', 'mcp__b__xy'));
});

test('permit.js never breaks the call path', () => {
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'permit.js')], {
    input: 'not json', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir },
  });
  assert.strictEqual(run.status, 0);
  assert.strictEqual(run.stdout, '');
});

test('prompt hint: one line of names, skipped for short prompts, /commands and repeats', () => {
  const stateDir = path.join(dir, 'state');
  let fed = null;
  const out = { skills: [{ name: 'superpowers:brainstorming', score: 3 }], tools: [{ server: 'rea', tool: 'open_binary', claude_name: 'mcp__plugin_rea-mod_rea__open_binary', score: 2 }] };
  const run = prompt => {
    fed = prompt;
    return { status: 0, stdout: JSON.stringify(out) };
  };
  const dataDir = path.join(dir, 'data');
  const ask = (prompt, sid = 's1') => hint({ prompt, session_id: sid }, { run, stateDir, dataDir });
  assert.strictEqual(ask('help me plan a reverse engineering job'),
    'Routed matches for this prompt: skills superpowers:brainstorming; tools mcp__plugin_rea-mod_rea__open_binary');
  assert.strictEqual(fed, 'help me plan a reverse engineering job');
  assert.strictEqual(ask('help me plan a reverse engineering job again'), null, 'same line as last time');
  assert.match(ask('help me plan a reverse engineering job', 's2'), /^Routed matches/);
  assert.strictEqual(ask('short'), null);
  assert.strictEqual(ask('/omc status please'), null);
  out.tools = [];
  assert.strictEqual(ask('a different and long enough prompt'), 'Routed matches for this prompt: skills superpowers:brainstorming');
  out.skills = [];
  assert.strictEqual(ask('nothing matches this long prompt'), null);
  assert.strictEqual(hint({ prompt: 'a long enough prompt here' }, { run: () => ({ status: 3, stdout: '' }), stateDir }), null);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'off'), '');
  out.skills = [{ name: 'x' }];
  assert.strictEqual(ask('the mod is off, so no hints at all'), null);
});

test('prompt.js exits 0 silently on bad input', () => {
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'prompt.js')], {
    input: '{', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir },
  });
  assert.strictEqual(run.status, 0);
  assert.strictEqual(run.stdout, '');
});

test('prompt hint: in hide mode ids are followed by the load_skill instruction, and only when skills match', () => {
  const stateDir = path.join(dir, 'state-hide');
  const out = { skills: [{ id: 'ecc:docker-patterns', name: 'ecc:docker-patterns', desc: 'x', score: 3 }, { name: 'plain' }], tools: [] };
  const ask = (prompt, hide = true) => hint({ prompt, session_id: 'h' }, { run: () => ({ status: 0, stdout: JSON.stringify(out) }), stateDir, hide });
  assert.strictEqual(ask('write a Dockerfile for the service'),
    'Routed matches for this prompt: skills ecc:docker-patterns, plain\n'
    + 'Skills are hidden from the native list: load one with load_skill(<id>) (resolve_skills searches); never Read a path or use the Skill tool.');
  assert.strictEqual(ask('write a Dockerfile for the other service', false), 'Routed matches for this prompt: skills ecc:docker-patterns, plain');
  out.skills = [];
  out.tools = [{ claude_name: 'mcp__x__y' }];
  assert.strictEqual(ask('only a tool matches this long prompt'), 'Routed matches for this prompt: tools mcp__x__y');
  out.tools = [];
  assert.strictEqual(ask('nothing matches at all, quiet'), null);
});

// A fake <claude>/oh-my-context-mod with a state file, run through the real hook scripts.
const home = path.join(dir, 'hide-home');
const modState = path.join(home, '.claude', 'oh-my-context-mod');
const hook = (file, input, args = []) => spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', file), ...args], {
  input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: home },
});
test('SubagentStart hook: additionalContext only in hide mode', () => {
  assert.strictEqual(hook('prompt.js', { agent_id: 'a', agent_type: 'Explore' }, ['subagent']).stdout, '', 'no state: off');
  w(path.join(modState, 'state.json'), { hide: false });
  assert.strictEqual(hook('prompt.js', {}, ['subagent']).stdout, '');
  w(path.join(modState, 'state.json'), { hide: true });
  const r = hook('prompt.js', { agent_id: 'a', agent_type: 'Explore' }, ['subagent']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: SUBAGENT_HINT } });
  assert.match(SUBAGENT_HINT, /resolve_skills.*load_skill.*never Read a path or use the Skill tool/);
});

test('hooks.json wires SubagentStart and no Skill gate', () => {
  const h = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const cmds = h.SubagentStart.flatMap(g => g.hooks.map(x => x.command));
  assert.ok(cmds.some(c => /prompt\.js" subagent$/.test(c)));
  assert.ok(!h.PreToolUse.some(g => g.matcher === 'Skill'));
});
