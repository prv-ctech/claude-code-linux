# Copyright 2025 activeing123
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
# Modified by oh-my-context-mod (github.com/prv-ctech/claude-code-linux), 2026-10-30: per-server files under OMC_HOME/cache only (no legacy single file, no env overrides); renamed to oh-my-context: package, commands, tool, environment and path names (see vendor/NOTICE).

"""
oh-my-context cache — Schema cache for tool discovery

Caches tool lists per server to avoid repeated initialize/list_tools round-trips.
TTL: 5 minutes.

Multi-process safe by construction: **one file per server**. Writing a server's
entry only ever rewrites that server's own file, so two processes caching two
different servers can never overwrite each other. Each per-server write is a
unique-temp-file ``os.replace`` (atomic on Windows and POSIX), so a reader never
sees a half file.
"""
import hashlib
import json
import os
import tempfile
import time
from pathlib import Path

from . import config as _config

_TTL = 300  # 5 minutes


def _cache_dir() -> Path:
    return _config.CACHE_DIR


def _server_file(server: str) -> Path:
    """This server's own cache file. sha1 so any server name is a safe filename."""
    digest = hashlib.sha1(server.encode("utf-8")).hexdigest()
    return _cache_dir() / "schema_cache" / f"{digest}.json"


def tools_fingerprint(tools: list[dict]) -> str:
    """Content signature for a server's tool set: sorted names + each tool's
    required-param list. Cheap and stable; changes exactly when the callable
    surface changes (tool added/removed, or a tool's required args change),
    which is precisely when a cached manifest becomes unsafe to trust.
    Defensive against malformed servers (null inputSchema, non-dict entries).
    """
    surface = []
    for t in tools:
        if not isinstance(t, dict):
            continue
        req = (t.get("inputSchema") or {}).get("required") or []
        surface.append((t.get("name", "?"), sorted(req)))
    surface.sort()
    blob = json.dumps(surface, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()[:16]


def _read_json(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _entry_for(server: str) -> dict | None:
    return _read_json(_server_file(server))


def _atomic_write(path: Path, data: dict) -> None:
    """Write JSON to `path` atomically via a *unique* temp file + os.replace.

    The temp name is unique per call (mkstemp), so concurrent writers — even in
    the same process — never share a scratch file. os.replace is atomic on both
    Windows and POSIX, so a reader sees either the old file or the new one.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False)
        os.replace(tmp, str(path))
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def get_cached_tools(server: str) -> list[dict] | None:
    """Get cached tools for a server, or None if cache miss/expired."""
    entry = _entry_for(server)
    if not entry:
        return None
    if time.time() - entry.get("ts", 0) > _TTL:
        return None
    return entry.get("tools", [])


def get_cached_tools_any_age(server: str) -> list[dict] | None:
    """Cached tools for a server even when the TTL has expired, or None if never cached.

    For callers that must never wait on a server (`oh-my-context hint`, the danger
    screen): they read whatever is on disk instead of refreshing.
    """
    entry = _entry_for(server)
    return entry.get("tools", []) if entry else None


def set_cached_tools(server: str, tools: list[dict]) -> bool:
    """Cache tools for a server (one file per server, atomic write).

    Stores a content fingerprint alongside the tools and returns True when the
    server's *callable surface* (tool names + required args) actually changed
    versus what was cached, False when it is identical. `serve` uses that
    signal to log MCP tool drift across manifest refreshes without diffing
    payloads itself.

    Writes only this server's own file, so it is safe against a concurrent
    writer caching a *different* server.
    """
    fp = tools_fingerprint(tools)
    old = _entry_for(server)
    old_fp = old.get("fp") if old else None
    _atomic_write(_server_file(server), {
        "server": server, "tools": tools, "ts": time.time(), "fp": fp,
    })
    return old_fp != fp


