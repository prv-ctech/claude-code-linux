#!/usr/bin/env node
// mcptoon-mod. Argument: session (the SessionStart hook), status, on or off.
//
// On every session start it moves each enabled plugin's MCP servers, and the user's own servers in
// ~/.claude.json, into mcptoon's config, then turns the originals off for this project with
// disabledMcpServers (the key /mcp writes), so Claude sees only the mcptoon gateway. Skills leave
// Claude's listing: plugin SKILL.md files get `disable-model-invocation: true`, user skills get a
// skillOverrides entry, and mcptoon's skill index is rebuilt over all of them.
// Claude Code reads MCP and skill config at launch, so what a start changes counts from the next session.
//
// Everything the mod adds is recorded in state.json, so `off` removes exactly that and nothing the
// person set themselves. A server whose config needs a value the hook cannot read (a keychain
// option, an unset env var) stays direct.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ME = 'mcptoon-mod';
const root = path.resolve(__dirname, '..');
const FLAG = 'disable-model-invocation: true';
const OVERRIDE = 'user-invocable-only';
// mcptoon's own skill tells Claude how to reach everything else, so it stays listed.
const ALWAYS_LISTED = ['mcptoon'];

function paths(home = os.homedir(), env = process.env) {
  const claude = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  return {
    settings: path.join(claude, 'settings.json'),
    installed: path.join(claude, 'plugins', 'installed_plugins.json'),
    data: path.join(claude, 'plugins', 'data'),
    skills: path.join(claude, 'skills'),
    claudeJson: env.CLAUDE_CONFIG_DIR ? path.join(claude, '.claude.json') : path.join(home, '.claude.json'),
    mcptoon: env.MCPTOON_CONFIG_FILE || path.join(home, '.mcptoon', 'config.json'),
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

// For a file the mod rewrites: a missing file is `fallback`, but one that does not parse throws, so
// a half-written or hand-broken config is never replaced by the fallback plus the mod's keys.
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

// Write to a temp file and rename, so Claude never reads a half-written config. Keeps the file's mode.
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

const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

function frontmatter(text) {
  if (!text.startsWith('---')) return '';
  const end = text.indexOf('\n---', 3);
  return end < 0 ? '' : text.slice(0, end);
}

// Returns the patched text, or null when the skill already sets disable-model-invocation itself.
function patchSkill(text) {
  if (/^disable-model-invocation:/m.test(frontmatter(text))) return null;
  if (!text.startsWith('---')) return `---\n${FLAG}\n---\n${text}`;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  return `${text.slice(0, end)}\n${FLAG}${text.slice(end)}`;
}

function unpatchSkill(text) {
  if (text.startsWith(`---\n${FLAG}\n---\n`)) return text.slice(FLAG.length + 9);
  return text.replace(`\n${FLAG}\n---`, '\n---');
}

function skillName(file) {
  const m = frontmatter(readText(file)).match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/m);
  return m ? m[1] : path.basename(path.dirname(file));
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return '';
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

// SKILL.md files under dir: a skill is a folder holding one; other folders are searched to `depth`.
function findSkills(dir, depth) {
  let out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return out;
  }
  for (const n of names.sort()) {
    const full = path.join(dir, n);
    if (!isDir(full)) continue;
    if (fs.existsSync(path.join(full, 'SKILL.md'))) out.push(path.join(full, 'SKILL.md'));
    else if (depth > 1) out = out.concat(findSkills(full, depth - 1));
  }
  return out;
}

// Fills ${VAR}, ${VAR:-default}, ${CLAUDE_PLUGIN_ROOT}, ${CLAUDE_PLUGIN_DATA} and ${user_config.KEY}
// the way Claude Code does for .mcp.json. Names it cannot fill go to `missing`.
function resolve(value, vars, env, missing) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (m, name, def) => {
      if (name in vars) return String(vars[name]);
      if (env[name] !== undefined) return env[name];
      if (def !== undefined) return def;
      missing.push(name);
      return m;
    });
  }
  if (Array.isArray(value)) return value.map(v => resolve(v, vars, env, missing));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, vars, env, missing)]));
  }
  return value;
}

