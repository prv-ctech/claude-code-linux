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
lead the list with a short description (from the per-project session log, most used
first). Every other skill is a name on its plugin's line. The text has no
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
        "one of these, use it: `find` (task) returns matching tools with parameters and skills "
        "with descriptions; "
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
        raw = cache_mod.get_cached_tools_any_age(server)
        tools = [t for t in raw or []
                 if isinstance(t, dict) and t.get("name") and "error" not in t]
        failed = next((str(t["error"]) for t in raw or [] if isinstance(t, dict) and "error" in t), "")
        prefix = cfg.get("claude_prefix") if isinstance(cfg, dict) else None
        name = prefix if isinstance(prefix, str) and prefix else server
        skip = _GENERIC | set(re.split(r"[_\-.]+", server.lower()))
        words = Counter(w for t in tools for w in set(re.split(r"[_\-.]+", str(t["name"]).lower()))
                        if len(w) > 2 and w not in skip)
        # Most common first, then by name, so the line is the same on every run.
        top = [w for w, _ in sorted(words.items(), key=lambda p: (-p[1], p[0]))[:_WORDS]]
        if tools:
            line = f"- {name}__* ({len(tools)} tools): {', '.join(top)}"
        elif failed:
            line = f"- {name}__* (failed to start: {' '.join(failed.split())[:100]})"
        else:
            line = f"- {name}__* (tools not listed yet)"
        mine = (used.get(server) or [])[:_USED_TOOLS]
        lines.append(line + (f"; used here: {', '.join(mine)}" if mine else ""))
    return lines


# An id is printed into every context, so a skill file in a cloned repo must not be able to put
# arbitrary text there: plain names only, and not long ones.
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:._-]{0,79}$")


def _skills(used: list) -> tuple:
    """([(id, gloss)] this project has loaded, most used first; the other ids, sorted)."""
    from .hint import synced_twin
    from .skills import load_index

    skills = [s for s in (load_index() or {}).get("skills", [])
              if s.get("slug") and not s.get("alias_of") and _ID.match(s["slug"])]
    slugs = {s["slug"].lower() for s in skills}
    rows = {s["slug"]: _gloss(s.get("desc")) for s in skills if not synced_twin(s["slug"], slugs)}
    first = [(slug, rows[slug]) for slug in used if slug in rows]
    taken = {slug for slug, _ in first}
    return first, sorted(slug for slug in rows if slug not in taken)


def _by_plugin(ids: list) -> list:
    """One line per plugin: its skills by name. A cut-off description of each cost four times the
    characters and said little; `find` returns the full description when a task needs one."""
    groups: dict = {}
    for slug in ids:
        plugin, _, name = slug.rpartition(":")
        groups.setdefault(plugin, []).append(name)
    return [f"- {plugin}: {', '.join(names)}" if plugin else f"- {', '.join(names)}"
            for plugin, names in sorted(groups.items())]


def build_card(cwd: str | None = None) -> str:
    """cwd: the project whose own use puts tools and skills first (default: the working directory)."""
    from . import session_log

    servers, first, rest = [], [], []
    used_tools, used_skills = session_log.used(cwd)
    # Each half fails on its own: a broken cache must not hide the skills.
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
    out = [HEAD] + (["MCP servers:"] + servers if servers else [])
    if first:
        out += ["Skills used in this project:"] + [f"- {slug}: {gloss}" if gloss else f"- {slug}" for slug, gloss in first]
    if rest:
        out += ["Other skills (id is plugin:name):" if first else "Skills (id is plugin:name):"] + _by_plugin(rest)
    return "\n".join(out)[:_MAX]


def run_card(args: list) -> int:
    text = build_card(args[1] if args[:1] == ["--cwd"] and len(args) == 2 else None)
    if text:
        print(text)
    return 0
