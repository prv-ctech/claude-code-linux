#!/usr/bin/env node
'use strict';
// Document minimizer helper: prepare / apply / abort / restore. Node stdlib only, no network.
// The session model rewrites the candidate; this script checks and swaps files.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const EXTS = new Set(['.md', '.markdown', '.txt', '.rst', '.typ', '.typst', '.tex', '']);
const MAX = 1024 * 1024;
const WORDS = ['not', 'never', 'no', 'only', 'except'];

const RULES = `rewrite rules for the candidate:
- remove articles, filler (just, really, basically, actually, simply), pleasantries, hedging
- shorten redundant phrases ("in order to" -> "to"); drop connective fluff (however, furthermore, additionally)
- use short fragments
- keep exactly: fenced and indented code blocks, inline code, URLs and links, file paths, commands,
  env vars ($HOME, NODE_ENV), proper nouns, dates, versions, all numbers, every heading line,
  frontmatter, table rows, list nesting and numbering, and the words not/never/no/only/except
- write the result to the candidate path; then run apply`;

function fail(msg) { console.log(msg); process.exit(1); }

function resolve(p) {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd(), p);
}

function paths(file) {
  let parent;
  try { parent = fs.realpathSync(path.dirname(file)); } catch { parent = path.dirname(file); }
  const hash = crypto.createHash('sha256').update(parent).digest('hex').slice(0, 12);
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const dir = path.join(base, 'oh-my-context-mod', 'backups', `${hash}-${path.basename(parent)}`);
  const name = path.basename(file);
  return { dir, backup: path.join(dir, `${name}.original`), candidate: path.join(dir, `${name}.candidate`) };
}

function decode(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return null; }
}

// Split text into the pieces we compare: frontmatter, headings, fences, indented blocks, rows.
function parts(text) {
  const fm = (/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text) || [''])[0];
  const lines = text.slice(fm.length).split('\n');
  const headings = [], fences = [], indented = [], rows = [];
  let fence = null, cur = null, prevBlank = true, inList = false, ind = null;
  for (const line of lines) {
    if (fence) {
      cur.push(line);
      const m = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) { fences.push(cur.join('\n')); fence = null; }
      continue;
    }
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (open) {
      if (ind) { indented.push(ind.join('\n').replace(/\s+$/, '')); ind = null; }
      fence = open[1]; cur = [line]; continue;
    }
    const blank = !line.trim();
    if (!blank && /^(?: {4}|\t)/.test(line) && !inList && (prevBlank || ind)) {
      (ind = ind || []).push(line); prevBlank = false; continue;
    }
    if (ind && blank) { ind.push(line); prevBlank = true; continue; }
    if (ind) { indented.push(ind.join('\n').replace(/\s+$/, '')); ind = null; }
    if (blank) { prevBlank = true; continue; }
    inList = /^\s*([-*+]|\d+[.)])\s/.test(line) || (inList && /^\s/.test(line));
    prevBlank = false;
    if (/^ {0,3}#{1,6}(\s|$)/.test(line)) headings.push(line);
    if (line.startsWith('|')) rows.push(line);
  }
  if (fence) fences.push(cur.join('\n'));
  if (ind) indented.push(ind.join('\n').replace(/\s+$/, ''));
  return { fm, headings, fences, indented, rows };
}

