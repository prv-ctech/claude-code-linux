#!/bin/sh
# Every workspace file the image build consumes: one repo-relative path per line,
# LC_ALL=C sorted and deduplicated. This is the input set of the recipe hash.
#
# It is DERIVED, never hand-maintained (reviewer finding F9). The workflow used
# to carry a literal list, and the list omitted scripts/install-claude-desktop.sh
# even though the Dockerfile COPYs it (Dockerfile:157) and executes it (:289):
# editing it produced an unchanged recipe hash, the plan job concluded "up to
# date", and the edit reached no image. The Dockerfile's own COPY lines are the
# source of truth now, so a new COPY source joins the hash with no other edit.
#
# Deliberately absent: the Claude Desktop version. The decide step mixes it in per
# candidate, because a version here would make an unfetchable new index stanza
# change the hash while the built image stays identical - a pointless rebuild on
# every sweep.
#
# The bump rule lives in .github/workflows/build.yml (`RECIPE_SCHEMA`): changing
# what this script prints, or how it computes it, is a recipe change, so bump that
# constant in the same commit - every published version then rebuilds exactly once
# instead of hashing differently without saying so.
#
# Consumers word-split the output, so a path must not contain whitespace; this
# repository has none, and the workflow fails loudly on any path it cannot hash.
set -eu

cd "$(dirname "$0")/.."

dockerfile=${1:-Dockerfile}

# The COPY/ADD sources of the Dockerfile. Continuation lines are joined first, so
# a multi-line COPY cannot be misparsed into half a path - the failure mode would
# be a source that silently never reaches the hash. `--from=<stage>` copies out of
# a previous build stage, not out of the build context, so those are skipped.
copy_sources() {
  sed -e ':join' -e '/\\$/{N;s/\\\n//;tjoin}' "$dockerfile" |
    awk '
      /^[[:space:]]*(#|$)/ { next }
      tolower($1) != "copy" && tolower($1) != "add" { next }
      {
        n = 0
        fromstage = 0
        for (i = 2; i <= NF; i++) {
          if ($i ~ /^--from=/) { fromstage = 1; continue }
          if ($i ~ /^--/) continue
          n++; tok[n] = $i
        }
        if (fromstage) { next }
        # Every argument except the last (the destination) is a source.
        for (i = 1; i < n; i++) print tok[i]
      }
    '
}

sources=$(copy_sources)
[ -n "$sources" ] || {
  echo "recipe-inputs: no COPY source found in $dockerfile; the derivation is broken" >&2
  exit 1
}

# A source is either a file or a directory whose whole tree is copied.
copy_files=""
for src in $sources; do
  src=${src%/}
  if [ -f "$src" ]; then
    copy_files="$copy_files $src"
  elif [ -d "$src" ]; then
    under=$(find "$src" -type f | LC_ALL=C sort)
    [ -n "$under" ] || { echo "recipe-inputs: COPY source '$src' is an empty directory" >&2; exit 1; }
    copy_files="$copy_files $under"
  else
    echo "recipe-inputs: COPY source '$src' is not in the build context" >&2
    exit 1
  fi
done

unraid_files=$(find unraid -type f | LC_ALL=C sort)
[ -n "$unraid_files" ] || { echo "recipe-inputs: unraid/ holds no files" >&2; exit 1; }

# Dockerfile and .dockerignore: consumed by the build without being COPYed, and
# .dockerignore changes the context the COPY lines resolve against. compose.yaml,
# unraid/** and the workflow file are the packaging inputs the template tests and
# the sweep read; the workflow also asserts every emitted path exists.
# shellcheck disable=SC2086  # the file lists are intentional word-split lists
printf '%s\n' \
  Dockerfile \
  .dockerignore \
  docker-entrypoint.sh \
  compose.yaml \
  .github/workflows/build.yml \
  $copy_files \
  $unraid_files |
  LC_ALL=C sort -u
