"""TOON encoder (and a decoder for tests): compact text for uniform arrays of objects.

Own implementation of the rules in specs/tickets/005. `encode_json(text)` returns the
TOON text or None when the value is not eligible.
"""
from __future__ import annotations

import json
import re

_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]*$")
_NUM_RE = re.compile(r"^-?\d+(\.\d+)?([eE][+-]?\d+)?$")


class _Num(str):
    """A JSON number kept as its lexical text."""


class _NotEligible(Exception):
    pass


def _pairs(pairs):
    d = {}
    for k, v in pairs:
        if k in d:
            raise _NotEligible
        d[k] = v
    return d


def _bad_const(_):
    raise _NotEligible


def _scalar(v) -> str:
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, _Num):
        return str(v)
    s = v
    if (not s or s != s.strip() or any(c in s for c in '\n\r\t":,')
            or s[0] in '[{"-' or s[0].isdigit() or s in ("true", "false", "null")):
        return json.dumps(s, ensure_ascii=False)
    try:
        float(s)
        return json.dumps(s, ensure_ascii=False)
    except ValueError:
        return s


def _is_scalar(v) -> bool:
    return not isinstance(v, (dict, list))


def _key(k: str) -> str:
    if not _KEY_RE.match(k):
        raise _NotEligible
    return k


def _array(name: str, arr: list, ind: str, out: list) -> None:
    n = len(arr)
    if n == 0:
        out.append(f"{ind}{name}[0]: []")
    elif all(_is_scalar(x) for x in arr):
        out.append(f"{ind}{name}[{n}]: " + ",".join(_scalar(x) for x in arr))
    elif all(isinstance(x, dict) for x in arr):
        keys = list(arr[0])
        if not keys or any(list(x) != keys for x in arr) or any(
                not _is_scalar(v) for x in arr for v in x.values()):
            raise _NotEligible
        out.append(f"{ind}{name}[{n}]{{{','.join(_key(k) for k in keys)}}}:")
        for x in arr:
            out.append(ind + "  " + ",".join(_scalar(x[k]) for k in keys))
    else:
        raise _NotEligible


def _entries(obj: dict, ind: str, out: list) -> None:
    for k in sorted(obj):
        v = obj[k]
        _key(k)
        if isinstance(v, dict):
            if v:
                out.append(f"{ind}{k}:")
                _entries(v, ind + "  ", out)
            else:
                out.append(f"{ind}{k}: {{}}")
        elif isinstance(v, list):
            _array(k, v, ind, out)
        else:
            out.append(f"{ind}{k}: {_scalar(v)}")


def encode_json(text: str) -> str | None:
    """TOON text for a JSON document, or None when not eligible."""
    try:
        v = json.loads(text, object_pairs_hook=_pairs, parse_float=_Num,
                       parse_int=_Num, parse_constant=_bad_const)
        out: list = []
        if isinstance(v, list):
            _array("", v, "", out)
        elif isinstance(v, dict) and v:
            _entries(v, "", out)
        else:
            return None
        return "\n".join(out)
    except (_NotEligible, ValueError, RecursionError):
        return None


# ─── decoder (tests) ───

def _cell(tok: str):
    if tok == "null":
        return None
    if tok == "true":
        return True
    if tok == "false":
        return False
    if tok.startswith('"'):
        return json.loads(tok)
    if _NUM_RE.match(tok):
        return json.loads(tok)
    return tok


def _split(s: str) -> list:
    cells, i = [], 0
    while True:
        if s[i:i + 1] == '"':
            _, end = json.JSONDecoder().raw_decode(s, i)
            cells.append(_cell(s[i:end]))
            i = end
        else:
            j = s.find(",", i)
            j = len(s) if j < 0 else j
            cells.append(_cell(s[i:j]))
            i = j
        if i >= len(s):
            return cells
        i += 1  # comma


_LINE_RE = re.compile(r"^( *)([A-Za-z_][A-Za-z0-9_.-]*)?(?:\[(\d+)\](?:\{([^}]*)\})?)?:(?: (.*))?$")


def decode(text: str):
    lines = text.split("\n")
    pos = [0]

    def block(indent: int) -> dict:
        d = {}
        while pos[0] < len(lines):
            m = _LINE_RE.match(lines[pos[0]])
            if len(m.group(1)) != indent:
                break
            d[m.group(2)] = item(m, indent)
        return d

    def item(m, indent: int):
        pos[0] += 1
        n, cols, rest = m.group(3), m.group(4), m.group(5)
        if cols is not None:
            names = cols.split(",")
            rows = []
            for _ in range(int(n)):
                rows.append(dict(zip(names, _split(lines[pos[0]].strip()))))
                pos[0] += 1
            return rows
        if n is not None:
            return [] if rest == "[]" else _split(rest)
        if rest == "{}":
            return {}
        if rest is not None:
            return _split(rest)[0] if rest.startswith('"') else _cell(rest)
        return block(indent + 2)

    m = _LINE_RE.match(lines[0])
    if m.group(2) is None and m.group(3) is not None:
        return item(m, 0)
    return block(0)
