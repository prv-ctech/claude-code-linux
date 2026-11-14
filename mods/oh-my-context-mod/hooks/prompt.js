#!/usr/bin/env node
// oh-my-context-mod: SubagentStart hook. A subagent starts with an empty context, so it gets what the
// session got at its start: the card sync.js saved for this project and, in an indexed workspace, the
// code graph block, and the memory line while the mod runs the memory. Nothing is added per prompt: the card names what exists and the gateway's find
// tool does the matching, which a word-overlap hint on every prompt did worse.
// Any error prints nothing and exits 0.
const fs = require('fs');
const path = require('path');
const { paths, readText } = require('./restore.js');
const G = require('./graph.js');
const M = require('./memory.js');

function context(input, p) {
  if (p.pluginData && fs.existsSync(path.join(p.pluginData, 'off'))) return '';
  const root = G.projectDir(input);
  const card = (readText(G.cardFile(p, root)) || '').trim();
  const graph = G.graphOn(p) ? G.line(root) : '';
  return [card, graph, M.memoryOn(p) ? M.LINE : ''].filter(Boolean).join('\n');
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const text = context(input, paths());
  if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: text } }));
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    /* the card is optional; never hold up a subagent */
  }
}

module.exports = { context };
