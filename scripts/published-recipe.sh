#!/bin/sh
# Print the recipe hash baked into a published image. Used by
# .github/workflows/build.yml to decide whether a new upstream version needs
# building and whether an already-published version needs a rebuild because the
# recipe here changed.
#
# The hash is a content hash over the Dockerfile, docker-entrypoint.sh, the
# rootfs tree, compose.yaml, the Unraid template, the workflow itself and BOTH
# upstream pins (Claude Desktop and the Claude Code CLI), so a bump in either
# upstream or any recipe edit produces a different value and exactly one
# rebuild. It is stamped on the image as
# org.opencontainers.image.claude-code-linux-recipe (and mirrored on
# com.prvctech.claude-recipe for the DESIGN.md label table).
#
# Reads the image config over the OCI registry API instead of `docker buildx
# imagetools`: the labels live in the config blob, so this needs nothing beyond
# curl and jq, and no docker login.
#
# usage: published-recipe.sh <registry> <repository> <tag> [github-token]
# env:   REGISTRY_SCHEME  http for a plain-HTTP registry (default https)
#
# The optional credential is a GitHub token (GITHUB_TOKEN or a PAT), used to
# exchange for an anonymous-or-scoped registry token when the package is private
# (it is, see DESIGN.md R3). Omit it for public packages.
#
# EXIT CODES — the caller must distinguish them, because "the tag is not
# published yet" (rebuild) and "the registry could not be read" (stop) lead to
# opposite decisions:
#   0  recipe hash printed (empty output = the tag exists but carries no recipe
#      label, which is itself a reason to rebuild)
#   3  the tag does not exist: HTTP 404 from the manifest endpoint
#   2  anything else — transport failure, 401/403, 5xx, an index with no
#      linux/amd64 child, an unreadable config blob. Never a "missing" verdict.
set -eu

# Diagnostics go to stderr so stdout stays a bare hash for $(...) capture.
note() { printf 'published-recipe: %s\n' "$*" >&2; }

[ "$#" -ge 3 ] || { note "usage: published-recipe.sh <registry> <repository> <tag> [token]"; exit 2; }
command -v jq >/dev/null 2>&1 || { note "jq is required"; exit 2; }

registry="${1:?usage: published-recipe.sh <registry> <repository> <tag> [token]}"
repository="${2:?usage: published-recipe.sh <registry> <repository> <tag> [token]}"
tag="${3:?usage: published-recipe.sh <registry> <repository> <tag> [token]}"
credential="${4:-}"
scheme="${REGISTRY_SCHEME:-https}"

# Both media-type families are offered: a registry storing OCI manifests
# answers 404 when only the Docker type is requested.
accept='application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json'

# A GitHub token is NOT itself a registry bearer token: presenting one raw makes
# ghcr answer 403. It has to be exchanged at the token endpoint, which wants it
# as the Basic-auth password. With no credential at all the same endpoint still
# hands out an anonymous token, which is all a public package needs.
token=""
if [ "$scheme" = "https" ]; then
  if [ -n "$credential" ]; then
    token=$(curl -fsSL -u "x-access-token:${credential}" \
      "https://${registry}/token?scope=repository:${repository}:pull" 2>/dev/null \
      | jq -r '.token // empty' || true)
  else
    token=$(curl -fsSL \
      "https://${registry}/token?scope=repository:${repository}:pull" 2>/dev/null \
      | jq -r '.token // empty' || true)
  fi
fi

if [ -n "$token" ]; then
  set -- -H "Authorization: Bearer ${token}"
else
  set --
fi

body=$(mktemp) || exit 2
cfg=$(mktemp) || exit 2
trap 'rm -f "$body" "$cfg"' EXIT HUP INT TERM

# -f is deliberately NOT used: a 404 has to be observed as a status code, not
# collapsed into curl's exit 22. A failed transfer still prints 000, so an empty
# code is normalised to 000 rather than concatenated.
manifest_url="${scheme}://${registry}/v2/${repository}/manifests/${tag}"
http=$(curl -sSL -o "$body" -w '%{http_code}' "$@" -H "Accept: $accept" \
  "$manifest_url" || true)
http=${http:-000}
case "$http" in
  200) ;;
  404) exit 3 ;;
  000) note "no HTTP response from ${registry} for ${repository}:${tag}"; exit 2 ;;
  *)   note "HTTP ${http} from ${registry} for ${repository}:${tag}"; exit 2 ;;
esac

# A tag may resolve to a multi-arch index. In that case the digest in
# .manifests[] is a MANIFEST digest, not a config blob, so it has to be fetched
# from the manifest endpoint first and the config digest read out of it. Reading
# it as a blob answers 404 and would misreport a published tag as an error.
child=$(mktemp) || exit 2
trap 'rm -f "$body" "$cfg" "$child"' EXIT HUP INT TERM

if [ "$(jq -r 'if .manifests then "index" else "manifest" end' "$body")" = "index" ]; then
  arch_digest=$(jq -r '[.manifests[] | select(.platform.os == "linux"
      and .platform.architecture == "amd64")][0].digest // empty' "$body")
  [ -n "$arch_digest" ] \
    || { note "${repository}:${tag} is an index with no linux/amd64 manifest"; exit 2; }
  child_http=$(curl -sSL -o "$child" -w '%{http_code}' "$@" -H "Accept: $accept" \
    "${scheme}://${registry}/v2/${repository}/manifests/${arch_digest}" || true)
  child_http=${child_http:-000}
  [ "$child_http" = 200 ] \
    || { note "linux/amd64 manifest ${arch_digest} answered HTTP ${child_http}"; exit 2; }
else
  cp "$body" "$child"
fi

digest=$(jq -r '.config.digest // empty' "$child")
case "$digest" in
  sha256:*) ;;
  *) note "${repository}:${tag} carries no usable config digest"; exit 2 ;;
esac

config_url="${scheme}://${registry}/v2/${repository}/blobs/${digest}"
blob_http=$(curl -sSL -o "$cfg" -w '%{http_code}' "$@" \
  -H 'Accept: application/vnd.oci.image.config.v1+json' "$config_url" || true)
blob_http=${blob_http:-000}
[ "$blob_http" = 200 ] \
  || { note "config blob ${digest} answered HTTP ${blob_http}"; exit 2; }

jq -r '.config.Labels["org.opencontainers.image.claude-code-linux-recipe"]
       // .config.Labels["com.prvctech.claude-recipe"] // empty' "$cfg"
