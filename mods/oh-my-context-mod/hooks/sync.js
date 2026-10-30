#!/usr/bin/env node
// oh-my-context-mod. Argument: session (the SessionStart hook), status, on or off.
//
// On every session start it routes every MCP server Claude would start (the user's own and
// local-scope servers in ~/.claude.json, and each enabled plugin's, user or project scope) through
// the oh-my-context gateway: each one gets an entry in the gateway config and is turned off for this
// project with disabledMcpServers (the key /mcp writes), so Claude sees only the gateway's tools.
// Skills stay invocable but cost almost nothing: user skills get skillOverrides "name-only", plugin
// SKILL.md files and plugin commands get the one-line description "routed" (both still invocable by
// Claude and as /name). Global plugins and user skills are changed only while the mod is enabled at
// user scope, since every project sees them. oh-my-context's skill index is rebuilt over the original
// files, so the gateway's resolve_skills tool finds them by what they do.
// Claude Code reads MCP and skill config at launch, so what a start changes counts from the next session.
//
// Everything the mod adds is journaled in <config>/oh-my-context-mod/state.json before it is made, so
// `off` and the guard (restore.js, run from the person's own settings hooks) remove exactly that and
// nothing the person set themselves. A server that would break behind the gateway stays direct.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const R = require('./restore.js');

const { ME, paths, sha, readText, readConfig, writeFileAtomic, writeJson, withLock, loadState, saveState } = R;
const root = path.resolve(__dirname, '..');
const ROUTED = 'description: routed';
const NAME_ONLY = 'name-only';
const GATEWAY = 'the gateway itself';
const CONFIG_CHANGE = 'user_settings|project_settings|local_settings';

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
const arr = v => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
// Claude's rule for tool-name segments.
const norm = s => String(s).replace(/[^A-Za-z0-9_-]/g, '_');
const shq = s => `'${String(s).replace(/'/g, "'\\''")}'`;

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

// --- frontmatter --------------------------------------------------------------------------------

// { bom, eol, front } where front is null (no frontmatter), false (opened but never closed) or
// { head: lines between the fences, rest: the closing fence and everything after it }.
// bom: a leading UTF-8 BOM, which Claude strips before it parses frontmatter.
function splitFront(text) {
  const bom = text.charCodeAt(0) === 0xfeff ? '﻿' : '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.slice(bom.length).split(eol);
  if (lines[0].trimEnd() !== '---') return { bom, eol, front: null };
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (end < 0) return { bom, eol, front: false };
  return { bom, eol, front: { head: lines.slice(1, end), rest: lines.slice(end).join(eol) } };
}

// Top-level YAML keys with their lines, block scalars (| >) and indented continuations included.
// null when a line fits none of that, so an odd frontmatter is left alone rather than guessed at.
function blocks(head) {
  const out = [];
  const seen = new Set();
  for (const line of head) {
    const key = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
    if (key) {
      if (seen.has(key[1])) return null;
      seen.add(key[1]);
      out.push({ key: key[1], lines: [line] });
    } else if (!line.trim() || /^[ \t]/.test(line) || /^-(\s|$)/.test(line)) {
      if (!out.length) {
        if (line.trim()) return null;
        out.push({ key: null, lines: [line] });
      } else out[out.length - 1].lines.push(line);
    } else if (line.startsWith('#')) out.push({ key: null, lines: [line] });
    else return null;
  }
  return out;
}

