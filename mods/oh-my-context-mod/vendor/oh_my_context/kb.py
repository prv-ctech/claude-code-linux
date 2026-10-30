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
# Modified by oh-my-context-mod (github.com/prv-ctech/claude-code-linux), 2026-10-30: local files only (the URL fetch is removed: no network); renamed to oh-my-context: package, commands, tool, environment and path names (see vendor/NOTICE).

"""oh-my-context kb — search *inside* documents (the kb_index and kb_search tools).

It chunks the text, stores the chunks in SQLite FTS5, and returns the matching
windows. The document never enters the context whole; only the passages that
matched do. oh-my-context-mod: local files only; nothing is fetched.

Why two indexes instead of one
------------------------------
Neither tokenizer is enough alone (both failures reproduced here):

* **porter** stems words, so "caching" finds "cached"/"caches". But it cannot
  match a *fragment*: "useEff" does not find "useEffect".
* **trigram** matches substrings, so "useEff" finds "useEffect". But it has no
  notion of word boundaries, so it is noisy on prose.

Running both and merging with **Reciprocal Rank Fusion** gives a document that
ranks well in *either* strategy a place near the top, instead of a cascade where
the second index only runs when the first returns nothing. RRF is rank-based, so
the two indexes never have to agree on a score scale.

Everything here is standard library: ``sqlite3`` (FTS5 ships with CPython on
Windows/macOS/Linux). Zero dependencies, same as the rest of the package.

Honest limits, stated rather than hidden
----------------------------------------
* **FTS5 must be present.** It is in CPython's bundled SQLite on every platform
  this project targets, but ``kb`` checks and says so plainly if it is not,
  instead of dying with an ``OperationalError``.
* **Trigram needs SQLite >= 3.34.** Below that the substring half is skipped and
  search degrades to porter-only, which the result carries as a note.
"""

from __future__ import annotations

import re
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from collections.abc import Iterable
from typing import Any

# ─── Defaults ───

#: Rows older than this are dropped on write. A content index is a cache, not an
#: archive — keeping it bounded is what stops it growing into a second repo.
RETENTION_DAYS = 14

#: Chunks bigger than this are split on paragraph boundaries. A 40 KB single
#: heading with no subheadings is common in generated docs and would otherwise
#: be one unusable chunk.
MAX_CHUNK_CHARS = 4000

#: Chars of context returned around a hit.
SNIPPET_BEFORE = 120
SNIPPET_AFTER = 260

#: RRF's rank constant. 60 is the value from the original paper (Cormack et al.,
#: 2009) and what every RRF implementation in the wild uses; changing it changes
#: how sharply top ranks dominate.
RRF_K = 60


class KBError(Exception):
    """A problem the caller can fix (no FTS5, missing index, missing file)."""


# ─── Storage ───

def _db_path() -> Path:
    from .config import CONFIG_DIR

    return CONFIG_DIR / "kb" / "content.sqlite"


def _have_fts5(con: sqlite3.Connection) -> bool:
    try:
        con.execute("CREATE VIRTUAL TABLE temp.__fts_probe USING fts5(x)")
        con.execute("DROP TABLE temp.__fts_probe")
        return True
    except sqlite3.OperationalError:
        return False


def _have_trigram(con: sqlite3.Connection) -> bool:
    try:
        con.execute("CREATE VIRTUAL TABLE temp.__tri_probe USING fts5(x, tokenize='trigram')")
        con.execute("DROP TABLE temp.__tri_probe")
        return True
    except sqlite3.OperationalError:
        return False


