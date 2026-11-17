// Run: node --test mods/oh-my-agent-mod/test/
// guard.mjs, finish-gate.mjs and check.mjs against temp git repos.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, tmp, repo, git, write, run } from './helpers.mjs';
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
  for (const c of ['git add .oma/project.md', 'git add -f specs/tickets/001-x/rd.md', 'git commit -m x -- specs/tickets/BOARD.md', 'git -C /w add ./.oma/job']) {
    assert.match(bash(c), /local and never committed/, c);
  }
  for (const c of ['git status -- .oma', 'git add specs/other.md', 'git log -- specs/tickets', 'git add src/oma/x.ts']) assert.strictEqual(bash(c), null, c);
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
  assert.strictEqual(spawn('oh-my-agent-mod:reviewer'), null);
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
  assert.strictEqual(gate({ agent_type: 'oh-my-agent-mod:reviewer', cwd: wt }), null);
  // Uncommitted change blocks even when the status says done.
  status({ step: 'done', evals: { passed: 3, failed: 0, total: 3, round: 1 } });
  write(path.join(wt, 'feature.txt'), 'x');
  out = gate({ agent_type: W, cwd: wt, last_assistant_message: 'a' });
  assert.match(out.reason, /uncommitted changes/);
  git(wt, 'add', 'feature.txt');
  git(wt, 'commit', '-q', '-m', 'feature');
  assert.strictEqual(gate({ agent_type: W, cwd: wt }), null, 'done, 0 failed, clean: lets it stop');
  // Local oma files (tickets, results, evidence) are never committed, even where .gitignore doesn't list them yet.
  write(path.join(wt, 'specs', 'tickets', '004-x', 'results.md'), 'E-1 | PASS | ok');
  write(path.join(wt, 'specs', 'tickets', '004-x', 'evidence', 'E-1.md'), 'ok');
  write(path.join(wt, 'specs', 'tickets', 'BOARD.md'), 'x');
  assert.strictEqual(gate({ agent_type: W, cwd: wt }), null, 'untracked oma files do not block');
  write(path.join(wt, 'other', 'x.txt'), 'x');
  assert.match(gate({ agent_type: W, cwd: wt, last_assistant_message: 'b' }).reason, /\?\? other\/x\.txt/, 'real changes still block');
  fs.rmSync(path.join(wt, 'other'), { recursive: true });
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
  write(path.join(dir, '.oma', 'watchdog-rules.md'), '```json\n{"healthPaths": []}\n```\n');
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
  r = check(dir, '--tick');
  assert.match(r.lines.find(l => l.kind === 'stale').detail, /first flagged/);
});

test('check warns on a broken rules file and falls back to defaults', () => {
  const dir = repo();
  write(path.join(dir, '.oma', 'watchdog-rules.md'), '```json\n{ not json\n```\n');
  const r = check(dir, '--tick');
  assert.match(r.stderr, /not valid JSON/);
});

test('check says app-not-running once per streak', async () => {
  const net = await import('node:net');
  const srv = net.createServer().listen(0);
  await new Promise(r => srv.once('listening', r));
  const port = srv.address().port;
  await new Promise(r => srv.close(r)); // free again: nothing answers there
  const dir = repo();
  write(path.join(dir, '.oma', 'watchdog-rules.md'), '```json\n{"appUrl": "http://127.0.0.1:' + port + '", "healthPaths": ["/"]}\n```\n');
  const kinds = () => check(dir, '--tick').lines.map(l => l.kind);
  assert.deepStrictEqual(kinds(), ['tick', 'app-not-running']);
  assert.deepStrictEqual(kinds(), ['tick']);
});

