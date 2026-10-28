#!/usr/bin/env node
// Ultracave hook for caveman-mod. Hook modes: session, prompt, subagent.
// Command modes: on, off, status (used by /caveman and /caveman-status).
// session and subagent get the full ruleset; prompt gets a one-line reminder on every message,
// so the style holds through a long chat. Output is one JSON object with
// hookSpecificOutput.additionalContext, which SessionStart, UserPromptSubmit and SubagentStart
// all add to the model's context. The on/off flag is a small JSON file next to the Claude config.
// Each hook writes its own fired-time file, so hooks never touch the flag.
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

const REMINDER = 'CAVEMAN ULTRACAVE ACTIVE. Respond terse like smart caveman. All technical substance stay. '
  + 'Only fluff die. Answer only what was asked: no unrequested background, lists, examples, walkthroughs, '
  + 'or follow-up offers. Security warnings, irreversible actions, multi-step order: normal prose. '
  + 'Technical terms, code, commands, paths, and errors stay exact.';

const rules = fs.readFileSync(path.join(__dirname, '..', 'rules', 'ultracave.md'), 'utf8').trimEnd();

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}

// Temp file + rename, so a reader never sees a half-written file. The pid keeps parallel writers apart.
function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function hookFire() {
  // Heartbeat: status reads these times to show the hook really ran.
  writeFileAtomic(path.join(FIRED_DIR, `${mode}.txt`), new Date().toISOString());
  if (readState().enabled === false) return;
  const context = mode === 'prompt' ? REMINDER : rules;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: EVENTS[mode], additionalContext: context } }));
}

function setEnabled(enabled) {
  writeFileAtomic(STATE, JSON.stringify({ enabled }, null, 2));
  console.log(`caveman: ${enabled ? 'ON' : 'OFF'}. Takes effect from the next message.`);
}

function status() {
  const enabled = readState().enabled !== false;
  let plugin = 'not enabled in settings.json';
  try {
    if (JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).enabledPlugins?.[PLUGIN_KEY] === true) plugin = 'enabled';
  } catch { plugin = 'settings.json missing or unreadable'; }
  const rulesOk = rules.length > 0 ? `ok (${rules.length} chars)` : 'EMPTY';
  console.log(`caveman: ${enabled ? 'ON' : 'OFF'}`);
  console.log(`state:   ${STATE}`);
  console.log(`plugin:  ${plugin}`);
  console.log(`rules:   ${rulesOk}`);
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
