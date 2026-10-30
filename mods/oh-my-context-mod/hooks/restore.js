#!/usr/bin/env node
// oh-my-context-mod: state, lock and restore. Argument: guard (a SessionStart or ConfigChange hook).
//
// Standalone on purpose (node builtins only, no sibling files): sync.js requires it, and every apply
// copies it to <config>/oh-my-context-mod/guard.js, which the person's own settings.json runs as a hook.
// Claude Code has no uninstall or disable event and deletes ${CLAUDE_PLUGIN_DATA} on uninstall, so
// that copy is what puts everything back once the plugin is gone or turned off.
//
// The state is a journal: sync.js records each change before it makes it, and every restore step
// checks the current content first, so a record whose change never happened is simply dropped.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ME = 'oh-my-context-mod';
const PLUGIN_ID_DIR = 'oh-my-context-mod-claude-code-linux';
// Longer than any locked run (session() makes two 90 s gateway CLI calls under the lock), so only a hung
// holder or one whose pid was reused waits this long; a holder that died is taken over at once.
const LOCK_STALE_MS = 300000;

// Every path the mod uses. The state dir sits outside plugin data so it survives an uninstall.
function paths(home = os.homedir(), env = process.env) {
  const claude = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const plugins = env.CLAUDE_CODE_PLUGIN_CACHE_DIR || path.join(claude, 'plugins');
  const pluginData = env.CLAUDE_PLUGIN_DATA || path.join(plugins, 'data', PLUGIN_ID_DIR);
  const mhome = env.OMC_HOME || path.join(pluginData, 'home');
  return {
    claude,
    settings: path.join(claude, 'settings.json'),
    installed: path.join(plugins, 'installed_plugins.json'),
    data: path.join(plugins, 'data'),
    pluginData,
    skills: path.join(claude, 'skills'),
    claudeJson: env.CLAUDE_CONFIG_DIR ? path.join(claude, '.claude.json') : path.join(home, '.claude.json'),
    // Claude's file credential store (Linux); sensitive plugin options sit under pluginSecrets[<plugin id>].
    credentials: path.join(env.CLAUDE_SECURESTORAGE_CONFIG_DIR || claude, '.credentials.json'),
    gateway: env.OMC_CONFIG_FILE || path.join(mhome, 'config.json'),
    // mcptoon-mod 0.1.0's gateway config (upstream mcptoon's default), undone on migration.
    legacy: path.join(home, '.mcptoon', 'config.json'),
    state: path.join(claude, ME),
    // Claude Code's managed settings dir per platform. MDM, registry and server-managed sources are not read.
    managedDir: { darwin: '/Library/Application Support/ClaudeCode', win32: 'C:\\Program Files\\ClaudeCode' }[process.platform] || '/etc/claude-code',
  };
}

const sha = text => crypto.createHash('sha256').update(text).digest('hex');

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;
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
    throw new Error(`${file} is not valid JSON (${e.message}); the mod changed nothing in it`);
  }
}

// Write to a temp file and rename, so Claude never reads a half-written file. The temp file is
// created with its final mode, so a config holding secrets is never readable by others, not even briefly.
// keepMode: an existing file keeps its own mode instead of `mode`.
function writeFileAtomic(file, text, mode = 0o644, keepMode = true) {
  let m = mode;
  if (keepMode) {
    try {
      m = fs.statSync(file).mode & 0o777;
    } catch (e) {
      /* new file */
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.unlinkSync(tmp);
  } catch (e) {
    /* none left over */
  }
  const fd = fs.openSync(tmp, 'wx', m);
  // A failed write (disk full) or rename leaves no temp file beside the person's config.
  try {
    try {
      fs.writeSync(fd, text);
      fs.fchmodSync(fd, m);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

function writeJson(file, data, mode = 0o644, keepMode = true) {
  writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n', mode, keepMode);
}

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// One session at a time changes the setup. A lock whose process is gone is taken over at once; a live
// holder keeps it until it ends (or LOCK_STALE_MS: hung, or its pid reused), so two applies never overlap.
function withLock(dir, fn, wait = 10000) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.lock');
  const me = `${process.pid} ${Date.now()}`;
  const until = Date.now() + wait;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, me);
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0;
      let pid = 0;
      try {
        age = Date.now() - fs.statSync(file).mtimeMs;
        pid = parseInt(readText(file), 10); // NaN while the holder has not written its pid yet
      } catch (err) {
        continue;
      }
      if ((pid > 0 && !alive(pid)) || age > LOCK_STALE_MS) {
        fs.rmSync(file, { force: true });
        continue;
      }
      if (Date.now() > until) throw new Error(`${file} is held by another session; nothing was changed`);
      sleep(100);
    }
  }
  try {
    return fn();
  } finally {
    if (readText(file) === me) fs.rmSync(file, { force: true });
  }
}

