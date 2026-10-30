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
# Modified by oh-my-context-mod (github.com/prv-ctech/claude-code-linux), 2026-10-30: call/inspect accept original Claude tool names; inspect shows a running server's instructions; managed call schema offers only the Claude-name and server+tool forms; renamed to oh-my-context: package, commands, tool, environment and path names (see vendor/NOTICE).

"""oh-my-context's own tools — the gateway's first-party surface.

They read state the bridge already holds (the tool index, the config, the skill
index, the usage counter, the CCR store, the knowledge base); only `call` reaches
an upstream server, through the bridge. On a name collision the upstream
definition wins (see serve._handle_list_tools).

Keep the wording inside the budget enforced by ``schema_simplifier`` (descriptions
<= 360 chars / 3 sentences, parameter docs <= 200 chars / 2 sentences) so the
gateway never truncates its own catalog.
"""

from __future__ import annotations

import json
import os
import re  # oh-my-context-mod: resolve_claude_name
from typing import Any

from .schema_simplifier import namespaced_tool_name, simplify_tool_def

# Names of the first-party tools, in listing order.
NATIVE_NAMES = (
    "manifest",
    "servers",
    "health",
    "usage",
    "skills",
    "resolve_skills",
    "inspect",
    "call",
    "retrieve",
    "kb_search",
    "kb_index",
    "session",
)


