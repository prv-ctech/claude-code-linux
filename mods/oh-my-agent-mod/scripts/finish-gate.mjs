#!/usr/bin/env node
// oh-my-agent-mod: finish gate for the `oh-my-agent-mod:worker` subagent (adapted from the
// deepseek-superagent pack's worker-finish-gate.mjs).
//
// Wired in the plugin's hooks/hooks.json (plugin agents ignore frontmatter hooks) twice:
//   - PreToolUse on SubagentHandback, the tool a subagent ends with in Claude Code 2.1.3xx: a block
//     on SubagentStop is discarded when the turn ended by a tool result, so the gate denies the
//     handback instead (permissionDecision deny, with the reason as the worker's next instruction);
//   - SubagentStop on the worker's agent type, for a worker that ends with a plain final message:
//     {"decision":"block","reason":"..."} keeps it running.
// Both only gate agent_type oh-my-agent-mod:worker.
//
// The worker may only finish when, in ITS worktree (not the main checkout):
//   - .oma/job/status.json has step "done", evals.total > 0 and evals.failed === 0
//   - `git status --porcelain` is empty, ignoring untracked oma files (.oma/, specs/tickets/)
//
// Exception: a worker whose status step is "blocked" with a non-empty "note"
// is let through at once (no 3-block count, no clean-tree requirement). A
// "blocked" step without a note is blocked and told to add one.
//
// Loop guard: after 3 consecutive blocks for the same worktree, the next stop
// is let through. The count lives in .oma/job/gate-count and resets whenever the
// gate passes or lets a worker through.
//
// If no .oma/job/status.json can be found, the hook allows the stop (exit 0), so it
// never gets in the way of anything that isn't a worker on a ticket.
//
// No dependencies. Node 18+.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const MAX_BLOCKS = 3;
const WORKER_TYPES = new Set(['oh-my-agent-mod:worker', 'worker']);
// The same stop event can reach this script twice (for example if more than one
// worker is running and each worker's frontmatter hook sees the event). Two
// calls with the same agent and the same final message within this window are
// treated as one stop attempt, so the counter isn't bumped twice.
const DUPLICATE_WINDOW_MS = 5000;

let EVENT = 'SubagentStop';

function allow(message) {
  if (message) process.stdout.write(JSON.stringify({ systemMessage: message }) + '\n');
  process.exit(0);
}

