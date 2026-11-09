# 003: Caveman style really changes how Claude replies

**Status:** ready

## Summary
caveman-mod is meant to replace the output style so every Claude reply is in terse "ultracave" form, saving tokens. The user reports that replies in their Claude Code sessions (Claude Desktop) do not come out in that style. Find out why, fix it inside caveman-mod, and leave a check that proves, without a human, that replies follow the style.

## Why
Token savings and a reading style the user chose. The mod's hooks fire and its output style is set, yet the user sees normal prose, so the mod gives them nothing today. When a detail isn't covered here, favour: the style must hold in the user's real setup (Claude Desktop with their other plugins on), whatever output style the session happens to have, and `/caveman off` must still undo everything.

## User stories
- As the user, I want every main-session reply to come back in caveman form while caveman is on, so that I save tokens and read less.
- As the user, I want `/caveman off` to put things back exactly as before.
- As the maintainer, I want a command that shows whether the style really works, so a regression is caught without me reading replies.

## What the ticket writer already found (verify, don't assume)
- **Hooks fire and deliver.** `~/.claude/caveman-mod-fired/{session,prompt,subagent}.txt` were updated today; `~/.claude/settings.json` has `outputStyle: "caveman-mod:ultracave"` and `enabledPlugins["caveman-mod@claude-code-linux"]: true`; `~/.claude/caveman-mod.json` is `{"style":{"prev":"Concise"}}` (no `enabled` key, so on).
- **Headless CLI loads it.** In a temp folder, `claude -p "Reply with the single word ok." --output-format stream-json --verbose --model haiku --max-turns 1` (CLI 2.1.319) emitted a `system/init` event with `output_style: "caveman-mod:ultracave"`, and a `hook_response` for SessionStart whose output starts with `CAVEMAN ULTRACAVE:`. Subagents also receive the rules (the ticket writer itself got them through SubagentStart).
- **The user runs Claude Desktop**, which spawns the CLI (`~/.config/Claude/claude-code/<version>/claude`, entrypoint `claude-desktop`) with `--setting-sources=user,project,local` and its own `--settings` JSON. Leads from reading the desktop bundle (`/usr/lib/claude-desktop/resources/app.asar`), not yet confirmed:
  - Desktop keeps an output style per session (`sessionSettings.outputStyle`) and applies it to the running CLI with `applyFlagSettings(..., { outputStyle })`. Flag settings outrank `settings.json`, so a session that has, for example, `Concise` keeps it whatever caveman wrote to `settings.json`.
  - Desktop offers its own styles `Concise`, `Explanatory`, `Learning`, `Proactive`, and its style-name check rejects names containing `:` (a validator with `/[<>"|?*:]/`), so `caveman-mod:ultracave` can be dropped from its style list (log line `[CCD] output-style list: dropped ...`).
  - `[SettingsResolver] Screened outputStyle ...` is logged when it refuses a style name.
- **Competing instructions.** Other plugins also inject long SessionStart text into the same sessions (ponytail, claude-mem-lite, oh-my-context, codebase-memory, oh-my-agent), and the Desktop system prompt has its own reply-format guidance. The model may get the caveman text and still not follow it.