def native_tools() -> list[dict]:
    """Full MCP tool definitions for the gateway's own tools."""
    return [
        {
            "name": "manifest",
            "title": "Tool manifest",
            "description": (
                "List the upstream tools this gateway currently exposes, grouped by server. "
                "Returns names by default; that compact view is what an agent should read "
                "instead of pulling every full schema. Pass include_descriptions for a "
                "one-line summary per tool."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "server": {
                        "type": "string",
                        "description": (
                            "Restrict the listing to one server name. Omit to list every "
                            "server the gateway has loaded."
                        ),
                    },
                    "include_descriptions": {
                        "type": "boolean",
                        "description": (
                            "Attach each tool's first description sentence to the listing. "
                            "Costs tokens; the default false keeps the manifest small."
                        ),
                    },
                },
            },
            "outputSchema": {
                "type": "object",
                "properties": {
                    "servers": {
                        "type": "array",
                        "description": "One entry per server that contributed tools.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "toolCount": {"type": "integer"},
                                "tools": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "name": {"type": "string"},
                                            "description": {
                                                "type": "string",
                                                "description": (
                                                    "Only present when include_descriptions "
                                                    "was set; omitted to keep the manifest small."
                                                ),
                                            },
                                        },
                                        "required": ["name"],
                                    },
                                },
                            },
                            "required": ["name", "toolCount", "tools"],
                        },
                    },
                    "totalServers": {"type": "integer"},
                    "totalTools": {"type": "integer"},
                },
                "required": ["servers", "totalServers", "totalTools"],
            },
            "annotations": {
                "title": "Tool manifest",
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "servers",
            "title": "Configured servers",
            "description": (
                "Report the MCP servers configured behind this gateway: transport, tool "
                "count and whether their tools loaded. Use it to see what is actually "
                "reachable before calling a tool, and to spot a server that configured "
                "but published nothing."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "server": {
                        "type": "string",
                        "description": (
                            "Report one server by name instead of all of them. Aliases "
                            "resolve to the canonical server name."
                        ),
                    },
                },
            },
            "outputSchema": {
                "type": "object",
                "properties": {
                    "servers": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "transport": {
                                    "type": "string",
                                    "description": "stdio, http or unknown.",
                                },
                                "toolCount": {"type": "integer"},
                                "loaded": {
                                    "type": "boolean",
                                    "description": "True if the gateway indexed its tools.",
                                },
                            },
                            "required": ["name", "transport", "toolCount", "loaded"],
                        },
                    },
                    "configured": {"type": "integer"},
                },
                "required": ["servers", "configured"],
            },
            "annotations": {
                "title": "Configured servers",
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "health",
            "title": "Gateway self-check",
            "description": (
                "Self-check of this gateway process: version, config path, servers "
                "configured, tools indexed and uptime. Read this first when a tool you "
                "expect is missing; it distinguishes an empty config from a server that "
                "failed to load."
            ),
            "inputSchema": {"type": "object", "properties": {}},
            "outputSchema": {
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "description": "ok, degraded, error or starting.",
                    },
                    "version": {"type": "string"},
                    "python": {"type": "string"},
                    "configPath": {"type": "string"},
                    "serversConfigured": {"type": "integer"},
                    "toolsIndexed": {"type": "integer"},
                    "failedServers": {"type": "integer"},
                    "uptimeSeconds": {"type": "number"},
                },
                "required": ["status", "version", "serversConfigured", "toolsIndexed"],
            },
            "annotations": {
                "title": "Gateway self-check",
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "usage",
            "title": "Token savings so far",
            "description": (
                "How much this gateway has saved: tools compressed, tokens saved and the "
                "session call count. Call this when you want to tell the user what oh-my-context "
                "did. Report these numbers verbatim; never estimate them yourself."
            ),
            "inputSchema": {"type": "object", "properties": {}},
            "outputSchema": {
                "type": "object",
                "properties": {
                    "toolsCompressed": {"type": "integer"},
                    "tokensSaved": {"type": "integer"},
                    "savingsPct": {"type": "number"},
                    "callsRecorded": {
                        "type": "integer",
                        "description": "Calls oh-my-context has recorded, cumulative across sessions.",
                    },
                },
                "required": ["toolsCompressed", "tokensSaved", "savingsPct"],
            },
            "annotations": {
                "title": "Token savings so far",
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "skills",
            "title": "Skill catalog",
            "description": (
                "List the skills oh-my-context indexes on this machine: slug and one-line "
                "description per skill. Read it once to learn what skills exist, then "
                "resolve the one you need with resolve_skills. Offline and "
                "read-only; pass include_aliases to also see alias cards."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "include_aliases": {
                        "type": "boolean",
                        "description": (
                            "Include alias cards, not only canonical skills. The "
                            "default false keeps one row per real skill."
                        ),
                    },
                },
            },
            "outputSchema": {
                "type": "object",
                "properties": {
                    "skills": {
                        "type": "array",
                        "description": "One entry per skill, sorted by slug.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "slug": {"type": "string"},
                                "desc": {"type": "string"},
                            },
                            "required": ["slug", "desc"],
                        },
                    },
                    "totalSkills": {"type": "integer"},
                },
                "required": ["skills", "totalSkills"],
            },
            "annotations": {
                "title": "Skill catalog",
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "resolve_skills",
            "title": "Resolve skills for a task",
            "description": (
                "Return the skills that best match a task description, best first. "
                "Call this with the user's request before acting, then read the chosen "
                "skill's SKILL.md. Offline BM25 ranking, no LLM."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": (
                            "What the user wants to do, in their own words. More detail "
                            "ranks better than a single keyword."
                        ),
                    },
                    "k": {
                        "type": "integer",
                        "description": (
                            "How many candidates to return. The default 5 is enough to "
                            "pick from; larger only when the top few look wrong."
                        ),
                    },
                },
                "required": ["task"],
            },
            "outputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "k": {"type": "integer"},
                    "shortlist": {
                        "type": "array",
                        "description": "Best matches first, each with its BM25 score.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "slug": {"type": "string"},
                                "score": {"type": "number"},
                                "desc": {"type": "string"},
                            },
                            "required": ["slug", "score"],
                        },
                    },
                },
                "required": ["query", "k", "shortlist"],
            },
            "annotations": {
                "title": "Resolve skills for a task",
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "inspect",
            "title": "Inspect one tool's parameters",
            "description": (
                "Show one upstream tool's full input schema — the parameters to call it "
                "with. Read-only; nothing runs. Use it after manifest names a tool."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tool": {
                        "type": "string",
                        "description": (
                            "Original Claude tool name (mcp__...), or a namespaced name from "
                            "manifest, e.g. fetch_fetch. A bare name works when only "
                            "one server owns it."
                        ),
                    },
                    "server": {
                        "type": "string",
                        "description": (
                            "Server that owns the tool; disambiguates a shared bare name."
                        ),
                    },
                },
                "required": ["tool"],
            },
            "outputSchema": {
                "type": "object",
                "properties": {
                    "tool": {"type": "string"},
                    "server": {"type": "string"},
                    "inputSchema": {"type": "object"},
                },
                "required": ["tool", "server", "inputSchema"],
            },
            "annotations": {
                "title": "Inspect one tool's parameters",
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "call",
            "title": "Call any upstream tool",
            # oh-my-context-mod: only the two forms hooks/permit.js maps back to a Claude
            # tool name (`tool` as mcp__..., or `server` plus `tool`).
            "description": (
                "Run a routed tool by its original Claude tool name (mcp__ prefix) as tool, or by "
                "server plus the server's own tool name as tool. The tool list is withheld, so this "
                "is how you run one found via manifest. Arguments are validated first."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tool": {
                        "type": "string",
                        "description": (
                            "Original Claude tool name, e.g. mcp__github__create_issue. Or the "
                            "server's own tool name when server is given."
                        ),
                    },
                    "server": {
                        "type": "string",
                        "description": (
                            "Routed server that owns the tool. Required unless tool is an mcp__ "
                            "name; with an mcp__ name it must be that tool's server."
                        ),
                    },
                    "arguments": {
                        "type": "object",
                        "description": "Arguments object for the tool; see inspect.",
                    },
                },
                "required": ["tool"],
            },
            "outputSchema": {
                "type": "object",
                "properties": {
                    "tool": {"type": "string"},
                    "server": {"type": "string"},
                    "result": {},
                },
                "required": ["tool", "server"],
            },
            "annotations": {
                "title": "Call any upstream tool",
                "readOnlyHint": False,
                "destructiveHint": True,
                "idempotentHint": False,
                "openWorldHint": True,
            },
        },
        {
            "name": "retrieve",
            "title": "Retrieve a compressed result",
            "description": (
                "Get back the full, uncompressed text of a tool result oh-my-context "
                "compressed. When a result ends with a line naming a handle, call "
                "this if the summary lacks a detail you need."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "handle": {
                        "type": "string",
                        "description": (
                            "The handle from a result's 'retrieve handle=...' "
                            "line, e.g. ab12cd34ef56."
                        ),
                    },
                },
                "required": ["handle"],
            },
            "outputSchema": {
                "type": "object",
                "properties": {
                    "found": {"type": "boolean"},
                    "handle": {"type": "string"},
                    "original": {},
                },
                "required": ["found", "handle"],
            },
            "annotations": {
                "title": "Retrieve a compressed result",
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "kb_search",
            "title": "Search inside indexed documents",
            "description": (
                "Return the PASSAGES in already-indexed documents that match a query, "
                "not the whole file. Use it instead of reading a large document whole "
                "when you need a few lines from it. Index a document first with "
                "kb_index."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Words to find. Substrings and typos are handled.",
                    },
                    "k": {
                        "type": "integer",
                        "description": "How many passages to return (default 5).",
                    },
                    "source": {
                        "type": "string",
                        "description": (
                            "Restrict to sources whose name contains this text. "
                            "Omit to search everything indexed."
                        ),
                    },
                },
                "required": ["query"],
            },
            "outputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "hits": {"type": "array", "items": {"type": "object"}},
                    "notes": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["query", "hits"],
            },
            "annotations": {
                "title": "Search inside indexed documents",
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "kb_index",
            "title": "Index a document for search",
            "description": (
                "Chunk a local file into the knowledge base so "
                "kb_search can find passages in it. Indexing is what keeps "
                "the document out of your context window while staying searchable."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "A local file path to index.",
                    },
                    "source": {
                        "type": "string",
                        "description": "Optional label for this source in the index.",
                    },
                },
            },
            "outputSchema": {
                "type": "object",
                "properties": {
                    "indexed": {"type": "boolean"},
                    "source": {"type": "string"},
                    "chunks": {"type": "integer"},
                    "bytes": {"type": "integer"},
                    "error": {"type": "string"},
                },
                "required": ["indexed", "source", "chunks"],
            },
            "annotations": {
                "title": "Index a document for search",
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "session",
            "title": "This session's activity",
            "description": (
                "Summarise what has routed through this gateway in this project: "
                "tools used, files written, errors, git operations. Call it after a "
                "context compaction to catch up on where you were. It is on-demand, "
                "not automatic — the gateway cannot inject into your context itself."
            ),
            "inputSchema": {"type": "object", "properties": {}},
            "outputSchema": {
                "type": "object",
                "properties": {
                    "project": {"type": "string"},
                    "events": {"type": "integer"},
                    "filesWritten": {"type": "array", "items": {"type": "string"}},
                    "toolsUsed": {"type": "array", "items": {"type": "object"}},
                    "errors": {"type": "array", "items": {"type": "object"}},
                    "gitOps": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["project", "events"],
            },
            "annotations": {
                "title": "This session's activity",
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
    ]


def is_native(name: str) -> bool:
    return name in NATIVE_NAMES


def _transport_of(cfg: Any) -> str:
    """Best-effort transport label from a server config entry."""
    if not isinstance(cfg, dict):
        return "unknown"
    if cfg.get("command"):
        return "stdio"
    if cfg.get("url") or cfg.get("serverUrl"):
        return "http"
    return "unknown"


def _first_sentence(text: str) -> str:
    for sep in (". ", "! ", "? "):
        i = text.find(sep)
        if i != -1:
            return text[: i + 1].strip()
    return text.strip()


def _as_str(value: Any) -> str:
    """Tolerate junk from a client: only strings are usable as filters."""
    return value.strip() if isinstance(value, str) else ""


def _as_bool(value: Any) -> bool:
    """Accept the shapes agents actually send, without crashing on any of them."""
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "y", "on")
    return bool(value)


def _as_int(value: Any, default: int, minimum: int = 1) -> int:
    """Coerce a client-supplied count, falling back rather than raising.

    Agents send ``k`` as a string or a float often enough that a strict read
    would turn a usable call into an error; a bad value is simply ignored.
    """
    if isinstance(value, bool):
        return default
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, str):
        try:
            value = int(value.strip())
        except ValueError:
            return default
    if not isinstance(value, int) or value < minimum:
        return default
    return value