// shortcut: user-scope plugins from ~/.claude/settings.json only; project-scope plugins stay direct.
function enabledPlugins(p, settings) {
  const installed = readJson(p.installed, {}).plugins || {};
  return Object.entries(settings.enabledPlugins || {}).filter(([, on]) => on === true).flatMap(([id]) => {
    const inst = (installed[id] || [])[0];
    if (!inst || !inst.installPath) return [];
    const [name, market] = id.split('@');
    const manifest = readJson(path.join(inst.installPath, '.claude-plugin', 'plugin.json'), {});
    const defaults = Object.fromEntries(Object.entries(manifest.userConfig || {})
      .filter(([, o]) => o.default !== undefined && !o.sensitive).map(([k, o]) => [k, o.default]));
    const options = { ...defaults, ...(((settings.pluginConfigs || {})[id] || {}).options || {}) };
    return [{ id, name, root: inst.installPath, data: path.join(p.data, `${name}-${market}`), manifest, options }];
  });
}

function pluginServerConfigs(plugin) {
  const m = plugin.manifest.mcpServers;
  const fromFile = f => readJson(path.join(plugin.root, f), {}).mcpServers || {};
  return {
    ...fromFile('.mcp.json'),
    ...(typeof m === 'string' ? fromFile(m) : m && typeof m === 'object' ? m : {}),
  };
}

// Every MCP server Claude would start: the user's own and each enabled plugin's.
function collectServers(p, plugins, env) {
  const own = Object.entries(readJson(p.claudeJson, {}).mcpServers || {})
    .map(([server, cfg]) => ({ key: server, server, plugin: null, cfg, vars: {}, pluginEnv: {} }));
  const fromPlugins = plugins.flatMap(pl => Object.entries(pluginServerConfigs(pl)).map(([server, cfg]) => {
    const vars = { CLAUDE_PLUGIN_ROOT: pl.root, CLAUDE_PLUGIN_DATA: pl.data };
    for (const [k, v] of Object.entries(pl.options)) vars[`user_config.${k}`] = v;
    return { key: `plugin:${pl.name}:${server}`, server, plugin: pl.name, cfg, vars, pluginEnv: { CLAUDE_PLUGIN_ROOT: pl.root, CLAUDE_PLUGIN_DATA: pl.data } };
  }));
  return [...own, ...fromPlugins].map(s => ({ ...s, env }));
}

// Decides each server: forward (behind mcptoon, with its mcptoon config entry) or direct, with why.
function plan(servers, direct) {
  return servers.map(s => {
    const out = { key: s.key, name: s.server, forward: false, reason: '' };
    const type = s.cfg.type || (s.cfg.url ? 'http' : 'stdio');
    if (s.plugin === ME || s.cfg.command === 'mcptoon' || /\/mcptoon$/.test(s.cfg.command || '')) return { ...out, reason: 'the gateway itself' };
    if ([s.key, s.server, s.plugin].some(n => n && direct.includes(n))) return { ...out, reason: 'in direct_servers' };
    if (type !== 'stdio' && type !== 'http') return { ...out, reason: `${type} transport` };
    if (s.cfg.headersHelper) return { ...out, reason: 'headersHelper' };
    const missing = [];
    const cfg = resolve(s.cfg, s.vars, s.env, missing);
    if (missing.length) return { ...out, reason: `needs ${[...new Set(missing)].join(', ')}` };
    const entry = type === 'http'
      ? { transport: 'http', url: cfg.url, ...(cfg.headers && { headers: cfg.headers }) }
      : {
        transport: 'stdio',
        command: cfg.command,
        args: cfg.args || [],
        // Claude gives a plugin's stdio server these two; the gateway would otherwise pass its own.
        env: { ...s.pluginEnv, ...(cfg.env || {}) },
        ...(cfg.cwd && { cwd: cfg.cwd }),
      };
    return { ...out, forward: true, entry };
  });
}

function skillPlan(p, plugins, direct) {
  const keep = n => [...direct, ...ALWAYS_LISTED].includes(n);
  const pluginSkills = plugins.filter(pl => pl.name !== ME).flatMap(pl =>
    findSkills(path.join(pl.root, 'skills'), 1).filter(f => !keep(pl.name) && !keep(skillName(f))));
  const userSkills = [...new Set(findSkills(p.skills, 3).map(skillName))].filter(n => !keep(n));
  const roots = [p.skills, ...plugins.map(pl => path.join(pl.root, 'skills'))].filter(isDir);
  return { pluginSkills, userSkills, roots };
}

function options(settings) {
  const id = Object.keys(settings.enabledPlugins || {}).find(k => k.startsWith(`${ME}@`));
  const defaults = Object.fromEntries(Object.entries(readJson(path.join(root, '.claude-plugin', 'plugin.json'), {}).userConfig || {})
    .map(([k, o]) => [k, o.default]));
  return { id, ...defaults, ...(((settings.pluginConfigs || {})[id] || {}).options || {}) };
}

