"""text: keep notable paragraphs; long runs of the rest collapse."""
import re

_KEEP = re.compile(r"(?i)\b(ERROR|WARNING|IMPORTANT|NOTE|ACTION|SECURITY|SUMMARY|CONCLUSION|DECISION|RECOMMENDATION)\b")
_HEAD = re.compile(r"^#{1,6}\s", re.M)


def _sections(text: str) -> list:
    secs, cur, fence = [], [], False
    for ln in text.split("\n"):
        if ln.lstrip().startswith("```"):
            fence = not fence
        if not ln.strip() and not fence:
            if cur:
                secs.append("\n".join(cur))
                cur = []
        else:
            cur.append(ln)
    if cur:
        secs.append("\n".join(cur))
    return secs


def compress(text: str):
    if len(text.encode()) < 1600:
        return None
    secs = _sections(text)
    if len(secs) <= 6:
        return None
    keep = [i < 2 or i >= len(secs) - 2 or "```" in s or bool(_HEAD.search(s)) or bool(_KEEP.search(s))
            for i, s in enumerate(secs)]
    out, run = [], []

    def flush():
        if len(run) >= 3:
            out.append(f"… {len(run)} sections elided …")
        else:
            out.extend(run)
        run.clear()

    for s, k in zip(secs, keep):
        if k:
            flush()
            out.append(s)
        else:
            run.append(s)
    flush()
    return "\n\n".join(out) if len(out) < len(secs) else None