test('guard keeps the first-timer blind: browser only, oma up/serve/stop/port, writes under .oma/job/first-timer', () => {
  const F = 'oh-my-agent-mod:first-timer';
  const d = (tool_name, tool_input) => decide({ agent_type: F, tool_name, tool_input, cwd: '/p' });
  for (const command of ['oma up 3000', 'oma serve 3000', 'oma stop 3000', 'oma port 3000', 'node /p/oh-my-agent-mod/bin/oma up 3000', 'cd /work/app', "cd '/work/my app' && oma up 3000", 'node "/x/oh-my-agent-mod/bin/oma" up 3000', 'oma up 3000 > /dev/null 2>&1']) {
    assert.strictEqual(d('Bash', { command }), null, command);
  }
  for (const command of ['cat README.md', 'oma serve 3000 && cat src/a.js', 'oma cfg', 'git log', 'ls src', 'oma up 3000; ls', 'node /tmp/evil/bin/oma up 3000', 'node /w/oh-my-agent-mod/../../usr/bin/oma up 3000']) {
    assert.match(d('Bash', { command }) || '', /stays blind/, command);
  }
  assert.strictEqual(d('Write', { file_path: '/p/.oma/job/first-timer/report.md' }), null);
  assert.match(d('Write', { file_path: '/p/src/x.md' }), /stays blind/);
  assert.match(d('Write', { file_path: '/p/.oma/job/first-timer/../../../src/x.md' }), /stays blind/);
  assert.match(d('Write', { file_path: '/elsewhere/.oma/job/first-timer/x.md' }), /stays blind/, 'only this project');
  assert.strictEqual(d('Bash', { command: 'cd "/work/my app"' }), null);
  for (const url of ['file:///etc/passwd', 'https://example.com', 'http://localhost.example.com/']) {
    assert.match(d('mcp__Claude_Browser__navigate', { url }) || '', /stays blind/, url);
  }
  assert.strictEqual(d('mcp__Claude_Browser__navigate', { url: 'http://checker.localhost:3000/a' }), null);
  assert.match(d('mcp__context7__query-docs', {}) || '', /stays blind/);
  for (const tool of ['Read', 'Edit', 'Grep', 'Glob', 'Agent', 'mcp__plugin_codebase-memory-mod_codebase-memory-mcp__search_code', 'mcp__plugin_oh-my-context-mod_oh-my-context__call']) {
    assert.match(d(tool, { file_path: '/p/a.js', pattern: 'x' }) || '', /stays blind/, tool);
  }
  assert.strictEqual(d('mcp__Claude_Browser__navigate', { url: 'http://localhost:3000' }), null);
  assert.strictEqual(decide({ agent_type: W, tool_name: 'Read', tool_input: { file_path: '/p/src/a.js' } }), null, 'other agents unaffected');
  assert.match(d('Bash', { command: 'git push' }) || '', /blind/);
});

test('guard leaves docker push next to git alone', () => {
  const out = decide({ agent_type: 'oh-my-agent-mod:worker', tool_name: 'Bash', tool_input: { command: 'git add "$f" && docker push $IMG' } });
  assert.equal(out, null);
});

