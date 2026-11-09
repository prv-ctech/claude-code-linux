#!/usr/bin/env node
// oh-my-agent-mod: PreToolUse guard for the mod's own agents only (agent_type "oh-my-agent-mod:*").
// Plugins cannot ship permission rules, so this does what the deepseek-superagent pack's
// settings.json deny list did, without touching the person's own sessions:
//   - no `git push` from any oma agent (nothing leaves the machine until the person pushes), however
//     git is spelled (/usr/bin/git, quoted, inside bash -c / sh -c, after env or global options);
//   - no reading or writing env files (.env, .env.*, .env-*, .envrc, *.env; not .env.example and kin);
//   - the same for codebase-memory graph tools' file_pattern / path_filter / file_path;
//   - no subagents other than oh-my-agent ones, which this guard would not cover.
// Prints a deny decision or nothing. Any error prints nothing and exits 0.
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFIX = 'oh-my-agent-mod:';
const ENV_OK = /^\.env\.(example|sample|template|dist|defaults)$/i;
export const isEnvName = name => {
  const b = basename(String(name || ''));
  if (ENV_OK.test(b)) return false;
  return /^\.env([._-].*)?$/i.test(b) || /^\.envrc$/i.test(b) || /^[^/]+\.env$/i.test(b);
};

// A graph-tool pattern that targets an env file: a name isEnvName rejects, or `.env...` right after the
// start, / * { or , that is not an allowed example-style name.
const targetsEnv = v => typeof v === 'string' && (isEnvName(v)
  || [...v.matchAll(/(?:^|[/*{,])(\.env[^/,}]*)/gi)].some(m => !ENV_OK.test(m[1])));
const CM_PREFIX = 'mcp__plugin_codebase-memory-mod_codebase-memory-mcp__';

// Shell words of one command line: quotes removed, $(...) / `...` contents kept as their own text.
// shortcut: not a full shell parser (no here-docs, no escapes inside single quotes); enough to find a
// command name, and anything it can't split stays one word, which errs toward denying.
function words(segment) {
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < segment.length) cur += segment[++i];
      else cur += c;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '\\' && i + 1 < segment.length) cur += segment[++i];
    else if (/\s/.test(c)) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

// Command segments: split on ; & | newlines and the inside of $( ), ( ) and backticks.
function segments(cmd) {
  return String(cmd).split(/\|\||&&|[;&|\n`()]|\$\(/).map(s => s.trim()).filter(Boolean);
}

const WRAPPERS = new Set(['env', 'command', 'exec', 'nohup', 'timeout', 'nice', 'ionice', 'time', 'sudo', 'xargs', 'stdbuf']);
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

// True when a shell command runs `git push`, at any depth of bash -c / sh -c.
export function runsGitPush(cmd, depth = 0) {
  if (depth > 3) return true; // nested past reason: refuse
  for (const seg of segments(cmd)) {
    const w = words(seg);
    let i = 0;
    while (i < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]) || WRAPPERS.has(w[i]) || (i > 0 && WRAPPERS.has(w[i - 1]) && /^-/.test(w[i])) || /^\d+(\.\d+)?[smhd]?$/.test(w[i]))) i++;
    const name = basename(w[i] || '');
    if (/^(ba|z|da|k)?sh$/.test(name)) {
      const c = w.indexOf('-c', i + 1) >= 0 ? w.indexOf('-c', i + 1) : w.findIndex((x, j) => j > i && /^-[a-z]*c[a-z]*$/.test(x));
      if (c >= 0 && w[c + 1] && runsGitPush(w[c + 1], depth + 1)) return true;
      continue;
    }
    if (name !== 'git') continue;
    let j = i + 1;
    while (j < w.length && w[j].startsWith('-')) j += GIT_OPTS_WITH_VALUE.has(w[j]) ? 2 : 1;
    if (w[j] === 'push') return true;
  }
  return false;
}

// A shell command that names an env file as a word (outside of a commit message is all we can do:
// a quoted -m message is one word and only counts when the whole word is an env file name).
export function namesEnvFile(cmd) {
  return segments(cmd).some(seg => words(seg).some(w => isEnvName(w.replace(/^[<>]+/, ''))));
}

export function decide(input) {
  if (!input || typeof input.agent_type !== 'string' || !input.agent_type.startsWith(PREFIX)) return null;
  const ti = input.tool_input || {};
  const tool = input.tool_name;
  if (tool === 'Bash' || tool === 'Monitor') {
    const cmd = String(ti.command || '');
    if (runsGitPush(cmd)) return 'git push is off for oh-my-agent agents: nothing leaves this machine until the person pushes it.';
    if (namesEnvFile(cmd)) return 'oh-my-agent agents never read .env files. List a needed one in .worktreeinclude instead.';
  }
  if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(tool) && isEnvName(ti.file_path || ti.notebook_path)) {
    return 'oh-my-agent agents never read or write .env files. List a needed one in .worktreeinclude instead.';
  }
  if (tool === 'Grep' && (isEnvName(ti.path) || /(^|[\/{,])\.env/i.test(String(ti.glob || '')))) {
    return 'oh-my-agent agents never read .env files.';
  }
  if (typeof tool === 'string' && tool.startsWith(CM_PREFIX) && [ti.file_pattern, ti.path_filter, ti.file_path].some(targetsEnv)) {
    return 'oh-my-agent agents never read .env files.';
  }
  if (tool === 'Agent' && typeof ti.subagent_type === 'string' && !ti.subagent_type.startsWith(PREFIX)) {
    return `oh-my-agent agents start only oh-my-agent-mod:* subagents (asked for ${ti.subagent_type}).`;
  }
  return null;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return;
  }
  const reason = decide(input);
  if (reason) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    }));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch {
    /* never break a tool call */
  }
}
