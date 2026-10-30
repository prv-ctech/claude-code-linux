#!/usr/bin/env node
// oh-my-context-mod: UserPromptSubmit hook. Routed skills and tools are out of Claude's listing, so this
// asks `oh-my-context hint` (offline: the skill index and cached tool manifests only) which of them fit
// the prompt, and adds their names as one line of context. Skipped for short prompts and /commands,
// and when the line is the same as this session's last one. Any error prints nothing and exits 0.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { paths, readText, writeFileAtomic } = require('./restore.js');

const KEEP_SESSIONS = 20;

function runHint(prompt) {
  const bin = path.join(__dirname, '..', 'bin', 'oh-my-context');
  return spawnSync(bin, ['hint', '--k-skills', '3', '--k-tools', '3'], { input: prompt, encoding: 'utf8', timeout: 2000 });
}

// The context line, or null.
// dataDir: plugin data, which holds the off switch (sync.js offFile).
function hint(input, { run, stateDir, dataDir }) {
  const prompt = String(input.prompt || '');
  if (prompt.trim().length < 12 || prompt.trimStart().startsWith('/')) return null;
  if (dataDir && fs.existsSync(path.join(dataDir, 'off'))) return null;
  const r = run(prompt);
  if (!r || r.status !== 0 || !r.stdout) return null;
  const out = JSON.parse(r.stdout);
  const skills = (out.skills || []).map(s => s && s.name).filter(Boolean);
  const tools = (out.tools || []).map(t => t && t.claude_name).filter(Boolean);
  if (!skills.length && !tools.length) return null;
  const parts = [skills.length && `skills ${skills.join(', ')}`, tools.length && `tools ${tools.join(', ')}`].filter(Boolean);
  const line = `Routed matches for this prompt: ${parts.join('; ')}`;
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
  const line = hint(input, { run: runHint, stateDir: p.state, dataDir: p.pluginData });
  if (line) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: line } }));
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    /* a hint is optional; never hold up the prompt */
  }
}

module.exports = { hint };
