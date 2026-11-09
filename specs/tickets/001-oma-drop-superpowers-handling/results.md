# 001-oma-drop-superpowers-handling results

A-1 | PASS | `oma run lint` exit 0, "Validation passed"
A-2 | PASS | `oma run test` exit 0; node pass 83 fail 0; python OK (46); `ok 11 - session start never touches the user settings`
A-3 | PASS | `node --test mods/oh-my-agent-mod/test/*.test.mjs` exit 0, `# pass 15`, `# fail 0`
E-1 | PASS | prints `clean`, exit 0
E-2 | PASS | prints `none` then `claude,settings,data,sessions`
E-3 | PASS | restore-superpowers and bogus: stderr `usage: oma.mjs <session|prompt|start|status> [--dir <project>]`, exit=2, stdout empty
E-4 | PASS | exact startup hint JSON, exit=0, `same`, ls shows only before.json and settings.json
E-5 | PASS | output has `runs the superagent`, no `could not check`, last line `{ broken`
E-6 | PASS | prints `null` then `true`
E-7 | PASS | line 3 `argument-hint: "[what to build | status | off]"`; second command prints `true`
E-8 | PASS | `0.2.0`, `review_tickets`, `true`; `claude plugin validate mods/oh-my-agent-mod` exit=0
E-9 | PASS | prints `true`; diffstat `1 file changed, 1 insertion(+), 1 deletion(-)`
E-10 | PASS | prints `true`, `true`, `true`, `2`
E-11 | PASS | exit 0, `# pass 1`, `# fail 0`
R-1 | PASS | (E-12) oma test file exit 0, fail 0; router-mode, bootstrap and status/run/serve tests ok
R-2 | PASS | (E-13) `oma.mjs status --dir .` exit 0, `"ok": true`
R-3 | PASS | (E-14) compact session command prints only `exit=0`
