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
# Modified by oh-my-context-mod (github.com/prv-ctech/claude-code-linux), 2026-10-30: store under OMC_HOME/ccr, no TTL, one session per gateway process (no env overrides); renamed to oh-my-context: package, commands, tool, environment and path names (see vendor/NOTICE).

"""oh-my-context CCR — Compress, Cache, Retrieve (zero dependencies).

Why this exists
---------------
:mod:`oh_my_context.compressor` throws bytes away: it truncates strings and drops
array tails. On its own that is a one-way door — the moment a model needs the
detail that was dropped, the task stalls. CCR is the door back.

When a result is compressed, the **original** is written to a local store and the
compressed view carries a handle. If the model finds the summary insufficient it
calls ``retrieve`` with that handle and gets the full payload back.
Compression stops being lossy and becomes *lazy loading* — the decision to pay
for the detail is deferred to the model, which is the only party that knows
whether it needs it.

The lossless contract
---------------------
Compression may **hide** information from the context. It may never **destroy**
it. Three rules make that true; each one repairs a measured failure (the tests
that pin them live upstream):

1. **No timer destroys data.** Entries do not expire.
2. **Size is not a reason to lose data.** Payloads over 1 MB used to be refused
   outright, and the compressed view then carried **no handle at all** — a model
   was told "-52 items · 8 strings cut" with nowhere to go. Anything that fits in
   the store is now stored, and anything that cannot is *said out loud* by
   :func:`oh_my_context.compressor.notice` instead of silently.
3. **Failure is distinguishable.** ``retrieve`` used to answer ``None`` for four
   different situations (bad handle, never stored, evicted, unreadable), so a model
   could not tell "you misremembered the handle" from "that data is gone".
   :func:`retrieve_status` answers from a closed set instead.

Design choices worth naming:

* **Content-addressed handles.** The handle is a hash of the payload, so the
  same result stored twice is stored once — the store self-dedupes. That is also
  what makes session de-duplication possible (see below): the same payload always
  hashes to the same handle, so "have I already sent this?" is a set lookup.
* **Bounded by bytes, not by time.** The store is evicted oldest-first once it
  exceeds 200 MB. Eviction is the *only* way an entry disappears — and a handle
  that pointed at an evicted entry reports ``never-stored`` rather than
  returning empty data.
* **Sessions.** One gateway process serves one conversation (stdio), so the
  process remembers which payloads it already sent and can reply with a one-line
  reference instead of the body.
* **Never raises.** A failed store or retrieve degrades to "no handle" / a
  status — compression must not break a tool call because a temp file was busy.

This is the same idea as Headroom's ``headroom_retrieve`` tool
(``headroomlabs-ai/headroom``, Apache-2.0), reimplemented on the standard
library.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path
from typing import Any, NamedTuple

# The store is bounded by bytes, never by time.
_MAX_STORE_BYTES = 200_000_000

# ─── Closed status set (retrieve) ───
#
# Outcomes used to collapse into one `None`. They are different facts and a
# model needs to tell them apart.
STATUS_OK = "ok"
STATUS_BAD_HANDLE = "bad-handle"
STATUS_NEVER_STORED = "never-stored"
STATUS_UNREADABLE = "unreadable"


# ─── Closed reason set (store) ───
REASON_TOO_BIG = "too-big"
REASON_UNSERIALISABLE = "unserialisable"
REASON_WRITE_FAILED = "write-failed"


class StoreOutcome(NamedTuple):
    """What :func:`store_ex` did: the handle (or ``None``) and why, on failure.

    ``store`` alone cannot express "I could not keep this", and a caller that
    silently loses the reason is exactly how a compressed view ends up with no
    handle and no explanation. ``bytes`` is the serialised size, so a caller can
    say how large the thing it could not keep was.
    """

    handle: str | None
    reason: str | None = None
    bytes: int = 0


# ─── Store location ───

def _store_dir() -> Path:
    from .config import CONFIG_DIR

    return CONFIG_DIR / "ccr"


def _handle_for(server: str, tool: str, blob: str) -> str:
    """Content-addressed handle: the same payload always hashes the same."""
    raw = f"{server}:{tool}:{blob}".encode("utf-8", "replace")
    return hashlib.sha1(raw).hexdigest()[:12]


def _payload_blob(original: Any) -> str | None:
    try:
        return json.dumps(original, ensure_ascii=False)
    except (TypeError, ValueError):
        return None


# ─── Session bookkeeping ───
#
# De-duplication is only sound *inside one conversation*: telling a fresh session
# "same as handle X" would reference something it never saw. A gateway process is
# one conversation, so the sent-set lives as long as the process.

_session_lock = threading.Lock()
_session_sent: set[str] = set()


def was_sent(handle: str) -> bool:
    """True when this exact payload already went to the model this session."""
    with _session_lock:
        return bool(handle) and handle in _session_sent


def mark_sent(handle: str) -> None:
    """Record that ``handle``'s payload has now been sent to the model."""
    if handle:
        with _session_lock:
            _session_sent.add(handle)


# ─── Write half ───


