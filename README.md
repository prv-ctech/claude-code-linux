# claude-code-linux

The official **Claude Desktop for Linux** (Anthropic's apt `.deb`) plus the **Claude Code CLI**,
running on a Selkies web desktop and streamed to your browser. Built on LinuxServer.io's
[baseimage-selkies](https://github.com/linuxserver/docker-baseimage-selkies), so PUID/PGID, UMASK and
`/config` work the way every other Unraid container does (the same setup as
[artcraft-apps](https://github.com/junkerderprovinz/artcraft-apps)). Built for Unraid Community
Applications, also usable via `docker compose`.

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
3. Keep **PUID** `99`, **PGID** `100` and **UMASK** `002` (the Unraid defaults). Set **TZ** and,
   optionally, **Workspace** (a host folder that appears at `/workspaces`).
4. Apply. Point your reverse proxy (Pangolin) at port `3000` (HTTP); on the LAN open
   `https://<server>:3001` and accept the self-signed certificate once.

### Docker Compose

```bash
cp .env.example .env      # PUID/PGID/UMASK default to Unraid's 99/100/002
docker compose up -d
docker compose logs -f
```

State lands in `./appdata` by default. Both files encode the same ports, `/dev/shm` size,
PUID/PGID/UMASK defaults and paths as the Unraid template, so the two cannot drift.

## First run

1. **Open the session** through your reverse proxy, or `https://<server>:3001` on the LAN. There is
   no desktop login: the reverse proxy is the gate.
2. **Sign in to Claude.** The session starts the secret service and then Claude Desktop; the app's
   sign-in page opens in the session's **Google Chrome**, which is the desktop's default browser on
   purpose ([`rootfs/etc/xdg/mimeapps.list`](rootfs/etc/xdg/mimeapps.list)).
3. **Or use the CLI.** Open *Terminal* from the desktop's right-click menu, or from the Unraid terminal
   run `docker exec -it -u abc claude-code-linux claude`.

Start the container with `CLAUDE_DESKTOP_AUTOSTART=false` for a session without the Claude window at
start-up; the desktop's right-click menu (*Claude*, *Google Chrome*, *Terminal*) opens it on demand,
also after you close it.

### Where state lives

Everything that has to survive an update is a single mount, `/config` (the session user's `HOME`):

| Host | Value |
|---|---|
| Unraid | `/mnt/user/appdata/claude-code-linux` (the template's *AppData* path) |
| compose | `./appdata` (`CLAUDE_STATE` in `.env`) |

It holds the Chrome profile, the gnome-keyring that stores the claude.ai sign-in, the Claude Desktop
configuration and `~/.claude/.credentials.json` for the CLI. That is why an update or a recreate never
asks you to sign in again — and why it is worth backing up.

**Upgrading from the `/home/ubuntu` image** (before the LinuxServer.io rebase): start fresh. Point
*AppData* at a new, empty folder and sign in once more; the old folder's files belong to uid 1000 and
use the old layout.

## Python and CPU encoding

`python3`, `pip` and `uv` are installed. `pip install --user` and `uv tool install` write under
`/config`, so they persist with the rest of the state. Video is encoded on the CPU (x264) by
default; no GPU or device passthrough is needed. With `--device=/dev/dri` (compose: `devices:`), Selkies
detects an Intel or AMD render node at start and encodes with VA-API where the GPU supports the codec
(checked on an Intel Arc A380; NVIDIA is untested). No driver install is needed on the host or in the
image: the host kernel's GPU driver is enough (`i915` on the A380), and the image already carries the
VA-API, Mesa and Vulkan drivers. Claude Desktop then renders through ANGLE on Vulkan, on the same GPU;
its default GL backend would log `XFree86-VidModeExtension missing` and `glXGetMscRateOML failed` on
every frame, because the virtual X display has no refresh rate to report. The image sets
`INTEL_DEBUG=noccs`: on Intel Arc, compressed (CCS) buffers on the zero-copy capture path stream as
scrambled tiles. The sidebar's Full Color button asks for 4:4:4, which an Arc encodes in hardware only
for H.265 and VP9, so with it on, H.264 falls back to the CPU (x264). H.264 is the base's default
encoder, and the webcam uplink is locked to H.264 (`SELKIES_WEBCAM_ENCODER`).

## PUID, PGID and UMASK

The base image's init remaps its `abc` user to `PUID`/`PGID` and applies `UMASK` before anything
starts, so every file the desktop, Claude Desktop or the CLI writes under `/config` and `/workspaces`
belongs to the host user that owns the share. The defaults are Unraid's: `99` (`nobody`), `100`
(`users`) and `002` (group-writable, so your other containers can edit the same files). On another
Linux host, set them to the ids that own your folders (often `1000`/`1000`).

## Workspace access

A host folder with your projects can be mounted at `/workspaces` (Unraid: the **Workspace** path;
compose: `CLAUDE_WORKSPACE`, default `./workspace`). With PUID/PGID matching the folder's owner it is
writable as-is; nothing is chowned.

## `/dev/shm` is 2 GB on purpose

Docker's default `/dev/shm` is 64 MB, and the browsers in this desktop are killed on it. The Unraid
template sets `--shm-size=2g` in `ExtraParams` (there is no `Config Type` for it) and `compose.yaml`
sets `shm_size: 2gb`. This is required, not tuning.

## Ports and exposure

| Port | Use |
|---|---|
| `3000/tcp` | HTTP, for the reverse proxy (Pangolin) that terminates TLS and authenticates. Opened directly in a browser it reports that it needs a secure connection. |
| `3001/tcp` | HTTPS with a self-signed certificate, for the LAN. |

**There is no desktop login**: `CUSTOM_USER`/`PASSWORD` are not set and `SELKIES_ENABLE_BASIC_AUTH`
is `false`, so the reverse proxy's auth is the only gate. **Never expose 3000 or 3001 to the Internet
directly**: the streamed session holds your claude.ai and Claude Code credentials. (Setting
`PASSWORD`, and optionally `CUSTOM_USER`, would turn on the base's nginx basic auth.)

## Cowork (QEMU/KVM) is unsupported

Anthropic's Cowork runs tasks inside a virtual machine hosted by the desktop app; it needs hardware
virtualization, `/dev/kvm` **and** `/dev/vhost-vsock` (openable only by members of the `kvm` group).
Anthropic's own documentation calls the missing-`vhost-vsock` case common in container-based
environments, and this template grants no devices, so the Cowork tab reports its requirement instead
of half-failing. The **pinned Claude Code CLI ships in the same image** and is the documented
fallback: it needs no virtualization.

If you want to try KVM anyway, build with `--build-arg CLAUDE_DESKTOP_COWORK=true` and pass
`/dev/kvm` and `/dev/vhost-vsock`. Nothing about that configuration is supported.

## Limitations

| Limitation | Why, and what to do instead |
|---|---|
| **amd64 only — no `arm64` image** | Both apps publish arm64 builds, but this project builds `linux/amd64` only (DESIGN D11): publishing a second architecture nobody asked for, plus the emulated builds it needs. There is no `Dockerfile.aarch64` and CI produces no multi-arch index, so an ARM host cannot run it. |
| **Computer Use is unavailable** | It is a macOS/Windows feature — Anthropic's Linux desktop notes state it "isn't available on Linux". No image change can add it; use the bundled Claude Code CLI for automation. |
| **Cowork needs KVM** | [`/dev/kvm` plus `/dev/vhost-vsock` and the host `kvm` group](#cowork-qemukvm-is-unsupported), which the template deliberately does not grant. The CLI in the same image is the fallback. |
| **The Unraid icon is a generated placeholder tile** | `unraid/icon.png` is a 256×256 RGBA mark generated for this repository — not a flat colour block — because Community Applications requires an icon URL and no designed tile exists yet. Replacing that one file is the whole change when a designed tile arrives. |
| **Self-signed TLS on `3001`** | Inherited from the base image. Use the reverse proxy on `3000` for anything beyond your LAN. |

## Tags and how an update reaches you

| Tag | Meaning |
|---|---|
| `:latest` | Moving. What the Unraid template and `compose.yaml` reference. Re-pointed by CI to a digest that already passed the smoke test; never rebuilt. |
| `:<claude-desktop-version>` (e.g. `2.26454.2`) | Precision tag for the newest build of that desktop version. Re-pointed when the CLI pin or the recipe changes, so it is **not** byte-immutable. |
| `:<claude-desktop-version>-ubunturesolute` | Same build, distribution flavor suffix taken from the base image tag. |

Because a version tag can be re-pointed, the immutable handle is the **digest** (`image@sha256:…`).
Publishing a version by hand, verifying a published image and rolling a user back — all with exact
commands — are in [`docs/RELEASE.md`](docs/RELEASE.md).

### The version this release targets

The numbers the first release is built from, re-resolved from upstream on 2026-10-08:

| Component | Version | Where it comes from |
|---|---|---|
| Claude Desktop | `2.26454.2` · `SHA256 b251a0224a8635874f33598df8ed8952b427f84815ee59580cc022d6bdb2430f` | the `Version`/`SHA256` of that one stanza in Anthropic's amd64 `Packages` index |
| Claude Code CLI | `2.1.294` | `dist-tags.latest` of `@anthropic-ai/claude-code` (npm) |
| Base image | `ghcr.io/linuxserver/baseimage-selkies:ubunturesolute` | the workflow's `BASE_IMAGE`, and the source of the `-ubunturesolute` tag suffix |

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

Plugins are the exception: they keep updating without a rebuild. `FORCE_AUTOUPDATE_PLUGINS=1` keeps
plugin auto-update on, and at every start the `init-claude` s6 step (`rootfs/usr/local/bin/claude-init`) sets `autoUpdate: true` on each
third-party marketplace in `~/.claude/plugins/known_marketplaces.json` that has no setting yet. Without
that, a third-party marketplace's local clone is never refreshed, so Claude Code never sees a newer
plugin version and its update button stays grey. A marketplace you turned auto-update off for
(`autoUpdate: false`) is left alone, and so are Anthropic's own marketplaces, which update by default.
A marketplace added during a session is picked up at the next container start; until then,
`claude plugin marketplace update` refreshes it by hand. Auto-update means each session start pulls
whatever those marketplaces publish, unreviewed.

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
container from its stored template with the same Config values. The bind-mounted `/config` path
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
   `claude --version` must equal the CLI pin **when run as the session user** (`docker exec -u abc`),
   started with `PUID=99 PGID=100 UMASK=002`: `abc` must be `99:100` and own `/config`,
   `http://localhost:3000/` must answer `200` **without a login**, Xvfb, `openbox` and Claude Desktop
   must all be running as uid 99, and `google-chrome --version` must match the installed package and a
   bounded `--headless --dump-dom` run must produce DOM. Only then are `:<version>` and `:<version>-<flavor>` pushed, with one
   retry for GHCR's first-publication race (`denied: permission_denied: write_package`).
3. **`latest`** moves `:latest` with `docker buildx imagetools create --prefer-index=false` from the
   digest that just passed the smoke test, then asserts that `:latest` resolves to exactly that digest
   (the copy is skipped when it already resolves there). `--prefer-index=false` is what makes the
   assertion meaningful: it writes the source manifest bytes through instead of re-wrapping them in a
   fresh index. **`:latest` is never rebuilt.**

**A timer alone never rebuilds.** The recipe hash covers everything the image build consumes: the
Dockerfile, `.dockerignore`, every `COPY` source of the Dockerfile (the
`scripts/install-claude-desktop.sh` installer, the whole `rootfs` tree and the icon), `compose.yaml`, the Unraid
packaging (`unraid/**` — template and icon), **this workflow file**, a `RECIPE_SCHEMA` constant and the
CLI pin — plus the **Claude Desktop version it is computed for**. The list is *derived*, not
hand-maintained: [`scripts/recipe-inputs.sh`](scripts/recipe-inputs.sh) reads the Dockerfile's own
`COPY` lines and prints it, and the `plan` job hashes exactly that output, so a new `COPY` source joins
the hash with no other edit and no build input can silently fall out of it. The workflow's `push` filter
covers that set — `Dockerfile`, `.dockerignore`, `rootfs/**`, `compose.yaml`,
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
| Starts, WebUI loads, but sign-in never completes / settings are not saved | AppData still holds files from the old uid-1000 image | Point *AppData* at a new, empty folder (or `chown -R 99:100` the old one) |
| `requires a secure connection (HTTPS)` | Port 3000 opened directly in a browser | Use the reverse proxy, or `https://<server>:3001` |
| Browser tabs crash, renderers die | `/dev/shm` too small | Keep `--shm-size=2g` / `shm_size: 2gb`; do not remove it |
| Sign-in is not remembered across restarts | Secret-service keyring missing or locked | The image installs and unlocks `gnome-keyring` for `org.freedesktop.secrets`; check the container log for keyring errors |
| Cowork tab says virtualization is unavailable | No `/dev/kvm` / `/dev/vhost-vsock` | Expected and unsupported; use the bundled Claude Code CLI |
| Browser warns about the certificate | In-container TLS is self-signed | Expected; use a reverse proxy with real TLS for remote access |

## Repository layout

```
Dockerfile, rootfs/**                         the image (s6 init in rootfs/etc/s6-overlay)
.dockerignore                                 build context: exactly what the Dockerfile COPYs
.github/workflows/build.yml                   plan -> build -> latest CI, upstream sweep
scripts/latest-upstream-version.sh            desktop version signal (apt index)
scripts/published-recipe.sh                   recipe hash read back from GHCR (curl + jq)
scripts/recipe-inputs.sh                      derives the recipe-hash input set from the Dockerfile
scripts/install-claude-desktop.sh             key/InRelease verification + pinned .deb install
scripts/selfcheck.sh                          workspace gate over the image's shell surface (no daemon)
unraid/claude-code-linux.xml                  Community Applications template, PUID/PGID 99/100, UMASK 002
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
cp .env.example .env && docker compose config -q       # no desktop login
```

What has and has not been proven on a host without a container runtime is recorded in
[`docs/VERIFICATION.md`](docs/VERIFICATION.md); publishing and rolling back are in
[`docs/RELEASE.md`](docs/RELEASE.md).

## Licensing

The published image contains **proprietary, closed-source software that this project does not own**:
Anthropic's `claude-desktop` package (© Anthropic PBC, distributed under Anthropic's Commercial Terms
of Service, no redistribution right granted) as well as Google Chrome and LinuxServer.io's Selkies base image
from their own upstreams. The `.deb` is **never vendored into this repository**: it is fetched from
Anthropic's own apt repository at build time and verified against the `SHA256` published in that same
index. This repository's own build files (workflow, scripts, template, compose, README) may be reused;
the resulting image is subject to its upstreams' terms. The GHCR package stays **private** until this
is reviewed, and `org.opencontainers.image.licenses` is deliberately left unset.
