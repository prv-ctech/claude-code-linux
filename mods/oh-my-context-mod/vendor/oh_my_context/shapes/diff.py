"""diff: keep changed lines, headers and 2 lines of context either side."""
_ANCHORS = ("diff --git ", "index ", "--- ", "+++ ", "@@ ", "rename ", "copy ", "old mode",
            "new mode", "new file", "deleted file", "Binary files", "GIT binary patch",
            "\\", "+", "-")


def compress(text: str):
    lines = text.split("\n")
    if len(lines) < 12:
        return None
    keep = [False] * len(lines)
    for i, ln in enumerate(lines):
        if ln.startswith(_ANCHORS):
            for j in range(max(0, i - 2), min(len(lines), i + 3)):
                keep[j] = True
    out, gap = [], 0
    for ln, k in zip(lines, keep):
        if k:
            if gap:
                out.append(f"… {gap} context lines elided …")
                gap = 0
            out.append(ln)
        else:
            gap += 1
    if gap:
        out.append(f"… {gap} context lines elided …")
    return "\n".join(out) if any(not k for k in keep) else None