test('guard catches git push behind shell keywords and eval, and untyped Agent calls', () => {
  const bash = command => decide({ agent_type: W, tool_name: 'Bash', tool_input: { command } });
  for (const c of ['if true; then git push; fi', '{ git push; }', '! git push', 'eval git push', 'eval "git push"', 'G=git; $G push', 'P=push; git $P origin main', 'env -u FOO git push', 'sudo -u root git push', 'timeout -s KILL 5 git push', 'bash -c "cat .env.local"', "env -S 'git push origin main'", "git -c alias.u='push origin HEAD' u", 'cat .env>/dev/stdout', 'git {push,} origin main', 'cat .{env,}', 'git send-pack origin main', 'setsid git push origin HEAD', 'flock /tmp/l git push origin HEAD', 'git {pu,x}sh origin HEAD', 'cat .e{nv,x}', 'grep -f .env src/app.ts', "cat .$'env'", 'grep -eKEY .env', 'git subtree push --prefix x origin main', 'git lfs push origin --all', "git config alias.u 'push origin HEAD'", "git rebase --exec 'git push origin HEAD' HEAD~1", 'git submodule foreach git push', 'git --attr-source HEAD push origin main', 'bash <<EOF\ngit push origin HEAD\nEOF', 'find . -maxdepth 0 -exec git push origin HEAD \\;', 'rg --hidden -g .env KEY .', 'git \\\npush origin main', 'cat .en\\\nv', 'git-send-pack origin main', '/usr/lib/git-core/git-push', "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.u GIT_CONFIG_VALUE_0='push origin HEAD' git u", 'cat config/app.env.local', 'grep -- -x .env', '$(which git) push origin main', 'bash <<< "git push"', 'source <(echo git push)', 'cat .env*', 'cat .e?v', 'cat .en[v]', 'echo .env | xargs cat', '{git,} push origin HEAD', 'git http-push http://example.invalid/r.git HEAD', 'function f { git push origin main; }; f', '>/dev/null git push origin main', '> /tmp/x.log git push origin main', 'cat $(echo .env)', 'git commit -m fix;git push origin HEAD', 'echo -m a;cat .env', 'f() { git push; }; f', `git -c alias.u='!git pu""sh origin HEAD' u`]) assert.ok(bash(c), c);
  for (const c of ['git status', 'echo then', 'eval echo ok', 'git commit -m "push notifications"', 'git add push/handler.ts', 'npm run push-notifications', 'cat src/*.ts', 'cat .env.example', 'git log --oneline --grep push', 'git grep -n "push" -- src', 'grep "a[" README.md', 'ls *', 'git grep -n push "$DIR"', 'git grep -n push -- lib/source', 'git commit -m "docs: explain .oma/ layout"', 'git log --oneline --grep=commit -- specs/tickets/', 'grep -n "\\.env" src/config.ts']) assert.strictEqual(bash(c), null, c);
  for (const c of ['grep KEY .env', 'rg -n token .env.local']) assert.ok(bash(c), c);
  for (const c of ['git -C . add specs/tickets/a', 'git commit specs/tickets/a -m x']) assert.ok(bash(c), c);
  const cm = 'mcp__plugin_codebase-memory-mod_codebase-memory-mcp__search_code';
  for (const fp of ['.*env', '[.]env']) assert.ok(decide({ agent_type: W, tool_name: cm, tool_input: { file_pattern: fp } }), fp);
  assert.strictEqual(decide({ agent_type: W, tool_name: cm, tool_input: { file_pattern: '*.ts' } }), null);
  // The same tool routed through oh-my-context's call, by original name or by server.
  const via = tool_input => decide({ agent_type: W, tool_name: 'mcp__plugin_oh-my-context-mod_oh-my-context__call', tool_input });
  assert.ok(via({ tool: cm, arguments: { file_pattern: '.env' } }));
  assert.ok(via({ server: 'codebase-memory-mcp', tool: 'search_code', arguments: { path_filter: '[.]env' } }));
  assert.strictEqual(via({ tool: cm, arguments: { file_pattern: '*.ts' } }), null);
  assert.strictEqual(via({ tool: 'mcp__context7__query-docs', arguments: { file_pattern: '.env' } }), null);
  assert.ok(decide({ agent_type: W, tool_name: 'Task', tool_input: { subagent_type: 'general-purpose' } }));
  assert.ok(decide({ agent_type: 'oh-my-agent-mod:first-timer', tool_name: 'mcp__Claude_Browser__javascript_tool', tool_input: { text: '1' }, cwd: '/p' }));
  assert.ok(decide({ agent_type: W, tool_name: 'Agent', tool_input: { prompt: 'x' } }), 'no subagent_type means the default agent');
  assert.strictEqual(decide({ agent_type: W, tool_name: 'Agent', tool_input: { subagent_type: 'oh-my-agent-mod:reviewer' } }), null);
});

