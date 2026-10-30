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
# Modified by oh-my-context-mod (github.com/prv-ctech/claude-code-linux), 2026-10-30: only the index the plugin builds from its catalog (`skills index <dir>`) and the BM25 resolve over it are kept; skills are indexed by their frontmatter name; renamed to oh-my-context: package, commands, tool, environment and path names (see vendor/NOTICE).

"""
oh-my-context skills — skill-catalog index + compression-safe routing.

The problem
-----------
An agent's skill catalog is a fixed tax: every skill's ``name: description``
sits in the session context whether it is used or not. Trimming it to bare
names saves ~93% of the tokens but costs about half the routing accuracy,
because skill names are often not self-explanatory (``houtai`` is a backend,
``kao`` is a memory quiz, ``tu-kami`` is PDF typesetting) — unlike MCP tool
names, which read as verbs.

The fix
-------
Do not compress what the model sees; move the full catalog out of context and
retrieve from it:

  1. ``index``   — scan skill roots, keep slug/description/triggers/aliases on
                   disk. Never injected into the session.
  2. ``resolve`` — zero-dependency BM25 shortlist over that index. Deterministic,
                   no LLM, no tokens.

Measured upstream on a 370-skill / 40-task set: the shortlist stage is 100%
recall when aliases are resolved.

Zero dependencies: standard library only.
"""
import hashlib
import json
import math
import os
import re
import threading
from collections import Counter, defaultdict
from pathlib import Path

from .config import CONFIG_DIR

INDEX_VERSION = 1


# ═══════════════════════════════════════════════════
# Paths
# ═══════════════════════════════════════════════════

def _index_path() -> Path:
    return CONFIG_DIR / "skills-index.json"


def _clean_desc(desc: str) -> str:
    """A description with any surrounding YAML quotes removed.

    The indexer stores the raw frontmatter value, which for many skills is
    YAML-quoted (``description: "…"``). Both the rendered output and BM25 must
    see the same cleaned text, so a description is never quoted in one place and
    bare in another. Only a matching pair at the very start/end is stripped —
    internal quotes are content and are preserved.
    """
    desc = desc or ""
    if len(desc) >= 2 and desc[0] == desc[-1] and desc[0] in ("'", '"'):
        return desc[1:-1]
    return desc


def _same_file_bytes(a: Path, b: Path) -> bool:
    """True when two ``SKILL.md`` files hold byte-identical content.

    The size check short-circuits the common case (a real conflict has different
    text, so its size almost always differs) and keeps the full read for the case
    that actually needs it. Any I/O failure reads as "not the same", which keeps
    an unreadable copy visible instead of silently dropping a skill.
    """
    try:
        if a.stat().st_size != b.stat().st_size:
            return False
        return a.read_bytes() == b.read_bytes()
    except OSError:
        return False


# ═══════════════════════════════════════════════════
# Scanning
# ═══════════════════════════════════════════════════

def _triggers(desc: str) -> list[str]:
    """Pull trigger words out of a description.

    Descriptions carry them as ``触发词：/a、b、c`` or ``Triggers: x / y``. The
    router needs them because a bare skill name is frequently uninformative.
    """
    m = re.search(r"(?:触发词|触发|Triggers?)\s*[:：]\s*(.+)", desc or "", re.I)
    if not m:
        return []
    parts = re.split(r"[、,，/|;；\s]+", m.group(1))
    out = []
    for p in parts:
        p = p.strip().lstrip("/").strip()
        if p and len(p) <= 24 and p not in out:
            out.append(p)
    return out


def _alias_target(desc: str) -> str:
    """``别名转发：/archify → /tu-archify`` yields ``tu-archify``; else ``""``.

    Alias cards are pointer stubs. Left unresolved they compete with their own
    target in retrieval and split the vote.
    """
    if "别名转发" not in (desc or ""):
        return ""
    m = re.search(r"→\s*/?([A-Za-z0-9_\-]+)", desc)
    return m.group(1).lower() if m else ""


