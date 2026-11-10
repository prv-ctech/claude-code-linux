#!/usr/bin/env node
// Reply modes for oh-my-context-mod. Hook modes: session, prompt, tool, subagent.
// Command modes: mode [level], status (used by /omc mode and later /omc status).
// session and subagent get the level's full rules; prompt a short reminder; tool a one-line one.
// Output is one JSON object with hookSpecificOutput.additionalContext. State lives next to the
// Claude config because Bash commands have no CLAUDE_PLUGIN_DATA.
const fs = require('fs');
const os = require('os');
const path = require('path');

const EVENTS = { session: 'SessionStart', prompt: 'UserPromptSubmit', tool: 'PostToolUse', subagent: 'SubagentStart' };
const LEVELS = ['off', 'lite', 'full', 'ultra', 'max'];
const DEFAULT_MODE = 'ultra';
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const DIR = path.join(CONFIG_DIR, 'oh-my-context-mod');
const STATE = path.join(DIR, 'reply.json');
const FIRED_DIR = path.join(DIR, 'reply-fired');
const SETTINGS = path.join(CONFIG_DIR, 'settings.json');
const STYLE_PREFIX = 'oh-my-context-mod:reply-';
const styleOf = level => STYLE_PREFIX + level;
const isOurs = s => typeof s === 'string' && LEVELS.some(l => l !== 'off' && s === styleOf(l));

const REMINDERS = {
  lite: 'REPLY MODE LITE applies to this whole turn, including the final answer after tool calls. Full sentences, but no greetings, recaps, offers, hedging or filler words. '
    + 'Start with the answer. Code, paths, errors, numbers and negations stay exact.',
  full: 'REPLY MODE FULL applies to this whole turn, including the final answer after tool calls. Short sentences, one idea each; articles may drop. '
    + 'Answer first, then the reason, then the next step. No greetings, recaps, offers or filler. Code, paths, errors, numbers and negations stay exact.',
  ultra: 'REPLY MODE ULTRA applies to this whole turn, including the final answer, summaries and "in detail" requests. Overrides other styles. '
    + 'Fragments, not sentences: zero a/an/the, is/are outside code; no filler, recap, offers. Each fact once; detailed means complete, still fragments. '
    + 'Code, paths, errors, numbers and negations stay exact; plain sentences only for security, irreversible steps, questions. Reread, cut every a/an/the/is/are. Like: "Cache miss, fetch origin, store result."',
  max: 'REPLY MODE MAX applies to this whole turn, including the final answer. Only `label: value` lines and comma lists: no sentences, zero a/an/the, is/are outside code. '
    + 'Silent between tool calls unless direction changes, confirmation is needed, or a security or irreversible issue appears. '
    + 'Code, paths, errors, numbers and negations stay exact; plain sentences only for security, irreversible steps, questions. Reread, cut every a/an/the/is/are. Like: "Cache miss, fetch origin, store result."',
};
const TOOL_REMINDERS = {
  lite: 'REPLY MODE LITE: final answer too. No filler, no recap.',
  full: 'REPLY MODE FULL: final answer too. Short, answer first.',
  ultra: 'REPLY MODE ULTRA: final answer too. Fragments, no a/an/the, is/are.',
  max: 'REPLY MODE MAX: final answer too. label: value lines only.',
};

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const readState = () => { const s = readJson(STATE); return isObj(s) ? s : {}; };
const stateMode = state => (LEVELS.includes(state.mode) ? state.mode : DEFAULT_MODE);

// Temp file + rename, so a reader never sees a half-written file.
function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
const writeState = state => writeFileAtomic(STATE, JSON.stringify(state, null, 2) + '\n');

// shortcut: no lock shared with other writers of settings.json; add one if a lost update shows up.
function editSettings(fn) {
  const settings = fs.existsSync(SETTINGS) ? readJson(SETTINGS) : {};
  if (!isObj(settings)) return false; // unreadable: never overwrite it
  fn(settings);
  writeFileAtomic(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  return true;
}

// Switch outputStyle to ours; the previous value is saved only the first time.
function applyStyle(state, level) {
  let prev;
  if (!editSettings(s => { prev = s.outputStyle; s.outputStyle = styleOf(level); })) return;
  if (!state.style) state.style = { prev: prev ?? null };
}

function restoreStyle(state) {
  if (!state.style) return;
  const { prev } = state.style;
  // A style the user picked since then is theirs: left alone.
  const ok = editSettings(s => {
    if (!isOurs(s.outputStyle)) return;
    if (prev === null) delete s.outputStyle;
    else s.outputStyle = prev;
  });
  if (ok) delete state.style; // unreadable settings: keep the saved style for a later off
}

function rulesOf(level) {
  return fs.readFileSync(path.join(__dirname, '..', 'output-styles', `reply-${level}.md`), 'utf8')
    .replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

function hookFire(mode) {
  writeFileAtomic(path.join(FIRED_DIR, `${mode}.txt`), new Date().toISOString());
  const state = readState();
  const envMode = process.env.OMC_REPLY_MODE;
  const override = LEVELS.includes(envMode);
  const level = override ? envMode : stateMode(state);
  if (level === 'off') return;
  // First session with the mode on: switch the style once. The env override never writes state.
  if (mode === 'session' && !override && !state.style) {
    applyStyle(state, level);
    state.mode = level;
    writeState(state);
  }
  const context = mode === 'prompt' ? REMINDERS[level] : mode === 'tool' ? TOOL_REMINDERS[level] : rulesOf(level);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: EVENTS[mode], additionalContext: context } }));
}

const currentStyle = () => (readJson(SETTINGS) || {}).outputStyle || 'default';

function setMode(level) {
  const state = readState();
  if (level === 'off') restoreStyle(state);
  else applyStyle(state, level);
  state.mode = level;
  writeState(state);
  console.log(`reply mode: ${level}. Output style: ${currentStyle()}. Takes effect from the next message.`);
}

function status() {
  console.log(`reply mode: ${stateMode(readState())}`);
  console.log(`style: ${currentStyle()}`);
  console.log('last hook fire (UTC):');
  for (const ev of Object.keys(EVENTS)) {
    let fired;
    try { fired = fs.readFileSync(path.join(FIRED_DIR, `${ev}.txt`), 'utf8').trim(); } catch { fired = null; }
    console.log(`  ${EVENTS[ev].padEnd(17)} ${fired ?? 'never'}`);
  }
}

const cmd = process.argv[2];
try {
  if (cmd === 'mode') {
    const level = process.argv[3];
    if (level === undefined) console.log(`reply mode: ${stateMode(readState())}`);
    else if (LEVELS.includes(level)) setMode(level);
    else { console.log('usage: /omc mode off|lite|full|ultra|max'); process.exit(2); }
  } else if (cmd === 'status') status();
  else if (EVENTS[cmd]) hookFire(cmd);
  else process.exit(2);
} catch (e) {
  // Hooks never fail a session; stdout stays clean.
  if (EVENTS[cmd]) process.exit(0);
  console.error(e.message);
  process.exit(1);
}
