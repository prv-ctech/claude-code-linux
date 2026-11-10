# 008: Remove caveman-mod: Evaluation

## Setup
From the worktree root. User checks use `C=${CLAUDE_CONFIG_DIR:-$HOME/.claude}`. Before running the removal script, save `python3 -c "import json;print(json.dumps(json.load(open('$C/settings.json')),sort_keys=True))" > /tmp/before-settings.json` (and same for `$C/plugins/installed_plugins.json` -> before-installed.json) in the scratchpad.

## Automated checks
- `for m in mods/*-mod; do claude plugin validate "$m" || exit 1; done` exits 0
- `node --test mods/oh-my-agent-mod/test/*.test.mjs mods/oh-my-context-mod/test/*.test.js mods/codebase-memory-mod/test/*.test.js && PYTHONPATH=mods/oh-my-context-mod/vendor python3 -m unittest discover -s mods/oh-my-context-mod/test -p 'test_*.py'` passes
- `node mods/oh-my-agent-mod/bin/oma cfg` prints valid JSON whose `test` has no `caveman`

## Acceptance checks

### E-1: repo clean (covers FR-1..FR-5)
- **Type**: CLI
- **Steps**: `test ! -e mods/caveman-mod && test ! -e .github/workflows/caveman-mod.yml && echo ok`; `python3 -c "import json;print([p['name'] for p in json.load(open('.claude-plugin/marketplace.json'))['plugins']])"`; `python3 -c "import re,subprocess;fs=subprocess.check_output(['git','ls-files']).decode().split();print([f for f in fs if not f.startswith('specs/tickets/') and re.search('caveman',f+open(f,errors='ignore').read(),re.I)])"`
- **Expected**: `ok`; list without `caveman-mod`, other 5 names present; `[]`.

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
- A new `claude -p "hi" --max-turns 1` session starts without plugin errors; `node mods/oh-my-context-mod/hooks/reply.js status` prints a reply mode.

## Traceability
| Requirement | Evals |
|---|---|
| FR-1..FR-5 | E-1, automated |
| FR-6 | E-2 |
| FR-7 | E-3 |
| FR-8 | E-4 |
| FR-9, FR-10 | E-5 |
| NFR-1 | E-6 |

## Definition of done
- [ ] All automated checks pass
- [ ] E-1..E-7 pass
- [ ] Nothing from Out of scope built
