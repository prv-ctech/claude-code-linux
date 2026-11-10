'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DOC = path.join(__dirname, '..', 'scripts', 'doc.js');
const ORIG = `---
title: Notes
---
# Setup

In order to run the app, you should basically just run \`npm start\` from /srv/app. It will listen on port 8080. Never use version 2.1.

\`\`\`sh
echo   hi
\`\`\`

| key | value |
|---|---|
| a | 1 |

See https://example.com/docs for more.
`;
const GOOD = ORIG.replace(/^In order.*$/m, 'Run `npm start` from /srv/app. Listens on port 8080. Never use version 2.1.');

function env() {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-xdg-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-doc-'));
  const file = path.join(dir, 'notes.md');
  fs.writeFileSync(file, ORIG);
  const run = (cmd, f = file) => spawnSync('node', [DOC, cmd, f], { encoding: 'utf8', env: { ...process.env, XDG_DATA_HOME: xdg } });
  const prep = () => {
    const r = run('prepare');
    return { r, backup: /backup: (.*)/.exec(r.stdout)?.[1], cand: /candidate: (.*)/.exec(r.stdout)?.[1] };
  };
  return { xdg, dir, file, run, prep };
}

// Candidate from mutate(GOOD) must be rejected with a message matching re; file untouched.
function bad(mutate, re) {
  const e = env(); const { cand } = e.prep();
  fs.writeFileSync(cand, mutate(GOOD));
  const r = e.run('apply');
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stdout, /^invalid:/);
  assert.match(r.stdout, re);
  assert.strictEqual(fs.readFileSync(e.file, 'utf8'), ORIG);
}

test('prepare writes backup with modes outside the folder', () => {
  const e = env(); const { r, backup, cand } = e.prep();
  assert.strictEqual(r.status, 0);
  assert.ok(backup.startsWith(e.xdg) && !backup.startsWith(e.dir));
  assert.match(backup, /backups\/[0-9a-f]{12}-omc-doc-[^/]+\/notes\.md\.original$/);
  assert.ok(cand.endsWith('notes.md.candidate'));
  assert.strictEqual(fs.statSync(backup).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.dirname(backup)).mode & 0o777, 0o700);
  assert.strictEqual(fs.readFileSync(backup, 'utf8'), ORIG);
  assert.match(r.stdout, /code blocks/);
});

test('prepare refusals', () => {
  const e = env();
  const mk = (n, c = 'x') => { const f = path.join(e.dir, n); fs.writeFileSync(f, c); return f; };
  const files = [mk('x.py'), mk('x.json'), mk('.' + 'env'), mk('notes.original.md'),
    mk('big.md', 'a'.repeat(2 * 1024 * 1024)), mk('bad.md', Buffer.from([0xff, 0xfe]))];
  fs.symlinkSync(e.file, path.join(e.dir, 'link.md'));
  files.push(path.join(e.dir, 'link.md'));
  for (const f of files) {
    const r = e.run('prepare', f);
    assert.strictEqual(r.status, 1, f);
    assert.match(r.stdout, /^refused:/);
  }
  assert.ok(!fs.existsSync(path.join(e.xdg, 'oh-my-context-mod')));
  e.prep();
  const again = e.run('prepare');
  assert.strictEqual(again.status, 1);
  assert.match(again.stdout, /already compressed/);
});

test('valid apply replaces file, drops candidate', () => {
  const e = env(); const { cand } = e.prep();
  fs.writeFileSync(cand, GOOD);
  const r = e.run('apply');
  assert.strictEqual(r.status, 0, r.stdout);
  assert.match(r.stdout, /^compressed: .* \d+ -> \d+ tokens \(\d+% smaller\)/);
  assert.strictEqual(fs.readFileSync(e.file, 'utf8'), GOOD);
  assert.ok(!fs.existsSync(cand));
});

test('each validation rule fails', () => {
  bad((t) => t.replace('title: Notes', 'title: N'), /frontmatter/);
  bad((t) => t.replace('# Setup', '# Install'), /headings/);
  bad((t) => t.replace('echo   hi', 'echo hi'), /fenced/);
  bad((t) => t.replace('`npm start`', 'npm start'), /inline code/);
  bad((t) => t.replace('https://example.com/docs', 'the site'), /URLs/);
  bad((t) => t.replace('/srv/app', 'the dir'), /paths/);
  bad((t) => t.replace('8080', 'port'), /numbers/);
  bad((t) => t.replace('| a | 1 |', '| a | 1 | x |'), /table rows/);
  bad((t) => t.replace('Never', 'Always'), /"never"/);
  bad(() => ORIG + ' ', /not shorter/);
});

test('indented code block change is caught', () => {
  const e = env();
  fs.writeFileSync(e.file, 'Intro text here.\n\n    code line\n\nEnd text here.\n');
  const { cand } = e.prep();
  fs.writeFileSync(cand, 'Intro.\n\n    code  line\n\nEnd.\n');
  assert.match(e.run('apply').stdout, /indented code/);
});

test('file changed since prepare', () => {
  const e = env(); const { cand } = e.prep();
  fs.writeFileSync(cand, GOOD);
  fs.appendFileSync(e.file, 'more\n');
  const r = e.run('apply');
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /file changed since prepare/);
});

test('abort deletes backup and candidate', () => {
  const e = env(); const { backup, cand } = e.prep();
  fs.writeFileSync(cand, 'x');
  assert.match(e.run('abort').stdout, /^left unchanged:/);
  assert.ok(!fs.existsSync(backup) && !fs.existsSync(cand));
  assert.strictEqual(fs.readFileSync(e.file, 'utf8'), ORIG);
});

test('restore puts original back; second restore fails', () => {
  const e = env(); const { backup, cand } = e.prep();
  fs.writeFileSync(cand, GOOD); e.run('apply');
  assert.match(e.run('restore').stdout, /^restored:/);
  assert.strictEqual(fs.readFileSync(e.file, 'utf8'), ORIG);
  assert.ok(!fs.existsSync(backup));
  const r2 = e.run('restore');
  assert.strictEqual(r2.status, 1);
  assert.match(r2.stdout, /^no backup for /);
});
