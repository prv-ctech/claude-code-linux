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
# Modified by oh-my-context-mod (github.com/prv-ctech/claude-code-linux), 2026-10-30: block only (no soft cap), fixed limits; renamed to oh-my-context: package, commands, tool, environment and path names (see vendor/NOTICE).

"""floodguard — progressive throttle for the gateway's own search tools.

Why this exists
---------------
``kb_search`` (and ``resolve_skills``) can be called in a loop.
An agent that fires twelve individual searches has chosen twelve round trips
over one batched query, and each one drags a fresh set of snippets into the
context window — the exact flood the gateway exists to prevent. Past a limit the
calls are refused with a nudge toward the batched path.

The budget is **per agent context**, not global
-----------------------------------------------
This is the bug the context-mode project hit and fixed (their issue #769): one
module-global counter means ten concurrent subagents share one budget, so a
legitimate fan-out ("10 agents × 2 calls") trips a guard that was only ever meant
to catch *one* actor spamming. Keying the counter per agent id preserves
single-actor flood protection exactly while letting fan-out work.

Pure and transport-free on purpose
----------------------------------
No MCP types, no clock of its own (``now`` is a parameter), so the policy is
unit-testable without a server. ``serve`` owns the singleton and supplies the key.
"""

from __future__ import annotations

from dataclasses import dataclass

#: Rolling window. After this many seconds a key's counter resets.
WINDOW_MS = 60_000

#: Calls beyond this are refused outright.
BLOCK_AFTER = 8

#: Defensive bound on tracked keys, so a host that mints unbounded agent ids
#: cannot grow the map without limit. Eviction is oldest-window-first and fails
#: open (the evicted actor simply gets a fresh window) — never a false block.
MAX_KEYS = 4096


@dataclass
class Decision:
    count: int
    blocked: bool
    #: Seconds until this key's window resets — used in the message.
    resets_in: int

    def message(self, tool: str) -> str:
        return (f"{tool}: {self.count} calls in this window — blocked to stop a "
                f"context flood. Batch them into one call, or retry in "
                f"{self.resets_in}s.")


class FloodGuard:
    """A rolling-window call counter, bucketed per agent-context key."""

    def __init__(self) -> None:
        self._buckets: dict[str, tuple[int, int]] = {}  # key -> (count, window_start)

    def record(self, key: str, now_ms: int) -> Decision:
        count, start = self._buckets.get(key, (0, now_ms))
        if now_ms - start > WINDOW_MS:
            count, start = 0, now_ms
        count += 1
        self._buckets[key] = (count, start)
        if len(self._buckets) > MAX_KEYS:
            oldest = min(self._buckets.items(), key=lambda kv: kv[1][1])
            self._buckets.pop(oldest[0], None)
        resets_in = max(0, int((start + WINDOW_MS - now_ms) / 1000))
        return Decision(count=count, blocked=count > BLOCK_AFTER, resets_in=resets_in)
