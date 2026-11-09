# 002: oh-my-agent works with codebase-memory-mod's code-search gate: Evaluation

## Setup
Run every command from the project root of the checkout being checked. Nothing to install (`install` is `none`), no server (appType `cli`). Node 22 and git must be on PATH.

These checks may run in the main checkout, where codebase-memory-mod's gate blocks `grep`/`find` as commands, so they use `node` for every text check. Each check builds its own temp folders with `mktemp -d`; none touches the real `~/.claude` or `~/.cache`.

Shared fixture, run once in the shell before E-1 to E-4 (all later commands assume `$T`, `$P`, `$E` are set in the same shell):
```
T=$(mktemp -d); mkdir -p "$T/cfg" "$T/cache" "$T/proj/.codebase-memory"
git -C "$T/proj" init -q && git -C "$T/proj" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
: > "$T/proj/.codebase-memory/graph.db.zst"
printf '{"enabledPlugins":{"codebase-memory-mod@claude-code-linux":true}}' > "$T/cfg/settings.json"
P=$(cd "$T/proj" && pwd -P)
E="CLAUDE_CONFIG_DIR=$T/cfg XDG_CACHE_HOME=$T/cache"
```

## Automated checks
- `oma run lint` exits 0
- `oma run test` exits 0 with `# fail 0` and Python `OK`, including the new file `mods/oh-my-agent-mod/test/codegraph.test.mjs`, which must cover: each `reason` value of `codeGraph()`, the settings precedence (user true, local false gives `"plugin not enabled"`), invalid JSON skipped, the project name rule, the three `subagent` hook outputs and its silence for non-oma agents and bad input
- `node --test mods/oh-my-agent-mod/test/*.test.mjs` exits 0 with `# fail 0`, and `scripts.test.mjs` includes the FR-6 table cases

## Acceptance checks

### E-1: status reports an active graph with the right project name (covers FR-1, FR-2, FR-3)
- **Type**: CLI
- **Steps**:
  1. `env $E node mods/oh-my-agent-mod/scripts/oma.mjs status --dir "$P" | node -e "const s=JSON.parse(require('fs').readFileSync(0,'utf8'));const g=s.codeGraph;console.log(g.active, g.reason, g.project===process.argv[1].replace(/\//g,'-').replace(/^-+/,''))" "$P"`
- **Expected**: prints exactly `true on true`.

### E-2: each inactive reason (covers FR-1, FR-2, FR-3)
- **Type**: CLI
- **Steps**:
  1. Define `cg() { env $E node mods/oh-my-agent-mod/scripts/oma.mjs status --dir "$P" | node -e "const g=JSON.parse(require('fs').readFileSync(0,'utf8')).codeGraph;console.log(g.active+'|'+g.reason+'|'+g.project)"; }`
  2. `mkdir -p "$T/cache/codebase-memory-mcp" && : > "$T/cache/codebase-memory-mcp/gate-off" && cg && rm "$T/cache/codebase-memory-mcp/gate-off"`
  3. `mv "$P/.codebase-memory/graph.db.zst" "$T/g" && cg && mv "$T/g" "$P/.codebase-memory/graph.db.zst"`
  4. `mkdir -p "$P/.claude" && printf '{"enabledPlugins":{"codebase-memory-mod@claude-code-linux":false}}' > "$P/.claude/settings.local.json" && cg && rm "$P/.claude/settings.local.json"`
  5. `printf '{not json' > "$P/.claude/settings.json" && cg && rm "$P/.claude/settings.json"`
- **Expected**: step 2 prints `false|gate off|null`; step 3 prints `false|no graph|null`; step 4 prints `false|plugin not enabled|null`; step 5 prints a line that starts with `true|on|` and ends with `-proj` (the broken project file is skipped, the user settings decide).

