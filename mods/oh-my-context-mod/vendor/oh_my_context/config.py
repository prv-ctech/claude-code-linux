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
# Modified by oh-my-context-mod (github.com/prv-ctech/claude-code-linux), 2026-10-30: reads only the plugin's config file (no project-local, TOML or env config), cwd_only and cwd_except servers, two settings (exposure, compress off by default); config backups are owner-only (0600); renamed to oh-my-context: package, commands, tool, environment and path names (see vendor/NOTICE).

"""
oh-my-context config — Server configuration

Reads server definitions from the gateway config, OMC_CONFIG_FILE (oh-my-context-mod:
written by hooks/sync.js), and two settings from OMC_HOME/settings.json.

Config format:
{
  "servers": {
    "exa": {
      "transport": "stdio",
      "command": ["npx", "-y"],
      "args": ["@anthropic/mcp-exa"],
      "env": {"EXA_API_KEY": "..."}
    },
    "github": {
      "transport": "http",
      "url": "http://localhost:3001/mcp",
      "headers": {"Authorization": "Bearer ghp_xxx"}
    }
  }
}
"""
import json
import os
from pathlib import Path


# ─── Paths ───
# oh-my-context-mod: bin/oh-my-context always sets OMC_HOME (the plugin's data folder)
# and OMC_CONFIG_FILE; the cache lives under OMC_HOME.
CONFIG_DIR = Path(os.environ["OMC_HOME"])
CACHE_DIR = CONFIG_DIR / "cache"


def _config_file() -> Path:
    return Path(os.environ["OMC_CONFIG_FILE"])


def _settings_file() -> Path:
    # Gateway preferences that are not per-server, kept apart from config.json
    # (which hooks/sync.js owns).
    return CONFIG_DIR / "settings.json"


CONFIG_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)


# Settings read from settings.json, and their defaults. oh-my-context-mod: routed
# results come back as a direct call returns them (compress off).
#
#   exposure: compact (default) lists only the gateway's own tools; full also lists
#             every upstream tool with a simplified schema.
#   compress: off (default) passes results through verbatim; smart compresses
#             redundant shapes and keeps the original for `retrieve` (compressor.py).
SETTING_DEFAULTS = {"exposure": "compact", "compress": "off"}
COMPRESS_MODES = ("off", "smart")


# ─── Server name aliases ───

# Users can use short names; we map to canonical names
SERVER_ALIASES = {
    "exa": "exa",
    "fetch": "fetch",
    "github": "github",
    "fs": "filesystem",
    "filesystem": "filesystem",
}


def resolve_server_name(name: str) -> str:
    """Resolve short name to canonical server name.

    Checks static aliases first, then dynamically checks if 'name'
    is a prefix of any configured server name (e.g. 'fs' → 'filesystem').
    """
    # 1. Static aliases (backward compat)
    if name in SERVER_ALIASES:
        return SERVER_ALIASES[name]

    # 2. Check if exact name exists in config (no resolution needed)
    servers = load_config()
    if name in servers:
        return name

    # 3. Dynamic prefix matching (e.g. 'fs' → 'filesystem')
    for sname in servers:
        if sname.lower() == name.lower():
            return sname

    # 4. Return as-is (let caller handle unknown server)
    return name


# ─── Self-reference guard ───
#
# `oh-my-context serve` is the gateway itself. An entry that launches it must never
# reach its own server list: serve would launch a second serve, which loads the
# same list again — an unbounded fork bomb (measured upstream: 294 processes,
# 10.4 GB RAM).

#: Reserved server name for the gateway's own entry.
SELF_SERVER_NAME = "oh-my-context"


def _looks_like_self_command(cfg) -> bool:
    """True when this server entry's argv would launch `oh-my-context serve`.

    Compares whole argv *tokens*, never substrings, so a token that merely
    contains "serve" is not taken for the gateway.

    Checks the argv, not just the name, so a self-entry that was renamed still
    gets caught. Both `command` and `args` are accepted as str or list, which
    are the two shapes seen in the wild.
    """
    if not isinstance(cfg, dict):
        return False
    cmd = cfg.get("command")
    if isinstance(cmd, str):
        parts = cmd.split()
    elif isinstance(cmd, list):
        parts = [str(x) for x in cmd]
    else:
        return False
    args = cfg.get("args") or []
    if isinstance(args, list):
        parts += [str(a) for a in args if isinstance(a, (str, int))]
    elif isinstance(args, str):
        parts += args.split()

    def _is_omc_token(tok: str) -> bool:
        base = tok.replace("\\", "/").rsplit("/", 1)[-1].lower()
        for ext in (".exe", ".cmd", ".bat", ".py"):
            if base.endswith(ext):
                base = base[: -len(ext)]
        return base in ("oh-my-context", "oh_my_context")  # oh-my-context-mod: command or module

    has_omc = any(_is_omc_token(t) for t in parts)
    has_serve = any(t.replace("\\", "/").rsplit("/", 1)[-1].lower() == "serve"
                    for t in parts)
    return has_omc and has_serve


