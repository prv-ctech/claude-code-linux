# Copyright 2026 prv-ctech (oh-my-context-mod, github.com/prv-ctech/claude-code-linux)
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
# Added by oh-my-context-mod (github.com/prv-ctech/claude-code-linux), 2026-10-30: `oh-my-context hint`.

"""oh-my-context hint — which skills and routed tools fit a prompt.

    echo "<prompt>" | oh-my-context hint [--k-skills N] [--k-tools N]

Prints one JSON object and exits 0, also when nothing matches or nothing is built:

    {"skills": [{"name", "score"}],
     "tools":  [{"server", "tool", "claude_name", "score"}]}

Meant for a UserPromptSubmit hook, so it is read-only and fast: skills come from
the skills index, tools from the gateway's cached manifests (any age). It never
starts an MCP server and never touches the network. It writes nothing of its own;
the one exception is shared code: when the gateway config does not parse,
load_config keeps one config.json.bak of it, the same as the gateway does on start.

Only clear matches are printed. Both buckets use the same BM25 as `skills
resolve` and the same three gates, because a wrong hint costs context on every
prompt while a missing one costs nothing:

  * score >= _MIN_SCORE (1.5): with b=0.5, one rare term matched once scores about
    1 in a 3-document catalog and 3-4 in a 100-document one, so a lone common word
    never passes, while two distinctive terms do at any catalog size;
  * at least _MIN_TERMS (2) distinct informative prompt terms in the document
    (stopwords and 1-2 letter ASCII words do not count), or the skill's own name
    written in the prompt (skills only: a tool's name is often one common word such
    as search, comment or get);
  * score >= _REL_CUT (0.5) x the best score in its bucket, so a long tail of
    weak matches behind a clear winner is dropped.
"""

from __future__ import annotations

import json
import re
import sys

_MIN_SCORE = 1.5
_MIN_TERMS = 2
_REL_CUT = 0.5
_MAX_PROMPT = 20000

_STOPWORDS = frozenset("""
a an and are as at be been but by can could do does for from had has have how i if in
into is it its let me my no not of on or our please should so that the their them then
there these this those to us use using was we what when where which who why will with
would you your just also any some all get make want need like help run show tell give
""".split())


def _int_flag(args: list, flag: str, default: int) -> int:
    for i, a in enumerate(args):
        value = None
        if a == flag and i + 1 < len(args):
            value = args[i + 1]
        elif a.startswith(flag + "="):
            value = a.split("=", 1)[1]
        if value is not None:
            try:
                return max(0, int(value))
            except ValueError:
                return default
    return default


def _informative(tokens) -> set:
    return {t for t in tokens
            if t not in _STOPWORDS and not (t.isascii() and len(t) < 3)}


def _rank(bm25, prompt: str, k: int, names: dict) -> list:
    """[(lower slug, score)] that pass the gates, best first. names: lower slug -> own name."""
    from .skills import _tokenize

    if k <= 0 or not bm25.n:
        return []
    q_all = _tokenize(prompt)
    q_terms = _informative(q_all)
    q_set = set(q_all)
    scored = []
    for slug, doc in bm25.docs.items():
        score = bm25._score(q_all, doc)
        if score <= 0:
            continue
        named = (names.get(slug) or "").lower() in q_set
        if score < _MIN_SCORE or (len(q_terms & doc.keys()) < _MIN_TERMS and not named):
            continue
        scored.append((score, slug))
    if not scored:
        return []
    scored.sort(key=lambda p: (-p[0], p[1]))
    best = scored[0][0]
    return [(slug, round(score, 3)) for score, slug in scored[:k] if score >= _REL_CUT * best]


def _skill_hints(prompt: str, k: int) -> list:
    from .skills import _BM25, load_index

    index = load_index()
    if not index or k <= 0:
        return []
    original = {s["slug"].lower(): s["slug"] for s in index.get("skills", []) if s.get("slug")}
    # The name a person types is the part after "plugin:" (superpowers:brainstorming).
    names = {low: slug.rsplit(":", 1)[-1] for low, slug in original.items()}
    return [{"name": original.get(slug, slug), "score": score}
            for slug, score in _rank(_BM25(index), prompt, k, names)]


def _tool_hints(prompt: str, k: int) -> list:
    from . import cache as cache_mod
    from .config import load_config
    from .skills import _BM25

    if k <= 0:
        return []
    entries = []
    rows = {}
    for server, cfg in sorted(load_config().items()):
        tools = cache_mod.get_cached_tools_any_age(server)
        prefix = cfg.get("claude_prefix") if isinstance(cfg, dict) else None
        for t in tools or []:
            if not isinstance(t, dict) or "error" in t or not t.get("name"):
                continue
            tool = str(t["name"])
            slug = f"{server}␟{tool}"
            words = re.sub(r"[_\-.]+", " ", tool)
            entries.append({"slug": slug, "name": tool, "desc": str(t.get("description") or ""),
                            "triggers": [words, re.sub(r"[_\-.]+", " ", server)]})
            claude = (f"{prefix}__{re.sub(r'[^A-Za-z0-9_-]', '_', tool)}"
                      if isinstance(prefix, str) and prefix else None)
            rows[slug.lower()] = {"server": server, "tool": tool, "claude_name": claude}
    if not entries:
        return []
    # oh-my-context-mod: no own-name bypass for tools; a tool's name is often one common word.
    return [{**rows[slug], "score": score}
            for slug, score in _rank(_BM25({"skills": entries}), prompt, k, {})]


def run_hint(args: list) -> int:
    k_skills = _int_flag(args, "--k-skills", 3)
    k_tools = _int_flag(args, "--k-tools", 3)
    try:
        prompt = sys.stdin.read(_MAX_PROMPT)
    except Exception:
        prompt = ""
    out = {"skills": [], "tools": []}
    if prompt.strip():
        # Each bucket fails on its own: a broken cache must not hide the skills.
        try:
            out["skills"] = _skill_hints(prompt, k_skills)
        except Exception as e:  # noqa: BLE001
            print(f"oh-my-context hint: skills: {e}", file=sys.stderr)
        try:
            out["tools"] = _tool_hints(prompt, k_tools)
        except Exception as e:  # noqa: BLE001
            print(f"oh-my-context hint: tools: {e}", file=sys.stderr)
    print(json.dumps(out, ensure_ascii=False))
    return 0
