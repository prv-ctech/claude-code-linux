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
# Modified by oh-my-context-mod (github.com/prv-ctech/claude-code-linux), 2026-10-30: stdio only (no HTTP, background or autostart mode, no plugin-skill prompts, health method, footer or presence lines); its own initialize instructions; alwaysLoad meta; `call` takes only an original Claude tool name or server plus tool, the two forms permit.js maps; lazy server instructions; per-server timeout; no danger block for a resolved call route; upstream isError and content blocks pass through; tools/call runs off the stdio reader with cancellation; cache-only cold index; routed prompts/resources pass through; compression only with the `compress` setting; renamed to oh-my-context: package, commands, tool, environment and path names (see vendor/NOTICE).

"""
oh-my-context serve — stdio bridge MCP server (ADR 0004)

Acts as a single MCP server in front of the agent, proxying all
underlying MCP servers. The agent only connects to oh-my-context (1 server),
not 100 individual servers.

  Agent  ←→  oh-my-context serve (stdio)  ←→  MCP server 1, 2, ... N

Key behaviors:
  - tools/list: returns simplified schemas (fewer tokens, ADR 0006)
  - tools/call: routes to underlying server, validates args with full schema,
    applies safety checks, compresses output
  - Tool names: {server}_{tool} namespaced (ADR 0007)
  - Parallel manifest loading: 100 servers in ~5s instead of 500s
  - Per-request timeout: no single server can hang the bridge
  - Remote MCP: supports HTTP-stream (SSE) MCP servers transparently

oh-my-context-mod: run by the plugin's .mcp.json as `bin/oh-my-context serve`.
"""

from __future__ import annotations

import concurrent.futures
import json
import os
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any

from . import __version__
from . import config
from .config import load_config, resolve_server_name
from .client import (
    MCPClient,
    MCPClientPool,
    MCPError,
    SUPPORTED_PROTOCOL_VERSIONS,
    ERR_UNSUPPORTED_PROTOCOL_VERSION,
    _META_PROTOCOL_KEY,
    DEFAULT_CALL_TIMEOUT,
)
from . import native_tools
from . import router as router_mod
from . import usage
from .schema_simplifier import (
    simplify_tool_def,
    validate_args,
    namespaced_tool_name,
    split_namespaced,
)

# MCP protocol version we speak as a server
PROTOCOL_VERSION = "2024-11-05"
_SERVER_INFO = {"name": "oh-my-context", "version": __version__}


# oh-my-context-mod: the whole `instructions` text. Facts only: no savings line. Stays
# under 1,500 characters because it rides in context on every turn.
_INSTRUCTIONS_LIMIT = 1500


def _instructions(servers: dict) -> str:
    """oh-my-context-mod: what the model needs to reach routed tools and skills."""
    names = []
    for name in sorted(servers):
        cfg = servers[name] if isinstance(servers[name], dict) else {}
        prefix = cfg.get("claude_prefix")
        names.append(prefix if isinstance(prefix, str) and prefix else name)
    tail = (
        "Any routed tool is called with this gateway's `call` tool, using its original "
        "Claude tool name (mcp__...) as `tool`, or `server` plus `tool`. `manifest` lists "
        "the routed tool names and `inspect` shows one tool's parameters. A routed "
        "server's own instructions are returned with its first call, and again after "
        "/clear, compaction or a subagent. Skills are listed "
        "by name only; `resolve_skills` returns the matching skill ids and "
        "descriptions, which are then invoked with the Skill tool as usual."
    )
    if not names:
        return "No MCP servers are routed through this gateway right now. " + tail
    head = ("These MCP servers are routed through this gateway instead of loading "
            "their tools directly (original tool-name prefixes): ")
    budget = _INSTRUCTIONS_LIMIT - len(head) - len(tail) - 40
    shown = []
    for n in names:
        if len(", ".join(shown + [n])) > budget:
            break
        shown.append(n)
    listed = ", ".join(shown)
    if len(shown) < len(names):
        listed += f" and {len(names) - len(shown)} more (see manifest)"
    return head + listed + ". " + tail


# Tools Claude Code should load with their schemas up front (no ToolSearch round
# trip) when the upstream list is withheld. oh-my-context-mod.
_ALWAYS_LOAD = ("call", "inspect", "manifest", "resolve_skills")


# CacheableResult defaults (SEP-2549) for list/read results. Env-tunable:
# OMC_LIST_TTL_MS / OMC_LIST_CACHE_SCOPE.
_LIST_TTL_DEFAULT_MS = 300_000
_LIST_SCOPE_DEFAULT = "public"


def _list_cache_fields() -> dict:
    """CacheableResult hints (SEP-2549) for list/read results.

    Returns {"ttlMs": int >= 1, "cacheScope": "public" | "private"}. Invalid
    env values fall back to the defaults instead of breaking the bridge.
    """
    ttl = _LIST_TTL_DEFAULT_MS
    raw = (os.environ.get("OMC_LIST_TTL_MS") or "").strip()
    if raw:
        try:
            parsed = int(raw)
        except ValueError:
            parsed = -1
        if parsed >= 1:
            ttl = parsed
        else:
            _log(f"invalid OMC_LIST_TTL_MS={raw!r}, "
                 f"using default {_LIST_TTL_DEFAULT_MS}")
    scope = (os.environ.get("OMC_LIST_CACHE_SCOPE") or "").strip().lower()
    if scope not in ("public", "private"):
        if scope:
            _log(f"invalid OMC_LIST_CACHE_SCOPE={scope!r}, "
                 f"using default {_LIST_SCOPE_DEFAULT}")
        scope = _LIST_SCOPE_DEFAULT
    return {"ttlMs": ttl, "cacheScope": scope}

# Default timeout for manifest loading (per server, seconds)
_DEFAULT_MANIFEST_TIMEOUT = 10
# Max workers for parallel manifest loading
_MAX_MANIFEST_WORKERS = 20


