# 010: /omc is the only oh-my-context-mod command: Evaluation

## Setup
From the project root. No install, no app to start (`start` is `none`).

## Automated checks
- `for m in mods/*-mod; do claude plugin validate "$m" || exit 1; done` exits 0
- `node --test mods/oh-my-agent-mod/test/*.test.mjs mods/oh-my-context-mod/test/*.test.js mods/codebase-memory-mod/test/*.test.js && PYTHONPATH=mods/oh-my-context-mod/vendor python3 -m unittest discover -s mods/oh-my-context-mod/test -p 'test_*.py'` exits 0

## Acceptance checks

### E-1: only omc.md (covers FR-1)
- **Type**: CLI
- **Steps**: `ls mods/oh-my-context-mod/commands`
- **Expected**: output is exactly `omc.md`.

### E-2: body unchanged (covers FR-2)
- **Type**: CLI
- **Steps**: `diff <(git show 6265db6:mods/oh-my-context-mod/commands/omc.md | tail -n +3) <(tail -n +3 mods/oh-my-context-mod/commands/omc.md)`
- **Expected**: no output, exit 0 (argument-hint line and whole body identical).

### E-3: standalone description (covers FR-3)
- **Type**: CLI
- **Steps**: `sed -n 2p mods/oh-my-context-mod/commands/omc.md`
- **Expected**: `description: Show which MCP servers and skills run behind oh-my-context, or turn the mod on or off`

### E-4: no command hint left (covers FR-4)
- **Type**: CLI
- **Steps**: `git ls-files mods/oh-my-context-mod .claude-plugin | xargs grep -nE '/oh-my-context-mod([^-/a-z]|$)'`, then `git ls-files mods/oh-my-context-mod .claude-plugin | xargs grep -n 'Short for'`
- **Expected**: both print nothing.

### E-5: hints say /omc (covers FR-4)
- **Type**: CLI
- **Steps**:
  1. `grep -c '/omc on routes them again' mods/oh-my-context-mod/hooks/sync.js`
  2. `grep -c '(/omc status)' mods/oh-my-context-mod/hooks/sync.js`
  3. `node -e "const p=require('./mods/oh-my-context-mod/.claude-plugin/plugin.json');console.log(p.description.includes('/omc'), p.userConfig.direct_servers.description.includes('/omc'))"`
  4. `node -e "const m=require('./.claude-plugin/marketplace.json');console.log(m.plugins.find(x=>x.name==='oh-my-context-mod').description.includes('/omc'))"`
- **Expected**: `1`, `1`, `true true`, `true`.

### E-6: plugin-name paths kept (covers FR-4)
- **Type**: CLI
- **Steps**: `grep -c 'oh-my-context-mod-claude-code-linux' mods/oh-my-context-mod/bin/oh-my-context`
- **Expected**: `1`.

### E-7: version (covers FR-5)
- **Type**: CLI
- **Steps**: `node -p "require('./mods/oh-my-context-mod/.claude-plugin/plugin.json').version"`
- **Expected**: `0.7.2`

### E-8: test updated (covers FR-6)
- **Type**: CLI
- **Steps**: `grep -c "ask('/omc status please'), null" mods/oh-my-context-mod/test/hooks.test.js`
- **Expected**: `1`. (E-4 already proves no test still names the old command.)

### E-9: validate and full tests (covers FR-7, NFR-1)
- **Type**: CLI
- **Steps**: `claude plugin validate mods/oh-my-context-mod`, then the full test command above
- **Expected**: both exit 0; `naming.test.js` passes.

## Edge case checks
### E-10: no path reference to removed file (covers edge cases)
- **Type**: CLI
- **Steps**: `git ls-files mods .claude-plugin | xargs grep -n 'oh-my-context-mod\.md'`
- **Expected**: no output.

## Regression checks
- E-2 confirms subcommand routing in omc.md is unchanged; the full test run covers sync.js, reply.js, doc.js and the gateway.

## Traceability
| Requirement | Evals |
|-------------|-------|
| FR-1 | E-1 |
| FR-2 | E-2 |
| FR-3 | E-3 |
| FR-4 | E-4, E-5, E-6 |
| FR-5 | E-7 |
| FR-6 | E-8 |
| FR-7 | E-9 |
| NFR-1 | E-9 |

## Definition of done
- [ ] All automated checks pass
- [ ] All acceptance checks E-1…E-10 pass
- [ ] No items from "Out of scope" were built
