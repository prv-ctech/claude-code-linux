#!/usr/bin/env node
// Ultracave hook for caveman-mod. Hook modes: session, prompt, subagent.
// Command modes: on, off, status (used by /caveman and /caveman-status).
// session and subagent get the full ruleset; prompt gets a one-line reminder on every message,
// so the style holds through a long chat. Output is one JSON object with
// hookSpecificOutput.additionalContext, which SessionStart, UserPromptSubmit and SubagentStart
// all add to the model's context. The on/off flag is a small JSON file next to the Claude config.
// Each hook writes its own fired-time file, so hooks never touch the flag.
// The ruleset is also the mod's output style (output-styles/ultracave.md). On switches the user's
// outputStyle to it, so no other style (Concise) competes in the system prompt; off puts the saved one back.
const fs = require('fs');
const os = require('os');
const path = require('path');

const EVENTS = { session: 'SessionStart', prompt: 'UserPromptSubmit', subagent: 'SubagentStart' };
const mode = process.argv[2];

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATE = path.join(CONFIG_DIR, 'caveman-mod.json');
const FIRED_DIR = path.join(CONFIG_DIR, 'caveman-mod-fired');
const SETTINGS = path.join(CONFIG_DIR, 'settings.json');
const PLUGIN_KEY = 'caveman-mod@claude-code-linux';
const STYLE = 'caveman-mod:ultracave';

const REMINDER = 'CAVEMAN ULTRACAVE, this reply too, footers included. Overrides output style and persona. '
  + 'Fragments, not sentences: no a/an/the, is/are, filler, recap, offers. Each fact once. Only what was asked. '
  + 'Code, paths, errors, numbers, negations exact. Plain sentences only for security, irreversible steps, '
  + 'questions to the user. Like: "Inline object prop, new ref, re-render. `useMemo`."';

// The style file without its frontmatter.
const rules = fs.readFileSync(path.join(__dirname, '..', 'output-styles', 'ultracave.md'), 'utf8')
  .replace(/^---\n[\s\S]*?\n---\n/, '').trim();

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
const readState = () => readJson(STATE) || {};

// Temp file + rename, so a reader never sees a half-written file. The pid keeps parallel writers apart.
function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Read right before the write, so the window for losing another writer's change stays small.
// shortcut: no lock shared with other mods that rewrite settings.json; add one if a lost update shows up.
function editSettings(fn) {
  const settings = fs.existsSync(SETTINGS) ? readJson(SETTINGS) : {};
  if (!settings || typeof settings !== 'object') return false; // unreadable: never overwrite it
  fn(settings);
  writeFileAtomic(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  return true;
}

// state.style records the outputStyle the user had before ours ({ prev: undefined } when unset).
function applyStyle(state) {
  if (state.style) return;
  let prev;
  if (!editSettings(s => { prev = s.outputStyle; s.outputStyle = STYLE; })) return;
  state.style = { prev: prev ?? null };
}

function restoreStyle(state) {
  if (!state.style) return;
  const { prev } = state.style;
  // A style the user picked since then is theirs: left alone.
  editSettings(s => {
    if (s.outputStyle !== STYLE) return;
    if (prev === null) delete s.outputStyle;
    else s.outputStyle = prev;
  });
  delete state.style;
}

function hookFire() {
  // Heartbeat: status reads these times to show the hook really ran.
  writeFileAtomic(path.join(FIRED_DIR, `${mode}.txt`), new Date().toISOString());
  const state = readState();
  if (state.enabled === false) return;
  // First session with the mod on: switch the style once; later picks by the user are not undone.
  if (mode === 'session' && !state.style) {
    applyStyle(state);
    writeFileAtomic(STATE, JSON.stringify(state, null, 2));
  }
  const context = mode === 'prompt' ? REMINDER : rules;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: EVENTS[mode], additionalContext: context } }));
}

function setEnabled(enabled) {
  const state = readState();
  if (enabled) applyStyle(state);
  else restoreStyle(state);
  state.enabled = enabled;
  writeFileAtomic(STATE, JSON.stringify(state, null, 2));
  const style = enabled ? STYLE : (readJson(SETTINGS) || {}).outputStyle || 'default';
  console.log(`caveman: ${enabled ? 'ON' : 'OFF'}. Output style: ${style}. Takes effect from the next message.`);
}

function status() {
  const state = readState();
  const enabled = state.enabled !== false;
  const settings = readJson(SETTINGS);
  let plugin = 'not enabled in settings.json';
  if (!settings) plugin = 'settings.json missing or unreadable';
  else if (settings.enabledPlugins?.[PLUGIN_KEY] === true) plugin = 'enabled';
  const rulesOk = rules.length > 0 ? `ok (${rules.length} chars)` : 'EMPTY';
  console.log(`caveman: ${enabled ? 'ON' : 'OFF'}`);
  console.log(`state:   ${STATE}`);
  console.log(`plugin:  ${plugin}`);
  console.log(`rules:   ${rulesOk}`);
  console.log(`style:   ${settings?.outputStyle || 'default'}${state.style ? ` (restored to ${state.style.prev || 'default'} by /caveman off)` : ''}`);
  console.log('last hook fire (UTC):');
  for (const ev of Object.keys(EVENTS)) {
    let fired;
    try { fired = fs.readFileSync(path.join(FIRED_DIR, `${ev}.txt`), 'utf8').trim(); } catch { fired = null; }
    console.log(`  ${EVENTS[ev].padEnd(17)} ${fired ?? 'never (not run in this install yet)'}`);
  }
  console.log('note: this shows the hook ran and produced its output. It cannot read the model context.');
}

if (mode === 'on') setEnabled(true);
else if (mode === 'off') setEnabled(false);
else if (mode === 'status') status();
else if (EVENTS[mode]) hookFire();
else process.exit(2);