class MCPServerBridge:
    """Stdio bridge: speaks MCP server protocol to agent, proxies to underlying servers.

    Thread-safe: each JSON-RPC request is handled in the main thread but
    underlying server calls are non-blocking with timeout.
    """

    def __init__(self):
        self._start_time = time.time()
        self._pool: MCPClientPool | None = None
        self._servers: dict = {}
        # Servers whose last fetch *failed* (as opposed to answered with no tools),
        # for the `health` tool: "absent from `_tool_index`" is also true of a
        # healthy server that exposes zero tools.
        self._server_fetch_errors: dict[str, str] = {}
        # tool_index: namespaced_name → {server, tool, full_schema, full_def}
        self._tool_index: dict[str, dict] = {}
        self._tool_index_lock = threading.RLock()
        self._initialized = False
        self._lock = threading.Lock()
        self._shutdown = False
        # Progressive throttle for the gateway's own search tools. Bucketed per
        # agent context (see floodguard's docstring for the fan-out bug a global
        # counter causes). Only the search-shaped tools consult it: a throttle on
        # `manifest` would punish normal discovery.
        from .floodguard import FloodGuard
        self._flood = FloodGuard()
        # oh-my-context-mod: servers whose own instructions this process already handed over.
        self._instructions_shown: set = set()
        self._client_name = ""
        # oh-my-context-mod: stdio tools/call requests still running, and those the client
        # cancelled (they get no response, as MCP asks).
        self._inflight: set = set()
        self._cancelled: set = set()
        self._inflight_lock = threading.Lock()
        # oh-my-context-mod: routed servers' prompts/resources: owner maps.
        self._routed_prompts: dict = {}
        self._routed_resources: dict = {}
        self._routed_templates: list = []

    # ═══════════════════════════════════════════════════
    # Lifecycle
    # ═══════════════════════════════════════════════════

    def _ensure_initialized(self):
        """Lazily load config and build tool index on first use.

        Thread-safe: uses lock, double-check pattern.
        Performance: uses cache (fast path) or parallel loading (slow path).
        """
        if self._initialized:
            return
        with self._lock:
            if self._initialized:
                return
            self._servers = load_config()
            # load_config never returns the gateway's own entry (fork bomb guard).
            self._pool = MCPClientPool(self._servers)
            self._build_tool_index()
            self._initialized = True

    def _build_tool_index(self):
        """Build the namespaced tool index from all configured servers.

        Performance strategy:
          1. Fist try cached manifest (fast path, no server startup)
          2. If cache miss for some servers, load them in parallel (ThreadPoolExecutor)
          3. Cache limit: 5 minutes TTL, configurable via OMC_CACHE_TTL
        """
        # Step 1: Try cache first (fast path)
        # oh-my-context-mod: cache only. get_manifest would spawn each missing server one by
        # one in a throwaway pool; those go to the parallel fetch below through
        # self._pool, which keeps them connected for the first call.
        from . import cache as cache_mod
        cached_manifest = {}
        for server_name in self._servers:
            try:
                tools = cache_mod.get_cached_tools(server_name)
            except Exception:
                tools = None
            if tools is not None:
                cached_manifest[server_name] = tools

        # Step 2: Find which servers need live fetch
        all_servers = list(self._servers.keys())
        cached_servers = set(cached_manifest.keys())
        uncached = [s for s in all_servers if s not in cached_servers]

        # Step 3: Build index from cache entries
        for server_name in all_servers:
            tools = cached_manifest.get(server_name, [])
            if not isinstance(tools, list) or not tools:
                continue
            for tool_def in tools:
                if not isinstance(tool_def, dict) or "error" in tool_def:
                    continue
                tool_name = tool_def.get("name", "")
                if not tool_name:
                    continue
                ns_name = namespaced_tool_name(server_name, tool_name)
                with self._tool_index_lock:
                    self._tool_index[ns_name] = {
                        "server": server_name,
                        "tool": tool_name,
                        "full_schema": tool_def.get("inputSchema", {}),
                        "full_def": tool_def,
                    }

        # Step 4: Live fetch uncached servers in parallel
        if uncached:
            _log(f"Loading {len(uncached)} uncached servers in parallel...")
            self._refresh_servers_in_parallel(uncached)
            _log(f"Tool index built: {len(self._tool_index)} tools from {len(all_servers)} servers")

    def _refresh_servers_in_parallel(self, server_names: list[str]):
        """Fetch tools from specified servers in parallel using ThreadPoolExecutor.

        This is the key performance optimization for 100+ server scenarios.
        Instead of 100 × 5s = 500s serial, it runs in parallel with max 20 workers.
        """
        if not server_names:
            return

        def _fetch_one(srv: str) -> tuple[str, list[dict]]:
            try:
                tools = self._pool.list_tools(srv)
                # Cache the result; the fingerprint tells us whether this
                # server's callable surface drifted since the last refresh.
                try:
                    from .cache import set_cached_tools
                    if set_cached_tools(srv, tools):
                        _log(f"  [{srv}] tool set changed on refresh "
                             f"({len(tools)} tools) - index updated")
                except Exception:
                    pass
                with self._tool_index_lock:
                    self._server_fetch_errors.pop(srv, None)
                self._remember_capabilities(srv)  # oh-my-context-mod
                return srv, tools
            except Exception as e:
                _log(f"  [{srv}] fetch failed: {e}")
                with self._tool_index_lock:
                    self._server_fetch_errors[srv] = str(e)[:200]
                return srv, []

        executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=_MAX_MANIFEST_WORKERS,
            thread_name_prefix="oh-my-context-manifest",
        )
        try:
            fut_map = {executor.submit(_fetch_one, srv): srv for srv in server_names}
            for fut in concurrent.futures.as_completed(fut_map, timeout=60):
                try:
                    srv, tools = fut.result(timeout=_DEFAULT_MANIFEST_TIMEOUT)
                    for tool_def in tools:
                        if not isinstance(tool_def, dict) or "error" in tool_def:
                            continue
                        tool_name = tool_def.get("name", "")
                        if not tool_name:
                            continue
                        ns_name = namespaced_tool_name(srv, tool_name)
                        with self._tool_index_lock:
                            self._tool_index[ns_name] = {
                                "server": srv,
                                "tool": tool_name,
                                "full_schema": tool_def.get("inputSchema", {}),
                                "full_def": tool_def,
                            }
                except concurrent.futures.TimeoutError:
                    _log(f"  [{fut_map[fut]}] timed out ({_DEFAULT_MANIFEST_TIMEOUT}s)")
                except Exception as e:
                    _log(f"  [{fut_map[fut]}] error: {e}")
        except concurrent.futures.TimeoutError:
            # as_completed hit its 60s wall clock. Do NOT wait for the stragglers:
            # the `with` form would call shutdown(wait=True) here, blocking startup
            # until each hung server reaches its own client timeout (30s, or up to
            # a server's own long timeout) — which defeats the 60s cap entirely while
            # `_ensure_initialized`'s lock stays held. Cancel pending futures and
            # proceed with whatever landed; late arrivals still index under the lock.
            _log("  manifest refresh exceeded 60s — proceeding with a partial index")
        finally:
            executor.shutdown(wait=False, cancel_futures=True)

    def close(self):
        """Clean up resources."""
        if self._pool:
            try:
                self._pool.close()
            except Exception:
                pass
        self._initialized = False

    # ═══════════════════════════════════════════════════
    # MCP Server Protocol — JSON-RPC over stdio
    # ═══════════════════════════════════════════════════

    def run(self):
        """Main loop: read JSON-RPC from stdin, write responses to stdout.

        This is the entry point for `oh-my-context serve`.
        """
        # Force UTF-8 on the stdio pipes: a response the console codec cannot encode
        # would otherwise be swallowed by `_send_response` and hang the client.
        for _stream in (sys.stdin, sys.stdout):
            _reconf = getattr(_stream, "reconfigure", None)
            if _reconf is not None:
                try:
                    _reconf(encoding="utf-8")
                except (OSError, ValueError):
                    pass
        _log("oh-my-context serve started — stdio bridge mode")

        try:
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue

                try:
                    request = json.loads(line)
                except json.JSONDecodeError:
                    _send_response({
                        "jsonrpc": "2.0",
                        "error": {"code": -32700, "message": "Parse error"},
                        "id": None,
                    })
                    continue

                # oh-my-context-mod: a request runs on its own thread, so one slow upstream call cannot hold every other request
                # (other servers, the gateway's own tools, ping) behind it, and a
                # notifications/cancelled is read while that call still runs.
                # initialize and shutdown stay in order on this thread.
                # shortcut: a cancel is not forwarded upstream; the abandoned call keeps
                # its thread until the upstream answers or its timeout runs out.
                if isinstance(request, dict):
                    method, rid = request.get("method"), request.get("id")
                    if method == "notifications/cancelled":
                        params = request.get("params")
                        cid = params.get("requestId") if isinstance(params, dict) else None
                        with self._inflight_lock:
                            if _hashable(cid) and cid in self._inflight:
                                self._cancelled.add(cid)
                        continue
                    if rid is not None and _hashable(rid) and method not in ("initialize", "shutdown"):
                        with self._inflight_lock:
                            self._inflight.add(rid)
                        threading.Thread(target=self._handle_request, args=(request,),
                                         daemon=True, name="oh-my-context-req").start()
                        continue
                    self._handle_request(request)
                else:
                    self._handle_request({})

                if self._shutdown:
                    break

        except KeyboardInterrupt:
            _log("Interrupted")
        except EOFError:
            _log("stdin closed")
        except Exception as e:
            _log(f"Fatal: {e}")
            traceback.print_exc(file=sys.stderr)
        finally:
            self.close()
            _log("oh-my-context serve stopped")

    def _respond(self, response: dict):
        """Send a response, unless the client cancelled the request."""
        # oh-my-context-mod: a request the client cancelled gets no response.
        rid = response.get("id") if isinstance(response, dict) else None
        if _hashable(rid):
            with self._inflight_lock:
                self._inflight.discard(rid)
                if rid in self._cancelled:
                    self._cancelled.discard(rid)
                    return
        _send_response(response)


    def _handle_request(self, request: dict):
        """Dispatch a single JSON-RPC request."""
        method = request.get("method", "")
        req_id = request.get("id")
        params = request.get("params", {})
        if not isinstance(params, dict):
            params = {}

        # Notification (no id) — don't respond
        if req_id is None:
            if method == "notifications/initialized":
                _log("Client initialized notification received")
            return

        # 2026-07-28 GA: requests are self-describing. A _meta protocolVersion
        # we cannot speak is rejected up front (UnsupportedProtocolVersionError).
        meta = params.get("_meta")
        if isinstance(meta, dict):
            meta_version = meta.get(_META_PROTOCOL_KEY) or meta.get("protocolVersion")
            if meta_version and meta_version not in SUPPORTED_PROTOCOL_VERSIONS:
                self._respond(_make_error_response(
                    req_id,
                    ERR_UNSUPPORTED_PROTOCOL_VERSION,
                    f"Unsupported protocol version: {meta_version}",
                ))
                return

        try:
            if method == "initialize":
                result = self._handle_initialize(params)
                self._respond(_make_success(req_id, result))
            elif method == "server/discover":
                result = self._handle_discover()
                self._respond(_make_success(req_id, result))
            elif method == "tools/list":
                result = self._handle_list_tools(params)
                self._respond(_make_success(req_id, result))
            elif method == "tools/call":
                result = self._handle_call_tool(params)
                self._respond(_make_success(req_id, result))
            elif method == "ping":
                self._respond(_make_success(req_id, {"resultType": "complete"}))
            elif method == "resources/list":
                result = self._handle_list_resources()
                self._respond(_make_success(req_id, result))
            elif method == "resources/read":
                # oh-my-context-mod: a routed server's resource, read from that server.
                result = self._read_routed_resource(params)
                if result is None:
                    self._respond(_make_error_response(
                        req_id, -32002, f"Resource not found: {params.get('uri', '')}"))
                else:
                    self._respond(_make_success(req_id, result))
            elif method == "resources/templates/list":
                # oh-my-context-mod: routed servers' resource templates.
                result = {"resourceTemplates": self._gather_routed("resources", "templates")}
                result.update(_list_cache_fields())
                result["resultType"] = "complete"
                self._respond(_make_success(req_id, result))
            elif method == "prompts/list":
                result = self._handle_list_prompts()
                self._respond(_make_success(req_id, result))
            elif method == "prompts/get":
                result = self._handle_get_prompt(params)
                if result is None:
                    self._respond(_make_error_response(
                        req_id, -32602, "Unknown prompt"))
                else:
                    self._respond(_make_success(req_id, result))
            elif method == "logging/setLevel":
                _log(f"Client set logging level: {params.get('level', 'info')}")
                self._respond(_make_success(req_id, {}))
            else:
                self._respond(_make_error_response(req_id, -32601, f"Method not found: {method}"))
        except MCPError as e:
            self._respond(_make_error_response(req_id, -32603, f"[{e.code}] {e.message}"))
        except Exception as e:
            self._respond(_make_error_response(req_id, -32603, str(e)[:200]))

        if method == "shutdown":
            self._shutdown = True

    # ═══════════════════════════════════════════════════
    # MCP Method Handlers
    # ═══════════════════════════════════════════════════

    def _handle_initialize(self, params: dict) -> dict:
        """Respond to the (legacy) initialize handshake.

        2026-07-28 removed the handshake from the protocol — the bridge no
        longer requires it — but pre-GA clients still send it, so it keeps
        working. A requested version we support is echoed back; anything
        else gets the legacy default.
        """
        _log(f"Initialize from client: {params.get('clientInfo', {})}")
        # Remember the client's self-reported name for the flood guard's per-agent
        # bucketing. Best-effort: an unknown client must not break the handshake.
        _ci = params.get("clientInfo")
        if isinstance(_ci, dict):
            self._client_name = str(_ci.get("name") or _ci.get("title") or "")
        client_version = params.get("protocolVersion", PROTOCOL_VERSION)
        version = (
            client_version
            if client_version in SUPPORTED_PROTOCOL_VERSIONS
            else PROTOCOL_VERSION
        )
        result = {
            "protocolVersion": version,
            "capabilities": {
                "tools": {},
                "resources": {},
                "prompts": {},
                # 2026-07-28: capabilities carry an extensions field
                "extensions": {},
            },
            "serverInfo": _SERVER_INFO,
            "resultType": "complete",
        }
        # `instructions` is the protocol's official channel for a server to brief
        # the model; it costs context on every turn.
        # oh-my-context-mod: reads the config file only; no upstream
        # server starts for the handshake.
        try:
            result["instructions"] = _instructions(load_config())
        except Exception:
            result["instructions"] = _instructions({})
        return result

    def _handle_discover(self) -> dict:
        """server/discover (2026-07-28): advertise versions/capabilities/identity.

        Clients MAY call this before any other request for up-front version
        selection. Cheap by design: no config load, no server startup.
        """
        return {
            "protocolVersions": list(SUPPORTED_PROTOCOL_VERSIONS),
            "capabilities": {
                "tools": {},
                "resources": {},
                "prompts": {},
                "extensions": {},
            },
            "serverInfo": dict(_SERVER_INFO),
            "resultType": "complete",
        }

    def _handle_list_resources(self) -> dict:
        """resources/list.

        oh-my-context-mod: the resources of the routed servers that offer
        them (see `_gather_routed`).
        """
        result = {"resources": self._gather_routed("resources", "resources")}
        result.update(_list_cache_fields())
        result["resultType"] = "complete"
        return result

    def _handle_list_prompts(self) -> dict:
        """prompts/list: the routed servers' prompts (oh-my-context-mod)."""
        prompts = self._gather_routed("prompts", "prompts")
        _log(f"prompts/list: returning {len(prompts)} routed prompts")
        result = {"prompts": prompts}
        result.update(_list_cache_fields())
        result["resultType"] = "complete"
        return result

    def _handle_get_prompt(self, params: dict) -> dict | None:
        """prompts/get: a routed server's prompt (oh-my-context-mod)."""
        self._ensure_initialized()
        return self._get_routed_prompt(str(params.get("name", "")), params.get("arguments"))

    def _handle_list_tools(self, params: dict) -> dict:
        """Return the gateway's tool list.

        Two exposure presets (CONTEXT.md: "Tool Exposure Preset", ADR 0012):

        * ``compact`` (default) — oh-my-context's own tools only. Upstream tools stay
          reachable (`manifest` names them, `call` runs them) but
          are not enumerated, which is what makes the gateway cost ~2.0k tokens
          per turn instead of ~18.0k. This is the "compact manifest" ADR 0004
          promised: "Claude Code 只看到 1 个 MCP server".
        * ``full`` — also list every upstream tool with a simplified schema
          (ADR 0006 layered schema). The pre-2026-09-25 behavior, kept as the
          fallback for a host whose tool panel reads this list, or a model that
          will not ask for the manifest.

        Each tool name is namespaced: {server}_{tool} (ADR 0007).
        Thread-safe: reads from _tool_index under RLock.
        """
        self._ensure_initialized()

        compact = config.compact_exposure()

        with self._tool_index_lock:
            tools: list[dict] = []
            if not compact:
                for ns_name, info in sorted(self._tool_index.items()):
                    full_def = info.get("full_def", {})
                    simplified = simplify_tool_def(full_def)
                    simplified["name"] = ns_name  # Override with namespaced name
                    tools.append(simplified)

            # First-party tools: published even with zero upstream servers, so a
            # gateway launched in a clean environment never reports an empty catalog
            # (a directory crawler or client that just started us would otherwise see
            # a tool-less server and have nothing to evaluate). An upstream tool that
            # happens to claim the same namespaced name wins — we skip ours.
            # Under `compact` these are the whole list, which is exactly why the
            # initialize directive has to say where the upstream tools went.
            for defn in native_tools.native_tools():
                if defn["name"] in self._tool_index:
                    continue
                tools.append(simplify_tool_def(defn))
                if compact and defn["name"] in _ALWAYS_LOAD:
                    # oh-my-context-mod: Claude Code loads these schemas without a ToolSearch.
                    tools[-1]["_meta"] = {**(tools[-1].get("_meta") or {}),
                                          "anthropic/alwaysLoad": True}

        _log(f"tools/list: returning {len(tools)} tools "
             f"(exposure={'compact' if compact else 'full'})")
        # SEP-2549 CacheableResult + GA resultType on list results
        result = {"tools": tools}
        result.update(_list_cache_fields())
        result["resultType"] = "complete"
        return result

    def _native_state(self) -> dict:
        """Read-only snapshot of bridge state for the first-party tools."""
        with self._tool_index_lock:
            index = dict(self._tool_index)
            fetch_errors = dict(self._server_fetch_errors)
        return {
            "servers": self._servers or {},
            "tool_index": index,
            # The *authoritative* failure signal: a server whose fetch raised. The
            # native health tool must use this, not "absent from tool_index" — that
            # is also true of a healthy server that exposes no tools, and inferring
            # failure from the index made one alive-but-empty server report error.
            "fetch_errors": fetch_errors,
            "initialized": self._initialized,
            "uptime": time.time() - self._start_time,
            # oh-my-context-mod: inspect never starts a server for its instructions.
            "instructions_for": lambda s: self._take_instructions(s, connect=False),
        }

    def _take_instructions(self, server: str, connect: bool = True) -> str:
        """oh-my-context-mod: a server's own initialize instructions, once per context.

        A context ends when hooks/sync.js touches `<OMC_HOME>/instructions-epoch`
        (on /clear, compaction and subagent start/stop): the next call hands them over
        again. With connect (call) the server is connected if needed; without
        it (inspect) only a server that is already running counts. Empty when
        the server sent none, it was already handed over, or it is not running/cannot
        start.
        """
        shown = self._instructions_shown
        try:
            epoch = (config.CONFIG_DIR / "instructions-epoch").stat().st_mtime_ns
        except OSError:
            epoch = None
        with _instructions_lock:
            if epoch != getattr(self, "_instructions_epoch", None):
                self._instructions_epoch = epoch
                shown.clear()
            if not server or server in shown:
                return ""
        try:
            client = (self._pool._get_client(server) if connect
                      else self._pool._clients.get(server))
        except Exception:
            return ""
        if client is None:
            return ""
        with _instructions_lock:
            if server in shown:  # a parallel call took them first
                return ""
            shown.add(server)
        text = getattr(client, "server_instructions", None)
        return text.strip() if isinstance(text, str) else ""

    def _call_route(self, name: str, tool: str, server: str):
        """oh-my-context-mod: the exact (server, tool) of a `call`, or an error result.

        Accepted: (a) `tool` = the original Claude name (mcp__...), with `server`
        optional but then naming the same server; (b) `server` plus the server's own
        tool name as `tool`. The legacy `name` (server_tool) and a bare tool name are
        refused: hooks/permit.js cannot map them back to a Claude tool name.
        """
        if name or not tool or (not tool.startswith("mcp__") and not server):
            return _make_tool_error(_CALL_FORMS)
        servers = self._servers or {}
        if tool.startswith("mcp__"):
            with self._tool_index_lock:
                index = dict(self._tool_index)
            a_server, a_tool, a_err = native_tools.resolve_claude_name(tool, servers, index)
            if a_err:
                return _make_tool_error(a_err)
            if server and server != a_server:
                return _make_tool_error(
                    f"`server` '{server}' does not match '{tool}', which belongs to the "
                    f"routed server '{a_server}'. Omit `server` or pass the matching one.")
            return (a_server, a_tool)
        if server not in servers:
            return _make_tool_error(
                f"Unknown server '{server}'. Routed servers: "
                f"{', '.join(sorted(servers)) or 'none'}. " + _CALL_FORMS)
        return (server, tool)

    # ── oh-my-context-mod: routed servers' prompts and resources ──

    def _capabilities_file(self) -> Path:
        from . import cache as cache_mod
        return cache_mod._cache_dir() / "capabilities.json"

    def _known_capabilities(self) -> dict:
        caps = getattr(self, "_capabilities", None)
        if caps is None:
            try:
                caps = json.loads(self._capabilities_file().read_text(encoding="utf-8"))
            except (OSError, ValueError):
                caps = {}
            self._capabilities = caps = caps if isinstance(caps, dict) else {}
        return caps

    def _remember_capabilities(self, server: str) -> None:
        """Record a connected server's capabilities, so prompts/list and resources/list
        only ask the servers that offer them and never start one that does not."""
        try:
            client = self._pool._clients.get(server)
            caps = getattr(client, "server_capabilities", None)
            if not isinstance(caps, dict):
                return
            caps = {k: True for k in ("prompts", "resources") if k in caps}
            with _instructions_lock:
                known = self._known_capabilities()
                if known.get(server) == caps:
                    return
                known[server] = caps
                snapshot = dict(known)
            from . import cache as cache_mod
            cache_mod._atomic_write(self._capabilities_file(), snapshot)
        except Exception:
            pass

    def _gather_routed(self, capability: str, kind: str) -> list:
        """prompts, resources or resource templates of every routed server that offers
        `capability`, fetched in parallel. A failing server is skipped, not fatal."""
        self._ensure_initialized()
        known = self._known_capabilities()
        servers = [s for s in sorted(self._servers or {})
                   if (known.get(s) or {}).get(capability)]
        if not servers:
            return []
        fetch = {"prompts": self._pool.list_prompts, "resources": self._pool.list_resources,
                 "templates": self._pool.list_resource_templates}[kind]

        def one(srv):
            try:
                return srv, fetch(srv) or []
            except Exception as e:  # noqa: BLE001
                _log(f"  [{srv}] {kind} list failed: {e}")
                return srv, []

        out = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
            for srv, items in ex.map(one, servers):
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    if kind == "prompts" and item.get("name"):
                        name = f"{srv}__{item['name']}"
                        self._routed_prompts[name] = (srv, item["name"])
                        out.append({**item, "name": name})
                    elif kind == "resources" and item.get("uri"):
                        self._routed_resources[item["uri"]] = srv
                        out.append(item)
                    elif kind == "templates" and item.get("uriTemplate"):
                        prefix = str(item["uriTemplate"]).split("{", 1)[0]
                        self._routed_templates.append((prefix, srv))
                        out.append(item)
        return out

    def _get_routed_prompt(self, name: str, arguments) -> dict | None:
        owner = self._routed_prompts.get(name)
        if owner is None and "__" in name:
            srv, prompt = name.split("__", 1)
            owner = (srv, prompt) if srv in (self._servers or {}) else None
        if owner is None:
            return None
        result = self._pool.get_prompt(owner[0], owner[1],
                                       arguments if isinstance(arguments, dict) else None)
        texts = [m.get("content", {}).get("text", "") for m in result.get("messages") or []
                 if isinstance(m, dict) and isinstance(m.get("content"), dict)]
        poison = router_mod._check_poisoning("\n".join(t for t in texts if isinstance(t, str)))
        if poison:
            raise MCPError(-32003, f"prompt blocked: {poison}")
        return result

    def _read_routed_resource(self, params: dict) -> dict | None:
        self._ensure_initialized()
        uri = str(params.get("uri", ""))
        srv = self._routed_resources.get(uri)
        if srv is None:
            # A URI built from a template: the server whose template prefix matches longest.
            matches = [(len(p), s) for p, s in self._routed_templates if p and uri.startswith(p)]
            srv = max(matches)[1] if matches else None
        if srv is None:
            return None
        return self._pool.read_resource(srv, uri)

    def _throttle_search(self, name: str) -> dict | None:
        """Apply the per-agent flood guard to the gateway's search tools.

        Returns a tool result to send *instead of* running the tool when the call
        is blocked, or None to let it proceed. Only the search-shaped tools are
        throttled — throttling `manifest` would punish ordinary discovery,
        which is the opposite of what the gateway is for.

        The bucket key is the calling agent context. A stdio bridge serves one
        client, so ``clientInfo`` name plus thread identity is the honest
        granularity available; it keeps a fan-out of subagents from sharing one
        budget (the bug that made a legitimate 10-agent × 2-call fan-out look like
        a flood in the project this guard is modelled on).
        """
        if name not in ("kb_search", "resolve_skills"):
            return None
        key = f"{self._client_name or 'unknown'}:{threading.get_ident()}"
        decision = self._flood.record(key, int(time.time() * 1000))
        if decision.blocked:
            return _make_tool_error(decision.message(name))
        return None

    def _handle_call_tool(self, params: dict, route: tuple | None = None) -> dict:
        """Route a tool call to the underlying server (ADR 0004).

        Thread-safe: reads from _tool_index under RLock.
        Timeout: the server entry's own "timeout", else DEFAULT_CALL_TIMEOUT.
        oh-my-context-mod: `route` is an exact (server, tool) that call already
        resolved; a server's own "timeout" in the config wins over the default.
        """
        self._ensure_initialized()

        name = params.get("name", "")
        arguments = params.get("arguments", {})
        if route:
            name = namespaced_tool_name(*route)  # oh-my-context-mod

        # First-party tools are answered by the gateway itself, no upstream needed.
        # Skipped if an upstream tool owns that name (upstream always wins).
        # Stamped like a proxied result: the gateway's own tools are what an agent
        # reaches for first, so leaving them out would mean a client that only ever
        # calls `manifest` never sees the line at all.
        if native_tools.is_native(name):
            with self._tool_index_lock:
                owned_upstream = name in self._tool_index
            if not owned_upstream:
                if name == "call":
                    # The bridge's own escape hatch for `exposure=compact`: unwrap
                    # {name, arguments} and re-enter the very path a direct call
                    # takes, so validation, danger checks, compression and usage
                    # tracking are shared rather than duplicated. This is what makes
                    # withholding the tool list safe — the listing is gone, the
                    # capability is not.
                    inner = arguments if isinstance(arguments, dict) else {}
                    target = inner.get("name", "")
                    target = target.strip() if isinstance(target, str) else ""
                    # oh-my-context-mod: only the two forms hooks/permit.js maps back to a
                    # Claude tool name (`tool` as mcp__..., or `server` plus `tool`), so the
                    # person's permission rules always apply.
                    route = self._call_route(
                        target, native_tools._as_str(inner.get("tool")),
                        native_tools._as_str(inner.get("server")))
                    if isinstance(route, dict):
                        return route
                    target = namespaced_tool_name(*route)
                    target_args = inner.get("arguments", {})
                    if not isinstance(target_args, dict):
                        target_args = {}
                    return self._wrap_call_envelope(
                        self._handle_call_tool({"name": target, "arguments": target_args},
                                               route=route),
                        route)
                guard = self._throttle_search(name)
                if guard is not None:
                    return guard
                usage.track_call()
                return native_tools.call_native(name, arguments, self._native_state())
        # oh-my-context-mod: the gateway's own tools carry no prefix, so no prefix is reserved.

        # Split namespaced name
        known_servers = list(self._servers.keys()) if self._servers else []
        server, tool = route or split_namespaced(name, known_servers)  # oh-my-context-mod: route

        if not server:
            # Try fuzzy: maybe the agent called just the tool name
            with self._tool_index_lock:
                server = _find_server_for_tool(name, self._tool_index)
            tool = name if server else tool

        if not server or not tool:
            with self._tool_index_lock:
                available = list(self._tool_index.keys())[:10]
            return _make_tool_error(
                f"Unknown tool: '{name}'. "
                f"Use namespaced format: server_tool (e.g. fetch_fetch). "
                f"Available: {', '.join(available)}..."
            )

        # Resolve server name (handles aliases)
        server = route[0] if route else resolve_server_name(server)  # oh-my-context-mod: exact

        # Validate args against full schema
        with self._tool_index_lock:
            info = self._tool_index.get(name)
        annotations = None
        if info:
            full_schema = info.get("full_schema", {})
            full_def = info.get("full_def") or {}
            if isinstance(full_def, dict):
                ann = full_def.get("annotations")
                if isinstance(ann, dict):
                    annotations = ann
            errors = validate_args(arguments, full_schema)
            if errors:
                return _make_tool_error(
                    f"Parameter validation failed: {'; '.join(errors)}"
                )

        # Safety checks via router (pass in-memory annotations so a readOnlyHint
        # clears a name false-positive and a destructiveHint blocks a neutral name)
        # oh-my-context-mod: under the plugin a PreToolUse hook mirrors Claude Code's own
        # permission rules for call, so the gateway does not block on its own;
        # only for a call call resolved to an exact route, the forms permit.js
        # maps. A direct call (exposure=full) keeps the block.
        danger = None if route else router_mod._check_dangerous(server, tool, arguments, annotations)
        if danger:
            return _make_tool_error(
                f"Blocked: {danger}. Run it through the `call` tool, where your "
                f"permission rules decide.")

        # Route to underlying server (with timeout)
        try:
            # Call with timeout. Keep the full envelope, not just the extracted
            # payload: a tool that advertises an outputSchema in tools/list MUST
            # answer with matching structuredContent, or a strict client rejects
            # the whole result (issue #22). call() would unwrap that away.
            call_timeout = _server_call_timeout(self._servers.get(server))  # oh-my-context-mod
            envelope = self._call_with_timeout(self._pool, server, tool, arguments, call_timeout)

            # Compression runs on the payload view.
            payload = _unwrap_envelope(envelope)
            # oh-my-context-mod: an upstream isError result is a failed call.
            upstream_failed = isinstance(envelope, dict) and bool(envelope.get("isError"))
            usage.track_call()
            self._log_event(server, tool, arguments, ok=not upstream_failed)
            self._remember_capabilities(server)  # oh-my-context-mod

            if isinstance(envelope, dict) and envelope.get("structuredContent") is not None:
                # Build the response from the envelope explicitly. Passing the
                # payload to _make_tool_result() would misread one that carries a
                # "content" key (filesystem's list_directory declares exactly that)
                # as an already-wrapped result and return that same object, so
                # attaching structuredContent would nest the result inside itself.
                result = dict(envelope)
                compressed = self._compress_result(payload, server, tool)
                if compressed is not payload or not isinstance(result.get("content"), list):
                    # A compression format re-renders the text view; otherwise keep
                    # the upstream content blocks and only synthesise them if absent.
                    result["content"] = [{"type": "text", "text": (
                        compressed if isinstance(compressed, str)
                        else json.dumps(compressed, ensure_ascii=False))}
                    ] + _non_text_blocks(envelope)  # oh-my-context-mod
                result.setdefault("isError", False)
                result.setdefault("resultType", "complete")
            elif upstream_failed:
                # oh-my-context-mod: an upstream tool failure stays a failure, as a direct call would.
                content = envelope.get("content")
                result = {"content": (content if isinstance(content, list) and content
                                      else [{"type": "text", "text": "MCP tool returned error"}]),
                          "isError": True, "resultType": "complete"}
            else:
                compressed = self._compress_result(payload, server, tool)
                if (compressed is payload and isinstance(envelope, dict)
                        and isinstance(envelope.get("content"), list)):
                    # oh-my-context-mod: nothing was compressed; hand on the upstream blocks as
                    # sent (no JSON wrapping, no merged text, images and links kept).
                    result = {"content": list(envelope["content"]),
                              "isError": False, "resultType": "complete"}
                else:
                    result = _make_tool_result(compressed)
                    if result is not compressed and isinstance(result.get("content"), list):
                        # oh-my-context-mod: compression rewrites the text view only.
                        result["content"] = result["content"] + _non_text_blocks(envelope)

            # oh-my-context-mod: the server's own instructions ride along with its first
            # successful call, once per gateway process.
            if not result.get("isError") and isinstance(result.get("content"), list):
                instructions = self._take_instructions(server)
                if instructions:
                    result["content"] = [{"type": "text", "text": (
                        f"[Instructions from MCP server '{server}', shown once]\n"
                        f"{instructions}")}] + result["content"]

            return result

        except MCPError as e:
            usage.track_call()
            self._log_event(server, tool, arguments, ok=False)
            return _make_tool_error(f"[{e.code}] {e.message}")
        except concurrent.futures.TimeoutError:
            _timeout = _server_call_timeout(self._servers.get(server))  # oh-my-context-mod
            usage.track_call()
            self._log_event(server, tool, arguments, ok=False)
            return _make_tool_error(f"Call timed out after {_timeout}s")
        except Exception as e:
            usage.track_call()
            self._log_event(server, tool, arguments, ok=False)
            return _make_tool_error(f"Call failed: {str(e)[:200]}")

    def _wrap_call_envelope(self, result: dict, route: tuple) -> dict:
        """Wrap a routed answer in the shape `call` advertises.

        `call` declares an outputSchema requiring `tool` and `server`, but
        the escape hatch re-enters the direct-call path and returned that path's
        envelope verbatim — so when the upstream tool answered with its own
        structuredContent (``{"entities": [], "relations": []}`` and the like), a
        strict client rejected every such call: the response did not match the
        schema the gateway itself published (issue #33, a side effect of #22).

        This rebuilds ``{tool, server, result}`` from whatever the routed call
        produced, so the declared schema is always satisfied:

        * success with structuredContent -> ``result`` is that structuredContent,
          and the upstream text view is kept as the content block;
        * success without it -> ``result`` is the unwrapped payload;
        * a routed failure (bad args, danger block, timeout, unknown tool) ->
          ``isError`` stays true (the failure is still reported) and ``result``
          carries the error text, so even an error answer matches the schema.

        It wraps, it does not re-run: validation, danger checks, compression,
        and usage accounting all already happened inside the
        routed call and are preserved here.
        """
        server, tool = route  # oh-my-context-mod: already exact

        failed = bool(isinstance(result, dict) and result.get("isError"))
        structured = result.get("structuredContent") if isinstance(result, dict) else None
        if structured is None and failed:
            # No upstream payload to expose; surface the error text as the
            # wrapped result rather than inventing an empty object.
            text = _error_text(result)
            structured = {"error": text} if text else {}

        # oh-my-context-mod: `result` only carries the upstream's own structuredContent (or the
        # error). Re-deriving it from the content blocks repeated the whole payload (an
        # image's base64 twice) and glued the server instructions into it.
        wrapped = {"tool": tool, "server": server}
        if structured is not None:
            wrapped["result"] = structured

        out: dict = {
            "structuredContent": wrapped,
            "isError": failed,
            "resultType": "complete",
        }
        if isinstance(result, dict) and isinstance(result.get("content"), list):
            out["content"] = result["content"]
        else:
            out["content"] = [{"type": "text", "text": json.dumps(
                wrapped, ensure_ascii=False)}]  # oh-my-context-mod
        return out

    def _log_event(self, server: str, tool: str, arguments: Any, ok: bool) -> None:
        """Record one routed call in the per-project session log.

        Best-effort and never raises: the log is a convenience for catching up
        after a compaction, and must not be able to fail the call it is logging.
        """
        try:
            from . import session_log
            session_log.record(server, tool, arguments, ok=ok)
        except Exception:
            pass

    def _call_with_timeout(
        self, pool: MCPClientPool, server: str, tool: str,
        arguments: dict, timeout: int,
    ) -> Any:
        """Execute a tool call with a timeout in a worker thread.

        This prevents a single hung MCP server from blocking the entire bridge.
        On timeout, the thread is abandoned (daemon) but the subprocess is killed.
        """
        result_container = []
        error_container = []
        event = threading.Event()
        worker_thread = [None]  # Store reference for cleanup

        def _worker():
            t = threading.current_thread()
            worker_thread[0] = t
            try:
                r = pool.call_full(server, tool, arguments)
                result_container.append(r)
            except Exception as e:
                error_container.append(e)
            finally:
                event.set()

        t = threading.Thread(target=_worker, daemon=True, name=f"oh-my-context-call-{server}-{tool}")
        t.start()

        if not event.wait(timeout=timeout):
            # Timeout — try to kill the underlying subprocess if possible
            # This is best-effort since the thread is stuck in I/O
            try:
                client = pool._clients.get(server)
                if client and client._proc:
                    client._proc.kill()
            except Exception:
                pass
            raise concurrent.futures.TimeoutError(f"Tool call timed out after {timeout}s")

        if error_container:
            raise error_container[0]
        return result_container[0] if result_container else None

    # ═══════════════════════════════════════════════════
    # Helpers
    # ═══════════════════════════════════════════════════

    def _compress_result(self, result: Any, server: str, tool: str) -> Any:
        """The `compress` setting: "smart" compresses (see `_smart_compress`), "off" (the
        default) returns the result untouched."""
        if config.compression_mode() == "smart":
            return self._smart_compress(result, server, tool)
        return result

    def _smart_compress(self, result: Any, server: str, tool: str) -> Any:
        """Structure-aware compression + CCR (see compressor.py / ccr.py).

        The compressed payload is the summary; the *original* goes to the CCR
        store and its handle rides along in a one-line notice, so a model that
        needs a dropped detail can call ``retrieve`` instead of being
        stuck. A result that was not shrunk is returned untouched. A result that
        *was* shrunk but could not be stored still comes back compressed — with a
        notice that says so — because the one thing this path must never produce
        is a trimmed view with no way back and no explanation.
        """
        try:
            from . import compressor as _compressor
            text, _stats = _compressor.compress_with_ccr(result, server=server, tool=tool)
            return text if text is not None else result
        except Exception:
            return result