def _connect() -> sqlite3.Connection:
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(path))
    if not _have_fts5(con):
        con.close()
        raise KBError(
            "this Python's SQLite has no FTS5, so the knowledge base cannot index "
            f"(sqlite {sqlite3.sqlite_version}). Use a Python built against SQLite with FTS5."
        )
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS chunks (
            doc_id     INTEGER PRIMARY KEY,
            source     TEXT NOT NULL,
            title      TEXT NOT NULL DEFAULT '',
            ord        INTEGER NOT NULL DEFAULT 0,
            body       TEXT NOT NULL,
            fetched_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
        """
    )
    # FTS5 external-content tables mirror `chunks`. External content keeps one
    # copy of the text on disk instead of three (chunks + 2 FTS tables).
    con.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_porter USING fts5("
        "title, body, content='chunks', content_rowid='doc_id', tokenize='porter')"
    )
    if _have_trigram(con):
        con.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_tri USING fts5("
            "title, body, content='chunks', content_rowid='doc_id', tokenize='trigram')"
        )
    con.commit()
    return con


def _rebuild_fts(con: sqlite3.Connection) -> None:
    con.execute("INSERT INTO chunks_porter(chunks_porter) VALUES('rebuild')")
    row = con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_tri'"
    ).fetchone()
    if row:
        con.execute("INSERT INTO chunks_tri(chunks_tri) VALUES('rebuild')")
    con.commit()


# ─── Chunking ───

def _split_long(text: str, limit: int) -> list[str]:
    """Split an over-long chunk on paragraph boundaries, then hard-wrap."""
    if len(text) <= limit:
        return [text]
    out: list[str] = []
    buf: list[str] = []
    size = 0
    for para in re.split(r"\n\s*\n", text):
        if size + len(para) + 2 > limit and buf:
            out.append("\n\n".join(buf))
            buf, size = [], 0
        if len(para) > limit:
            # A single paragraph longer than the limit: hard-wrap it.
            if buf:
                out.append("\n\n".join(buf))
                buf, size = [], 0
            for i in range(0, len(para), limit):
                out.append(para[i:i + limit])
            continue
        buf.append(para)
        size += len(para) + 2
    if buf:
        out.append("\n\n".join(buf))
    return out


def chunk_markdown(text: str, *, max_chars: int = MAX_CHUNK_CHARS) -> list[tuple[str, str]]:
    """Split markdown into ``(title, body)`` chunks at headings, code fences intact.

    Fences matter: a ``# comment`` inside a ``` block is not a heading, and
    splitting on it would slice a code sample in half. The fence flag is the
    whole reason this is a loop and not a regex split.
    """
    lines = text.splitlines()
    chunks: list[tuple[str, str]] = []
    title = ""
    buf: list[str] = []
    in_fence = False

    def flush() -> None:
        if not buf:
            return
        body = "\n".join(buf).strip("\n")
        if not body.strip():
            return
        for piece in _split_long(body, max_chars):
            chunks.append((title, piece))

    for line in lines:
        stripped = line.lstrip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            buf.append(line)
            continue
        if not in_fence and re.match(r"^#{1,6}\s", line):
            flush()
            buf = []
            title = line.lstrip("#").strip()
            buf.append(line)
            continue
        buf.append(line)
    flush()
    return chunks


def chunk_text(text: str, *, max_chars: int = MAX_CHUNK_CHARS) -> list[tuple[str, str]]:
    """Plain-text chunking: fixed windows on paragraph boundaries, no titles."""
    out: list[tuple[str, str]] = []
    for piece in _split_long(text, max_chars):
        out.append(("", piece))
    return out


# ─── Indexing ───

@dataclass
class IndexReport:
    source: str
    chunks: int
    bytes: int
    skipped: bool = False
    reason: str | None = None
    notes: list[str] | None = None

    def as_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "source": self.source, "chunks": self.chunks,
            "bytes": self.bytes, "skipped": self.skipped,
        }
        if self.reason:
            d["reason"] = self.reason
        if self.notes:
            d["notes"] = self.notes
        return d


def _sweep(con: sqlite3.Connection) -> int:
    cutoff = time.time() - RETENTION_DAYS * 86400
    cur = con.execute("DELETE FROM chunks WHERE fetched_at < ?", (cutoff,))
    removed = cur.rowcount or 0
    if removed:
        con.commit()
        _rebuild_fts(con)
    return removed


def index_text(source: str, text: str, *, title: str = "",
               markdown: bool = True) -> IndexReport:
    """Replace every chunk for ``source`` with the chunks of ``text``."""
    con = _connect()
    try:
        chunks = chunk_markdown(text) if markdown else chunk_text(text)
        if not chunks:
            return IndexReport(source, 0, len(text.encode("utf-8")),
                               skipped=True, reason="empty document")
        con.execute("DELETE FROM chunks WHERE source = ?", (source,))
        now = time.time()
        rows = []
        for i, (t, body) in enumerate(chunks):
            rows.append((source, t or title, i, body, now))
        con.executemany(
            "INSERT INTO chunks(source, title, ord, body, fetched_at) "
            "VALUES(?,?,?,?,?)", rows,
        )
        con.commit()
        _rebuild_fts(con)
        removed = _sweep(con)
        notes = []
        if removed:
            notes.append(f"dropped {removed} chunk(s) older than {RETENTION_DAYS} days")
        return IndexReport(source, len(chunks), len(text.encode("utf-8")), notes=notes)
    finally:
        con.close()


def index_file(path: str, *, source: str | None = None) -> IndexReport:
    p = Path(path).expanduser()
    if not p.is_file():
        raise KBError(f"file not found: {path}")
    text = p.read_text(encoding="utf-8", errors="replace")
    is_md = p.suffix.lower() in (".md", ".markdown", ".mdx")
    return index_text(source or str(p), text, markdown=is_md)


# ─── Search ───

def _levenshtein(a: str, b: str, cap: int = 2) -> int:
    if abs(len(a) - len(b)) > cap:
        return cap + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1,
                           prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _vocabulary(con: sqlite3.Connection, limit: int = 4000) -> set[str]:
    """Distinct words in the index, for typo correction.

    Bounded: a huge index would make every query O(vocabulary). 4,000 words
    covers the real cases (a typo in a word that appears in the corpus) without
    scanning a 200k-word index on every keystroke.
    """
    words: set[str] = set()
    for (body,) in con.execute("SELECT body FROM chunks LIMIT 2000"):
        for w in re.findall(r"[A-Za-z][A-Za-z0-9_-]{2,}", body.lower()):
            words.add(w)
            if len(words) >= limit:
                return words
    return words


def _correct_terms(terms: Iterable[str], vocab: set[str]) -> tuple[list[str], list[str]]:
    fixed: list[str] = []
    corrections: list[str] = []
    for t in terms:
        low = t.lower()
        if low in vocab or len(low) < 4:
            fixed.append(t)
            continue
        best, best_d = None, 3
        for w in vocab:
            if abs(len(w) - len(low)) > 2:
                continue
            d = _levenshtein(low, w)
            if d < best_d:
                best, best_d = w, d
                if d == 1:
                    break
        if best and best_d <= 2:
            fixed.append(best)
            corrections.append(f"{t}→{best}")
        else:
            fixed.append(t)
    return fixed, corrections


def _fts_query(terms: list[str]) -> str:
    """Build a safe FTS5 MATCH expression: quoted terms, OR-ed.

    Quoting is not cosmetic: a raw user query containing ``-`` or ``:`` is
    FTS5 syntax (column filter, NOT operator) and would either error or silently
    change meaning. Every term becomes a quoted string; prefix matching is added
    on the last term so "kubernet" finds "kubernetes" while typing.
    """
    clean = []
    for t in terms:
        t = t.replace('"', "")
        if t.strip():
            clean.append(f'"{t}"')
    if not clean:
        return ""
    # Last term gets a prefix star so a partial word still matches.
    clean[-1] = clean[-1] + "*"
    return " OR ".join(clean)


def _snippet(body: str, terms: list[str]) -> str:
    """A window around the first term hit — not a head truncation.

    Truncating the head of a long chunk is how you return the table of contents
    instead of the answer. Finding where the query actually appears and taking a
    window around it is the difference between a snippet and a teaser.
    """
    low = body.lower()
    pos = -1
    for t in terms:
        p = low.find(t.lower())
        if p >= 0 and (pos < 0 or p < pos):
            pos = p
    if pos < 0:
        return body[:SNIPPET_BEFORE + SNIPPET_AFTER].strip()
    start = max(0, pos - SNIPPET_BEFORE)
    end = min(len(body), pos + SNIPPET_AFTER)
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(body) else ""
    return (prefix + body[start:end].strip() + suffix)


@dataclass
class Hit:
    source: str
    title: str
    snippet: str
    score: float
    ord: int

    def as_dict(self) -> dict[str, Any]:
        return {"source": self.source, "title": self.title,
                "snippet": self.snippet, "score": round(self.score, 5),
                "ord": self.ord}


@dataclass
class SearchReport:
    query: str
    hits: list[Hit]
    notes: list[str]

    def as_dict(self) -> dict[str, Any]:
        return {"query": self.query,
                "hits": [h.as_dict() for h in self.hits],
                "notes": self.notes}


def search(query: str, *, k: int = 5, source: str | None = None) -> SearchReport:
    """Ranked passages for ``query`` via porter + trigram, fused with RRF."""
    terms = [t for t in re.findall(r"[A-Za-z0-9_][A-Za-z0-9_-]*", query) if t]
    if not terms:
        raise KBError("query has no searchable terms")
    if k <= 0:
        raise KBError("k must be positive")

    con = _connect()
    notes: list[str] = []
    try:
        if not con.execute("SELECT 1 FROM chunks LIMIT 1").fetchone():
            raise KBError("the knowledge base is empty. Index a file first with kb_index.")

        vocab = _vocabulary(con)
        terms, corrections = _correct_terms(terms, vocab)
        if corrections:
            notes.append("corrected: " + ", ".join(corrections))

        expr = _fts_query(terms)
        if not expr:
            raise KBError("query has no searchable terms")

        src_clause = ""
        params: list[Any] = [expr]
        if source:
            src_clause = " AND c.source LIKE ?"
            params.append(f"%{source}%")

        porter_rows = con.execute(
            "SELECT c.doc_id FROM chunks_porter f JOIN chunks c ON c.doc_id = f.rowid "
            "WHERE chunks_porter MATCH ?" + src_clause +
            " ORDER BY bm25(chunks_porter, 5.0, 1.0) LIMIT 50",
            params,
        ).fetchall()

        tri_rows: list[tuple] = []
        has_tri = con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_tri'"
        ).fetchone()
        if has_tri:
            tri_rows = con.execute(
                "SELECT c.doc_id FROM chunks_tri f JOIN chunks c ON c.doc_id = f.rowid "
                "WHERE chunks_tri MATCH ?" + src_clause +
                " ORDER BY bm25(chunks_tri, 5.0, 1.0) LIMIT 50",
                params,
            ).fetchall()
        else:
            notes.append("trigram index unavailable (SQLite < 3.34): substring "
                         "matching skipped, porter only")

        # Reciprocal Rank Fusion: score = Σ 1/(K + rank). Rank-based, so the two
        # indexes never need a shared score scale.
        fused: dict[int, float] = {}
        for rows in (porter_rows, tri_rows):
            for rank, (doc_id,) in enumerate(rows):
                fused[doc_id] = fused.get(doc_id, 0.0) + 1.0 / (RRF_K + rank + 1)

        # Proximity rerank: a passage where the query terms sit close together is
        # a better answer than one where they are pages apart.
        for doc_id in list(fused):
            body = con.execute(
                "SELECT body FROM chunks WHERE doc_id = ?", (doc_id,)
            ).fetchone()[0]
            low = body.lower()
            positions = [low.find(t.lower()) for t in terms]
            if all(p >= 0 for p in positions):
                span = max(positions) - min(positions)
                fused[doc_id] += 1.0 / (RRF_K + 1 + span / 200.0)

        top = sorted(fused.items(), key=lambda kv: -kv[1])[:k]
        hits: list[Hit] = []
        for doc_id, score in top:
            row = con.execute(
                "SELECT source, title, body, ord FROM chunks WHERE doc_id = ?",
                (doc_id,),
            ).fetchone()
            if not row:
                continue
            src, title, body, ordn = row
            hits.append(Hit(src, title, _snippet(body, terms), score, ordn))
        return SearchReport(query, hits, notes)
    finally:
        con.close()
