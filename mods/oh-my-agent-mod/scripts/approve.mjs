// oh-my-agent-mod: the approval manifest (.oma/approved.json).
// Written only by the UserPromptSubmit hook when the person types /oma approve; read by the guard
// before a worker starts. A ticket is approved while its rd.md and every approved part of its eval.md
// still hash to what the person saw. New checks may be added; approved ones may not change.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const hash = s => createHash('sha256').update(s).digest('hex').slice(0, 16);
const read = f => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};
export const manifestFile = root => path.join(root, '.oma', 'approved.json');
const ticketsDir = root => path.join(root, 'specs', 'tickets');

// eval.md split at its ## and ### headings: { "Setup": hash, "E-1": hash, ... }. Traceability and
// Definition of done list the checks, so they change whenever a check is added: left out.
function evalParts(text) {
  const parts = {};
  for (const block of text.split(/^(?=#{2,3} )/m).slice(1)) {
    const key = block.match(/^#{2,3} +([^:\n]+)/)[1].trim();
    if (!/^(Traceability|Definition of done)$/i.test(key)) parts[key] = hash(block.trim());
  }
  return parts;
}

// What approval covers for one ticket folder, or null when rd.md or eval.md is missing.
export function digest(root, name) {
  const rd = read(path.join(ticketsDir(root), name, 'rd.md'));
  const ev = read(path.join(ticketsDir(root), name, 'eval.md'));
  if (rd === null || ev === null) return null;
  // The Status line moves draft -> ready -> done after approval.
  return { rd: hash(rd.replace(/^\*\*Status:\*\*.*$/m, '').trim()), eval: evalParts(ev) };
}

const manifest = root => {
  try {
    const m = JSON.parse(fs.readFileSync(manifestFile(root), 'utf8'));
    return m && typeof m.tickets === 'object' && m.tickets ? m : { tickets: {} };
  } catch {
    return { tickets: {} };
  }
};

// Why this ticket folder may not be built, or null when it is approved as it stands.
export function problem(root, name) {
  const now = digest(root, name);
  if (!now) return 'its rd.md or eval.md is missing';
  const was = manifest(root).tickets[name];
  if (!was) return 'the user has not approved it';
  if (was.rd !== now.rd) return 'its rd.md changed after the user approved it';
  const changed = Object.keys(was.eval || {}).filter(k => now.eval[k] !== was.eval[k]);
  return changed.length ? `approved parts of its eval.md changed or were removed (${changed.join(', ')})` : null;
}

const folders = root => {
  try {
    return fs.readdirSync(ticketsDir(root)).filter(n => /^\d{3}-/.test(n)).sort();
  } catch {
    return [];
  }
};

// { approved: [...], pending: [{ ticket, why }] } for every ticket folder not in `done`.
export function state(root, done = []) {
  const out = { approved: [], pending: [] };
  for (const name of folders(root)) {
    if (done.includes(name.slice(0, 3))) continue;
    const why = problem(root, name);
    if (why) out.pending.push({ ticket: name, why });
    else out.approved.push(name);
  }
  return out;
}

// Records every ticket in `pending` as it is on disk now. Returns the folder names it approved.
export function approve(root, done = []) {
  const m = manifest(root);
  const names = [];
  for (const { ticket } of state(root, done).pending) {
    const d = digest(root, ticket);
    if (!d) continue;
    m.tickets[ticket] = { approved: new Date().toISOString(), ...d };
    names.push(ticket);
  }
  if (names.length) {
    fs.mkdirSync(path.dirname(manifestFile(root)), { recursive: true });
    fs.writeFileSync(manifestFile(root), JSON.stringify(m, null, 2) + '\n');
  }
  return names;
}
