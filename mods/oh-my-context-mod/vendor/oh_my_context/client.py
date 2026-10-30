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
# Modified by oh-my-context-mod (github.com/prv-ctech/claude-code-linux), 2026-10-30: keep server instructions; upstreams start without the launcher's Python/OMC env; renew an expired HTTP session once; remote HTTP servers honour proxy env; only what the gateway uses is kept (no CLI transport/spec options, completion or MRTR retry); a non-JSON-RPC HTTP error body is an HTTP error, and a 401 points to direct_servers; a server that died before its deadline is reported as PROCESS_DIED (upstream 27dd0ddac); renamed to oh-my-context: package, commands, tool, environment and path names (see vendor/NOTICE).

"""
oh-my-context client — Universal MCP client (HTTP + stdio)

Supports both transport modes defined by the Model Context Protocol:
  - stdio:  subprocess + JSON-RPC over stdin/stdout
  - http:   POST JSON-RPC to HTTP endpoint, handle SSE responses

Usage:
    # stdio (most common — any npx @modelcontextprotocol/server-* works out of box)
    client = MCPClient(stdio=["npx", "-y", "@modelcontextprotocol/server-everything"])
    client.initialize()
    tools = client.list_tools()
    result = client.call_tool_full("echo", {"message": "hi"})
    client.close()

    # http
    client = MCPClient(http="http://localhost:3001/mcp", headers={"Authorization": "Bearer xxx"})
    client.initialize()
    result = client.call_tool_full("search", {"query": "AI"})
    client.close()
"""
from __future__ import annotations

import collections
import json
import os
import queue
import subprocess
import threading
import time
import urllib.parse  # oh-my-context-mod: _http_opener
import urllib.request
import urllib.error
from typing import Any, Optional

from . import __version__


# ─── MCP Protocol Constants ───

#: Newest MCP specification revision this client implements.
#: 2026-07-28 is the stateless revision: no initialize handshake, per-request
#: ``_meta`` versioning, ``server/discover`` RPC, MRTR multi round-trips.
LATEST_PROTOCOL_VERSION = "2026-07-28"

#: Revision used for the legacy initialize() handshake. Servers reply with
#: their own version; anything at or below this gets classic session semantics.
LEGACY_PROTOCOL_VERSION = "2025-06-18"

#: Default ``User-Agent`` for HTTP transport requests. urllib would otherwise
#: announce ``Python-urllib/3.x``, which bot filters in front of public hosted
#: endpoints (Cloudflare error 1010 and friends) reject outright — the server
#: is never reached, so the failure looks like a transport bug but is not.
#: A ``User-Agent`` in the server's own ``headers`` wins over this default.
DEFAULT_USER_AGENT = f"oh-my-context/{__version__}"

#: Every revision oh-my-context knows how to talk to, newest first.
SUPPORTED_PROTOCOL_VERSIONS = [
    "2026-07-28",
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
]


#: Both response shapes are accepted (a server may answer either way).
_HTTP_ACCEPT = "application/json, text/event-stream"


# _meta keys defined by the 2026-07-28 spec (stateless request annotation)
_META_PROTOCOL_KEY = "io.modelcontextprotocol/protocolVersion"
_META_CAPS_KEY = "io.modelcontextprotocol/clientCapabilities"
_META_CLIENT_KEY = "io.modelcontextprotocol/clientInfo"

#: JSON-RPC error code for UnsupportedProtocolVersionError (2026-07-28)
ERR_UNSUPPORTED_PROTOCOL_VERSION = -32022

_CLIENT_INFO = {"name": "oh-my-context", "version": __version__}

# Request ID counter (thread-safe)
_id_lock = threading.Lock()
_id_counter = [0]


def _next_id() -> int:
    with _id_lock:
        _id_counter[0] += 1
        return _id_counter[0]


def _stdio_pump(proc, response_queues: dict, rq_lock,
                late_queue, late_lock):
    """Background stdout reader for stdio transport (v0.7.4).

    Reads raw lines from ``proc.stdout`` forever and routes every JSON-RPC
    message with an ``id`` into the matching per-id queue (popped from
    ``response_queues``). Everything else — debug output, notifications,
    responses for requests that already timed out — is parked in
    ``late_queue`` (lost & found) instead of poisoning the next request.

    On EOF, every registered waiter receives a ``None`` sentinel so
    in-flight requests fail fast instead of hanging on a dead process.

    Module-level so tests can drive it directly against a fake process.
    """
    stdout = proc.stdout
    while True:
        try:
            line = stdout.readline()
        except (OSError, ValueError):
            line = b""
        if not line:
            with rq_lock:
                for q in list(response_queues.values()):
                    q.put(None)
            return
        text = line.decode("utf-8", errors="replace").strip()
        if not text:
            continue
        try:
            msg = json.loads(text)
        except json.JSONDecodeError:
            # Debug output / partial line — no response id to route.
            with late_lock:
                late_queue.append((text, time.time()))
            continue
        if not isinstance(msg, dict) or "id" not in msg:
            # Notification — no response id; park for diagnostics.
            with late_lock:
                late_queue.append((msg, time.time()))
            continue
        rid = msg["id"]
        with rq_lock:
            q = response_queues.pop(rid, None)
        if q is not None:
            q.put(msg)
        else:
            # Response for a request that already timed out — park it
            # (lost & found) instead of poisoning the next request.
            with late_lock:
                late_queue.append((msg, time.time()))


