# 009: Uninstall the old mod from the user's Claude Code: Evaluation

## Setup
From the worktree root. User checks use `C=${CLAUDE_CONFIG_DIR:-$HOME/.claude}`. Before running the removal script, save `python3 -c "import json;print(json.dumps(json.load(open('$C/settings.json')),sort_keys=True))" > /tmp/before-settings.json` (and same for `$C/plugins/installed_plugins.json` -> before-installed.json) in the scratchpad.

## Acceptance checks

### E-1: guard (covers FR-0)
- **Type**: CLI
- **Steps**: copy the script to the scratchpad; run it with `CLAUDE_CONFIG_DIR` pointed at a scratchpad copy of `C` whose installed_plugins.json names an oh-my-context-mod installPath without `output-styles/reply-ultra.md`.
- **Expected**: exit 1, the `stop:` line printed, no `backups/` dir created, all files in the copy unchanged (`diff -r` empty). Then on the real `C`: `ls <installPath>/output-styles/reply-ultra.md` exists before the real run.

### E-2: backups (covers FR-6)
- **Expected**: `ls $C/backups/remove-caveman-mod-*/` shows `settings.json`, `installed_plugins.json` (and `reply.json` if it existed); their content equals the before files.

### E-3: plugin gone (covers FR-7)
- **Expected**: `claude plugin list` (or installed_plugins.json) has no `caveman-mod@claude-code-linux`; settings.json `enabledPlugins` has no such key; `$C/plugins/cache/claude-code-linux/caveman-mod` and `$C/plugins/data/caveman-mod-claude-code-linux` do not exist.

### E-4: output style (covers FR-8)
- **Expected**: settings.json `outputStyle` is `oh-my-context-mod:reply-ultra` (reply mode on) or `Concise` (off); never `caveman-mod:ultracave`. reply.json `style.prev` is not `caveman-mod:ultracave`.

### E-5: leftovers (covers FR-9, FR-10)
- **Expected**: `$C/caveman-mod.json`, `$C/caveman-mod-fired`, `$C/plugins/data/caveman-mod-inline` do not exist; results.md holds the script output with one line per action.

### E-6: nothing else touched (covers NFR-1)
- **Steps**: compare before/after parsed JSON of settings.json and installed_plugins.json with the named keys removed from both.
- **Expected**: equal.

### E-7: idempotent (covers edge cases)
- **Steps**: run the script a second time.
- **Expected**: only `already gone:` lines (plus a new backup dir); exit 0; files unchanged.

## Regression checks
- A new `claude -p "hi" --max-turns 1` session starts without plugin errors; `node <installed oh-my-context-mod installPath>/hooks/reply.js status` prints a reply mode.

## Traceability
| Requirement | Evals |
|---|---|
| FR-0 | E-1 |
| FR-6 | E-2 |
| FR-7 | E-3 |
| FR-8 | E-4 |
| FR-9, FR-10 | E-5 |
| NFR-1 | E-6 |

## Definition of done
- [ ] E-1..E-7 pass
- [ ] Nothing from Out of scope built
