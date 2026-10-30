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
# Modified by oh-my-context-mod (github.com/prv-ctech/claude-code-linux), 2026-10-30: only the call counter the `usage` tool reads is kept (no activity ledger, no tiktoken); renamed to oh-my-context: package, commands, tool, environment and path names (see vendor/NOTICE).

"""
oh-my-context usage — the call counter and the token estimate the `usage` tool reports.

The counter is stored in OMC_HOME/cache/usage.json.
"""
import json
import os
import threading

from .config import CACHE_DIR

_USAGE_FILE = CACHE_DIR / "usage.json"

# Concurrency guard: tool calls run on several threads.
_usage_lock = threading.Lock()


def count_tokens(payload) -> int:
    """Estimated token cost of a payload: characters / 4. Never raises.

    oh-my-context-mod: always the estimate; tiktoken would download its encoding.
    """
    if payload is None:
        return 0
    try:
        text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    except (TypeError, ValueError):
        return 0
    return max(1, round(len(text) / 4)) if text else 0


def calls_recorded() -> int:
    """Tool calls recorded so far, cumulative across sessions."""
    try:
        return int(json.loads(_USAGE_FILE.read_text(encoding="utf-8")).get("total", 0))
    except (OSError, ValueError, TypeError, AttributeError):
        return 0


def track_call() -> None:
    """Count one tool call. Crash-safe: counting must never break the call itself.

    Atomic write (unique tmp file + os.replace), so a reader never sees a torn file.
    """
    try:
        with _usage_lock:
            total = calls_recorded() + 1
            _USAGE_FILE.parent.mkdir(parents=True, exist_ok=True)
            tmp = _USAGE_FILE.with_name(f"usage.json.tmp.{os.getpid()}.{threading.get_ident()}")
            tmp.write_text(json.dumps({"total": total}), encoding="utf-8")
            os.replace(tmp, _USAGE_FILE)
    except OSError:
        pass