def _manifest(arguments: dict, state: dict) -> dict:
    want_server = _as_str(arguments.get("server"))
    with_desc = _as_bool(arguments.get("include_descriptions"))
    index = state["tool_index"]

    by_server: dict[str, list[str]] = {}
    for ns_name, info in index.items():
        server = info.get("server", "")
        if want_server and server != want_server:
            continue
        by_server.setdefault(server, []).append(info.get("tool", ns_name))

    servers = []
    for name in sorted(by_server):
        tools = sorted(by_server[name])
        entries = []
        for tool in tools:
            entry = {"name": tool}
            if with_desc:
                full = index.get(namespaced_tool_name(name, tool), {}).get("full_def", {})
                entry["description"] = _first_sentence(full.get("description", "") or "")
            entries.append(entry)
        servers.append({"name": name, "toolCount": len(tools), "tools": entries})

    total_tools = sum(s["toolCount"] for s in servers)
    payload = {
        "servers": servers,
        "totalServers": len(servers),
        "totalTools": total_tools,
    }
    if not servers:
        payload["notice"] = (
            "No upstream tools indexed. This gateway publishes only what the routed servers "
            "expose; /oh-my-context-mod in Claude Code shows which servers are routed."
        )
    return payload


def _servers(arguments: dict, state: dict) -> dict:
    want_server = _as_str(arguments.get("server"))
    configured = state["servers"]
    index = state["tool_index"]

    counts: dict[str, int] = {}
    for info in index.values():
        counts[info.get("server", "")] = counts.get(info.get("server", ""), 0) + 1

    rows = []
    for name in sorted(configured):
        if want_server and name != want_server:
            continue
        rows.append({
            "name": name,
            "transport": _transport_of(configured[name]),
            "toolCount": counts.get(name, 0),
            "loaded": counts.get(name, 0) > 0,
        })
    if want_server and not rows:
        rows.append({"name": want_server, "transport": "unknown", "toolCount": 0, "loaded": False})
    out = {"servers": rows, "configured": len(configured)}
    if not configured:
        out["notice"] = (
            "No servers are routed through this gateway. /oh-my-context-mod in Claude Code "
            "shows what it routes and why a server stays direct."
        )
    return out


