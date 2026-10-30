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
# Modified by oh-my-context-mod (github.com/prv-ctech/claude-code-linux), 2026-10-30: only the commands the plugin runs are left (--version, serve, hint, skills index <dir>); every other command, the help pages, the footer and the managed refusals are removed; renamed to oh-my-context: package, commands, tool, environment and path names (see vendor/NOTICE).

"""oh-my-context cli — the commands oh-my-context-mod runs through bin/oh-my-context.

    oh-my-context --version            hooks/sync.js: is the gateway runnable
    oh-my-context serve                .mcp.json: the stdio MCP gateway
    oh-my-context hint                 hooks/prompt.js: skill and tool hints for a prompt
    oh-my-context skills index <dir>   hooks/sync.js: index the skill catalog
"""

import sys
from pathlib import Path

from . import __version__

# oh-my-context-mod: anything else is not a command of this copy.
USAGE = "usage: oh-my-context --version | serve | hint [--k-skills N] [--k-tools N] | skills index <dir>..."


def _harden_stream_encoding() -> None:
    """Keep printing from crashing on a console codec that lacks a glyph.

    A tty keeps its own encoding with errors="replace"; a pipe (the MCP stdio
    channel, a hook) becomes UTF-8. Never raises.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            reconfigure = getattr(stream, "reconfigure", None)
            if reconfigure is None:
                continue
            try:
                is_tty = stream.isatty()
            except Exception:
                is_tty = False
            if is_tty:
                reconfigure(errors="replace")
            else:
                reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def _skills_index(dirs: list) -> None:
    from .skills import build_and_save

    index, path = build_and_save([Path(d).expanduser() for d in dirs])
    n_entries = len(index["skills"])
    n_alias = sum(1 for s in index["skills"] if s.get("alias_of"))
    print(f"indexed {n_entries} entr{'y' if n_entries == 1 else 'ies'} "
          f"({n_alias} alias card{'' if n_alias == 1 else 's'}, "
          f"{n_entries - n_alias} skills) from {len(index['roots'])} root(s)")
    print(f"index: {path}")
    if index["warnings"]:
        print(f"warnings: {len(index['warnings'])}")


def main() -> None:
    _harden_stream_encoding()
    args = sys.argv[1:]
    command = args[0] if args else ""
    if command == "--version":
        print(f"oh-my-context {__version__}")
    elif command == "serve" and len(args) == 1:
        from .serve import run_serve
        run_serve()
    elif command == "hint":
        from .hint import run_hint
        sys.exit(run_hint(args[1:]))
    elif command == "skills" and args[1:2] == ["index"] and len(args) > 2:
        _skills_index(args[2:])
    else:
        print(USAGE, file=sys.stderr)
        sys.exit(2)