function emptyState() {
  // cwds: every project an apply ran in, so the guard can tell whether one still turns the mod on.
  return { version: 2, paths: {}, servers: {}, projects: {}, overrides: {}, files: [], hooks: [], cwds: [] };
}

function loadState(dir) {
  return { ...emptyState(), ...readConfig(path.join(dir, 'state.json'), {}) };
}

function saveState(dir, state) {
  writeJson(path.join(dir, 'state.json'), state, 0o600, false);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Puts back what the state records. full: everything; otherwise only the disabledMcpServers entries
// of `cwd` and the files patched for plugins enabled in `cwd` alone (shared files stay, since other
// projects still route them). Each step stands alone: a file that does not parse is skipped (never written) and
// reported, its records stay for the next try, and the rest still restores.
function restore(dir, state, { full = true, cwd } = {}) {
  const done = { switches: 0, overrides: 0, files: 0, servers: 0, hooks: 0 };
  const failed = [];
  const left = [];
  const p = state.paths || {};
  const step = (what, fn) => {
    try {
      fn();
    } catch (e) {
      failed.push(`${what}: ${e.message}`);
    }
    saveState(dir, state);
  };

  const projects = full ? Object.keys(state.projects) : [cwd].filter(c => state.projects[c]);
  if (projects.length) step('MCP server switches', () => {
    const cj = p.claudeJson ? readConfig(p.claudeJson, null) : null;
    let changed = false;
    for (const d of projects) {
      const rec = state.projects[d];
      const proj = cj && cj.projects && cj.projects[d];
      if (proj && Array.isArray(proj.disabledMcpServers)) {
        const next = proj.disabledMcpServers.filter(k => !rec.keys.includes(k));
        done.switches += proj.disabledMcpServers.length - next.length;
        if (next.length !== proj.disabledMcpServers.length) changed = true;
        if (!next.length && rec.created) delete proj.disabledMcpServers;
        else proj.disabledMcpServers = next;
      }
      // A project entry the mod created and nothing else filled since goes too.
      if (proj && rec.newProject && !Object.keys(proj).length) {
        delete cj.projects[d];
        changed = true;
      }
    }
    if (changed) writeJson(p.claudeJson, cj, 0o600);
    for (const d of projects) delete state.projects[d];
  });
  const files = full ? [...state.files] : state.files.filter(r => cwd && r.cwd === cwd);
  for (const rec of files) {
    step(rec.path, () => {
      const cur = readText(rec.path);
      if (cur === null && fs.existsSync(rec.path)) throw new Error('cannot be read');
      if (cur !== null && sha(cur) === rec.patchedSha) {
        const orig = readText(path.join(dir, 'originals', `${rec.origSha}.md`));
        if (orig === null || sha(orig) !== rec.origSha) throw new Error('its backup is missing');
        writeFileAtomic(rec.path, orig);
        done.files++;
      } else if (cur !== null && sha(cur) !== rec.origSha) {
        // Changed since (a plugin update or a hand edit): theirs now, so it stays as it is.
        left.push(rec.path);
      }
      state.files = state.files.filter(r => r !== rec);
    });
  }
  if (!full) return { done, failed, left };

  if (Object.keys(state.overrides).length) step('skillOverrides', () => {
    const s = p.settings ? readConfig(p.settings, null) : null;
    const o = s && s.skillOverrides;
    let changed = false;
    // Only a value the mod set and nobody changed since.
    for (const [n, v] of Object.entries(state.overrides)) {
      if (o && o[n] === v) {
        delete o[n];
        done.overrides++;
        changed = true;
      }
    }
    if (changed) {
      if (!Object.keys(o).length) delete s.skillOverrides;
      writeJson(p.settings, s, 0o644);
    }
    state.overrides = {};
  });

  if (Object.keys(state.servers).length) step('gateway config', () => {
    const g = p.gateway ? readConfig(p.gateway, null) : null;
    if (g && g.servers) {
      let changed = false;
      for (const [n, rec] of Object.entries(state.servers)) {
        if (g.servers[n] && g.servers[n].claude_key === rec.key) {
          delete g.servers[n];
          done.servers++;
          changed = true;
        }
      }
      if (changed) writeJson(p.gateway, g, 0o600, false);
    }
    state.servers = {};
  });

  // The guard goes last, and only once everything else is back, so a failed step is retried.
  if (state.hooks.length && !failed.length) step('guard hooks', () => {
    const s = p.settings ? readConfig(p.settings, null) : null;
    let changed = false;
    for (const h of state.hooks) {
      const arr = s && s.hooks && s.hooks[h.event];
      const i = Array.isArray(arr) ? arr.findIndex(e => same(e, h.entry)) : -1;
      if (i < 0) continue;
      arr.splice(i, 1);
      if (!arr.length) delete s.hooks[h.event];
      if (!Object.keys(s.hooks).length) delete s.hooks;
      done.hooks++;
      changed = true;
    }
    if (changed) writeJson(p.settings, s, 0o644);
    state.hooks = [];
  });
  return { done, failed, left };
}

// Full restore; the state dir goes too once nothing is left to retry.
function restoreAll(dir) {
  if (!fs.existsSync(path.join(dir, 'state.json'))) return { done: {}, failed: [], left: [] };
  const r = restore(dir, loadState(dir), { full: true });
  if (!r.failed.length) fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

function describe(r) {
  const d = r.done;
  const parts = [
    d.switches && `${d.switches} MCP server switch(es)`,
    d.servers && `${d.servers} gateway entr(ies)`,
    d.overrides && `${d.overrides} skill override(s)`,
    d.files && `${d.files} plugin skill/command file(s)`,
    d.hooks && 'its guard hooks',
  ].filter(Boolean);
  let text = parts.length ? `put back ${parts.join(', ')}` : 'nothing left to put back';
  if (r.left.length) text += `; ${r.left.length} file(s) changed since and were left as they are`;
  if (r.failed.length) text += `; not restored yet (retried next time): ${r.failed.join('; ')}`;
  return text;
}

function enabledIn(file, id) {
  const s = readConfig(file, {});
  return s && s.enabledPlugins ? s.enabledPlugins[id] : undefined;
}

// The guard: runs from the person's own settings hooks. Returns a message, or null when the mod is
// still installed and enabled (or when it cannot tell for sure).
function guard(input, dir = __dirname) {
  return withLock(dir, () => {
    const state = loadState(dir);
    const p = state.paths || {};
    if (!p.installed || !p.settings) return null;
    const installed = readConfig(p.installed, null);
    if (!installed || typeof installed.plugins !== 'object' || !installed.plugins) return null;
    const user = readConfig(p.settings, {});
    const ids = Object.keys(installed.plugins).filter(k => k.startsWith(`${ME}@`));
    if (!ids.length) {
      const r = restoreAll(dir);
      return `oh-my-context-mod is uninstalled: ${describe(r)}. Every MCP server and skill shows fully from the next session.`;
    }
    const userOn = user.enabledPlugins || {};
    const id = Object.keys(userOn).find(k => k.startsWith(`${ME}@`)) || ids[0];
    // Local settings win over project settings, which win over user settings.
    const on = d => {
      const local = enabledIn(path.join(d, '.claude', 'settings.local.json'), id);
      const project = enabledIn(path.join(d, '.claude', 'settings.json'), id);
      return (local !== undefined ? local : project !== undefined ? project : userOn[id]) !== false;
    };
    const cwd = input && input.cwd;
    if (cwd && on(cwd)) return null;
    if (userOn[id] === false) {
      // Off at user scope: everything goes back unless a project the mod set up still turns it on.
      const dirs = [...(state.cwds || []), ...Object.keys(state.projects), ...Object.values(state.servers).map(r => r.cwd), ...state.files.map(r => r.cwd)];
      if (![...new Set(dirs.filter(Boolean))].some(on)) {
        const r = restoreAll(dir);
        return `oh-my-context-mod is disabled: ${describe(r)}. Every MCP server and skill shows fully from the next session.`;
      }
    }
    if (!cwd || !(state.projects[cwd] || state.files.some(r => r.cwd === cwd))) return null;
    const r = restore(dir, state, { full: false, cwd });
    return `oh-my-context-mod is disabled in this project: ${describe(r)}. Its MCP servers show directly from the next session.`;
  });
}

function main() {
  if (process.argv[2] !== 'guard') {
    console.error('oh-my-context-mod restore.js: argument guard expected');
    return;
  }
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch (e) {
    /* no hook input */
  }
  const msg = guard(input, __dirname);
  if (msg) process.stdout.write(JSON.stringify({ systemMessage: msg }));
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    // Never break a session start or a settings change over the guard.
    console.error(`oh-my-context-mod guard: ${e.message}`);
  }
}

module.exports = {
  ME, paths, sha, readText, readConfig, writeFileAtomic, writeJson, withLock,
  emptyState, loadState, saveState, restore, restoreAll, describe, guard,
};
