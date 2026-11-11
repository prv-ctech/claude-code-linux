#!/usr/bin/env node
// oh-my-agent-mod: hooks and the /oma bootstrap.
//
//   oma.mjs session            SessionStart hook: router reminder after compaction
//   oma.mjs prompt             UserPromptSubmit hook: /oma turns router mode on for this session, /oma off ends it;
//                              while on, one reminder line per prompt
//   oma.mjs init [--dir <p>]   /oma init: same setup as start, no router; ignores oma files in git and Docker
//   oma.mjs start [--dir <p>]  /oma bootstrap: sets the project up (idempotent) and prints its state for the router
//   oma.mjs status [--dir <p>] the same state, changing nothing
//   oma.mjs dirty [--dir <p>]  prints tracked modified files that are not oma's own ignore lines; exit 1 if any, 2 on git failure
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
// Everything oma writes in a project. Never committed, never sent into a Docker build context.
export const IGNORE_LINES = ['/.oma/', '/specs/tickets/', '/.claude/worktrees/'];
// Ignored files that every new worktree still needs (Claude Code copies what .worktreeinclude lists).
const GRAPH_DIR = '.codebase-memory';
const WORKTREE_LINES = ['/.oma/', '/specs/tickets/'];

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
  + '(Read it again if it is not in your context): route work to oh-my-agent-mod agents, never build, edit or run git yourself, except a quick fix as the Quick path in router.md allows. /oma off ends router mode.';

export function sessionsOn(p) {
  const s = readJson(p.sessions, {});
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
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
    if (['status', 'help', 'init'].includes(arg)) return null;
    setSession(p, sid, true);
    // Headless runs (claude -p) don't resolve the short /oma name, so the command text may be missing.
    const lines = [`oh-my-agent: the user ran /oma, so you are the oh-my-agent router for this request, even if no /oma command text appears above (headless runs don't resolve the short name). `
      + `Unless you already did for this prompt, first run node "${path.join(ROOT, 'scripts', 'oma.mjs')}" start in the project root, then read ${path.join(ROOT, 'router.md')} in full and follow it.`];
    // Agents inherit this session's permission mode.
    const mode = String(input.permission_mode || '');
    if (mode && !['auto', 'bypassPermissions', 'dontAsk'].includes(mode)) {
      lines.push(`oh-my-agent: this session's permission mode is "${mode}", so every agent will stop and wait for approvals. `
        + 'Tell the user once, in one line, that switching the session to auto mode lets the run go without them.');
    }
    return lines.join('\n');
  }
  return sid && sessionsOn(p)[sid] ? routerLine() : null;
}

// Claude Code only resolves plugin commands by their full name (/oh-my-agent-mod:oma), so a user-level
// /oma alias points at this plugin version. Never overwrites a file without our marker.
const ALIAS_MARK = '<!-- oh-my-agent-mod alias: rewritten at every session start; delete freely -->';
export function ensureAlias(p, root = ROOT) {
  const file = path.join(p.claude, 'commands', 'oma.md');
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch {}
  if (old !== null && !old.includes(ALIAS_MARK)) return false;
  const src = fs.readFileSync(path.join(root, 'commands', 'oma.md'), 'utf8').replaceAll('${CLAUDE_PLUGIN_ROOT}', root);
  const end = src.indexOf('\n---', 4) + 4;
  const text = `${src.slice(0, end)}\n${ALIAS_MARK}\n\nIf ${path.join(root, 'scripts', 'oma.mjs')} does not exist, oh-my-agent-mod is uninstalled: delete ${file}, tell the user /oma is gone, and stop.\n${src.slice(end)}`;
  if (text === old) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return true;
}

export function onSession(p, input) {
  try { ensureAlias(p); } catch {}
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
// JS-only recursive copy: fs.cpSync can abort the process with a native error on unreadable dirs.
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name), b = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

