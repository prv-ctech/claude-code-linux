# 003-caveman-style-takes-effect results

## Root cause

Summary: the style and the rules do reach the model in Desktop sessions, and no Desktop setting overrides the style. The gap is compliance. The rules are injected only at session start and at prompt submit; the final answer comes after tool calls, far from both, and there the model slips back into normal prose (about 12% filler, same as no caveman). Fix: a one-line reminder after every tool call, plus a stronger prompt reminder.

### Does the CLI load the style
Yes. Headless and in Desktop sessions the init output style is `caveman-mod:ultracave`.
Headless: `claude -p "Reply with the single word ok." --output-format stream-json --verbose --model haiku --max-turns 1` printed `init output_style= caveman-mod:ultracave` and a SessionStart `hook_response` whose output starts with `{"hookSpecificOutput":{"hookEventName":"SessionStart"`.
Desktop: every Desktop session transcript since 2026-10-30 (19 files under `~/.claude/projects/-workspaces-claude-code-linux/`, entrypoint `claude-desktop`, CLI 2.1.309 and 2.1.317) holds an attachment `{"type":"output_style_instructions","style":{"name":"caveman-mod:ultracave","prompt":"CAVEMAN ULTRACAVE: every reply, whole session. ...`.

### Do the hook rules reach the model in a Desktop session
Yes. SessionStart and every UserPromptSubmit deliver the rules as `hook_additional_context` attachments.
Command: a node script over the newest transcript, counting attachments that contain `CAVEMAN`, by type and hook event.
Output (latest Desktop session): `{"hook_success/SessionStart":1,"hook_additional_context/SessionStart":1,"output_style_instructions/":1,"hook_additional_context/UserPromptSubmit":20}` for 20 prompts.
Other sessions show the same shape (one SessionStart, one style attachment, one UserPromptSubmit per prompt).

### Which output style Desktop sessions actually run with
Caveman's own style; nothing in Desktop forces another one. The ticket's lead (Desktop flag settings with `Concise`) is not what happens here.
Running Desktop CLI processes (`/proc/<pid>/cmdline`): `--setting-sources=user,project,local` and `--settings` JSON with keys `ultracode,deniedMcpServers` (or `fastMode,deniedMcpServers`), no `outputStyle` key.
Stored sessions under `~/.config/Claude/claude-code-sessions/`: `sessionSettings` is `null` in 31 files, `{"ultracode":true}` in 8, `{"ultracode":false}` in 2; none has `outputStyle`. Desktop writes `sessionSettings.outputStyle` only when the user picks a style in its menu.
Logs: `grep -c "Screened outputStyle\|output-style list" ~/.config/Claude/logs/main*.log` printed `0` for main.log, main1.log and main2.log (no screened or dropped style).

### Does the model follow the rules when they arrive
Not reliably in real sessions. A single question passes; a question after a tool-using turn does not.
Before the fix, `node mods/caveman-mod/test/live.mjs`: opus `PASS A P1 filler=0/131 (0.0%)`, `PASS B P2 filler=1/101 (1.0%)`, `PASS C control filler=84/725 (11.6%)`, `RESULT: PASS`. Same script with `--model sonnet`: `FAIL B P1 filler=4/96 (4.2%)`, `FAIL B P2 filler=3/72 (4.2%)`, `RESULT: FAIL`.
Real Desktop sessions (replies of 40 words or more, filler = the/a/an/is/are, from the transcripts above): haiku 7.6%, opus 11.6%, sonnet 12.3% aggregate, against 11.6% for the no-caveman control.
Reproduction: headless, Desktop's appended system prompt, turn 1 = "read hooks/ultracave.js and explain in detail" (a tool call, then a long answer), then the final answer scored. Sonnet, five runs before the fix: 45/339, 48/357, 0/251, 48/389, 90/484 filler/words (13%, 13%, 0%, 12%, 19%). Six runs with the PostToolUse reminder: 1/301, 0/255, 1/293, 0/257, 0/296, 0/304 (at most 0.4%).

## Checks

A-1 | PASS | `oma run lint` exit 0, all mods "Validation passed"
A-2 | PASS | `oma run test` exit 0: `# pass 87`, `# fail 0`, Python `OK`
A-3 | PASS | `node --test mods/caveman-mod/test/*.test.js` exit 0, `# fail 0`, live.mjs not run
E-1 | PASS | node check printed `true true true true`
E-2 | PASS | live.mjs: `PASS A init output_style=caveman-mod:ultracave`, `PASS B init output_style=default`, A and B P1-P3 all 0.0%, `PASS C control filler=95/771 (12.3%)`, `RESULT: PASS`, exit=0, 20.9s; sha256 of settings.json and caveman-mod.json OK
E-3 | PASS | second run `RESULT: PASS`
E-4 | PASS | `SKIP: caveman is off in the state file. Run /caveman on first.` exit=2 in 0.04s; PATH=/nonexistent gives `SKIP: claude CLI not found on PATH.` exit=2
E-5 | PASS | step 2 `session true`, `prompt true`, `subagent true`; step 3 `0 0 0`, `Concise`, `0`
E-6 | PASS | version 0.5.0 prints `true`; prompt reminder 562 chars prints `true`
E-7 | PASS | prints `true`, `exit=0`, `{broken` unchanged
R-1 | PASS | existing ultracave tests inside `oma run test`: 87 pass, 0 fail
R-2 | PASS | `ultracave.js status` first line `caveman: ON`, exit 0
R-3 | PASS | `subagent` mode prints additionalContext starting `CAVEMAN ULTRACAVE`
R-4 | PASS | `git diff --stat main...HEAD -- mods/oh-my-agent-mod mods/codebase-memory-mod mods/oh-my-context-mod` prints nothing
