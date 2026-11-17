// oma.mjs (hooks, bootstrap) and the bin/oma helper, against temp homes and repos.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { ROOT, tmp, repo, git, write, run } from './helpers.mjs';
import { paths, onPrompt, onSession, projectState, guardIgnores, ensureAlias, ensureOmaIgnores, omaOnlyDiff } from '../scripts/oma.mjs';

const OMA_ON = { 'oh-my-agent-mod@claude-code-linux': true };

const OMA = path.join(ROOT, 'bin', 'oma');
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));

function home(settings) {
  const dir = tmp('oma-home-');
  const env = { CLAUDE_CONFIG_DIR: dir, CLAUDE_PLUGIN_DATA: path.join(dir, 'data') };
  const p = paths(env);
  if (settings) write(p.settings, settings);
  return { p, env };
}

test('gatherer agent frontmatter', () => {
  const t = fs.readFileSync(path.join(ROOT, 'agents', 'gatherer.md'), 'utf8');
  const fm = t.split('---')[1];
  assert.match(fm, /^name: gatherer$/m);
  assert.match(fm, /^model: haiku$/m);
  assert.match(fm, /^effort: high$/m);
  assert.doesNotMatch(fm, /^tools:/m);
});

test('session start never touches the user settings', () => {
  const { p } = home({ enabledPlugins: { ...OMA_ON, 'x@y': true } });
  const before = fs.readFileSync(p.settings);
  const out = onSession(p, { source: 'startup', session_id: 's' });
  assert.match(out, /^oh-my-agent: \/oma <what to build> runs the superagent/);
  assert.deepStrictEqual(fs.readFileSync(p.settings), before);
  assert.ok(!fs.existsSync(path.join(p.claude, 'oh-my-agent-mod')));
});

