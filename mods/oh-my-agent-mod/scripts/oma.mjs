#!/usr/bin/env node
// oh-my-agent-mod: hooks and the /oma bootstrap.
//
//   oma.mjs session            SessionStart hook: router reminder after compaction
//   oma.mjs prompt             UserPromptSubmit hook: /oma turns router mode on for this session, /oma off ends it;
//                              while on, one reminder line per prompt
//   oma.mjs start [--dir <p>]  /oma bootstrap: sets the project up (idempotent) and prints its state for the router
//   oma.mjs status [--dir <p>] the same state, changing nothing
//   oma.mjs subagent           SubagentStart hook: tells oma agents which code-search tools work (codebase-memory-mod)
//
// Hooks keep stdout to the hook protocol and never fail the session: any error prints nothing and exits 0.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ME = 'oh-my-agent-mod';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP_SESSIONS = 50;
const IGNORE_LINES = ['/.oma/job/', '/.claude/worktrees/'];

export function paths(env = process.env, home = os.homedir()) {
  const claude = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const data = env.CLAUDE_PLUGIN_DATA || path.join(claude, 'plugins', 'data', `${ME}-claude-code-linux`);
  return {
    claude,
    settings: path.join(claude, 'settings.json'),
    data,
    sessions: path.join(data, 'sessions.json'),
  };
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

function writeAtomic(file, text) {
  // A symlinked settings file (dotfiles) keeps its link: the rename replaces the target, not the link.
  try {
    file = fs.realpathSync(file);
  } catch {
    /* new file */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o644;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    /* new file */
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}
const writeJson = (file, data) => writeAtomic(file, JSON.stringify(data, null, 2) + '\n');

// A settings file the mod edits must parse; a broken one is left alone rather than replaced.
function readSettings(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  return JSON.parse(text);
}

const truthy = v => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());

// --- router mode per session -----------------------------------------------------------------------

const routerLine = () => `oh-my-agent router mode is on in this session: you are the router. Follow ${path.join(ROOT, 'router.md')} `
  + '(Read it again if it is not in your context): route work to oh-my-agent-mod agents, never build, edit or run git yourself. /oma off ends router mode.';

export function sessionsOn(p) {
  return readJson(p.sessions, {});
}

function setSession(p, sid, on) {
  if (!sid) return;
  const s = sessionsOn(p);
  delete s[sid];
  if (on) s[sid] = new Date().toISOString();
  const keys = Object.keys(s);
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_SESSIONS))) delete s[k];
  writeJson(p.sessions, s);
}

// What the UserPromptSubmit hook adds, or null. `/oma` (any arguments but off/stop) turns router mode on.
export function onPrompt(p, input) {
  const prompt = String(input.prompt || '').trim();
  const sid = String(input.session_id || '');
  const m = prompt.match(/^\/(?:oh-my-agent-mod:)?oma(?:\s+([\s\S]*))?$/);
  if (m) {
    const arg = (m[1] || '').trim().toLowerCase();
    if (['off', 'stop', 'exit', 'quit'].includes(arg)) {
      setSession(p, sid, false);
      return null;
    }
    if (['status', 'help'].includes(arg)) return null;
    setSession(p, sid, true);
    // The command itself carries the instructions; agents inherit this session's permission mode.
    const mode = String(input.permission_mode || '');
    if (mode && !['auto', 'bypassPermissions', 'dontAsk'].includes(mode)) {
      return `oh-my-agent: this session's permission mode is "${mode}", so every agent will stop and wait for approvals. `
        + 'Tell the user once, in one line, that switching the session to auto mode lets the run go without them.';
    }
    return null;
  }
  return sid && sessionsOn(p)[sid] ? routerLine() : null;
}

export function onSession(p, input) {
  const lines = [];
  const sid = String(input.session_id || '');
  const on = sid && sessionsOn(p)[sid];
  if (on && input.source === 'clear') setSession(p, sid, false);
  else if (on && (input.source === 'compact' || input.source === 'resume')) {
    lines.push(`${routerLine()} After this ${input.source}: Read router.md now, rebuild your job list from the status files (oma.mjs status), and re-arm your watch if it is not running.`);
  }
  if (!lines.length && input.source === 'startup') lines.push('oh-my-agent: /oma <what to build> runs the superagent (router, workers in worktrees, tester, reviewer, merger, checker).');
  return lines.join('\n') || null;
}

// --- codebase-memory-mod compatibility -----------------------------------------------------------------