def _split_terms(text: str, keep_whole: bool = False) -> list[str]:
    """Split a trigger line into individual terms.

    ``keep_whole`` is for list items: a short item with no separator is one term
    (``做 PDF``, ``landing page``), not two — splitting on whitespace would shred
    multi-word triggers.
    """
    text = (text or "").strip()
    if keep_whole and text and len(text) <= 24 and not re.search(r"[、,，/|;；]", text):
        return [text.lstrip("/").strip()]
    return [p.strip().lstrip("/").strip()
            for p in re.split(r"[、,，/|;；\s]+", text) if p.strip()]


def _body_triggers(body: str) -> list[str]:
    """Mine retrieval terms from a SKILL.md *body*.

    Retrieval quality is otherwise hostage to how well each author wrote the
    frontmatter description — and most authors do not write one well. Measured on
    this machine's catalog: stripping the trigger clause from descriptions drops
    top-1 recall from 92.5% to 80%, and this recovery puts it back at 95%.

    Triggers, slash-commands and headings are already written down for humans;
    this reads them back so the router can use them. The file is untouched.
    Authors write triggers two ways — ``触发词：a、b`` on one line, or a
    ``## 触发词`` heading followed by a list — so both are handled.
    """
    body = body or ""
    found: list[str] = []
    lines = body.splitlines()
    # A trigger declaration starts the line (after markdown markers). Requiring the
    # anchor matters: "正文也没有触发词" is a *negative* sentence, not a declaration,
    # and reading it as one would invent triggers out of prose.
    decl = re.compile(r"^\s*(?:[-*•]\s*|\d+[.)]\s*|#{1,6}\s*)*(?:触发词|触发|Triggers?)\s*[:：]?\s*(.*)$",
                      re.I)
    i = 0
    while i < len(lines):
        m = decl.match(lines[i])
        if m:
            if m.group(1):
                found += _split_terms(m.group(1))
            # continuation: list items / short or separator-bearing lines, until a
            # heading or the blank line that ends the block
            j, taken = i + 1, 0
            while j < len(lines) and taken < 12:
                nxt = lines[j].strip()
                if not nxt:
                    if taken:
                        break
                    j += 1
                    continue
                if nxt.startswith("#") or decl.match(lines[j]):
                    break
                is_item = bool(re.match(r"^[-*•]\s+|^\d+[.)]\s+", nxt))
                if is_item or len(nxt) <= 24 or re.search(r"[、,，/|;；]", nxt):
                    found += _split_terms(
                        re.sub(r"^[-*•]\s+|^\d+[.)]\s+", "", nxt), keep_whole=is_item)
                    taken += 1
                    j += 1
                else:
                    break
            i = j
            continue
        i += 1
    found += re.findall(r"/([a-z][a-z0-9\-]{2,})", body)
    found += [h.strip() for h in re.findall(r"^#{1,3}\s+(.+)$", body, re.M)]
    out: list[str] = []
    seen = set()
    for t in found:
        t = t.strip()
        low = t.lower()
        if 1 < len(t) <= 30 and low not in seen and not re.fullmatch(r"触发词|触发|triggers?", low):
            seen.add(low)
            out.append(t)
    return out[:40]


def _walk_skill_dirs(base: Path, seen: set[str]):
    """Yield ``(slug, skill_md_path)`` anywhere under ``base``, depth-first.

    Skills nest: a catalog ships sub-catalogs (``<skill>/skills/<slug>/``) and
    bundled examples. A one-level walk indexed 376 of this machine's 405 skills
    and silently hid the other 29 — including the whole ``video-seedance``
    sub-family, which is the reason a one-line catalog entry can point at a
    family at all. Directories are visited once by resolved real path, so a
    junction pointing back into the tree cannot loop.

    ``os.scandir`` rather than ``iterdir``: it answers ``is_dir`` from the
    directory entry it already read instead of a fresh ``stat`` per child, which
    is the difference between a 350ms and a 50ms walk of this machine's catalog.
    The dedup key is ``realpath``, not ``st_ino`` — Windows reports ``st_ino``
    as 0 for junctions, so an inode key would collapse every junction onto one
    and silently drop the skills behind it.
    """
    dkey = os.path.normcase(os.path.realpath(base))
    if dkey in seen:
        return
    seen.add(dkey)
    try:
        with os.scandir(base) as it:
            entries = sorted(it, key=lambda e: e.name)
    except OSError:
        return
    for entry in entries:
        try:
            if not entry.is_dir(follow_symlinks=True):
                continue
        except OSError:
            continue
        if _skip_dir(entry.name):
            continue
        child = Path(entry.path)
        md = _find_skill_md(child)
        if md is not None:
            yield entry.name, md
        yield from _walk_skill_dirs(child, seen)


