#!/usr/bin/env node
// mcptoon-mod 0.1.1: restore only. 0.1.0 moved MCP servers into ~/.mcptoon/config.json, turned the
// originals off with disabledMcpServers, flagged plugin SKILL.md files and set skillOverrides, all
// journaled in ${CLAUDE_PLUGIN_DATA}/state.json. Each session start undoes that with 0.1.0's own
// restore(). It never sets `off`: oh-my-context-mod reads this state to migrate, and an off flag
// would switch it off too.
const fs = require('fs');
const os = require('os');
const path = require('path');

const LINE = 'mcptoon-mod 0.1.1 put back its 0.1.0 changes. Install oh-my-context-mod from this marketplace, then uninstall mcptoon-mod.';
const FLAG = 'disable-model-invocation: true';

function paths(home = os.homedir(), env = process.env) {
  const claude = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  return {
    settings: path.join(claude, 'settings.json'),
    claudeJson: env.CLAUDE_CONFIG_DIR ? path.join(claude, '.claude.json') : path.join(home, '.claude.json'),
    mcptoon: env.MCPTOON_CONFIG_FILE || path.join(home, '.mcptoon', 'config.json'),
    state: path.join(env.CLAUDE_PLUGIN_DATA || path.join(claude, 'plugins', 'data', 'mcptoon-mod-claude-code-linux'), 'state.json'),
  };
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return '';
  }
}

// A missing file is `fallback`; one that does not parse throws, so it is never rewritten.
function readConfig(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}); the mod changed nothing`);
  }
}

// Temp file and rename, keeping the file's mode (0.1.0's writeJson).
function writeJson(file, data, mode) {
  let keep = mode;
  try {
    keep = fs.statSync(file).mode & 0o777;
  } catch (e) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: keep || 0o644 });
  fs.renameSync(tmp, file);
}

function unpatchSkill(text) {
  if (text.startsWith(`---\n${FLAG}\n---\n`)) return text.slice(FLAG.length + 9);
  return text.replace(`\n${FLAG}\n---`, '\n---');
}

function loadState(file) {
  return { off: false, servers: [], projects: {}, skills: [], overrides: [], ...readConfig(file, {}) };
}

// 0.1.0's restore(), unchanged except that it returns early when nothing is recorded, so a
// session start does not rewrite ~/.claude.json for nothing.
function restore(p) {
  const state = loadState(p.state);
  if (!state.servers.length && !Object.keys(state.projects).length && !state.skills.length && !state.overrides.length) return false;
  const settings = readConfig(p.settings, {});
  const mc = readConfig(p.mcptoon, null);
  const cj = readConfig(p.claudeJson, null);
  if (mc && mc.servers) {
    for (const n of state.servers) delete mc.servers[n];
    writeJson(p.mcptoon, mc, 0o600);
  }
  if (cj && cj.projects) {
    for (const [dir, mine] of Object.entries(state.projects)) {
      const proj = cj.projects[dir];
      if (proj && proj.disabledMcpServers) proj.disabledMcpServers = proj.disabledMcpServers.filter(k => !mine.includes(k));
    }
    writeJson(p.claudeJson, cj, 0o600);
  }
  for (const f of state.skills) if (fs.existsSync(f)) fs.writeFileSync(f, unpatchSkill(readText(f)));
  if (state.overrides.length && settings.skillOverrides) {
    for (const n of state.overrides) delete settings.skillOverrides[n];
    if (!Object.keys(settings.skillOverrides).length) delete settings.skillOverrides;
    writeJson(p.settings, settings, 0o644);
  }
  writeJson(p.state, { ...state, servers: [], projects: {}, skills: [], overrides: [] }, 0o600);
  return true;
}

function main() {
  let text = LINE;
  try {
    restore(paths());
  } catch (e) {
    text = `mcptoon-mod 0.1.1 could not put back its 0.1.0 changes: ${e.message}`;
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
}

if (require.main === module) main();

module.exports = { paths, restore, unpatchSkill };
