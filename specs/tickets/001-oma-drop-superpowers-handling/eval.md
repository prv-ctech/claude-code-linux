# 001: Remove all superpowers handling from /oma: Evaluation

## Setup
Run all commands from the project root of the worktree being checked. Nothing to install (`install` is `none` in `.oma/project.md`). Node 22 and the `claude` CLI must be on PATH. No server is needed (appType `cli`). Every check makes its own temp folders with `mktemp -d`, so checks can run in parallel copies.

## Automated checks
- `oma run lint` exits 0 (validates every mod manifest)
- `oma run test` exits 0, and the output includes the new test `session start never touches the user settings` passing
- `node --test mods/oh-my-agent-mod/test/*.test.mjs` exits 0 with `# fail 0`

## Acceptance checks

### E-1: No superpowers text left in the mod or its marketplace entry (covers FR-3, FR-5, FR-6, FR-7, FR-8, FR-9)
- **Type**: CLI
- **Steps**:
  1. Run:
     ```
     node -e "const fs=require('fs'),p=require('path');const re=/superpowers|withOmcLock|handOver|hand-over|oh-my-agent-mod\/state/i;const hits=[];const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory())walk(f);else if(re.test(fs.readFileSync(f,'utf8')))hits.push(f)}};walk('mods/oh-my-agent-mod');if(/superpowers/i.test(fs.readFileSync('.claude-plugin/marketplace.json','utf8')))hits.push('.claude-plugin/marketplace.json');console.log(hits.join('\n')||'clean');process.exit(hits.length?1:0)"
     ```
- **Expected**: prints exactly `clean` and exits 0.

### E-2: Removed functions are gone and paths() has no state key (covers FR-3)
- **Type**: CLI
- **Steps**:
  1. Run `node --input-type=module -e "const m=await import('./mods/oh-my-agent-mod/scripts/oma.mjs');console.log(['handOver','restoreSuperpowers','withOmcLock'].filter(k=>k in m).join(',')||'none');console.log(Object.keys(m.paths({CLAUDE_CONFIG_DIR:'/x',CLAUDE_PLUGIN_DATA:'/x/d'})).join(','))"`
- **Expected**: prints exactly two lines: `none` and `claude,settings,data,sessions`.

### E-3: restore-superpowers subcommand removed (covers FR-2)
- **Type**: CLI
- **Steps**:
  1. Run `node mods/oh-my-agent-mod/scripts/oma.mjs restore-superpowers; echo "exit=$?"`
  2. Run `node mods/oh-my-agent-mod/scripts/oma.mjs bogus; echo "exit=$?"`
- **Expected**: each prints `usage: oma.mjs <session|prompt|start|status> [--dir <project>]` (on stderr) followed by `exit=2`. Nothing else is printed on stdout.

### E-4: Session start never touches the user settings (covers FR-1)
- **Type**: CLI
- **Steps**:
  1. Run:
     ```
     H=$(mktemp -d); printf '{\n  "enabledPlugins": {"oh-my-agent-mod@claude-code-linux": true, "superpowers@superpowers-dev": true}\n}\n' > "$H/settings.json"; cp "$H/settings.json" "$H/before.json"
     echo '{"session_id":"s1","source":"startup"}' | CLAUDE_CONFIG_DIR="$H" CLAUDE_PLUGIN_DATA="$H/data" node mods/oh-my-agent-mod/scripts/oma.mjs session; echo; echo "exit=$?"
     cmp "$H/settings.json" "$H/before.json" && echo same; ls "$H"
     ```
- **Expected**:
  - The first line is exactly `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"oh-my-agent: /oma <what to build> runs the superagent (router, workers in worktrees, tester, reviewer, merger, checker)."}}`
  - then `exit=0`
  - then `same`
  - and `ls` lists only `before.json`, `settings.json` and possibly `data`. There is no `oh-my-agent-mod` entry.

### E-5: Broken settings file does not matter (covers FR-1, edge case)
- **Type**: CLI
- **Steps**:
  1. Run `H=$(mktemp -d); printf '{ broken' > "$H/settings.json"; echo '{"session_id":"s2","source":"startup"}' | CLAUDE_CONFIG_DIR="$H" CLAUDE_PLUGIN_DATA="$H/data" node mods/oh-my-agent-mod/scripts/oma.mjs session; echo; cat "$H/settings.json"; echo`
- **Expected**:
  - The first line contains `runs the superagent` and does not contain `could not check`.
  - The last line is exactly `{ broken`.

### E-6: /oma restore-superpowers no longer passes through the prompt hook (covers FR-4)
- **Type**: CLI
- **Steps**:
  1. Run `node --input-type=module -e "const fs=await import('node:fs');const os=await import('node:os');const m=await import('./mods/oh-my-agent-mod/scripts/oma.mjs');const d=fs.mkdtempSync(os.tmpdir()+'/oma-');const p=m.paths({CLAUDE_CONFIG_DIR:d,CLAUDE_PLUGIN_DATA:d+'/data'});m.onPrompt(p,{session_id:'S',prompt:'/oma status'});console.log(JSON.stringify(m.onPrompt(p,{session_id:'S',prompt:'next'})));m.onPrompt(p,{session_id:'R',prompt:'/oma restore-superpowers',permission_mode:'auto'});console.log(/router mode is on/.test(m.onPrompt(p,{session_id:'R',prompt:'next'})))"`
