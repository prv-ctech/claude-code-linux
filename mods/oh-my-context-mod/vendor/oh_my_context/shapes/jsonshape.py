"""json: TOON when shorter, else array elision."""
import json
import re

from .. import toon

_KEEP_RE = re.compile(r"(?i)error|failed|fatal|timeout|exception|panic")
_VERBATIM_KEY = re.compile(
    r"(?i)^(error|errors|message|msg|stack|stacktrace|stack_trace|trace|traceback|exception|reason|detail|details|warning|warnings)$")
_MAX_KEPT = 50


def _dump(v) -> str:
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def _walk(node, state):
    if isinstance(node, dict):
        return {k: (v if _VERBATIM_KEY.match(k) else _walk(v, state)) for k, v in node.items()}
    if not isinstance(node, list):
        return node
    n = len(node)
    if n <= 8:
        return [_walk(x, state) for x in node]
    keep = {0, 1, 2, n - 2, n - 1}
    for i in range(3, n - 2):
        if len(keep) >= _MAX_KEPT:
            break
        if _KEEP_RE.search(_dump(node[i])):
            keep.add(i)
    out, gap = [], 0
    for i, x in enumerate(node):
        if i in keep:
            if gap:
                out.append({"__omc_elided__": gap})
                gap = 0
            out.append(_walk(x, state))
        else:
            gap += 1
            state["elided"] = True
    if gap:
        out.append({"__omc_elided__": gap})
    return out


def compress(text: str):
    toon_text = toon.encode_json(text)
    if toon_text is not None and len(toon_text.encode()) < len(text.encode()):
        return toon_text
    state = {}
    out = _walk(json.loads(text), state)
    return _dump(out) if state else None
