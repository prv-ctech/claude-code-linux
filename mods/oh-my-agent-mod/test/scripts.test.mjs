// Run: node --test mods/oh-my-agent-mod/test/
// guard.mjs, finish-gate.mjs and check.mjs against temp git repos.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, repo, git, write, run } from './helpers.mjs';
import { decide } from '../scripts/guard.mjs';

const GATE = path.join(ROOT, 'scripts', 'finish-gate.mjs');
const CHECK = path.join(ROOT, 'scripts', 'check.mjs');
const W = 'oh-my-agent-mod:worker';

test('guard denies git push and env files for oma agents only, however git is spelled', () => {
  const bash = (command, agent_type = W) => decide({ agent_type, tool_name: 'Bash', tool_input: { command } });
  for (const c of ['git push origin main', 'git -C /x push', 'cd x; git push -u origin HEAD', '/usr/bin/git push', 'bash -c "git push origin x"',
    "sh -c 'git status; git push'", 'env GIT_TRACE=1 git push', 'git -c http.x=y --no-pager push', 'timeout 30 git push', '(git push)', 'echo $(git push)']) {
    assert.match(bash(c), /git push is off/, c);
  }
  for (const c of ['git status && git log', 'git commit -m "Users get push notifications"', 'git add push/handler.ts',
    'git diff --stat main...HEAD -- push/', 'git checkout -b push-alerts', 'git commit -m "Load settings from .env file"', 'npm run push']) {
    assert.strictEqual(bash(c), null, c);
  }
  assert.strictEqual(bash('git push origin main', null), null, 'the person\'s own session is untouched');
  assert.strictEqual(bash('git push', 'other-plugin:worker'), null);
  assert.match(decide({ agent_type: W, tool_name: 'Monitor', tool_input: { command: 'git push' } }), /git push is off/);
  for (const c of ['cat .env', 'grep KEY ./.env.local', 'cat .envrc', 'cat prod.env', 'cat .env-local', 'source .env', 'echo X >> .env']) {
    assert.match(bash(c), /never read \.env/, c);
  }
  for (const c of ['cat .env.example', 'cat .envrc-notes.md', 'ls src/environment.ts']) assert.strictEqual(bash(c), null, c);
  const file = (tool_name, file_path) => decide({ agent_type: W, tool_name, tool_input: { file_path } });
  assert.match(file('Read', '/p/.env'), /never read or write/);
  assert.match(file('Write', '/p/.env.production'), /never read or write/);
  assert.match(file('Read', '/p/.envrc'), /never read or write/);
  assert.strictEqual(file('Read', '/p/.env.example'), null);
  assert.strictEqual(file('Read', '/p/src/env.ts'), null);
  assert.match(decide({ agent_type: W, tool_name: 'Grep', tool_input: { pattern: 'KEY', path: '.', glob: '.env*' } }), /never read/);
  assert.strictEqual(decide({ agent_type: W, tool_name: 'Grep', tool_input: { pattern: 'KEY', path: 'src' } }), null);
  const spawn = t => decide({ agent_type: W, tool_name: 'Agent', tool_input: { subagent_type: t, prompt: 'x' } });
  assert.match(spawn('general-purpose'), /only oh-my-agent-mod/);
  assert.strictEqual(spawn('oh-my-agent-mod:tester'), null);
});

test('guard covers env files in codebase-memory graph tools and leaves code search alone', () => {
  const X = 'mcp__plugin_codebase-memory-mod_codebase-memory-mcp__';
  const cm = (agent_type, t, tool_input) => decide({ agent_type, tool_name: X + t, tool_input });
  const base = { project: 'p', pattern: 'KEY' };
  for (const [t, ti] of [
    ['search_code', { ...base, file_pattern: '.env*' }],
    ['search_code', { ...base, path_filter: 'config/.env' }],
    ['search_code', { ...base, file_pattern: '*.env' }],
    ['search_code', { ...base, file_pattern: '*.ts,.env.local' }],
    ['get_file_outline', { project: 'p', file_path: 'deploy/.env.production' }],
  ]) assert.strictEqual(cm(W, t, ti), 'oh-my-agent agents never read .env files.', JSON.stringify(ti));
  for (const [t, ti] of [
    ['search_code', { ...base, file_pattern: '*.ts' }],
    ['search_code', { ...base, file_pattern: '.env.example' }],
    ['search_graph', { project: 'p', name_pattern: 'env' }],
    ['get_file_outline', { project: 'p', file_path: 'src/environment.ts' }],
    ['search_code', undefined],
    ['search_code', { ...base, file_pattern: 5 }],
  ]) assert.strictEqual(cm(W, t, ti), null, JSON.stringify(ti));
  assert.strictEqual(cm(undefined, 'search_code', { ...base, file_pattern: '.env*' }), null);
  assert.strictEqual(cm('other:agent', 'get_file_outline', { project: 'p', file_path: '.env' }), null);
  for (const [tool_name, tool_input] of [['Grep', { pattern: 'foo', path: 'src' }], ['Glob', { pattern: '**/*.ts' }],
    ['Bash', { command: 'grep -rn foo src' }], ['Bash', { command: 'find . -name "*.ts"' }]]) {
    assert.strictEqual(decide({ agent_type: W, tool_name, tool_input }), null, tool_name);
  }
});

