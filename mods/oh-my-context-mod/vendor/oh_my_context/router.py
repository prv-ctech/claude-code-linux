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
# Modified by oh-my-context-mod (github.com/prv-ctech/claude-code-linux), 2026-10-30: only the safety screens are kept (routing lives in serve); renamed to oh-my-context: package, commands, tool, environment and path names (see vendor/NOTICE).

"""
oh-my-context router — safety screens for routed calls

The destructive-operation check (`serve` applies it to a direct call under
exposure=full) and prompt poisoning detection (routed prompts).
"""
import re
import unicodedata
from typing import Any


# ─── Tool annotations: dangerous operations ───

# Name-substring fallback for servers that ship no MCP `annotations` (most do
# not). Ordered loosely by specificity; `run_` is last so a tool named
# `run_query` is caught while `runtime_info` is not (`run_` needs the trailing
# underscore). Added `truncate`/`overwrite`/`execute`/`run_` on 2026-10-23 after
# an external report: a `truncate_table` tool slipped through the old list.
_DANGEROUS_PATTERNS = [
    "delete", "remove", "drop", "destroy", "purge", "wipe",
    "rm_", "del_", "clear", "reset", "force", "kill",
    "truncate", "overwrite", "execute", "run_",
]

# Arguments whose *value* can carry a destructive statement even when the tool
# name is neutral (the `run_query {"sql": "DROP TABLE customers"}` case).
_DANGEROUS_ARG_KEYS = ("sql", "query", "statement", "command", "cmd", "script", "shell")
_DANGEROUS_ARG_PATTERNS = [
    r"\bdrop\s+(table|database|schema|index|view)\b",
    r"\btruncate\s+(table\s+)?\w",
    r"\bdelete\s+from\b",
    r"\bupdate\s+\w+\s+set\b",
    r"\b(insert\s+into|alter\s+table|create\s+table)\b",
    r"\brm\s+-[rf]", r"\bmkfs\b", r"\bdd\s+if=",
    r"\b(shutdown|reboot|halt)\b", r">\s*/dev/sd",
]


