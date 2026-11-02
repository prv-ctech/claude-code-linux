#!/usr/bin/env node
// oh-my-context-mod: PreToolUse hook on the Skill tool. In hide mode every skill the mod routes sits in
// its catalog (<state>/catalog/<safe id>/SKILL.md) and is found with resolve_skills and loaded with
// load_skill; a Skill call for one of them is denied with that pointer. Best effort: no state, no
// catalog or any error prints nothing (the call goes on) and exits 0. Stdout is the hook protocol.
const fs = require('fs');
const path = require('path');
const { paths } = require('./restore.js');
const { hideOn } = require('./prompt.js');

const safe = id => id.replace(/[^A-Za-z0-9._-]/g, '_');

// The catalog id the Skill call names, or null. A bare name (no plugin prefix) matches a catalog entry
// whose id ends in it; the id comes from the entry's own `name:` line, since ':' and '_' both map to '_'.
function catalogId(name, catalog) {
  const want = safe(name.replace(/^\//, '').trim());
  if (!want) return null;
  const dirs = fs.readdirSync(catalog);
  const dir = dirs.includes(want) ? want : dirs.find(d => d.endsWith(`_${want}`));
  if (!dir) return null;
  const m = /^name:[ \t]*(.+?)[ \t]*$/m.exec(fs.readFileSync(path.join(catalog, dir, 'SKILL.md'), 'utf8').slice(0, 2000));
  if (!m) return want === dir ? name : null;
  try {
    return m[1].startsWith('"') ? JSON.parse(m[1]) : m[1];
  } catch (e) {
    return m[1];
  }
}

// The deny reason, or null.
function decide(input, { stateDir, dataDir }) {
  // shortcut: the Skill tool_input shape is not in the hooks docs; `skill` is what Claude sends, the others are guesses.
  const ti = (input && input.tool_input) || {};
  const name = [ti.skill, ti.name, ti.command].find(v => typeof v === 'string');
  if (!name || !hideOn(stateDir, dataDir)) return null;
  const id = catalogId(name, path.join(stateDir, 'catalog'));
  return id ? `routed: call load_skill("${id}")` : null;
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const p = paths();
  const reason = decide(input, { stateDir: p.state, dataDir: p.pluginData });
  if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    /* never block a Skill call over this hook */
  }
}

module.exports = { decide, catalogId };