test('guard hook prints a PreToolUse deny and nothing otherwise', () => {
  const r = run('node', [path.join(ROOT, 'scripts', 'guard.mjs')], { input: JSON.stringify({ agent_type: W, tool_name: 'Bash', tool_input: { command: 'git push' } }) });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const quiet = run('node', [path.join(ROOT, 'scripts', 'guard.mjs')], { input: 'not json' });
  assert.strictEqual(quiet.status, 0);
  assert.strictEqual(quiet.stdout, '');
});

function worktree(dir, name = 'agent-abc12345') {
  const wt = path.join(dir, '.claude', 'worktrees', name);
  git(dir, 'worktree', 'add', '-q', '-b', `worktree-${name}`, wt);
  return wt;
}

const gate = (input, env = {}) => {
  const r = run('node', [GATE], { input: JSON.stringify(input), env });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
};

test('finish gate blocks an unfinished worker, passes a finished one, and gives up after 3 blocks', () => {
  const dir = repo();
  const wt = worktree(dir);
  const status = s => write(path.join(wt, '.oma', 'job', 'status.json'), { ticket: '004', slug: '004-x', step: 'building', evals: { passed: 0, failed: 0, total: 0, round: 0 }, ...s });
  status({});
  let out = gate({ agent_type: W, cwd: wt, agent_id: 'abc12345' });
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, /block 1 of 3/);
  assert.match(out.reason, /step is "building"/);
  // Not a worker: never gated.
  assert.strictEqual(gate({ agent_type: 'oh-my-agent-mod:tester', cwd: wt }), null);
  // Uncommitted change blocks even when the status says done.
  status({ step: 'done', evals: { passed: 3, failed: 0, total: 3, round: 1 } });
  write(path.join(wt, 'feature.txt'), 'x');
  out = gate({ agent_type: W, cwd: wt, last_assistant_message: 'a' });
  assert.match(out.reason, /uncommitted changes/);
  git(wt, 'add', 'feature.txt');
  git(wt, 'commit', '-q', '-m', 'feature');
  assert.strictEqual(gate({ agent_type: W, cwd: wt }), null, 'done, 0 failed, clean: lets it stop');
  // Blocked with a note: through at once.
  status({ step: 'blocked', note: 'ticket contradicts itself' });
  out = gate({ agent_type: W, cwd: wt });
  assert.match(out.systemMessage, /stopped as blocked/);
  // Three blocks, then let through.
  status({ step: 'fixing', evals: { passed: 1, failed: 2, total: 3, round: 3 } });
  for (let i = 1; i <= 3; i++) assert.strictEqual(gate({ agent_type: W, cwd: wt, last_assistant_message: `m${i}` }).decision, 'block');
  out = gate({ agent_type: W, cwd: wt, last_assistant_message: 'm4' });
  assert.match(out.systemMessage, /let .* through after 3 blocks/);
});

test('finish gate finds the worktree from the agent id when cwd is the main checkout', () => {
  const dir = repo();
  const wt = worktree(dir, 'agent-feedface99');
  write(path.join(wt, '.oma', 'job', 'status.json'), { step: 'building', evals: {} });
  const out = gate({ agent_type: W, cwd: dir, agent_id: 'feedface99' }, { CLAUDE_PROJECT_DIR: dir });
  assert.strictEqual(out.decision, 'block');
  assert.ok(out.reason.includes(wt));
});

const check = (dir, ...args) => {
  const r = run('node', [CHECK, '--root', dir, ...args]);
  assert.strictEqual(r.status, 0, r.stderr);
  return { lines: r.stdout.split('\n').filter(Boolean).map(l => JSON.parse(l)), stderr: r.stderr };
};

