'use strict';
// No file name or content under the mod may carry the names of the project it was cut from.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const c = ['ca', 've'].join('');
const bad = new RegExp(['ca', 've', 'man'].join('') + '|ultra' + c + '|mega' + c + '|\\b' + c + '\\b|' + ['c', 'cr'].join(''), 'i');
const root = path.join(__dirname, '..');

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__pycache__' || e.name.endsWith('.pyc')) continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(f);
    else yield f;
  }
}

test('no forbidden upstream name in any file name or line', () => {
  const hits = [];
  for (const f of walk(root)) {
    const rel = path.relative(root, f);
    if (bad.test(rel)) hits.push(`${rel} (file name)`);
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (bad.test(line)) hits.push(`${rel}:${i + 1}`);
    });
  }
  assert.deepStrictEqual(hits, []);
});
