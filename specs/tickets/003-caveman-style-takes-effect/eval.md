# 003: Caveman style really changes how Claude replies: Evaluation

## Setup
Run every command from the project root of the checkout being checked. Nothing to install (`install` is `none`), no server (appType `cli`). Node 22 and git on PATH.

The live check (E-2, E-3) also needs the `claude` CLI on PATH and logged in, network access, and caveman on in the user's config (`~/.claude/caveman-mod.json` has no `"enabled": false`). Check first: `claude auth status` prints JSON with `"loggedIn": true`. If it does not, E-2 and E-3 are `FAIL | check not runnable: claude CLI not logged in`.

These checks may run in the main checkout, where codebase-memory-mod blocks `grep`/`find` as commands, so text checks use `node`. Offline checks build their own temp config folder with `mktemp -d`.

## Automated checks
- `oma run lint` exits 0
- `oma run test` exits 0 with `# fail 0` and Python `OK`; `mods/caveman-mod/test/ultracave.test.js` has a test for every code change made in this ticket (FR-6)
- `node --test mods/caveman-mod/test/*.test.js` exits 0 with `# fail 0` and does not run `live.mjs`

## Acceptance checks

### E-1: Root cause written with evidence (covers FR-1)
- **Type**: CLI
- **Steps**:
  1. Run:
     ```
     node -e "
     const t=require('fs').readFileSync('specs/tickets/003-caveman-style-takes-effect/results.md','utf8');
     const i=t.indexOf('## Root cause');const rest=i<0?'':t.slice(i);const end=rest.slice(3).search(/\n## /);const body=end<0?rest:rest.slice(0,end+3);
     const heads=['### Does the CLI load the style','### Do the hook rules reach the model in a Desktop session','### Which output style Desktop sessions actually run with','### Does the model follow the rules when they arrive'];
     const secrets=/sk-ant-[A-Za-z0-9_-]{8,}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
     console.log(i>=0, heads.every(h=>body.includes(h)), heads.every(h=>{const s=body.slice(body.indexOf(h)+h.length).split(/\n### /)[0];return s.trim().split('\n').filter(Boolean).length>=3}), !secrets.test(body))"
     ```
- **Expected**: prints exactly `true true true true` (section present, all four subsections present, each with an answer plus evidence lines, no token, e-mail address or UUID in it).

### E-2: Live check passes with caveman on (covers FR-2, FR-3, FR-4, NFR-1, NFR-2)
- **Type**: CLI
- **Steps**:
  1. `C=${CLAUDE_CONFIG_DIR:-$HOME/.claude}; sha256sum "$C/settings.json" "$C/caveman-mod.json" > /tmp/oma-t003-before.sha`
  2. `time node mods/caveman-mod/test/live.mjs; echo "exit=$?"`
  3. `sha256sum -c /tmp/oma-t003-before.sha`
- **Expected**:
  - Step 2 prints `PASS A init output_style=caveman-mod:ultracave`, `PASS B init output_style=default`, six lines `PASS A P1 ...` through `PASS B P3 ...` each with a ratio of at most `4.0%`, one line `PASS C control filler=.../... (...)` with a ratio of at least `6.0%`, then `RESULT: PASS` and `exit=0`. No line starts with `FAIL` or `SKIP:`. `real` time under `10m`.
  - Step 3 prints `OK` for both files.
  - Nothing printed in step 2 matches a token (`sk-ant-`), an e-mail address or a UUID.

### E-3: Live check is stable (covers FR-3, FR-4)
- **Type**: CLI
- **Steps**:
  1. Run `node mods/caveman-mod/test/live.mjs | tail -n 1` a second time, right after E-2.
- **Expected**: prints `RESULT: PASS`.

### E-4: Live check skips when caveman is off or the CLI is missing (covers FR-2, edge cases)
- **Type**: CLI
- **Steps**:
  1. `T=$(mktemp -d); printf '{"enabled":false}' > "$T/caveman-mod.json"; CLAUDE_CONFIG_DIR=$T node mods/caveman-mod/test/live.mjs; echo "exit=$?"`
  2. `N=$(command -v node); PATH=/nonexistent "$N" mods/caveman-mod/test/live.mjs; echo "exit=$?"`