# ═══════════════════════════════════════════════════
# JSON-RPC helpers
# ═══════════════════════════════════════════════════

def _make_success(req_id, result: dict) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "result": result,
    }


def _make_error_response(req_id, code: int, message: str) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": code, "message": message},
    }


def _unwrap_envelope(envelope: Any) -> Any:
    """Reduce a tools/call envelope to the payload ``pool.call`` used to return.

    ``pool.call`` is ``_extract_content(pool.call_full(...))`` by construction, so
    this keeps usage accounting and --format compression seeing exactly the value
    they saw before the envelope was preserved. Non-dict inputs pass straight
    through (e.g. the legacy fallback pool, which already returns a payload).
    """
    if isinstance(envelope, dict) and ("content" in envelope or "structuredContent" in envelope):
        return MCPClient._extract_content(envelope)
    return envelope


def _make_tool_result(content: Any) -> dict:
    """Format a successful tool result as MCP content response."""
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        # Already MCP content array format
        return {"content": content, "isError": False, "resultType": "complete"}
    elif isinstance(content, dict) and "content" in content:
        # Already wrapped
        return content
    else:
        text = json.dumps(content, ensure_ascii=False) if content is not None else "null"

    return {
        "content": [{"type": "text", "text": text}],
        "isError": False,
        "resultType": "complete",
    }