def _coerce_bool(value: Any) -> bool | None:
    """True/False for a real bool or the usual JSON string spellings, else None."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        low = value.strip().lower()
        if low in ("true", "1", "yes", "y"):
            return True
        if low in ("false", "0", "no", "n"):
            return False
    if isinstance(value, int):
        return bool(value)
    return None


def _tool_annotations(server: str, tool: str) -> dict | None:
    """The MCP `annotations` dict for a tool, from cache only.

    Cache-only on purpose: the safety screen must never spawn a server, and an uncached server simply
    falls back to the name-substring check. `get_cached_tools_any_age` is used
    rather than `get_cached_tools` so a TTL-expired entry still contributes its
    annotations — a stale annotation is better than none for a *pre*-call check.
    """
    try:
        from . import cache as _cache
        cached = _cache.get_cached_tools_any_age(server)
    except Exception:
        return None
    if not cached:
        return None
    for t in cached:
        if isinstance(t, dict) and t.get("name") == tool:
            ann = t.get("annotations")
            return ann if isinstance(ann, dict) else None
    return None


def _check_dangerous(server: str, tool: str, args: dict | None = None,
                     annotations: dict | None = None) -> str | None:
    """Check if operation is dangerous. Returns reason string or None.

    Resolution order, so an explicit MCP annotation beats a guessed name:

      1. ``readOnlyHint: true``  → safe, skip the name check entirely. That is
         the field's whole purpose: it clears a *false positive* such as a
         cache-flush tool whose name happens to contain ``clear``.
      2. ``destructiveHint: true`` → dangerous even when the name looks harmless
         (a `truncate_table` carrying the spec annotation). The old name-only
         screen waved this straight through.
      3. Name-substring fallback in ``_DANGEROUS_PATTERNS`` for servers that ship
         no annotations.
      4. Argument inspection: an explicit ``force``/``confirm`` true, or a
         destructive statement (DROP TABLE, rm -rf, …) inside a sql/shell-ish
         argument.

    ``annotations`` is the MCP ``tool.annotations`` dict when the caller already
    has it (`serve` keeps it in memory); otherwise it is read from the cache.
    """
    if not tool:
        return None
    tool_lower = tool.lower()

    if annotations is None:
        annotations = _tool_annotations(server, tool)

    # 1. readOnlyHint clears the name check (fixes the clear_cache false positive)
    if isinstance(annotations, dict):
        if _coerce_bool(annotations.get("readOnlyHint")) is True:
            # Still honour an explicit force/confirm argument — a read-only tool
            # has no business taking one, and if it does the caller is asserting
            # an intent we should not silently drop.
            if args and isinstance(args, dict):
                for key in ("force", "confirm"):
                    if key in args and args[key] is True:
                        return f"argument contains dangerous flag: {key}=true"
            return None
        # 2. destructiveHint flags a dangerous op the name does not advertise
        if _coerce_bool(annotations.get("destructiveHint")) is True:
            return "tool annotations declare destructiveHint: true"

    # 3. Name-substring fallback
    for pattern in _DANGEROUS_PATTERNS:
        if pattern in tool_lower:
            return f"tool name matches dangerous pattern: '{pattern}'"

    # 4a. Explicit force/confirm flags
    if args and isinstance(args, dict):
        for key in ("force", "confirm"):
            if key in args and args[key] is True:
                return f"argument contains dangerous flag: {key}=true"
        # 4b. Destructive statement hidden in a sql/shell-style argument
        for key in _DANGEROUS_ARG_KEYS:
            val = args.get(key)
            if not isinstance(val, str):
                continue
            low = val.lower()
            for pat in _DANGEROUS_ARG_PATTERNS:
                if re.search(pat, low):
                    return f"argument '{key}' contains a destructive statement"
    return None


# ─── Tool poisoning detection ───

# Patterns that indicate prompt injection in tool results
# Based on OWASP LLM Top 10, Invariant Labs Tool Poisoning research,
# and MCP-ITP (arXiv:2601.07395) attack patterns
_POISONING_INDICATORS = [
    # ── Direct instruction override ──
    "ignore previous instructions",
    "ignore all previous",
    "ignore the above",
    "ignore prior instructions",
    "disregard the above",
    "disregard previous",
    "forget your instructions",
    "forget all previous",
    # ── Role hijacking ──
    # fix 2026-10-01: `"you are a "` 与 `"act as "` 这**两个裸子串已从本表移除**，
    # 下方 `_POISONING_REGEXES` 以"句首锚定"形式重新收编（见该文件内注释）。
    # 原因（实测误报）：它们是英语里极常见的普通短语，字面匹配会在正常技术文本上
    # 恒命中 —— 例 ollama issue #18676 正文
    #   "this makes `done` act as a parsing short-circuit rather than a terminal signal"
    # 与 #18715/#18620 中被引用的 system prompt 片段 ("you are a coding agent ...")。
    # 两处都不是注入，却把整份 issues 结果拦成 TOOL_POISONING，真数据一条都拿不到。
    "you are now",
    "pretend you are",
    "new role:",
    "new instructions:",
    "system prompt:",
    # ── Hidden instructions (HTML comments, tags) ──
    "<!-- assistant:",
    "<!-- ignore",
    "<!-- system",
    "<!-- important",
    "<!-- do ",
    "[INST]",
    "<<SYS>>",
    "<|im_start|",
    "<|system|",
    # ── Data exfiltration attempts ──
    # fix 2026-10-01: `"curl http"` / `"wget http"` 同样过宽 —— GitHub issue 与
    # release notes 里满是可复现用的 curl/wget 命令（实测 ollama #18718 与
    # v0.35.0/v0.34.3 发布说明均被它拦成 TOOL_POISONING，真数据一条都拿不到）。
    # 已收编到下方 `_POISONING_REGEXES`：仅当与"外传动作"同现时才算。
    "send this to",
    "post this to",
    "call this url",
    "fetch this url",
    "upload to ",
    "exfiltrate",
    # ── Credential harvesting ──
    "read your env",
    "cat ~/.ssh",
    "print your api key",
    "show your token",
    "read /etc/passwd",
    "cat /etc/shadow",
    # ── Privilege escalation ──
    "sudo ",
    "chmod 777",
    "rm -rf",
    "format c:",
    # ── MCP-specific tool poisoning patterns ──
    "tool result:",  # fake tool result injection
    "mcp server:",  # fake server directive
    "register tool",
    "add this tool",
]

# ── Chinese indicators (v0.7.3) ──
_POISONING_INDICATORS_ZH = [
    "忽略之前", "忽略以上", "忽略先前",
    "无视之前", "无视以上",
    "你的系统提示", "你的api key", "你的密钥",
]

# ── 句首锚定的角色劫持判定（2026-10-01 收窄） ──
# 这三个短语在英语里太常见，做**裸子串**匹配会在正常内容上恒命中（误报实例见上方
# `_POISONING_INDICATORS` 的 Role hijacking 注释）。这里改成：只有出现在**句首**
# （文本开头，或紧跟在 . / ! / ? / 换行 之后）才算 —— 真正的注入是写给模型的独立
# 指令，通常就落在句首；而误报那几例都是嵌在从句/被引文本里的普通描述。
#
# ⚠️ 性质声明（advisory）：本函数整体是**启发式安全网，不是安全边界**（见下方
# docstring）。这类宽泛判定**曾经误判过**，按 R5 纪律仅作提示性拦截，
# 宁可漏拦也不要把正常数据整块吞掉。
_POISONING_REGEXES = [
    re.compile(r"(?:^|[.!?。！？\n])\s*you are a\b"),
    re.compile(r"(?:^|[.!?。！？\n])\s*act as\b"),
    re.compile(r"(?:^|[.!?。！？\n])\s*you have been\b"),
    # curl/wget 本身无害（技术文档里满地都是），只有"传到本地以外的地址"且带
    # 外传/凭据意图时才是真注入信号。故要求：外传动作 + 非本地目标，两者同现。
    re.compile(r"curl\s+https?://[^\n]{0,200}", re.I),
    re.compile(r"wget\s+https?://[^\n]{0,200}", re.I),
]

# 与上面 curl/wget 正则配套的判定（2026-10-01 收窄）：
# ① 外传/凭据类动词 —— 光有 curl 不算，得有"把东西送出去/偷出来"的意图
_EXFIL_VERBS = (
    "send this", "post this", "upload this", "upload to", "exfiltrate",
    "leak the", "steal the", "your api key", "your token", "print your api key",
    "show your token", "read your env", "~/.ssh", "/etc/passwd",
)
# ② 本地目标不算外传：localhost / 127.0.0.1 / ::1 / 私有网段 / example.com
_LOCAL_TARGET_RE = re.compile(
    r"https?://(?:localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0|"
    r"10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|"
    r"example\.com|example\.org|example\.net)", re.I)


# Zero-width and invisible characters used to split keywords past substring
# matching (U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+2060 WJ, U+FEFF BOM)
_ZERO_WIDTH_RE = re.compile(r"[\u200b\u200c\u200d\u2060\ufeff]")


def _normalize_for_scan(text: str) -> str:
    """Normalize obfuscation tricks before indicator matching (v0.7.3).

    1. NFKC fold (fullwidth → ascii), lowercased
    2. strip zero-width chars that would otherwise split keywords
    """
    folded = unicodedata.normalize("NFKC", text).lower()
    return _ZERO_WIDTH_RE.sub("", folded)


def _check_poisoning(result: Any) -> str | None:
    """Detect prompt injection in tool results.

    Returns reason string if poisoning detected, None otherwise.
    This is a heuristic check — not a security boundary, but a safety net.

    v0.7.3 hardening:
      - scans the full text (was: first 5000 chars only — truncation bypass)
      - NFKC-normalizes (defeats fullwidth homoglyphs)
      - strips zero-width chars (defeats 'ig\u200bnore' splitting)
      - zero-width DENSITY is itself a signal (hiding something)
      - Chinese indicator list added
    """
    if result is None:
        return None

    # Convert result to string for scanning
    try:
        text = str(result)
    except Exception:
        return None

    # Zero-width density check (before stripping, on the original text)
    zw_count = len(_ZERO_WIDTH_RE.findall(text))
    if zw_count >= 3:
        return (f"potential prompt injection detected: "
                f"{zw_count} zero-width characters in output")

    normalized = _normalize_for_scan(text)

    for indicator in _POISONING_INDICATORS:
        if indicator.lower() in normalized:
            return f"potential prompt injection detected: contains '{indicator}'"
    for indicator in _POISONING_INDICATORS_ZH:
        if indicator in normalized:
            return f"potential prompt injection detected: contains '{indicator}'"
    # 句首锚定的宽泛角色劫持判定（2026-10-01 收窄后新增，见 _POISONING_REGEXES）
    for rx in _POISONING_REGEXES:
        if not rx.search(normalized):
            continue
        if rx.pattern.startswith(("curl", "wget")):
            # curl/wget 单独出现是正常技术内容（发布说明/复现步骤里满地都是）。
            # 仅当 ① 含外传意图 ② 且目标不是本机/私有地址 时才判为注入。
            match = rx.search(normalized)
            if not match or _LOCAL_TARGET_RE.search(match.group()):
                continue
            if not any(w in normalized for w in _EXFIL_VERBS):
                continue
        return f"potential prompt injection detected: matches pattern '{rx.pattern}'"

    return None
