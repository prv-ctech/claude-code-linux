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
# Modified by oh-my-context-mod (github.com/prv-ctech/claude-code-linux), 2026-10-30: only the SKILL.md frontmatter reader is kept (the Agent Plugins scanner and installer are removed); renamed to oh-my-context: package, commands, tool, environment and path names (see vendor/NOTICE).

"""SKILL.md frontmatter reading, for the skills index (skills.scan_roots)."""

from pathlib import Path


def _block_indicator(value: str) -> str | None:
    """Return ``"|"`` or ``">"`` when *value* starts a YAML block scalar, else None.

    YAML lets a scalar span lines — ``description: |`` puts the text in the
    indented lines below. Reading only the line that carries the colon yields the
    indicator itself as the value, which is what shipped: five skills on this
    machine were indexed with a description of literally ``|``, so the catalog
    showed a pipe where their text belongs and no query could match them. One of
    those, ``humanizer``, also keeps its 触发词 line inside that block, so its
    only Chinese routing signal was being thrown away with it.

    An indentation indicator (``|2``) is accepted; the digits only feed YAML's own
    column arithmetic, which folding-and-stripping makes moot.
    """
    v = value.strip()
    if not v or v[0] not in "|>":
        return None
    return v[0] if v[1:].rstrip("+-0123456789") == "" else None


def _fold_block_scalar(lines: list[str], i: int, style: str) -> tuple[str, int]:
    """Fold the indented block after ``lines[i]`` into one line.

    Returns ``(text, next_index)``. ``|`` keeps its newlines, ``>`` folds them to
    spaces; either way the result is collapsed to a single line, because every
    caller here wants a value it can read off one line. Common leading
    indentation is removed first so the text is not padded.
    """
    block: list[str] = []
    j = i + 1
    while j < len(lines):
        raw = lines[j]
        if raw.strip() == "":
            block.append("")
            j += 1
            continue
        if not raw.startswith((" ", "\t")):
            break
        block.append(raw)
        j += 1
    while block and not block[-1].strip():
        block.pop()
    if not block:
        return "", j
    indents = [len(b) - len(b.lstrip()) for b in block if b.strip()]
    cut = min(indents) if indents else 0
    body = [b[cut:] if len(b) >= cut else "" for b in block]
    text = "\n".join(body) if style == "|" else " ".join(p.strip() for p in body)
    return " ".join(text.split()), j


def _fold_frontmatter_blocks(block: str) -> str:
    """Rewrite block scalars in a frontmatter *block* as one-line values.

    Pre-processing here rather than inside the parsers keeps their existing
    line-by-line loops unchanged — one place to get block scalars right instead
    of two that can drift apart.
    """
    lines = block.splitlines()
    out: list[str] = []
    i = 0
    while i < len(lines):
        key, sep, value = lines[i].partition(":")
        style = _block_indicator(value) if sep else None
        if style is None:
            out.append(lines[i])
            i += 1
            continue
        text, i = _fold_block_scalar(lines, i, style)
        out.append(f"{key}: {text}")
    return "\n".join(out)


def strip_yaml_quotes(value: str) -> str:
    """Drop one matching pair of YAML quotes wrapping *value*.

    A frontmatter line ``description: "…"`` carries the quotes as YAML syntax,
    not as part of the value — but the raw line keeps them. Only a *matching*
    pair at the very start and end is stripped, so a description that
    legitimately contains internal quotes (``He said "hi"``) survives intact;
    blanket-replacing quote characters would corrupt it.
    """
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def parse_skill_md(path: Path | str) -> tuple[str, str, str]:
    """Parse a SKILL.md into (name, description, body). Zero-dependency.

    Frontmatter (between the first two ``---`` lines) supplies name and
    description; everything after it is the body. Missing frontmatter yields
    empty name/description and the whole text as body. Raises OSError if the
    file cannot be read (callers decide whether to skip).
    """
    text = Path(path).read_text(encoding="utf-8")
    name, description, body = "", "", text.strip()
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) == 3:
            for line in _fold_frontmatter_blocks(parts[1]).splitlines():
                key, _, value = line.partition(":")
                key = key.strip().lower()
                if key == "name":
                    name = value.strip()
                elif key == "description":
                    description = strip_yaml_quotes(value.strip())
            body = parts[2].strip()
    return name, description, body


