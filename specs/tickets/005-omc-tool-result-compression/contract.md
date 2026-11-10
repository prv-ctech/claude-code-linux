# 005 contract

Shape as in rd.md "Shared shape". Details agreed:

- `recovery.store(original: str) -> str | None`; `recovery.fetch(handle, query=None) -> (status, text)`; status in ok|not-found|corrupt|invalid-handle; `recovery.stats() -> {"bytes","cap","entries"}`; `was_sent(handle)`, `mark_sent(handle)` kept; `recovery.MARKER_FMT`/`recovery.marker(handle)` returns the exact marker line (no leading newline); caller appends `"\n" + marker(handle)`.
- Handle `omc_` + sha256(utf8)[:32]. `store` returns None for empty, over cap, write error, unencodable text.
- `retrieve` tool: args `handle` (required), `query` (optional). Result is plain text (`_text`), not JSON: original, filtered sections, or one-line status message.
- Old ccr API (`store_ex`, `retrieve_status`, `retrieve_notice`, STATUS_*) is gone. Compression teammate removes `compress_with_ccr` and its `ccr` imports in compressor.py/serve.py, uses only `recovery.store` + `recovery.marker`.

## Files
- recovery: vendor/oh_my_context/recovery.py (ccr.py removed), native_tools.py retrieve, vendor/NOTICE, test/test_recovery section inside test/test_compress.py class `RecoveryTests` (recovery writes it; compression writes the shape/toon/pipeline classes in the same file, appended after), test_gateway.py edits for retrieve.
- compression: compressor.py, shapes/, toon.py, serve.py, config.py, usage.py, rest of test_compress.py.

## results.md
See results.md skeleton.
