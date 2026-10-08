# claude-code-linux

The official **Claude Desktop for Linux** (Anthropic's apt `.deb`) plus the **Claude Code CLI**,
running as a full Chrome/LXQt desktop inside a container and streamed to your browser with
[Selkies](https://github.com/selkies-project/selkies). Built for Unraid Community Applications,
also usable via `docker compose`.

Nothing is installed on the client. Open the WebUI, sign in to Claude Desktop once, and the sign-in
survives every container update because it lives in the mounted state directory.

- Binding engineering contract: [`docs/DESIGN.md`](docs/DESIGN.md) (decisions D1–D12, risk register R1–R9).
- Unraid template: [`unraid/claude-code-linux.xml`](unraid/claude-code-linux.xml).
- Compose for non-Unraid hosts: [`compose.yaml`](compose.yaml) with [`/.env.example`](.env.example).
- Release, verification and rollback procedure: [`docs/RELEASE.md`](docs/RELEASE.md).
- Unraid first-run handoff, with what to send back when something fails:
  [`docs/UNRAID-TEST.md`](docs/UNRAID-TEST.md).

> **The GHCR package is private while the redistribution and licensing review is open** (the image
> contains a proprietary Anthropic package — see [Licensing](#licensing)). Anonymous pulls fail with
> `denied`. Authenticate first:
>
> ```bash
> docker login ghcr.io -u YOUR-GITHUB-USERNAME   # password: a PAT with read:packages
> ```
>
> It will be made public only after that review closes; this README will say so when it happens.

## Quick start

### Unraid

1. `docker login ghcr.io -u YOUR-GITHUB-USERNAME` in the Unraid terminal (PAT with `read:packages`).
2. Community Applications → *claude-code-linux* (or add the template manually from
   [`unraid/claude-code-linux.xml`](unraid/claude-code-linux.xml)).
3. Set **PASSWD** (required, no default). Leave **PUID** and **PGID** at `1000`.
4. Apply, then open the WebUI on port `8080` (the certificate is self-signed, so the browser warns).

### Docker Compose

```bash
cp .env.example .env      # CLAUDE_PASSWORD is required; compose fails closed without it
docker compose up -d
docker compose logs -f
```

Host port `8080` is published; state lands in `./claude-code-state` by default. Both files encode the
same port, `/dev/shm` size, PUID/PGID defaults and state path as the Unraid template, so the two
cannot drift.

## First run

1. **Open the session.** Browse to `https://<server>:8080` (the Unraid template's *WebUI* button does
   exactly this). The in-container certificate is self-signed, so accept the browser warning.
2. **Log in to the streamed desktop.** User name `ubuntu`, password is the `PASSWD` you set (for compose,
   `CLAUDE_PASSWORD`). That login is the only gate in front of the desktop.
3. **Sign in to Claude.** The session autostarts the secret service and then Claude Desktop; the app's
   sign-in page opens in the session's **Google Chrome**, which is the desktop's default browser on
   purpose ([`rootfs/etc/xdg/mimeapps.list`](rootfs/etc/xdg/mimeapps.list)). Sign in with your Anthropic
   account.
4. **Or use the CLI.** A terminal inside the session has `claude` on `PATH` — the same Claude Code pin the
   image ships — and it is the documented fallback where Cowork is unavailable.

Start the container with `CLAUDE_DESKTOP_AUTOSTART=false` for a session without the Claude window at
start-up; the *Claude* entry in the LXQt menu opens it on demand either way.

### Where state lives

Everything that has to survive an update is a single mount, `/home/ubuntu`:

| Host | Value |
|---|---|
| Unraid | `/mnt/user/appdata/claude-code-linux` (the template's *AppData* path) |
| compose | `./claude-code-state` (`CLAUDE_STATE` in `.env`) |

It holds the Chrome profile, the gnome-keyring that stores the claude.ai sign-in, the Claude Desktop
configuration and `~/.claude/.credentials.json` for the CLI. That is why an update or a recreate never
asks you to sign in again — and why it is worth backing up, keeping at uid 1000, and never pointing at
`/config` (Unraid rewrites that mount target to its own app config path).

## PUID / PGID: 1000/1000 only

`PUID=1000` and `PGID=1000` are the **only** supported values. The Selkies desktop layer is rootless
by design at uid 1000 (`/home/ubuntu`, the build-time `fakeroot` package database and the root-owned
setuid bracket all assume that id), and **no remap path exists**: any other value is rejected at
start with exit status `78` and an actionable message. Unraid's own default is `99`/`100`; this
project deliberately defaults to `1000`/`1000`, which is the natively supported mapping.

**Unraid creates the appdata directory as `nobody:users` (99:100) before the container starts**, while
the session runs as uid 1000. The container's root bootstrap re-chowns `/home/ubuntu` on every start,
so the stock flow works with no user action. If a start still reports a write or permission error:

```bash
chown -R 1000:1000 /mnt/user/appdata/claude-code-linux
```

## `/dev/shm` is 2 GB on purpose

Docker's default `/dev/shm` is 64 MB, and the browsers in this desktop are killed on it. The Unraid
template sets `--shm-size=2g` in `ExtraParams` (there is no `Config Type` for it) and `compose.yaml`
sets `shm_size: 2gb`. This is required, not tuning.

## Ports and exposure

`8080/tcp` is the only port the image serves. Selkies' default `SELKIES_MODE=websocket` needs no other
port; WebRTC mode would additionally need TURN `3478/tcp+udp` and `65532-65535`, which neither the
template nor compose publishes. **Do not expose 8080 to the Internet**: the streamed session holds
your claude.ai and Claude Code credentials, TLS is a self-signed certificate, and the desktop login
(`ubuntu` + your `PASSWD`) is the only gate in front of it. Put a reverse proxy with real TLS in front
if you need remote access.

## Cowork (QEMU/KVM) is unsupported

Anthropic's Cowork runs tasks inside a virtual machine hosted by the desktop app; it needs hardware
virtualization, `/dev/kvm` **and** `/dev/vhost-vsock` (openable only by members of the `kvm` group).
Anthropic's own documentation calls the missing-`vhost-vsock` case common in container-based
environments, and this template grants no devices, so the Cowork tab reports its requirement instead
of half-failing. The **pinned Claude Code CLI ships in the same image** and is the documented
fallback: it needs no virtualization.

If you want to try KVM anyway, the template's comments show the optional device passthrough, and
`compose.yaml` carries the equivalent commented `devices:` and `group_add:` entries. Nothing about
that configuration is supported.

## Limitations

| Limitation | Why, and what to do instead |
|---|---|
| **amd64 only — no `arm64` image** | Both apps publish arm64 builds, but this project builds `linux/amd64` only (DESIGN D11): publishing a second architecture nobody asked for, plus the emulated builds it needs. There is no `Dockerfile.aarch64` and CI produces no multi-arch index, so an ARM host cannot run it. |
| **Computer Use is unavailable** | It is a macOS/Windows feature — Anthropic's Linux desktop notes state it "isn't available on Linux". No image change can add it; use the bundled Claude Code CLI for automation. |
| **Cowork needs KVM** | [`/dev/kvm` plus `/dev/vhost-vsock` and the host `kvm` group](#cowork-qemukvm-is-unsupported), which the template deliberately does not grant. The CLI in the same image is the fallback. |
| **The Unraid icon is a generated placeholder tile** | `unraid/icon.png` is a 256×256 RGBA mark generated for this repository — not a flat colour block — because Community Applications requires an icon URL and no designed tile exists yet. Replacing that one file is the whole change when a designed tile arrives. |
| **Self-signed TLS on `8080`** | Inherited from the Selkies base image. Put a reverse proxy with real TLS in front for anything beyond your LAN; never expose `8080` itself. |

## Tags and how an update reaches you

| Tag | Meaning |
|---|---|
| `:latest` | Moving. What the Unraid template and `compose.yaml` reference. Re-pointed by CI to a digest that already passed the smoke test; never rebuilt. |
| `:<claude-desktop-version>` (e.g. `2.26454.2`) | Precision tag for the newest build of that desktop version. Re-pointed when the CLI pin or the recipe changes, so it is **not** byte-immutable. |
| `:<claude-desktop-version>-ubuntu26.04` | Same build, distribution flavor suffix taken from the base image tag. |

Because a version tag can be re-pointed, the immutable handle is the **digest** (`image@sha256:…`).
Publishing a version by hand, verifying a published image and rolling a user back — all with exact
commands — are in [`docs/RELEASE.md`](docs/RELEASE.md).

### The version this release targets

The numbers the first release is built from, re-resolved from upstream on 2026-10-08:

| Component | Version | Where it comes from |
|---|---|---|
| Claude Desktop | `2.26454.2` · `SHA256 b251a0224a8635874f33598df8ed8952b427f84815ee59580cc022d6bdb2430f` | the `Version`/`SHA256` of that one stanza in Anthropic's amd64 `Packages` index |
| Claude Code CLI | `2.1.294` | `dist-tags.latest` of `@anthropic-ai/claude-code` (npm) |
| Base image | `ghcr.io/selkies-project/selkies/desktop:2.0.0-ubuntu26.04` | the workflow's `BASE_IMAGE`, and the source of the `-ubuntu26.04` tag suffix |

The Unraid template and `compose.yaml` both pull `ghcr.io/prv-ctech/claude-code-linux:latest`, which
resolves to the newest build of that pair; the precision tags are derived from it. The pins above are the
upstream ones as resolved and verified (index stanza plus a ranged GET of the `.deb`), and CI has since
built them: all three recorded runs of `build.yml` succeeded, so the image has been built, booted and
smoke-tested, and the `:latest` manifest is readable from GHCR anonymously. What that does and does not
prove is recorded, with the exact API responses, in
[`docs/VERIFICATION.md`](docs/VERIFICATION.md) §8.

The container **never self-updates**. Anthropic's apt repository is not registered inside the image
(`CLAUDE_DESKTOP_ADD_REPO=false`) and the CLI updater is disabled (`DISABLE_AUTOUPDATER=1`,
`DISABLE_UPDATES=1`), so the version on screen is exactly the version that was built. **The image
rebuild is the update path.**

### The two version signals

| Tracked upstream | Signal | Why exactly this |
|---|---|---|
| Claude **Desktop** | maximum `Version` in `https://downloads.claude.ai/claude-desktop/apt/stable/dists/stable/main/binary-amd64/Packages`, with the `SHA256` from the **same stanza**, ordered by `sort -V` | The app is closed-source, apt-only, and **does not self-update on Linux**: apt is the only version signal. `sort -V` is mandatory because the index's scheme moved from `1.x` to `2.x` and it is append-only. |
| Claude **Code CLI** | `dist-tags.latest` of the npm packument `https://registry.npmjs.org/@anthropic-ai/claude-code` | `dist-tags.next` is **ahead** of `latest` (at authoring time `next` was `2.1.295` while `latest` was `2.1.294`), so a max scan over `versions[]` would publish an unreleased-next build as if it were stable. `https://github.com/anthropics/claude-code` is the **CLI** repository, not the desktop channel; its `releases/latest` is used only as a corroborating log line, never as the source of truth. |

`scripts/latest-upstream-version.sh` implements the desktop signal and can be run locally; it prints
the version, or `--json`/`--candidates` for the full stanza data.

### How Unraid learns about a new build

Unraid **compares the registry manifest digest of the tag the user installed** with the local
`RepoDigests`. It does **not** use the template's `<Date>` element, which the CA field reference calls
legacy. That is exactly why the template points at the moving `:latest` while precision tags are also
published: when CI pushes a new digest to `:latest`, Unraid shows **"update ready"** and recreates the
container from its stored template with the same Config values. The bind-mounted `/home/ubuntu` path
is what carries your sign-in, keyring and CLI credentials across that recreation — so no re-login.

### When a rebuild happens

`.github/workflows/build.yml` runs three jobs — `plan` → `build` → `latest`:

1. **`plan`** resolves both upstream signals, computes the **recipe hash**, and decides whether there is
   anything to do. It triggers on a 6-hourly cron sweep, on pushes to recipe paths, and on
   `workflow_dispatch` with `version` and `rebuild` inputs. The `.deb` of the candidate version is
   probed with a **ranged GET of a single byte** (nothing is downloaded, and unlike `HEAD` it is not
   defeated by a bucket that answers `403`/`405` to `HEAD`; `200` and `206` both mean "it is there")
   before it is accepted, so a version Anthropic has listed but not yet uploaded is skipped loudly
   instead of failing the image; a version below the `MIN_VERSION` floor is never considered.
2. **`build`** builds `linux/amd64` with `load: true` and **smoke-tests before pushing**: the health
   status must be `healthy`, `dpkg-query -W claude-desktop` must equal the planned version,
   `claude --version` must equal the CLI pin **when run as the session identity** (`docker exec -u
   1000:1000 -e HOME=/home/ubuntu`, not as root), pid 1 must be root while the session identity is
   `1000:1000`, `https://localhost:8080/api/health` must answer `200`, the streamed session must really
   be up (display read from the base's own environment file, with Xvfb, `lxqt-session` and `openbox` all
   running as uid 1000), `google-chrome --version` must execute as uid 1000, match the version dpkg
   recorded for the single installed `google-chrome*` package, and a bounded `--headless --dump-dom` run
   must produce DOM — and `PUID=99` must exit `78`
   with the documented message. Only then are `:<version>` and `:<version>-<flavor>` pushed, with one
   retry for GHCR's first-publication race (`denied: permission_denied: write_package`).
3. **`latest`** moves `:latest` with `docker buildx imagetools create --prefer-index=false` from the
   digest that just passed the smoke test, then asserts that `:latest` resolves to exactly that digest
   (the copy is skipped when it already resolves there). `--prefer-index=false` is what makes the
   assertion meaningful: it writes the source manifest bytes through instead of re-wrapping them in a
   fresh index. **`:latest` is never rebuilt.**

**A timer alone never rebuilds.** The recipe hash covers everything the image build consumes: the
Dockerfile, `.dockerignore`, `docker-entrypoint.sh`, every `COPY` source of the Dockerfile (the
`scripts/install-claude-desktop.sh` installer and the whole `rootfs` tree), `compose.yaml`, the Unraid
packaging (`unraid/**` — template and icon), **this workflow file**, a `RECIPE_SCHEMA` constant and the
CLI pin — plus the **Claude Desktop version it is computed for**. The list is *derived*, not
hand-maintained: [`scripts/recipe-inputs.sh`](scripts/recipe-inputs.sh) reads the Dockerfile's own
`COPY` lines and prints it, and the `plan` job hashes exactly that output, so a new `COPY` source joins
the hash with no other edit and no build input can silently fall out of it. The workflow's `push` filter
covers that set — `Dockerfile`, `.dockerignore`, `docker-entrypoint.sh`, `rootfs/**`, `compose.yaml`,
`unraid/**`, `scripts/**` (which also covers the sweep tooling) and `.github/workflows/build.yml` — so
every edit that moves the hash also starts a run, while an edit elsewhere (the docs, this README,
`.env.example`) starts nothing. The desktop version is mixed in per candidate rather than taken from the
tip of the index: the hash a published `:<version>` image
carries is the hash of *that* version plus the rest of the recipe, so a stanza Anthropic lists but has
not uploaded yet cannot change the hash while the built image is unchanged. It is stamped on the image
as `org.opencontainers.image.claude-code-linux-recipe` (mirrored on `com.prvctech.claude-recipe`) and
read back out of GHCR over the raw registry API by
[`scripts/published-recipe.sh`](scripts/published-recipe.sh) with nothing but `curl` and `jq` — no
`docker login`. Identical pins + identical hash ⇒ "up to date" ⇒ no build. A new desktop version, a new
CLI version, a workflow edit, or any other recipe edit ⇒ exactly one rebuild.

To force something by hand: *Actions → build → Run workflow*, optionally with an exact `version`, and
with `rebuild=true` when you want the newest version built **without** reading the registry first.

### GitHub pauses scheduled workflows after 60 days of inactivity

GitHub disables a `schedule` trigger in a repository that has seen **no activity for 60 days**. Only a
commit, tag, release, pull request or manual run counts — an automatic scheduled run does **not** reset
the clock. A dormant repository therefore stops noticing new upstream versions *silently*: the workflow
still exists, it simply never fires, and nothing in this repository can prevent that. The recovery, in
order of least effort:

1. **Actions → build → Run workflow** (or `gh workflow run build.yml`). One click, no commit, and it
   both builds on the spot and counts as activity for the 60-day clock.
2. **Enable the workflow again** if GitHub already disabled it (Actions → build → *Enable workflow*).
3. **Push any commit**, even a documentation edit — the clock resets and the next sweep runs.

**Operator-controlled keepalive (opt-in).** To make the sweep survive dormancy without remembering it,
drive `workflow_dispatch` from a cron you already own (Unraid *User Scripts*, a NAS crontab, any CI),
with a token carrying `Actions: write` on this repository:

```bash
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.github+json' \
  https://api.github.com/repos/prv-ctech/claude-code-linux/actions/workflows/build.yml/dispatches \
  -d '{"ref":"main"}'
```

A weekly dispatch is enough. It is deliberately not wired up here: it needs a token, and creating that
token is the operator's call.

### When the registry cannot be read

`plan` distinguishes "not published yet" from "the registry could not be read", because they lead to
opposite decisions — the first is a rebuild, the second must stop rather than guess.
`scripts/published-recipe.sh` exits `3` **only** for an HTTP 404 on the tag; `0` with a hash (empty
output means "published without a recipe stamp", which is also a rebuild); and `2` for anything else —
401/403, 5xx, a timeout, an index with no `linux/amd64` child. Exit `2` fails the `plan` job with the
registry's HTTP status in the log and never silently rebuilds. If that happens before the package
exists at all (the very first publication), re-run *Run workflow* with `rebuild=true`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `denied` or `unauthorized` when pulling | The GHCR package is private | `docker login ghcr.io -u <user>` with a PAT carrying `read:packages` |
| Container exits with code `78` and a `PUID/PGID must be 1000/1000` message | PUID or PGID was changed | Set both back to `1000` and recreate |
| Starts, WebUI loads, but sign-in never completes / settings are not saved | The state directory is not writable by uid 1000 | `chown -R 1000:1000 /mnt/user/appdata/claude-code-linux` (on the server holding a network share) |
| Browser tabs crash, renderers die | `/dev/shm` too small | Keep `--shm-size=2g` / `shm_size: 2gb`; do not remove it |
| Sign-in is not remembered across restarts | Secret-service keyring missing or locked | The image installs and unlocks `gnome-keyring` for `org.freedesktop.secrets`; check the container log for keyring errors |
| Cowork tab says virtualization is unavailable | No `/dev/kvm` / `/dev/vhost-vsock` | Expected and unsupported; use the bundled Claude Code CLI |
| Browser warns about the certificate | In-container TLS is self-signed | Expected; use a reverse proxy with real TLS for remote access |

## Repository layout

```
Dockerfile, docker-entrypoint.sh, rootfs/**   the image (owned by the container task)
.dockerignore                                 build context: exactly what the Dockerfile COPYs
.github/workflows/build.yml                   plan -> build -> latest CI, upstream sweep
scripts/latest-upstream-version.sh            desktop version signal (apt index)
scripts/published-recipe.sh                   recipe hash read back from GHCR (curl + jq)
scripts/recipe-inputs.sh                      derives the recipe-hash input set from the Dockerfile
scripts/install-claude-desktop.sh             key/InRelease verification + pinned .deb install
scripts/selfcheck.sh                          workspace gate over the image's shell surface (no daemon)
unraid/claude-code-linux.xml                  Community Applications template, PUID/PGID 1000/1000
compose.yaml, .env.example                    non-Unraid hosts
docs/DESIGN.md                                binding build contract
docs/RELEASE.md                               publish, verify and roll back by hand
docs/UNRAID-TEST.md                           first-run handoff for the Unraid host
docs/VERIFICATION.md                          what was verified and what could not be, on this host
docs/research/reference-architecture.md       house pattern this CI mirrors
```

## Verification and local reproduction

CI is where every build and runtime assertion happens (the workspace this project was authored in has
no Docker daemon), and the smoke-test log plus the version table are uploaded as a build artifact and
written to the run summary. Locally you can check everything that needs no daemon:

```bash
sh scripts/selfcheck.sh                                # the workspace gate: linters + stubbed runtime behaviour
python3 -c "import xml.dom.minidom; xml.dom.minidom.parse('unraid/claude-code-linux.xml')"
sh -n scripts/published-recipe.sh && sh -n scripts/latest-upstream-version.sh
bash scripts/latest-upstream-version.sh                # e.g. 2.26454.2
bash scripts/latest-upstream-version.sh --json         # version, sha256, deb URL, stanza count
sh scripts/recipe-inputs.sh                            # every file the recipe hash covers
cp .env.example .env && docker compose config -q       # CLAUDE_PASSWORD must be set
```

What has and has not been proven on a host without a container runtime is recorded in
[`docs/VERIFICATION.md`](docs/VERIFICATION.md); publishing and rolling back are in
[`docs/RELEASE.md`](docs/RELEASE.md).

## Licensing

The published image contains **proprietary, closed-source software that this project does not own**:
Anthropic's `claude-desktop` package (© Anthropic PBC, distributed under Anthropic's Commercial Terms
of Service, no redistribution right granted) as well as Google Chrome and the Selkies desktop stack
from their own upstreams. The `.deb` is **never vendored into this repository**: it is fetched from
Anthropic's own apt repository at build time and verified against the `SHA256` published in that same
index. This repository's own build files (workflow, scripts, template, compose, README) may be reused;
the resulting image is subject to its upstreams' terms. The GHCR package stays **private** until this
is reviewed, and `org.opencontainers.image.licenses` is deliberately left unset.
