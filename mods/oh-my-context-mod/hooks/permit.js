#!/usr/bin/env node
// oh-my-context-mod: PreToolUse hook on the gateway's call tool. A routed call reaches Claude as one gateway tool,
// so the person's permission rules for the original tool would never match it. This maps the call
// back to the original Claude tool name (mcp__<server>__<tool>) and answers what those rules say:
// deny > ask > allow over managed, user, project and local settings. With no rule it asks, as Claude
// would for an MCP tool nobody allowed, except in auto and bypassPermissions mode (prints nothing).
// A call in a form that cannot be mapped back is denied with a note on the accepted forms.
// Never breaks the call path: any error prints nothing and exits 0.
const fs = require('fs');
const path = require('path');
const { paths } = require('./restore.js');

// Modes where Claude itself would not ask for an MCP tool without a rule.
const NO_ASK = new Set(['auto', 'bypassPermissions']);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

const norm = s => String(s).replace(/[^A-Za-z0-9_-]/g, '_');

const FORMS = 'The gateway\'s call tool: pass `tool` as the original tool name (mcp__<server>__<tool>), or `server` plus `tool`, '
  + 'and no `name`, so your permission rules can be checked';

// The original Claude tool name of a routed call, or null. Exactly the two forms the gateway
// runs: (a) `tool` = mcp__... with `server` absent or the server that name belongs to, (b) `server`
// plus a plain `tool`. Any other form (a `name`, a bare `tool`) is null, and decide() refuses it.
function originalName(toolInput, servers) {
  const ti = toolInput || {};
  const str = k => (typeof ti[k] === 'string' ? ti[k] : '');
  const tool = str('tool');
  const server = str('server');
  if (!tool || str('name')) return null;
  const e = server ? servers && servers[server] : null;
  if (server && !(e && e.claude_prefix)) return null;
  // Normalized as Claude names tools, so a rule for mcp__fs__files_delete matches `files.delete`.
  if (tool.startsWith('mcp__')) return !server || tool.startsWith(`${e.claude_prefix}__`) ? norm(tool) : null;
  return server ? `${e.claude_prefix}__${norm(tool)}` : null;
}

// Rule forms: mcp__server (the whole server), mcp__server__tool, and * wildcards.
function ruleMatches(rule, name) {
  if (typeof rule !== 'string' || !rule.startsWith('mcp__') || rule.includes('(')) return false;
  if (rule === name) return true;
  if (rule.includes('*')) {
    const re = rule.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${re}$`).test(name);
  }
  return !rule.slice(5).includes('__') && name.startsWith(`${rule}__`);
}

// { decision, reason } or null.
function decide(input, { files, servers }) {
  const name = originalName(input.tool_input, servers);
  // Defense in depth: a form the rules cannot be mapped to is refused, never let through unchecked.
  if (!name) return { decision: 'deny', reason: FORMS };
  const rules = { deny: [], ask: [], allow: [] };
  for (const f of files) {
    const perms = (readJson(f) || {}).permissions || {};
    for (const k of Object.keys(rules)) if (Array.isArray(perms[k])) rules[k].push(...perms[k]);
  }
  for (const d of ['deny', 'ask', 'allow']) {
    const rule = rules[d].find(r => ruleMatches(r, name));
    if (rule) return { decision: d, reason: `routed call to ${name}: your ${d} rule "${rule}" applies` };
  }
  if (NO_ASK.has(input.permission_mode)) return null;
  const server = name.slice(0, name.indexOf('__', 5));
  return { decision: 'ask', reason: `routed call to ${name}: no permission rule matches it; allow "${server}" or "${name}" to skip this prompt` };
}

// The settings files Claude reads permission rules from: managed (managed-settings.json and the
// managed-settings.d/*.json drop-ins, no dotfiles), user, and the project root's project and local.
// shortcut: --settings and --disallowedTools are invisible to a command hook; Claude still applies
// them to the gateway's call tool itself.
function ruleFiles(p, root) {
  const dropIn = path.join(p.managedDir, 'managed-settings.d');
  let drops = [];
  try {
    drops = fs.readdirSync(dropIn).filter(n => n.endsWith('.json') && !n.startsWith('.')).sort().map(n => path.join(dropIn, n));
  } catch (e) {
    /* no drop-in dir */
  }
  return [path.join(p.managedDir, 'managed-settings.json'), ...drops, p.settings,
    path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json')];
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const p = paths();
  // input.cwd follows a Bash `cd`; Claude reads project settings from the project root, which it
  // exports to command hooks as CLAUDE_PROJECT_DIR.
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const state = readJson(path.join(p.state, 'state.json')) || {};
  const gateway = readJson((state.paths && state.paths.gateway) || p.gateway) || {};
  const d = decide(input, { files: ruleFiles(p, root), servers: gateway.servers || {} });
  if (!d) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.decision, permissionDecisionReason: d.reason },
  }));
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    /* never block a call over this hook */
  }
}

module.exports = { originalName, ruleMatches, decide, ruleFiles };
