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
# Modified by oh-my-context-mod (github.com/prv-ctech/claude-code-linux), 2026-11-10: rewritten as the recovery store: one file per content-hash handle under OMC_HOME/recovery, byte cap, no eviction, section query (see vendor/NOTICE).

"""oh-my-context recovery store.

When a tool result is compressed, its exact original is kept here under a
content-hash handle, and the compressed text ends with a marker naming that
handle. The ``retrieve`` tool gives the original (or matching sections) back.

Rules: nothing is ever evicted or deleted by the gateway; a store that would pass
the byte cap is refused (the caller then returns the original uncompressed);
nothing here raises.
"""

from __future__ import annotations

import hashlib
import os
import re
import threading
from pathlib import Path

DEFAULT_CAP = 536870912  # 512 MiB; OMC_RECOVERY_MAX_BYTES overrides

_HANDLE_RE = re.compile(r"^omc_[0-9a-f]{32}$")
_MARKER_FMT = "<<omc:{}>> compressed view; call retrieve with this handle for the exact original"


def marker(handle: str) -> str:
    """The marker line (no newline) that ends every compressed text."""
    return _MARKER_FMT.format(handle)


def _dir() -> Path:
    from . import config

    return config.CONFIG_DIR / "recovery"


def _cap() -> int:
    try:
        v = int(os.environ.get("OMC_RECOVERY_MAX_BYTES", ""))
        if v > 0:
            return v
    except ValueError:
        pass
    return DEFAULT_CAP


def handle_for(data: bytes) -> str:
    return "omc_" + hashlib.sha256(data).hexdigest()[:32]


def stats() -> dict:
    total = n = 0
    try:
        for p in _dir().iterdir():
            if _HANDLE_RE.match(p.name):
                total += p.stat().st_size
                n += 1
    except OSError:
        pass
    return {"bytes": total, "cap": _cap(), "entries": n}


def store(original: str) -> str | None:
    """Keep ``original``; return its handle, or None when not stored."""
    try:
        if not isinstance(original, str) or not original:
            return None
        data = original.encode("utf-8")
        handle = handle_for(data)
        d = _dir()
        path = d / handle
        if path.exists() and path.stat().st_size == len(data):
            return handle
        st = stats()
        if st["bytes"] + len(data) > st["cap"]:
            return None
        d.mkdir(mode=0o700, parents=True, exist_ok=True)
        tmp = d / f".{handle}.tmp.{os.getpid()}.{threading.get_ident()}"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
        return handle
    except (OSError, UnicodeError):
        return None


def _sections(text: str) -> list[str]:
    return [s for s in re.split(r"\n[ \t]*\n+", text) if s.strip()]


def _query(text: str, query: str) -> str:
    words = {w for w in re.split(r"[^0-9a-zA-Z]+", query.lower()) if len(w) >= 2}
    scored = []
    for i, sec in enumerate(_sections(text)):
        have = set(re.split(r"[^0-9a-zA-Z]+", sec.lower()))
        score = len(words & have)
        if score:
            scored.append((score, i, sec))
    if not scored:
        return "no section matches; call retrieve without query for the full original"
    best = sorted(scored, key=lambda t: (-t[0], t[1]))[:20]
    best.sort(key=lambda t: t[1])
    out = best[0][2]
    for prev, cur in zip(best, best[1:]):
        out += ("\n\n" if cur[1] == prev[1] + 1 else "\n…\n") + cur[2]
    return out


def fetch(handle: str, query: str | None = None) -> tuple[str, str]:
    """Return ``(status, text)``; status in ok | not-found | corrupt | invalid-handle."""
    if not isinstance(handle, str) or not _HANDLE_RE.match(handle):
        return "invalid-handle", ""
    try:
        data = (_dir() / handle).read_bytes()
    except FileNotFoundError:
        return "not-found", ""
    except OSError:
        return "corrupt", ""
    if handle_for(data) != handle:
        return "corrupt", ""
    try:
        text = data.decode("utf-8")
    except UnicodeError:
        return "corrupt", ""
    return "ok", _query(text, query) if query else text


# Per-process dedupe: which handles this conversation already received.
_lock = threading.Lock()
_sent: set[str] = set()


def was_sent(handle: str) -> bool:
    with _lock:
        return bool(handle) and handle in _sent


def mark_sent(handle: str) -> None:
    if handle:
        with _lock:
            _sent.add(handle)
