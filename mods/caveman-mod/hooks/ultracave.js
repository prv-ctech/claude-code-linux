#!/usr/bin/env node
// Ultracave hook for caveman-mod. Argument: session, prompt or subagent.
// session and subagent get the full ruleset; prompt gets a one-line reminder on every message,
// so the style holds through a long chat. Output is one JSON object with
// hookSpecificOutput.additionalContext, which SessionStart, UserPromptSubmit and SubagentStart
// all add to the model's context.
const fs = require('fs');
const path = require('path');

const EVENTS = { session: 'SessionStart', prompt: 'UserPromptSubmit', subagent: 'SubagentStart' };
const mode = process.argv[2];

const REMINDER = 'CAVEMAN ULTRACAVE ACTIVE. Respond terse like smart caveman. All technical substance stay. '
  + 'Only fluff die. Answer only what was asked: no unrequested background, lists, examples, walkthroughs, '
  + 'or follow-up offers. Security warnings, irreversible actions, multi-step order: normal prose. '
  + 'Technical terms, code, commands, paths, and errors stay exact.';

const rules = fs.readFileSync(path.join(__dirname, '..', 'rules', 'ultracave.md'), 'utf8').trimEnd();

const context = mode === 'prompt' ? REMINDER : rules;
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: EVENTS[mode], additionalContext: context } }));
