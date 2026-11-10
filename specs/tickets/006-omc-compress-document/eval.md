# 006: /omc compress: Evaluation

## Setup
From the worktree root. `export XDG_DATA_HOME=$(mktemp -d); D=$(mktemp -d)`. Create `$D/notes.md`:
```
---
title: Notes
---
# Setup

In order to run the app, you should basically just run `npm start` from /srv/app. It will listen on port 8080. Do not use version 2.1.

| key | value |
|---|---|
| a | 1 |

See https://example.com/docs for more.
```

## Automated checks
- `for m in mods/*-mod; do claude plugin validate "$m" || exit 1; done` exits 0
- `node --test mods/oh-my-context-mod/test/*.test.js` passes, including `doc.test.js`
- `PYTHONPATH=mods/oh-my-context-mod/vendor python3 -m unittest discover -s mods/oh-my-context-mod/test -p 'test_*.py'` passes

## Acceptance checks

### E-1: prepare + backup (covers FR-2, FR-3, FR-4)
- **Type**: CLI
- **Steps**: `node mods/oh-my-context-mod/scripts/doc.js prepare $D/notes.md`
- **Expected**: exit 0; prints `backup: $XDG_DATA_HOME/oh-my-context-mod/backups/<12hex>-<dirname>/notes.md.original`, a `candidate:` line, and rules naming code blocks, URLs, paths, numbers, headings, frontmatter, tables. `cmp` backup vs file: identical; backup mode 600.

### E-2: valid apply (covers FR-5)
- **Steps**: write to the candidate path the same file with the prose line replaced by `Run app: \`npm start\` from /srv/app. Listens on port 8080. Do not use version 2.1.`; run `doc.js apply $D/notes.md`.
- **Expected**: `compressed: ... -> ... tokens (N% smaller)`; file equals candidate; candidate gone.

### E-3: invalid apply, untouched (covers FR-5)
- **Steps**: restore (E-5), prepare again, write a candidate missing `8080` and changing the heading to `# Install`; apply.
- **Expected**: exit 1; `invalid:` with lines naming the number and the heading; file identical to backup.

### E-4: abort (covers FR-6)
- **Steps**: `doc.js abort $D/notes.md`.
- **Expected**: `left unchanged: ...`; backup and candidate deleted; file unchanged. `commands/omc.md` text states fix-only-listed-problems, max 2 retries, then abort.

### E-5: restore (covers FR-7)
- **Steps**: after E-2, `doc.js restore $D/notes.md`.
- **Expected**: `restored:`; file byte-equal to original; backup gone; second restore prints `no backup for ...`, exit 1.

### E-6: refusals (covers FR-2)
- **Expected**: `prepare` on `x.py`, `x.json`, `.env`, `notes.original.md`, a symlink, a 2 MiB file, a file with a live backup: each exit 1, `refused: ...`, no backup created.

### E-7: command dispatch (covers FR-1)
- **Expected**: omc.md and oh-my-context-mod.md route `compress`/`restore` to `scripts/doc.js`, keep `mode` -> reply.js and others -> sync.js; argument-hint lists compress and restore; usage line for pasted text present.

### E-8: changed between steps (edge)
- prepare, then append a line to the file, then apply -> `invalid: file changed since prepare`.

### E-9: tests, docs, version, naming (covers FR-8, FR-9, NFR-1..3)
- doc.test.js exists and passes; plugin.json version higher than base; README has `Compress a document`; doc.js requires only `node:` modules and no `http`/`https`/`net`/`fetch`; no forbidden words in changed files.

## Regression checks
- `/omc mode` path: `node mods/oh-my-context-mod/hooks/reply.js mode` still prints a level. `node mods/oh-my-context-mod/hooks/sync.js status` exits 0.

## Traceability
| Requirement | Evals |
|---|---|
| FR-1 | E-7 |
| FR-2 | E-1, E-6 |
| FR-3, FR-4 | E-1 |
| FR-5 | E-2, E-3, E-8 |
| FR-6 | E-4 |
| FR-7 | E-5 |
| FR-8, FR-9, NFR-1..3 | E-9 |

## Definition of done
- [ ] All automated checks pass
- [ ] E-1..E-9 pass
- [ ] Nothing from Out of scope built