// Mirrors mods/codebase-memory-mod/hooks/gate.js: same graph file, same escape file, folder as given.
// codebase-memory-mod counts as enabled when the last settings file with a codebase-memory-mod@* key sets it true.
export function codeGraph(dir, { env = process.env, home = os.homedir() } = {}) {
  const abs = path.resolve(dir);
  const files = [
    path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json'),
    path.join(abs, '.claude', 'settings.json'),
    path.join(abs, '.claude', 'settings.local.json'),
  ];
  let enabled = false;
  for (const f of files) {
    const plugins = (readJson(f, null) || {}).enabledPlugins;
    const key = plugins && typeof plugins === 'object' ? Object.keys(plugins).find(k => k.startsWith('codebase-memory-mod@')) : undefined;
    if (key !== undefined) enabled = plugins[key] === true;
  }
  let reason = 'on';
  if (!enabled) reason = 'plugin not enabled';
  else if (!fs.existsSync(path.join(abs, '.codebase-memory', 'graph.db.zst'))) reason = 'no graph';
  else if (fs.existsSync(path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'codebase-memory-mcp', 'gate-off'))) reason = 'gate off';
  const active = reason === 'on';
  return { active, project: active ? abs.replace(/\//g, '-').replace(/^-+/, '') : null, reason };
}

// What the SubagentStart hook adds for an oma agent, or null.
export function onSubagent(input, opts) {
  if (typeof input.agent_type !== 'string' || !input.agent_type.startsWith(`${ME}:`)) return null;
  const cwd = path.resolve(input.cwd || process.cwd());
  const g = codeGraph(cwd, opts);
  if (g.reason === 'plugin not enabled') return null;
  if (!g.active) return `oh-my-agent code search: codebase-memory-mod is on but no graph applies in ${cwd} (${g.reason}), so Grep, Glob and grep work as usual here.`;
  return `oh-my-agent code search: codebase-memory-mod is on and ${cwd} has a graph, so Grep, Glob and shell grep/rg/ag/ack/find/git grep on code are blocked here. `
    + 'Use the codebase-memory tools (load them with ToolSearch: mcp__plugin_codebase-memory-mod_codebase-memory-mcp__search_graph, search_code, get_code_snippet, trace_path, get_file_outline) '
    + `with project "${g.project}". Piping command output into grep stays allowed. `
    + `A worktree under .claude/worktrees/ has no graph of its own: there Grep, Glob and grep work as usual, and the graph shows ${cwd}, not your branch.`;
}

// --- project bootstrap -------------------------------------------------------------------------------

const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

function ensureLines(file, lines) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    /* new */
  }
  const have = new Set(text.split(/\r?\n/).map(l => l.trim()));
  const add = lines.filter(l => !have.has(l) && !have.has(l.replace(/^\//, '')));
  if (!add.length) return [];
  const sep = text && !text.endsWith('\n') ? '\n' : '';
  const head = text ? '\n# oh-my-agent: job files and agent worktrees\n' : '# oh-my-agent: job files and agent worktrees\n';
  fs.writeFileSync(file, `${text}${sep}${head}${add.join('\n')}\n`);
  return add;
}

function board(root) {
  const file = path.join(root, 'specs', 'tickets', 'BOARD.md');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const rows = [];
  for (const line of text.split('\n')) {
    const c = line.split('|').map(x => x.trim());
    if (c.length > 5 && /^\d+$/.test(c[1])) rows.push({ id: c[1].padStart(3, '0'), title: c[2], status: c[3], mode: c[4], runs: c[5] });
  }
  return rows;
}

function inFlight(root) {
  const out = [];
  const wt = git(root, ['worktree', 'list', '--porcelain']);
  const dirs = wt.status === 0 ? wt.stdout.split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9)).slice(1) : [];
  for (const d of dirs) {
    const s = readJson(path.join(d, '.oma', 'job', 'status.json'), null);
    if (s) out.push({ worktree: d, ticket: s.ticket, slug: s.slug, step: s.step, updated: s.updated, branch: s.branch, note: s.note });
  }
  let team = [];
  try {
    team = fs.readdirSync(path.join(root, '.oma', 'job')).filter(f => /^status-.+\.json$/.test(f));
  } catch {
    /* none */
  }
  for (const f of team) {
    const s = readJson(path.join(root, '.oma', 'job', f), null);
    if (s) out.push({ teammate: f.slice(7, -5), ticket: s.ticket, slug: s.slug, step: s.step, updated: s.updated });
  }
  return out;
}