### E-3: SubagentStart hook text for oma agents (covers FR-4)
- **Type**: CLI
- **Steps**:
  1. `sa() { printf '{"hook_event_name":"SubagentStart","agent_type":"%s","cwd":"%s"}' "$1" "$P" | env $E node mods/oh-my-agent-mod/scripts/oma.mjs subagent; r=$?; echo; echo "exit=$r"; }`
  2. `sa oh-my-agent-mod:worker | node -e "const [j]=require('fs').readFileSync(0,'utf8').split('\n');const o=JSON.parse(j).hookSpecificOutput;const t=o.additionalContext;console.log(o.hookEventName, t.startsWith('oh-my-agent code search: codebase-memory-mod is on and '+process.argv[1]+' has a graph'), t.includes('with project \"'+process.argv[1].replace(/\//g,'-').replace(/^-+/,'')+'\"'), t.includes('A worktree under .claude/worktrees/ has no graph of its own'))" "$P"`
  3. `mv "$P/.codebase-memory/graph.db.zst" "$T/g"; sa oh-my-agent-mod:merger | node -e "const [j]=require('fs').readFileSync(0,'utf8').split('\n');console.log(JSON.parse(j).hookSpecificOutput.additionalContext==='oh-my-agent code search: codebase-memory-mod is on but no graph applies in '+process.argv[1]+' (no graph), so Grep, Glob and grep work as usual here.')" "$P"; mv "$T/g" "$P/.codebase-memory/graph.db.zst"`
- **Expected**: step 2 prints exactly `SubagentStart true true true`. Step 3 prints exactly `true`.

### E-4: hook stays silent where it should (covers FR-4, FR-5)
- **Type**: CLI
- **Steps**:
  1. `sa general-purpose` (function from E-3)
  2. `printf '{"hook_event_name":"SubagentStart","cwd":"%s"}' "$P" | env $E node mods/oh-my-agent-mod/scripts/oma.mjs subagent; echo "exit=$?"`
  3. `printf 'not json' | env $E node mods/oh-my-agent-mod/scripts/oma.mjs subagent; echo "exit=$?"`
  4. `printf '{"enabledPlugins":{}}' > "$T/cfg/settings.json"; sa oh-my-agent-mod:worker; printf '{"enabledPlugins":{"codebase-memory-mod@claude-code-linux":true}}' > "$T/cfg/settings.json"`
- **Expected**: step 1 prints an empty line then `exit=0`; steps 2 and 3 print only `exit=0`; step 4 prints an empty line then `exit=0`.

### E-5: hooks.json wiring (covers FR-4, FR-6)
- **Type**: CLI
- **Steps**:
  1. `node -e "const h=require('./mods/oh-my-agent-mod/hooks/hooks.json').hooks;const s=(h.SubagentStart||[]).find(e=>e.matcher==='*'&&e.hooks.some(x=>/oma\.mjs\\\" subagent$/.test(x.command)));const g=h.PreToolUse.find(e=>e.hooks.some(x=>x.command.includes('guard.mjs')));console.log(!!s, new RegExp('^('+g.matcher+')$').test('mcp__plugin_codebase-memory-mod_codebase-memory-mcp__search_code'), new RegExp('^('+g.matcher+')$').test('Grep'))"`
- **Expected**: prints exactly `true true true`.

