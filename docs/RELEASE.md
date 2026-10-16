# Release, verification and rollback

Exact commands for the three things an operator does by hand: **publish a version**, **verify a
published image**, and **roll a user back**. Everything here is also what CI does, so a manual run and a
scheduled sweep end in the same state.

`<version>` below is a Claude Desktop version, e.g. `2.26454.2`. The current target pair, its `SHA256`
and the base image are tabulated in [`README.md`](../README.md#the-version-this-release-targets).

## What a release publishes

| Tag | Written how | Immutable? |
|---|---|---|
| `:<version>` | pushed by the `build` job after its smoke test passes | **No** — re-pointed when the CLI pin or the recipe changes |
| `:<version>-ubuntu26.04` | same digest, distribution flavor suffix from `BASE_IMAGE` | No, same reason |
| `:latest` | `docker buildx imagetools create --prefer-index=false` from the smoke-tested digest | No — it moves on purpose |

`:latest` is **never rebuilt**: it is written through as the same manifest bytes as `:<version>` (that
is what `--prefer-index=false` is for), and the `latest` job asserts that it resolves to the digest that
just passed the smoke test.

**The immutable handle is the digest** (`image@sha256:…`). Because a version tag can be re-pointed,
rollback instructions below use the digest where byte-identity matters.

## 0. Prerequisites, once

1. **Repository permissions** — *Settings → Actions → General → Workflow permissions*: **Read and write
   permissions**. Without it the first push fails with `denied: permission_denied: write_package` and the
   GHCR package is never created.
2. **The package is private** while the redistribution and licensing review is open
   ([README § Licensing](../README.md#licensing)). Every consumer needs
   `docker login ghcr.io -u <user>` with a PAT carrying `read:packages`.
3. **Local tools** for the manual path: `gh` authenticated (`gh auth status`), `docker` with `buildx`,
   `curl`, `jq`.

## 1. Publish a version by hand

```bash
# Pin the exact version and skip the registry read. rebuild=true is the recovery
# path for the very first publication, when the package does not exist yet and the
# plan job's registry read would exit 2 instead of guessing.
gh workflow run build.yml -f version=2.26454.2 -f rebuild=true

# Follow it.
gh run list --workflow=build.yml --limit 1
gh run watch "$(gh run list --workflow=build.yml --limit 1 --json databaseId -q '.[0].databaseId')"
```

The same thing without a pin — let the sweep decide what is newest:

```bash
gh workflow run build.yml
```

What must be true when it finishes:

- the `build` job's smoke test passed (health `healthy`, `dpkg-query` equals the planned version,
  `claude --version` equals the CLI pin as uid 1000, pid 1 root, `/api/health` 200, the streamed session
  up — Xvfb, `lxqt-session` and `openbox` running as uid 1000 on the display the base's own environment
  file names — `google-chrome --version` executing as uid 1000 and matching the version dpkg recorded
  for the single installed `google-chrome*` package with a headless `--dump-dom` run producing DOM, and
  `PUID=99` exiting 78);
- `:<version>` and `:<version>-ubuntu26.04` exist;
- `:latest` resolves to the **same digest** as `:<version>`.

A first push may fail once with `denied: permission_denied: write_package` (GHCR creates the package on
first write); the workflow retries that once. A second failure is the repository permission in §0.

## 2. Verify a published image

```bash
IMAGE=ghcr.io/prv-ctech/claude-code-linux

# Digest and media type of the precision tag, and of the moving tag.
docker buildx imagetools inspect "$IMAGE:2.26454.2"
docker buildx imagetools inspect --format '{{.Manifest.Digest}}' "$IMAGE:latest"

# The recipe hash stamped on the published image, read straight off the OCI
# registry API (no docker login needed for a public package; pass a token for the
# private one). Exit 0 = hash printed, 3 = tag absent, 2 = registry unreadable.
scripts/published-recipe.sh ghcr.io prv-ctech/claude-code-linux 2.26454.2 "${GITHUB_TOKEN:-}"
```

Reproduce that hash locally from the tree, to prove the published image was built from this commit:

```bash
{ printf 'CLAUDE_DESKTOP_VERSION=%s\n' 2.26454.2
  printf 'RECIPE_SCHEMA=2\n'
  printf 'BASE_IMAGE=ghcr.io/selkies-project/selkies/desktop:2.0.0-ubuntu26.04\n'
  printf 'CLAUDE_CODE_VERSION=%s\n' 2.1.294
  for f in $(sh scripts/recipe-inputs.sh); do
    printf '%s=%s\n' "$f" "$(sha256sum "$f" | cut -d' ' -f1)"
  done
} | sha256sum | cut -c1-12
```

The composition above is byte-identical to the workflow's (`RECIPE_SCHEMA`, `BASE_IMAGE` and the CLI pin,
then every file `scripts/recipe-inputs.sh` prints; the desktop version is prepended per candidate).

If you have a Docker daemon, run the same assertions CI runs:

```bash
docker run -d --name claude-verify --shm-size=2g \
  -e PUID=1000 -e PGID=1000 -e PASSWD=temp-verify -p 8080:8080 \
  -v "$PWD/verify-state:/home/ubuntu" "$IMAGE:2.26454.2"

docker inspect --format '{{.State.Health.Status}}' claude-verify                  # healthy
docker exec claude-verify dpkg-query -W -f='${Version}' claude-desktop            # 2.26454.2
docker exec -u 1000 claude-verify id -u                                           # 1000
docker exec -u 1000:1000 -e HOME=/home/ubuntu claude-verify claude --version      # 2.1.294
curl -k -s -o /dev/null -w '%{http_code}\n' https://localhost:8080/api/health     # 200

# The two runtime checks the smoke test adds on top of those: the session really
# up, and Chrome really executing in it, both as uid 1000.
docker exec -u 1000:1000 -e HOME=/home/ubuntu claude-verify sh -c \
  '. "${XDG_RUNTIME_DIR:-/tmp/runtime-ubuntu}/container-env"; xdpyinfo -display "$DISPLAY" >/dev/null && pgrep -f "Xvfb $DISPLAY" >/dev/null && pgrep -x lxqt-session >/dev/null && pgrep -x openbox >/dev/null' \
  && echo "session up"
docker exec -u 1000:1000 -e HOME=/home/ubuntu claude-verify \
  google-chrome --headless --disable-gpu --no-first-run --dump-dom about:blank | grep -c '<html'

# The PUID/PGID guard must refuse anything else, loudly. It exits 78; the last
# line names the only supported values.
docker run --rm --shm-size=2g -e PUID=99 -e PGID=100 -e PASSWD=x "$IMAGE:2.26454.2"
echo "exit=$?   # 78"

docker rm -f claude-verify && rm -rf verify-state
```

## 3. Roll a user back

**First, record what they are on** — the digest is what makes the rollback exact:

```bash
docker inspect --format '{{index .RepoDigests 0}}' claude-code-linux
```

**Unraid**: *Docker* → the container → *Edit* → set **Repository** to the previous build and *Apply*.
Either form works; use a digest for byte-identity:

```
ghcr.io/prv-ctech/claude-code-linux:2.26454.2
ghcr.io/prv-ctech/claude-code-linux@sha256:<digest-of-the-good-build>
```

**compose**: pin the same reference in `.env`, then recreate:

```bash
# .env
CLAUDE_IMAGE=ghcr.io/prv-ctech/claude-code-linux@sha256:<digest-of-the-good-build>
```

```bash
docker compose pull && docker compose up -d
```

**Either way**: the *AppData* path does not change, so the sign-in, the keyring and the CLI credentials
survive the rollback. Confirm the session came back healthy:

```bash
docker inspect --format '{{.State.Health.Status}}' claude-code-linux          # healthy
docker exec claude-code-linux dpkg-query -W -f='${Version}' claude-desktop    # the version you rolled back to
```

**Repository-level rollback** (when the *recipe* is wrong, not the upstream version):

```bash
git revert <release-commit>        # the next sweep rebuilds from the reverted recipe
```

or re-dispatch the older version by hand (§1 with `-f version=<older>`).

**Moving `:latest` backwards** is a deliberate, manual act — the workflow only ever moves it forward:

```bash
docker buildx imagetools create -t ghcr.io/prv-ctech/claude-code-linux:latest \
  ghcr.io/prv-ctech/claude-code-linux@sha256:<digest-of-the-good-build>
```

## 4. When the sweep goes quiet

GitHub disables a `schedule` trigger after 60 days without repository activity, which stops the upstream
sweep silently while the last image keeps working. How to notice it, and how to recover (a manual
`workflow_dispatch` both builds and resets the clock), is in
[README § GitHub pauses scheduled workflows after 60 days of inactivity](../README.md#github-pauses-scheduled-workflows-after-60-days-of-inactivity).

## 5. What has not been proven on this host

This repository was authored on a host with **no container runtime**, so `docker build`, `docker run`
and the Selkies boot have never executed *here*. CI has since executed them: all three recorded runs of
`build.yml` succeeded, including the `build` job's smoke step. Those runs' values live in the run
artifact, not in this record ([`VERIFICATION.md`](VERIFICATION.md) §8). What *was* verified on this
host, and how, is recorded in [`VERIFICATION.md`](VERIFICATION.md) — including the
workspace gate `sh scripts/selfcheck.sh`, which needs no Docker daemon and covers the image's shell
surface with command stubs.
