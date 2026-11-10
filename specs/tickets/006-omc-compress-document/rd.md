# 006: /omc compress: document minimizer with backup and restore

**Status:** done

## Summary
`/omc compress <path>` rewrites a prose file (CLAUDE.md, notes, docs) to the fewest tokens while keeping every technical detail, backs the original up outside the file's folder, validates that protected parts are unchanged, and leaves the original in place if it cannot pass. `/omc restore <path>` puts the backup back.

## Why
Memory files like CLAUDE.md load into every session; shrinking them saves tokens on every turn. Protected parts (code, paths, numbers) must survive byte for byte.

## User stories
- As a user, I want `/omc compress CLAUDE.md` to shrink the file safely, so every session costs less.
- As a user, I want `/omc restore CLAUDE.md` to undo it.

## How it works
The session model does the rewriting (no API key, no network from the script); a Node script does everything checkable: `mods/oh-my-context-mod/scripts/doc.js` with subcommands `prepare`, `apply`, `restore`.

## Functional requirements
- **FR-1**: `/omc compress <path>` and `/omc restore <path>` are dispatched from `commands/omc.md` and `commands/oh-my-context-mod.md` (first word `compress` / `restore`); argument-hint adds `compress <file> | restore <file>`. The command text tells Claude the exact flow of FR-2..FR-6. Pasted text instead of a path: reply `usage: /omc compress <file path>` and do nothing.
- **FR-2**: `node scripts/doc.js prepare <path>` (path relative to `$CLAUDE_PROJECT_DIR` or absolute): accepts only existing regular files with extension `.md`, `.markdown`, `.txt`, `.rst`, `.typ`, `.typst`, `.tex`, or no extension. Refuses (exit 1, one line `refused: <reason>`) any other extension (e.g. `.py`, `.json`, `.yaml`, `.env`), names ending `.original.<ext>`, symlinks, files > 1 MiB, non-UTF-8 files, and files that already have a backup (`refused: already compressed; run /omc restore <path> first`). On success: writes the backup (FR-3), prints `backup: <backup path>`, `candidate: <candidate path>` and the rewrite rules (FR-4), exit 0. Candidate path: `<backup dir>/<name>.candidate`.
- **FR-3**: Backup path: `${XDG_DATA_HOME:-~/.local/share}/oh-my-context-mod/backups/<first 12 hex of sha256(absolute parent dir)>-<parent dir name>/<file name>.original` (the original file name kept, `.original` appended). Dirs 0700, file 0600, exact bytes. Never inside the file's own folder.
- **FR-4**: Rewrite rules (own words) printed by prepare: remove articles, filler words (just, really, basically, actually, simply), pleasantries, hedging, redundant phrases ("in order to" -> "to"), connective fluff (however, furthermore, additionally); use short fragments. Keep exactly: fenced and indented code blocks, inline code, URLs and links, file paths, commands, env vars (`$HOME`, `NODE_ENV`), proper nouns, dates, versions, all numbers, every heading line, frontmatter, table rows, list nesting and numbering, and the words not/never/no/only/except.
- **FR-5**: `node scripts/doc.js apply <path>`: reads the candidate, validates against the backup, and only if valid replaces the file (temp + rename, keeps file mode) and deletes the candidate; prints `compressed: <path> <before> -> <after> tokens (<pct>% smaller)` using chars/4 for both. Invalid: prints `invalid:` then one line per problem, exit 1, file untouched. Validation (all must hold):
  1. frontmatter block (leading `---`...`---`) identical;
  2. list of heading lines (`#`-style) identical and in order;
  3. list of fenced code blocks identical byte for byte and in order; indented code blocks (4+ spaces after blank line, outside lists) identical;
  4. multiset of inline code spans identical;
  5. multiset of URLs (`https?://\S+` trimmed of trailing `).,;`) identical;
  6. multiset of path-like tokens (contain `/` and no spaces, or start `~/` `./` `../`) identical;
  7. multiset of numbers (`\d+(\.\d+)*`) identical;
  8. table rows (lines starting `|`) identical;
  9. counts of each of the words not, never, no, only, except (case-insensitive, whole word) not lower;
  10. candidate strictly shorter in bytes than the original.
- **FR-6**: Retries: the command text tells Claude: after `invalid:`, fix only the listed problems in the candidate (no full rewrite) and run apply again, at most 2 retries; if the third apply still fails, run `node scripts/doc.js abort <path>` which deletes the candidate and the backup and prints `left unchanged: <path>`; report the problems to the user.
- **FR-7**: `node scripts/doc.js restore <path>`: copies the backup over the file (exact bytes), deletes the backup, prints `restored: <path>`. No backup: `no backup for <path>`, exit 1.
- **FR-8**: Tests `mods/oh-my-context-mod/test/doc.test.js` (node:test, temp `XDG_DATA_HOME` and temp files) for FR-2, FR-3, FR-5 (each validation rule with one failing candidate), FR-6 abort, FR-7.
- **FR-9**: plugin.json version bump to the next minor above what is on base (0.6.0 if 004 merged as 0.5.0); README section "Compress a document" (flow, file types, backup location, restore).

## Non-functional requirements
- **NFR-1**: Node 22 stdlib only. **NFR-2**: The script never sends anything over the network. **NFR-3**: No caveman/cave/ultracave/megacave/ccr words in files this ticket adds or changes.

## Edge cases & error handling
- Path outside the project: allowed (absolute path), same rules.
- File changed between prepare and apply (sha differs from backup): `invalid: file changed since prepare`, nothing written.
- Backup write fails: prepare exits 1, file untouched.

## Out of scope
- Compressing code, JSON, YAML, env files. Batch/folder compression. Tool-result compression (005).

## Affected areas
- `mods/oh-my-context-mod/scripts/doc.js` (new), `test/doc.test.js` (new), `commands/omc.md`, `commands/oh-my-context-mod.md`, `README.md`, `.claude-plugin/plugin.json`.

## Do not touch
- `hooks/**`, `vendor/**`, `output-styles/**`.

## Dependencies
- waits for 004 (both edit `commands/*.md`, README, plugin.json).

## Decisions made
- **Agreed with the user**: router decision 2d.
- **Decided by the ticket writer**: the session model rewrites, a script validates (no extra API calls); backup dir keyed by a hash of the parent folder to avoid name clashes; refuse a second compress while a backup exists so the true original is never overwritten; abort deletes the backup since the file is untouched; size limit 1 MiB.
