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

"""Helpers shared by the card and the gateway's find tool.

This module was `oh-my-context hint`, a word-overlap hint added to every prompt. It is
gone: in live use it named skills and tools nobody asked for, and the card (card.py)
plus `find` do the job without a line on every prompt. What stays is what those two use.
"""

from __future__ import annotations

import re

# A hit below this share of the best score is the weak tail behind a clear winner.
_REL_CUT = 0.5
_DESC_MAX = 100


def synced_twin(slug: str, slugs) -> bool:
    """The desktop app lists a synced skill twice, as `pdf` and `anthropic-skills:pdf`: True for
    the long one of such a pair. Two plugins with a skill of the same name are not a pair."""
    plugin, _, own = slug.lower().rpartition(":")
    return plugin == "anthropic-skills" and own in slugs


def _one_line(desc) -> str:
    """First sentence of a description, on one line, cut at _DESC_MAX."""
    from .skills import _clean_desc

    text = " ".join(_clean_desc(desc).split("触发词")[0].split())
    text = re.split(r"(?<=[.!?])\s", text, maxsplit=1)[0]
    return text if len(text) <= _DESC_MAX else text[:_DESC_MAX - 1].rstrip() + "…"


def tool_catalog() -> tuple:
    """Every routed tool known from the cached manifests: (BM25 entries, rows, names).

    rows: lower slug -> {server, tool, claude_name, desc, schema}. names: lower slug -> the
    server's name parts. Offline: never starts a server. Used by the gateway's find tool.
    """
    from . import cache as cache_mod
    from .config import load_config

    entries = []
    rows = {}
    names = {}
    for server, cfg in sorted(load_config().items()):
        tools = cache_mod.get_cached_tools_any_age(server)
        prefix = cfg.get("claude_prefix") if isinstance(cfg, dict) else None
        for t in tools or []:
            if not isinstance(t, dict) or "error" in t or not t.get("name"):
                continue
            tool = str(t["name"])
            slug = f"{server}␟{tool}"
            words = re.sub(r"[_\-.]+", " ", tool)
            desc = str(t.get("description") or "")
            entries.append({"slug": slug, "name": tool, "desc": desc,
                            "triggers": [words, re.sub(r"[_\-.]+", " ", server)]})
            claude = (f"{prefix}__{re.sub(r'[^A-Za-z0-9_-]', '_', tool)}"
                      if isinstance(prefix, str) and prefix else None)
            rows[slug.lower()] = {"server": server, "tool": tool, "claude_name": claude,
                                  "desc": desc, "schema": t.get("inputSchema") or {}}
            # The server's name as the person knows it: its gateway name or Claude's (mcp__github).
            names[slug.lower()] = set(re.split(r"[_\-.]+", f"{server} {prefix or ''}".lower().replace(" ", "_"))) - {
                "", "mod", "mcp", "plugin"}
    return entries, rows, names
