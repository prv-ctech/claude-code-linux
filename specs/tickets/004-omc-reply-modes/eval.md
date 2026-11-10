# 004: Reply compression modes: Evaluation

## Setup
From the worktree root. No install. Tests use temp dirs: `export T=$(mktemp -d); export CLAUDE_CONFIG_DIR=$T` for the CLI checks below (never your real config dir).

## Automated checks
- `for m in mods/*-mod; do claude plugin validate "$m" || exit 1; done` exits 0
- `node --test mods/oh-my-context-mod/test/*.test.js` passes, including new `test/reply.test.js`
- `PYTHONPATH=mods/oh-my-context-mod/vendor python3 -m unittest discover -s mods/oh-my-context-mod/test -p 'test_*.py'` passes

## Acceptance checks

### E-1: hooks emit context (covers FR-1, FR-2, FR-3)
- **Type**: CLI
- **Steps**: with `CLAUDE_CONFIG_DIR=$T` and `echo '{"outputStyle":"Concise"}' > $T/settings.json`, run `node mods/oh-my-context-mod/hooks/reply.js session`, then `prompt`, `tool`, `subagent`.
- **Expected**: each prints one JSON object; `hookEventName` is SessionStart / UserPromptSubmit / PostToolUse / SubagentStart; session and subagent `additionalContext` starts with `REPLY MODE ULTRA:`; tool context length <= 100; `node -e` parse of hooks.json shows the four reply.js commands plus every entry that was there before (sync.js session/epoch, prompt.js, permit.js).

### E-2: style switch once (covers FR-7)
- **Type**: CLI
- **Steps**: after E-1, `cat $T/settings.json $T/oh-my-context-mod/reply.json`; then write `{"outputStyle":"Explanatory"}` to settings.json and run `reply.js session` again.
- **Expected**: first: outputStyle `oh-my-context-mod:reply-ultra`, reply.json style.prev `Concise`. After the second session run outputStyle is still `Explanatory`. `$T/oh-my-context-mod/reply-fired/session.txt` holds an ISO time.

### E-3: mode command (covers FR-6, FR-10)
- **Type**: CLI
- **Steps**: fresh `$T` with `{"outputStyle":"Concise"}`; run `reply.js mode max`, `reply.js mode`, `reply.js mode off`, `reply.js mode loud; echo $?`.
- **Expected**: line `reply mode: max. Output style: oh-my-context-mod:reply-max. Takes effect from the next message.`; then current `max`; after off outputStyle is `Concise` and `reply.js session` prints nothing; invalid prints `usage: /omc mode off|lite|full|ultra|max`, exit 2, files unchanged. `commands/omc.md` contains the `mode` dispatch to `hooks/reply.js`.

### E-4: level rules (covers FR-4, FR-5)
- **Type**: CLI + review
- **Steps**: open the four `output-styles/reply-*.md`.
- **Expected**: frontmatter name `reply-<level>`, `keep-coding-instructions: true`; first body line starts `REPLY MODE <LEVEL>:`; each has the floor (exact words: not/never/no/only/except; code, commands, paths, errors untouched; plain sentences list incl. security, irreversible, questions, text saved outside chat); ultra has a Bad/Good pair; max states label: value lines and silence between tool calls. No sentence copied from `mods/caveman-mod/output-styles/ultracave.md`.

### E-5: env override (covers FR-8)
- **Type**: CLI
- **Steps**: state mode off (`reply.js mode off`), then `OMC_REPLY_MODE=max node .../reply.js subagent`.
- **Expected**: context starts `REPLY MODE MAX:`; reply.json still says `off`.

### E-6: status (covers FR-9)
- **Type**: CLI
- **Expected**: `reply.js status` prints `reply mode: off`, a `style:` line and four event lines under `last hook fire (UTC):`.

### E-7: live check (covers FR-12)
- **Type**: CLI (needs logged-in claude; exit 2 = skip is acceptable only when not logged in)
- **Steps**: `node mods/oh-my-context-mod/test/live-reply.mjs`; before and after, `sha256sum ~/.claude/settings.json` (or $CLAUDE_CONFIG_DIR unset real dir).
- **Expected**: `RESULT: PASS`, exit 0; the hash is unchanged.

### E-8: docs and version (covers FR-13, FR-11)
- **Expected**: plugin.json version `0.5.0`; README has a `Reply modes` heading; reply.test.js exists and passes.

## Edge case checks
### E-9: corrupt files (covers edge cases, NFR-3)
- Write `{oops` to settings.json, run `reply.js mode ultra`: settings.json still `{oops`. Write `{oops` to reply.json: `reply.js mode` prints `ultra`.

### E-10: naming (covers NFR-2)
- `python3 -c "import re,subprocess;fs=subprocess.check_output(['git','diff','--name-only','main']).decode().split();print([f for f in fs if f.startswith('mods/oh-my-context-mod') and re.search(r'caveman|\bcave\b|ultracave|megacave|ccr',open(f).read()+f,re.I)])"` prints `[]`.

### E-11: speed (covers NFR-1)
- `time node mods/oh-my-context-mod/hooks/reply.js prompt` real < 1 s.

## Regression checks
- `/omc status` still runs: `node mods/oh-my-context-mod/hooks/sync.js status` exits 0 and its first line starts `oh-my-context-mod:`.

## Traceability
| Requirement | Evals |
|---|---|
| FR-1, FR-2, FR-3 | E-1 |
| FR-4, FR-5 | E-4 |
| FR-6 | E-3 |
| FR-7 | E-2 |
| FR-8 | E-5 |
| FR-9 | E-6 |
| FR-10 | E-3 |
| FR-11, FR-13 | E-8 |
| FR-12 | E-7 |
| NFR-1 | E-11 |
| NFR-2 | E-10 |
| NFR-3 | E-9 |

## Definition of done
- [ ] All automated checks pass
- [ ] E-1..E-11 pass
- [ ] Nothing from Out of scope built
