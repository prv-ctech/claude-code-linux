# 008: Remove caveman-mod from the repo: Evaluation

## Setup
From the worktree root. No user config needed.

## Automated checks
- `for m in mods/*-mod; do claude plugin validate "$m" || exit 1; done` exits 0
- `node --test mods/oh-my-agent-mod/test/*.test.mjs mods/oh-my-context-mod/test/*.test.js mods/codebase-memory-mod/test/*.test.js && PYTHONPATH=mods/oh-my-context-mod/vendor python3 -m unittest discover -s mods/oh-my-context-mod/test -p 'test_*.py'` passes
- `node mods/oh-my-agent-mod/bin/oma cfg` prints valid JSON whose `test` has no `caveman`

## Acceptance checks

### E-1: repo clean (covers FR-1..FR-5)
- **Type**: CLI
- **Steps**: `test ! -e mods/caveman-mod && test ! -e .github/workflows/caveman-mod.yml && echo ok`; `python3 -c "import json;print([p['name'] for p in json.load(open('.claude-plugin/marketplace.json'))['plugins']])"`; `python3 -c "import re,subprocess;fs=subprocess.check_output(['git','ls-files']).decode().split();print([f for f in fs if not f.startswith('specs/tickets/') and re.search('caveman',f+open(f,errors='ignore').read(),re.I)])"`
- **Expected**: `ok`; list without `caveman-mod`, other 5 names present; `[]`.

## Regression checks
- `git status` after the work shows no change outside the repo paths named in rd.md; nothing under `/config/.claude` was written by the worker.

## Traceability
| Requirement | Evals |
|---|---|
| FR-1..FR-5 | E-1, automated |

## Definition of done
- [ ] All automated checks pass
- [ ] E-1 passes
- [ ] Nothing from Out of scope built