def _health(arguments: dict, state: dict) -> dict:  # noqa: ARG001 - uniform signature
    from . import __version__
    from .config import _config_file

    configured = state["servers"]
    index = state["tool_index"]
    # "Failed" means the fetch raised (``fetch_errors``), NOT "absent from the
    # index" — that is also true of a healthy server that legitimately exposes no tools.
    failed = sum(1 for name in configured if name in state["fetch_errors"])

    if not state.get("initialized"):
        status = "starting"
    elif configured and failed == len(configured):
        status = "error"
    elif failed:
        status = "degraded"
    else:
        status = "ok"

    cfg_path = str(_config_file())

    return {
        "status": status,
        "version": __version__,
        "python": os.sys.version.split()[0],
        "configPath": cfg_path,
        "serversConfigured": len(configured),
        "toolsIndexed": len(index),
        "failedServers": failed,
        # Clamp to >= 0: right after startup the elapsed clock can be a tiny
        # negative float, and round(-1e-9, 1) is -0.0. That is legal JSON but not
        # value-preserving for a JS client (JSON.parse("-0.0") -> -0, which
        # stringifies back to "0"), so a client that round-trips tool results to
        # check they are lossless rejects the whole response (issue #23).
        "uptimeSeconds": round(max(state.get("uptime", 0.0), 0.0), 1),
        "nativeTools": list(NATIVE_NAMES),
    }