### E-6: guard covers the graph tools for env files (covers FR-6)
- **Type**: CLI
- **Steps**:
  1. Run:
     ```
     node --input-type=module -e "
     import { decide } from './mods/oh-my-agent-mod/scripts/guard.mjs';
     const X='mcp__plugin_codebase-memory-mod_codebase-memory-mcp__';
     const c=(agent_type,t,ti)=>decide({agent_type,tool_name:X+t,tool_input:ti})?'deny':'allow';
     const W='oh-my-agent-mod:worker';
     console.log([
       c(W,'search_code',{project:'p',pattern:'KEY',file_pattern:'.env*'}),
       c(W,'search_code',{project:'p',pattern:'KEY',path_filter:'config/.env'}),
       c(W,'search_code',{project:'p',pattern:'KEY',file_pattern:'*.env'}),
       c(W,'get_file_outline',{project:'p',file_path:'deploy/.env.production'}),
       c(W,'search_code',{project:'p',pattern:'KEY',file_pattern:'*.ts'}),
       c(W,'search_code',{project:'p',pattern:'KEY',file_pattern:'.env.example'}),
       c(W,'search_graph',{project:'p',name_pattern:'env'}),
       c(W,'get_file_outline',{project:'p',file_path:'src/environment.ts'}),
       c(undefined,'search_code',{project:'p',pattern:'KEY',file_pattern:'.env*'}),
       c('other:agent','get_file_outline',{project:'p',file_path:'.env'}),
       c(W,'search_code',undefined),
     ].join(' '));
     console.log(decide({agent_type:W,tool_name:X+'search_code',tool_input:{project:'p',pattern:'K',file_pattern:'.env*'}}));"
     ```
- **Expected**: first line exactly `deny deny deny deny allow allow allow allow allow allow allow`; second line exactly `oh-my-agent agents never read .env files.`

### E-7: guard leaves code search to codebase-memory (covers FR-7)
- **Type**: CLI
- **Steps**:
  1. `cd "$P" && node --input-type=module -e "const {decide}=await import(process.argv[1]);const W='oh-my-agent-mod:worker';console.log([decide({agent_type:W,tool_name:'Grep',tool_input:{pattern:'foo',path:'src'}}),decide({agent_type:W,tool_name:'Glob',tool_input:{pattern:'**/*.ts'}}),decide({agent_type:W,tool_name:'Bash',tool_input:{command:'grep -rn foo src'}}),decide({agent_type:W,tool_name:'Bash',tool_input:{command:'find . -name \"*.ts\"'}})].map(String).join(' '))" "$OLDPWD/mods/oh-my-agent-mod/scripts/guard.mjs"; cd "$OLDPWD"`
- **Expected**: prints exactly `null null null null` (run inside a folder that has a graph).

### E-8: merger uses git diff --check (covers FR-8)
- **Type**: CLI
- **Steps**:
  1. `node -e "const t=require('fs').readFileSync('mods/oh-my-agent-mod/agents/merger.md','utf8');console.log(t.includes('git diff --check -- <files>'), /grep -rn/.test(t))"`
  2. Behaviour of the command it names: `M=$(mktemp -d) && cd "$M" && git init -q -b main && git config user.email t@t && git config user.name t && echo a > f && git add f && git commit -qm a && git checkout -qb b && echo b > f && git commit -qam b && git checkout -q main && echo c > f && git commit -qam c; git merge b >/dev/null 2>&1; git diff --check -- f >/dev/null; echo "markers=$?"; echo ok > f; git diff --check -- f; echo "clean=$?"; cd "$OLDPWD"`
- **Expected**: step 1 prints exactly `true false`; step 2 prints `markers=2` then `clean=0`.

### E-9: no oma instruction runs a gated search command (covers FR-9)
- **Type**: CLI
- **Steps**:
  1. Run:
     ```
     node -e "
     const fs=require('fs'),p=require('path');const {CODE_SEARCH}=require('./mods/codebase-memory-mod/hooks/gate.js');
     const d='mods/oh-my-agent-mod';const files=[...fs.readdirSync(d+'/agents').map(f=>d+'/agents/'+f),d+'/router.md',d+'/commands/oma.md'];
     const hits=[];for(const f of files){const t=fs.readFileSync(f,'utf8');let fence=false;
       for(const [i,l] of t.split('\n').entries()){if(/^\s*\`\`\`/.test(l)){fence=!fence;continue}
         const spans=fence?[l]:[...l.matchAll(/\`([^\`]+)\`/g)].map(m=>m[1]);
         for(const s of spans) if(/\s/.test(s.trim())&&CODE_SEARCH.test(s)) hits.push(f+':'+(i+1)+': '+s)}}
     console.log(hits.join('\n')||'clean');process.exit(hits.length?1:0)"
     ```