test('/oma turns router mode on for its session only; /oma off ends it; compaction reminds, clear forgets', () => {
  const { p, env } = home({});
  assert.strictEqual(onPrompt(p, { session_id: 'A', prompt: 'hello there, plain prompt' }), null);
  assert.match(onPrompt(p, { session_id: 'A', prompt: '/oma add password reset', permission_mode: 'auto' }), /you are the oh-my-agent router.*oma\.mjs" start/);
  assert.match(onPrompt(p, { session_id: 'E', prompt: '/oma go', permission_mode: 'default' }), /permission mode is "default"/);
  assert.match(onPrompt(p, { session_id: 'A', prompt: 'what is running?' }), /router mode is on.*Quick path/);
  onPrompt(p, { session_id: 'F', prompt: '/oma fix cover posters do not render', permission_mode: 'auto' });
  assert.match(onPrompt(p, { session_id: 'F', prompt: 'go' }), /router mode is on/, '/oma fix turns router mode on');
  assert.strictEqual(onPrompt(p, { session_id: 'B', prompt: 'what is running?' }), null, 'other sessions untouched');
  assert.strictEqual(onPrompt(p, { session_id: 'B', prompt: '/oma status' }), null);
  assert.strictEqual(onPrompt(p, { session_id: 'B', prompt: 'x y z' }), null, '/oma status does not turn it on');
  assert.match(onSession(p, { session_id: 'A', source: 'compact' }, env), /After this compact: Read router\.md/);
  onPrompt(p, { session_id: 'A', prompt: '/oma off' });
  assert.strictEqual(onPrompt(p, { session_id: 'A', prompt: 'what is running?' }), null);
  onPrompt(p, { session_id: 'C', prompt: '/oh-my-agent-mod:oma' });
  assert.match(onPrompt(p, { session_id: 'C', prompt: 'status please' }), /router mode/);
  onSession(p, { session_id: 'C', source: 'clear' }, env);
  assert.strictEqual(onPrompt(p, { session_id: 'C', prompt: 'status please' }), null);
  assert.match(onSession(p, { session_id: 'D', source: 'startup' }, env), /\/oma <what to build>/);
});

test('session start ignores oma files without init, and untracks ones already committed', () => {
  const dir = repo(); // commits .oma/project.md
  write(path.join(dir, 'specs', 'tickets', 'BOARD.md'), 'x');
  git(dir, 'add', '-f', 'specs');
  assert.ok(git(dir, 'ls-files', '.oma', 'specs').includes('BOARD.md'));
  write(path.join(dir, '.worktreeinclude'), '.env\n'); // the user's own, committed file
  git(dir, 'add', '.worktreeinclude');
  git(dir, 'commit', '-q', '-m', 'wti');
  const changed = guardIgnores(dir);
  assert.ok(changed.length >= 3);
  assert.strictEqual(git(dir, 'ls-files', '.oma', 'specs'), '');
  assert.strictEqual(git(dir, 'ls-files', '.worktreeinclude'), '.worktreeinclude', 'the user\'s .worktreeinclude stays tracked');
  assert.ok(fs.readFileSync(path.join(dir, '.worktreeinclude'), 'utf8').startsWith('.env\n'), 'its own lines stay');
  assert.ok(fs.existsSync(path.join(dir, '.oma', 'project.md')), 'files stay on disk');
  assert.strictEqual(run('git', ['check-ignore', '-q', 'specs/tickets/001-x/rd.md'], { cwd: dir }).status, 0);
  assert.deepStrictEqual(guardIgnores(dir), []);
  // A linked worktree is never edited: its tracked .worktreeinclude would turn the worker's tree dirty.
  const wt = path.join(dir, '.claude', 'worktrees', 'w');
  git(dir, 'worktree', 'add', '-q', '-b', 'w', wt);
  write(path.join(wt, 'specs', 'tickets', 'BOARD.md'), 'x');
  fs.writeFileSync(path.join(dir, '.worktreeinclude'), '.env\n');
  git(dir, 'commit', '-qam', 'reset wti');
  const before = git(wt, 'status', '--porcelain');
  assert.deepStrictEqual(guardIgnores(wt), []);
  assert.strictEqual(git(wt, 'status', '--porcelain'), before);
  const plain = repo();
  fs.rmSync(path.join(plain, '.oma'), { recursive: true });
  git(plain, 'rm', '-rq', '--cached', '.oma');
  assert.deepStrictEqual(guardIgnores(plain), [], 'projects without oma files are left alone');
});

test('bootstrap sets a project up once and reports its state', () => {
  const dir = tmp('oma-proj-');
  git(dir, 'init', '-q', '-b', 'trunk');
  write(path.join(dir, 'app.js'), 'x');
  write(path.join(dir, '.gitignore'), 'node_modules/');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  const env = { CLAUDE_CONFIG_DIR: tmp('oma-h-') };
  const s = projectState(dir, { write: true, env });
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.branch, 'trunk');
  assert.strictEqual(s.profile, 'not filled in');
  assert.strictEqual(s.board, null);
  assert.ok(fs.existsSync(path.join(dir, '.oma', 'project.md')));
  assert.ok(fs.existsSync(path.join(dir, '.oma', 'watchdog-rules.md')));
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /node_modules\/\n\n# oh-my-agent[^\n]*\n\/\.oma\/\n\/specs\/tickets\/\n\/\.claude\/worktrees\/\n\/\.oma-archive\/\n$/);
  assert.match(fs.readFileSync(path.join(dir, '.dockerignore'), 'utf8'), /^# oh-my-agent[^\n]*\n\/\.oma\/\n\/specs\/tickets\//);
  assert.strictEqual(fs.readFileSync(path.join(dir, '.worktreeinclude'), 'utf8').split('\n').filter(l => l && l[0] !== '#').join(), '/.oma/,/specs/tickets/');
  assert.deepStrictEqual(readJson(path.join(dir, '.claude', 'settings.local.json')), { worktree: { baseRef: 'head' } });
  assert.strictEqual(run('git', ['check-ignore', '-q', '.claude/settings.local.json'], { cwd: dir }).status, 0, 'local settings ignored');
  assert.ok(s.watchCommand.includes('check.mjs') && s.watchCommand.includes('--watch'));
  // Idempotent: nothing changes the second time.
  const again = projectState(dir, { write: true, env });
  assert.deepStrictEqual(again.changed, []);
  // A session running in a worktree of its own works on that worktree's branch.
  const wt = path.join(dir, '.claude', 'worktrees', 'w');
  git(dir, 'worktree', 'add', '-q', '-b', 'w', wt);
  const ws = projectState(wt, { env });
  assert.strictEqual(fs.realpathSync(ws.projectRoot), fs.realpathSync(wt));
  assert.strictEqual(ws.branch, 'w');
  // Detached HEAD and an empty repository: a clear problem, nothing written.
  git(wt, 'checkout', '-q', '--detach');
  assert.match(projectState(wt, { write: true, env }).problem, /detached HEAD/);
  const empty = tmp('oma-empty-repo-');
  git(empty, 'init', '-q');
  assert.match(projectState(empty, { write: true, env }).problem, /no commits yet/);
  assert.deepStrictEqual(fs.readdirSync(empty), ['.git']);
  // Not a repo: a clear problem, nothing written.
  const bare = tmp('oma-nogit-');
  const no = projectState(bare, { write: true, env });
  assert.strictEqual(no.ok, false);
  assert.deepStrictEqual(fs.readdirSync(bare), []);
});

test('bootstrap reads the board and work in flight', () => {
  const dir = repo();
  write(path.join(dir, 'specs', 'tickets', 'BOARD.md'), '| # | Title | Status | Mode | Runs |\n|---|---|---|---|---|\n| 001 | Toggle | ready | solo | alongside |\n| 2 | SEO | draft | solo | waits for 001: route |\n');
  const wt = path.join(dir, '.claude', 'worktrees', 'agent-1');
  git(dir, 'worktree', 'add', '-q', '-b', 'b1', wt);
  write(path.join(wt, '.oma', 'job', 'status.json'), { ticket: '001', slug: '001-toggle', step: 'testing' });
  const s = projectState(dir, { env: { CLAUDE_CONFIG_DIR: tmp('h') } });
  assert.strictEqual(s.profile, 'filled in');
  assert.deepStrictEqual(s.board.map(r => [r.id, r.status, r.runs]), [['001', 'ready', 'alongside'], ['002', 'draft', 'waits for 001: route']]);
  assert.strictEqual(s.inFlight[0].ticket, '001');
  assert.strictEqual(s.inFlight[0].step, 'testing');
});

const oma = (cwd, ...args) => run('node', [OMA, ...args], { cwd });

test('oma status writes the status file with correct step timing and validation', () => {
  const dir = repo();
  let r = oma(dir, 'status', 'init', 'specs/tickets/004-seo-settings', '3104');
  assert.strictEqual(r.status, 0, r.stderr);
  const file = path.join(dir, '.oma', 'job', 'status.json');
  let s = readJson(file);
  assert.deepStrictEqual([s.ticket, s.slug, s.step, s.port, s.branch, s.evals.round], ['004', '004-seo-settings', 'setup', 3104, 'main', 0]);
  const started = s.stepStarted;
  r = oma(dir, 'status', 'building', 'writing', 'the', 'panel');
  s = readJson(file);
  assert.strictEqual(s.note, 'writing the panel');
  assert.ok(s.stepStarted >= started);
  const building = s.stepStarted;
  oma(dir, 'status', 'building', 'still going');
  assert.strictEqual(readJson(file).stepStarted, building, 'same step keeps stepStarted');
  r = oma(dir, 'status', 'testing', 'tester ran', '--evals', '2/1/3', '--round', 'next');
  s = readJson(file);
  assert.deepStrictEqual(s.evals, { passed: 2, failed: 1, total: 3, round: 1 });
  assert.strictEqual(oma(dir, 'status', 'testing', '--evals', '2/2/3').status, 2, 'counts must add up');
  assert.strictEqual(oma(dir, 'status', 'nonsense').status, 2);
  assert.strictEqual(oma(dir, 'status', 'blocked').status, 2, 'blocked needs its own note');
  assert.strictEqual(oma(dir, 'status', 'blocked', 'ticket contradicts itself').status, 0);
  oma(dir, 'status', 'init', 'repro:save-button', '3090');
  assert.deepStrictEqual([readJson(file).ticket, readJson(file).slug], ['repro', 'save-button']);
});

test('oma run, cfg and the none commands', () => {
  const dir = repo({ lint: 'echo linted', build: 'exit 3', test: 'none' });
  let r = oma(dir, 'run', 'lint');
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /linted\nlint exit 0: echo linted/);
  r = oma(dir, 'run', 'build');
  assert.strictEqual(r.status, 3);
  assert.match(r.stdout, /build exit 3/);
  assert.match(oma(dir, 'run', 'test').stdout, /test none \(skipped\)/);
  assert.strictEqual(JSON.parse(oma(dir, 'cfg').stdout).agentHosts, 'yes');
  assert.strictEqual(oma(tmp('oma-empty-'), 'cfg').status, 1);
});