const unquote = v => v.trim().replace(/^(["'])(.*)\1$/, '$2');

function meta(text, fallbackName) {
  const { front } = splitFront(text);
  const b = front ? blocks(front.head) : [];
  const get = k => {
    const x = b && b.find(y => y.key === k);
    return x ? unquote(x.lines[0].slice(x.lines[0].indexOf(':') + 1)) : undefined;
  };
  return {
    name: get('name') || fallbackName,
    dmi: b ? b.some(x => x.key === 'disable-model-invocation') : /^disable-model-invocation:/m.test(text),
    parsed: front !== false && b !== null,
  };
}

// A SKILL.md or command text with a one-line description and no when_to_use; null when it cannot be
// done safely.
function routeSkill(text) {
  const { bom, eol, front } = splitFront(text);
  if (front === false) return null;
  if (front === null) return `${bom}---${eol}${ROUTED}${eol}---${eol}${text.slice(bom.length)}`;
  const b = blocks(front.head);
  if (!b) return null;
  const out = [];
  let done = false;
  for (const x of b) {
    if (x.key === 'when_to_use') continue;
    if (x.key === 'description') {
      if (!done) out.push(ROUTED);
      done = true;
      continue;
    }
    out.push(...x.lines);
  }
  if (!done) out.push(ROUTED);
  return bom + ['---', ...out, front.rest].join(eol);
}

// The original text with `name` set to the id the Skill tool takes, for the catalog. No BOM: the
// indexer reads plain utf-8 and wants `---` first.
function withName(text, id) {
  const line = /^[A-Za-z0-9:._-]+$/.test(id) ? `name: ${id}` : `name: ${JSON.stringify(id)}`;
  const { bom, eol, front } = splitFront(text);
  const body = text.slice(bom.length);
  const b = front ? blocks(front.head) : null;
  if (!b) {
    // Claude describes a skill without frontmatter by its first body line, so the index does too.
    const first = front === null && body.split(/\r?\n/).map(l => l.replace(/^#+\s*/, '').trim()).find(Boolean);
    const desc = first ? `${eol}description: ${JSON.stringify(first.slice(0, 300))}` : '';
    return `---${eol}${line}${desc}${eol}---${eol}${body}`;
  }
  const head = b.some(x => x.key === 'name')
    ? b.flatMap(x => (x.key === 'name' ? [line] : x.lines))
    : [line, ...front.head];
  return ['---', ...head, front.rest].join(eol);
}

// --- discovery ----------------------------------------------------------------------------------

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

function findMarkdown(dir, depth) {
  let out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return out;
  }
  for (const n of names.sort()) {
    const full = path.join(dir, n);
    if (isDir(full)) {
      if (depth > 1) out = out.concat(findMarkdown(full, depth - 1));
    } else if (n.endsWith('.md')) out.push(full);
  }
  return out;
}

// A plugin's relative path, only when it stays inside the plugin.
function inPlugin(pl, rel) {
  if (typeof rel !== 'string') return null;
  const abs = path.resolve(pl.root, rel);
  return abs === pl.root || abs.startsWith(pl.root + path.sep) ? abs : null;
}

function pluginSkillFiles(pl) {
  const dirs = ['skills', ...arr(pl.manifest.skills)].map(r => inPlugin(pl, r)).filter(Boolean);
  const files = dirs.flatMap(d => (fs.existsSync(path.join(d, 'SKILL.md')) ? [path.join(d, 'SKILL.md')] : findSkills(d, 1)));
  return [...new Set(files)];
}

// commands in plugin.json replaces the default commands/ folder.
function pluginCommandFiles(pl) {
  const m = pl.manifest.commands;
  const rels = m === undefined ? ['commands']
    : typeof m === 'object' && !Array.isArray(m) ? Object.values(m).map(v => v && v.source)
      : arr(m);
  const files = rels.map(r => inPlugin(pl, r)).filter(Boolean)
    .flatMap(f => (isDir(f) ? findMarkdown(f, 2) : f.endsWith('.md') && fs.existsSync(f) ? [f] : []));
  return [...new Set(files)];
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

// Every plugin enabled at user scope (global: routed for every project) or in this project's
// .claude/settings.json or settings.local.json (scope: cwd). Local wins over project over user.
// here: whether Claude starts it in this project.
function enabledPlugins(p, cwd, settings) {
  const installed = readJson(p.installed, {}).plugins || {};
  const user = settings.enabledPlugins || {};
  const project = readJson(path.join(cwd, '.claude', 'settings.json'), {}).enabledPlugins || {};
  const local = readJson(path.join(cwd, '.claude', 'settings.local.json'), {}).enabledPlugins || {};
  const ids = [...new Set([...Object.keys(user), ...Object.keys(project), ...Object.keys(local)])];
  const secrets = readJson(p.credentials, {}).pluginSecrets || {};
  return ids.flatMap(id => {
    const global = user[id] === true;
    const eff = id in local ? local[id] : id in project ? project[id] : user[id];
    const here = eff === true;
    if (!global && !here) return [];
    const entries = Array.isArray(installed[id]) ? installed[id] : [];
    const userEntry = entries.find(e => !e.scope || e.scope === 'user');
    const inst = (global ? userEntry : entries.find(e => e.projectPath === cwd)) || userEntry || entries[0];
    if (!inst || !inst.installPath) return [];
    const name = id.split('@')[0];
    const manifest = readJson(path.join(inst.installPath, '.claude-plugin', 'plugin.json'), {});
    const spec = manifest.userConfig || {};
    const defaults = Object.fromEntries(Object.entries(spec)
      .filter(([, o]) => o && o.default !== undefined && !o.sensitive).map(([k, o]) => [k, o.default]));
    // Sensitive options come from Claude's file credential store when it has one (Linux); with a
    // keychain the file holds none, and the server stays direct ("needs user_config.<key>").
    const stored = secrets[id] || {};
    const sensitive = Object.fromEntries(Object.entries(spec)
      .filter(([k, o]) => o && o.sensitive && typeof stored[k] === 'string').map(([k]) => [k, stored[k]]));
    const options = { ...defaults, ...(((settings.pluginConfigs || {})[id] || {}).options || {}), ...sensitive };
    const data = path.join(p.data, id.replace(/[^A-Za-z0-9_-]/g, '-'));
    return [{ id, name, root: path.resolve(inst.installPath), data, manifest, options, scope: global ? null : cwd, here }];
  });
}

// The servers Claude signs in to with OAuth: mcpOAuth in its file credential store is keyed
// "<server key>|<hash>", written as soon as a server asks for sign-in. Key names only; tokens are never read.
function oauthServers(p) {
  const o = readJson(p.credentials, {}).mcpOAuth;
  return new Set(o && typeof o === 'object' ? Object.keys(o).map(k => k.slice(0, k.lastIndexOf('|'))) : []);
}

function pluginServerConfigs(plugin) {
  const m = plugin.manifest.mcpServers;
  const fromFile = f => {
    const abs = inPlugin(plugin, f);
    return abs ? readJson(abs, {}).mcpServers || {} : {};
  };
  const listed = arr(m).map(x => (typeof x === 'string' ? fromFile(x) : x && typeof x === 'object' ? x : {}));
  return Object.assign({}, fromFile('.mcp.json'), ...listed);
}

// Every MCP server Claude would start here, plus the global ones the gateway serves everywhere.
function collectServers(p, cwd, plugins, cj, env) {
  const local = ((cj.projects || {})[cwd] || {}).mcpServers || {};
  const shared = readJson(path.join(cwd, '.mcp.json'), {}).mcpServers || {};
  const user = Object.entries(cj.mcpServers || {}).map(([n, cfg]) => ({
    key: n, server: n, plugin: null, cfg, vars: {}, pluginEnv: {}, scope: null,
    // A local-scope or project server of the same name replaces the user's in this project.
    here: !(n in local) && !(n in shared), prefix: `mcp__${norm(n)}`, names: [n, `${n}@user`],
  }));
  const loc = Object.entries(local).map(([n, cfg]) => ({
    key: n, server: n, plugin: null, cfg, vars: {}, pluginEnv: {}, scope: cwd, here: true,
    prefix: `mcp__${norm(n)}`, names: [`${n}@local`],
  }));
  const project = Object.entries(shared).map(([n, cfg]) => ({
    key: n, server: n, plugin: null, cfg, vars: {}, pluginEnv: {}, scope: cwd, here: true,
    prefix: `mcp__${norm(n)}`, names: [], project: true,
  }));
  const fromPlugins = plugins.flatMap(pl => Object.entries(pluginServerConfigs(pl)).map(([server, cfg]) => {
    const vars = { CLAUDE_PLUGIN_ROOT: pl.root, CLAUDE_PLUGIN_DATA: pl.data };
    for (const [k, v] of Object.entries(pl.options)) vars[`user_config.${k}`] = v;
    return {
      key: `plugin:${pl.name}:${server}`, server, plugin: pl.name, cfg: cfg || {}, vars,
      pluginEnv: { CLAUDE_PLUGIN_ROOT: pl.root, CLAUDE_PLUGIN_DATA: pl.data },
      scope: pl.scope, here: pl.here, prefix: `mcp__${norm(`plugin_${pl.name}_${server}`)}`,
      names: [server, `${pl.name}__${server}`],
    };
  }));
  return [...user, ...loc, ...project, ...fromPlugins].map(s => ({ ...s, env }));
}

// The gateway must never route to itself, whatever form its command takes, nor to an upstream
// mcptoon gateway (the project oh-my-context is derived from): one gateway behind the other would
// hide the same servers twice.
const GATEWAYS = ['oh-my-context', 'mcptoon'];
function isGateway(s, cfg) {
  if (s.plugin === ME || GATEWAYS.includes(s.server)) return true;
  const cmd = String(cfg.command || '');
  const args = arr(cfg.args).map(String);
  if (GATEWAYS.includes(path.basename(cmd))) return true;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-m' && /^(oh_my_context|mcptoon)(\.cli)?$/.test(args[i + 1] || '')) return true;
    if (GATEWAYS.includes(path.basename(args[i])) && args[i + 1] === 'serve') return true;
  }
  return cmd.startsWith(root + path.sep);
}

// Decides each server: forward (behind oh-my-context, with its gateway config entry) or direct, with why.
function plan(servers, direct, oauth = new Set()) {
  return servers.map(s => {
    const out = { key: s.key, name: s.server, names: s.names, scope: s.scope, here: s.here, forward: false, reason: '' };
    const type = s.cfg.type || (s.cfg.url ? 'http' : 'stdio');
    if (isGateway(s, s.cfg)) return { ...out, reason: GATEWAY };
    if ([s.key, s.server, s.plugin].some(n => n && direct.includes(n))) return { ...out, reason: 'in direct_servers' };
    // shortcut: the docs do not confirm how to turn one project .mcp.json server off, so they stay direct.
    if (s.project) return { ...out, reason: 'project .mcp.json' };
    if (type !== 'stdio' && type !== 'http') return { ...out, reason: `${type} transport` };
    // Its tokens live in Claude's store and Claude refreshes them; the gateway has no way to sign in.
    if (type === 'http' && oauth.has(s.key)) return { ...out, reason: 'OAuth (signs in through Claude)' };
    if (s.cfg.headersHelper) return { ...out, reason: 'headersHelper' };
    const missing = [];
    const cfg = resolve(s.cfg, s.vars, s.env, missing);
    if (missing.length) return { ...out, reason: `needs ${[...new Set(missing)].join(', ')}` };
    if (isGateway(s, cfg)) return { ...out, reason: GATEWAY };
    let cwdOnly;
    if (s.scope) {
      try {
        cwdOnly = fs.realpathSync(s.scope);
      } catch (e) {
        cwdOnly = s.scope;
      }
    }
    // Claude's order: the server's own timeout (>= 1000 ms), then MCP_TOOL_TIMEOUT (at least 1000 ms).
    // Default: Claude's idle abort on the gateway's own stdio call (30 min; the gateway forwards no
    // progress), so the one-call-at-a-time gateway never keeps waiting after Claude gave up.
    // CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0 turns that abort off, leaving Claude's 1e8 ms default.
    const own = Number(cfg.timeout);
    const envMs = Number(s.env.MCP_TOOL_TIMEOUT);
    const idle = s.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT;
    const idleMs = idle === undefined || idle === '' || !(Number(idle) >= 0) ? 1800000 : Number(idle) === 0 ? 1e8 : Math.max(1000, Number(idle));
    const ms = Math.min(own >= 1000 ? own : envMs > 0 ? Math.max(1000, envMs) : idleMs, 2147483647);
    const mod = {
      claude_key: s.key,
      claude_prefix: s.prefix,
      timeout: Math.ceil(ms / 1000),
      ...(cwdOnly && { cwd_only: cwdOnly }),
    };
    const entry = type === 'http'
      ? { transport: 'http', url: cfg.url, ...(cfg.headers && { headers: cfg.headers }), ...mod }
      : {
        transport: 'stdio',
        command: cfg.command,
        args: cfg.args || [],
        // Claude gives a plugin's stdio server these two; the gateway would otherwise pass its own.
        env: { ...s.pluginEnv, ...(cfg.env || {}) },
        ...(cfg.cwd && { cwd: cfg.cwd }),
        ...mod,
      };
    return { ...out, forward: true, entry };
  });
}

// direct_servers and direct_skills: what Claude passes the hook, else the saved plugin options.
// Blank (the default) keeps nothing direct.
function options(settings, env) {
  const id = Object.keys(settings.enabledPlugins || {}).find(k => k.startsWith(`${ME}@`));
  const saved = ((settings.pluginConfigs || {})[id] || {}).options || {};
  const pick = k => {
    const v = env[`CLAUDE_PLUGIN_OPTION_${k.toUpperCase()}`];
    return v !== undefined ? v : saved[k] !== undefined ? saved[k] : '';
  };
  return { id, direct_servers: pick('direct_servers'), direct_skills: pick('direct_skills') };
}

// Whether the mod is enabled at user scope. Global plugin skills and commands and the user's
// skillOverrides reach every project, so only then does it change them; a mod enabled only in a
// project routes that project's MCP servers and its project-scope plugins.
const everywhere = settings => Object.entries(settings.enabledPlugins || {}).some(([k, v]) => k.startsWith(`${ME}@`) && v === true);

// The off switch lives in plugin data, which Claude deletes on uninstall, so a reinstall starts on.
const offFile = p => path.join(p.pluginData, 'off');

// Every skill and command the mod considers here. For a file the mod patched, its decisions are
// made on the backed-up original, not on the patched text.
function skillPlan(p, plugins, direct, state) {
  const recs = new Map(state.files.map(r => [r.path, r]));
  const original = (file, text) => {
    const rec = recs.get(file);
    if (text === null || !rec || sha(text) !== rec.patchedSha) return text;
    const orig = readText(path.join(p.state, 'originals', `${rec.origSha}.md`));
    return orig !== null && sha(orig) === rec.origSha ? orig : text;
  };
  const kept = (pl, n) => [pl.name, n, `${pl.name}:${n}`].some(x => direct.includes(x));
  // Reached through a symlink (a link-farm install, a linked folder or file): not the plugin's own
  // copy, and a rename would replace the link, so it is never rewritten.
  const plain = (pl, file) => {
    try {
      return fs.realpathSync(file) === path.join(fs.realpathSync(pl.root), path.relative(pl.root, file));
    } catch (e) {
      return false;
    }
  };
  const items = [];
  for (const pl of plugins.filter(x => x.name !== ME)) {
    for (const file of pluginSkillFiles(pl)) {
      const text = readText(file);
      const orig = original(file, text);
      const m = orig === null ? {} : meta(orig, path.basename(path.dirname(file)));
      items.push({ kind: 'skill', file, text, orig, id: m.name && `${pl.name}:${m.name}`, scope: pl.scope, plugin: pl.name,
        route: orig !== null && !m.dmi && !kept(pl, m.name) && plain(pl, file), dmi: m.dmi, parsed: m.parsed });
    }
    for (const file of pluginCommandFiles(pl)) {
      const text = readText(file);
      const orig = original(file, text);
      const n = path.basename(file, '.md');
      const m = orig === null ? {} : meta(orig, n);
      // shortcut: a nested commands/sub/x.md is plugin:sub:x to Claude; derive it from the commands dir when one appears.
      items.push({ kind: 'command', file, text, orig, id: `${pl.name}:${n}`, scope: pl.scope, plugin: pl.name,
        route: orig !== null && !m.dmi && !kept(pl, n) && plain(pl, file), dmi: m.dmi, parsed: m.parsed });
    }
  }
  const users = findSkills(p.skills, 3).map(file => {
    const text = readText(file);
    const m = text === null ? { name: path.basename(path.dirname(file)) } : meta(text, path.basename(path.dirname(file)));
    return { file, text, name: m.name, dmi: m.dmi, route: !direct.includes(m.name) };
  });
  return { items, users };
}

function runGateway(args, input) {
  return spawnSync(path.join(root, 'bin', 'oh-my-context'), args, { encoding: 'utf8', timeout: 90000, input });
}

// Puts `want` in place of what the mod added last time, leaving the person's own entries alone.
// Returns the list to write and what the mod now owns in it.
function swap(current, mine, want) {
  const base = current.filter(x => !mine.includes(x));
  const owned = want.filter(x => !base.includes(x));
  return { next: [...base, ...owned], owned };
}

const inScope = (scope, cwd) => !scope || scope === cwd;

// --- apply --------------------------------------------------------------------------------------

function installGuard(p, settings, state) {
  const guardFile = path.join(p.state, 'guard.js');
  const src = fs.readFileSync(path.join(__dirname, 'restore.js'), 'utf8');
  if (readText(guardFile) !== src) writeFileAtomic(guardFile, src, 0o644, false);
  const hook = { type: 'command', command: `node ${shq(guardFile)} guard`, timeout: 60 };
  const want = [
    { event: 'SessionStart', entry: { hooks: [hook] } },
    { event: 'ConfigChange', entry: { matcher: CONFIG_CHANGE, hooks: [hook] } },
  ];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (settings.hooks !== undefined && (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) return false;
  let changed = false;
  // An entry recorded earlier that is no longer wanted (the state dir moved) goes.
  for (const h of state.hooks.filter(x => !want.some(w => same(w, x)))) {
    const list = (settings.hooks || {})[h.event];
    const i = Array.isArray(list) ? list.findIndex(e => same(e, h.entry)) : -1;
    if (i >= 0) {
      list.splice(i, 1);
      changed = true;
    }
  }
  state.hooks = state.hooks.filter(x => want.some(w => same(w, x)));
  for (const w of want) {
    settings.hooks = settings.hooks || {};
    if (settings.hooks[w.event] !== undefined && !Array.isArray(settings.hooks[w.event])) continue;
    const list = settings.hooks[w.event] = settings.hooks[w.event] || [];
    if (!state.hooks.some(x => same(x, w))) state.hooks.push(w);
    if (!list.some(e => same(e, w.entry))) {
      list.push(w.entry);
      changed = true;
    }
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  return changed;
}

function applyLocked(p, cwd, env, run) {
  // Every file it rewrites is read first, so a parse error stops it before any write.
  const settings = readConfig(p.settings, {});
  const cj = readConfig(p.claudeJson, {});
  const gw = readConfig(p.gateway, {});
  const state = loadState(p.state);
  const records = s => JSON.stringify([s.servers, s.projects, s.overrides, s.files, s.hooks]);
  const before = records(state);
  const save = () => saveState(p.state, state);
  state.paths = { settings: p.settings, claudeJson: p.claudeJson, installed: p.installed, gateway: p.gateway };
  delete state.off; // 0.2's off flag, now kept in plugin data; apply runs only while the mod is on
  if (!state.cwds.includes(cwd)) state.cwds.push(cwd);
  save();

  const opts = options(settings, env);
  const plugins = enabledPlugins(p, cwd, settings);
  const problems = [];
  const all = everywhere(settings);

  // 1. The guard first, so whatever follows can be put back even if this start dies halfway.
  if (installGuard(p, settings, state)) {
    save();
    writeJson(p.settings, settings, 0o644);
  }

  // 2. Gateway config: entries for the global servers and this project's; other projects' stay.
  const found = collectServers(p, cwd, plugins, cj, env);
  const servers = plan(found, list(opts.direct_servers), oauthServers(p));
  const ident = (key, scope) => `${key}|${scope || ''}`;
  const byIdent = new Map(Object.entries(state.servers).map(([n, r]) => [ident(r.key, r.cwd), n]));
  gw.servers = gw.servers || {};
  const used = new Set([...Object.keys(gw.servers), ...Object.keys(state.servers), 'oh-my-context']);
  const wanted = new Set();
  for (const s of servers.filter(x => x.forward)) {
    const id = ident(s.key, s.scope);
    let name = byIdent.get(id);
    if (!name) {
      const free = s.names.filter(n => !used.has(n));
      name = free[0] || `${s.names[s.names.length - 1]}~${sha(id).slice(0, 8)}`;
      if (used.has(name)) {
        Object.assign(s, { forward: false, reason: 'no free gateway name' });
        continue;
      }
      used.add(name);
    }
    s.gateway = name;
    wanted.add(name);
    state.servers[name] = { key: s.key, cwd: s.scope || null };
  }
  const stale = Object.entries(state.servers).filter(([n, r]) => inScope(r.cwd, cwd) && !wanted.has(n)).map(([n]) => n);
  save();
  // A global entry is not served in a project where Claude would not start it: its plugin is off
  // there, or a local-scope or project server of the same tool prefix takes its place.
  let real = cwd;
  try {
    real = fs.realpathSync(cwd);
  } catch (e) {
    /* not on disk */
  }
  const scopedHere = new Set(found.filter(x => x.scope).map(x => x.prefix));
  for (const s of servers.filter(x => x.forward)) {
    const entry = { ...s.entry };
    if (!s.scope) {
      const prev = ((gw.servers[s.gateway] || {}).cwd_except || []).filter(x => typeof x === 'string');
      const hide = !s.here || scopedHere.has(entry.claude_prefix);
      const except = hide ? (prev.includes(real) ? prev : [...prev, real]) : prev.filter(x => x !== real);
      if (except.length) entry.cwd_except = except;
    }
    gw.servers[s.gateway] = entry;
  }
  for (const n of stale) if (gw.servers[n] && gw.servers[n].claude_key === state.servers[n].key) delete gw.servers[n];
  // It holds servers' env and headers, so it is the owner's alone from the moment it exists.
  writeJson(p.gateway, gw, 0o600, false);
  for (const n of stale) delete state.servers[n];
  save();

  // 3. Turn the routed originals off in this project.
  cj.projects = cj.projects || {};
  const newProject = !cj.projects[cwd];
  const proj = cj.projects[cwd] = cj.projects[cwd] || {};
  const rec = state.projects[cwd] || { keys: [], created: !Array.isArray(proj.disabledMcpServers), newProject };
  const current = Array.isArray(proj.disabledMcpServers) ? proj.disabledMcpServers : [];
  const d = swap(current, rec.keys, servers.filter(s => s.forward && s.here).map(s => s.key));
  if (JSON.stringify(d.next) !== JSON.stringify(current)) {
    state.projects[cwd] = { ...rec, keys: [...new Set([...rec.keys, ...d.owned])] };
    save();
    // A list the mod created goes again once it is empty (d.owned is part of d.next, so nothing is lost).
    if (!d.next.length && rec.created) delete proj.disabledMcpServers;
    else proj.disabledMcpServers = d.next;
    if (rec.newProject && !Object.keys(proj).length) delete cj.projects[cwd];
    writeJson(p.claudeJson, cj, 0o600);
  }
  if (d.owned.length) state.projects[cwd] = { ...rec, keys: d.owned };
  else delete state.projects[cwd];
  save();

  // 4. Plugin skills and commands.
  const sk = skillPlan(p, plugins, list(opts.direct_skills), state);
  let filesChanged = false;
  const routedPaths = new Set();
  for (const it of sk.items) {
    if (it.text === null) {
      problems.push(`${it.file}: cannot be read; left as is`);
      routedPaths.add(it.file);
      continue;
    }
    // A global plugin's files reach every project, so only a mod enabled at user scope changes them.
    if (!it.route || (!it.scope && !all)) continue;
    routedPaths.add(it.file);
    const old = state.files.find(r => r.path === it.file);
    const ours = old && sha(it.text) === old.patchedSha;
    // Ours but its backup is gone: left as it is, since the original cannot be known.
    if (ours && it.orig === it.text) continue;
    // Ours: re-derived from the backed-up original (an older build flagged commands instead). Not ours
    // any more (or never): the file on disk is the original, from a plugin update or first sight.
    const base = ours ? it.orig : it.text;
    const patched = routeSkill(base);
    if (ours && patched === it.text) continue;
    if (patched === null || patched === base) {
      if (patched === null) problems.push(`${it.file}: frontmatter not understood; left as is`);
      // Ours: the loop below puts the original back; otherwise the record is stale.
      if (patched === null || ours) routedPaths.delete(it.file);
      if (old && !ours) state.files = state.files.filter(r => r !== old);
      continue;
    }
    const origSha = sha(base);
    const backup = path.join(p.state, 'originals', `${origSha}.md`);
    if (readText(backup) !== base) writeFileAtomic(backup, base, 0o600, false);
    const next = { kind: it.kind, path: it.file, origSha, patchedSha: sha(patched), plugin: it.plugin, cwd: it.scope || null };
    state.files = [...state.files.filter(r => r !== old), next];
    save();
    writeFileAtomic(it.file, patched);
    filesChanged = true;
  }
  // Files no longer routed (kept direct, plugin gone or disabled): back to the original if still ours.
  for (const r of state.files.filter(x => inScope(x.cwd, cwd) && !routedPaths.has(x.path))) {
    const cur = readText(r.path);
    if (cur !== null && sha(cur) === r.patchedSha) {
      const orig = readText(path.join(p.state, 'originals', `${r.origSha}.md`));
      if (orig === null || sha(orig) !== r.origSha) {
        problems.push(`${r.path}: backup missing; left patched`);
        continue;
      }
      writeFileAtomic(r.path, orig);
      filesChanged = true;
    }
    state.files = state.files.filter(x => x !== r);
    save();
  }

  // 5. User skills: name only in Claude's listing, unless the person set an override themselves.
  const overrides = { ...(settings.skillOverrides || {}) };
  const mine = state.overrides;
  // skillOverrides in the user settings reach every project, so only a mod enabled at user scope sets them.
  const want = [...new Set(sk.users.filter(u => all && u.route && !u.dmi).map(u => u.name))]
    .filter(n => !(n in overrides) || mine[n] === overrides[n]);
  for (const n of want) mine[n] = mine[n] || NAME_ONLY;
  const drop = Object.keys(mine).filter(n => !want.includes(n));
  save();
  for (const n of want) overrides[n] = mine[n];
  for (const n of drop) if (overrides[n] === mine[n]) delete overrides[n];
  if (JSON.stringify(overrides) !== JSON.stringify(settings.skillOverrides || {})) {
    if (Object.keys(overrides).length) settings.skillOverrides = overrides;
    else delete settings.skillOverrides;
    writeJson(p.settings, settings, 0o644);
  }
  for (const n of drop) delete mine[n];
  save();

  // 6. The catalog oh-my-context indexes: the original SKILL.md files, named by the id the Skill tool takes.
  const catalog = path.join(p.state, 'catalog');
  fs.mkdirSync(catalog, { recursive: true });
  const entries = new Map();
  for (const it of sk.items.filter(x => x.orig !== null && !x.dmi && x.id)) entries.set(it.id, it.orig);
  for (const u of sk.users.filter(x => x.text !== null && !x.dmi)) entries.set(u.name, u.text);
  const safe = id => id.replace(/[^A-Za-z0-9._-]/g, '_');
  const keep = new Set();
  for (const [id, text] of entries) {
    const file = path.join(catalog, safe(id), 'SKILL.md');
    keep.add(safe(id));
    const body = withName(text, id);
    if (readText(file) !== body) writeFileAtomic(file, body, 0o644, false);
  }
  let names = [];
  try {
    names = fs.readdirSync(catalog);
  } catch (e) {
    /* none yet */
  }
  for (const n of names.filter(x => !keep.has(x))) fs.rmSync(path.join(catalog, n), { recursive: true, force: true });
  let indexed = false;
  try {
    indexed = run(['skills', 'index', catalog]).status === 0;
  } catch (e) {
    indexed = false;
  }

  save();
  return { servers, state, cwd, indexed, problems, filesChanged, changed: records(state) !== before };
}

function apply(p, cwd, env, run) {
  return withLock(p.state, () => applyLocked(p, cwd, env, run));
}

// The lock creates the state dir; with nothing journaled it would stay behind empty.
function dropEmptyState(p) {
  try {
    fs.rmdirSync(p.state);
  } catch (e) {
    /* not empty, or gone */
  }
}

// Everything back, guard included; the state dir goes once nothing is left to retry.
function fullRestore(p) {
  const r = withLock(p.state, () => R.restoreAll(p.state));
  dropEmptyState(p);
  return r;
}

// --- output -------------------------------------------------------------------------------------

function sessionContext(r) {
  const fwd = r.servers.filter(s => s.forward && s.here).length;
  const direct = r.servers.filter(s => !s.forward && s.here && s.reason !== GATEWAY).map(s => `${s.key} (${s.reason})`);
  const files = r.state.files.filter(f => inScope(f.cwd, r.cwd));
  const skills = files.filter(f => f.kind === 'skill').length + Object.keys(r.state.overrides).length;
  const cmds = files.filter(f => f.kind === 'command').length;
  let line = `oh-my-context-mod: ${fwd} MCP server(s) routed through oh-my-context (its manifest and call tools), `
    + `${skills} skill(s) and ${cmds} plugin command(s) listed by name only (still invocable; its resolve_skills tool finds them); `
    + `direct: ${direct.join(', ') || 'none'}.`;
  if (r.changed) line += ' Changes made at this start count from the next session.';
  if (!r.indexed) line += ' The skill index did not rebuild.';
  if (r.problems.length) line += ` ${r.problems.length} file(s) left as is (/oh-my-context-mod status).`;
  return line;
}

function status(p, cwd, env, run) {
  const settings = readJson(p.settings, {});
  const cj = readJson(p.claudeJson, {});
  const state = (() => {
    try {
      return loadState(p.state);
    } catch (e) {
      return R.emptyState();
    }
  })();
  const opts = options(settings, env);
  const v = run(['--version']);
  const plugins = enabledPlugins(p, cwd, settings);
  const servers = plan(collectServers(p, cwd, plugins, cj, env), list(opts.direct_servers), oauthServers(p));
  const off = new Set((state.projects[cwd] || {}).keys || []);
  const files = state.files.filter(f => inScope(f.cwd, cwd));
  const sk = skillPlan(p, plugins, list(opts.direct_skills), state);
  const guardOn = state.hooks.length > 0 && state.hooks.every(h => (((settings.hooks || {})[h.event]) || []).some(e => JSON.stringify(e) === JSON.stringify(h.entry)));
  const all = everywhere(settings);
  const out = [
    `oh-my-context-mod: ${fs.existsSync(offFile(p)) || state.off ? 'off' : 'on'} · oh-my-context CLI: ${v.status === 0 ? String(v.stdout).trim() : 'not runnable'}`,
    '',
    `MCP servers (${cwd}):`,
    ...servers.filter(s => s.here).map(s => `  ${(s.forward ? (off.has(s.key) ? 'forwarded' : 'forward*') : 'direct').padEnd(9)}  ${s.key}${s.reason ? `  (${s.reason})` : ''}`),
    '  * forward on the next session start in this project',
    '',
    `Skills: ${files.filter(f => f.kind === 'skill').length} plugin skill(s) and ${Object.keys(state.overrides).length} user skill(s) listed by name only; `
      + `${sk.items.filter(i => i.kind === 'skill' && i.route && (i.scope || all)).length + sk.users.filter(u => all && u.route && !u.dmi).length} would be on the next start.`,
    `Commands: ${files.filter(f => f.kind === 'command').length} plugin command(s) listed by name only, still invocable.`,
    `Guard (puts everything back on uninstall or disable): ${guardOn ? 'installed' : 'not installed'}`,
    `Filters (plugin settings): direct_servers = "${opts.direct_servers}", direct_skills = "${opts.direct_skills}"`,
    `Paths: state ${p.state}, gateway config ${state.paths.gateway || p.gateway}, settings ${p.settings}`,
  ];
  return out.join('\n');
}

// The SessionStart hook: apply (or put everything back when the CLI cannot run).
const OFF_LINE = 'oh-my-context-mod: off; every MCP server and skill loads directly. /oh-my-context-mod on routes them again.';

function session(p, cwd, env, run) {
  // Off, with no state to undo: return before the lock creates the state dir.
  if (fs.existsSync(offFile(p)) && !fs.existsSync(path.join(p.state, 'state.json'))) return { additionalContext: OFF_LINE };
  const out = withLock(p.state, () => {
    if (loadState(p.state).off) writeFileAtomic(offFile(p), '', 0o600, false);
    if (fs.existsSync(offFile(p))) {
      // Off means everything is back: retries what `off` could not restore, and drops an older off flag.
      const r = R.restoreAll(p.state);
      return { additionalContext: r.failed.length ? `${OFF_LINE} Not restored yet: ${R.describe(r)}` : OFF_LINE };
    }
    if (run(['--version']).status !== 0) {
      // No gateway means no way to reach a routed server, so nothing stays routed.
      const r = R.restoreAll(p.state);
      return { additionalContext: `oh-my-context-mod: the oh-my-context CLI did not run, so every MCP server and skill is direct again (${R.describe(r)}); this shows fully from the next session.` };
    }
    const r = applyLocked(p, cwd, env, run);
    return { additionalContext: sessionContext(r), ...(r.filesChanged && { reloadSkills: true }) };
  });
  dropEmptyState(p);
  return out;
}

// A fresh context (/clear, compaction, a subagent starting or handing back) has not seen any routed
// server's instructions; the gateway hands them over again once this file's mtime changes.
function touchEpoch(p) {
  const file = path.join(path.dirname(p.gateway), 'instructions-epoch');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.closeSync(fs.openSync(file, 'a', 0o600));
  const now = new Date();
  fs.utimesSync(file, now, now);
}

function main() {
  const mode = process.argv[2] || 'status';
  const env = process.env;
  const p0 = paths(undefined, env);
  // The launcher, the gateway and this hook must agree on the data dir even outside a hook.
  if (!env.CLAUDE_PLUGIN_DATA) env.CLAUDE_PLUGIN_DATA = p0.pluginData;
  const p = paths(undefined, env);
  if (mode === 'epoch') return touchEpoch(p);
  if (mode === 'session') {
    let payload = {};
    try {
      payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    } catch (e) {
      /* no payload */
    }
    if (payload.source === 'clear' || payload.source === 'compact') {
      try {
        touchEpoch(p);
      } catch (e) {
        console.error(`oh-my-context-mod: ${e.message}`);
      }
    }
    let out;
    try {
      out = session(p, payload.cwd || process.cwd(), env, runGateway);
    } catch (e) {
      out = { additionalContext: `oh-my-context-mod: ${e.message}` };
    }
    if (out) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', ...out } }));
    return;
  }
  if (mode === 'status') return console.log(status(p, process.cwd(), env, runGateway));
  if (mode === 'off') {
    const r = fullRestore(p);
    writeFileAtomic(offFile(p), '', 0o600, false);
    return console.log(`oh-my-context-mod: off; ${R.describe(r)}. Claude Code shows every MCP server and skill fully from the next session.`);
  }
  if (mode === 'on') {
    if (runGateway(['--version']).status !== 0) {
      console.error('oh-my-context-mod: the oh-my-context CLI did not run, so nothing was routed.');
      process.exitCode = 1;
      return;
    }
    fs.rmSync(offFile(p), { force: true });
    const r = apply(p, process.cwd(), env, runGateway);
    return console.log(`${sessionContext(r)}\n\n${status(p, process.cwd(), env, runGateway)}`);
  }
  console.error(`oh-my-context-mod: unknown argument ${mode}; use status, on or off`);
  process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`oh-my-context-mod: ${e.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  paths, resolve, plan, routeSkill, withName, swap, apply, session,
  fullRestore, status, collectServers, enabledPlugins, skillPlan, isGateway, touchEpoch, oauthServers,
};