def _usage(arguments: dict, state: dict) -> dict:  # noqa: ARG001 - uniform signature
    """Real savings numbers, never an estimate.

    Tokens are a static property of the catalog (raw JSON vs the simplified
    schemas), so they are stable for a given tool set; calls are the cumulative
    counter in usage.json.
    """
    from . import usage as usage_mod

    index = state["tool_index"]
    full_tokens = 0
    slim_tokens = 0
    for info in index.values():
        full_def = info.get("full_def") or {}
        if not full_def or "error" in full_def:
            continue
        full_tokens += usage_mod.count_tokens(full_def)
        slim_tokens += usage_mod.count_tokens(simplify_tool_def(full_def))

    saved = max(0, full_tokens - slim_tokens)
    pct = round(saved / full_tokens * 100, 1) if full_tokens else 0.0

    calls = usage_mod.calls_recorded()

    return {
        "toolsCompressed": len(index),
        "tokensSaved": saved,
        "savingsPct": pct,
        "callsRecorded": calls,
    }


def _skills(arguments: dict, state: dict) -> dict:  # noqa: ARG001 - uniform signature
    """The skill catalog (the index hooks/sync.js builds), exposed over MCP. Read-only."""
    from . import skills as skills_mod

    skills_mod.ensure_index()  # first call builds it; a stale one is refreshed
    rows = skills_mod.catalog_rows(
        skills_mod.load_index(), include_aliases=_as_bool(arguments.get("include_aliases")))
    payload = {"skills": rows, "totalSkills": len(rows)}
    if not rows:
        payload["notice"] = (
            "No skill index yet. oh-my-context-mod builds it at session start; "
            "/oh-my-context-mod in Claude Code shows the setup."
        )
    return payload


def _resolve_skills(arguments: dict, state: dict) -> dict:  # noqa: ARG001 - uniform signature
    """Best skills for a task, ranked by BM25. Offline and instant."""
    from . import skills as skills_mod

    task = _as_str(arguments.get("task"))
    k = _as_int(arguments.get("k"), 5, minimum=1)
    if not task:
        return {"query": "", "k": k, "shortlist": [],
                "notice": "Pass a non-empty `task` describing what the user wants to do."}
    skills_mod.ensure_index()  # a fresh install answers instead of erroring
    shortlist = skills_mod.resolve_shortlist(task, k)
    payload = {"query": task, "k": k, "shortlist": shortlist}
    if not shortlist:
        payload["notice"] = (
            "No skill matched. The catalog may be empty (oh-my-context-mod builds it at "
            "session start) or the wording may not match; try the user's own words, or "
            "skills to list."
        )
    return payload