_CALL_FORMS = (  # oh-my-context-mod
    "`call` takes `tool` as the original Claude tool name (mcp__<server>__<tool>; "
    "`server` optional), or `server` plus the server's own tool name as `tool`. "
    "Call `manifest` to list the routed tools.")


def _non_text_blocks(envelope: Any) -> list:
    """oh-my-context-mod: upstream image/audio/resource blocks, which a text compression must not drop."""
    blocks = envelope.get("content") if isinstance(envelope, dict) else None
    return [b for b in blocks or [] if isinstance(b, dict) and b.get("type") != "text"]


def _hashable(value: Any) -> bool:
    """oh-my-context-mod: a JSON-RPC id usable as a set member (str or number)."""
    return isinstance(value, (str, int, float)) and not isinstance(value, bool)


def _make_tool_error(message: str) -> dict:
    """Format a tool error as MCP content response."""
    return {
        "content": [{"type": "text", "text": f"Error: {message}"}],
        "isError": True,
        "resultType": "complete",
    }


def _error_text(result: Any) -> str:
    """Pull the human-readable message out of a routed error result."""
    if not isinstance(result, dict):
        return str(result) if result else ""
    for block in result.get("content") or []:
        if isinstance(block, dict) and isinstance(block.get("text"), str):
            return block["text"]
    return ""