async function freePort() {
  const s = net.createServer().listen(0);
  await new Promise(r => s.once('listening', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}

test('oma serve, up, port and stop manage only their own dev server', async () => {
  const server = "node -e \"require('http').createServer((q,s)=>{s.statusCode=q.url==='/ok'?200:404;s.end()}).listen(<port>)\"";
  const dir = repo({ start: server, upPath: '/ok' });
  const port = String(await freePort());
  let r = oma(dir, 'serve', port);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /serving http:\/\/localhost:\d+\/ok/);
  assert.match(oma(dir, 'up', port).stdout, / 200$/m);
  assert.notStrictEqual(oma(dir, 'port', port).stdout.trim(), '');
  assert.strictEqual(oma(dir, 'serve', port).status, 1, 'second serve on a busy port refuses');
  // Another repository did not start it: stop refuses.
  const other = repo({ start: server, upPath: '/ok' });
  assert.strictEqual(oma(other, 'stop', port).status, 1);
  // Another worktree of the same repository (a re-routed agent's) may stop it.
  const wt = path.join(dir, '.claude', 'worktrees', 'agent-x');
  git(dir, 'worktree', 'add', '-q', '-b', 'agent-x', wt);
  r = oma(wt, 'stop', port);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /started in/);
  r = oma(dir, 'serve', port);
  assert.strictEqual(r.status, 0, r.stderr);
  r = oma(dir, 'stop', port);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(oma(dir, 'port', port).stdout.trim(), '');
  assert.strictEqual(oma(dir, 'up', port).status, 1);
});