def resolve_claude_name(name: str, servers: dict, index: dict) -> tuple[str, str, str]:
    """oh-my-context-mod: map an original Claude tool name to ``(server, tool, error)``.

    A routed server's entry carries ``claude_prefix``, the tool-name prefix Claude
    Code gave it when it ran directly (``mcp__github``, ``mcp__plugin_x_y``). The
    longest prefix followed by ``__`` wins. Claude Code replaced characters outside
    ``[A-Za-z0-9_-]`` with ``_``, so the rest is matched against the server's indexed
    tools both as-is and in that sanitized form.
    """
    best = ""
    server = ""
    for srv, cfg in (servers or {}).items():
        prefix = cfg.get("claude_prefix") if isinstance(cfg, dict) else None
        if (isinstance(prefix, str) and prefix and name.startswith(prefix + "__")
                and len(prefix) > len(best)):
            best, server = prefix, srv
    if not server:
        prefixes = sorted(cfg["claude_prefix"] for cfg in (servers or {}).values()
                          if isinstance(cfg, dict) and isinstance(cfg.get("claude_prefix"), str)
                          and cfg["claude_prefix"])
        listed = ", ".join(p + "__*" for p in prefixes) if prefixes else "none"
        return "", "", (f"Unknown tool '{name}': no routed MCP server has that name prefix. "
                        f"Routed prefixes: {listed}. Call manifest to list the tools.")
    rest = name[len(best) + 2:]
    tools = [info.get("tool", "") for info in index.values() if info.get("server") == server]
    if rest in tools:
        return server, rest, ""
    for tool in tools:
        if re.sub(r"[^A-Za-z0-9_-]", "_", tool) == rest:
            return server, tool, ""
    return server, rest, ""  # not indexed (yet): let the server answer for itself


def _inspect(arguments: dict, state: dict) -> dict:
    """One upstream tool's real input schema — the parameters to call it with.

    The discovery half of the compact-exposure contract: `manifest` gives
    names, this gives the arguments, and the tool is then called by its namespaced
    name. Read-only — nothing is executed here.
    """
    index = state["tool_index"]
    want_server = _as_str(arguments.get("server"))
    want_tool = _as_str(arguments.get("tool"))

    if want_tool.startswith("mcp__") and not want_server:
        # oh-my-context-mod: an original Claude tool name.
        a_server, a_tool, a_err = resolve_claude_name(want_tool, state.get("servers") or {}, index)
        if a_err:
            return {"tool": want_tool, "server": "", "inputSchema": {}, "notice": a_err}
        want_server, want_tool = a_server, a_tool

    if not want_tool:
        return {"tool": "", "server": "", "inputSchema": {},
                "notice": "Pass `tool` — a namespaced name like fetch_fetch, or a bare "
                          "tool name when only one server owns it."}

    def _resolve() -> tuple[str, str]:
        if want_tool in index:  # exact namespaced hit
            return want_tool, index[want_tool].get("server", "")
        if want_server:
            ns = namespaced_tool_name(want_server, want_tool)
            if ns in index:
                return ns, want_server
        matches = [ns for ns, info in index.items()
                   if info.get("tool") == want_tool and (not want_server or info.get("server") == want_server)]
        if len(matches) == 1:
            return matches[0], index[matches[0]].get("server", "")
        return "", ""

    ns_name, server = _resolve()
    if not ns_name:
        known = [ns for ns in index][:10]
        return {"tool": want_tool, "server": want_server, "inputSchema": {},
                "notice": f"Unknown tool: '{want_tool}'. Call manifest to list what "
                          f"is loaded" + (f". A few: {', '.join(known)}" if known else ".")}

    info = index[ns_name]
    full_def = info.get("full_def") or {}
    schema = info.get("full_schema") or full_def.get("inputSchema") or {}
    payload = {
        "tool": ns_name,
        "server": server,
        "description": _first_sentence(full_def.get("description", "") or ""),
        "inputSchema": schema,
    }
    # oh-my-context-mod: the server's own instructions, once per gateway process (shared
    # with call, which then does not repeat them).
    take = state.get("instructions_for")
    instructions = take(server) if callable(take) else ""
    if instructions:
        payload["serverInstructions"] = instructions
    return payload