def _is_self_entry(name, cfg) -> bool:
    """True when this entry would make the gateway launch itself.

    Two independent signals — the reserved name, or a self-launching argv.
    Either one is enough to be a fork bomb.
    """
    if str(name).strip().lower() == SELF_SERVER_NAME:
        return True
    return _looks_like_self_command(cfg)


def strip_self_entries(servers: dict) -> dict:
    """Drop every entry that would make the gateway launch itself.

    Applied on the read path (`load_config`) as well as the write paths, so a
    hand-edited or imported self-entry can never reach a running `serve`.
    """
    if not isinstance(servers, dict):
        return {}
    return {k: v for k, v in servers.items() if not _is_self_entry(k, v)}


# ─── Config loading ───

def _preserve_unreadable(path: Path, raw: str) -> None:
    """Copy a config file we are about to ignore to `<path>.bak`, once.

    One bad file must not break the gateway, so `load_config` ignores it; the `.bak`
    keeps the original recoverable. Never clobbers an existing `.bak` — the first
    snapshot is the one closest to the original. Best-effort.
    """
    bak = path.with_suffix(path.suffix + ".bak")
    try:
        if not bak.exists():
            _write_owner_only(bak, raw)  # oh-my-context-mod
    except OSError:
        pass


def _load_config_file(path: Path) -> dict:
    """The `servers` mapping of the config file, preserving the file if we ignore it."""
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        _preserve_unreadable(path, raw)
        return {}
    if isinstance(data, dict) and isinstance(data.get("servers", {}), dict):
        return dict(data.get("servers", {}))
    # Parsed, but not the shape we read (e.g. a top-level list, or `servers` a list).
    _preserve_unreadable(path, raw)
    return {}


def load_config() -> dict:
    """The routed servers, from the gateway config (OMC_CONFIG_FILE).

    oh-my-context-mod: hooks/sync.js writes that file; a project-local config is never
    read (a cloned repo could otherwise make the gateway run any command it names).
    A server entry with ``cwd_only`` (an absolute project path) is left out unless
    the working directory, realpath'd, is that project; one with ``cwd_except`` (a
    list of realpaths) is left out in those projects.
    """
    servers = _load_config_file(_config_file())
    try:
        here = os.path.realpath(os.getcwd())
    except OSError:
        here = ""
    for name, cfg in list(servers.items()):
        pin = cfg.get("cwd_only") if isinstance(cfg, dict) else None
        excluded = cfg.get("cwd_except") if isinstance(cfg, dict) else None
        if (isinstance(pin, str) and pin and os.path.realpath(pin) != here) or (
                isinstance(excluded, list) and here in excluded):
            del servers[name]
    # Never hand the gateway its own entry: `serve` would launch itself.
    return strip_self_entries(servers)


def _write_owner_only(path: Path, raw: str) -> None:
    """oh-my-context-mod: the config can hold tokens; its backup is the owner's alone, like the config.

    O_EXCL keeps the never-clobber rule: an existing file raises FileExistsError (an OSError).
    """
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
        fh.write(raw)


# ─── Gateway settings (not per-server) ───

def load_settings() -> dict:
    """Gateway preferences merged over defaults. A missing file is not an error."""
    values = dict(SETTING_DEFAULTS)
    path = _settings_file()
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                for key in SETTING_DEFAULTS:
                    if key in data:
                        values[key] = data[key]
        except (json.JSONDecodeError, OSError):
            pass
    return values


def get_setting(key: str) -> str:
    """One setting's current value (default when unset)."""
    return str(load_settings().get(key, SETTING_DEFAULTS.get(key, "")))


def compact_exposure() -> bool:
    """True when the gateway withholds the upstream tool list (`exposure`).

    An unrecognized value falls back to compact: a hand-edited settings file must
    not break the gateway, and "list fewer tools" is the safe direction to fail in.
    """
    return get_setting("exposure").strip().lower() != "full"


def compression_mode() -> str:
    """How tool results are compressed: "off" (default) or "smart"."""
    value = get_setting("compress").strip().lower()
    return value if value in COMPRESS_MODES else COMPRESS_MODES[0]
