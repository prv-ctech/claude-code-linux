# Reference architecture report — `prv-ctech/chatgpt-linux`

**Research date:** 2026-10-08 · **Method:** web only (`api.github.com`, `raw.githubusercontent.com`)

## 0. Headline finding — the requested repo DOES NOT EXIST

| Fetch | URL | Result |
|---|---|---|
| Repo metadata | `https://api.github.com/repos/prv-ctech/chatgpt-linux` | **HTTP 404** `{"message":"Not Found"}` |
| Repo tree | `https://api.github.com/repos/prv-ctech/chatgpt-linux/git/trees/HEAD?recursive=1` | **HTTP 404** `{"message":"Not Found"}` |
| Owner metadata | `https://api.github.com/users/prv-ctech` | HTTP 200 — account exists, id `103532453`, created 2022-04-12 |

404 on a repo endpoint is indistinguishable between **private** and **nonexistent** for an unauthenticated caller. However, the owner account **is** public and enumerable, and its public repo list (fetched via `/users/prv-ctech/repos?per_page=100`, 2 repos) contains **no** `chatgpt-linux`:

| Public repo | Size | Language | Pushed | Note |
|---|---|---|---|---|
| [`prv-ctech/claude-code-linux`](https://github.com/prv-ctech/claude-code-linux) | **0 KB** | null | 2026-10-08T18:34:14Z | **Empty placeholder** — no commits, no tree. This IS the current workspace. |
| [`prv-ctech/deepseek-harness`](https://github.com/prv-ctech/deepseek-harness) | 214 KB | Dockerfile | 2026-10-05 | **The real pattern owner** — Docker + Unraid + auto-rebuild. |

GitHub repository search `q=chatgpt-linux` returns 497 results, **none** of them a `prv-ctech` repo and **none** a Docker/Selkies packaging of the ChatGPT desktop app. So `chatgpt-linux` is either private (created after the listing cache) or was never created; the sibling project it was meant to model cannot be read.

**Substitute used instead (highest-fidelity analogue):** [`prv-ctech/deepseek-harness`](https://github.com/prv-ctech/deepseek-harness) — *same owner, same intended architecture shape*: Dockerfile + `compose.yaml` + entrypoint + Unraid CA template XML + GHCR build workflow with upstream-version tracking. Every question in the brief (base image, PUID/PGID, ports, volumes, env, Actions triggers, tagging, auto-rebuild, Unraid XML fields, freshness labels) is answerable from it with **verbatim** evidence.

A second, genuinely public **Selkies + Unraid** analogue is reported in §7: [`shoyrock/Brave-Origin`](https://github.com/shoyrock/Brave-Origin).

> Every snippet below was fetched over HTTP 200 from the raw URL cited next to it. Items that could not be verified are marked **UNVERIFIED**. Nothing is paraphrased into a code block.

---

## 1. Repo tree of the substitute reference

`prv-ctech/deepseek-harness` — 17 blobs total:

```
.dockerignore
.env.example
.github/workflows/build.yml
.gitignore
Dockerfile
README.md
compose.yaml
docker-entrypoint.sh
fix/owns-host.mjs
proxy.patch.yml
scripts/published-recipe.sh
unraid/deepseek-harness.xml
```

Source: `https://api.github.com/repos/prv-ctech/deepseek-harness/git/trees/HEAD?recursive=1` (HTTP 200, `truncated:false`).

Note the absence of: `docker-compose.yml` (it is `compose.yaml`), any `supervisord.conf` (no supervisor layer — `tini` is PID 1), any multi-arch `Dockerfile.aarch64`, and any Community-Applications repository submission (the XML lives in-repo, see §5).

---

## 2. File-by-file

### 2.1 `Dockerfile` — raw: `https://raw.githubusercontent.com/prv-ctech/deepseek-harness/HEAD/Dockerfile` (HTTP 200, 14 225 B, 259 lines)

| Question | Answer (exact) |
|---|---|
| Base image | `ARG BASE_IMAGE=node:22-bookworm-slim` → `FROM ${BASE_IMAGE}`, overridden by CI to the same literal |
| Desktop/streaming layer | **NONE.** No Selkies, no KasmVNC, no webtop, no X server, no VNC. It is a **headless web app** behind a reverse proxy. |
| App install | **Official npm package**, not a `.deb`, not an Electron wrapper: `npm install --global --omit=dev "@deepseek-ai/dsh@${DSH_VERSION}" "pnpm@${PNPM_VERSION}"` |
| Version pin | `ARG DSH_VERSION=0.2.0-rc.2`, overridden by CI `--build-arg` |
| Self-check at build | `RUN test "$(dsh --version)" = "${DSH_VERSION}"` — **fails the build, not the deployment** |
| PID 1 | `tini`; `ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]` |
| Port | `EXPOSE 3080`; `CMD ["web"]` |
| PUID/PGID | `ENV PUID=1000 PGID=1000`; the entrypoint chowns then `setpriv`-drops (see §2.3) |
| Healthcheck | node one-liner accepting 200/303/401, because the base ships no curl/wget |
| Variant | `INSTALL_PLUS` build arg → separate `…-plus` package (~600–700 MB extra toolchain) |
| Labels | `org.opencontainers.image.{title,description,source,licenses,version}` + **`com.prvctech.dsh.version`** |

### 2.2 `compose.yaml` — raw: `…/HEAD/compose.yaml` (HTTP 200, 3 253 B, 66 lines)

| Item | Exact value |
|---|---|
| Image | `ghcr.io/prv-ctech/deepseek-harness:latest` (`${DSH_IMAGE:-…}`) |
| Ports | `"${DSH_BIND:-0.0.0.0}:${DSH_PORT:-3080}:3080"` |
| Volumes | `dsh-state:/home/node/.dsh` (named) + `${DSH_WORKSPACE:-./workspace}:/workspace` (bind) |
| Env | `DSH_PUBLIC_HOST` (required), `DSH_TRUSTED_HOSTS`, `PUID`, `PGID`, `DSH_PERMISSION_MODE` |
| Hardening | `read_only: true`, `tmpfs /tmp:rw,nosuid,nodev,size=256m`, `no-new-privileges`, `cap_drop: ALL` + 5 caps re-added (`CHOWN DAC_OVERRIDE FOWNER SETGID SETUID`), `pids_limit: 512` |

### 2.3 `docker-entrypoint.sh` — raw: `…/HEAD/docker-entrypoint.sh` (HTTP 200, 5 930 B, 141 lines)

- `set -eu`; `PUID`/`PGID` default `1000`; **no `useradd`/`groupmod`** — deliberately: *"Renaming its ids with usermod/groupmod needs a writable /etc, which a `--read-only` container does not have"*.
- Recursive `chown` only for the state dir, guarded by a single `find … -print -quit` probe (`needs_chown`); `/workspace` is chowned **one level only** (non-fatal warning on failure).
- `--read-only`-safe: state-dir chown failure is **fatal** (`dsh` cannot run), workspace failure is a warning.
- Drops privileges with `setpriv --reuid … --regid … --clear-groups` — comment: *"`--clear-groups`, not `--init-groups`: the latter refuses a uid that has no passwd entry ("uid 1234 not found"), which is exactly the Unraid PUID=99 case."*
- Arg-order handling: re-adds `--patch`/`--no-open`/`--trusted-host` only when the caller has not supplied them, because *"Unraid's 'Post Arguments' field REPLACES this CMD"*.

### 2.4 `.github/workflows/build.yml` — raw: `…/HEAD/.github/workflows/build.yml` (HTTP 200, 25 398 B, 497 lines)

Full analysis in §4 below. Three jobs: `plan` → `build` (matrix) → `latest`.

### 2.5 `unraid/deepseek-harness.xml` — raw: `…/HEAD/unraid/deepseek-harness.xml` (HTTP 200, 8 767 B, 51 lines)

Full analysis in §5 below.

### 2.6 `scripts/published-recipe.sh` — raw: `…/HEAD/scripts/published-recipe.sh` (HTTP 200, 2 879 B)

The freshness oracle. Reads the **OCI image config blob over the raw registry API** (curl + jq only — no `docker buildx imagetools`, no login), resolves a multi-arch index to the `linux/amd64` manifest, then prints `.config.Labels["org.opencontainers.image.dsh-recipe"]`. Exchanges a GitHub token at `/token?scope=repository:…:pull` (a raw GitHub token gets 403 from ghcr — it must be Basic-auth-exchanged).

### 2.7 `.env.example` — raw: `…/HEAD/.env.example` (HTTP 200, 1 566 B)

Documents `DSH_PUBLIC_HOST` (required), `DSH_TRUSTED_HOSTS`, `DSH_IMAGE`, `PUID`, `PGID`, `DSH_BIND`, `DSH_PORT`, `DSH_WORKSPACE`, `DSH_PERMISSION_MODE`.

### 2.8 `README.md` — raw: `…/HEAD/README.md` (HTTP 200, 22 438 B)

**UNVERIFIED in detail** — the fetch succeeded but the file was not read line-by-line for this report; only its existence and size are asserted.

---

## 3. Exact runtime facts (answers to brief item 3)

| Field | `prv-ctech/deepseek-harness` |
|---|---|
| **Base image** | `node:22-bookworm-slim` |
| **Desktop / streaming layer** | **Neither Selkies nor KasmVNC nor webtop.** No streaming layer at all — the app is an HTTP web UI on `:3080`. |
| **App install** | Official npm release `@deepseek-ai/dsh@<version>`, installed globally; upstream package untouched (*"Nothing is forked and nothing is monkey-patched, so a new upstream RC is a rebuild, not a merge"*). No `.deb`, no Electron wrapper. |
| **PUID/PGID** | Dockerfile `ENV PUID=1000 PGID=1000` (template/`.env` override to `99`/`100` for Unraid). Entrypoint starts as root **only** to `chown` the state volume, then `exec setpriv --reuid "$PUID" --regid "$PGID" --clear-groups …`. `--user` runs are supported (ownership step skipped, with an actionable error if the state dir is unwritable). |
| **Exposed ports** | `3080/tcp` (single). Unraid publishes `3080`; TURN-style extra ports: none. |
| **Volumes** | `/home/node/.dsh` (state: settings, credentials, sessions, plugin installs) and `/workspace` (agent sandbox root). |
| **Env vars** | `DSH_VERSION`, `DSH_HOME`, `HOME`, `SHELL`, `PNPM_HOME`, `PUID`, `PGID`, `PIP_BREAK_SYSTEM_PACKAGES`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `NARB_NATIVE_CACHE_DIR`, `CBM_CACHE_DIR`; runtime-only `DSH_PUBLIC_HOST`, `DSH_TRUSTED_HOSTS`, `DSH_PERMISSION_MODE`, `DSH_WORKSPACE_DIR`, `DEEPSEEK_API_KEY`. |

**Why the cache vars matter for a sibling project:** `NARB_NATIVE_CACHE_DIR` is documented as load-bearing — *"on a `--tmpfs /tmp:noexec` container … that dlopen fails … and dsh never boots"*.

---

## 4. GitHub Actions architecture (brief item 4)

### Triggers

```yaml
on:
  schedule:
    # Scan, not build: a 6-hourly sweep puts a new upstream RC within a working
    # day and costs nothing when there is nothing to do.
    - cron: '23 */6 * * *'
  push:
    branches: [main]
    paths:
      - Dockerfile
      - docker-entrypoint.sh
      - proxy.patch.yml
      - fix/**
      - scripts/**
      - .github/workflows/build.yml
  workflow_dispatch:
    inputs:
      version:
        description: 'Exact version to build (default: every tracked version missing an image)'
        required: false
        type: string
      rebuild:
        description: 'Rebuild even when the image already carries this recipe'
        required: false
        type: boolean
        default: false
```

- **No `repository_dispatch`.** The mechanism is a **cron sweep + an idempotent plan job**.
- `permissions: contents: read` + `packages: write`.
- Registry: **GHCR only** (`ghcr.io/${{ github.repository }}` and `…-plus`). No Docker Hub.

### Multi-arch

**amd64 only**, deliberately:

```yaml
      # amd64 only. GHCR is not behind Cloudflare, so the chunked-push workaround
      # a Cloudflare-fronted registry needs is unnecessary here, and arm64 would
      # mean emulated builds for a target nobody has asked for.
      - uses: docker/setup-buildx-action@v4
```
```yaml
          platforms: linux/amd64
          load: true
```
`buildx` is used, but for `load: true` + cache, **not** for a multi-platform push. There is **no** `platforms: linux/amd64,linux/arm64` anywhere. **UNVERIFIED claim of multi-arch buildx** — the reference does not do it.

### The NEW-UPSTREAM-VERSION detector (the critical mechanism)

Step `Plan versions to build` in job `plan`. Verbatim core:

```yaml
          # Upstream release candidates, oldest first, read from the releases
          # of deepseek-ai/deepseek-harness (`dsh-v<version>` tags). `sort -V`
          # orders 0.2.0-rc.2 < 0.2.0-rc.10 correctly, which a string compare
          # does not.
          all=$(curl -fsSL -H "Authorization: Bearer $TOKEN" \
              "https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=100" \
            | jq -r '.[].tag_name | select(startswith("dsh-v")) | ltrimstr("dsh-v")' \
            | sort -V)
          at_least() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }
          candidates=$(printf '%s\n' "$all" | grep -E -- '-rc\.[0-9]+$' | while read -r v; do
            at_least "$v" "$MIN_VERSION" && echo "$v"
          done)
```

**Buildability gate — the release must also exist on npm**, because the image installs from npm:

```yaml
          # The image installs @deepseek-ai/dsh@<version> from npm, so a release
          # that is not published there yet cannot be built: skip it and let a
          # later sweep pick it up. Skipped loudly, to stderr — stdout is the
          # candidate list.
          candidates=$(printf '%s\n' "$candidates" | while read -r v; do
            [ -n "$v" ] || continue
            code=$(curl -sS -o /dev/null -w '%{http_code}' \
              "https://registry.npmjs.org/@deepseek-ai/dsh/$v" || true)
            if [ "$code" = "200" ]; then
              echo "$v"
            else
              echo "::notice::$v is released upstream but not on npm yet; skipping" >&2
            fi
          done)
```

**The idempotency key is a content hash of the recipe, stamped as an image label and read back out of the registry** — this makes a *code* change rebuild already-published versions:

```yaml
      - name: Compute recipe hash
        id: recipe
        run: |
          files='Dockerfile docker-entrypoint.sh proxy.patch.yml fix/owns-host.mjs'
          # shellcheck disable=SC2086
          echo "base=$(cat $files | sha256sum | cut -c1-12)" >> "$GITHUB_OUTPUT"
          echo "plus=$( { cat $files; echo plus; } | sha256sum | cut -c1-12)" >> "$GITHUB_OUTPUT"
```
```yaml
            for v in $candidates; do
              reason=""
              if ! published=$(./scripts/published-recipe.sh "$REGISTRY" "$repository" "$v" "$TOKEN" 2>/dev/null); then
                reason="missing"
              elif [ "$published" != "$recipe" ]; then
                reason="recipe-changed"
              fi
              if [ -z "$reason" ] && [ "${REBUILD:-false}" = "true" ]; then
                reason="requested"
              fi
              if [ -n "$reason" ]; then
                echo "$repository:$v -> build ($reason)"
                entries=$(printf '%s' "$entries" | jq -c \
                  --arg v "$v" --arg r "$recipe" --arg repo "$repository" \
                  --argjson plus "$plus" \
                  '. + [{version:$v, recipe:$r, repository:$repo, plus:$plus}]')
              else
                echo "$repository:$v -> up to date"
              fi
            done
```

The label is stamped in the build step:

```yaml
          labels: |
            org.opencontainers.image.revision=${{ github.sha }}
            org.opencontainers.image.dsh-recipe=${{ matrix.recipe }}
```

Stated net effect, verbatim: *"A container on `:latest` therefore updates only when upstream ships a newer RC or the recipe here changes, never on a timer."*

### Tagging scheme

| Tag | Meaning |
|---|---|
| `:<version>` (e.g. `0.2.0-rc.2`) | Immutable per-release tag, same build as `:latest` pointed at |
| `:latest` | **Moved by manifest copy, never rebuilt** — `docker buildx imagetools create -t "$repository:latest" "$repository:$NEWEST"` |
| `ghcr.io/prv-ctech/deepseek-harness-plus:<same tags>` | Lockstep variant |
| date tag | **ABSENT** — no `:YYYYMMDD` tagging exists |

`:latest` is moved only to a digest that already passed the smoke test:

```yaml
      # Move :latest by copying a manifest, so it always resolves to a digest
      # that already passed the smoke test above. The target is the newest
      # tracked version, which exists by now either because this run built it or
      # because it was already up to date — the matrix alone would be wrong,
      # since it lists only what needed building.
```
```yaml
            if ! source_digest=$(docker buildx imagetools inspect "$repository:$NEWEST" \
                 --format '{{.Manifest.Digest}}' 2>/dev/null) || [ -z "$source_digest" ]; then
              unchanged+=("$repository")
              echo "::warning::$repository:$NEWEST was not published, so its :latest is unchanged"
              continue
            fi
```
```yaml
            echo "$repository:latest -> $NEWEST ($source_digest)"
            docker buildx imagetools create -t "$repository:latest" "$repository:$NEWEST"
```

### Gate-before-publish

Images are built with `load: true` and pushed only after an in-runner smoke test (`docker inspect … .State.Health.Status` == `healthy`, `dsh --version` equals the matrix version, `/proc/1` uid 0 while the `dsh web` process uid is 1000, HTTP `200|303|401`). Push is attempted, then retried once on failure with `continue-on-error` + `steps.push.outcome == 'failure'` because of a first-publication race: `denied: permission_denied: write_package`.

---

## 5. Unraid side (brief item 5)

**Yes — a Community-Applications-compatible template XML, kept in-repo** at `unraid/deepseek-harness.xml`. It is not in a separate `docker-templates` repo. `TemplateURL` is empty (`<TemplateURL/>`); a working CA template normally needs a hosted raw URL — [Brave-Origin does exactly that](#7-genuinely-public-analogues) via `<TemplateURL>https://raw.githubusercontent.com/…/templates/brave-origin.xml</TemplateURL>`.

Schema fields actually used (all verbatim from the fetched XML):

```xml
<?xml version="1.0"?>
<Container version="2">
  <Name>deepseek-harness</Name>
  <Repository>ghcr.io/prv-ctech/deepseek-harness:latest</Repository>
  <Registry>https://github.com/prv-ctech/deepseek-harness/pkgs/container/deepseek-harness</Registry>
  <Network>bridge</Network>
  <Shell>sh</Shell>
  <Privileged>false</Privileged>
  <Project>https://github.com/prv-ctech/deepseek-harness</Project>
  <Support>https://github.com/prv-ctech/deepseek-harness/issues</Support>
  <Category>AI: Tools:</Category>
  <WebUI>http://[IP]:[PORT:3080]</WebUI>
  <TemplateURL/>
  <Icon>https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/dsh-v0.2.0-rc.2/apps/desktop/resources/icon.png</Icon>
  <ExtraParams/>
  <PostArgs>web</PostArgs>
```

| Brief item | Finding |
|---|---|
| `<Network>` | `bridge` |
| `<Privileged>` | `false` |
| PUID/PGID entries | Present, `Display="advanced"`, `Type="Variable"`, Unraid defaults `99` / `100` |
| Port entry | `<Config Name="WebUI Port" Target="3080" … Type="Port" …>3080</Config>` |
| Path entries | `Appdata` → `/home/node/.dsh` = `/mnt/user/appdata/deepseek-harness`; `Workspace` → `/workspace` |
| `<Date>` | **ABSENT.** Freshness is not surfaced through a template date. |
| Docker labels for freshness | **`net.unraid.docker.managed` / `net.unraid.docker.icon`: ABSENT** — the template relies on `<Icon>` only. |
| Custom freshness label | `com.prvctech.dsh.version` in the Dockerfile signature + `org.opencontainers.image.dsh-recipe` for the rebuild gate. |
| `<ExtraParams>` | empty in this template (Brave-Origin uses it for `--security-opt seccomp=unconfined --shm-size=1g --pids-limit 2048`) |

The template's `<Overview>` is where operational truth is surfaced to the user, including a **PRIVATE IMAGE** warning requiring `docker login ghcr.io -u prv-ctech` with a PAT (so the GHCR package is private despite the repo being public), a note that the launch token **rotates on every restart**, and: *"VERSIONS: `:latest` follows the newest upstream release candidate … Every version we ship also gets its own tag (e.g. 0.2.0-rc.2) which you can pin in Repository instead."*

---

## 6. EXACT YAML/SNIPPETS

All blocks in §2–§5 above are verbatim. Consolidated provenance table:

| Snippet | Raw URL | HTTP |
|---|---|---|
| Dockerfile (all) | `https://raw.githubusercontent.com/prv-ctech/deepseek-harness/HEAD/Dockerfile` | 200 |
| compose.yaml (all) | `https://raw.githubusercontent.com/prv-ctech/deepseek-harness/HEAD/compose.yaml` | 200 |
| docker-entrypoint.sh (all) | `https://raw.githubusercontent.com/prv-ctech/deepseek-harness/HEAD/docker-entrypoint.sh` | 200 |
| build.yml (all) | `https://raw.githubusercontent.com/prv-ctech/deepseek-harness/HEAD/.github/workflows/build.yml` | 200 |
| unraid XML (all) | `https://raw.githubusercontent.com/prv-ctech/deepseek-harness/HEAD/unraid/deepseek-harness.xml` | 200 |
| published-recipe.sh | `https://raw.githubusercontent.com/prv-ctech/deepseek-harness/HEAD/scripts/published-recipe.sh` | 200 |
| .env.example | `https://raw.githubusercontent.com/prv-ctech/deepseek-harness/HEAD/.env.example` | 200 |
| proxy.patch.yml | `https://raw.githubusercontent.com/prv-ctech/deepseek-harness/HEAD/proxy.patch.yml` | 200 |
| Brave-Origin template | `https://raw.githubusercontent.com/shoyrock/Brave-Origin/HEAD/templates/brave-origin.xml` | 200 |
| Brave-Origin workflow | `https://raw.githubusercontent.com/shoyrock/Brave-Origin/HEAD/.forgejo/workflows/docker-build.yml` | 200 |
| Brave-Origin compose | `https://raw.githubusercontent.com/shoyrock/Brave-Origin/HEAD/compose.yaml` | 200 |
| Brave-Origin Dockerfile | `https://raw.githubusercontent.com/shoyrock/Brave-Origin/HEAD/Dockerfile` | 200 |
| selkies egl-desktop Dockerfile head | `https://raw.githubusercontent.com/selkies-project/docker-selkies-egl-desktop/HEAD/Dockerfile` | 200 |
| selkies egl-desktop compose | `https://raw.githubusercontent.com/selkies-project/docker-selkies-egl-desktop/HEAD/docker-compose.yml` | 200 |
| linuxserver webtop Dockerfile head | `https://raw.githubusercontent.com/linuxserver/docker-webtop/HEAD/Dockerfile` | 200 |
| jdownloader repo-watch | `https://raw.githubusercontent.com/junkerderprovinz/jdownloader/HEAD/.github/workflows/repo-watch-instant.yml` | 200 |

---

## 7. Genuinely public analogues

### 7a. `shoyrock/Brave-Origin` — **closest true Selkies + Unraid reference**
<https://github.com/shoyrock/Brave-Origin> · 55 blobs · has `templates/brave-origin.xml`, `compose.yaml`, `compose.gpu.yaml`, `entrypoint.sh`, `patches/*.patch`, `scripts/smoke-test.sh`, `scripts/security-scan.py`

- **Base:** multi-stage. `FROM ghcr.io/linuxserver/baseimage-selkies:debiantrixie@sha256:7f4f69e5…` (pinned digest) as `selkies-upstream`; `FROM debian:trixie-slim` for the runtime; `node:22-trixie-slim` to **build patched Selkies from a pinned commit** `selkies-project/selkies/tar.gz/92dea42fc70bfcb52e6d98c4e6854872badfe621`.
- **Streaming layer:** **Selkies**, self-built and patched (4 patches: Wayland fixes, clipboard send button, native clipboard paste, audio restart timestamps), plus a from-source `labwc` compositor stage. KasmVNC appears only as a **legacy alias** in env names (`KASM_AUTH_ENABLED`, `KASM_USER`, `KASM_PASSWORD`) and in `<ExtraSearchTerms>… kasmvnc …`. The sibling repo [`junkerderprovinz/jdownloader`](https://github.com/junkerderprovinz/jdownloader) is the s6-overlay-flavoured version of the same recipe.
- **Port:** `EXPOSE 8443` (HTTPS served in-container; `WEB_PORT` selects only the host side). `shm_size: "1gb"`, `--security-opt seccomp=unconfined`.
- **PUID/PGID:** env, defaults `1000`, Unraid `99`/`100`; `UMASK=022`.
- **Unraid template:** full CA schema — `<TemplateURL>` (hosted raw URL — required for a real CA listing), `<ReadMe>`, `<Date>2026-09-10</Date>`, `<MinVer>6.9</MinVer>`, `<License>MIT</License>`, `<Category>Productivity: Tools:Utilities</Category>`, `<ExtraSearchTerms>`, `<Privileged>false</Privileged>`, and a `<Branch><Tag>beta</Tag>…` block.
- **CI:** **Forgejo Actions** (`.forgejo/workflows/docker-build.yml`), not GitHub Actions — validate → audit deps → `docker build --pull --no-cache` → `smoke-test.sh` → `security-scan.py` → publish to **two registries** (`REGISTRY_IMAGE` + GHCR). Triggers: push to `main`/`beta`, `tags: ['v*']`, PRs, `workflow_dispatch`. `if: github.event_name != 'pull_request'` guards the publishing job.
- **Upstream freshness:** *runtime* auto-update, not CI rebuild — `AUTO_UPDATE=true`, `UPDATE_INTERVAL=21600`, `scripts/update-brave.sh`, plus `tests/update.py`. The image is built from Brave's **official apt repository** (`brave-browser-apt-release.s3.brave.com`), not a `.deb` URL.

### 7b. `selkies-project/docker-selkies-egl-desktop` — canonical Selkies/WebRTC base
<https://github.com/selkies-project/docker-selkies-egl-desktop> · 22 blobs

- **Base:** `ARG BASE_IMAGE="ghcr.io/selkies-project/selkies/base:latest-ubuntu26.04"`; Ubuntu **26.04 only**, because kwin is rebuilt from archive source with `patches/kwin-nested-virtual-output.patch` and `patches/kwin-x11/kwin-x11-randr-monitors.patch`.
- **Streaming:** Selkies itself — Xvfb X11 framebuffer by default, nested `kwin_wayland` when `SELKIES_WAYLAND=true`. GPU via EGL/DRI3, no X.Org of its own.
- **Ports:** `8080:8080`; optional TURN `3478`, `65532-65535` (tcp+udp). `shm_size: '2gb'` (browsers crash on Docker's 64 MB default).
- **Key env:** `PASSWD`, `SELKIES_MODE` (websocket default / `webrtc`), `SELKIES_WAYLAND`, `SELKIES_ENABLE_BASIC_AUTH`, `SELKIES_ENABLE_HTTPS`, `SELKIES_TURN_*`, `DISPLAY_SIZEW/H`.
- **CI:** `.github/workflows/container-publish.yml` — **UNVERIFIED in detail** (tree confirms the file; content not fetched).
- **No Unraid template**, no PUID/PGID (single `ubuntu` user + `PASSWD`).

### 7c. `linuxserver/docker-webtop` — the LinuxServer PUID/PGID + selkies lineage
<https://github.com/linuxserver/docker-webtop> · 40 blobs

- **Base:** `FROM ghcr.io/linuxserver/baseimage-selkies:alpine324` — i.e. the **selkies** streaming layer, wrapped in LinuxServer's baseimage conventions.
- Separate `Dockerfile.aarch64` — the **real** multi-arch pattern in this space (a distinct arch Dockerfile, published through LinuxServer's Jenkins/CI), unlike the GHCR single-arch reference.
- Root tree is LinuxServer-style: `root/defaults/startwm.sh`, `root/defaults/startwm_wayland.sh`, `root/defaults/xfce/*.xml`, `readme-vars.yml`, `jenkins-vars.yml`, `package_versions.txt`.
- **CI:** `.github/workflows/external_trigger.yml` + `external_trigger_scheduler.yml` + `package_trigger_scheduler.yml`, plus a `Jenkinsfile` — LinuxServer's own runner, not GHCR buildx. **UNVERIFIED in detail** (contents not fetched).

### 7d. Others that match "new upstream version → automatic rebuild" more richly
- [`junkerderprovinz/jdownloader`](https://github.com/junkerderprovinz/jdownloader) — 583 blobs; s6-overlay services (`rootfs/etc/s6-overlay/s6-rc.d/init-selkies-config`, `svc-de`, `svc-xorg`), a `justfile`, `renovate.json`, and workflows `build.yml`, `release.yml`, `repo-watch-instant.yml`, `registry-cleanup.yml`, `lint.yml`, `style.yml`, `geometry-probe.yml`, `experiment-headless.yml`, `.github/release-notes/v4.8.0.md`. **`repository_dispatch` appears here**, but for issue/PR notification via a shared `repo-watch` dispatcher — *not* for upstream version detection.
- [`Joly0/pinokio-docker`](https://github.com/Joly0/pinokio-docker) — LinuxServer-derived (`readme-vars.yml`, `root/defaults/autostart`, `BUILD_NUMBER`) with **both** `.github/workflows/docker-build.yml` **and** `.github/workflows/scheduled-builds.yml` — a scheduled rebuild trigger closest to a nightly "pick up upstream changes" pattern. **UNVERIFIED in detail.**

### 7e. Named-but-not-matching
- [`pratik-desgn/chatgpt-linux`](https://github.com/pratik-desgn/chatgpt-linux) — the only public `chatgpt-linux`, an *"unofficial hardening and finishing fork layered over `ilysenko/codex-desktop-linux`"*. 850 blobs, **Cargo/Rust + Electron + `.deb`/RPM/pacman/AppImage packaging, a Nix flake, and `.devcontainer/Dockerfile` — but no Docker image, no Selkies, no Unraid template.** Its `.github/workflows/` holds `ci.yml`, `updater.yml`, `update-chatgpt-hash.yml`, etc., where auto-update means *refreshing a Nix DMG hash*, not rebuilding a container. Useful as a *native-packaging* reference, not a container reference.
- `anthropics/claude-code` devcontainer — not fetched; **UNVERIFIED**.

---

## 8. What a sibling project should copy (pattern summary)

1. `Dockerfile` with `ARG BASE_IMAGE` + `ARG APP_VERSION`, install the **official upstream package**, and `RUN test "$(app --version)" = "$APP_VERSION"` so a bad publish fails the build.
2. `compose.yaml` (not `docker-compose.yml`) with **every** host-specific value as `${VAR:-default}` and a gitignored `.env`; named volume for state, bind for user data.
3. `docker-entrypoint.sh` that starts as root **only** to `chown` state, then `setpriv --reuid --regid --clear-groups` to `PUID:PGID`; never `usermod`; make `--read-only` work.
4. `unraid/<name>.xml` with `<Container version="2">`, `Repository`/`Registry`/`Network=bridge`/`Privileged=false`, `Type="Port"`, `Type="Path"` ×2, `Type="Variable"` entries for `PUID`/`PGID` (defaults `99`/`100`), and a hosted `<TemplateURL>` for real CA listing.
5. `.github/workflows/build.yml` with `plan`/`build`/`latest`; `cron` sweep (not `repository_dispatch`) querying upstream releases, `sort -V`, a `MIN_VERSION` floor, and a **recipe-hash label read back from the registry** so both new upstream versions *and* local Dockerfile fixes trigger exactly-once rebuilds.
6. Publish per-version tag + buildability-gated `:latest` moved by `imagetools create` from a smoke-tested digest; never rebuild `:latest`.

Skipped: fetching the substitute's `README.md`, `proxy.patch.yml`, `fix/owns-host.mjs` bodies, and the analogue CI YAMLs beyond Brave-Origin; add when the sibling needs wording or patch-layer specifics rather than structure.

**Unverified items in this report:** private-vs-nonexistent status of `prv-ctech/chatgpt-linux`; `prv-ctech/deepseek-harness` README body; `selkies-project/docker-selkies-egl-desktop` publish workflow; `linuxserver/docker-webtop` CI internals; `Joly0/pinokio-docker` `scheduled-builds.yml`; `anthropics/claude-code` devcontainer existence/shape.