def _find_skill_md(directory: Path) -> Path | None:
    """The skill manifest in ``directory``, or None. Case-insensitive on name.

    One ``stat`` on the canonical spelling first — it hits for 386 of this
    machine's 407 skills, and on Windows it also answers for the 21 that spell
    the name ``skill.md``, because NTFS folds case. Only when that fails (i.e.
    on a case-sensitive filesystem holding a lower-case manifest) is the
    directory listed, which is the expensive path and therefore the rare one.

    Case folding is not decoration: 21 skills here ship ``skill.md``, and a
    strict ``== "SKILL.md"`` silently dropped every one of them. ``child /
    "SKILL.md"`` alone would find them on Windows and miss them on Linux, so the
    catalog would differ by platform; both spellings are accepted explicitly.
    """
    canonical = directory / "SKILL.md"
    if canonical.is_file():
        return canonical
    try:
        names = [e.name for e in os.scandir(directory)]
    except OSError:
        return None
    for name in names:
        if name.lower() == "skill.md":
            candidate = directory / name
            if candidate.is_file():
                return candidate
    return None


def _iter_skill_dirs(root: Path):
    """Yield ``(slug, skill_md_path)`` for one root, recursively.

    Accepts both layouts seen in the wild — ``<root>/<slug>/SKILL.md`` and
    ``<root>/skills/<slug>/SKILL.md`` — and keeps descending past a skill
    directory, because a skill may carry nested skills of its own. The second
    layout is usually already inside the first, and sharing one ``seen`` set is
    what keeps it from being walked twice.
    """
    seen: set[str] = set()
    for base in (root, root / "skills"):
        if not base.is_dir():
            continue
        yield from _walk_skill_dirs(base, seen)


def scan_roots(roots: list[Path]) -> dict:
    """Build an index dict from skill roots. Read-only; never writes to roots.

    Roots are de-duplicated by resolved real path first. Agent skill folders are commonly junctions onto one real catalog, so
    a naive walk would index the catalog once per alias and emit a
    ``SKILL_DUPLICATE`` per file — noise, not a real conflict. A machine with no
    aliases sees no change, because distinct roots keep distinct real paths.

    Real paths do not catch a **copy**, though: a view that holds its own byte
    copy of a skill (rather than a junction) has a distinct real path, so the
    walk reaches it and, before this, indexed it a second time. A copy carries
    the same slug and the same bytes, so it is the same skill seen twice; only a
    same-slug file with *different* bytes is a real conflict worth a warning.
    """
    from .plugin import parse_skill_md  # local: import-light

    skills: list[dict] = []
    warnings: list[dict] = []
    seen: dict[str, str] = {}
    seen_files: set[str] = set()
    seen_roots: set[str] = set()
    for root in roots:
        if not root.is_dir():
            warnings.append({"code": "ROOT_MISSING", "message": f"skill root not found: {root}"})
            continue
        try:
            root_key = str(root.resolve())
        except OSError:
            root_key = str(root)
        if root_key in seen_roots:
            continue  # alias of a root already walked — not a duplicate skill
        seen_roots.add(root_key)
        for slug, md in _iter_skill_dirs(root):
            try:
                md_key = str(md.resolve())
            except OSError:
                md_key = str(md)
            if md_key in seen_files:
                continue  # same real SKILL.md reached through another root
            seen_files.add(md_key)
            try:
                name, desc, body = parse_skill_md(md)
            except OSError as exc:
                warnings.append({"code": "SKILL_UNREADABLE", "message": f"{md}: {exc}"})
                continue
            if name:
                # oh-my-context-mod: the plugin writes the invocable Skill id (e.g.
                # "superpowers:brainstorming") as the name; resolve returns it.
                slug = name
            if not desc:
                warnings.append({
                    "code": "SKILL_NO_DESC",
                    "message": f"{slug}: empty description — routing will miss it",
                })
            key = slug.lower()
            prev = seen.get(key)
            if prev is not None:
                # A second file with the same slug is either a byte-identical
                # copy of the first (agent folders get *copied*, not only
                # junctioned — the same skill, so index it once) or genuinely
                # different text (two skills competing for one name — warn).
                if _same_file_bytes(Path(prev), md):
                    continue
                warnings.append({
                    "code": "SKILL_DUPLICATE",
                    "message": f"{slug}: also found at {seen[key]} — duplicates dilute retrieval",
                })
            else:
                seen[key] = str(md)
            front = _triggers(desc)
            extra = [t for t in _body_triggers(body)
                     if t.lower() not in {f.lower() for f in front}]
            skills.append({
                "slug": slug,
                "name": name or slug,
                "desc": desc,
                "triggers": front + extra,
                "alias_of": _alias_target(desc),
                "root": str(root),
            })
    return {
        "version": INDEX_VERSION,
        "roots": [str(r) for r in roots],
        # Lets a later run tell — cheaply and exactly — whether the catalog still
        # matches. Computed from the same walk that produced `skills`, so the two
        # cannot disagree about which files the catalog covers.
        "signature": catalog_signature(roots),
        "skills": skills,
        "warnings": warnings,
    }


