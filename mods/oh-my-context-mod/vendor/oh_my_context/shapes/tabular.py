# Added by oh-my-context-mod (ticket 005): own implementation, not from upstream mcptoon.
"""tabular: CSV/TSV/Markdown tables; head, tail and notable rows, or TOON for CSV."""
import csv
import json
import re

from .. import toon

_KEEP = re.compile(r"(?i)\b(ERROR|FAIL|FAILED|FATAL|PANIC|EXCEPTION|WARNING|SECURITY|DENIED|REJECTED)\b")
_SEP = re.compile(r"^:?-{3,}:?$")


def md_table(lines) -> bool:
    if len(lines) < 2 or "|" not in lines[0]:
        return False
    cells = [c.strip() for c in lines[1].strip().strip("|").split("|")]
    return bool(cells) and all(_SEP.match(c) for c in cells)


def delimiter(first: str):
    return "\t" if first.count("\t") > first.count(",") and "\t" in first else ("," if "," in first else None)


def _toon(lines, delim):
    rows = list(csv.reader(lines, delimiter=delim))
    keys = rows[0]
    if len(set(keys)) != len(keys):
        return None
    num = re.compile(r"^-?\d+(\.\d+)?([eE][+-]?\d+)?$")
    recs = [dict(zip(keys, r)) for r in rows[1:]]
    # numbers become JSON numbers so TOON does not quote them
    doc = json.dumps([{k: (json.loads(v) if num.match(v) else v) for k, v in r.items()} for r in recs])
    return toon.encode_json(doc)


def compress(text: str):
    lines = text.split("\n")
    while lines and not lines[-1]:
        lines.pop()
    md = md_table(lines)
    head = 2 if md else 1
    data = lines[head:]
    if len(data) < 12:
        return None
    keep = set(range(3)) | {len(data) - 2, len(data) - 1}
    keep |= {i for i, ln in enumerate(data) if _KEEP.search(ln)}
    out, gap = lines[:head], 0
    for i, ln in enumerate(data):
        if i in keep:
            if gap:
                out.append(f"… {gap} rows elided …")
                gap = 0
            out.append(ln)
        else:
            gap += 1
    if gap:
        out.append(f"… {gap} rows elided …")
    best = "\n".join(out) if len(out) < len(lines) else None
    d = None if md else delimiter(lines[0])
    if d and len(lines) >= 8:
        t = _toon(lines, d)
        if t is not None and (best is None or len(t) < len(best)):
            best = t
    return best
