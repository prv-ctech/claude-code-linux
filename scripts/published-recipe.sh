#!/bin/sh
# Print the recipe hash baked into a published image, or exit non-zero when the
# tag does not exist. Used by .github/workflows/build.yml to decide whether a
# new upstream version needs building and whether an already-published version
# needs a rebuild because the recipe here changed.
#
# The hash is a content hash over the Dockerfile, docker-entrypoint.sh, the
# rootfs tree, compose.yaml, the Unraid template and BOTH upstream pins (Claude
# Desktop and the Claude Code CLI), so a bump in either upstream or any recipe
# edit produces a different value and exactly one rebuild. It is stamped on the
# image as org.opencontainers.image.claude-code-linux-recipe (and mirrored on
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
set -eu

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

# A tag may resolve to a multi-arch index; take the linux/amd64 manifest.
manifest=$(curl -fsSL "$@" -H "Accept: $accept" \
  "${scheme}://${registry}/v2/${repository}/manifests/${tag}") || exit 1

digest=$(printf '%s' "$manifest" | jq -r '
  if .manifests then
    (.manifests[] | select(.platform.os == "linux" and .platform.architecture == "amd64") | .digest)
  else .config.digest end')
case "$digest" in sha256:*) ;; *) exit 1 ;; esac

curl -fsSL "$@" -H 'Accept: application/vnd.oci.image.config.v1+json' \
  "${scheme}://${registry}/v2/${repository}/blobs/${digest}" \
  | jq -r '.config.Labels["org.opencontainers.image.claude-code-linux-recipe"]
           // .config.Labels["com.prvctech.claude-recipe"] // empty'