class MCPError(Exception):
    """MCP protocol or transport error."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(f"[{code}] {message}")


# Node/npm emit this boilerplate on nearly every spawn; it explains nothing
# about why a server died and, being printed first, it used to bury the real
# diagnostic in every head-slice of stderr.
_STDERR_NOISE = (
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "trace-warnings",
)


def _salient_stderr(raw: str, limit: int = 500) -> str:
    """Return the part of a dead server's stderr that explains the death.

    A failing `npx` prints a wall of Node warnings first and the actionable
    line last (``npm error 404 Not Found ...``). Slicing from the head keeps
    only noise, so prefer the diagnostic lines and fall back to the tail —
    process errors are printed last, not first.
    """
    text = (raw or "").strip()
    if not text:
        return ""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    salient = [ln for ln in lines
               if not any(marker in ln for marker in _STDERR_NOISE)]
    if salient:
        text = " | ".join(salient)
    return text[-limit:] if len(text) > limit else text


def _http_opener(url: str):
    """oh-my-context-mod: the urllib opener for one HTTP MCP server.

    Upstream disabled proxies for every server ("MCP servers are usually local").
    A remote server honours HTTP(S)_PROXY / NO_PROXY as it does when
    Claude Code connects to it directly; loopback stays direct, because urllib would
    send localhost through the proxy when NO_PROXY is unset.
    """
    host = urllib.parse.urlsplit(url).hostname or ""
    if host not in ("localhost", "127.0.0.1", "::1"):
        return urllib.request.build_opener()  # default ProxyHandler: environment proxies
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


class MCPClient:
    """Universal MCP client — HTTP or stdio transport.

    Args:
        stdio:  Command list to spawn as subprocess (e.g. ["npx", "-y", "@mcp/server"])
        http:   HTTP endpoint URL (e.g. "http://localhost:3001/mcp")
        headers: HTTP headers (e.g. {"Authorization": "Bearer xxx"})
        env:    Environment variables for stdio subprocess
        timeout: Default timeout in seconds

    Pass exactly one of `stdio` or `http`.
    """

    def __init__(
        self,
        stdio: Optional[list[str]] = None,
        http: Optional[str] = None,
        headers: Optional[dict[str, str]] = None,
        env: Optional[dict[str, str]] = None,
        timeout: float = 30,
        cwd: Optional[str] = None,
    ):
        if stdio and http:
            raise ValueError("Pass exactly one of stdio= or http=")
        if not stdio and not http:
            raise ValueError("Must pass stdio= or http=")

        self._transport = "stdio" if stdio else "http"
        self._stdio_cmd = stdio
        self._http_url = http
        self._headers = headers or {}
        self._env = env
        self._timeout = timeout
        self._cwd = cwd

        # stdio state
        self._proc: Optional[subprocess.Popen] = None
        self._stdout_lock = threading.Lock()
        # stderr is drained CONTINUOUSLY while the child is alive — see
        # _start_stderr_pump. An unread stderr pipe fills after ~4 KB, and the
        # child then blocks inside write(), which stops it reading stdin and
        # answering stdout. That is the spec="auto" probe deadlock (#19): one
        # `server/discover` makes a legacy Python server emit ~6.8 KB of
        # pydantic validation warnings. The drained text is kept in a bounded
        # ring of 8 KB chunks (~512 KB) so error paths can still report a tail.
        self._stderr_buf: collections.deque[str] = collections.deque(maxlen=64)
        self._stderr_lock = threading.Lock()
        self._stderr_thread: Optional[threading.Thread] = None

        # Response pump (v0.7.4): a background thread reads stdout lines and
        # routes every JSON-RPC message into a queue keyed by response id.
        # Requests then wait on the queue with a deadline — a silent server
        # (e.g. one that never replies to unknown RPCs) can no longer hang
        # the client forever via a blocking readline().
        self._pump_thread: Optional[threading.Thread] = None
        self._response_queues: dict[int, queue.Queue] = {}
        self._response_queues_lock = threading.Lock()
        self._late_queue: collections.deque[tuple[Any, float]] = collections.deque(
            maxlen=16)
        self._late_lock = threading.Lock()

        # http state
        self._session_id: Optional[str] = None

        # common state
        self._tools_cache: list[dict] = []

        # protocol negotiation (MCP 2026-07-28): probe server/discover, fall back
        # to the classic handshake. mode: "modern" | "legacy" | None (before).
        self._mode: Optional[str] = None
        self._negotiated: Optional[str] = None
        self._in_probe = False
        self._fell_back = False
        self.server_capabilities: Optional[dict] = None
        # oh-my-context-mod: the server's own `instructions`, handed to the model with its first call.
        self.server_instructions: Optional[str] = None

    # ═══════════════════════════════════════════════════
    # Public API
    # ═══════════════════════════════════════════════════

    def initialize(self) -> dict:
        """Connect and negotiate the best MCP protocol version.

        The client probes the server with ``server/discover`` (MCP 2026-07-28). A server that answers gets
        stateless modern semantics; anything that rejects the probe
        silently falls back to the classic initialize() handshake
        (2025-06-18 and older revisions).
        """
        if self._transport == "stdio":
            self._spawn_stdio()

        try:
            result = self._probe_modern()
            self._mode = "modern"
            self._negotiated = LATEST_PROTOCOL_VERSION
            if isinstance(result, dict):
                self.server_capabilities = result.get("capabilities")
                self.server_instructions = result.get("instructions")  # oh-my-context-mod
            return result if isinstance(result, dict) else {}
        except MCPError:
            pass  # fall through to the legacy handshake

        result = self._legacy_initialize()
        self._mode = "legacy"
        self._negotiated = LEGACY_PROTOCOL_VERSION
        return result

    def _probe_modern(self) -> dict:
        """Probe a server with the 2026-07-28 ``server/discover`` RPC.

        Returns the discovery result on success; raises MCPError when the
        server clearly does not implement the modern protocol (unknown
        method, unsupported version, transport failure, ...).

        Uses a short dedicated deadline (capped at 10s): a legacy server
        that stays silent on this RPC should cost seconds, not the full
        request timeout, before the auto-fallback to the classic handshake.
        """
        self._in_probe = True
        try:
            probe_timeout = min(self._timeout, 10.0)
            return self._request("server/discover", {}, timeout=probe_timeout)
        finally:
            self._in_probe = False

    def _legacy_initialize(self) -> dict:
        """Classic initialize handshake (MCP <= 2025-11-25 semantics)."""
        result = self._request("initialize", {
            "protocolVersion": LEGACY_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": _CLIENT_INFO,
        })
        if isinstance(result, dict):
            self.server_capabilities = result.get("capabilities")
            self.server_instructions = result.get("instructions")  # oh-my-context-mod
        # Send initialized notification (required by legacy MCP spec)
        self._notify("notifications/initialized", {})
        return result

    def list_tools(self, use_cache: bool = True) -> list[dict]:
        """List available tools. Returns list of tool definitions."""
        if use_cache and self._tools_cache:
            return self._tools_cache

        result = self._request("tools/list", {})
        tools = result.get("tools", []) if isinstance(result, dict) else []
        self._tools_cache = tools
        return tools

    def call_tool_full(self, name: str, arguments: dict | None = None) -> Any:
        """Call a tool and return the COMPLETE MCP tools/call result envelope.

        Keeps every protocol-level field intact: structuredContent, _meta,
        resultType, isError, content — everything the server sent.

        Raises MCPError("INPUT_REQUIRED") when the server answers with MRTR
        ``resultType: "input_required"`` (2026-07-28): the gateway cannot ask the
        user for that input.
        """
        return self._request("tools/call", {"name": name, "arguments": arguments or {}})

    # ── MCP resources (spec: resources/list, resources/templates/list,
    #    resources/read) ────────────────────────────────────────────────────
    # These return the raw protocol result rather than flattened content:
    # a resource read yields a `contents` array (text or base64 blob), and
    # dropping mimeType/uri would lose information the caller needs.

    def list_resources(self) -> list[dict]:
        """List the server's resources. Returns the `resources` array."""
        result = self._request("resources/list", {})
        return result.get("resources", []) if isinstance(result, dict) else []

    def list_resource_templates(self) -> list[dict]:
        """List resource URI templates. Returns the `resourceTemplates` array."""
        result = self._request("resources/templates/list", {})
        if isinstance(result, dict):
            return result.get("resourceTemplates", [])
        return []

    def read_resource(self, uri: str) -> dict:
        """Read one resource by URI. Returns the full result (`contents`)."""
        result = self._request("resources/read", {"uri": uri})
        return result if isinstance(result, dict) else {"contents": result}

    # ── MCP prompts (spec: prompts/list, prompts/get) ──────────────────────

    def list_prompts(self) -> list[dict]:
        """List the server's prompt templates. Returns the `prompts` array."""
        result = self._request("prompts/list", {})
        return result.get("prompts", []) if isinstance(result, dict) else []

    def get_prompt(self, name: str, arguments: dict | None = None) -> dict:
        """Render a prompt by name. Returns the full result (`messages`)."""
        params: dict = {"name": name}
        if arguments:
            params["arguments"] = arguments
        result = self._request("prompts/get", params)
        return result if isinstance(result, dict) else {"messages": result}

    def close(self):
        """Clean up: kill subprocess or close HTTP session."""
        if self._transport == "stdio" and self._proc:
            try:
                self._proc.stdin.close()
                self._proc.terminate()
                self._proc.wait(timeout=3)
            except Exception:
                try:
                    self._proc.kill()
                    self._proc.wait(timeout=1)
                except Exception:
                    pass
            finally:
                self._proc = None

    def _reconnect_if_dead(self):
        """Check if stdio process is dead and try to reconnect.

        Called before each request. If process has exited, restarts it.
        """
        if self._transport != "stdio":
            return
        if self._proc is None:
            # Not started yet — spawn
            self._spawn_stdio()
            return
        if self._proc.poll() is not None:
            # Process has exited — restart
            self._proc = None
            self._tools_cache = []  # Clear cache on reconnect
            self._spawn_stdio()

    # ═══════════════════════════════════════════════════
    # stdio transport
    # ═══════════════════════════════════════════════════

    def _spawn_stdio(self):
        """Start the subprocess for stdio transport."""
        import shutil
        import sys

        env = os.environ.copy()
        # oh-my-context-mod: an upstream starts with the environment Claude Code gave the
        # gateway, not with what bin/oh-my-context added to run this vendored copy.
        for key in ("PYTHONPATH", "PYTHONPYCACHEPREFIX", "OMC_HOME", "OMC_CONFIG_FILE",
                    "OMC_MOD_PYTHONPATH"):
            env.pop(key, None)
        if os.environ.get("OMC_MOD_PYTHONPATH"):
            env["PYTHONPATH"] = os.environ["OMC_MOD_PYTHONPATH"]
        if self._env:
            env.update(self._env)

        cmd = list(self._stdio_cmd)

        # Windows: resolve npx/node/.cmd executables
        if sys.platform == "win32" and cmd:
            resolved = shutil.which(cmd[0])
            if resolved:
                cmd[0] = resolved
            elif not cmd[0].endswith(".cmd"):
                # Try .cmd extension (npx.cmd, etc.)
                resolved = shutil.which(cmd[0] + ".cmd")
                if resolved:
                    cmd[0] = resolved

        self._proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=self._cwd,
            bufsize=0,  # unbuffered — critical for JSON-RPC over pipes
        )
        self._start_response_pump()
        # Fresh process → forget any stderr tail from the previous one.
        with self._stderr_lock:
            self._stderr_buf.clear()
        self._start_stderr_pump()

    def _start_response_pump(self):
        """Start the background stdout reader thread (v0.7.4).

        The pump reads raw lines and routes JSON-RPC responses to per-id
        queues. Requests block on ``queue.get(timeout=...)`` instead of a
        blocking ``readline()`` — the fix for infinite hangs on servers
        that never answer some RPCs (e.g. old servers that stay silent on
        the 2026-07-28 ``server/discover`` probe).

        Each spawn gets its OWN response-queue dict (a new generation). This
        is what makes reconnect safe: the previous pump thread is still alive,
        blocked on the dead process's ``readline()``, and when that pipe EOFs
        it injects a ``None`` sentinel into every queue it can see. If it shared
        one dict with the new pump, that stale sentinel would land in a NEW
        in-flight request's queue and surface as a spurious "server process
        exited". A per-generation dict isolates the two.
        """
        self._response_queues = {}
        self._pump_thread = threading.Thread(
            target=_stdio_pump,
            args=(self._proc, self._response_queues,
                  self._response_queues_lock, self._late_queue,
                  self._late_lock),
            daemon=True,
            name=f"oh-my-context-stdio-pump-{id(self._proc)}",
        )
        self._pump_thread.start()

    def _start_stderr_pump(self):
        """Drain the child's stderr for as long as it lives (#19).

        Not reading stderr is not a cosmetic loss. A pipe holds only ~4 KB:
        a server that logs more than that blocks inside write(), so it stops
        reading stdin and stops writing stdout, and every request then times
        out as though the server had "gone silent". One `server/discover`
        probe is enough to trigger it — the Python reference servers answer
        that unknown method with ~6.8 KB of pydantic validation warnings.

        Reading on a background thread keeps the pipe empty. The text lands in
        a bounded ring for post-mortem diagnostics; nothing here consumes it,
        so callers may read it more than once.
        """
        if self._proc is None or self._proc.stderr is None:
            return

        def _keep(chunk) -> None:
            if isinstance(chunk, bytes):
                chunk = chunk.decode("utf-8", errors="replace")
            if chunk:
                with self._stderr_lock:
                    self._stderr_buf.append(chunk)

        def _drain() -> None:
            stream = self._proc.stderr  # type: ignore[union-attr]
            read1 = getattr(stream, "read1", None)
            try:
                if read1 is not None:
                    # read1 hands back whatever is available; read(n) waits for
                    # n bytes or EOF, so a server emitting one huge line with no
                    # newline would block at the pipe buffer again — the very
                    # failure this pump exists to prevent. Line iteration has
                    # the same problem, which is why it is not used here.
                    while True:
                        chunk = read1(8192)
                        if not chunk:
                            return  # EOF — the child is gone
                        _keep(chunk)
                else:  # pragma: no cover — subprocess.PIPE is always buffered
                    for raw in stream:
                        if not raw:
                            return
                        _keep(raw)
            except Exception:
                pass  # stderr diagnostics are best-effort

        self._stderr_thread = threading.Thread(
            target=_drain, daemon=True,
            name=f"oh-my-context-stderr-pump-{id(self._proc)}")
        self._stderr_thread.start()

    def _stderr_tail(self) -> str:
        """Best-effort tail of the child's stderr.

        Reads the ring filled by ``_start_stderr_pump`` rather than the pipe.
        The post-mortem pipe read it replaces was itself the bug: nobody read
        stderr while the server ran, so the pipe filled and the server blocked.
        A post-mortem read also raced the exit — a child's pipe handles close
        (EOF becomes visible) before the process object flips to signaled, so
        poll() could still report it alive.

        When the child has already exited the drain thread is about to hit
        EOF, so it gets a bounded moment to finish: that keeps the complete
        tail (a failing npx prints `npm error 404` last, after a wall of Node
        warnings) available to the error paths that report it.
        """
        thread = self._stderr_thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=1.0)
        with self._stderr_lock:
            tail = "".join(self._stderr_buf)
        return tail[-2000:]

    def _stdio_request(self, payload: bytes, timeout: float | None = None) -> dict:
        """Send JSON-RPC request over stdin, wait for the response with a
        deadline.

        The background pump thread owns stdout; this method registers a
        per-id queue, writes the request, then blocks on the queue with a
        timeout. A server that never replies now surfaces as a
        ``RESPONSE_TIMEOUT`` MCPError instead of hanging forever.
        """
        rid = None
        try:
            req_msg = json.loads(payload.decode("utf-8"))
            rid = req_msg.get("id")
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass
        if not isinstance(rid, int):
            raise MCPError("PROTOCOL_ERROR", "request payload has no numeric id")

        response_q: queue.Queue = queue.Queue(maxsize=1)
        with self._response_queues_lock:
            self._response_queues[rid] = response_q

        try:
            with self._stdout_lock:
                assert self._proc is not None
                assert self._proc.stdin is not None
                self._proc.stdin.write(payload + b"\n")
                self._proc.stdin.flush()
        except (OSError, ValueError, BrokenPipeError) as e:
            with self._response_queues_lock:
                self._response_queues.pop(rid, None)
            # A write failure almost always means the process already
            # exited (e.g. npx E404 on a missing package). Surface the
            # stderr tail so users see the real cause, not just Errno 22.
            stderr = _salient_stderr(self._stderr_tail())
            detail = f"failed writing to MCP server: {e}"
            if stderr:
                detail += f" | server stderr: {stderr}"
            raise MCPError("PROCESS_DIED", detail) from e

        deadline = timeout if timeout is not None else self._timeout
        try:
            msg = response_q.get(timeout=deadline)
        except queue.Empty:
            with self._response_queues_lock:
                self._response_queues.pop(rid, None)
            # oh-my-context-mod: upstream mcptoon 27dd0ddac. A dead server whose EOF sentinel
            # lost the race with the deadline is reported as dead, not as a timeout.
            if self._proc is not None and self._proc.poll() is not None:
                stderr = _salient_stderr(self._stderr_tail())
                raise MCPError(
                    "PROCESS_DIED",
                    f"MCP server process exited (rc={self._proc.returncode}) "
                    f"without answering request id {rid}. stderr: {stderr}") from None
            raise MCPError(
                "RESPONSE_TIMEOUT",
                f"no JSON-RPC response for request id {rid} "
                f"within {deadline}s (server went silent)",
            ) from None

        if msg is None:
            # Pump EOF sentinel — process died. Surface stderr tail
            # (one-shot cached; later error paths reuse it).
            stderr = _salient_stderr(self._stderr_tail())
            raise MCPError(
                "PROCESS_DIED",
                f"MCP server process exited. stderr: {stderr}")

        return msg

    def _stdio_notify(self, payload: bytes):
        """Send notification (no response expected) over stdio."""
        assert self._proc is not None
        assert self._proc.stdin is not None
        self._proc.stdin.write(payload + b"\n")
        self._proc.stdin.flush()

    # ═══════════════════════════════════════════════════
    # HTTP transport
    # ═══════════════════════════════════════════════════

    def _http_request(self, payload: bytes, timeout: float | None = None,
                      extra_headers: dict | None = None, _renewed: bool = False) -> dict:
        """POST JSON-RPC to HTTP endpoint, handle SSE/Streamable HTTP/JSON response.

        Supports:
          - Plain JSON response (Content-Type: application/json)
          - SSE stream (Content-Type: text/event-stream) — both old and Streamable HTTP
          - Streamable HTTP with Mcp-Session-Id header (legacy revisions)
          - Stateless 2026-07-28 requests (Mcp-Method/Mcp-Name headers, no session)
        """
        req = urllib.request.Request(self._http_url, data=payload, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", _HTTP_ACCEPT)
        # Bot filters on public hosted endpoints 403 the default
        # "Python-urllib/3.x" signature (Cloudflare error 1010); announce
        # ourselves instead — unless the caller already set a User-Agent.
        req.add_header("User-Agent", DEFAULT_USER_AGENT)
        # Resolve `${NAME}` header values here, at request time (issue #24). Nothing
        # is written back — `self._headers` keeps the `${NAME}` template, so the
        # secret never reaches the config file or any output.
        from . import headers as headers_mod

        try:
            resolved = headers_mod.resolve_headers(self._headers)
        except headers_mod.HeaderEnvError as e:
            raise MCPError("HEADER_ENV_MISSING", str(e)) from e
        for k, v in resolved.items():
            req.add_header(k, v)
        if extra_headers:
            for k, v in extra_headers.items():
                req.add_header(k, v)
        # Legacy revisions only: 2026-07-28 removed protocol-level sessions
        sent_sid = self._session_id if self._mode != "modern" else None  # oh-my-context-mod
        if sent_sid:
            req.add_header("Mcp-Session-Id", sent_sid)

        opener = _http_opener(self._http_url)  # oh-my-context-mod: proxy as Claude Code does

        try:
            resp = opener.open(req, timeout=timeout or self._timeout)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            # oh-my-context-mod: 404 on a request that carried Mcp-Session-Id means the
            # session is gone (spec: start a new one); re-initialize, retry once.
            # The initialize request carries no session id, so it cannot loop.
            if e.code == 404 and sent_sid and not _renewed:
                self._session_id = None
                self._legacy_initialize()
                return self._http_request(payload, timeout, extra_headers, _renewed=True)
            # Try to parse as JSON error
            try:
                err_data = json.loads(body)
                # oh-my-context-mod: only a JSON-RPC error object; an OAuth body such as
                # {"error": "invalid_token"} would crash _request (err.get on a str).
                if isinstance(err_data, dict) and isinstance(err_data.get("error"), dict):
                    return err_data
            except (json.JSONDecodeError, ValueError):
                pass
            if e.code == 401:
                # oh-my-context-mod: the gateway cannot sign in; Claude can, when the server is direct.
                raise MCPError(
                    "HTTP_ERROR",
                    f"HTTP 401: this server needs Claude's own sign-in. Add it to direct_servers "
                    f"(a setting of /oh-my-context-mod) so Claude connects to it directly. {body[:200]}",
                ) from e
            raise MCPError("HTTP_ERROR", f"HTTP {e.code}: {body[:300]}") from e
        except urllib.error.URLError as e:
            raise MCPError("CONNECTION_ERROR", str(e.reason)[:200]) from e

        # Save session ID from response headers (Streamable HTTP)
        new_sid = resp.headers.get("Mcp-Session-Id", "")
        if new_sid:
            self._session_id = new_sid

        # Check content type for SSE vs JSON
        content_type = resp.headers.get("Content-Type", "")

        if "text/event-stream" in content_type:
            # SSE stream — read all events and find the response
            body = resp.read().decode("utf-8", errors="replace")
            return self._parse_http_body(body)
        else:
            # Plain JSON response
            body = resp.read().decode("utf-8", errors="replace")
            return self._parse_http_body(body)

    def _http_notify(self, payload: bytes):
        """Send notification over HTTP (fire-and-forget)."""
        try:
            req = urllib.request.Request(self._http_url, data=payload, method="POST")
            req.add_header("Content-Type", "application/json")
            req.add_header("User-Agent", DEFAULT_USER_AGENT)
            # Same request-time resolution as `_http_request` (issue #24): a
            # notification must not carry a different Authorization than the call
            # it belongs to. Best-effort — the whole method is fire-and-forget.
            from . import headers as headers_mod

            for k, v in headers_mod.resolve_headers(self._headers).items():
                req.add_header(k, v)
            if self._session_id:
                req.add_header("Mcp-Session-Id", self._session_id)
            _http_opener(self._http_url).open(req, timeout=5)  # oh-my-context-mod
        except Exception:
            pass  # Notifications are fire-and-forget

    # ═══════════════════════════════════════════════════
    # Unified request dispatcher
    # ═══════════════════════════════════════════════════

    def _request(self, method: str, params: dict, timeout: float | None = None) -> dict:
        """Send a JSON-RPC request and return the result.

        MCP 2026-07-28 (modern mode): every request is annotated with
        ``_meta`` carrying the protocol version, client capabilities and
        client info — there is no initialize handshake. HTTP requests also
        carry the required ``Mcp-Method`` / ``Mcp-Name`` headers and never
        send a session id.

        Legacy mode: requests go out bare; the initialize handshake has
        already established the session.
        """
        # Auto-reconnect if stdio process died
        if self._transport == "stdio":
            self._reconnect_if_dead()

        modern = self._mode == "modern" or self._in_probe

        # 2026-07-28: annotate every request with protocol _meta
        if modern:
            params = dict(params)
            meta = dict(params.get("_meta") or {})
            meta[_META_PROTOCOL_KEY] = self._negotiated or LATEST_PROTOCOL_VERSION
            meta[_META_CAPS_KEY] = {}
            meta[_META_CLIENT_KEY] = _CLIENT_INFO
            params["_meta"] = meta

        # 2026-07-28 Streamable HTTP: standard request headers
        extra_headers = None
        if modern and self._transport == "http":
            extra_headers = {"Mcp-Method": method}
            if method == "tools/call" and isinstance(params.get("name"), str):
                extra_headers["Mcp-Name"] = params["name"]

        msg = {
            "jsonrpc": "2.0",
            "id": _next_id(),
            "method": method,
            "params": params,
        }
        payload = json.dumps(msg).encode()

        if self._transport == "stdio":
            data = self._stdio_request(payload, timeout=timeout)
        else:
            data = self._http_request(payload, timeout=timeout,
                                      extra_headers=extra_headers)

        if isinstance(data, dict):
            if "error" in data:
                err = data["error"]
                code = err.get("code", "MCP_ERROR")
                # 2026-07-28: server rejected our protocol version — fall
                # back to the legacy handshake once, then retry the request
                # under legacy semantics.
                if (modern and code == ERR_UNSUPPORTED_PROTOCOL_VERSION
                        and not self._fell_back):
                    self._fell_back = True
                    self._mode = "legacy"
                    self._negotiated = LEGACY_PROTOCOL_VERSION
                    if self._transport == "http":
                        self._session_id = None
                    self._legacy_initialize()
                    return self._request(method, params, timeout=timeout)
                raise MCPError(
                    code,
                    err.get("message", str(err)),
                )
            if "result" in data:
                result = data["result"]
                # 2026-07-28 MRTR: interim result asking for more input.
                # (Servers predating the field omit resultType — clients
                # MUST treat those as "complete", which is the default here.)
                if isinstance(result, dict) and result.get("resultType") == "input_required":
                    raise MCPError("INPUT_REQUIRED",
                                   "tool needs more input before it can finish (MRTR)")
                return result
            return data

        raise MCPError("PARSE_ERROR", f"Unexpected response type: {type(data)}")

    def _notify(self, method: str, params: dict):
        """Send a JSON-RPC notification (no response expected)."""
        msg = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }
        payload = json.dumps(msg).encode()

        if self._transport == "stdio":
            self._stdio_notify(payload)
        else:
            self._http_notify(payload)

    # ═══════════════════════════════════════════════════
    # Response parsing
    # ═══════════════════════════════════════════════════


    @staticmethod
    def _parse_http_body(body: str) -> dict:
        """Parse HTTP response — handles SSE (data: lines) and plain JSON.

        Also handles Streamable HTTP where response may include
        multiple SSE events (notifications + final response).
        Returns the last valid JSON-RPC response found.
        """
        last_result = None

        # SSE format: lines starting with "data: "
        for line in body.split("\n"):
            s = line.strip()
            if s.startswith("data: "):
                try:
                    d = json.loads(s[6:])
                    if isinstance(d, dict):
                        # Keep the last response with a result or error
                        if "result" in d or "error" in d or "id" in d and "method" not in d:
                            last_result = d
                except json.JSONDecodeError:
                    continue

        if last_result is not None:
            return last_result

        # Plain JSON
        try:
            return json.loads(body)
        except json.JSONDecodeError as e:
            raise MCPError("PARSE_ERROR", f"Cannot parse response: {body[:200]}") from e

    @staticmethod
    def _extract_content(result: Any) -> Any:
        """Extract usable content from MCP tools/call result.

        MCP returns {"content": [{"type": "text", "text": "..."}], ...}
        We try to parse the text content as JSON for structured results.

        New MCP spec (2025-06-18+) servers may return `structuredContent`
        instead of / alongside text content — when present, it is preferred
        as the authoritative result.
        """
        if not isinstance(result, dict):
            return result

        # New protocol: structuredContent is the authoritative result
        if result.get("structuredContent") is not None:
            return result["structuredContent"]

        # Check for MCP error
        if result.get("isError"):
            contents = result.get("content", [])
            err_text = " ".join(
                c.get("text", "") for c in contents
                if isinstance(c, dict) and c.get("type") == "text"
            )
            return {"error": True, "message": err_text or "MCP tool returned error"}

        contents = result.get("content", [])
        if not contents:
            return result

        # Extract text content
        texts = [
            c["text"] for c in contents
            if isinstance(c, dict) and c.get("type") == "text"
        ]
        if not texts:
            return result

        combined = "".join(texts)

        # Try to parse as JSON (structured result)
        try:
            return json.loads(combined)
        except (json.JSONDecodeError, ValueError):
            try:
                return json.loads(combined, strict=False)
            except (json.JSONDecodeError, ValueError):
                return {"text": combined}


