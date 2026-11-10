"""Shape compressors: each is fn(text) -> str | None (None = no gain)."""
from . import code, diff, jsonshape, log, tabular, testreport, text

# The single seam where a later compressor (e.g. for built-in tool output) plugs in.
REGISTRY = {
    "json": jsonshape.compress,
    "testreport": testreport.compress,
    "diff": diff.compress,
    "tabular": tabular.compress,
    "code": code.compress,
    "log": log.compress,
    "text": text.compress,
}