def build_and_save(roots: list[Path]) -> tuple[dict, Path]:
    """Scan ``roots`` and write the index atomically (tmp + ``os.replace``).

    Atomic because the index is now rebuilt automatically, possibly while another
    process is reading it: a reader must see the old index or the new one, never a
    half-written file.
    """
    index = scan_roots(roots)
    path = _index_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp.{os.getpid()}")
    tmp.write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)
    return index, path


def load_index() -> dict:
    """Load the built index; ``{}`` when absent or unreadable."""
    path = _index_path()
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


# ═══════════════════════════════════════════════════
# Catalog views for the MCP tools
# ═══════════════════════════════════════════════════

def catalog_rows(index: dict, *, include_aliases: bool = False) -> list[dict]:
    """Canonical skill rows — ``{slug, desc}`` — sorted by slug.

    Alias cards are hidden unless asked for: they are pointer stubs that would
    otherwise compete with the skill they point at. ``desc`` is the
    trigger-stripped one-liner.
    """
    rows = []
    for s in index.get("skills", []):
        if s.get("alias_of") and not include_aliases:
            continue
        rows.append({"slug": s["slug"],
                     "desc": _clean_desc(s.get("desc")).split("触发词")[0].strip()})
    rows.sort(key=lambda r: r["slug"])
    return rows


def resolve_shortlist(query: str, k: int = 5) -> list[dict]:
    """The k best skills for ``query`` — ``[{slug, score, desc}]``, best first.

    An empty catalog yields ``[]`` rather than raising, so a machine with no
    skills still answers.
    """
    idx = load_index()
    if not idx:
        return []
    return _BM25(idx).search(query, k)


# ═══════════════════════════════════════════════════
# Keeping the index alive without a manual step
# ═══════════════════════════════════════════════════
#
# oh-my-context-mod: hooks/sync.js builds the index at session start; a resolve
# rebuilds it when a skill under its roots changed since.

def _iter_skill_mds(roots: list[Path]):
    """Yield every ``SKILL.md`` under ``roots``, de-duplicated by real path.

    The cheap half of a scan: no parsing, just the walk. Shares
    :func:`_iter_skill_dirs` so a staleness probe and a full scan can never
    disagree about which files belong to the catalog.
    """
    seen_roots: set[str] = set()
    seen_files: set[str] = set()
    for root in roots:
        if not root.is_dir():
            continue
        try:
            root_key = str(root.resolve())
        except OSError:
            root_key = str(root)
        if root_key in seen_roots:
            continue
        seen_roots.add(root_key)
        for _slug, md in _iter_skill_dirs(root):
            try:
                key = str(md.resolve())
            except OSError:
                key = str(md)
            if key in seen_files:
                continue
            seen_files.add(key)
            yield md


