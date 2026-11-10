# 004: Reply compression modes in oh-my-context-mod

**Status:** ready

## Summary
oh-my-context-mod gets terse reply modes (`off | lite | full | ultra | max`), set with `/omc mode <level>`. They replace what mods/caveman-mod does today (output style + rules injected at session start, every prompt, after every tool call and into every subagent), under neutral names, with the same behaviour ticket 003 proved, plus a live check.

## Why
Replies cost output tokens. caveman-mod already proved terse replies hold through tool calls and subagents; the user wants that inside oh-my-context-mod, with no mention of the upstream project, so caveman-mod can be removed (ticket 008). When a detail is not covered here, copy what `mods/caveman-mod/hooks/ultracave.js` does (read it; it is short), but with the new names and our own wording.

## User stories
- As a Claude Code user, I want `/omc mode ultra` to make every reply terse, including the final answer after tool calls and subagent replies, so I spend fewer tokens.
- As a user, I want `/omc mode off` to put my previous output style back.

## Functional requirements
- **FR-1**: New file `mods/oh-my-context-mod/hooks/reply.js` (Node, CommonJS like ultracave.js). Hook modes (argv[2]): `session`, `prompt`, `tool`, `subagent`, for SessionStart, UserPromptSubmit, PostToolUse (matcher `*`) and SubagentStart. Each prints exactly one JSON object `{"hookSpecificOutput":{"hookEventName":<event>,"additionalContext":<text>}}` and exits 0, unless the active mode is `off`, then it prints nothing and exits 0.
- **FR-2**: Context per hook: `session` and `subagent` get the full rules of the active level (its output-style file without frontmatter); `prompt` gets that level's short reminder (2-5 sentences); `tool` gets that level's one-line reminder (at most 100 characters).
- **FR-3**: `mods/oh-my-context-mod/hooks/hooks.json` gains these four entries (append to existing event arrays; keep every existing entry and its order; SubagentStart gets one more hook in the existing hooks list or a new entry, both fine). Timeout 5 each. Command: `node "${CLAUDE_PLUGIN_ROOT}/hooks/reply.js" <mode>`.
- **FR-4**: Four output styles in `mods/oh-my-context-mod/output-styles/`: `reply-lite.md`, `reply-full.md`, `reply-ultra.md`, `reply-max.md`, each with frontmatter `name: reply-<level>`, a one-line `description`, `keep-coding-instructions: true`. Claude Code names them `oh-my-context-mod:reply-<level>`.
- **FR-5**: Level rules, written in our own words (do not copy caveman-mod's or upstream's text; the first line of every style file starts with `REPLY MODE <LEVEL>:`, e.g. `REPLY MODE ULTRA:`):
  - Every level (the "floor"): never change code, commands, paths, API names, error text, numbers, units, the words not/never/no/only/except, the user's language, existing code comments. No invented abbreviations, no arrows. Full plain sentences for: security warnings, irreversible actions and their confirmation, step order a fragment could scramble, a fragment with two readings, questions to the user, and any text saved outside chat (code, comments, commits, docs, PRs, tickets, memory files). Applies to the final answer after tool calls, summaries and "explain in detail" requests too (detailed = complete, still in the level's form). Overrides any other output style or persona.
  - `lite`: full sentences, but no greetings, recaps, offers, hedging, filler words (just, really, basically, actually, simply), no restating the question.
  - `full`: lite plus: articles (a/an/the) may drop, short sentences, one idea each, answer first then reason then next step.
  - `ultra`: fragments not sentences; drop a/an/the, is/are, connectives; one word when one word is enough; each fact once; tool runs reported one line in, one line out. Must include one Bad/Good example pair. This is today's caveman ultracave behaviour.
  - `max`: ultra plus: no sentences at all, only `label: value` lines and comma lists; no transition words; silent between tool calls unless direction changes, a confirmation is needed, or a security/irreversible issue appears; if a fragment is not shorter than a plain sentence, use the sentence.