export function projectState(dir, { write = false, env = process.env } = {}) {
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  if (r.status !== 0) {
    return { ok: false, problem: `${dir} is not a git repository. oh-my-agent builds in git worktrees: run \`git init\` and commit the project first.` };
  }
  // The session's own checkout (a desktop session may run in a worktree of its own): tickets, the
  // profile and every merge live on the branch checked out here, and workers branch from its HEAD.
  const root = r.stdout.trim();
  const branchNow = git(root, ['branch', '--show-current']).stdout.trim();
  if (!branchNow) {
    return { ok: false, problem: `${root} is on a detached HEAD. oh-my-agent merges every ticket into the branch checked out here: check out a branch first.` };
  }
  if (git(root, ['rev-parse', '--verify', '-q', 'HEAD']).status !== 0) {
    return { ok: false, problem: `${root} has no commits yet. Commit the project once; workers branch from the last commit.` };
  }
  const changed = [];
  const omaDir = path.join(root, '.oma');
  if (write) {
    for (const [name, tpl] of [['project.md', 'project.md'], ['watchdog-rules.md', 'watchdog-rules.md']]) {
      const f = path.join(omaDir, name);
      if (!fs.existsSync(f)) {
        fs.mkdirSync(omaDir, { recursive: true });
        fs.copyFileSync(path.join(ROOT, 'templates', tpl), f);
        changed.push(`.oma/${name} (new)`);
      }
    }
    const added = ensureLines(path.join(root, '.gitignore'), IGNORE_LINES);
    if (added.length) changed.push(`.gitignore (+ ${added.join(', ')})`);
    // Workers branch from the commit checked out here, not from origin's default branch. Claude Code reads
    // local settings from the session's project folder, which can be a subfolder of the repository.
    const local = path.join(dir, '.claude', 'settings.local.json');
    const s = readSettings(local);
    if (!s.worktree || s.worktree.baseRef !== 'head') {
      s.worktree = { ...(s.worktree || {}), baseRef: 'head' };
      writeJson(local, s);
      changed.push('.claude/settings.local.json (worktree.baseRef: head)');
    }
    const rel = path.relative(root, local).split(path.sep).join('/');
    if (git(root, ['check-ignore', '-q', rel]).status !== 0) {
      const ex = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']);
      if (ex.status === 0) ensureLines(ex.stdout.trim(), [`/${rel}`]);
    }
  }
  const profileText = (() => {
    try {
      return fs.readFileSync(path.join(omaDir, 'project.md'), 'utf8');
    } catch {
      return '';
    }
  })();
  const profile = !profileText ? 'missing' : /\*\*Profile:\*\*\s*filled in/.test(profileText) && !profileText.includes('{{') ? 'filled in' : 'not filled in';
  const branch = branchNow;
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=no']).stdout.split('\n').filter(Boolean);
  const untrackedOma = git(root, ['status', '--porcelain', '--', '.oma', 'specs/tickets', '.gitignore']).stdout.split('\n').filter(Boolean);
  const head = git(root, ['rev-parse', '--short', 'HEAD']);
  const settings = readJson(paths(env).settings, {});
  return {
    ok: true,
    pluginRoot: ROOT,
    router: path.join(ROOT, 'router.md'),
    watchCommand: `node ${JSON.stringify(path.join(ROOT, 'scripts', 'check.mjs'))} --watch --root ${JSON.stringify(root)}`,
    projectRoot: root,
    branch,
    head: head.stdout.trim(),
    mergeInProgress: git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status === 0,
    profile,
    board: board(root),
    inFlight: inFlight(root),
    uncommittedTracked: dirty,
    omaFilesNotCommitted: untrackedOma,
    agentTeams: (env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS || (settings.env || {}).CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) === '1',
    reviewTickets: truthy(env.CLAUDE_PLUGIN_OPTION_REVIEW_TICKETS),
    changed,
    codeGraph: codeGraph(dir, { env }),
  };
}

// --- main ---------------------------------------------------------------------------------------------

function stdinJson() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function hookOut(event, text) {
  if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
}

function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const p = paths();
  const dirArg = rest.indexOf('--dir');
  const dir = dirArg >= 0 && rest[dirArg + 1] ? rest[dirArg + 1] : process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (mode === 'session') {
    try {
      hookOut('SessionStart', onSession(p, stdinJson()));
    } catch {
      /* never break a session start */
    }
    return;
  }
  if (mode === 'prompt') {
    try {
      hookOut('UserPromptSubmit', onPrompt(p, stdinJson()));
    } catch {
      /* never hold up a prompt */
    }
    return;
  }
  if (mode === 'subagent') {
    try {
      hookOut('SubagentStart', onSubagent(stdinJson()));
    } catch {
      /* never hold up a subagent */
    }
    return;
  }
  if (mode === 'start' || mode === 'status') {
    console.log(JSON.stringify(projectState(dir, { write: mode === 'start' }), null, 2));
    return;
  }
  console.error('usage: oma.mjs <session|prompt|subagent|start|status> [--dir <project>]');
  process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (e) {
    console.error(`oh-my-agent: ${e.message}`);
    process.exitCode = 1;
  }
}