- **Expected**: prints exactly `clean` and exits 0.

### E-10: README section and version (covers FR-10, FR-11)
- **Type**: CLI
- **Steps**:
  1. `node -e "const L=require('fs').readFileSync('mods/oh-my-agent-mod/README.md','utf8').split('\n');const i=L.indexOf('## With codebase-memory-mod');const rest=i<0?[]:L.slice(i+1);const e=rest.findIndex(l=>l.startsWith('## '));const body=(e<0?rest:rest.slice(0,e)).filter(l=>l.trim());const b=body.join(' ');console.log(i>=0, body.length>=3&&body.length<=6, b.includes('.codebase-memory')&&b.includes('.env')&&/worktree/i.test(b));console.log(require('./mods/oh-my-agent-mod/.claude-plugin/plugin.json').version)"`
- **Expected**: prints exactly `true true true` then `0.3.0`.

## Edge case checks

### E-11: other marketplace key and missing cwd (covers edge cases, FR-2, FR-4)
- **Type**: CLI
- **Steps**:
  1. `printf '{"enabledPlugins":{"codebase-memory-mod@other-market":true}}' > "$T/cfg/settings.json"; env $E node mods/oh-my-agent-mod/scripts/oma.mjs status --dir "$P" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).codeGraph.reason)"; printf '{"enabledPlugins":{"codebase-memory-mod@claude-code-linux":true}}' > "$T/cfg/settings.json"`
  2. `cd "$P" && printf '{"hook_event_name":"SubagentStart","agent_type":"oh-my-agent-mod:tester"}' | env $E node "$OLDPWD/mods/oh-my-agent-mod/scripts/oma.mjs" subagent | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).hookSpecificOutput.additionalContext.includes(' and '+process.argv[1]+' has a graph'))" "$P"; cd "$OLDPWD"`
- **Expected**: step 1 prints `on`; step 2 prints `true`.

## Regression checks
- Existing guard behaviour holds: the `guard denies git push and env files for oma agents only` and `guard hook prints a PreToolUse deny and nothing otherwise` tests in `mods/oh-my-agent-mod/test/scripts.test.mjs` still pass (part of `oma run test`).
- Core flow 3: `node mods/oh-my-agent-mod/scripts/oma.mjs status --dir .` prints JSON with `"ok": true` and exits 0, now also with a `codeGraph` key.
- Core flow 4: `node mods/oh-my-agent-mod/bin/oma cfg` prints the profile JSON and exits 0.
- Session and prompt hooks unchanged: `printf '{"session_id":"s1","source":"startup"}' | node mods/oh-my-agent-mod/scripts/oma.mjs session` prints a SessionStart JSON whose additionalContext starts with `oh-my-agent: /oma <what to build>`.
- `git diff --stat <base>...HEAD -- mods/codebase-memory-mod mods/caveman-mod` prints nothing.

## Traceability
| Requirement | Evals |
|-------------|-------|
| FR-1        | E-1, E-2 |
| FR-2        | E-1, E-2, E-11 |
| FR-3        | E-1, E-2 |
| FR-4        | E-3, E-4, E-5, E-11 |
| FR-5        | E-4 |
| FR-6        | E-5, E-6 |
| FR-7        | E-7 |
| FR-8        | E-8 |
| FR-9        | E-9 |
| FR-10       | E-10 |
| FR-11       | E-10 |
| NFR-1       | E-3 (hook answers; code review: no git or network calls in the `subagent` path) |
| NFR-2       | E-4 |
| NFR-3       | Automated checks (tests use `fs.mkdtempSync` homes; reviewer confirms) |

## Definition of done
- [ ] All automated checks pass
- [ ] All acceptance checks E-1…E-11 pass
- [ ] No items from "Out of scope" were built