def catalog_signature(roots: list[Path]) -> str:
    """A hash of every ``SKILL.md`` under ``roots``: path, size and mtime.

    The staleness signal. mtime-of-newest alone cannot see a *deleted* skill (the
    files that remain are not newer than the index) and counting files cannot see
    an edit. A signature over the whole listing sees all three, and costs the same
    stat-only walk — 0.01s for 1,200 files.
    """
    rows = []
    for md in _iter_skill_mds(roots):
        try:
            st = md.stat()
        except OSError:
            continue  # vanished mid-walk; the next run sees the new truth
        rows.append(f"{md}\0{st.st_size}\0{st.st_mtime_ns}")
    rows.sort()  # walk order is not guaranteed stable across platforms
    return hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest()


def index_is_stale(index: dict) -> bool:
    """True when the catalog on disk no longer matches the index.

    Compares the stored :func:`catalog_signature` against the one the disk
    produces now.

    A root that cannot be read contributes no rows, so its signature will not
    match — one rebuild is requested, and the index that rebuild produces carries
    the same signature, so it settles rather than looping. A permanently wrong
    index is worse than one rebuild.
    """
    roots = [Path(r) for r in (index.get("roots") or []) if r]
    return catalog_signature(roots) != index.get("signature")


def ensure_index() -> bool:
    """Rebuild the index when a skill changed under it. Returns True if rebuilt.

    Called by the `skills` and `resolve_skills` tools. A missing index stays
    missing: the plugin builds it from its own catalog. Best-effort by design: a
    read-only home, a missing root or a scan error must never break a resolve, so
    every failure path is a quiet no-op and the caller falls back to whatever
    index already exists.
    """
    try:
        index = load_index()
        if not index or not index_is_stale(index):
            return False
        with _INDEX_LOCK:
            index = load_index()
            if not index_is_stale(index):  # another thread rebuilt first
                return False
            build_and_save([Path(r) for r in index.get("roots") or [] if r])
        return True
    except Exception:  # a stale index is not worth a crash
        return False


# ═══════════════════════════════════════════════════
# Retrieval (BM25, zero dependency)
# ═══════════════════════════════════════════════════

def _tokenize(text: str) -> list[str]:
    """ASCII words plus CJK unigrams and bigrams.

    Bigrams matter: skill descriptions are largely Chinese, where single
    characters are too ambiguous to rank on.
    """
    text = (text or "").lower()
    out = re.findall(r"[a-z0-9][a-z0-9_\-\.]*", text)
    cjk = re.findall(r"[\u4e00-\u9fff]", text)
    out += cjk
    out += [cjk[i] + cjk[i + 1] for i in range(len(cjk) - 1)]
    return out


def resolve_aliases(index: dict) -> tuple[dict, dict]:
    """Split the catalog into canonical skills and alias→canonical map.

    Returns ``(canonical_by_slug, alias_map)``. Alias chains are followed with a
    cycle guard; an alias pointing outside the catalog stays an alias (callers
    treat it as unknown).
    """
    skills = index.get("skills", [])
    by_slug = {s["slug"].lower(): s for s in skills}
    alias_map: dict[str, str] = {}
    for s in skills:
        t = (s.get("alias_of") or "").lower()
        if t:
            alias_map[s["slug"].lower()] = t
    canonical = {k: v for k, v in by_slug.items() if k not in alias_map}

    def resolve_one(slug: str) -> str:
        seen = set()
        while slug in alias_map and slug not in seen:
            seen.add(slug)
            slug = alias_map[slug]
        return slug

    return canonical, {k: resolve_one(k) for k in alias_map}


# How much an exact skill-name hit is worth relative to a plain term match.
# Measured on a 30-case Chinese routing set: 2.0 lifts top-1 from 26/30 to 28/30
# and top-3 to 28/30, and 3.0/5.0/8.0 change nothing further — so the effect
# saturates early and the smallest value that works is the one kept.
_EXACT_NAME_BOOST = 2.0


