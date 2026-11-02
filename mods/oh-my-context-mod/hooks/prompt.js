#!/usr/bin/env node
// oh-my-context-mod: UserPromptSubmit hook. Routed skills and tools are out of Claude's listing, so this
// asks `oh-my-context hint` (offline: the skill index and cached tool manifests only) which of them fit
// the prompt, and adds their ids as one line of context (plus, in hide mode, a line saying skills load
// with load_skill). Skipped for short prompts and /commands, and when the text is the same as this
// session's last one. `prompt.js subagent` is the SubagentStart handler: one line for the subagent.
// Any error prints nothing and exits 0.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { paths, readText, writeFileAtomic } = require('./restore.js');

const LOAD_HINT = 'Skills are hidden from the native list: load one with load_skill(<id>) (resolve_skills searches); never Read a path or use the Skill tool.';
const SUBAGENT_HINT = 'Skills are hidden from the native list: find them with the oh-my-context resolve_skills tool, load one with load_skill(<id>); never Read a path or use the Skill tool.';

// Hide mode, which sync.js records as `hide: true` in state.json (a missing key is off), unless the mod is off.
function hideOn(stateDir, dataDir) {
  if (dataDir && fs.existsSync(path.join(dataDir, 'off'))) return false;
  try {
    return JSON.parse(readText(path.join(stateDir, 'state.json')) || '{}').hide === true;
  } catch (e) {
    return false;
  }
}

const KEEP_SESSIONS = 20;

function runHint(prompt) {
  const bin = path.join(__dirname, '..', 'bin', 'oh-my-context');
  return spawnSync(bin, ['hint', '--k-skills', '3', '--k-tools', '3'], { input: prompt, encoding: 'utf8', timeout: 2000 });
}

// The context line, or null.
// dataDir: plugin data, which holds the off switch (sync.js offFile). hide: hide mode is on.
function hint(input, { run, stateDir, dataDir, hide }) {
  const prompt = String(input.prompt || '');
  if (prompt.trim().length < 12 || prompt.trimStart().startsWith('/')) return null;
  if (dataDir && fs.existsSync(path.join(dataDir, 'off'))) return null;
  const r = run(prompt);
  if (!r || r.status !== 0 || !r.stdout) return null;
  const out = JSON.parse(r.stdout);
  const skills = (out.skills || []).map(s => s && (s.id || s.name)).filter(Boolean);
  const tools = (out.tools || []).map(t => t && t.claude_name).filter(Boolean);
  if (!skills.length && !tools.length) return null;
  const parts = [skills.length && `skills ${skills.join(', ')}`, tools.length && `tools ${tools.join(', ')}`].filter(Boolean);
  const line = `Routed matches for this prompt: ${parts.join('; ')}`
    + (hide && skills.length ? `\n${LOAD_HINT}` : '');
  const file = path.join(stateDir, 'hints.json');
  let seen = {};
  try {
    seen = JSON.parse(readText(file) || '{}');
  } catch (e) {
    seen = {};
  }
  const sid = String(input.session_id || '');
  if (seen[sid] === line) return null;
  delete seen[sid];
  seen[sid] = line;
  const keys = Object.keys(seen);
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_SESSIONS))) delete seen[k];
  writeFileAtomic(file, JSON.stringify(seen), 0o600, false);
  return line;
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const p = paths();
  const hide = hideOn(p.state, p.pluginData);
  if (process.argv[2] === 'subagent') {
    if (hide) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: SUBAGENT_HINT } }));
    return;
  }
  const line = hint(input, { run: runHint, stateDir: p.state, dataDir: p.pluginData, hide });
  if (line) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: line } }));
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    /* a hint is optional; never hold up the prompt */
  }
}

module.exports = { hint, hideOn, SUBAGENT_HINT };
