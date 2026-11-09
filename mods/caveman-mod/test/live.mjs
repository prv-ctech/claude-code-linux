#!/usr/bin/env node
// Live check: do real replies follow the caveman style? Calls the real model (9 calls), so it is
// not named *.test.js and never runs in the offline test command. Run from the project root:
//   node mods/caveman-mod/test/live.mjs
// Exit 0 = all pass, 1 = a result failed, 2 = skipped (no CLI, not logged in, caveman off).
// Never writes the user's settings.json or caveman-mod.json; scenarios only pass --settings flags.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STYLE = 'caveman-mod:ultracave';
const INSTALLED = 'caveman-mod@claude-code-linux';
const MAX_RATIO = 4.0; // percent, every A and B reply
const MIN_CONTROL = 6.0; // percent, C aggregate
const TIMEOUT_MS = 120_000;

const PROMPTS = [
  ['P1', 'Explain the difference between git merge and git rebase.'],
  ['P2', 'Why does a React component re-render when I pass an inline object as a prop?'],
  ['P3', 'What does the HTTP status code 409 mean and when should an API return it?'],
];
const SCENARIOS = [
  { id: 'A', style: STYLE, plugin: true },
  { id: 'B', style: 'default', plugin: true },
  { id: 'C', style: 'default', plugin: false },
];

function skip(why) {
  console.log(`SKIP: ${why}`);
  process.exit(2);
}

// Never print a token, e-mail address or UUID.
const clean = s => String(s).replace(/sk-ant-[\w-]+|[\w.%+-]+@[\w.-]+\.[a-z]{2,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<redacted>').replace(/\s+/g, ' ').trim().slice(0, 80);

export function score(reply) {
  const text = reply.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  const words = text.match(/[A-Za-z']+/g) || [];
  const filler = words.filter(w => /^(the|a|an|is|are)$/i.test(w)).length;
  return { filler, words: words.length };
}
const pct = (f, w) => (w ? (100 * f) / w : 0);
const fmt = (f, w) => `filler=${f}/${w} (${pct(f, w).toFixed(1)}%)`;

function runScenario(sc, prompt) {
  return new Promise(resolve => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'caveman-live-')); // not a git repo
    const settings = { outputStyle: sc.style, enabledPlugins: { [INSTALLED]: false } };
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', 'opus', '--max-turns', '1',
      '--settings', JSON.stringify(settings)];
    if (sc.plugin) args.push('--plugin-dir', PLUGIN_DIR);
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, TIMEOUT_MS);
    child.stdout.on('data', d => { out += d; });
    child.stderr.resume();
    const done = res => { clearTimeout(timer); fs.rmSync(cwd, { recursive: true, force: true }); resolve(res); };
    child.on('error', e => done({ error: e.message }));
    child.on('close', code => {
      if (timedOut) return done({ error: 'timeout after 120 s' });
      let outputStyle; let reply; let isError = false;
      for (const line of out.split('\n')) {
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'system' && ev.subtype === 'init') outputStyle = ev.output_style;
        if (ev.type === 'result') { reply = ev.result; isError = !!ev.is_error; }
      }
      if (reply === undefined || isError) return done({ error: clean(reply || `exit ${code}, no result`), outputStyle });
      done({ outputStyle, reply });
    });
  });
}

async function main() {
  const state = (() => { try { return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'caveman-mod.json'), 'utf8')); } catch { return {}; } })();
  if (state.enabled === false) skip('caveman is off in the state file. Run /caveman on first.');
  // Without state.style the plugin's first-session hook would rewrite settings.json and the state file (NFR-1).
  if (!state.style) skip('caveman never switched your output style yet. Run /caveman on first.');
  const ver = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (ver.error || ver.status !== 0) skip('claude CLI not found on PATH.');
  const auth = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8' });
  let loggedIn = false;
  try { loggedIn = JSON.parse(auth.stdout).loggedIn === true; } catch { /* not logged in */ }
  if (!loggedIn) skip('claude CLI is not logged in. Run claude auth login.');

  // 9 independent calls: run them all at once to stay far below the 10 minute budget.
  const jobs = SCENARIOS.flatMap(sc => PROMPTS.map(([pid, prompt]) => ({ sc, pid, prompt })));
  const results = await Promise.all(jobs.map(j => runScenario(j.sc, j.prompt)));

  let allPass = true;
  const line = (ok, text) => { if (!ok) allPass = false; console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`); };

  for (const sc of SCENARIOS.filter(s => s.plugin)) {
    const first = results[jobs.findIndex(j => j.sc === sc)];
    line(first.outputStyle === sc.style, `${sc.id} init output_style=${first.outputStyle ?? 'unknown'}`);
  }
  for (const sc of SCENARIOS.filter(s => s.plugin)) {
    for (const [pid] of PROMPTS) {
      const r = results[jobs.findIndex(j => j.sc === sc && j.pid === pid)];
      if (r.error) { line(false, `${sc.id} ${pid} (error: ${r.error})`); continue; }
      const { filler, words } = score(r.reply);
      if (!words) line(false, `${sc.id} ${pid} (empty reply)`);
      else line(pct(filler, words) <= MAX_RATIO, `${sc.id} ${pid} ${fmt(filler, words)}`);
    }
  }
  const control = jobs.map((j, i) => [j, results[i]]).filter(([j]) => j.sc.id === 'C').map(([, r]) => r);
  const bad = control.find(r => r.error);
  if (bad) line(false, `C control (error: ${bad.error})`);
  else {
    const t = control.reduce((a, r) => { const s = score(r.reply); return { filler: a.filler + s.filler, words: a.words + s.words }; }, { filler: 0, words: 0 });
    if (!t.words) line(false, 'C control (empty reply)');
    else line(pct(t.filler, t.words) >= MIN_CONTROL, `C control ${fmt(t.filler, t.words)}`);
  }

  console.log(`RESULT: ${allPass ? 'PASS' : 'FAIL'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch(e => { console.log(`FAIL internal error: ${clean(e.message)}`); console.log('RESULT: FAIL'); process.exit(1); });