function block(reason) {
  const out = EVENT === 'PreToolUse'
    ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
    : { decision: 'block', reason };
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function expandHome(p) {
  if (typeof p !== 'string' || !p) return null;
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitTopLevel(dir) {
  try {
    return git(['rev-parse', '--show-toplevel'], dir).trim() || null;
  } catch {
    return null;
  }
}

// Every distinct `cwd` recorded in the worker's own transcript, most recent first.
function cwdsFromTranscript(path) {
  const file = expandHome(path);
  if (!file || !existsSync(file)) return [];
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const seen = [];
  for (const m of text.matchAll(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    let value;
    try {
      value = JSON.parse(`"${m[1]}"`);
    } catch {
      continue;
    }
    const i = seen.indexOf(value);
    if (i !== -1) seen.splice(i, 1);
    seen.push(value);
  }
  return seen.reverse();
}

// Worktrees under <project>/.claude/worktrees whose folder name contains the agent id.
function worktreesForAgent(agentId, projectDirs) {
  if (!agentId) return [];
  const out = [];
  for (const project of projectDirs) {
    const base = join(project, '.claude', 'worktrees');
    if (!isDir(base)) continue;
    for (const name of readdirSync(base)) {
      const bare = name.replace(/^agent-/, '');
      if (name.includes(agentId) || (bare.length >= 8 && agentId.includes(bare))) out.push(join(base, name));
    }
  }
  return out;
}

// Find the worker's worktree root: the first candidate directory whose git
// top-level has a .oma/job/status.json.
//
// Why several sources: the hooks reference says the input `cwd` is the worktree
// root once Claude has entered a worktree, and a subagent with
// `isolation: worktree` runs its commands inside its worktree, so `cwd` should
// be enough. But the docs don't state outright that SubagentStop's `cwd` is the
// subagent's worktree rather than the main session's directory. So when `cwd`
// doesn't lead to a status file, we fall back to:
//   1. the `cwd` values the worker's own transcript recorded (agent_transcript_path),
//   2. a folder under <project>/.claude/worktrees named after the agent id.
function findWorktree(input) {
  const candidates = [];
  if (typeof input.cwd === 'string') candidates.push(input.cwd);
  candidates.push(...cwdsFromTranscript(input.agent_transcript_path));
  const projectDirs = [process.env.CLAUDE_PROJECT_DIR, input.cwd].filter(Boolean);
  candidates.push(...worktreesForAgent(input.agent_id, projectDirs));

  const tried = new Set();
  for (const dir of candidates) {
    const abs = resolve(dir);
    if (tried.has(abs) || !isDir(abs)) continue;
    tried.add(abs);
    const root = gitTopLevel(abs) || abs;
    if (existsSync(join(root, '.oma', 'job', 'status.json'))) return root;
  }
  return null;
}

function readStatus(root) {
  try {
    return { status: JSON.parse(readFileSync(join(root, '.oma', 'job', 'status.json'), 'utf8')) };
  } catch (err) {
    return { status: null, error: err };
  }
}

function blockedNote(status) {
  if (!status || status.step !== 'blocked') return null;
  return typeof status.note === 'string' && status.note.trim() ? status.note.trim() : null;
}

// oma's own files are local and never committed. A worktree branches from the last commit, so its
// .gitignore may not list them yet (the main checkout's .gitignore edit can still be uncommitted).
export const isLocalOmaPath = (p) => p.startsWith('.oma/') || p.startsWith('specs/tickets/');

function checkWorktree(root, { status, error }) {
  const problems = [];
  if (!status) {
    problems.push(`.oma/job/status.json can't be read as JSON (${error?.message}). Rewrite it in the agreed format.`);
  }

  if (status && status.step === 'blocked') {
    // Blocked without a note (blocked with a note never gets here).
    problems.push(
      '.oma/job/status.json step is "blocked" but "note" is empty. If you truly can\'t proceed, write a one-line ' +
        'note saying why and stop again: a blocked worker with a note is let through at once, and your report ' +
        'must say what is blocked. If you aren\'t blocked, finish the ticket instead: step "done", every check ' +
        'passing, everything committed.'
    );
    return problems;
  }

  if (status) {
    const evals = status.evals || {};
    if (status.step !== 'done') {
      problems.push(`.oma/job/status.json step is "${status.step}", not "done".`);
    }
    if (!(typeof evals.total === 'number' && evals.total > 0)) {
      problems.push(`evals.total is ${JSON.stringify(evals.total)}; it must be the number of checks in eval.md (more than 0).`);
    }
    if (evals.failed !== 0) {
      problems.push(`evals.failed is ${JSON.stringify(evals.failed)}; every check in eval.md must pass (failed 0).`);
    }
  }

  try {
    const dirty = git(['status', '--porcelain', '--untracked-files=all'], root)
      .split('\n')
      .filter(Boolean)
      .filter((line) => !(line.startsWith('?? ') && isLocalOmaPath(line.slice(3).replace(/^"/, ''))));
    if (dirty.length) {
      const shown = dirty.slice(0, 15).map((l) => `    ${l}`).join('\n');
      const more = dirty.length > 15 ? `\n    ...and ${dirty.length - 15} more` : '';
      problems.push(`The worktree has uncommitted changes. Commit them on your branch (or revert the ones that aren't part of the ticket):\n${shown}${more}`);
    }
  } catch (err) {
    problems.push(`\`git status --porcelain\` failed in ${root}: ${String(err.stderr || err.message).trim()}`);
  }
  return problems;
}

function readCounter(file) {
  try {
    const raw = readFileSync(file, 'utf8').trim();
    if (/^\d+$/.test(raw)) return { count: Number(raw) };
    const parsed = JSON.parse(raw);
    return { count: Number(parsed.count) || 0, lastKey: parsed.lastKey, lastAt: parsed.lastAt };
  } catch {
    return { count: 0 };
  }
}

function writeCounter(file, data) {
  try {
    writeFileSync(file, JSON.stringify(data) + '\n');
  } catch {
    // A counter we can't write must not break the gate.
  }
}

function main() {
  let input;
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    allow(); // Not valid hook input: never break the session.
  }

  if (input.hook_event_name === 'PreToolUse') EVENT = 'PreToolUse';

  // Only gate the worker itself. If this hook ever sees another agent's stop
  // (tester, reviewer, an internal agent), let it through.
  if (input.agent_type && !WORKER_TYPES.has(input.agent_type)) allow();

  const root = findWorktree(input);
  if (!root) allow(); // No status file anywhere: not a worker on a ticket.

  const counterFile = join(root, '.oma', 'job', 'gate-count');
  const read = readStatus(root);

  // A real block: step "blocked" with a note. Let it stop at once.
  const note = blockedNote(read.status);
  if (note) {
    rmSync(counterFile, { force: true });
    allow(`Worker finish gate: ${root} stopped as blocked: ${note}`);
  }

  const problems = checkWorktree(root, read);

  if (problems.length === 0) {
    rmSync(counterFile, { force: true });
    allow();
  }

  const prev = readCounter(counterFile);
  const key = `${input.agent_id || ''}|${input.last_assistant_message || ''}`;
  const now = Date.now();
  const duplicate = prev.lastKey === key && typeof prev.lastAt === 'number' && now - prev.lastAt < DUPLICATE_WINDOW_MS;

  if (!duplicate && prev.count >= MAX_BLOCKS) {
    // Blocked 3 times in a row already: let the worker finish so it can't loop
    // forever. The worker itself was told what to report on the 3rd block
    // (a block reason is the only text that reaches it); this message is shown
    // in the session so whoever is watching knows the gate gave up.
    writeCounter(counterFile, { count: 0, lastKey: key, lastAt: now });
    allow(
      `Worker finish gate let ${root} through after ${MAX_BLOCKS} blocks with checks still failing. ` +
        'Treat this ticket as FAIL and read its results.md for the failing checks. Outstanding:\n- ' +
        problems.join('\n- ')
    );
  }

  const count = duplicate ? prev.count : prev.count + 1;
  writeCounter(counterFile, { count, lastKey: key, lastAt: duplicate ? prev.lastAt : now });

  let reason =
    `Finish gate (block ${count} of ${MAX_BLOCKS}) for ${root}: you can't finish yet.\n- ` +
    problems.join('\n- ') +
    '\nFix these, re-run the failing checks, commit on your branch, update .oma/job/status.json ' +
    '(step "done", evals.failed 0, evals.total = number of checks), then finish with the report. ' +
    'If you truly can\'t go on, set step "blocked" with a one-line note saying why instead.';
  if (count >= MAX_BLOCKS) {
    reason +=
      '\nThis is the last block. If you can\'t get every check passing, stop fixing: make sure results.md ' +
      'lists every check with PASS/FAIL, commit everything, and finish with the report line ' +
      '`Ticket: <NNN-slug>: FAIL x/y`, naming the failing checks under "Blocked / needs a decision". ' +
      'Your next stop will be let through.';
  }
  block(reason);
}

main();
