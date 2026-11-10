# Copyright 2025-2026 activeing123
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# Modified by oh-my-context-mod (ticket 005). Rewritten for oh-my-context-mod ticket 005: shape compressors plus a recovery store (see vendor/NOTICE).

"""oh-my-context compressor: shrink routed tool results by shape, never lose data.

Pipeline per text result: skip small, detect the shape, run that shape's compressor
(`shapes.REGISTRY`), accept only a strictly shorter (and, for JSON, valid) output,
store the exact original in `recovery`, append the marker. Any failure returns None,
which means: use the original unchanged.
"""

from __future__ import annotations

import ast
import csv
import json
import re

from . import recovery, toon
from .shapes import REGISTRY
from .shapes.tabular import delimiter, md_table

MIN_BYTES = 512
MARKER_PREFIX = "<<omc:"

_LOG_RE = re.compile(
    r"(?i)\b(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|PANIC|CRIT|CRITICAL|ALERT|EMERG|EMERGENCY)\b"
    r"|^\s*\[[A-Z]+\]|\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}|\b\d{2}:\d{2}:\d{2}\b")
_BASE64_RE = re.compile(r"^[A-Za-z0-9+/\r\n]+={0,2}$")


def _test_report(text: str) -> bool:
    try:
        d = json.loads(text)
    except ValueError:
        d = None
    if isinstance(d, dict):
        return ((isinstance(d.get("tests"), list) and "exitcode" in d)
                or ("numFailedTests" in d and isinstance(d.get("testResults"), list)))
    return any(t.startswith(("<testsuites", "<testsuite")) for t in text.split(None, 16)[:16])


def _is_diff(text: str) -> bool:
    if not (text.startswith("diff --git ") or "\ndiff --git " in text or "\n@@ " in text
            or ("\n--- " in text and "\n+++ " in text)):
        return False
    return sum(1 for ln in text.split("\n") if ln.startswith(("+", "-", "@@", "diff "))) >= 4


def _is_tabular(text: str) -> bool:
    lines = text.split("\n")
    while lines and not lines[-1]:
        lines.pop()
    if md_table(lines):
        return True
    d = delimiter(lines[0]) if lines else None
    if not d:
        return False
    rows = list(csv.reader(lines, delimiter=d))
    n = len(rows[0])
    return len(rows) >= 8 and 2 <= n <= 128 and all(len(r) == n for r in rows)


def _is_code(text: str) -> bool:
    if text.startswith("#!"):
        return True
    if sum(1 for ln in text.split("\n") if ln.startswith(("def ", "class ", "import ", "from "))) < 3:
        return False
    try:
        ast.parse(text)
        return True
    except (SyntaxError, ValueError, RecursionError):
        return False


def _is_log(text: str) -> bool:
    lines = text.split("\n")
    if len(lines) < 4:
        return False
    hits = sum(1 for ln in lines if _LOG_RE.search(ln))
    return hits >= 3 and hits * 2 >= len(lines)


def detect_shape(text: str) -> str:
    s = text.strip()
    if s[:1] in ("{", "["):
        try:
            json.loads(s)
            return "testreport" if _test_report(s) else "json"
        except ValueError:
            pass
    if _test_report(text) if "<testsuite" in text[:2000] else False:
        return "testreport"
    for name, test in (("diff", _is_diff), ("tabular", _is_tabular), ("code", _is_code), ("log", _is_log)):
        try:
            if test(text):
                return name
        except Exception:
            pass
    return "text"


def _valid(shape: str, original: str, out: str) -> bool:
    if shape != "json":
        return True
    try:
        json.loads(out)
        return True
    except ValueError:
        return toon.decode(out) == json.loads(original)  # TOON output


def compress_text(text: str) -> str | None:
    """Compressed text with marker line, or None (use the original)."""
    try:
        if not isinstance(text, str) or MARKER_PREFIX in text:
            return None
        size = len(text.encode("utf-8"))
        if size < MIN_BYTES or "\x00" in text:
            return None
        s = text.strip()
        if len(s) >= 64 and (_BASE64_RE.match(s) or s.startswith("data:")):
            return None
        shape = detect_shape(text)
        out = REGISTRY[shape](text)
        if out is None or len(out.encode("utf-8")) >= size or not _valid(shape, text, out):
            return None
        # oh-my-context-mod: the marker counts; pass through unless the final text is shorter.
        if len(out.encode("utf-8")) + len(recovery.marker("omc_" + "0" * 32).encode("utf-8")) + 1 >= size:
            return None
        handle = recovery.store(text)
        if not handle:
            return None
        final = out + "\n" + recovery.marker(handle)
        from . import usage
        usage.add_saved_tokens(usage.count_tokens(text) - usage.count_tokens(final))
        return final
    except Exception:
        return None