# Per-request deadline (seconds) for a server entry without its own "timeout".
# oh-my-context-mod: hooks/sync.js gives every entry one.
DEFAULT_CALL_TIMEOUT = 30


# ═══════════════════════════════════════════════════
# Convenience: connection pool (reuse clients across calls)
# ═══════════════════════════════════════════════════

class MCPClientPool:
    """Manage multiple MCPClient instances, reuse connections.

    Usage:
        pool = MCPClientPool(config)
        result = pool.call_full("exa", "search", {"query": "AI"})
        pool.close()
    """

    def __init__(self, servers: dict):
        """servers: {name: {transport config}} from config.json"""
        self._servers = servers
        self._clients: dict[str, MCPClient] = {}
        self._lock = threading.Lock()

    def _get_client(self, name: str) -> MCPClient:
        """Get or create a client for server name.

        Thread-safe: uses lock only for dict access, NOT for initialize().
        This allows parallel server initialization across different servers.
        Resource-safe: if two threads create clients for the same server,
        the losing client is properly closed.
        """
        # Fast path: already connected
        cached = self._clients.get(name)
        if cached is not None:
            return cached

        # Check config
        cfg = self._servers.get(name)
        if not cfg:
            raise MCPError("UNKNOWN_SERVER", f"Server '{name}' not in config")

        # Create client (no lock needed — each thread creates its own)
        client = self._make_client(cfg)
        client.initialize()

        # Store in pool (lock only for dict write)
        with self._lock:
            # Double-check: another thread may have connected in parallel
            if name in self._clients:
                # Another thread won; close ours properly
                try:
                    client.close()
                except Exception:
                    # Best-effort cleanup — don't let close() failure leak resources
                    pass
                return self._clients[name]
            self._clients[name] = client
            return client

    @staticmethod
    def _make_client(cfg: dict) -> MCPClient:
        """Create MCPClient from config dict (an entry hooks/sync.js wrote)."""
        transport = cfg.get("transport", "stdio")
        timeout = cfg.get("timeout", DEFAULT_CALL_TIMEOUT)

        if transport == "stdio":
            command = cfg.get("command", [])
            if isinstance(command, str):
                command = [command]  # lenient: "command": "python" == ["python"]
            return MCPClient(
                stdio=command + cfg.get("args", []),
                env=cfg.get("env") or None,
                timeout=timeout,
                cwd=cfg.get("cwd"),
            )
        elif transport == "http":
            return MCPClient(
                http=cfg["url"],
                headers=cfg.get("headers", {}),
                timeout=timeout,
            )
        else:
            raise MCPError("BAD_CONFIG", f"Unknown transport: {transport}")

    def list_tools(self, name: str) -> list[dict]:
        """List tools for a specific server."""
        return self._get_client(name).list_tools()

    def list_resources(self, name: str) -> list[dict]:
        """List resources for a specific server."""
        return self._get_client(name).list_resources()

    def list_resource_templates(self, name: str) -> list[dict]:
        """List resource templates for a specific server."""
        return self._get_client(name).list_resource_templates()

    def read_resource(self, name: str, uri: str) -> dict:
        """Read one resource from a specific server."""
        return self._get_client(name).read_resource(uri)

    def list_prompts(self, name: str) -> list[dict]:
        """List prompts for a specific server."""
        return self._get_client(name).list_prompts()

    def get_prompt(self, name: str, prompt: str,
                   arguments: dict | None = None) -> dict:
        """Render a prompt from a specific server."""
        return self._get_client(name).get_prompt(prompt, arguments)

    def call_full(self, server: str, tool: str, arguments: dict | None = None) -> Any:
        """Call a tool and return the complete MCP tools/call result envelope."""
        return self._get_client(server).call_tool_full(tool, arguments)


    def close(self):
        """Close all clients."""
        for client in self._clients.values():
            try:
                client.close()
            except Exception:
                pass
        self._clients.clear()
