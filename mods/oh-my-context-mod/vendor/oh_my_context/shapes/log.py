# Added by oh-my-context-mod (ticket 005): own implementation, not from upstream mcptoon.
"""log: first 2, last 2 and notable lines; long runs of the rest collapse."""
import re

_KEEP = re.compile(
    r"(?i)(\b(ERROR|FATAL|PANIC|EXCEPTION|TRACEBACK|FAIL|FAILED|FAILURE|WARN|WARNING|CRIT|CRITICAL|ALERT|EMERG|EMERGENCY)\b"
    r"|^\s+at\s|^\s+File \"|\.go:\d+|^\s+--->|caused by)")


def compress(text: str):
    lines = text.split("\n")
    if len(lines) < 4:
        return None
    keep = [i < 2 or i >= len(lines) - 2 or bool(_KEEP.search(ln)) for i, ln in enumerate(lines)]
    out, run = [], []

    def flush():
        if len(run) >= 3:
            out.append(f"… {len(run)} lines elided …")
        else:
            out.extend(run)
        run.clear()

    for ln, k in zip(lines, keep):
        if k:
            flush()
            out.append(ln)
        else:
            run.append(ln)
    flush()
    return "\n".join(out) if len(out) < len(lines) else None