def _kb_search(arguments: dict, state: dict) -> dict:  # noqa: ARG001 - uniform signature
    """Passages matching a query, from documents already indexed.

    Delegates to :mod:`oh_my_context.kb`. A KBError (empty index, no FTS5) becomes a structured
    ``error`` rather than an exception, because "index something first" is advice
    the model can act on, not a crash.
    """
    from . import kb as kb_mod

    query = _as_str(arguments.get("query"))
    k = _as_int(arguments.get("k"), 5, minimum=1)
    source = _as_str(arguments.get("source")) or None
    if not query:
        return {"query": "", "hits": [], "notes": [],
                "error": "pass a non-empty `query`"}
    try:
        report = kb_mod.search(query, k=k, source=source)
    except kb_mod.KBError as exc:
        return {"query": query, "hits": [], "notes": [], "error": str(exc)}
    return report.as_dict()


def _kb_index(arguments: dict, state: dict) -> dict:  # noqa: ARG001 - uniform signature
    """Index a local file into the knowledge base (oh-my-context-mod: no URL fetch)."""
    from . import kb as kb_mod

    path = _as_str(arguments.get("path"))
    source = _as_str(arguments.get("source")) or None
    if not path:
        return {"indexed": False, "source": "", "chunks": 0,
                "error": "pass `path` (a local file)"}
    try:
        report = kb_mod.index_file(path, source=source)
    except kb_mod.KBError as exc:
        return {"indexed": False, "source": path, "chunks": 0,
                "error": str(exc)}
    return {"indexed": True, "source": report.source, "chunks": report.chunks,
            "bytes": report.bytes, "skipped": report.skipped}


def _session(arguments: dict, state: dict) -> dict:  # noqa: ARG001 - uniform signature
    """This project's session activity, for catching up after a compaction."""
    from . import session_log

    return session_log.summarise().as_dict()


def _retrieve(arguments: dict, state: dict) -> dict:  # noqa: ARG001 - uniform signature
    """Fetch the original behind a compression handle (the CCR read half).

    The write half lives in ``serve._smart_compress``: it stores the untruncated
    result and puts the handle in a notice line. This handler is the model's way
    back to that original, which is what makes compression reversible rather
    than a dead end.

    Unknown handles answer ``found: false`` — not an error, because "that summary
    is all there is now" is a valid outcome. But the *reason* is reported, from a
    closed set: ``bad-handle`` (you mistyped it) and ``never-stored`` (it was
    evicted, or never written) call for different next moves, and collapsing all
    of them into one empty answer is how a model ends up retrying the same typo
    forever.
    """
    handle = _as_str(arguments.get("handle"))
    from . import ccr as _ccr
    if not handle:
        # "You passed nothing" and "you passed a malformed handle" are the same
        # failure from the reader's side, so they get the same sentence.
        return {"found": False, "status": _ccr.STATUS_BAD_HANDLE, "handle": "",
                "notice": _ccr.retrieve_notice(_ccr.STATUS_BAD_HANDLE)}
    try:
        status, original = _ccr.retrieve_status(handle)
    except Exception:  # pragma: no cover - defensive
        status, original = "unreadable", None
    if status == "ok":
        return {"found": True, "status": status, "handle": handle,
                "original": original}
    return {"found": False, "status": status, "handle": handle,
            "notice": _ccr.retrieve_notice(status)}


_HANDLERS = {
    "manifest": _manifest,
    "servers": _servers,
    "health": _health,
    "usage": _usage,
    "skills": _skills,
    "resolve_skills": _resolve_skills,
    "inspect": _inspect,
    "retrieve": _retrieve,
    "kb_search": _kb_search,
    "kb_index": _kb_index,
    "session": _session,
    # "call" is routed by the bridge to the upstream tool; it has no
    # handler here because it must reuse the bridge's pool, validation and
    # compression rather than duplicate them (see serve._handle_call_tool). The
    # bridge wraps the routed answer in {tool, server, result} so this tool's
    # declared outputSchema is satisfied even when the upstream returns its own
    # structuredContent (issue #33).
}


def call_native(name: str, arguments: dict, state: dict) -> dict:
    """Run a first-party tool and return an MCP tool result.

    ``state`` is assembled by the bridge (serve.MCPServerBridge._native_state). Unknown
    names raise KeyError — the caller checks :func:`is_native` first.
    """
    arguments = arguments if isinstance(arguments, dict) else {}
    payload = _HANDLERS[name](arguments, state)
    text = json.dumps(payload, ensure_ascii=False, indent=None)
    return {
        "content": [{"type": "text", "text": text}],
        "structuredContent": payload,
        "isError": False,
        "resultType": "complete",
    }
