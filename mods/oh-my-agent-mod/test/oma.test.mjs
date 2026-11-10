// oma.mjs (hooks, bootstrap) and the bin/oma helper, against temp homes and repos.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { ROOT, tmp, repo, git, write, run } from './helpers.mjs';
import { paths, onPrompt, onSession, projectState, guardIgnores } from '../scripts/oma.mjs';

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
  assert.strictEqual(onPrompt(p, { session_id: 'A', prompt: '/oma add password reset', permission_mode: 'auto' }), null);
  assert.match(onPrompt(p, { session_id: 'E', prompt: '/oma go', permission_mode: 'default' }), /permission mode is "default"/);
  assert.match(onPrompt(p, { session_id: 'A', prompt: 'what is running?' }), /router mode is on/);
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
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /node_modules\/\n\n# oh-my-agent[^\n]*\n\/\.oma\/\n\/specs\/tickets\/\n\/\.claude\/worktrees\/\n$/);
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
  oma(dir, 'status', 'init', 'specs/tickets/007-stats', '3000', '--name', 'storage');
  assert.strictEqual(readJson(path.join(dir, '.oma', 'job', 'status-storage.json')).ticket, '007');
  assert.strictEqual(oma(dir, 'status', 'init', 'specs/tickets/x', '3000', '--name', '../evil').status, 2);
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
