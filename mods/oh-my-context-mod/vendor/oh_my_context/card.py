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
# Added by oh-my-context-mod (github.com/prv-ctech/claude-code-linux), 2026-11-14: `oh-my-context card`.

"""oh-my-context card — what is behind the gateway, as one block of text.

    oh-my-context card [--cwd <project dir>]

A hook adds this text once to each new context (session start, /clear, compaction,
a subagent), so the model knows which routed tools and skills exist without a
reminder on every turn. Read-only and offline, like `hint`: skills come from the
skills index, tools from the cached manifests. Prints nothing when both are empty.

What the project named by --cwd (default: the working directory) has really called
comes first: a server line ends with the tools used there, and skills it has loaded
lead the list (from the per-project session log, most used first). The text has no
dates and no counts, so it changes only when the catalog or the order of use does.
"""

from __future__ import annotations

import re
from collections import Counter

# Under Claude Code's 10,000-character cap for hook context, with room for other lines.
_MAX = 6000
_GLOSS = 48
_WORDS = 10
# Verbs every API has; they say nothing about what a server is for.
_GENERIC = frozenset("list get delete create update set add remove for used the and all".split())
# Openers that say nothing about what a skill does.
_OPENER = re.compile(
    r"^(use this skill (whenever|when) the user (wants|asks) to (do anything with )?"
    r"|read this skill before the first step (that uses|of any request to (do something )?)"
    r"|use (this )?(skill )?(when|for|to) )", re.I)

HEAD = ("Behind the oh-my-context gateway (not in your tool or skill lists). When a task touches "
        "one of these, use it: `find` (task) returns matching tools with parameters and skills; "
        "run a tool with `call` (tool = its mcp__ name), read a skill with `load_skill` (id).")


def _gloss(desc) -> str:
    from .hint import _one_line

    text = _OPENER.sub("", _one_line(desc)).strip()
    return text if len(text) <= _GLOSS else text[:_GLOSS - 1].rstrip() + "…"


_USED_TOOLS = 4


def _server_lines(used: dict) -> list:
    from . import cache as cache_mod
    from .config import load_config

    lines = []
    for server, cfg in sorted(load_config().items()):
        tools = [t for t in cache_mod.get_cached_tools_any_age(server) or []
                 if isinstance(t, dict) and t.get("name") and "error" not in t]
        prefix = cfg.get("claude_prefix") if isinstance(cfg, dict) else None
        name = prefix if isinstance(prefix, str) and prefix else server
        skip = _GENERIC | set(re.split(r"[_\-.]+", server.lower()))
        words = Counter(w for t in tools for w in set(re.split(r"[_\-.]+", str(t["name"]).lower()))
                        if len(w) > 2 and w not in skip)
        # Most common first, then by name, so the line is the same on every run.
        top = [w for w, _ in sorted(words.items(), key=lambda p: (-p[1], p[0]))[:_WORDS]]
        line = (f"- {name}__* ({len(tools)} tools): {', '.join(top)}" if tools
                else f"- {name}__* (tools not listed yet)")
        mine = (used.get(server) or [])[:_USED_TOOLS]
        lines.append(line + (f"; used here: {', '.join(mine)}" if mine else ""))
    return lines


def _skills(used: list) -> tuple:
    """([(id, gloss)] this project has loaded, most used first; the rest, sorted)."""
    from .hint import synced_twin
    from .skills import load_index

    skills = [s for s in (load_index() or {}).get("skills", []) if s.get("slug") and not s.get("alias_of")]
    slugs = {s["slug"].lower() for s in skills}
    rows = {s["slug"]: _gloss(s.get("desc")) for s in skills if not synced_twin(s["slug"], slugs)}
    first = [(slug, rows[slug]) for slug in used if slug in rows]
    taken = {slug for slug, _ in first}
    return first, sorted((slug, gloss) for slug, gloss in rows.items() if slug not in taken)


def build_card(cwd: str | None = None) -> str:
    """cwd: the project whose own use puts tools and skills first (default: the working directory)."""
    from . import session_log

    servers, first, rest = [], [], []
    used_tools, used_skills = session_log.used(cwd)
    # Each half fails on its own, like hint: a broken cache must not hide the skills.
    try:
        servers = _server_lines(used_tools)
    except Exception:  # noqa: BLE001
        pass
    try:
        first, rest = _skills(used_skills)
    except Exception:  # noqa: BLE001
        pass
    if not servers and not first and not rest:
        return ""
    head = [HEAD] + (["MCP servers:"] + servers if servers else [])
    line = lambda slug, gloss: f"- {slug}: {gloss}" if gloss else f"- {slug}"  # noqa: E731
    mine = (["Skills used in this project:"] + [line(*s) for s in first]) if first else []
    out = head + mine + ((["Other skills:" if first else "Skills:"] + [line(*s) for s in rest]) if rest else [])
    text = "\n".join(out)
    if len(text) > _MAX:
        # A huge catalog keeps the glosses of what this project uses and lists the rest by id.
        out = head + mine + [("Other skills: " if first else "Skills: ") + ", ".join(slug for slug, _ in rest)]
        text = "\n".join(out)[:_MAX]
    return text


def run_card(args: list) -> int:
    text = build_card(args[1] if args[:1] == ["--cwd"] and len(args) == 2 else None)
    if text:
        print(text)
    return 0
