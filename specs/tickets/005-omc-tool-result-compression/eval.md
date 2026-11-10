# 005: Tool-result compression and recovery: Evaluation

## Setup
From the worktree root. `export OMC_HOME=$(mktemp -d)` for every check (never the real data folder). `export PYTHONPATH=mods/oh-my-context-mod/vendor`. Python one-liners below import `oh_my_context` after those exports.

## Automated checks
- `for m in mods/*-mod; do claude plugin validate "$m" || exit 1; done` exits 0
- `node --test mods/oh-my-context-mod/test/*.test.js` passes
- `PYTHONPATH=mods/oh-my-context-mod/vendor python3 -m unittest discover -s mods/oh-my-context-mod/test -p 'test_*.py'` passes, including new `test_compress.py` (FR-C1)

## Acceptance checks

### E-1: handle, store, exact retrieve (covers FR-A1, FR-A3, FR-A4)
- **Type**: CLI
- **Steps**: `python3 -c "from oh_my_context import recovery as r; t='x'*2000; h=r.store(t); print(h); print(r.fetch(h)[0], r.fetch(h)[1]==t); import hashlib; print(h=='omc_'+hashlib.sha256(t.encode()).hexdigest()[:32])"`; `ls -l $OMC_HOME/recovery`.
- **Expected**: handle `omc_` + 32 hex; `ok True`; `True`; one file, mode `-rw-------`. `test -e mods/oh-my-context-mod/vendor/oh_my_context/ccr.py` fails.

### E-2: corrupt / invalid (covers FR-A3)
- **Steps**: overwrite the stored file with `y`; fetch -> status `corrupt`. `r.fetch('../../etc/passwd')[0]` -> `invalid-handle`.

### E-3: cap, no eviction (covers FR-A2)
- **Steps**: `OMC_RECOVERY_MAX_BYTES=5000`; store 3 distinct 2000-char strings.
- **Expected**: first two return handles, third returns None; both first handles still fetch `ok`.

### E-4: retrieve with query (covers FR-A4, FR-A5)
- **Steps**: store `"alpha one\n\nbeta two\n\nalpha three"`; fetch with query `alpha`.
- **Expected**: text `alpha one\n…\nalpha three`. Query `zzz` -> `no section matches; call retrieve without query for the full original`. The `retrieve` tool schema in native_tools has `handle` required and `query` optional.

### E-5: JSON elision through the gateway path (covers FR-B1, FR-B2, FR-B4 json, FR-B6)
- **Steps**: input `json.dumps({"items":[{"id":i,"v":"ok" if i!=7 else "error: boom","n":[1,{"a":i}]} for i in range(30)]})` passed through the same function serve.py `_compress_result` uses for a `call` result.
- **Expected**: output parses as JSON (after removing the last line); `items` keeps ids 0,1,2,7,28,29 and `{"__omc_elided__": N}` objects for the gaps; last line is `<<omc:HANDLE>> compressed view; call retrieve with this handle for the exact original`; retrieve gives the input byte-exact; `usage.saved_tokens()` grew by `count_tokens(in)-count_tokens(out)`.

### E-6: TOON (covers FR-B5)
- **Steps**: encode `[{"name":"Ada","role":"engineer"},{"name":"Lin","role":"designer"}]` and `{"rows":[{"id":1}]}`; decode both back.
- **Expected**: exactly `[2]{name,role}:\n  Ada,engineer\n  Lin,designer` and `rows[1]{id}:\n  1`; decodes equal the inputs. `[{"a":1},{"b":2}]` -> not eligible. String `"1x"` is quoted.

### E-7: per-shape fixtures (covers FR-B3, FR-B4)
- **Type**: automated (test_compress.py)
- **Expected**: test report (pytest JSON 20 tests, 1 failed with 12 stack frames) -> first line `TEST SUMMARY: passed=19 failed=1`, one `FAILED:` block, `... (7 frames omitted)`. Diff 40 lines one hunk change -> `… N context lines elided …`, all `+`/`-` lines kept. CSV 30 rows -> header + 3 + 2 rows + error rows + `… N rows elided …` (or TOON if shorter). Python file of 5 functions -> bodies `...`, parses. Log 50 lines with 1 ERROR -> first 2, last 2, ERROR line, `… N lines elided …`. Text 20 paragraphs > 1600 bytes -> headings and first/last 2 kept, `… N sections elided …`.

### E-8: pass-through rules (covers FR-B1, FR-B2, edge cases)
- **Expected**: 300-byte result unchanged; result holding `<<omc:` unchanged; result not getting smaller unchanged; with `OMC_RECOVERY_MAX_BYTES=10` a large JSON comes back unchanged with no marker and saved tokens +0; `compress: off` in `$OMC_HOME/settings.json` -> unchanged; native tool results (e.g. `usage`) never carry a marker.

### E-9: no unsafe old path (covers FR-B7)
- **Expected**: `python3 -c "import oh_my_context.compressor as c; print(hasattr(c,'compress_with_ccr'))"` prints `False` (or module routes only through new pipeline: no output without stored original in any test).

### E-10: performance (covers NFR-2)
- **Expected**: compressing a 1 MiB log text takes < 1 s (`time`).

### E-11: naming and deps (covers NFR-1, NFR-3)
- **Steps**: `python3 -c "import re,subprocess;fs=subprocess.check_output(['git','ls-files','mods/oh-my-context-mod/vendor']).decode().split();print([f for f in fs if re.search(r'caveman|\bcave\b|ultracave|megacave|ccr',f+open(f,errors='ignore').read(),re.I)])"`
- **Expected**: `[]`. No import outside the stdlib in new files.

## Regression checks
- `test_gateway.py` passes (manifest, call, skills, kb). `bin/oh-my-context --version` exits 0.

## Traceability
| Requirement | Evals |
|---|---|
| FR-A1 | E-1, E-11 |
| FR-A2 | E-3 |
| FR-A3 | E-1, E-2 |
| FR-A4 | E-1, E-4 |
| FR-A5 | E-4 |
| FR-A6 | E-7 (test_compress asserts stats) |
| FR-B1, FR-B2 | E-5, E-8 |
| FR-B3, FR-B4 | E-5, E-7 |
| FR-B5 | E-6 |
| FR-B6 | E-5, E-8 |
| FR-B7 | E-9 |
| FR-C1 | Automated checks |
| NFR-1, NFR-3 | E-11 |
| NFR-2 | E-10 |
| NFR-4 | review: no file is a copy of upstream Go/Python source |

## Definition of done
- [ ] All automated checks pass
- [ ] E-1..E-11 pass
- [ ] Nothing from Out of scope built