// A worktree under <main>/.claude/worktrees/ without a graph gets a copy of the main checkout's. Returns an error message or null.
function copyGraph(cwd) {
  try {
    const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' });
    if (r.status !== 0) return null;
    const main = path.dirname(r.stdout.trim());
    const src = path.join(main, '.codebase-memory');
    const dst = path.join(cwd, '.codebase-memory');
    if (!cwd.startsWith(path.join(main, '.claude', 'worktrees') + path.sep) || !fs.existsSync(src) || fs.existsSync(dst)) return null;
    copyDir(src, dst);
    return null;
  } catch (e) { return e.message; }
}

export function onSubagent(input, opts) {
  if (typeof input.agent_type !== 'string' || !input.agent_type.startsWith(`${ME}:`)) return null;
  // The first-timer must know nothing about the code or files.
  if (input.agent_type === `${ME}:first-timer`) return null;
  const cwd = path.resolve(input.cwd || process.cwd());
  const copyErr = copyGraph(cwd);
  const g = codeGraph(cwd, opts);
  const local = 'oh-my-agent local files: plans, tickets (specs/tickets/), results, evidence and .oma/ are git-ignored and never committed or pushed. Read and write them on disk, never with git (no git show, add or commit for them). A worktree gets copies through .worktreeinclude; if one is missing there, copy it from the main checkout.';
  const warn = copyErr ? `\noma: graph copy failed: ${copyErr}` : '';
  if (g.reason === 'plugin not enabled') return local + warn;
  if (!g.active) return `${local}${warn}\noh-my-agent code search: codebase-memory-mod is on but no graph applies in ${cwd} (${g.reason}), so Grep, Glob and grep work as usual here.`;
  return `${local}${warn}\noh-my-agent code search: codebase-memory-mod is on and ${cwd} has a graph, so Grep, Glob and shell grep/rg/ag/ack/find/git grep on code are blocked here. `
    + 'Use the codebase-memory tools (load them with ToolSearch: mcp__plugin_codebase-memory-mod_codebase-memory-mcp__search_graph, search_code, get_code_snippet, trace_path, get_file_outline) '
    + `with project "${g.project}". Piping command output into grep stays allowed. `
    + `A worktree under .claude/worktrees/ gets its own copy of the graph and is its own project once indexed: call index_repository there with repo_path set to the worktree path and persistence: true, and use the project name it returns, not "${g.project}".`;
}

// --- project bootstrap -------------------------------------------------------------------------------

const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

function ensureLines(file, lines, comment) {
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
  const head = text ? `\n${comment}\n` : `${comment}\n`;
  fs.writeFileSync(file, `${text}${sep}${head}${add.join('\n')}\n`);
  return add;
}

// Keeps oma files out of git and out of Docker images. Safe to run any time; returns what it changed.
export function ensureOmaIgnores(root) {
  const changed = [];
  const note = '# oh-my-agent: local plans, tickets and job files (never commit)';
  for (const name of ['.gitignore', '.dockerignore']) {
    const added = ensureLines(path.join(root, name), IGNORE_LINES, note);
    if (added.length) changed.push(`${name} (+ ${added.join(', ')})`);
  }
  // Ignored files do not reach a worktree on their own: list them so workers still see the tickets.
  // .worktreeinclude is the user's file (usually committed): lines are only appended, never ignored or untracked.
  const wti = ensureLines(path.join(root, '.worktreeinclude'), WORKTREE_LINES, '# oh-my-agent: files workers need');
  if (wti.length) changed.push(`.worktreeinclude (+ ${wti.join(', ')})`);
  // Graph: copy it into worktrees, and keep it uncommitted so .worktreeinclude (ignored files only) can copy it.
  // A graph git already tracks is left alone: checkout brings it to worktrees, and an ignore line would do nothing.
  if (fs.existsSync(path.join(root, GRAPH_DIR)) && !git(root, ['ls-files', '--', GRAPH_DIR]).stdout.trim()) {
    for (const name of ['.gitignore', '.worktreeinclude']) {
      const added = ensureLines(path.join(root, name), [`/${GRAPH_DIR}/`], '# oh-my-agent: code graph');
      if (added.length) changed.push(`${name} (+ ${added.join(', ')})`);
    }
  }
  // An ignore line does nothing for a file git already tracks: drop those from the index, keep them on disk.
  const tracked = git(root, ['ls-files', '--', '.oma', 'specs/tickets']).stdout.split('\n').filter(Boolean);
  if (tracked.length && git(root, ['rm', '-r', '--cached', '-q', '--', ...tracked]).status === 0) {
    changed.push(`untracked ${tracked.length} oma file(s) (still on disk; commit the removal)`);
  }
  return changed;
}