- **Expected**: prints exactly `null` and then `true`. `/oma status` still passes through, and `restore-superpowers` is no longer special.

### E-7: Command file (covers FR-5)
- **Type**: CLI
- **Steps**:
  1. Run `sed -n 3p mods/oh-my-agent-mod/commands/oma.md`
  2. Run `node -e "const t=require('fs').readFileSync('mods/oh-my-agent-mod/commands/oma.md','utf8');console.log(['- \`off\` (or \`stop\`):','- \`status\`: run','Anything else (no arguments'].every(s=>t.includes(s)))"`
- **Expected**: step 1 prints exactly `argument-hint: "[what to build | status | off]"`, and step 2 prints `true`.

### E-8: plugin.json (covers FR-6, NFR-2)
- **Type**: CLI
- **Steps**:
  1. Run `node -e "const j=require('./mods/oh-my-agent-mod/.claude-plugin/plugin.json');console.log(j.version);console.log(Object.keys(j.userConfig).join(','));console.log(j.description.endsWith('Sets each project up on first /oma and works alongside oh-my-context (omc).'))"`
  2. Run `claude plugin validate mods/oh-my-agent-mod; echo "exit=$?"`
- **Expected**:
  - Step 1 prints exactly three lines: `0.2.0`, `review_tickets`, `true`.
  - Step 2 ends with `exit=0`.

### E-9: Marketplace description (covers FR-7)
- **Type**: CLI
- **Steps**:
  1. Run `node -e "const m=require('./.claude-plugin/marketplace.json');const e=m.plugins.find(x=>x.name==='oh-my-agent-mod');console.log(e.description.endsWith('Sets each project up on first /oma, works alongside oh-my-context.'))"`
  2. Run `git diff --stat main -- .claude-plugin/marketplace.json`
- **Expected**:
  - Step 1 prints `true`.
  - Step 2 shows `1 file changed, 1 insertion(+), 1 deletion(-)`, so only that one description line changed.

### E-10: README (covers FR-8)
- **Type**: CLI
- **Steps**:
  1. Run `node -e "const t=require('fs').readFileSync('mods/oh-my-agent-mod/README.md','utf8');console.log(t.includes('Its disciplines live inside the agents (test first, root cause before fixes, no claim without fresh evidence, independent review), and it works alongside oh-my-context (\`/omc\`):'));console.log(t.includes(\"- The only settings it edits: the project's git-ignored \`.claude/settings.local.json\`.\"));console.log(t.includes('| Review tickets before building |'));console.log(t.split('## Settings')[1].split('## Safety')[0].split('\n').filter(l=>l.startsWith('| ')).length)"`
- **Expected**: prints exactly `true`, `true`, `true`, `2`. The Settings table is left with its header row and the single Review tickets row.

### E-11: New regression test exists (covers FR-9)
- **Type**: CLI
- **Steps**:
  1. Run `node --test --test-name-pattern='session start never touches the user settings' mods/oh-my-agent-mod/test/oma.test.mjs`
- **Expected**: exits 0 with `# pass 1` and `# fail 0`.

## Edge case checks
E-5 covers the broken settings file. E-4 covers a settings file that still lists superpowers (left as it is). E-6 covers `/oma restore-superpowers` typed after the update.

## Regression checks
- E-12 (covers NFR-1): `node --test mods/oh-my-agent-mod/test/*.test.mjs` exits 0. The tests `/oma turns router mode on for its session only…`, `bootstrap sets a project up once…`, `bootstrap reads the board…` and all `oma status/run/serve` tests are listed as passing.
- E-13 (covers NFR-1): `node mods/oh-my-agent-mod/scripts/oma.mjs status --dir .` exits 0 and prints JSON whose `"ok"` is `true`.
- E-14 (covers NFR-1): `H=$(mktemp -d); echo '{"session_id":"z","source":"compact"}' | CLAUDE_CONFIG_DIR="$H" CLAUDE_PLUGIN_DATA="$H/data" node mods/oh-my-agent-mod/scripts/oma.mjs session; echo "exit=$?"` prints only `exit=0`. The session is not in router mode, so there is no hint and no reminder.

## Traceability
| Requirement | Evals |
|-------------|-------|
| FR-1        | E-4, E-5 |
| FR-2        | E-3 |
| FR-3        | E-1, E-2 |
| FR-4        | E-6 |
| FR-5        | E-1, E-7 |
| FR-6        | E-1, E-8 |
| FR-7        | E-1, E-9 |
| FR-8        | E-1, E-10 |
| FR-9        | E-1, E-11 |
| NFR-1       | E-12, E-13, E-14 |
| NFR-2       | E-8 |

## Definition of done
- [ ] All automated checks pass
- [ ] All acceptance checks E-1…E-14 pass
- [ ] No items from "Out of scope" were built