## Functional requirements
- **FR-1**: Root cause first. Before changing code, the worker must establish, with evidence, why replies in the user's Claude Desktop sessions are not in caveman form, and write it in the ticket's `results.md` under a `## Root cause` heading with exactly these four subsections, each giving a one-line answer, then the command(s) run and a short output excerpt:
  - `### Does the CLI load the style` (init event `output_style`, in a headless run and, from the logs or transcript, in a Desktop session)
  - `### Do the hook rules reach the model in a Desktop session` (from a real Desktop session transcript under `~/.claude/projects/`, for example the `hook_additional_context` / SessionStart and UserPromptSubmit attachments)
  - `### Which output style Desktop sessions actually run with` (from the Desktop logs under `~/.config/Claude/logs/` and the session's stored settings)
  - `### Does the model follow the rules when they arrive` (the live check's scenario results from before the fix)
  Excerpts must not contain tokens, e-mail addresses, or account or session UUIDs (replace them with `<redacted>`).
- **FR-2**: A live check script `mods/caveman-mod/test/live.mjs` must exist and be runnable as `node mods/caveman-mod/test/live.mjs` from the project root. It is not named `*.test.js`, so the offline test command never runs it. It must:
  - exit 2 and print one line starting `SKIP:` when the `claude` CLI is missing or not logged in, or when `<CLAUDE_CONFIG_DIR or ~/.claude>/caveman-mod.json` has `"enabled": false` (the line then says to run `/caveman on`);
  - run each scenario in a fresh `fs.mkdtempSync` folder that is not a git repository, with `claude -p <prompt> --output-format stream-json --verbose --model opus --max-turns 1`, loading this checkout's `mods/caveman-mod` (not the installed copy) through `--plugin-dir` with the installed `caveman-mod@claude-code-linux` turned off through `--settings`, the user's other settings and plugins left as they are;
  - run three scenarios: **A** `--settings` sets `"outputStyle": "caveman-mod:ultracave"`; **B** `--settings` sets `"outputStyle": "default"` (another style forced by flag settings, as Claude Desktop does per session); **C** control: caveman-mod not loaded at all, `"outputStyle": "default"`;
  - send each scenario these three prompts, word for word: P1 `Explain the difference between git merge and git rebase.` P2 `Why does a React component re-render when I pass an inline object as a prop?` P3 `What does the HTTP status code 409 mean and when should an API return it?`;
  - score each reply: remove fenced code blocks and inline code spans, count words as matches of `/[A-Za-z']+/g`, count filler as whole-word, case-insensitive matches of `the`, `a`, `an`, `is`, `are`; ratio = filler / words;
  - print one line per result, in this form: `PASS A init output_style=caveman-mod:ultracave`, `PASS B init output_style=default`, `PASS A P1 filler=1/52 (1.9%)`, and for the control `PASS C control filler=31/310 (10.0%)` (aggregate over its three replies); `FAIL` instead of `PASS` when the rule below is not met;
  - pass rules: A's and B's init `output_style` equal the value they set; every A and B reply has ratio ≤ 4.0%; C's aggregate ratio ≥ 6.0% (proves the score tells the two apart);
  - end with `RESULT: PASS` and exit 0 when every line passed, else `RESULT: FAIL` and exit 1.
- **FR-3**: Fix: with caveman on, scenario A passes (replies follow the caveman rules when the session uses caveman's own output style).
- **FR-4**: Fix: with caveman on, scenario B passes (replies follow the caveman rules even when flag settings force another output style). The fix may change the injected rules or reminder, where and when they are injected, and how the style is applied, all inside `mods/caveman-mod/`. If the root cause shows that Claude Desktop needs a style it accepts (a name without `:`), the mod may also write its own style file into `<CLAUDE_CONFIG_DIR or ~/.claude>/output-styles/` on `/caveman on` and remove that file on `/caveman off`; nothing else outside the plugin folder, `caveman-mod.json`, `caveman-mod-fired/` and the `outputStyle` key of `settings.json` may be written.
- **FR-5**: `/caveman off` still turns everything off: after `node hooks/ultracave.js off`, the `session`, `prompt` and `subagent` hook modes print nothing on stdout, the user's previous `outputStyle` is restored as today, and any file FR-4 added outside the plugin folder is gone. `/caveman on` brings it all back.
- **FR-6**: Every code change in `hooks/ultracave.js` (or any new script) is covered by an offline test in `mods/caveman-mod/test/ultracave.test.js` (temp `CLAUDE_CONFIG_DIR`, no network).
- **FR-7**: `version` in `mods/caveman-mod/.claude-plugin/plugin.json` rises above `0.4.0` (patch for a pure fix, minor if behaviour the user can see changes, such as a new style name in the Desktop menu). If the description in `plugin.json` or the text in `commands/caveman.md` / `commands/caveman-status.md` no longer matches what the mod does, update it.

## Non-functional requirements
- **NFR-1**: The live check never changes the user's `<config>/settings.json` or `<config>/caveman-mod.json` (same sha256 before and after a run).
- **NFR-2**: The live check finishes within 10 minutes (9 model calls) and prints no token, e-mail address or UUID.
- **NFR-3**: The offline test command in `.oma/project.md` stays offline and passes.
- **NFR-4**: Hooks keep stdout to the hook protocol; any error prints nothing on stdout and exits 0. The prompt reminder stays one short paragraph (at most 600 characters), since it is added to every message.

## Edge cases & error handling
- Caveman off in the state file: live check prints `SKIP:` and exits 2, never turns it on itself.
- `claude` not on PATH or not logged in (`claude auth status` reports `"loggedIn": false`): `SKIP:` and exit 2.
- A CLI call that fails or times out (120 s per call): that result line is `FAIL ... (error: <short reason>)`, the run ends with `RESULT: FAIL`.
- A reply with zero words after removing code: that line is `FAIL ... (empty reply)`.
- `settings.json` unreadable: hooks still inject the rules and never overwrite the file (existing behaviour).

## Out of scope
- Changing Claude Desktop, the CLI, or any other plugin (ponytail, claude-mem-lite, oh-my-context, codebase-memory, oh-my-agent).
- New caveman levels or modes, or a per-project switch.
- Changing what `/caveman-status` reports, unless the root cause shows its output misleads (then add one line, covered by a test).
- Running the live check in the offline test command or in CI.

## Affected areas
- `mods/caveman-mod/hooks/ultracave.js`: whatever the root cause requires.
- `mods/caveman-mod/output-styles/ultracave.md`: rule wording, if that is part of the fix.
- `mods/caveman-mod/hooks/hooks.json`: only if injection points change.
- `mods/caveman-mod/commands/caveman.md`, `mods/caveman-mod/commands/caveman-status.md`: text, if it no longer matches.
- `mods/caveman-mod/test/live.mjs` (new), `mods/caveman-mod/test/ultracave.test.js`.
- `mods/caveman-mod/.claude-plugin/plugin.json`: version (and description if needed).

## Do not touch
- `mods/oh-my-agent-mod/`: ticket 002 owns it.
- `mods/codebase-memory-mod/`, `mods/oh-my-context-mod/`, `mods/rea-mod/`, `mods/authentik-mod/`.
- The user's real `~/.claude/settings.json`, except through `node mods/caveman-mod/hooks/ultracave.js on|off` while investigating, and only if the worker puts it back as it found it.

## Dependencies
- The `claude` CLI on PATH and logged in (`claude auth status` shows `"loggedIn": true`); network access for the live check only.
- None on other tickets.

## Decisions made
- **Agreed with the user**: the worker finds the root cause first, then fixes it and proves it with a check that runs without a human (router notes).
- **Decided by the ticket writer**:
  - "Caveman works" is measured by the filler-word ratio (the/a/an/is/are ≤ 4% per reply) on three fixed prompts, with a no-caveman control that must score ≥ 6%, so the check is objective.
  - The fix must hold even when another output style is forced (scenario B), because Claude Desktop applies a per-session style that outranks `settings.json`.
  - The live check uses `--model opus`, the model the user's sessions run, and is kept out of the offline test command.
  - A Desktop-visible style file in `~/.claude/output-styles/` is allowed only if the root cause calls for it, and `/caveman off` must remove it.