test('session start writes a user-level /oma alias pointing at this plugin, never over a user file', () => {
  const { p, env } = home({});
  onSession(p, { session_id: 'S', source: 'startup' }, env);
  const file = path.join(p.claude, 'commands', 'oma.md');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^---\ndescription:/);
  assert.ok(text.includes(path.join(ROOT, 'scripts', 'oma.mjs')) && !text.includes('${CLAUDE_PLUGIN_ROOT}'));
  assert.match(text, /oh-my-agent-mod is uninstalled: delete/);
  assert.strictEqual(ensureAlias(p), false, 'unchanged alias is not rewritten');
  fs.writeFileSync(file, 'my own command');
  assert.strictEqual(ensureAlias(p), false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'my own command');
});

test('init lists the codebase graph in .worktreeinclude and .gitignore only when it exists and is untracked', () => {
  const count = (dir, f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(l => l === '/.codebase-memory/').length : 0);
  const init = dir => assert.strictEqual(run('node', [path.join(ROOT, 'scripts', 'oma.mjs'), 'init'], { cwd: dir }).status, 0);
  const withGraph = repo();
  write(path.join(withGraph, '.codebase-memory', 'graph.db.zst'), '');
  init(withGraph);
  init(withGraph);
  assert.deepStrictEqual([count(withGraph, '.worktreeinclude'), count(withGraph, '.gitignore')], [1, 1]);
  assert.strictEqual(git(withGraph, 'status', '--porcelain', '--', '.codebase-memory'), '');
  const without = repo();
  init(without);
  assert.deepStrictEqual([count(without, '.worktreeinclude'), count(without, '.gitignore')], [0, 0]);
  const tracked = repo();
  write(path.join(tracked, '.codebase-memory', 'graph.db.zst'), '');
  git(tracked, 'add', '.codebase-memory');
  git(tracked, 'commit', '-q', '-m', 'graph');
  init(tracked);
  assert.deepStrictEqual([count(tracked, '.worktreeinclude'), count(tracked, '.gitignore')], [0, 0]);
  assert.strictEqual(git(tracked, 'ls-files', '.codebase-memory'), '.codebase-memory/graph.db.zst');
});

