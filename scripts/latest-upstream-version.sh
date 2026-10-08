#!/bin/sh
# Resolve the newest official Claude Desktop version from Anthropic's apt index.
#
# Contract (docs/DESIGN.md D2): ONE fetch of the Packages index, parse it as
# RFC-822 stanzas, keep only stanzas whose first line is `Package: claude-desktop`,
# take the SHA256 from the SAME stanza, order with `sort -V`, last line wins.
#
# Why `sort -V` and not a string compare: the index scheme moved from the 1.x
# line to 2.x and the index is append-only, so "2.9.0" vs "2.10.0" breaks any
# lexical compare. Why a fixed column table is wrong: the index is the only
# source of truth for the version, its SHA256 and its Filename; a table of known
# versions goes stale the moment Anthropic publishes one (which is the whole
# point of the sweep).
#
# usage: latest-upstream-version.sh [--json|--candidates|--field F] [--min-version V]
#   (no options)   print the newest version, one line, e.g. 2.26454.2
#   --json         one JSON object with version/sha256/filename/deb_url/stanzas
#   --candidates   "<version> <sha256> <filename>" per stanza >= MIN_VERSION,
#                  ascending by version, for the CI plan job's buildability walk
#   --field F      version|sha256|filename|deb-url|stanzas
# env: INDEX_URL, MIN_VERSION (default 2.0.0)
set -eu

INDEX_URL="${INDEX_URL:-https://downloads.claude.ai/claude-desktop/apt/stable/dists/stable/main/binary-amd64/Packages}"
INDEX_BASE="${INDEX_BASE:-https://downloads.claude.ai/claude-desktop/apt/stable}"
MIN_VERSION="${MIN_VERSION:-2.0.0}"
field=version
want_json=false
want_candidates=false

while [ $# -gt 0 ]; do
  case "$1" in
    --json) want_json=true ;;
    --candidates) want_candidates=true ;;
    --min-version) MIN_VERSION="${2:?--min-version needs a value}"; shift ;;
    --field) field="${2:?--field needs a value}"; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# at_least A B -> true when A >= B under version ordering (house pattern).
at_least() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }

idx=$(mktemp); trap 'rm -f "$idx"' EXIT
curl -fsSL --max-time 120 "$INDEX_URL" -o "$idx"

stanzas=$(grep -c '^Package: claude-desktop$' "$idx" || true)
if [ "${stanzas:-0}" -eq 0 ]; then
  echo "FATAL: no 'Package: claude-desktop' stanza in $INDEX_URL" >&2
  exit 1
fi

# Emit "<version> <sha256> <filename>" for every claude-desktop stanza.
rows=$(awk -v RS='' '
  {
    gsub(/\r/, "")
    n = split($0, L, "\n")
    if (L[1] != "Package: claude-desktop") next
    v = ""; s = ""; f = ""
    for (i = 1; i <= n; i++) {
      if (L[i] ~ /^Version: /)  v = substr(L[i], 10)
      if (L[i] ~ /^SHA256: /)   s = substr(L[i], 9)
      if (L[i] ~ /^Filename: /) f = substr(L[i], 11)
    }
    if (v != "") print v, s, f
  }' "$idx" | sort -V)

candidates=$(printf '%s\n' "$rows" | while read -r v s f; do
  [ -n "${v:-}" ] || continue
  at_least "$v" "$MIN_VERSION" && printf '%s %s %s\n' "$v" "$s" "$f"
done)

if [ -z "$candidates" ]; then
  echo "FATAL: no claude-desktop version >= MIN_VERSION=$MIN_VERSION in the index (newest stanza is $(printf '%s\n' "$rows" | tail -n 1 | cut -d' ' -f1))" >&2
  exit 1
fi

best=$(printf '%s\n' "$candidates" | tail -n 1)
VERSION=$(printf '%s' "$best" | cut -d' ' -f1)
SHA256=$(printf '%s' "$best" | cut -d' ' -f2)
FILENAME=$(printf '%s' "$best" | cut -d' ' -f3)
DEB_URL="$INDEX_BASE/$FILENAME"

if [ "$want_candidates" = true ]; then
  printf '%s\n' "$candidates"
  exit 0
fi

if [ "$want_json" = true ]; then
  printf '{"version":"%s","sha256":"%s","filename":"%s","deb_url":"%s","index_url":"%s","stanzas":%s,"min_version":"%s"}\n' \
    "$VERSION" "$SHA256" "$FILENAME" "$DEB_URL" "$INDEX_URL" "$stanzas" "$MIN_VERSION"
  exit 0
fi

case "$field" in
  version) printf '%s\n' "$VERSION" ;;
  sha256) printf '%s\n' "$SHA256" ;;
  filename) printf '%s\n' "$FILENAME" ;;
  deb-url) printf '%s\n' "$DEB_URL" ;;
  stanzas) printf '%s\n' "$stanzas" ;;
  *) echo "unknown --field '$field' (version|sha256|filename|deb-url|stanzas)" >&2; exit 2 ;;
esac
