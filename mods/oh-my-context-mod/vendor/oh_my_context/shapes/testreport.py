# Added by oh-my-context-mod (ticket 005): own implementation, not from upstream mcptoon.
"""testreport: pytest JSON, Jest JSON, JUnit XML -> summary plus trimmed failures."""
import json
import xml.etree.ElementTree as ET


def _trim(frames: list) -> list:
    if len(frames) >= 8:
        return frames[:3] + [f"... ({len(frames) - 5} frames omitted)"] + frames[-2:]
    return frames


def _pytest(d):
    cases = []
    for t in d["tests"]:
        out = t.get("outcome", "")
        call = t.get("call") or {}
        crash = call.get("crash") or {}
        frames = [f"{f.get('path', '')}:{f.get('lineno', '')} {f.get('message', '')}".rstrip()
                  for f in call.get("traceback") or [] if isinstance(f, dict)]
        cases.append((t.get("nodeid") or t.get("name") or "?", out,
                      crash.get("message") or "", frames))
    dur = d.get("duration") or 0
    return cases, dur


def _jest(d):
    cases = []
    for f in d["testResults"]:
        for a in f.get("assertionResults", []):
            st = {"passed": "passed", "failed": "failed", "pending": "skipped",
                  "skipped": "skipped", "todo": "skipped"}.get(a.get("status"), "passed")
            msgs = "\n".join(a.get("failureMessages") or []).split("\n")
            frames = [x.strip() for x in msgs[1:] if x.strip()]
            cases.append((a.get("fullName") or a.get("title") or "?", st, msgs[0], frames))
    return cases, 0


def _junit(text):
    root = ET.fromstring(text)
    cases = []
    for tc in root.iter("testcase"):
        name = f"{tc.get('classname', '')}.{tc.get('name', '')}".strip(".")
        st, msg, frames = "passed", "", []
        for tag, label in (("failure", "failed"), ("error", "error"), ("skipped", "skipped")):
            el = tc.find(tag)
            if el is not None:
                st, msg = label, el.get("message") or ""
                frames = [x.strip() for x in (el.text or "").split("\n") if x.strip()]
                break
        cases.append((name, st, msg, frames))
    try:
        dur = float(root.get("time") or 0)
    except ValueError:
        dur = 0
    return cases, dur


def compress(text: str):
    s = text.lstrip()
    if s[:1] in "{[":
        d = json.loads(text)
        cases, dur = _pytest(d) if "tests" in d else _jest(d)
    else:
        cases, dur = _junit(text)
    if not cases:
        return None
    counts = {"passed": 0, "failed": 0, "errors": 0, "skipped": 0}
    key = {"passed": "passed", "failed": "failed", "error": "errors", "skipped": "skipped"}
    for _, st, _, _ in cases:
        counts[key.get(st, "passed")] += 1
    head = "TEST SUMMARY: " + " ".join(f"{k}={v}" for k, v in counts.items() if v)
    if dur > 0:
        head += f" duration={dur:g}s"
    lines = [head]
    for name, st, msg, frames in cases:
        if st in ("failed", "error"):
            lines.append(f"{'ERROR' if st == 'error' else 'FAILED'}: {name}")
            if msg:
                lines.append(msg)
            lines += _trim(frames)
    return "\n".join(lines)