class _BM25:
    """Ranked retrieval over canonical skills.

    Each canonical skill's document merges its own slug/description/triggers with
    those of every alias that points at it, so a query using the alias name
    still reaches the canonical entry.
    """

    def __init__(self, index: dict):
        canonical, alias_map = resolve_aliases(index)
        self.slugs = set(canonical)
        self.descs: dict[str, str] = {}
        back: dict[str, list[str]] = defaultdict(list)
        for alias, target in alias_map.items():
            back[target].append(alias)

        by_slug = {s["slug"].lower(): s for s in index.get("skills", [])}
        docs: dict[str, Counter] = {}
        df: Counter = Counter()
        for slug, s in canonical.items():
            parts = [slug, s.get("name") or "", _clean_desc(s.get("desc")),
                     " ".join(s.get("triggers") or [])]
            for a in back.get(slug, []):
                as_ = by_slug.get(a, {})
                parts += [a, _clean_desc(as_.get("desc")), " ".join(as_.get("triggers") or [])]
            counts = Counter(_tokenize(" ".join(parts)))
            docs[slug] = counts
            self.descs[slug] = _clean_desc(s.get("desc"))
            for t in counts:
                df[t] += 1
        self.docs = docs
        self.df = df
        self.n = len(docs)
        self.avgdl = (sum(sum(c.values()) for c in docs.values()) / self.n) if self.n else 0.0

    def _score(self, q_tokens: list[str], doc: Counter) -> float:
        # b=0.5, not the textbook 0.75. Length here is verbosity, not scope: a
        # skill with a chatty description is not more likely to be the answer, so
        # normalising it twice as hard as a terse one only buries it. Measured:
        # 「用 ComfyUI 出一个视频」 put `comfyui` at rank 11 with b=0.75 while it
        # shared the same eight terms as a winner whose document was half as long.
        k1, b = 1.5, 0.5
        dl = sum(doc.values())
        total = 0.0
        for t in q_tokens:
            if t not in doc:
                continue
            idf = math.log(1 + (self.n - self.df[t] + 0.5) / (self.df[t] + 0.5))
            tf = doc[t]
            total += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl / self.avgdl))
        return total

    def search(self, query: str, k: int = 5) -> list[dict]:
        """Top-k ``[{slug, score, desc}]``, best first.

        ``k <= 0`` asks for nothing and gets ``[]``. It used to be clamped up to
        1, which made "no results, please" indistinguishable from "one result";
        a negative ``k`` was worse — ``ranked[:-1]`` sliced the ranking from the
        end and returned a silent wrong answer instead of nothing.

        A query token that names a skill outright is the strongest routing
        evidence there is, and plain BM25 dilutes it: 「用 ComfyUI 出一个视频」
        let five skills sharing only 泛词 and 视频 outrank ``comfyui`` itself. So
        an exact name hit is weighted, which is what `_EXACT_NAME_BOOST` records.
        """
        if k <= 0:
            return []
        q = _tokenize(query)
        named = {
            t for t in (query or "").lower().replace("/", " ").split()
            if t in self.slugs
        }
        scored: list[tuple[float, str]] = []
        for slug, d in self.docs.items():
            score = self._score(q, d)
            if score > 0 and slug in named:
                score *= _EXACT_NAME_BOOST
            scored.append((score, slug))
        scored.sort(key=lambda pair: (-pair[0], pair[1]))
        return [
            {"slug": slug, "score": round(score, 4), "desc": self.descs.get(slug, "")}
            for score, slug in scored[:k]
            if score > 0
        ]


# Directory names that are never a skill, wherever the tree is walked. `_index`
# is a vault's own index card: it carries a SKILL.md but is not a skill.
_SKIP_DIR_NAMES = {"_index", ".git", "__pycache__", "node_modules", ".DS_Store"}


def _skip_dir(name: str) -> bool:
    return name in _SKIP_DIR_NAMES or name.startswith(".")


# Guards index rebuilds: two resolves that both see a stale index must not scan
# the catalog twice, and neither may write the file while the other reads it.
_INDEX_LOCK = threading.Lock()
