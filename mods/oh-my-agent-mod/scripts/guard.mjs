#!/usr/bin/env node
// oh-my-agent-mod: PreToolUse guard for the mod's own agents only (agent_type "oh-my-agent-mod:*").
// Plugins cannot ship permission rules, so this does what the deepseek-superagent pack's
// settings.json deny list did, without touching the person's own sessions:
//   - no `git push` from any oma agent (nothing leaves the machine until the person pushes), however
//     git is spelled (/usr/bin/git, quoted, inside bash -c / sh -c, after env or global options);
//   - no reading or writing env files (.env, .env.*, .env-*, .envrc, *.env; not .env.example and kin);
//   - the same for codebase-memory graph tools' file_pattern / path_filter / file_path;
//   - no subagents other than oh-my-agent ones, which this guard would not cover;
//   - the first-timer stays blind: no reading files or code, Bash only for oma up/serve/stop/port,
//     Write only under .oma/job/first-timer/.
// Prints a deny decision or nothing. Any error prints nothing and exits 0.
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFIX = 'oh-my-agent-mod:';
const ENV_OK = /^\.env\.(example|sample|template|dist|defaults|md)$/i;
export const isEnvName = name => {
  const b = basename(String(name || ''));
  if (ENV_OK.test(b)) return false;
  if (/\.(d\.ts|ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb)$/i.test(b)) return false; // code files like .env.d.ts
  return /^\.env([._-].*)?$/i.test(b) || /^\.envrc$/i.test(b) || /^[^/]+\.env$/i.test(b) || /^[^/]+\.env\.(local|prod\w*|dev\w*|test|staging)$/i.test(b);
};