def _find_server_for_tool(tool_name: str, tool_index: dict) -> str:
    """Try to find which server owns a tool by name (fuzzy fallback)."""
    for ns_name, info in tool_index.items():
        if info["tool"] == tool_name:
            return info["server"]
    return ""


# oh-my-context-mod: one response line at a time on stdout; one instructions handover (and one
# capabilities record update) at a time.
_stdout_write_lock = threading.Lock()
_instructions_lock = threading.Lock()


def _send_response(response: dict):
    """Send a JSON-RPC response on stdout."""
    data = json.dumps(response, ensure_ascii=False)
    try:
        with _stdout_write_lock:  # oh-my-context-mod: responses come from request threads
            sys.stdout.write(data + "\n")
            sys.stdout.flush()
    except Exception as e:
        _log(f"Failed to send response: {e}")


def _log(msg: str):
    """Log to stderr (stdout is reserved for JSON-RPC protocol)."""
    sys.stderr.write(f"[oh-my-context serve] {msg}\n")
    sys.stderr.flush()


def _server_call_timeout(cfg) -> float:
    """oh-my-context-mod: a server's own "timeout" (seconds) wins over the gateway default.

    The client already used it for its request deadline, but the gateway's outer
    wait used the default, so a 600 s server was cut off at 30 s.
    """
    value = cfg.get("timeout") if isinstance(cfg, dict) else None
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
        return value
    return DEFAULT_CALL_TIMEOUT


def run_serve() -> None:
    """Entry point for `oh-my-context serve`: the stdio gateway."""
    MCPServerBridge().run()