function stateFile(p, id, env) {
  const dir = env.CLAUDE_PLUGIN_DATA || path.join(p.data, id ? id.replace('@', '-') : `${ME}-claude-code-linux`);
  return path.join(dir, 'state.json');
}

function loadState(file) {
  return { off: false, servers: [], projects: {}, skills: [], overrides: [], ...readConfig(file, {}) };
}

function runMcptoon(args) {
  return spawnSync(path.join(root, 'bin', 'mcptoon'), args, { encoding: 'utf8', timeout: 90000 });
}

// Puts `want` in place of what the mod added last time, leaving the person's own entries alone.
// Returns the list to write and what the mod now owns in it.
function swap(current, mine, want) {
  const base = current.filter(x => !mine.includes(x));
  const owned = want.filter(x => !base.includes(x));
  return { next: [...base, ...owned], owned };
}

function apply(p, cwd, env, run) {
  // Every file it rewrites is read first, so a parse error stops it before any write.
  const settings = readConfig(p.settings, {});
  const opts = options(settings);
  const file = stateFile(p, opts.id, env);
  const state = loadState(file);
  const mc = readConfig(p.mcptoon, {});
  const cj = readConfig(p.claudeJson, {});
  const before = JSON.stringify(state);
  const plugins = enabledPlugins(p, settings);

  // 1. mcptoon config: replace the entries the mod wrote last time.
  const servers = plan(collectServers(p, plugins, env), list(opts.direct_servers));
  mc.servers = mc.servers || {};
  for (const n of state.servers) delete mc.servers[n];
  state.servers = [];
  for (const s of servers.filter(x => x.forward)) {
    if (mc.servers[s.name]) {
      Object.assign(s, { forward: false, reason: 'name already used in the mcptoon config' });
      continue;
    }
    mc.servers[s.name] = s.entry;
    state.servers.push(s.name);
  }
  writeJson(p.mcptoon, mc, 0o600);
  // It now holds servers' env and headers, so it is the owner's alone whatever it was before.
  fs.chmodSync(p.mcptoon, 0o600);

  // 2. Turn the forwarded originals off in this project.
  cj.projects = cj.projects || {};
  const proj = cj.projects[cwd] = cj.projects[cwd] || {};
  const want = servers.filter(s => s.forward).map(s => s.key);
  const d = swap(proj.disabledMcpServers || [], state.projects[cwd] || [], want);
  if (JSON.stringify(d.next) !== JSON.stringify(proj.disabledMcpServers || [])) {
    proj.disabledMcpServers = d.next;
    writeJson(p.claudeJson, cj, 0o600);
  }
  state.projects[cwd] = d.owned;

  // 3. Skills out of Claude's listing.
  const sk = skillPlan(p, plugins, list(opts.direct_skills));
  for (const f of state.skills.filter(f => !sk.pluginSkills.includes(f))) {
    if (fs.existsSync(f)) fs.writeFileSync(f, unpatchSkill(readText(f)));
  }
  state.skills = state.skills.filter(f => sk.pluginSkills.includes(f) && fs.existsSync(f));
  for (const f of sk.pluginSkills.filter(f => !state.skills.includes(f))) {
    const patched = patchSkill(readText(f));
    if (patched === null) continue;
    fs.writeFileSync(f, patched);
    state.skills.push(f);
  }
  const overrides = { ...(settings.skillOverrides || {}) };
  const userSet = Object.keys(overrides).filter(n => !state.overrides.includes(n));
  for (const n of state.overrides) delete overrides[n];
  state.overrides = sk.userSkills.filter(n => !userSet.includes(n));
  for (const n of state.overrides) overrides[n] = OVERRIDE;
  if (JSON.stringify(overrides) !== JSON.stringify(settings.skillOverrides || {})) {
    if (Object.keys(overrides).length) settings.skillOverrides = overrides;
    else delete settings.skillOverrides;
    writeJson(p.settings, settings, 0o644);
  }

  // 4. mcptoon's skill index over every skill, hidden or not.
  const indexed = run(['skills', 'index', ...sk.roots]).status === 0;

  writeJson(file, state, 0o600);
  return { servers, state, indexed, changed: JSON.stringify(state) !== before };
}

// Removes everything the mod added, in every project it touched.
function restore(p, env) {
  const settings = readConfig(p.settings, {});
  const file = stateFile(p, options(settings).id, env);
  const state = loadState(file);
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
  writeJson(file, { ...state, servers: [], projects: {}, skills: [], overrides: [] }, 0o600);
  return file;
}

