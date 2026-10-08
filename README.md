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

## Tags and how an update reaches you

| Tag | Meaning |
|---|---|
| `:latest` | Moving. What the Unraid template and `compose.yaml` reference. Re-pointed by CI to a digest that already passed the smoke test; never rebuilt. |
| `:<claude-desktop-version>` (e.g. `2.26454.2`) | Precision tag for the newest build of that desktop version. Re-pointed when the CLI pin or the recipe changes, so it is **not** byte-immutable. |
| `:<claude-desktop-version>-ubuntu26.04` | Same build, distribution flavor suffix taken from the base image tag. |

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
   fetched (HEAD) before it is accepted, so a version Anthropic has listed but not yet uploaded is
   skipped loudly instead of failing the image; a version below the `MIN_VERSION` floor is never
   considered.
2. **`build`** builds `linux/amd64` with `load: true` and **smoke-tests before pushing**: the health
   status must be `healthy`, `dpkg-query -W claude-desktop` must equal the planned version,
   `claude --version` must equal the CLI pin, pid 1 must be root while the session identity is
   `1000:1000`, `https://localhost:8080/api/health` must answer `200`, and `PUID=99` must exit `78`
   with the documented message. Only then are `:<version>` and `:<version>-<flavor>` pushed, with one
   retry for GHCR's first-publication race (`denied: permission_denied: write_package`).
3. **`latest`** moves `:latest` with `docker buildx imagetools create` from the digest that just
   passed the smoke test, then asserts that `:latest` resolves to exactly that digest. **`:latest` is
   never rebuilt.**

**A timer alone never rebuilds.** The recipe hash covers the Dockerfile, `docker-entrypoint.sh`, the
`rootfs` tree, `compose.yaml`, the Unraid template **and both upstream pins**. It is stamped on the
image as `org.opencontainers.image.claude-code-linux-recipe` (mirrored on `com.prvctech.claude-recipe`)
and read back out of GHCR over the raw registry API by [`scripts/published-recipe.sh`](scripts/published-recipe.sh)
with nothing but `curl` and `jq` — no `docker login`. Identical pins + identical hash ⇒ "up to date"
⇒ no build. A new desktop version, a new CLI version, or any recipe edit ⇒ exactly one rebuild.

To force something by hand: *Actions → build → Run workflow*, optionally with an exact `version` and
`rebuild=true`.

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
.github/workflows/build.yml                   plan -> build -> latest CI, upstream sweep
scripts/latest-upstream-version.sh            desktop version signal (apt index)
scripts/published-recipe.sh                   recipe hash read back from GHCR (curl + jq)
unraid/claude-code-linux.xml                  Community Applications template, PUID/PGID 1000/1000
compose.yaml, .env.example                    non-Unraid hosts
docs/DESIGN.md                                binding build contract
docs/research/reference-architecture.md       house pattern this CI mirrors
```

## Verification and local reproduction

CI is where every build and runtime assertion happens (the workspace this project was authored in has
no Docker daemon), and the smoke-test log plus the version table are uploaded as a build artifact and
written to the run summary. Locally you can check everything that needs no daemon:

```bash
python3 -c "import xml.dom.minidom; xml.dom.minidom.parse('unraid/claude-code-linux.xml')"
bash -n scripts/published-recipe.sh && bash -n scripts/latest-upstream-version.sh
bash scripts/latest-upstream-version.sh                # e.g. 2.26454.2
bash scripts/latest-upstream-version.sh --json         # version, sha256, deb URL, stanza count
cp .env.example .env && docker compose config -q       # CLAUDE_PASSWORD must be set
```

## Licensing

The published image contains **proprietary, closed-source software that this project does not own**:
Anthropic's `claude-desktop` package (© Anthropic PBC, distributed under Anthropic's Commercial Terms
of Service, no redistribution right granted) as well as Google Chrome and the Selkies desktop stack
from their own upstreams. The `.deb` is **never vendored into this repository**: it is fetched from
Anthropic's own apt repository at build time and verified against the `SHA256` published in that same
index. This repository's own build files (workflow, scripts, template, compose, README) may be reused;
the resulting image is subject to its upstreams' terms. The GHCR package stays **private** until this
is reviewed, and `org.opencontainers.image.licenses` is deliberately left unset.
