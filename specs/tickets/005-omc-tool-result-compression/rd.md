# 005: Tool-result compression and recovery in the oh-my-context gateway

**Status:** done

## Summary
Results of routed MCP tools (those reached through the gateway's `call` tool) are compressed by shape (JSON, logs, test reports, diffs, code, tables, text), with TOON for uniform arrays of objects. Every lossy result keeps its exact original in a local store behind a content-hash handle; a marker in the text names the handle and the gateway's `retrieve` tool gives the original (or matching sections) back.

## Why
Large tool results fill the context. Compression must never lose data: output is only used when strictly smaller, valid, and the original is safely stored. When a detail is not covered here, favour "return the original unchanged".

## User stories
- As a Claude Code user, I want big routed tool results shrunk automatically, so long sessions cost fewer tokens.
- As the model, I want to fetch the exact original of a compressed result by handle, so nothing is lost.

## Existing code to reuse (read first)
`mods/oh-my-context-mod/vendor/oh_my_context/`: `serve.py` (`_handle_call_tool`, `_compress_result`, `_smart_compress`), `compressor.py` (current "smart" crusher, `compress_with_ccr`, `notice`), `ccr.py` (store, `retrieve_status`, `was_sent`/`mark_sent` dedupe, `_maybe_evict`), `native_tools.py` (`retrieve` and `usage` tool definitions and handlers), `config.py` (`compress` setting, `COMPRESS_MODES`, `get_setting`, settings file `OMC_HOME/settings.json`), `usage.py` (`count_tokens` = chars/4, `usage.json`). Tests: `test/test_gateway.py`.

## Mode: team. Shared shape (both parts must agree)
- `recovery.store(original: str) -> str | None`: returns handle or None (None = not stored: over cap, write error, empty).
- `recovery.fetch(handle: str, query: str | None = None) -> (status, text)`: status in `ok | not-found | corrupt | invalid-handle`.
- Handle: `omc_` + first 32 hex chars of SHA-256 of the original's UTF-8 bytes (16 bytes). Identical bytes give the identical handle.
- Marker: the last line of compressed text is exactly `<<omc:HANDLE>> compressed view; call retrieve with this handle for the exact original` (one line, `\n` before it).
- Write this as `contract.md` in this ticket folder before splitting work.

## Functional requirements

### Part A: recovery store (owner: recovery teammate)
- **FR-A1**: Rename `vendor/oh_my_context/ccr.py` to `recovery.py`; every import, name, docstring, comment, path and the `vendor/NOTICE` line updated. Store dir `OMC_HOME/recovery/` (old `OMC_HOME/ccr/` dir is ignored, not migrated). One file per handle, file name = handle, content = exact original bytes, written temp + rename, mode 0600, dir 0700.
- **FR-A2**: Cap: total bytes of the store dir default 512 MiB (536870912); env `OMC_RECOVERY_MAX_BYTES` (positive integer) overrides. A store that would pass the cap is refused (returns None). Nothing is ever evicted or deleted by the gateway: remove `_maybe_evict` and any time/size eviction.
- **FR-A3**: Fetch verifies `sha256` of the stored bytes matches the handle; mismatch -> `corrupt`. Malformed handle (not `omc_` + 32 lowercase hex) -> `invalid-handle`, never touches the file system.
- **FR-A4**: The gateway's existing `retrieve` tool takes `handle` (required) and `query` (optional string). No query: returns the exact original text. With query: split the original into sections at blank lines (one or more empty lines), score each by how many distinct query words (case-insensitive, split on non-alphanumerics, words < 2 chars dropped) it contains, keep sections with score > 0, at most the 20 best, output in original order joined by `\n…\n` between non-adjacent sections. No match: returns `no section matches; call retrieve without query for the full original`. Status other than ok returns a one-line message naming the status and the handle.
- **FR-A5**: Keep the existing per-process dedupe (`was_sent`/`mark_sent`) working with the new handles.
- **FR-A6**: `recovery.stats() -> {"bytes": int, "cap": int, "entries": int}` (used by ticket 007).

### Part B: shape compressors and gateway wiring (owner: compression teammate)
- **FR-B1**: The `compress` setting accepts `off | on`; `smart` is read as `on`; missing/unknown -> `on` (new default). Only results of the `call` tool (routed servers) are compressed; native tool results never are; a result already containing `<<omc:` is never compressed again; results of `retrieve` never.
- **FR-B2**: Pipeline per text result: (1) skip if < 512 bytes; (2) detect shape (FR-B3); (3) run that shape's compressor; (4) accept only if output is strictly shorter in bytes than input AND (for JSON output) parses with `json.loads`; (5) for any lossy output, `recovery.store(original)` must return a handle, else return the original unchanged; (6) append the marker line. Any exception anywhere -> original unchanged. Non-text MCP content blocks (images etc.) pass through untouched.
- **FR-B3**: Shape detection, first match wins (input = result text):
  1. json: stripped text starts with `{` or `[` and `json.loads` succeeds.
  2. test report: JSON with top-level `tests` list and `exitcode`, or `numFailedTests` and `testResults` list; or text whose first 16 non-space tokens contain `<testsuites` or `<testsuite`.
  3. diff: contains `\ndiff --git ` or text starts `diff --git `, or contains `\n@@ `, or both `\n--- ` and `\n+++ `; and at least 4 lines start with `+`, `-`, `@@` or `diff `.
  4. tabular: CSV/TSV (first line has >= 1 delimiter; tab if tabs outnumber commas) parsed with `csv`, every row same field count, 2..128 fields, >= 8 rows; or a Markdown table (header row, `|---|` separator row with cells matching `^:?-{3,}:?$`).
  5. code: starts `#!`, or `ast.parse` succeeds and the text has >= 3 lines starting with `def `, `class `, `import ` or `from ` (Python only).
  6. log: >= 4 lines, >= 3 match `(?i)\b(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|PANIC|CRIT|CRITICAL|ALERT|EMERG|EMERGENCY)\b|^\s*\[[A-Z]+\]|\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}|\b\d{2}:\d{2}:\d{2}\b`, and matching lines >= half of all lines.
  7. text: everything else.
- **FR-B4**: Compressors (one module per shape under `vendor/oh_my_context/shapes/`, registered in a dict `REGISTRY = {"json": ..., "testreport": ..., ...}` in `shapes/__init__.py`; each is `fn(text) -> str | None`, None = no gain):
  - **json**: TOON first (FR-B5) if the whole value is TOON-eligible and the TOON text is strictly shorter. Else array elision: any array with > 8 elements keeps the first 3, the last 2, and any element whose JSON text matches `(?i)error|failed|fatal|timeout|exception|panic`, up to 50 kept in total; each dropped run becomes `{"__omc_elided__": N}`. Subtrees under keys matching `(?i)^(error|errors|message|msg|stack|stacktrace|stack_trace|trace|traceback|exception|reason|detail|details|warning|warnings)$` stay verbatim. No array collapses -> None. Output `json.dumps(..., ensure_ascii=False, separators=(",", ":"))`.
  - **testreport**: one line `TEST SUMMARY: ` + nonzero counts `passed=N failed=N errors=N skipped=N` (+ ` duration=Xs` if > 0), then for each failure/error `FAILED: <name>` or `ERROR: <name>`, its message, and its stack trimmed: if >= 8 frames keep first 3 + last 2 with `... (N frames omitted)` (N = total - 5). Formats: pytest JSON (`tests`), Jest JSON (`testResults`), JUnit XML (`xml.etree`). Zero tests or parse error -> None.
  - **diff**: < 12 lines -> None. Keep anchor lines (start with `diff --git `, `index `, `--- `, `+++ `, `@@ `, `rename `, `copy `, `old mode`, `new mode`, `new file`, `deleted file`, `Binary files`, `GIT binary patch`, `\`, `+`, `-`) and 2 lines either side; each dropped run -> `… N context lines elided …`. Nothing dropped -> None.
  - **tabular**: < 12 rows -> None. Keep header, first 3 and last 2 data rows, rows matching `(?i)\b(ERROR|FAIL|FAILED|FATAL|PANIC|EXCEPTION|WARNING|SECURITY|DENIED|REJECTED)\b`; dropped runs -> `… N rows elided …`. Uniform CSV with >= 8 rows may instead be TOON when strictly shorter (take the shorter of the two).
  - **code** (Python only, stdlib `ast`): replace every function/method body with `...` keeping imports, decorators, signatures, class lines, docstrings and comments; output must `ast.parse`. Other languages: None (pass through).
  - **log**: < 4 lines -> None. Keep first 2, last 2, lines matching `(?i)(\b(ERROR|FATAL|PANIC|EXCEPTION|TRACEBACK|FAIL|FAILED|FAILURE|WARN|WARNING|CRIT|CRITICAL|ALERT|EMERG|EMERGENCY)\b|^\s+at\s|^\s+File "|\.go:\d+|^\s+--->|caused by)`; collapse runs of >= 3 dropped lines into `… N lines elided …` (runs < 3 kept as is).
  - **text**: < 1600 bytes -> None. Sections split at blank lines; if sections <= 6 -> None. Keep first 2, last 2, Markdown headings, fenced code blocks whole, sections matching `(?i)\b(ERROR|WARNING|IMPORTANT|NOTE|ACTION|SECURITY|SUMMARY|CONCLUSION|DECISION|RECOMMENDATION)\b`; runs of >= 3 dropped sections -> `… N sections elided …`.
  - The registry is the single seam where a later compressor (e.g. for built-in tool output) plugs in; add a one-line comment saying so.
- **FR-B5**: TOON encoder `vendor/oh_my_context/toon.py` (own code; the vendored python-toon in vendor NOTICE may be reused only if it already exists in the tree and meets these rules), plus a decoder used by tests:
  - Keys must match `^[A-Za-z_][A-Za-z0-9_.-]*$`, no duplicate keys (parse with `object_pairs_hook`), else not eligible.
  - Uniform array of objects (every element an object, same keys in same order as the first, all values scalar, first object non-empty): header `name[N]{k1,k2}:` (root: `[N]{k1,k2}:`), then N rows indented 2 spaces deeper, cells joined by `,`.
  - Scalar array: `name[N]: a,b,c`. Empty array `name[0]: []`, empty object `name: {}`. Nested objects: `name:` then children indented 2 spaces. Object keys output in sorted order.
  - Scalars: `null`, `true`, `false`, numbers as their original JSON text (`parse_float=str`-style: keep lexical form); strings bare unless empty, leading/trailing whitespace, contain `\n \r \t " :` or `,`, start with `[ { " -` or a digit, equal `true/false/null`, or parse as a number: then quoted with `json.dumps`.
  - Any non-uniform array or nested array of objects with differing keys: not eligible -> fall back.
  - Example: `[{"name":"Ada","role":"engineer"},{"name":"Lin","role":"designer"}]` -> `[2]{name,role}:\n  Ada,engineer\n  Lin,designer`. `{"rows":[{"id":1}]}` -> `rows[1]{id}:\n  1`.
  - TOON output counts as lossy only in key order: still stored in recovery and marked.
- **FR-B6**: Tokens saved: `usage.json` gains `saved_tokens` (int, cumulative). After an accepted compression add `count_tokens(original) - count_tokens(final text incl. marker)`; fallbacks add 0. `usage.saved_tokens()` reads it. Same `count_tokens` for both sides. Atomic write as `track_call`.
- **FR-B7**: Remove the old string-truncating "smart" path (`compress_with_ccr`, `smart_crush` etc.) or route it through the new pipeline; no code path may output a truncated view without a stored original.

### Both
- **FR-C1**: Tests `mods/oh-my-context-mod/test/test_compress.py` (unittest, offline, temp `OMC_HOME`): one fixture per shape asserting the exact kept/dropped lines and the marker; TOON examples above byte-exact and decode round trip; pass-through cases (small input, not smaller, invalid, store refused at cap via `OMC_RECOVERY_MAX_BYTES=10`); retrieve exact bytes; retrieve with query; corrupt and invalid handle; no eviction (fill to cap, older entries still fetch). Existing `test_gateway.py` updated for renamed module/defaults and still passes.

## Non-functional requirements
- **NFR-1**: Python 3.10 stdlib only, no new dependency.
- **NFR-2**: Compression of a 1 MiB result takes < 1 s on this machine.
- **NFR-3**: No file under `mods/oh-my-context-mod/vendor/` contains caveman, cave (word), ultracave, megacave or ccr (case-insensitive), including file names, after this ticket.
- **NFR-4**: Upstream source is not copied; implement from the rules above.

## Edge cases & error handling
- Invalid UTF-8 / binary / base64-looking result: pass through.
- Store dir not writable: pass through original, no marker.
- Same result twice: same handle, stored once.
- Result already holding `<<omc:`: untouched.

## Out of scope
- Proxy, cache planner, pixel (text-to-image): no proxy this round; Claude Code places its own prompt-cache breakpoints and a proxy would see the login token and every request body; pixel needs the proxy and has no published savings.
- Compressing built-in tool output (Bash, Read): future RTK work plugs into the `shapes` REGISTRY seam.
- HTML, terminal (ANSI), search-result and config shapes: no reliable rules settled; they fall to text.
- Code compression for non-Python languages (no parser in the stdlib).
- `/omc status` lines and README (ticket 007).

## Affected areas (team split)
- Recovery teammate: `vendor/oh_my_context/ccr.py` -> `recovery.py`, `vendor/oh_my_context/native_tools.py` (retrieve tool schema + handler), `vendor/NOTICE`.
- Compression teammate: `vendor/oh_my_context/compressor.py`, new `vendor/oh_my_context/shapes/`, new `vendor/oh_my_context/toon.py`, `vendor/oh_my_context/serve.py` (`_compress_result`, `_smart_compress`), `vendor/oh_my_context/config.py`, `vendor/oh_my_context/usage.py`.
- Shared: `test/test_compress.py` (new), `test/test_gateway.py`, `specs/tickets/005-omc-tool-result-compression/contract.md`.

## Do not touch
- `mods/oh-my-context-mod/hooks/**`, `commands/**`, `output-styles/**`, `README.md`, `.claude-plugin/plugin.json` (tickets 004, 006, 007 own them; 007 bumps the version and documents this).

## Dependencies
None.

## Decisions made
- **Agreed with the user**: router decisions 1, 2b, 2c, 3, 4, 6: no proxy; compress routed MCP results; recovery store with handle and marker via existing `retrieve`; neutral names; own code.
- **Decided by the ticket writer**: compression default `on` (originals always recoverable); handle `omc_`+32 hex; cap 512 MiB via `OMC_RECOVERY_MAX_BYTES`; JSON anomaly/relevance ranking and query-based compression left out (no query at call time); code shape Python only; HTML/terminal/search/config shapes fold into text; retrieve query = word-match sections, top 20; token counter = existing chars/4 estimate.
