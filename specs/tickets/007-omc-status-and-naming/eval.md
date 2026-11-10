# 007: /omc status and naming check: Evaluation

## Setup
From the worktree root. `export OMC_HOME=$(mktemp -d) CLAUDE_CONFIG_DIR=$(mktemp -d)`; `echo '{}' > $CLAUDE_CONFIG_DIR/settings.json`.

## Automated checks
- `for m in mods/*-mod; do claude plugin validate "$m" || exit 1; done` exits 0
- `node --test mods/oh-my-context-mod/test/*.test.js` passes, including `naming.test.js`
- `PYTHONPATH=mods/oh-my-context-mod/vendor python3 -m unittest discover -s mods/oh-my-context-mod/test -p 'test_*.py'` passes

## Acceptance checks

### E-1: stats CLI (covers FR-1)
- **Type**: CLI
- **Steps**: `mods/oh-my-context-mod/bin/oh-my-context stats`
- **Expected**: one JSON line with keys `compress` (`on`), `recovery.bytes` 0, `recovery.cap` 536870912, `recovery.entries` 0, `saved_tokens` 0.

### E-2: status lines (covers FR-1, NFR-1)
- **Steps**: `node mods/oh-my-context-mod/hooks/sync.js status`; `node mods/oh-my-context-mod/hooks/reply.js mode lite` then status again. Hash `$CLAUDE_CONFIG_DIR` and `$OMC_HOME` file listings before/after status.
- **Expected**: old lines still present (first line starts `oh-my-context-mod:`, `MCP servers (`, `Guard`, `Filters`, `Paths`); new lines `Skills by name: direct: ...`, `Reply mode: ultra (style: default)` then `Reply mode: lite ...`, `Tool-result compression: on`, `Recovery store: 0.0 MiB of 512.0 MiB, 0 entries (...)`, `Tokens saved by compression: 0`. Status changes no files; < 5 s.

### E-3: gateway down (covers FR-1 edge)
- **Steps**: `PATH=/nonexistent:$PATH`-style stub or test stub making the CLI fail.
- **Expected**: the three gateway lines read `unknown (gateway CLI not runnable)`; exit 0. (Covered in sync.test.js, FR-6.)

### E-4: naming test bites (covers FR-3, FR-4)
- **Steps**: `echo cave > mods/oh-my-context-mod/x.txt; node --test mods/oh-my-context-mod/test/naming.test.js; rm mods/oh-my-context-mod/x.txt; node --test mods/oh-my-context-mod/test/naming.test.js`
- **Expected**: first run fails naming `x.txt`; second passes.

### E-5: docs (covers FR-2, FR-5)
- **Expected**: README has headings `Tool-result compression` and `Status`, mentions `<<omc:`, `OMC_RECOVERY_MAX_BYTES`, `512`; plugin.json version higher than base; `git diff main -- .claude-plugin/marketplace.json` is empty.

### E-6: tests (covers FR-6)
- **Expected**: a test asserts the new lines; passes.

## Regression checks
- `node mods/oh-my-context-mod/hooks/sync.js on` / `off` behave as before (sync.test.js existing tests pass).

## Traceability
| Requirement | Evals |
|---|---|
| FR-1 | E-1, E-2, E-3 |
| FR-2, FR-5 | E-5 |
| FR-3, FR-4 | E-4 |
| FR-6 | E-6 |
| NFR-1 | E-2 |

## Definition of done
- [ ] All automated checks pass
- [ ] E-1..E-6 pass
- [ ] Nothing from Out of scope built