def store_ex(original: Any, *, server: str, tool: str) -> StoreOutcome:
    """Persist ``original``; report the handle *and* why nothing was stored.

    Never raises: a busy temp file must not fail a tool call. The one refusal
    that survives is "larger than the whole store budget", because keeping such
    an entry would evict everything else and still not fit it.

    The entry this call just wrote is **exempt from the eviction pass**. That is
    not politeness: eviction sorts by mtime, files written in the same clock tick
    tie, and a tie can put the new entry first — which deleted the entry whose
    handle was about to be returned (reproduced 2026-10-02: budget 6,000, a 5,911
    byte payload, `store_ex` answered with a handle and the store was left with
    zero files). A handle that points at nothing is the exact failure this module
    exists to prevent.
    """
    blob = _payload_blob(original)
    if blob is None:
        return StoreOutcome(None, REASON_UNSERIALISABLE)

    handle = _handle_for(server, tool, blob)
    path = _store_dir() / f"{handle}.json"

    # Splice the already-serialised payload in rather than re-serialising the
    # wrapper: for a large result that second copy is the expensive part.
    head = json.dumps({
        "handle": handle, "server": server, "tool": tool,
        "ts": time.time(), "bytes": len(blob),
    }, ensure_ascii=False)
    text = f'{head[:-1]}, "original": {blob}}}'

    # The budget is compared against the bytes that actually land on disk, not
    # the payload alone: the wrapper adds a couple of hundred bytes, and judging
    # by the payload let an entry that "fits" be written and then immediately
    # evicted by its own cleanup pass.
    size = len(text.encode("utf-8"))
    if size > _MAX_STORE_BYTES:
        return StoreOutcome(None, REASON_TOO_BIG, size)

    try:
        _store_dir().mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{handle}.json.tmp.{os.getpid()}")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        return StoreOutcome(None, REASON_WRITE_FAILED, size)

    _maybe_evict(keep=handle)
    # Belt and braces: if the entry is somehow gone anyway, do not hand out a
    # handle to nothing — say it was not stored, so the notice is honest.
    if not path.exists():
        return StoreOutcome(None, REASON_WRITE_FAILED, size)
    return StoreOutcome(handle, None, size)


# ─── Read half ───


def retrieve_status(handle: str) -> tuple[str, Any | None]:
    """Return ``(status, original)``; status is one of the STATUS_* values.

    ``never-stored`` covers both "no such entry was ever written" and "it was
    evicted under the byte budget" — telling those apart would need a tombstone
    per evicted handle, which costs more than the distinction is worth. The
    important half is that the reference fails *loudly* with a specific reason
    instead of handing back empty data.
    """
    if not handle or not isinstance(handle, str):
        return STATUS_BAD_HANDLE, None
    # A handle is a hex digest prefix; reject anything else before touching disk.
    if not all(c in "0123456789abcdef" for c in handle):
        return STATUS_BAD_HANDLE, None

    path = _store_dir() / f"{handle}.json"
    try:
        entry = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return STATUS_NEVER_STORED, None
    except (OSError, json.JSONDecodeError):
        return STATUS_UNREADABLE, None
    if not isinstance(entry, dict):
        return STATUS_UNREADABLE, None
    return STATUS_OK, entry.get("original")


# One sentence per failure status, next to the closed status set it describes.
# The status is only useful if it changes what the reader does next: retype it,
# fetch it again, or stop asking.
RETRIEVE_NOTICES = {
    STATUS_BAD_HANDLE: "That handle is not a handle (they are 12 lowercase hex "
                       "characters, copied from a 'retrieve handle=...' line).",
    STATUS_NEVER_STORED: "No stored result for that handle. Either it was never "
                         "compressed, or the store evicted it to stay under its size "
                         "budget — call the tool again to regenerate it.",
    STATUS_UNREADABLE: "The stored entry exists but could not be read (damaged or "
                       "unreadable file). Call the tool again to regenerate it.",
}


def retrieve_notice(status: str) -> str:
    """The one-sentence explanation for a failed :func:`retrieve_status`.

    Unknown statuses fall back to the ``unreadable`` sentence, because "the store
    exists but I cannot use it" is the honest description of any outcome this
    table does not name.
    """
    return RETRIEVE_NOTICES.get(status, RETRIEVE_NOTICES[STATUS_UNREADABLE])


def _maybe_evict(keep: str | None = None) -> int:
    """Evict oldest entries while the store is over budget. Returns the count.

    This is the only way an entry disappears, so it is also the only way a previously issued handle can go stale. Handles that
    do go stale report ``never-stored`` on read.

    ``keep`` names a handle that must survive this pass — :func:`store_ex` passes
    the entry it just wrote, because mtime ties make "newest" a guess rather than
    a fact, and evicting the entry whose handle is about to be returned produces
    exactly the silent dead end this module exists to prevent. The byte budget
    still holds: an entry is only ever written when it fits the budget alone, so
    keeping it while evicting everything else cannot leave the store over budget.
    """
    d = _store_dir()
    budget = _MAX_STORE_BYTES
    try:
        files = [(p, p.stat().st_mtime, p.stat().st_size) for p in d.glob("*.json")]
    except OSError:
        return 0
    total = sum(size for _, _, size in files)
    if total <= budget:
        return 0
    keep_name = f"{keep}.json" if keep else None
    removed = 0
    for path, _, size in sorted(files, key=lambda f: f[1]):
        if total <= budget:
            break
        if keep_name and path.name == keep_name:
            continue
        try:
            path.unlink()
            total -= size
            removed += 1
        except OSError:
            continue
    return removed