const inline = (s) => [...s.matchAll(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g)].map((m) => m[0]);
const urls = (s) => (s.match(/https?:\/\/\S+/g) || []).map((u) => u.replace(/[).,;]+$/, ''));
const nums = (s) => s.match(/\d+(?:\.\d+)*/g) || [];
function pathsIn(s) {
  return s.split(/\s+/).map((t) => t.replace(/^[("'`[]+|[)"'`\],.;:]+$/g, ''))
    .filter((t) => t && (t.includes('/') || /^(~\/|\.\/|\.\.\/)/.test(t)));
}
const wordCount = (s, w) => (s.match(new RegExp(`\\b${w}\\b`, 'gi')) || []).length;

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameSet = (a, b) => sameList([...a].sort(), [...b].sort());
function diffSet(a, b) {
  const c = new Map();
  for (const x of a) c.set(x, (c.get(x) || 0) + 1);
  for (const x of b) c.set(x, (c.get(x) || 0) - 1);
  return [...c].filter(([, n]) => n).map(([k, n]) => `${n > 0 ? 'missing' : 'extra'} ${JSON.stringify(k)}`);
}

function validate(orig, cand) {
  const o = parts(orig), c = parts(cand), errs = [];
  if (o.fm !== c.fm) errs.push('frontmatter changed');
  if (!sameList(o.headings, c.headings)) errs.push(`headings changed: expected ${JSON.stringify(o.headings)}, got ${JSON.stringify(c.headings)}`);
  if (!sameList(o.fences, c.fences)) errs.push('fenced code blocks changed');
  if (!sameList(o.indented, c.indented)) errs.push('indented code blocks changed');
  for (const [name, f] of [['inline code', inline], ['URLs', urls], ['paths', pathsIn], ['numbers', nums]]) {
    const a = f(orig), b = f(cand);
    if (!sameSet(a, b)) errs.push(`${name} changed: ${diffSet(a, b).join(', ')}`);
  }
  if (!sameSet(o.rows, c.rows)) errs.push('table rows changed');
  for (const w of WORDS) {
    const a = wordCount(orig, w), b = wordCount(cand, w);
    if (b < a) errs.push(`word "${w}" count dropped ${a} -> ${b}`);
  }
  if (Buffer.byteLength(cand) >= Buffer.byteLength(orig)) errs.push('candidate not shorter than original');
  return errs;
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function prepare(file) {
  let st;
  try { st = fs.lstatSync(file); } catch { fail('refused: file not found'); }
  if (st.isSymbolicLink()) fail('refused: symlink');
  if (!st.isFile()) fail('refused: not a regular file');
  const name = path.basename(file);
  if (/\.original(\.[^.]*)?$/i.test(name)) fail('refused: name ends with .original');
  if (name.startsWith('.') && path.extname(name) === '') fail(`refused: dotfile ${name}`);
  const ext = path.extname(name).toLowerCase();
  if (!EXTS.has(ext)) fail(`refused: unsupported file type ${ext}`);
  if (st.size > MAX) fail('refused: file larger than 1 MiB');
  const buf = fs.readFileSync(file);
  if (decode(buf) === null) fail('refused: not valid UTF-8');
  const p = paths(file);
  if (fs.existsSync(p.backup)) fail('refused: already compressed; run /omc restore <path> first');
  try {
    fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(p.dir, 0o700);
    fs.writeFileSync(p.backup, buf, { mode: 0o600 });
    fs.chmodSync(p.backup, 0o600);
  } catch (e) {
    try { fs.rmSync(p.backup, { force: true }); } catch {}
    fail(`refused: cannot write backup (${e.code || e.message})`);
  }
  console.log(`backup: ${p.backup}\ncandidate: ${p.candidate}\n${RULES}`);
}

function apply(file) {
  const p = paths(file);
  if (!fs.existsSync(p.backup)) fail('invalid:\nno backup; run prepare first');
  const origBuf = fs.readFileSync(p.backup);
  let cur;
  try { cur = fs.readFileSync(file); } catch { fail('invalid:\nfile missing'); }
  if (sha(cur) !== sha(origBuf)) fail('invalid: file changed since prepare');
  if (!fs.existsSync(p.candidate)) fail('invalid:\nno candidate; write it first');
  const cand = decode(fs.readFileSync(p.candidate));
  if (cand === null) fail('invalid:\ncandidate is not valid UTF-8');
  const orig = origBuf.toString('utf8');
  const errs = validate(orig, cand);
  if (errs.length) fail(`invalid:\n${errs.join('\n')}`);
  const tmp = `${file}.omc-tmp-${process.pid}`;
  const mode = fs.statSync(file).mode & 0o7777;
  fs.writeFileSync(tmp, cand, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
  fs.rmSync(p.candidate, { force: true });
  const before = Math.ceil(orig.length / 4), after = Math.ceil(cand.length / 4);
  console.log(`compressed: ${file} ${before} -> ${after} tokens (${Math.round((1 - after / before) * 100)}% smaller)`);
}

function abort(file) {
  const p = paths(file);
  // After a successful apply the candidate is gone and the file differs: keep the backup for restore.
  if (!fs.existsSync(p.candidate) && fs.existsSync(p.backup) && fs.existsSync(file)
    && sha(fs.readFileSync(file)) !== sha(fs.readFileSync(p.backup))) {
    fail(`refused: ${file} differs from its backup; use /omc restore to undo`);
  }
  fs.rmSync(p.candidate, { force: true });
  fs.rmSync(p.backup, { force: true });
  console.log(`left unchanged: ${file}`);
}

function restore(file) {
  const p = paths(file);
  if (!fs.existsSync(p.backup)) fail(`no backup for ${file}`);
  fs.writeFileSync(file, fs.readFileSync(p.backup));
  fs.rmSync(p.backup, { force: true });
  fs.rmSync(p.candidate, { force: true });
  console.log(`restored: ${file}`);
}

const [cmd, arg] = process.argv.slice(2);
const cmds = { prepare, apply, abort, restore };
if (!cmds[cmd] || !arg) fail('usage: doc.js prepare|apply|abort|restore <file path>');
cmds[cmd](resolve(arg));