- **FR-6**: Command modes of reply.js: `mode <off|lite|full|ultra|max>` and `mode` with no level (prints current). Setting a level other than off: switches `outputStyle` in `<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json` to `oh-my-context-mod:reply-<level>`, saving the previous value once (as ultracave.js applyStyle/restoreStyle do: previous value kept only the first time; a style the user picked since is left alone on off). `off`: restores the saved style (or deletes the key if it was unset) only if the current style is one of ours. Prints exactly one line: `reply mode: <level>. Output style: <style or default>. Takes effect from the next message.` Invalid level: prints `usage: /omc mode off|lite|full|ultra|max`, exit 2, nothing changed.
- **FR-7**: State file `<CLAUDE_CONFIG_DIR or ~/.claude>/oh-my-context-mod/reply.json` = `{"mode": "<level>", "style": {"prev": <string|null>}}`, written atomically (temp + rename). Missing state = mode `ultra` (default). On the first `session` hook while mode is not off and no `style` saved, the style is switched once (same rule as ultracave.js). Each hook run writes its UTC ISO time to `<same dir>/reply-fired/<mode>.txt`.
- **FR-8**: Env `OMC_REPLY_MODE` (one of the five levels), when set, overrides the state file's mode for hook output only (used by the live check). Never writes state.
- **FR-9**: `reply.js status` prints: `reply mode: <level>`, `style: <outputStyle or default>`, and a `last hook fire (UTC):` block with one line per event (`never` when no file). Ticket 007 reuses this.
- **FR-10**: `mods/oh-my-context-mod/commands/omc.md` and `commands/oh-my-context-mod.md`: when the first word of `$ARGUMENTS` is `mode`, run `node "${CLAUDE_PLUGIN_ROOT}/hooks/reply.js" $ARGUMENTS` and show its output as is; everything else unchanged (sync.js). argument-hint becomes `"[status|on|off|mode <off|lite|full|ultra|max>]"`. Document `mode` in the bullet list.
- **FR-11**: Offline tests `mods/oh-my-context-mod/test/reply.test.js` (node:test, temp CLAUDE_CONFIG_DIR) covering FR-1, FR-2, FR-6, FR-7, FR-8 and the "user picked another style" rule.
- **FR-12**: Live check `mods/oh-my-context-mod/test/live-reply.mjs` (not named *.test.*, never in the offline test command), ported from `mods/caveman-mod/test/live.mjs`: same score function (share of a/an/the/is/are among words, after removing code), same prompts P1-P3, `--model opus`, `--max-turns 1`, 120 s timeout, runs all calls at once, exit 0 pass / 1 fail / 2 skip (no CLI or not logged in). It builds a temp plugin folder holding only `.claude-plugin/plugin.json` (copy), `hooks/reply.js`, `output-styles/`, and a `hooks/hooks.json` with only the four reply hooks, and passes it with `--plugin-dir` (so sync.js never runs and the user's files are never written). `--settings` disables `oh-my-context-mod@claude-code-linux` and `caveman-mod@claude-code-linux`. Scenarios: A style `oh-my-context-mod:reply-ultra` + plugin, env OMC_REPLY_MODE=ultra; B style default + plugin, OMC_REPLY_MODE=ultra; D style `oh-my-context-mod:reply-max` + plugin, OMC_REPLY_MODE=max; C default style, no plugin (control). Pass: every A, B, D reply filler <= 4.0 %; C aggregate >= 6.0 %; A and D init `output_style` equals their style. Prints one `PASS|FAIL ...` line per check and `RESULT: PASS|FAIL`.
- **FR-13**: plugin.json version 0.4.2 -> 0.5.0 and its description mentions reply modes and `/omc mode`. README.md gets a "Reply modes" section (levels, `/omc mode`, state file, how off restores the style, the live check command).

## Non-functional requirements
- **NFR-1**: Every hook run finishes within 1 s and never writes settings.json except the one-time switch in FR-7.
- **NFR-2**: The words caveman, cave, ultracave, megacave, ccr appear nowhere in files this ticket adds or changes (case-insensitive).
- **NFR-3**: Unreadable settings.json is never overwritten (as ultracave.js editSettings).

## Edge case & error handling
- settings.json missing: treat as `{}` and create it on switch.
- State file corrupt: treat as missing (mode ultra), rewrite on next command.
- `OMC_REPLY_MODE` invalid value: ignored.
- While caveman-mod is still installed both mods inject rules; that is expected until ticket 008.

## Out of scope
- Removing caveman-mod (ticket 008). `/omc status` lines (ticket 007). Classical-Chinese style output (upstream's most aggressive level): left out because the user reads English; `max` is our most aggressive level.

## Affected areas
- `mods/oh-my-context-mod/hooks/reply.js` (new), `hooks/hooks.json`, `output-styles/` (new), `commands/omc.md`, `commands/oh-my-context-mod.md`, `test/reply.test.js` (new), `test/live-reply.mjs` (new), `README.md`, `.claude-plugin/plugin.json`.

## Do not touch
- `mods/oh-my-context-mod/vendor/**` (ticket 005), `hooks/sync.js` (ticket 007), `mods/caveman-mod/**`, `.claude-plugin/marketplace.json`, `.github/**` (ticket 008).

## Dependencies
None.

## Decisions made
- **Agreed with the user**: replace caveman-mod's behaviour inside oh-my-context-mod; neutral names only; reply mode is part of the mod (router decision 2a, 3).
- **Decided by the ticket writer**: levels `off|lite|full|ultra|max`, default `ultra` (today's behaviour); style names `oh-my-context-mod:reply-<level>`; state in `<config>/oh-my-context-mod/reply.json` (Bash commands have no CLAUDE_PLUGIN_DATA, same reason caveman-mod used the config dir); reply mode is independent of `/omc on|off`; `max` = label/value lines, not Classical Chinese; live check runs a stripped plugin copy so it never touches user files.