// A graph-tool pattern that targets an env file: a name isEnvName rejects, or `.env...` right after the
// start, / * { or , that is not an allowed example-style name.
const targetsEnv = v => Array.isArray(v) ? v.some(x => targetsEnv(x)) : typeof v === 'string' && ((/\{[^{}]*,[^{}]*\}/.test(v) && expandBraces(v).some(x => targetsEnv(x))) || isEnvName(v)
  || [...v.matchAll(/(?:^|[/*{,])(\.env[^/,}]*)/gi)].some(m => isEnvName(m[1]))
  // a glob or regex pattern (`.*env`, `[.]env`) that would select an env file
  || (/[*?[]/.test(v) && (globMatches(basename(v), ENV_NAMES) || (() => { try { return ENV_NAMES.some(n => new RegExp(`(^|/)${v}$`).test(n)); } catch { return false; } })())));
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

// Bash brace expansion: git {pu,x}sh, cat .e{nv,x}. Capped so a hostile word can't blow up.
export function expandBraces(w, out = []) {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(w);
  if (!m || out.length > 64) { out.push(w); return out; }
  for (const alt of m[1].split(',')) expandBraces(w.slice(0, m.index) + alt + w.slice(m.index + m[0].length), out);
  return out;
}

const WRAPPERS = new Set(['setsid', 'flock', 'coproc', 'doas', 'chrt', 'taskset', 'env', 'command', 'exec', 'nohup', 'timeout', 'nice', 'ionice', 'time', 'sudo', 'xargs', 'stdbuf']);
const GIT_OPTS_WITH_VALUE = new Set(['--attr-source', '--super-prefix', '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

// True when a shell command runs `git push`, at any depth of bash -c / sh -c.
export function runsGitPush(cmd, depth = 0) {
  if (depth > 3) return true; // nested past reason: refuse
  for (const seg of segments(cmd)) {
    // {git,} push: expand braces in every word, the command name included.
    if (depth < 3 && /\{[^{}]*,[^{}]*\}/.test(seg)) {
      const e = words(seg).flatMap(x => expandBraces(x)).filter(Boolean).join(' ');
      if (e !== seg && runsGitPush(e, depth + 1)) return true;
    }
    const w = words(seg);
    let i = 0;
    // Leading redirects: >/dev/null git push, > log git push.
    while (i < w.length && /^\d*(>>?|<|&>)/.test(w[i])) i += /^\d*(>>?|<|&>)&?$/.test(w[i]) ? 2 : 1;
    // Function definitions: `function f { ... }`, `f() { ... }`.
    if (w[0] === 'function') i = 2; else if (/^[\w-]+\(\)$/.test(w[0] || '')) i = 1;
    // Shell keywords and grouping in front of a command: if/then/do/else/{/!.
    while (i < w.length && /^(if|then|do|else|elif|while|until|\{|!)$/.test(w[i])) i++;
    if (w[i] === 'eval') {
      if (runsGitPush(w.slice(i + 1).join(' '), depth + 1)) return true;
      continue;
    }
    while (i < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]) || WRAPPERS.has(w[i]) || (i > 0 && WRAPPERS.has(w[i - 1]) && /^-/.test(w[i])) || /^\d+(\.\d+)?[smhd]?$/.test(w[i]))) i++;
    // A wrapper flag's value (env -u FOO, sudo -u root, timeout -s KILL) stops the walk above: look further for git.
    if (i > 0 && WRAPPERS.has(w[0]) && basename(w[i] || '') !== 'git') { const g = w.findIndex((x, j) => j > i && basename(x) === 'git'); if (g > 0) i = g; }
    // env -S 'git push origin main' splits its quoted value into a command.
    if (WRAPPERS.has(w[0]) && w.some((x, j) => j > 0 && /\s/.test(x) && runsGitPush(x, depth + 1))) return true;
    // find ... -exec git push ; runs the command after -exec.
    const ex = w.findIndex(x => /^-(exec|execdir|ok|okdir)$/.test(x));
    if (ex >= 0 && runsGitPush(w.slice(ex + 1).filter(x => !/^(\\?;|\+)$/.test(x)).join(' '), depth + 1)) return true;
    const name = basename(w[i] || '');
    if (/^(ba|z|da|k)?sh$/.test(name)) {
      const c = w.indexOf('-c', i + 1) >= 0 ? w.indexOf('-c', i + 1) : w.findIndex((x, j) => j > i && /^-[a-z]*c[a-z]*$/.test(x));
      if (c >= 0 && w[c + 1] && runsGitPush(w[c + 1], depth + 1)) return true;
      continue;
    }
    if (/^git-(push|send-pack)$/.test(name)) return true;
    if (name !== 'git') continue;
    // git -c alias.u='push origin HEAD' u
    if (w.some(x => /^alias\.[^=]*=.*\bpush\b/.test(x))) return true;
    // git rebase --exec 'git push', git submodule foreach git push: git runs the nested command.
    if (!READ_ONLY_GIT.has(gitSub(seg)) && w.some((x, k) => k > i && /\s/.test(x) && runsGitPush(x, depth + 1))) return true;
    const fe = w.indexOf('foreach', i);
    if (fe > i && runsGitPush(w.slice(fe + 1).join(' '), depth + 1)) return true;
    // git config alias.u 'push origin HEAD' sets up a push for a later call.
    // Also GIT_CONFIG_KEY_0=alias.u GIT_CONFIG_VALUE_0='push origin HEAD' git u
    // Any alias definition can hide a push (pu""sh, !sh -c ...): workers never need one.
    if (w.some(x => /(^|=)alias\./.test(x))) return true;
    let j = i + 1;
    while (j < w.length && w[j].startsWith('-')) j += GIT_OPTS_WITH_VALUE.has(w[j]) ? 2 : 1;
    // git {push,} expands to git push; send-pack pushes too.
    if (expandBraces(w[j] || '').some(x => ['push', 'send-pack', 'http-push'].includes(x))) return true;
    // git p4 submit, git svn dcommit send commits to another server too.
    if ((w[j] === 'p4' && w.includes('submit')) || (w[j] === 'svn' && w.includes('dcommit'))) return true;
    // git subtree push, git lfs push
    if (['subtree', 'lfs'].includes(w[j]) && w.slice(j + 1).includes('push')) return true;
  }
  return false;
}

// A shell command that names an env file as a word (outside of a commit message is all we can do:
// a quoted -m message is one word and only counts when the whole word is an env file name).
// A glob word (`.env*`, `.e?v`, `.en[v]`) that would expand to an env file counts too.
// Shell globs skip dotfiles unless the pattern itself starts with a dot, so only those can reach .env.
const globMatches = (pat, names) => names.some(n => {
  try { return new RegExp(`^${pat.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(n); } catch { return false; }
});
const ENV_NAMES = ['.env', '.env.local', '.envrc'];
const globHitsEnv = w => /[*?[]/.test(w) && basename(w).startsWith('.') && globMatches(basename(w), ENV_NAMES);
// A search tool's first plain argument is the pattern (grep -n "\.env" src/config.ts), not a file it reads.
// sed, awk and jq take a script first (sed 's/.env//' f, jq '.env' f): same shape.
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'sed', 'awk', 'jq']);
function fileWords(seg) {
  const w = words(seg);
  // echo/printf only touch files they redirect to (echo ".env" >> .gitignore reads nothing).
  if (['echo', 'printf'].includes(w[0])) return w.filter((x, i) => /^\d*[<>]/.test(x) || (i > 0 && /^\d*[<>]+&?$/.test(w[i - 1])));
  if (basename(w[0] || '') === 'git' && w[1] === 'grep') w.shift();
  if (!SEARCHERS.has(basename(w[0] || ''))) return w;
  // Drop only the pattern: the -e/--regexp values, else the first plain word (after `--` too).
  // A -f file stays a file word (grep -f .env reads .env).
  const explicit = w.some(x => /^(-[a-zA-Z]*[ef]|--regexp|--file)/.test(x));
  const out = [w[0]];
  let seen = explicit;
  for (let i = 1; i < w.length; i++) {
    const x = w[i];
    if (x === '--') { out.push(...w.slice(i + 1 + (seen ? 0 : 1))); break; }
    if (/^(-[a-zA-Z]*e|--regexp)$/.test(x)) { i++; continue; }
    // rg -g .env, --glob, --iglob, ag -G, grep --include: the value names files.
    if (/^(-g|--glob|--iglob|-G|--include)$/.test(x)) { out.push(x, w[i + 1] || ''); i++; continue; }
    if (/^(-[a-zA-Z]*e.+|--regexp=.*)$/.test(x)) continue;
    if (x.startsWith('-')) { out.push(x); continue; }
    if (!seen) { seen = true; continue; }
    out.push(x);
  }
  return out;
}
export function namesEnvFile(cmd, depth = 0) {
  // echo .env | xargs cat, cat $(echo .env): any word may become a file name.
  if (/\bxargs\b|\$\(|`/.test(cmd) && segments(cmd).some(seg => words(seg).some(x => isEnvName(x)))) return true;
  return segments(cmd).some(seg => {
    const w = words(seg), c = w.indexOf('-c');
    // bash -c "cat .env.local": check the nested command too.
    if (depth < 3 && /^(ba|z|da|k)?sh$/.test(basename(w[0] || '')) && c > 0 && w[c + 1] && namesEnvFile(w[c + 1], depth + 1)) return true;
    return fileWords(seg).some(w => w.split(/\d*[<>]+&?/).filter(p => !/\s/.test(p) && !p.startsWith('!') && !/^--exclude(-dir)?=/.test(p) && !/^\/.+\/$/.test(p) && !/^(process|import\.meta)\.env$/i.test(p)) // code, not files
      .map(p => p.replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))))
      .flatMap(p => [p, p.replace(/\$/g, '')].flatMap(x => expandBraces(x))).some(p => isEnvName(p) || globHitsEnv(p)));
  });
}

// Plans, tickets, results and .oma/ stay on disk. They are git-ignored; this stops a forced add.
// Commit messages (-m / --message) are text, not paths or commands.
// Heredoc bodies (git commit -m "$(cat <<'EOF' ... EOF)") are message text too.
const dropMessages = cmd => String(cmd).replace(/<<-?\s*['"]?(\w+)['"]?\n[\s\S]*?\n\s*\1\b/g, '').replace(/(^|\s)(-[a-z]*m|--message)(=|\s+|(?=["']))("[^"]*"|'[^']*'|[^\s;&|]+)/g, '$1');
// The git subcommand of a segment (`git -C x add y` gives add), or null when it isn't git.
function gitSub(seg) {
  const w = words(seg);
  let i = 0;
  while (i < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]) || WRAPPERS.has(w[i]))) i++;
  if (basename(w[i] || '') !== 'git') return null;
  let j = i + 1;
  while (j < w.length && w[j].startsWith('-')) j += GIT_OPTS_WITH_VALUE.has(w[j]) ? 2 : 1;
  return w[j] || '';
}
// Tools whose own `push` is not a git push (docker push $IMG next to git add "$f").
const OTHER_PUSHERS = new Set(['docker', 'podman', 'buildah', 'skopeo', 'helm', 'oras']);
const READ_ONLY_GIT = new Set(['log', 'grep', 'show', 'diff', 'blame', 'status', 'shortlog', 'rev-list', 'ls-files', 'merge-base', 'rev-parse', 'branch', 'remote', 'tag']);

export function stagesOmaFiles(cmd) {
  return segments(dropMessages(cmd)).some(seg => ['add', 'commit', 'stage'].includes(gitSub(seg)) && /(^|[\s"'=\/])\.?\/?(\.oma|specs\/tickets)(\/|\s|$|"|')/.test(seg));
}

// The first-timer's whole allowed surface outside the browser tools and ToolSearch.
const BLIND_CD = /cd ([^\s;&|<>`$()"']+|"[^"$`\\]+"|'[^']+')/.source;
// Only this mod's own oma CLI (installed or repo copy), not any bin/oma on disk.
const BLIND_OMA = /(node [^\s;&|<>`$()"']*oh-my-agent-mod[^\s;&|<>`$()"']*\/bin\/oma|node "[^"$`\\]*oh-my-agent-mod[^"$`\\]*\/bin\/oma"|oma) (up|serve|stop|port) \d{2,5}( (\d?>>?|&>) ?\/dev\/null| 2>&1)*/.source;
// One plain cd, one plain oma call, or `cd <dir> && oma ...`.
const BLIND_BASH = new RegExp(`^(${BLIND_CD}|${BLIND_OMA}|${BLIND_CD} && ${BLIND_OMA})$`);
// Only the app on this machine: http(s) to localhost, 127.0.0.1, [::1] or a *.localhost name. No file:, no other hosts.
const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.localhost)(:\d{1,5})?([\/?#]|$)/i;
export function blindDecide(tool, ti, cwd = process.cwd()) {
  const no = 'the first-timer stays blind: it uses the app only through the browser';
  // No `..` segments: the node path to oma must stay inside oh-my-agent-mod.
  if (tool === 'Bash') return BLIND_BASH.test(String(ti.command || '').trim()) && !/oh-my-agent-mod\S*\/\.\.(\/|\s|$)/.test(String(ti.command)) ? null : `${no}; Bash runs only plain "oma up|serve|stop|port <port>" or "cd <dir>".`;
  if (tool === 'Write') {
    const dir = resolve(cwd, '.oma', 'job', 'first-timer');
    const file = resolve(cwd, String(ti.file_path || ''));
    return dirname(file) === dir && /^[\w.-]+\.md$/.test(basename(file)) ? null : `${no}; Write only creates <project>/.oma/job/first-timer/<name>.md.`;
  }
  // Allowlist: anything else (Read, Agent, Task, TeamCreate, CronCreate, ...) is off.
  if (!['ToolSearch', 'TodoWrite'].includes(tool) && !String(tool).startsWith('mcp__')) return `${no}; ${tool} is off.`;
  if (String(tool).startsWith('mcp__') && !String(tool).startsWith('mcp__Claude_Browser__')) return `${no}; only the built-in browser tools are on.`;
  if (/^mcp__Claude_Browser__(javascript|preview_)/.test(String(tool))) return `${no}; a visitor doesn't run scripts or servers in the browser.`;
  if (String(tool).startsWith('mcp__Claude_Browser__') && Object.entries(ti).some(([k, v]) => !['text', 'value', 'query', 'action_summary'].includes(k) && typeof v === 'string' && /^\s*(file|data|javascript|view-source|chrome|about):/i.test(v))) {
    return `${no}; the browser opens only the local app, never file: or other local schemes.`;
  }
  if (String(tool).startsWith('mcp__Claude_Browser__') && ti.url !== undefined && !['back', 'forward'].includes(ti.url) && (typeof ti.url !== 'string' || !LOCAL_URL.test(ti.url))) {
    return `${no}; the browser opens only the local app (http://localhost...), never file: URLs or other sites.`;
  }
  return null;
}

export function decide(input) {
  if (!input || typeof input.agent_type !== 'string' || !input.agent_type.startsWith(PREFIX)) return null;
  const ti = input.tool_input || {};
  const tool = input.tool_name;
  if (input.agent_type === `${PREFIX}first-timer`) {
    const blind = blindDecide(tool, ti, input.cwd || process.cwd());
    if (blind) return blind;
  }
  if (tool === 'Bash' || tool === 'Monitor') {
    const cmd = String(ti.command || '').replace(/\\\r?\n/g, ''); // backslash-newline joins lines
    // Catch-all for what the parser can't follow (variables, here-strings, xargs, source <(...)): git and push in one command.
    // Leave out commit messages and read-only git segments (git log --grep push, git grep push "$DIR").
    const bare = segments(dropMessages(cmd)).filter(seg => !READ_ONLY_GIT.has(gitSub(seg)) && gitSub(seg) !== 'stash' && !OTHER_PUSHERS.has(basename(words(seg)[0] || ''))).join(' ; ');
    // Only when the command runs text indirectly ($var, here-strings, xargs, source, eval, a nested shell).
    const indirect = /\$|`|<<<|\bxargs\b|(^|[;&|]\s*)(source|\.)\s|\beval\b|\b(ba|z|da|k)?sh\b/.test(bare + ' ' + dropMessages(cmd));
    // bash <<EOF ... EOF: the heredoc body is what the shell runs.
    const shellHeredoc = /\b(ba|z|da|k)?sh\b[^\n]*<</.test(cmd) && /(^|[^\w./-])git([^\w./-]|$)/.test(cmd) && /\bpush\b/.test(cmd);
    if (shellHeredoc || runsGitPush(dropMessages(cmd)) || (indirect && /(^|[^\w./-])git([^\w./-]|$)/.test(bare) && /(^|[\s;&|"'`({=])push([\s;&|"'`)}]|$)/.test(bare))) return 'git push is off for oh-my-agent agents: nothing leaves this machine until the person pushes it.';
    if (stagesOmaFiles(cmd)) return 'oma files (.oma/, specs/tickets/) are local and never committed: do not git add or commit them.';
    if (namesEnvFile(dropMessages(cmd))) return 'oh-my-agent agents never read .env files. List a needed one in .worktreeinclude instead.';
  }
  if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(tool) && isEnvName(ti.file_path || ti.notebook_path)) {
    return 'oh-my-agent agents never read or write .env files. List a needed one in .worktreeinclude instead.';
  }
  if (tool === 'Grep' && (isEnvName(ti.path) || expandBraces(String(ti.glob || '')).some(g => /(^|\/)\.env/i.test(g) || globHitsEnv(g) || (/[*?]./.test(basename(g)) && !/env\*/i.test(g) && globMatches(basename(g), ENV_NAMES))))) {
    return 'oh-my-agent agents never read .env files.';
  }
  if (typeof tool === 'string' && tool.startsWith(CM_PREFIX) && [ti.file_pattern, ti.path_filter, ti.file_path].some(targetsEnv)) {
    return 'oh-my-agent agents never read .env files.';
  }
  if ((tool === 'Agent' || tool === 'Task') && !String(ti.subagent_type || '').startsWith(PREFIX)) {
    return `oh-my-agent agents start only oh-my-agent-mod:* subagents (asked for ${ti.subagent_type || 'the default agent'}).`;
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

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]))) {
  try {
    main();
  } catch {
    /* never break a tool call */
  }
}