function setOff(p, env, off) {
  const file = stateFile(p, options(readConfig(p.settings, {})).id, env);
  writeJson(file, { ...loadState(file), off }, 0o600);
}

function sessionContext(r) {
  const fwd = r.servers.filter(s => s.forward).map(s => s.key);
  const hidden = r.state.skills.length + r.state.overrides.length;
  const lines = [
    `mcptoon-mod: ${fwd.length} MCP server(s) run behind the mcptoon gateway${fwd.length ? ` (${fwd.join(', ')})` : ''} and ${hidden} skill(s) are out of the skill listing.`,
    'Their tools: mcptoon_manifest, then mcptoon_inspect and mcptoon_call on the mcptoon server (or the `mcptoon manifest` / `mcptoon call` CLI).',
    'Skills: `mcptoon skills resolve "<task>" --k 5`, then Read the SKILL.md it returns. The Skill tool refuses a hidden skill; read its SKILL.md instead.',
  ];
  if (r.changed) lines.push('This start changed the setup; MCP servers and the skill listing follow it from the next session.');
  if (!r.indexed) lines.push('The mcptoon skill index did not rebuild this time.');
  return lines.join('\n');
}

function status(p, cwd, env, run) {
  const settings = readJson(p.settings, {});
  const opts = options(settings);
  const state = loadState(stateFile(p, opts.id, env));
  const v = run(['--version']);
  const plugins = enabledPlugins(p, settings);
  const servers = plan(collectServers(p, plugins, env), list(opts.direct_servers));
  const off = new Set(state.projects[cwd] || []);
  const sk = skillPlan(p, plugins, list(opts.direct_skills));
  const out = [
    `mcptoon-mod: ${state.off ? 'off' : 'on'} · mcptoon CLI: ${v.status === 0 ? v.stdout.trim() : 'not runnable'}`,
    '',
    `MCP servers (${cwd}):`,
    ...servers.map(s => `  ${(s.forward ? (off.has(s.key) ? 'forwarded' : 'forward*') : 'direct').padEnd(9)}  ${s.key}${s.reason ? `  (${s.reason})` : ''}`),
    '  * forward on the next session start in this project',
    '',
    `Skills: ${state.skills.length} plugin skill(s) and ${state.overrides.length} user skill(s) hidden now; ${sk.pluginSkills.length + sk.userSkills.length} would be on the next start.`,
    `Filters (plugin settings): direct_servers = "${opts.direct_servers || ''}", direct_skills = "${opts.direct_skills || ''}"`,
  ];
  return out.join('\n');
}

function main() {
  const mode = process.argv[2] || 'status';
  const p = paths();
  const env = process.env;
  if (mode === 'session') {
    let payload = {};
    try {
      payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    } catch (e) {
      /* no payload */
    }
    let text;
    try {
      if (loadState(stateFile(p, options(readConfig(p.settings, {})).id, env)).off) return;
      if (runMcptoon(['--version']).status !== 0) {
        // No gateway means no way to reach a hidden server, so nothing stays hidden.
        restore(p, env);
        text = 'mcptoon-mod: the mcptoon CLI did not run, so every MCP server and skill is direct again.';
      } else {
        text = sessionContext(apply(p, payload.cwd || process.cwd(), env, runMcptoon));
      }
    } catch (e) {
      text = `mcptoon-mod: ${e.message}`;
    }
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
    return;
  }
  if (mode === 'status') return console.log(status(p, process.cwd(), env, runMcptoon));
  if (mode === 'off') {
    restore(p, env);
    setOff(p, env, true);
    return console.log('mcptoon-mod: off. Every MCP server and skill the mod moved is back; Claude Code shows them from the next session. Run this before you disable or uninstall the mod.');
  }
  if (mode === 'on') {
    if (runMcptoon(['--version']).status !== 0) {
      console.error('mcptoon-mod: the mcptoon CLI did not run, so nothing was moved.');
      process.exitCode = 1;
      return;
    }
    setOff(p, env, false);
    const r = apply(p, process.cwd(), env, runMcptoon);
    return console.log(`${sessionContext(r)}\n\n${status(p, process.cwd(), env, runMcptoon)}`);
  }
  console.error(`mcptoon-mod: unknown argument ${mode}; use status, on or off`);
  process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`mcptoon-mod: ${e.message}`);
    process.exitCode = 1;
  }
}

module.exports = { paths, resolve, plan, patchSkill, unpatchSkill, swap, apply, restore, status, collectServers, enabledPlugins };