test('omaOnlyDiff: oma lines allowed, user lines, other files and removals block', () => {
  const d = repo();
  git(d, 'rm', '-r', '--cached', '-q', '.oma');
  write(path.join(d, 'src.txt'), 'a\n');
  write(path.join(d, '.worktreeinclude'), 'keep\n');
  git(d, 'add', 'src.txt', '.worktreeinclude');
  git(d, 'commit', '-q', '-m', 'files');
  fs.mkdirSync(path.join(d, '.codebase-memory'));
  write(path.join(d, '.codebase-memory', 'g'), 'x');
  ensureOmaIgnores(d);
  assert.deepStrictEqual(omaOnlyDiff(d), []);
  fs.appendFileSync(path.join(d, '.worktreeinclude'), '/.deja/\n');
  assert.deepStrictEqual(omaOnlyDiff(d), ['.worktreeinclude']);
  git(d, 'checkout', '--', '.worktreeinclude', '.gitignore');
  fs.appendFileSync(path.join(d, 'src.txt'), 'b\n');
  assert.deepStrictEqual(omaOnlyDiff(d), ['src.txt']);
  git(d, 'checkout', '--', 'src.txt');
  write(path.join(d, '.gitignore'), '/.claude/worktrees/\n');
  assert.deepStrictEqual(omaOnlyDiff(d), ['.gitignore']);
  git(d, 'checkout', '--', '.gitignore');
  fs.appendFileSync(path.join(d, '.worktreeinclude'), '/.deja/\n');
  git(d, 'add', '.worktreeinclude');
  assert.deepStrictEqual(omaOnlyDiff(d), ['.worktreeinclude']);
  const cli = run('node', [path.join(ROOT, 'scripts', 'oma.mjs'), 'dirty', '--dir', d]);
  assert.strictEqual(cli.status, 1);
});

test('router.md names only phase files and agents that exist, and stays small', () => {
  const core = fs.readFileSync(path.join(ROOT, 'router.md'), 'utf8');
  const files = ['router-bug.md', 'router-interview.md', 'router-run.md', 'router-sweep.md'];
  for (const f of files) assert.ok(core.includes(`\`${f}\``) && fs.existsSync(path.join(ROOT, f)), f);
  const all = core + files.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('');
  for (const m of all.matchAll(/`oh-my-agent-mod:([a-z-]+)`/g)) assert.ok(fs.existsSync(path.join(ROOT, 'agents', `${m[1]}.md`)), m[1]);
  // The end of a run verifies the stale notes workers reported, through the sweep's `reported` scope.
  for (const f of ['router-run.md', 'router-sweep.md']) assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /scope `reported`/, f);
  assert.ok(Buffer.byteLength(core) < 16000, 'core router is read in every /oma session: keep it under 16 KB');
});