- **Expected**: step 1 prints one line starting `SKIP:` that contains `/caveman on`, then `exit=2`, and makes no model call (finishes in under 5 seconds). Step 2 prints one line starting `SKIP:` then `exit=2`.

### E-5: Off turns everything off, on brings it back (covers FR-5)
- **Type**: CLI
- **Steps**:
  1. `T=$(mktemp -d); printf '{"outputStyle":"Concise"}' > "$T/settings.json"; H=mods/caveman-mod/hooks/ultracave.js`
  2. `CLAUDE_CONFIG_DIR=$T node $H on >/dev/null; for m in session prompt subagent; do printf '{}' | CLAUDE_CONFIG_DIR=$T node $H $m | node -e "const o=JSON.parse(require('fs').readFileSync(0,'utf8')).hookSpecificOutput;console.log('$m', /CAVEMAN/.test(o.additionalContext))"; done`
  3. `CLAUDE_CONFIG_DIR=$T node $H off >/dev/null; for m in session prompt subagent; do printf '{}' | CLAUDE_CONFIG_DIR=$T node $H $m | wc -c; done; node -e "console.log(JSON.parse(require('fs').readFileSync('$T/settings.json','utf8')).outputStyle)"; ls -A "$T/output-styles" 2>/dev/null | wc -l`
- **Expected**: step 2 prints `session true`, `prompt true`, `subagent true`. Step 3 prints `0` three times, then `Concise`, then `0` (no style file left behind, whether or not the fix adds one).

### E-6: Version and texts (covers FR-7, NFR-4)
- **Type**: CLI
- **Steps**:
  1. `node -e "const v=require('./mods/caveman-mod/.claude-plugin/plugin.json').version.split('.').map(Number);console.log(v[0]>0||v[1]>4||(v[1]===4&&v[2]>0))"`
  2. `T=$(mktemp -d); printf '{}' | CLAUDE_CONFIG_DIR=$T node mods/caveman-mod/hooks/ultracave.js prompt | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).hookSpecificOutput.additionalContext.length<=600)"`
- **Expected**: step 1 prints `true`; step 2 prints `true`.

## Edge case checks

### E-7: Hooks never break a session (covers NFR-4, edge cases)
- **Type**: CLI
- **Steps**:
  1. `T=$(mktemp -d); printf '{broken' > "$T/settings.json"; printf '{}' | CLAUDE_CONFIG_DIR=$T node mods/caveman-mod/hooks/ultracave.js session | node -e "console.log(/CAVEMAN/.test(JSON.parse(require('fs').readFileSync(0,'utf8')).hookSpecificOutput.additionalContext))"; echo "exit=$?"; node -e "console.log(require('fs').readFileSync('$T/settings.json','utf8'))"`
- **Expected**: prints `true`, `exit=0`, then `{broken` (the unreadable file is left as it was).

## Regression checks
- Existing tests in `mods/caveman-mod/test/ultracave.test.js` still pass (part of `oma run test`): first session switches the style once; off restores the previous style; a style the user picked later is left alone.
- `node mods/caveman-mod/hooks/ultracave.js status` with a temp `CLAUDE_CONFIG_DIR` exits 0 and prints a first line starting `caveman: ON`.
- Subagents still get the full rules: `printf '{}' | CLAUDE_CONFIG_DIR=$(mktemp -d) node mods/caveman-mod/hooks/ultracave.js subagent` prints a SubagentStart JSON whose additionalContext starts with `CAVEMAN ULTRACAVE`.
- `git diff --stat <base>...HEAD -- mods/oh-my-agent-mod mods/codebase-memory-mod mods/oh-my-context-mod` prints nothing.

## Traceability
| Requirement | Evals |
|-------------|-------|
| FR-1        | E-1 |
| FR-2        | E-2, E-4 |
| FR-3        | E-2, E-3 |
| FR-4        | E-2, E-3, E-5 |
| FR-5        | E-5 |
| FR-6        | Automated checks |
| FR-7        | E-6 |
| NFR-1       | E-2 |
| NFR-2       | E-2 |
| NFR-3       | Automated checks |
| NFR-4       | E-6, E-7 |

## Definition of done
- [ ] All automated checks pass
- [ ] All acceptance checks E-1…E-7 pass
- [ ] No items from "Out of scope" were built