test('check flags stale, blocked and drifting workers from .oma/job status files', () => {
  const dir = repo();
  write(path.join(dir, '.oma', 'watchdog-rules.md'), '```json\n{"healthPaths": [], "browserWalkEveryNRounds": 2}\n```\n');
  write(path.join(dir, 'specs', 'tickets', '004-seo', 'rd.md'), '# 004\n\n## Affected areas\n- `src/seo/`: the panel\n\n## Do not touch\n- none\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'ticket');
  const wt = worktree(dir, 'agent-004');
  const old = new Date(Date.now() - 40 * 60000).toISOString();
  write(path.join(wt, '.oma', 'job', 'status.json'), { ticket: '004', slug: '004-seo', step: 'building', stepStarted: old, updated: old, evals: { passed: 0, failed: 0, total: 0, round: 0 } });
  write(path.join(wt, 'src', 'auth.ts'), 'x');
  write(path.join(wt, 'src', 'seo', 'panel.ts'), 'x');
  worktree(dir, 'my-own-experiment'); // the person's own worktree: never watched
  const wt2 = worktree(dir, 'agent-005');
  write(path.join(wt2, '.oma', 'job', 'status.json'), { ticket: '005', step: 'blocked', note: 'needs plan names', updated: new Date().toISOString() });

  let r = check(dir, '--tick');
  const kinds = r.lines.map(l => `${l.kind}:${l.ticket || ''}`);
  assert.ok(!r.lines.some(l => /my-own-experiment/.test(l.detail || '')), 'own worktree ignored');
  assert.deepStrictEqual(r.lines[0], { kind: 'tick', round: 1 });
  assert.ok(kinds.includes('stale:004'), kinds.join());
  assert.ok(kinds.includes('blocked:005'), kinds.join());
  const drift = r.lines.find(l => l.kind === 'drift');
  assert.match(drift.detail, /src\/auth\.ts/);
  assert.doesNotMatch(drift.detail, /panel\.ts/);
  assert.ok(fs.existsSync(path.join(dir, '.oma', 'job', 'watchdog-state.json')));
  // healthPaths [] means no server: never a walk.
  r = check(dir, '--tick');
  assert.ok(!r.lines.some(l => l.kind === 'walk-due'));
  assert.match(r.lines.find(l => l.kind === 'stale').detail, /first flagged/);
});

test('check prints walk-due on every Nth tick when the app answers', async () => {
  const http = await import('node:http');
  const server = http.createServer((q, s) => s.end('ok')).listen(0);
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  try {
    const dir = repo();
    write(path.join(dir, '.oma', 'watchdog-rules.md'), `\`\`\`json\n{"appUrl": "http://127.0.0.1:${port}", "healthPaths": ["/"], "browserWalkEveryNRounds": 2}\n\`\`\`\n`);
    const runAsync = args => new Promise((res, rej) => {
      import('node:child_process').then(({ execFile }) => execFile('node', [CHECK, '--root', dir, ...args], (e, out) => (e ? rej(e) : res(out))));
    });
    const first = await runAsync(['--tick']);
    assert.ok(!first.includes('walk-due'));
    const second = await runAsync(['--tick']);
    assert.match(second, /"kind":"walk-due","round":2/);
  } finally {
    server.close();
  }
});

test('check warns on a broken rules file and falls back to defaults', () => {
  const dir = repo();
  write(path.join(dir, '.oma', 'watchdog-rules.md'), '```json\n{ not json\n```\n');
  const r = check(dir, '--tick');
  assert.match(r.stderr, /not valid JSON/);
});

test('check says app-not-running once per streak and still calls walks', async () => {
  const net = await import('node:net');
  const srv = net.createServer().listen(0);
  await new Promise(r => srv.once('listening', r));
  const port = srv.address().port;
  await new Promise(r => srv.close(r)); // free again: nothing answers there
  const dir = repo();
  write(path.join(dir, '.oma', 'watchdog-rules.md'), '```json\n{"appUrl": "http://127.0.0.1:' + port + '", "healthPaths": ["/"], "browserWalkEveryNRounds": 2}\n```\n');
  const kinds = () => check(dir, '--tick').lines.map(l => l.kind);
  assert.deepStrictEqual(kinds(), ['tick', 'app-not-running']);
  assert.deepStrictEqual(kinds(), ['tick', 'walk-due']);
  assert.deepStrictEqual(kinds(), ['tick']);
});