test('approval: only /oma approve records it; a worker starts only on an approved, unchanged ticket', async () => {
  const { onPrompt, paths } = await import('../scripts/oma.mjs');
  const { state } = await import('../scripts/approve.mjs');
  const dir = repo();
  const t = path.join(dir, 'specs', 'tickets', '004-seo');
  write(path.join(t, 'rd.md'), '# 004\n\n**Status:** draft\n\n## Summary\nSEO panel\n');
  write(path.join(t, 'eval.md'), '# 004\n\n## Setup\nstart\n\n## Acceptance checks\n\n### E-1: title saves (covers FR-1)\n- **Expected**: saved\n\n## Traceability\n| FR-1 | E-1 |\n');
  write(path.join(dir, 'specs', 'tickets', 'BOARD.md'), '| # | Title | Status | Mode | Runs |\n|---|---|---|---|---|\n| 004 | SEO | draft | solo | alongside |\n');
  const start = prompt => decide({ tool_name: 'Agent', cwd: dir, tool_input: { subagent_type: 'oh-my-agent-mod:worker', prompt } });
  const P = 'Ticket: specs/tickets/004-seo\nPort: 3104';
  assert.match(start(P), /has not approved it.*\/oma approve/);
  assert.deepStrictEqual(state(dir).approved, []);

  const p = paths({ CLAUDE_CONFIG_DIR: tmp('oma-home-') });
  // A bare approve, or one naming another ticket, approves nothing: the user may not have seen 004.
  assert.match(onPrompt(p, { session_id: 'A', prompt: '/oma approve' }, dir), /Nothing was approved.*Still waiting for approval: 004-seo/);
  assert.match(onPrompt(p, { session_id: 'A', prompt: '/oma approve 005' }, dir), /Nothing was approved/);
  assert.ok(start(P));
  assert.match(onPrompt(p, { session_id: 'A', prompt: '/oma approve 4' }, dir), /Recorded as approved.*004-seo/);
  assert.strictEqual(start(P), null);
  assert.doesNotMatch(onPrompt(p, { session_id: 'A', prompt: '/oma approve all' }, dir), /Still waiting/);

  // Status moves and added checks keep approval; an edited check or requirement loses it.
  const ev = fs.readFileSync(path.join(t, 'eval.md'), 'utf8');
  write(path.join(t, 'rd.md'), '# 004\n\n**Status:** ready\n\n## Summary\nSEO panel\n');
  write(path.join(t, 'eval.md'), ev.replace('## Traceability', '### E-2: empty title (covers FR-1)\n- **Expected**: page name\n\n## Traceability').replace('| E-1 |', '| E-1, E-2 |'));
  assert.strictEqual(start(P), null);
  write(path.join(t, 'eval.md'), ev.replace('saved', 'anything'));
  assert.match(start(P), /approved parts of its eval\.md changed.*E-1/);
  write(path.join(t, 'eval.md'), ev);
  write(path.join(t, 'rd.md'), '# 004\n\n**Status:** ready\n\n## Summary\nSEO panel and sitemap\n');
  assert.match(start(P), /rd\.md changed/);

  // Nobody edits the manifest, in any session; other agents and other tickets are untouched.
  const f = path.join(dir, '.oma', 'approved.json');
  assert.ok(decide({ tool_name: 'Write', tool_input: { file_path: f } }));
  assert.ok(decide({ agent_type: 'oh-my-agent-mod:ticket-writer', tool_name: 'Edit', tool_input: { file_path: f } }));
  assert.ok(decide({ tool_name: 'Bash', tool_input: { command: 'echo {} > .oma/approved.json' } }));
  assert.strictEqual(decide({ tool_name: 'Bash', tool_input: { command: 'cat .oma/approved.json' } }), null);
  assert.strictEqual(decide({ tool_name: 'Agent', cwd: dir, tool_input: { subagent_type: 'general-purpose', prompt: P } }), null);
  assert.strictEqual(decide({ tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src', 'a.js') } }), null);
});

test('check --overlap lists ticket pairs that share a path and says whether the board orders them', () => {
  const dir = repo();
  const rd = areas => `# t\n\n## Affected areas\n${areas.map(a => `- \`${a}\`: x`).join('\n')}\n\n## Do not touch\n- none\n`;
  write(path.join(dir, 'specs', 'tickets', '010-music', 'rd.md'), rd(['src/music/', 'src/db/schema.ts']));
  write(path.join(dir, 'specs', 'tickets', '020-iptv', 'rd.md'), rd(['src/iptv/**', 'src/db/schema.ts']));
  write(path.join(dir, 'specs', 'tickets', '030-anime', 'rd.md'), rd(['src/anime/', 'src/music/player.ts']));
  write(path.join(dir, 'specs', 'tickets', '040-old', 'rd.md'), rd(['src/music/']));
  write(path.join(dir, 'specs', 'tickets', 'BOARD.md'), '| # | Title | Status | Mode | Runs |\n|---|---|---|---|---|\n| 010 | Music | draft | solo | alongside |\n| 020 | IPTV | draft | solo | waits for 010: schema |\n| 030 | Anime | draft | solo | alongside |\n| 040 | Old | done | solo | alongside |\n');
  const lines = check(dir, '--overlap').lines;
  assert.deepStrictEqual(lines, [
    { kind: 'overlap', tickets: ['010', '020'], paths: ['src/db/schema.ts'], ordered: true },
    { kind: 'overlap', tickets: ['010', '030'], paths: ['src/music/player.ts'], ordered: false },
  ]);
});

test('plan-reviewer is read-only and every agent the router names exists', () => {
  const fm = fs.readFileSync(path.join(ROOT, 'agents', 'plan-reviewer.md'), 'utf8').split('---')[1];
  assert.match(fm, /^name: plan-reviewer$/m);
  assert.match(fm, /^disallowedTools: Edit, Write, NotebookEdit, Agent$/m);
});

test('blind visitors: own folder each, only this app\'s ports, Haiku; reviewers are read-only', () => {
  const dir = repo({ mainPort: 4000 });
  const d = (tool_name, tool_input) => decide({ agent_type: 'oh-my-agent-mod:first-timer', tool_name, tool_input, cwd: dir });
  assert.strictEqual(d('Write', { file_path: path.join(dir, '.oma/job/first-timer/v2/report.md') }), null);
  assert.match(d('Write', { file_path: path.join(dir, '.oma/job/first-timer/v2/deep/x.md') }), /stays blind/);
  assert.match(d('Write', { file_path: path.join(dir, '.oma/job/first-timer/../x.md') }), /stays blind/);
  for (const url of ['http://localhost:4000/a', 'http://v1.localhost:3080', 'http://127.0.0.1:3080/x?y']) assert.strictEqual(d('mcp__Claude_Browser__navigate', { url }), null, url);
  for (const url of ['http://localhost:5432', 'http://localhost:3000/', 'http://localhost/', 'http://v1.localhost:9000/admin']) assert.match(d('mcp__Claude_Browser__navigate', { url }) || '', /only this project's app/, url);
  const fm = name => fs.readFileSync(path.join(ROOT, 'agents', `${name}.md`), 'utf8').split('---')[1];
  assert.match(fm('first-timer'), /^model: haiku$/m);
  assert.match(fm('final-reviewer'), /^disallowedTools: Edit, Write, NotebookEdit, Agent$/m);
});

test('approval covers the mockup', async () => {
  const { approve, problem } = await import('../scripts/approve.mjs');
  const dir = repo();
  const t = path.join(dir, 'specs', 'tickets', '007-player');
  write(path.join(t, 'rd.md'), '# 007\n\n**Status:** draft\n');
  write(path.join(t, 'eval.md'), '# 007\n\n### E-1: plays\n- **Expected**: plays\n');
  write(path.join(t, 'mockup.html'), '<h1>Player</h1>');
  assert.deepStrictEqual(approve(dir, ['007']), ['007-player']);
  assert.strictEqual(problem(dir, '007-player'), null);
  write(path.join(t, 'mockup.html'), '<h1>Player v2</h1>');
  assert.match(problem(dir, '007-player'), /mockup\.html changed/);
});

test('sweep: agents are told the code wins for facts only; guard keeps them out of .oma-archive and away from oma shelve', async () => {
  const { onSubagent } = await import('../scripts/oma.mjs');
  const dir = repo();
  const none = { env: { CLAUDE_CONFIG_DIR: path.join(tmp(), 'x') }, home: tmp() };
  const text = onSubagent({ agent_type: W, cwd: dir }, none);
  assert.match(text, /for facts about the code .* the code is the source of truth/);
  assert.match(text, /Rules, prohibitions and safety instructions in those files always hold/);
  assert.doesNotMatch(text, /End your reply/, 'no reply-format change for agents with a fixed format');

  const d = (tool_name, tool_input, agent_type = W, cwd = dir) => decide({ agent_type, tool_name, tool_input, cwd });
  const no = /shelved as outdated/;
  // However the path is spelled.
  for (const p of ['.oma-archive/2026-01-01/x.md', '.oma-archive', './/.oma-archive//INDEX.md', path.join(dir, '.oma-archive/INDEX.md')]) assert.match(d('Read', { file_path: p }) || '', no, p);
  assert.match(d('Read', { file_path: 'INDEX.md' }, W, path.join(dir, '.oma-archive')) || '', no, 'relative to a cwd inside it');
  assert.match(d('Grep', { pattern: 'x', path: '.oma-archive' }, 'oh-my-agent-mod:reviewer') || '', no);
  assert.match(d('Glob', { pattern: '.oma-archive/**/*.md' }) || '', no);
  for (const command of ['cat .oma-archive/INDEX.md', 'cd .oma-archive && ls', 'grep -r secret .oma-archive']) assert.match(d('Bash', { command }) || '', no, command);
  // Text that only mentions the folder is not a visit.
  assert.strictEqual(d('Edit', { file_path: path.join(dir, 'README.md'), old_string: 'x', new_string: 'notes go to .oma-archive/' }), null);
  assert.strictEqual(d('Bash', { command: 'git commit -m "docs: explain .oma-archive/"' }), null);
  assert.strictEqual(d('Bash', { command: "grep -qF -- '.oma-archive/' README.md" }), null, 'a sweep ticket check about the archive docs');
  assert.strictEqual(d('Read', { file_path: path.join(dir, '.oma/project.md') }), null);
  assert.strictEqual(d('Read', { file_path: path.join(dir, '.oma-archive/x.md') }, null), null, 'the person\'s own session is not restricted');

  // Only the router shelves.
  for (const a of [W, 'oh-my-agent-mod:sweep-verifier', 'oh-my-agent-mod:ticket-writer']) assert.match(d('Bash', { command: 'oma shelve r .deja/l.jsonl --id a' }, a) || '', /only by the router/, a);
  assert.match(d('Bash', { command: `node "${path.join(ROOT, 'bin', 'oma')}" shelve r x` }) || '', /only by the router/);
  assert.strictEqual(d('Bash', { command: 'oma shelve r .deja/l.jsonl --id a' }, null), null);
  assert.strictEqual(d('Bash', { command: 'git commit -m "oma shelve now refuses tracked files"' }), null);
});

test('sweep-verifier: read-only by hook, not only by prompt', () => {
  const V = 'oh-my-agent-mod:sweep-verifier';
  const d = command => decide({ agent_type: V, tool_name: 'Bash', tool_input: { command }, cwd: '/p' });
  for (const c of ['git log --oneline -- src/a.ts', 'git blame -L 3,3 -- CLAUDE.md', "git log -S'foo' --oneline -- src", 'ls -la src', 'cat CLAUDE.md | head -20', 'grep -n TODO src/a.ts', 'cd /p && git status --short', 'wc -l README.md']) assert.strictEqual(d(c), null, c);
  for (const c of ['rm -rf src', 'git commit -am x', 'git checkout -- .', 'git branch -D main', 'echo x > CLAUDE.md', 'cat a >> b', 'ls $(rm -rf src)', 'ls `rm x`', 'git log --output=x', 'node -e "1"', 'sed -i s/a/b/ f', 'ls; curl http://x', 'bash -c "rm x"', 'mv a b']) assert.match(d(c) || '', /only reads/, c);
  const fm = fs.readFileSync(path.join(ROOT, 'agents', 'sweep-verifier.md'), 'utf8').split('---')[1];
  assert.match(fm, /^disallowedTools: Edit, Write, NotebookEdit, Agent$/m);
  // Other agents keep their shell.
  assert.strictEqual(decide({ agent_type: W, tool_name: 'Bash', tool_input: { command: 'rm -rf dist' }, cwd: '/p' }), null);
});

test('oma shelve: only memory notes, into the main checkout\'s .oma-archive, losing nothing', () => {
  const dir = fs.realpathSync(repo());
  const cfgDir = fs.realpathSync(tmp('oma-claude-'));
  const OMA = path.join(ROOT, 'bin', 'oma');
  const oma = (cwd, ...a) => run('node', [OMA, ...a], { cwd, env: { CLAUDE_CONFIG_DIR: cfgDir } });
  const day = new Date().toISOString().slice(0, 10);
  const arch = path.join(dir, '.oma-archive');
  const read = f => fs.readFileSync(f, 'utf8');

  // One line of a deja file, by id; the other lines, also ones without an id, stay.
  const rules = path.join(dir, '.deja', 'live_rules.jsonl');
  const rest = 'not json\n{"text":"no id"}\n{"id":null}\n{"id":"bb22","text":"keep me"}\n';
  write(rules, `{"id":"aa11","text":"SECRET-OLD write only to run-1"}\n${rest}`);
  const one = oma(dir, 'shelve', 'audit run-1 is over', rules, '--id', 'aa11');
  assert.strictEqual(one.status, 0, one.stderr);
  assert.ok(!one.stdout.includes('SECRET-OLD'), 'content is never printed');
  assert.strictEqual(read(rules), rest);
  assert.strictEqual(read(path.join(arch, day, 'live_rules.jsonl')), '{"id":"aa11","text":"SECRET-OLD write only to run-1"}\n');
  for (const id of ['zz99', 'undefined', 'null']) assert.strictEqual(oma(dir, 'shelve', 'x', rules, '--id', id).status, 1, id);
  assert.strictEqual(read(rules), rest, 'a miss changes nothing');
  // Misread arguments stop before anything moves.
  for (const a of [[rules, '--id=bb22'], [rules, 'extra.md'], [rules, '--id'], []]) assert.strictEqual(oma(dir, 'shelve', 'x', ...a).status, 2, a.join(' '));
  assert.strictEqual(read(rules), rest);

  // A Claude memory file, from a worktree: it still lands in the main checkout.
  const wt = path.join(dir, '.claude', 'worktrees', 'w1');
  git(dir, 'worktree', 'add', '-q', wt);
  const memDir = path.join(cfgDir, 'projects', '-p', 'memory');
  const mem = path.join(memDir, 'old-fact.md');
  write(mem, 'the products page lives in src/products\n');
  assert.strictEqual(oma(wt, 'shelve', 'renamed|to catalog', mem).status, 0);
  assert.ok(!fs.existsSync(mem));
  assert.strictEqual(read(path.join(arch, day, 'old-fact.md')), 'the products page lives in src/products\n');
  assert.ok(!fs.existsSync(path.join(wt, '.oma-archive')), 'nothing in the worktree');
  // The same name again gets its own file.
  write(mem, 'again\n');
  assert.strictEqual(oma(dir, 'shelve', 'x', mem).status, 0);
  assert.strictEqual(read(path.join(arch, day, 'old-fact-2.md')), 'again\n');
  assert.deepStrictEqual(read(path.join(arch, 'INDEX.md')).trim().split('\n'),
    [`${day} | ${rules}#aa11 | audit run-1 is over`, `${day} | ${mem} | renamed to catalog`, `${day} | ${mem} | x`]);

  // Everything else is refused and left where it is.
  const keep = (file, why, re = /not a memory note/) => {
    const r = oma(dir, 'shelve', 'x', file);
    assert.strictEqual(r.status, 1, why);
    assert.match(r.stderr, re, why);
    assert.ok(fs.lstatSync(file), why);
  };
  const outside = path.join(tmp('oma-home-'), 'id_ed25519');
  write(outside, 'key\n');
  keep(outside, 'a file outside the project');
  write(path.join(dir, '.oma', 'approved.json'), '{}');
  keep(path.join(dir, '.oma', 'approved.json'), 'the approval manifest');
  keep(path.join(dir, '.oma', 'project.md'), 'the profile');
  write(path.join(dir, 'specs', 'tickets', '001-x', 'rd.md'), 'x');
  keep(path.join(dir, 'specs', 'tickets', '001-x', 'rd.md'), 'a ticket');
  keep(path.join(arch, day, 'live_rules.jsonl'), 'an already shelved note');
  write(path.join(memDir, 'MEMORY.md'), '- index\n');
  keep(path.join(memDir, 'MEMORY.md'), 'the memory index');
  fs.symlinkSync(path.join(dir, 'README.md'), path.join(dir, '.deja', 'link.jsonl'));
  keep(path.join(dir, '.deja', 'link.jsonl'), 'a symlink', /not a plain file/);
  write(path.join(dir, '.deja', 'memory.jsonl'), '{"id":"c"}\n');
  git(dir, 'add', '-f', '.deja/memory.jsonl');
  keep(path.join(dir, '.deja', 'memory.jsonl'), 'a tracked deja file', /tracked by git/);

  // A planted link in place of the archive folder is not written through.
  fs.rmSync(arch, { recursive: true });
  const elsewhere = tmp('oma-else-');
  fs.symlinkSync(elsewhere, arch);
  assert.strictEqual(oma(dir, 'shelve', 'x', rules, '--id', 'bb22').status, 1);
  assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
  assert.strictEqual(read(rules), rest);
});

test('init ignores .oma-archive and never lists it for worktrees', async () => {
  const { ensureOmaIgnores } = await import('../scripts/oma.mjs');
  const dir = repo();
  ensureOmaIgnores(dir);
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^\/\.oma-archive\/$/m);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, '.worktreeinclude'), 'utf8'), /oma-archive/);
});
