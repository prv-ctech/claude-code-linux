# 002-oma-codebase-memory-compat results

A-1 | PASS | oma run lint exit 0, all mods "Validation passed"
A-2 | PASS | oma run test exit 0: node --test 88 pass, # fail 0; Python OK; codegraph.test.mjs runs 4 tests
A-3 | PASS | node --test mods/oh-my-agent-mod/test/*.test.mjs: 20 pass, # fail 0, FR-6 table in scripts.test.mjs
E-1 | PASS | printed "true on true"
E-2 | PASS | "false|gate off|null", "false|no graph|null", "false|plugin not enabled|null", "true|on|...-proj"
E-3 | PASS | step 2 "SubagentStart true true true"; step 3 "true"
E-4 | PASS | empty line + exit=0; exit=0; exit=0; empty line + exit=0
E-5 | PASS | "true true true"
E-6 | PASS | "deny deny deny deny allow allow allow allow allow allow allow" / "oh-my-agent agents never read .env files."
E-7 | PASS | "null null null null"
E-8 | PASS | "true false"; "markers=2" "clean=0"
E-9 | PASS | "clean", exit 0
E-10 | PASS | "true true true", "0.3.0"
E-11 | PASS | "on"; "true"
R-1 | PASS | existing guard tests pass inside oma run test (# fail 0)
R-2 | PASS | oma.mjs status --dir . exit 0, ok true, codeGraph key present
R-3 | PASS | bin/oma cfg exit 0, profile JSON
R-4 | PASS | session hook additionalContext starts with "oh-my-agent: /oma <what to build>"
R-5 | PASS | git diff --stat main...HEAD -- mods/codebase-memory-mod mods/caveman-mod prints nothing