// Tracked modified files that are not just oma's own lines added to .gitignore, .dockerignore or .worktreeinclude.
export function omaOnlyDiff(root) {
  const st = git(root, ['status', '--porcelain', '--untracked-files=no']);
  if (st.status !== 0) throw new Error(`git status failed in ${root}: ${st.stderr.trim()}`);
  const ok = new Set([...IGNORE_LINES, ...WORKTREE_LINES, `/${GRAPH_DIR}/`]);
  const allowed = new Set(['.gitignore', '.dockerignore', '.worktreeinclude']);
  const bad = [];
  for (const l of st.stdout.split('\n').filter(Boolean)) {
    const f = l.slice(3).replace(/^"|"$/g, '');
    let clean = false;
    if (allowed.has(f)) {
      const d = git(root, ['diff', '-U0', 'HEAD', '--', f]);
      if (d.status !== 0) throw new Error(`git diff failed for ${f}: ${d.stderr.trim()}`);
      clean = d.stdout.split('\n').filter(x => x && !/^(diff |index |@@|--- |\+\+\+ )/.test(x)).every(x => {
        if (x[0] !== '+') return false;
        const t = x.slice(1).trim();
        return t === '' || t.startsWith('# oh-my-agent:') || ok.has(t);
      });
    }
    if (!clean) bad.push(f);
  }
  return bad;
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

// Session start in a project that already holds oma files, init or not: keep them ignored.
export function guardIgnores(dir) {
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  if (r.status !== 0) return [];
  const root = r.stdout.trim();
  // A worker's worktree branches from HEAD: editing its tracked .worktreeinclude there would make the tree dirty. Only the main checkout is touched.
  const dirs = ['--git-dir', '--git-common-dir'].map(a => git(root, ['rev-parse', '--path-format=absolute', a]).stdout.trim());
  if (dirs[0] !== dirs[1]) return [];
  if (!fs.existsSync(path.join(root, '.oma')) && !fs.existsSync(path.join(root, 'specs', 'tickets'))) return [];
  return ensureOmaIgnores(root);
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
    changed.push(...ensureOmaIgnores(root));
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
      if (ex.status === 0) ensureLines(ex.stdout.trim(), [`/${rel}`], '# oh-my-agent');
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
      guardIgnores(dir);
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
  if (mode === 'dirty') {
    try {
      const bad = omaOnlyDiff(dir);
      if (bad.length) console.log(bad.join('\n'));
      process.exitCode = bad.length ? 1 : 0;
    } catch (e) {
      console.error(`oh-my-agent: ${e.message}`);
      process.exitCode = 2;
    }
    return;
  }
  if (mode === 'start' || mode === 'status' || mode === 'init') {
    console.log(JSON.stringify(projectState(dir, { write: mode !== 'status' }), null, 2));
    return;
  }
  console.error('usage: oma.mjs <session|prompt|subagent|dirty|init|start|status> [--dir <project>]');
  process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(path.resolve(process.argv[1]))) {
  try {
    main();
  } catch (e) {
    console.error(`oh-my-agent: ${e.message}`);
    process.exitCode = 1;
  }
}