test('oma merge: merges an approved ticket, runs the suite, undoes a failing merge, never resolves a conflict, logs a fix', async () => {
  const { approve } = await import('../scripts/approve.mjs');
  const dir = repo({ test: 'test ! -f FAIL' });
  const ticket = (id, slug) => {
    write(path.join(dir, 'specs', 'tickets', `${id}-${slug}`, 'rd.md'), `# ${id}\n\n**Status:** ready\n\n## Summary\n${slug}\n`);
    write(path.join(dir, 'specs', 'tickets', `${id}-${slug}`, 'eval.md'), `# ${id}\n\n### E-1: works\n- **Expected**: ok\n`);
  };
  ticket('001', 'good'); ticket('002', 'bad'); ticket('003', 'clash'); ticket('004', 'unseen');
  write(path.join(dir, 'specs', 'tickets', 'BOARD.md'), '| # | Title | Status | Mode | Runs |\n|---|---|---|---|---|\n| 001 | Good | ready | solo | alongside |\n| 002 | Bad | ready | solo | waits for 001: same file |\n| 003 | Clash | ready | solo | alongside |\n');
  approve(dir, ['001', '002', '003']);
  const branch = (name, file, text) => {
    git(dir, 'checkout', '-q', '-b', name, 'main');
    write(path.join(dir, file), text);
    git(dir, 'add', file);
    git(dir, 'commit', '-q', '-m', `Add ${file}`);
    git(dir, 'checkout', '-q', 'main');
  };
  const merge = (...a) => {
    const r = oma(dir, 'merge', ...a);
    return { status: r.status, last: r.stdout.trim().split('\n').pop() };
  };
  const head = () => git(dir, 'rev-parse', 'HEAD');
  branch('t1', 'a.txt', 'one\n'); branch('t2', 'FAIL', 'x\n'); branch('t3', 'a.txt', 'other\n'); branch('fix1', 'b.txt', 'fix\n');

  let r = merge('t1', 'specs/tickets/001-good');
  assert.strictEqual(r.status, 0, r.last);
  assert.match(r.last, /^MERGED 001-good: merge \w{7}, lint none \(skipped\), build none \(skipped\), test ok, marked done; waited for 001: 002$/);
  assert.match(fs.readFileSync(path.join(dir, 'specs', 'tickets', '001-good', 'rd.md'), 'utf8'), /\*\*Status:\*\* done/);
  assert.match(fs.readFileSync(path.join(dir, 'specs', 'tickets', 'BOARD.md'), 'utf8'), /\| 001 \| Good \| done \|/);

  const before = head();
  r = merge('t2', 'specs/tickets/002-bad');
  assert.match(r.last, /^FAILED 002-bad: test: exit 1/);
  assert.strictEqual(head(), before, 'failing merge undone');

  r = merge('t3', 'specs/tickets/003-clash');
  assert.match(r.last, /^CONFLICT 003-clash: a\.txt/);
  assert.strictEqual(head(), before, 'conflict aborted');
  assert.strictEqual(git(dir, 'status', '--porcelain', '--untracked-files=no'), '');

  assert.match(merge('fix1', 'specs/tickets/004-unseen').last, /^FAILED 004-unseen: not approved: the user has not approved it/);
  // The worker's own copy of the ticket was weakened: refused.
  const wt = tmp('oma-wt-');
  write(path.join(wt, 'specs', 'tickets', '003-clash', 'rd.md'), fs.readFileSync(path.join(dir, 'specs', 'tickets', '003-clash', 'rd.md'), 'utf8'));
  write(path.join(wt, 'specs', 'tickets', '003-clash', 'eval.md'), '# 003\n\n### E-1: works\n- **Expected**: anything\n');
  assert.match(merge('t3', 'specs/tickets/003-clash', '--worktree', wt).last, /not approved: approved parts of its eval\.md changed.*worker's copy/);

  r = merge('fix1');
  assert.match(r.last, /^MERGED fix \(fix1\): merge \w{7}, .*logged as 005$/);
  assert.match(fs.readFileSync(path.join(dir, 'specs', 'tickets', 'BOARD.md'), 'utf8'), /\| 005 \| Fix: Add b\.txt \| done \| solo \| fix \|/);
  assert.match(oma(dir, 'log-fix', 'cover posters render again').stdout, /logged as 006/);
});

test('oma merge: oma\'s own uncommitted .gitignore lines do not block a branch that also edits .gitignore', () => {
  const dir = repo();
  git(dir, 'checkout', '-q', '-b', 'ig', 'main');
  fs.appendFileSync(path.join(dir, '.gitignore'), '/data/\n');
  git(dir, 'commit', '-q', '-am', 'Ignore data');
  git(dir, 'checkout', '-q', 'main');
  // Both sides append at the end of the file: the case a stash-and-pop turns into conflict markers.
  fs.mkdirSync(path.join(dir, '.codebase-memory'));
  fs.appendFileSync(path.join(dir, '.gitignore'), '\n# oh-my-agent: code graph\n/.codebase-memory/\n');
  const r = oma(dir, 'merge', 'ig');
  assert.match(r.stdout.trim().split('\n').pop(), /^MERGED fix \(ig\): /, r.stdout + r.stderr);
  const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.doesNotMatch(ignore, /<<<<<<<|>>>>>>>/);
  assert.strictEqual(git(dir, 'stash', 'list'), '');
  assert.match(ignore, /^\/data\/$/m);
  assert.match(ignore, /^\/\.codebase-memory\/$/m, 'oma line kept uncommitted');
});

test('oma stress: skipped when a run could touch the person\'s data or there is nothing to serve; down is safe to repeat', () => {
  const shared = repo({ start: 'node server.js' });
  fs.appendFileSync(path.join(shared, '.oma', 'project.md'), '\n- **Local data is per folder:** no\n');
  assert.match(oma(shared, 'stress', 'up').stdout, /^SKIPPED: local data is not per folder/);
  assert.match(oma(repo({ appType: 'cli' }), 'stress', 'up').stdout, /^SKIPPED: the stress stage is for web apps/);
  const none = repo();
  assert.match(oma(none, 'stress', 'up').stdout, /^SKIPPED: the profile has no start command/);
  assert.ok(!fs.existsSync(path.join(none, '.claude', 'worktrees', 'oma-stress')));
  assert.match(oma(none, 'stress', 'down').stdout, /stress app down/);
});

test('oma stress up serves a separate worktree on 3080 and down removes it', async () => {
  const busy = await new Promise(res => { const s = net.createServer().once('error', () => res(true)).once('listening', () => s.close(() => res(false))).listen(3080, '127.0.0.1'); });
  if (busy) return; // something else on this machine holds 3080
  const dir = repo({ start: 'node -e "require(\'http\').createServer((q,s)=>s.end(\'ok\')).listen(<port>)"' });
  const up = oma(dir, 'stress', 'up');
  try {
    assert.match(up.stdout, /stress app up: http:\/\/localhost:3080/, up.stderr);
    const wt = path.join(dir, '.claude', 'worktrees', 'oma-stress');
    assert.ok(fs.existsSync(path.join(wt, 'README.md')));
    assert.strictEqual(git(dir, 'status', '--porcelain', '--untracked-files=no'), '', 'main checkout untouched');
    assert.match(oma(dir, 'stress', 'up').stderr, /already exists/);
  } finally {
    assert.match(oma(dir, 'stress', 'down').stdout, /stress app down/);
  }
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'worktrees', 'oma-stress')));
});
