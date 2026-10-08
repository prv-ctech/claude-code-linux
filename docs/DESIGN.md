# DESIGN.md — binding build contract for `prv-ctech/claude-code-linux`

**Status:** BINDING · **Revision:** 7 · **Date:** 2026-10-08 · **Owner:** architect (team `claude-code-linux`)
**Audience:** container-dev (t2), ci-dev (t3), verifier, reviewer.

This document is the contract every downstream task is judged against. Every entry below is a
**decision**, not an option; if something here reads as a choice left open, that is a defect in this
document. Changing a decision means editing this file, not choosing differently in code.

Research material this contract is drawn from (all in this workspace):

| Artifact | What it covers |
|---|---|
| [`docs/research/reference-architecture.md`](research/reference-architecture.md) | House pattern (`prv-ctech/deepseek-harness`), Selkies/Unraid analogues, CI shape |
| [`unraid-ca-puid-pgid-spec.md`](../unraid-ca-puid-pgid-spec.md) | Unraid CA template schema, appdata/PUID semantics, update detection from webgui source |
| [`claude-code-distribution-report.md`](../claude-code-distribution-report.md) | Claude Code CLI distribution, npm channels, devcontainer/containerization guidance |

Every factual claim below carries a source URL. Values marked **observed at authoring time** were
executed on 2026-10-08 from this workspace and their commands are in [Appendix B](#appendix-b--commands-run-at-authoring-time).

---

## 0. Revision history (dated corrections)

The contract moved after t3 shipped. Both corrections are recorded here with their reason rather than
edited in silently, so a reader of the diff learns why the contract moved.

### 2026-10-08 — revision 2, post-t3 reconciliation

| # | Changed | From | To | Why |
|---|---|---|---|---|
| C1 | `/dev/shm` size (§5, §7.1) | `--shm-size=1g` / `shm_size: "1gb"` | **`--shm-size=2g` / `shm_size: 2gb`** (compose via `${CLAUDE_SHM_SIZE:-2gb}`) | 2 GB is what upstream Selkies documents and 1 GB leaves too little headroom for the two browsers in this desktop; the shipped Unraid `ExtraParams`, `compose.yaml`, `.env.example` and README already said 2g, and the binding contract must not contradict shipped code. |
| C2 | Host-facing interpolation names (§5, §7.1, new D13) | `${PUID:-1000}`, `${PGID:-1000}`, `${TZ:-Etc/UTC}` | **`${CLAUDE_PUID:-1000}`, `${CLAUDE_PGID:-1000}`, `${CLAUDE_TZ:-Etc/UTC}`** | Compose interpolates the ambient host environment, and an Unraid-shaped host exports `PUID=99` / `PGID=100` for its own docker tooling — so a plain `${PUID}` silently handed the container uid 99 and the entrypoint correctly refused it with exit 78. The **container-facing** names are deliberately unchanged: Unraid still passes `PUID`/`PGID` into the container through the template's `Config` entries (`<Config Name="PUID" Target="PUID" Default="1000">`), and `docker-entrypoint.sh` still reads `PUID`/`PGID`. |

Revision 1 was the original 2026-10-08 contract reviewed by t1; revision 2 recorded the 2g `/dev/shm`
size and the `CLAUDE_*` host-facing rename; revision 3 resolves the pid-1 contradiction and records the
three accepted image additions below; revision 4 records the entrypoint's three test-only path overrides
(§4.2); revision 5 corrects §5.1's key-fetch drift; revision 6 states the index-to-`InRelease` binding
that revision 5 could not yet claim; revision 7 brings §6.3's smoke-test enumeration up to the assertions
the step now makes.

### 2026-10-08 — revision 3, post-review amendments

| # | Changed | From | To | Why |
|---|---|---|---|---|
| C3 | pid 1 / supervision (§4.2 step 3, D6) | `exec setpriv … /etc/container-entrypoint.sh`, which would make pid 1 uid 1000 and contradict §6.3 | pid 1 **stays the root wrapper**: it runs the base entrypoint as a **child**, forwards `TERM`/`INT`/`QUIT` to the session, and exits with the session's status | Removes the internal contradiction a reviewer re-flagged: "pid 1 is root" and "the session is uid 1000" are now both true at once. The enforceable outcomes — the `setpriv` drop, no `usermod`/`groupmod`, `PUID=99` → exit 78 — are unchanged. |
| C4 | §5.1 package allowlist | `gnome-keyring ca-certificates … xdg-desktop-portal-gtk` | same list **+ `gpgv libsecret-tools`** | `gpgv` verifies the Anthropic index's signature and key fingerprint at build time; `libsecret-tools` proves the secret service actually stores a secret, which is exactly the R2 failure mode. |
| C5 | §3 | *(unrecorded)* | `rootfs/etc/xdg/mimeapps.list` recorded as the http/https handler | The base names no default browser, so the accepted *"Chrome is the OAuth browser"* criterion needs a concrete handler; `xdg-utils` ships no such file, so nothing is overwritten. |
| C6 | §3 | *(unrecorded)* | `/usr/local/bin/claude-desktop` sandbox-probe wrapper recorded | The packaged launcher is a bare symlink with nowhere to put a switch, so the wrapper reuses upstream's own probe (`unshare` where available, else `--no-sandbox`) instead of letting the zygote abort under Docker's default seccomp; `chrome-sandbox` stays `root:root 4755`. |

### 2026-10-08 — revision 4, test-only entrypoint overrides recorded

| # | Changed | From | To | Why |
|---|---|---|---|---|
| C7 | §4.2 | the entrypoint's three env overrides (`STATE_DIR`, `MOUNTINFO`, `DOCKER_ENTRYPOINT_PREFIX`) exist in the code but were absent from the contract | recorded with their defaults, the "set by nothing in the image, `compose.yaml` or the Unraid template" statement, and the gate's reason | container-dev flagged them rather than letting them pass silently. Recording them (a) states why the self-check gate cannot do without them, (b) fixes their defaults as the DESIGN paths, so a future contributor who changes one has to amend this document, and (c) makes explicit that a container never sets them. |

### 2026-10-08 — revision 5, §5.1 install chain corrected

| # | Changed | From | To | Why |
|---|---|---|---|---|
| C8 | §5.1 "Install method" | *"the `.deb` carries the signing key, so no separate key fetch is needed"* | the chain the shipped installer actually runs: `key.asc` fetched and hash-pinned, fingerprint checked over `InRelease` with `gpgv`, the pinned stanza read from the index, the `.deb` checked against that stanza's `SHA256`, apt validating the documented `deb` line | t13 finding F3: the doc contradicted the implementation and §5.1's own later text. The implementation is the stricter reading, so the contract moves to it — and says plainly which binding it does *not* claim. |

### 2026-10-08 — revision 6, index-to-`InRelease` binding stated

| # | Changed | From | To | Why |
|---|---|---|---|---|
| C9 | §5.1 "Install method" | revision 5's non-promise: the directly fetched `Packages` file was *not* signature-bound to `InRelease`, and the text said so | the implemented binding is stated: the `SHA256` the signed `InRelease` lists for `main/binary-amd64/Packages` is compared against `sha256sum` of the fetched index, and the script refuses to parse a mismatch | t16 closed the gap in `scripts/install-claude-desktop.sh:113-128`, so revision 5's wording understated the code. The C8 cell keeps that non-promise as history. |

### 2026-10-08 — revision 7, smoke-test enumeration refreshed

| # | Changed | From | To | Why |
|---|---|---|---|---|
| C10 | §6.3 smoke-test bullet | health, `/api/health`, the two version checks, pid 1 root vs session uid 1000, and the `PUID=99` exit 78 | the same, plus `/home/ubuntu` ownership, the desktop-is-up assertions (`DISPLAY` from the base's `container-env`, X socket, `xdpyinfo`, `Xvfb`/`lxqt-session`/`openbox` as uid 1000) and the Chrome assertions (executes as uid 1000, `--version` matches the installed package, bounded headless `--dump-dom`) | t22 added runtime desktop assertions to the smoke step (`.github/workflows/build.yml:384-615`), so the enumeration understated what the step checks. Descriptive only: no assertion here is new policy. |

---

## 1. Decisions at a glance

| # | Decision |
|---|---|
| D1 | The image ships **two tracked upstreams**: Claude **Desktop** (primary experience) and a pinned Claude **Code CLI** (the agentic path that works without KVM). One image, no variants. |
| D2 | Desktop version signal = **maximum `Version` line of the Anthropic apt index via `sort -V`**, with the `SHA256` of the *same stanza*. |
| D3 | CLI version signal = **`dist-tags.latest`** of `@anthropic-ai/claude-code` on npm. Never a max scan of the version list. |
| D4 | Base image = `ghcr.io/selkies-project/selkies/desktop:2.0.0-ubuntu26.04`, a literal `ARG BASE_IMAGE` default, overridable by `--build-arg`. |
| D5 | **PUID/PGID is 1000:1000, exclusively.** Any other value is rejected at start with an actionable error and exit 78. No remap path exists. |
| D6 | The image runs a **root bootstrap on pid 1**: the `USER 0` wrapper entrypoint validates PUID/PGID, `chown`s the state path, then `setpriv`s to 1000:1000 and runs `/etc/container-entrypoint.sh` **as a child** — pid 1 stays root, forwards `TERM`/`INT`/`QUIT` to the session and exits with the session's status; the base entrypoint is never `exec`'d over it. No `usermod`/`groupmod`, ever. |
| D7 | State path is **`/home/ubuntu`** and never `/config`. |
| D8 | Tags: `:latest` (moving; what Unraid tracks) + `:<claude-desktop-version>` (precision tag, re-pointed when the CLI pin or recipe changes). `:latest` is moved by `docker buildx imagetools create` from a smoke-tested digest and never rebuilt. |
| D9 | Health = the base image's own `HEALTHCHECK` on `https://localhost:8080/api/health`. No second healthcheck, and `/` is never the probe. |
| D10 | The container does **not** self-update: Anthropic's apt repo is not registered inside the image, and the CLI's updater is disabled. The image rebuild is the update path. |
| D11 | amd64 only, GHCR only, package **private** until the licensing risk (R3) is closed. |
| D12 | Google Chrome is **not** reinstalled and **not** re-patched; the base desktop layer already ships and patches it. `chromium-browser` is forbidden. |
| D13 | **Host-facing interpolation carries a `CLAUDE_` prefix** (`CLAUDE_PUID`, `CLAUDE_PGID`, `CLAUDE_TZ`, `CLAUDE_SHM_SIZE`); the container-facing names stay plain `PUID`, `PGID`, `TZ`. Because compose interpolates the ambient host environment and Unraid exports `PUID=99`/`PGID=100` — see §0/C2 and §5. |

---

## 2. Two tracked upstreams, one image

### 2.1 Claude Desktop — the app on screen (primary)

Facts ([Linux desktop docs](https://code.claude.com/docs/en/desktop-linux)):

* Linux support is in beta; Debian-based only — Ubuntu 22.04+ or Debian 12+; x86_64 or arm64.
* It is **closed source** and distributed **only** as a `.deb` through Anthropic's apt repository at
  `https://downloads.claude.ai/claude-desktop/apt/stable`; the `.deb` also ships Anthropic's signing key
  (`/usr/share/keyrings/claude-desktop-archive-keyring.asc`, fingerprint
  `31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE` from `https://downloads.claude.ai/claude-desktop/key.asc`).
* **It does not self-update on Linux**: *"The desktop app doesn't update itself on Linux. Updates arrive
  with your system's regular package updates."* Consequence: for a container, **apt is the only version
  signal and an image rebuild is the only update path.**
* `https://github.com/anthropics/claude-code` is **NOT** the desktop app's distribution channel. That
  repository is the **Claude Code CLI** (npm `@anthropic-ai/claude-code`, `curl … claude.ai/install.sh`,
  a devcontainer feature), its license is *"© Anthropic PBC. All rights reserved. Use is subject to
  Anthropic's Commercial Terms of Service"* ([LICENSE.md](https://raw.githubusercontent.com/anthropics/claude-code/HEAD/LICENSE.md)),
  and its releases/tags carry CLI versions (`releases/latest` = `v2.1.294`, observed). The desktop `.deb`
  is not published there. Nothing in this project may read a desktop version from that repository.

**Decision D2 — the exact signal.**

```
INDEX=https://downloads.claude.ai/claude-desktop/apt/stable/dists/stable/main/binary-amd64/Packages
```

One fetch of that index; parse it as RFC-822 stanzas; keep only stanzas whose first line is
`Package: claude-desktop`; emit `"<Version> <SHA256> <Filename>"` per stanza; `sort -V`; `tail -n 1`.
The winner's `Version` is the desktop version, its `SHA256` **from that same stanza** is the expected
digest, and its `Filename` gives the deb URL
(`https://downloads.claude.ai/claude-desktop/apt/stable/<Filename>`).

`sort -V` is mandatory, not cosmetic: the index's version scheme moved from the `1.x` line to `2.x`
(observed order: `1.17180.0 … 1.52386.6`, then `2.110.0 … 2.26454.2`), and the index is append-only.
This mirrors Anthropic's own documented lookup, which greps `^Filename:` and pipes through `sort -V`
([docs](https://code.claude.com/docs/en/desktop-linux)).

**Observed at authoring time (2026-10-08):**

| Field | Value |
|---|---|
| Stanzas in index | **50** |
| `CLAUDE_DESKTOP_VERSION` | **`2.26454.2`** |
| `SHA256` | **`b251a0224a8635874f33598df8ed8952b427f84815ee59580cc022d6bdb2430f`** |
| `Filename` | `pool/main/c/claude-desktop/claude-desktop_2.26454.2_amd64.deb` |
| `Size` (deb bytes) | 180 943 856 |
| `Installed-Size` (KiB) | 588 688 |
| `Depends` highlights | `libgtk-3-0, libnotify4, libnss3, libsecret-1-0, libc6 (>= 2.34), xdg-desktop-portal, xdg-desktop-portal-gtk \| …-gnome \| …-kde` |
| `Recommends` highlights | `libayatana-appindicator3-1, ca-certificates, gnome-keyring \| plasma-workspace, bubblewrap, socat, qemu-system-x86, ovmf, virtiofsd` |

Build-time assertions (fatal, not warnings): the downloaded file's `sha256sum` equals the index
`SHA256`; `dpkg-query -W -f='${Version}' claude-desktop` equals `ARG CLAUDE_DESKTOP_VERSION`.

### 2.2 Claude Code CLI — the pinned agentic path (fallback)

Facts ([npm registry](https://registry.npmjs.org/@anthropic-ai/claude-code),
[GitHub releases](https://api.github.com/repos/anthropics/claude-code/releases/latest), observed 2026-10-08):

| Signal | Observed |
|---|---|
| `dist-tags` | `latest` **2.1.294**, `stable` 2.1.286, `next` **2.1.295** |
| Version count | 537 |
| `releases/latest` | `v2.1.294` (published 2026-10-08T05:03:54Z) |

**Decision D3 — the exact signal:** the CLI version is `dist-tags.latest` of the npm packument
(`https://registry.npmjs.org/@anthropic-ai/claude-code`), i.e. `2.1.294` as observed. Two traps, both
verified, that the CI must not fall into:

1. `dist-tags.next` (`2.1.295`) is **ahead of** `latest` — a max scan over `versions[]` yields `2.1.295`
   and publishes an unreleased-next build as if it were stable. Read `dist-tags.latest`, never a max.
2. `https://registry.npmjs.org/@anthropic-ai/claude-code/-/package.json` **does not exist**
   (`{"code":"ResourceNotFound"}`) and carries no `dist-tags`; use the packument or
   `/@anthropic-ai/claude-code/latest`.

**Decision:** install the CLI pinned — `npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`
— which is exactly the official guidance for reproducing a version in a Dockerfile instead of using the
Dev Container Feature, and set `DISABLE_AUTOUPDATER=1` and `DISABLE_UPDATES=1`
([devcontainer docs](https://code.claude.com/docs/en/devcontainer.md),
[env vars](https://code.claude.com/docs/en/env-vars.md)). `DISABLE_UPDATES` is the documented switch for
*"distributing Claude Code through your own channels"*, which is what this image does: the version in the
image is exactly the pinned version, and it moves when the image is rebuilt.

**State and credentials land inside the mount.** On Linux the CLI stores its login at
`~/.claude/.credentials.json` (mode `0600`) and its global config at `~/.claude.json`
([authentication](https://code.claude.com/docs/en/authentication.md),
[settings reference](https://code.claude.com/docs/en/settings.md)). With `HOME=/home/ubuntu`, both are
under the mounted state path, so CLI sign-in survives container recreation exactly as Desktop's does.
`CLAUDE_CONFIG_DIR` is left unset.

### 2.3 Why both

Anthropic's own Linux docs make Cowork a virtual-machine feature: it *"runs those tasks in a virtual
machine that the desktop app hosts with QEMU and KVM"*, needs hardware virtualization, the QEMU/UEFI
packages, `/dev/kvm`, and *"`/dev/vhost-vsock`, which only `kvm` group members can open"*, and it warns
that the missing-`vhost-vsock` case *"is common on ChromeOS and in container-based Linux environments"*
([docs](https://code.claude.com/docs/en/desktop-linux)). See R1: the Unraid template grants no KVM
devices, so **Cowork is not available by default**. The CLI *"runs the same Claude Code engine and
supports a wider range of Linux distributions"* and needs no virtualization: it is the fallback that
keeps the container useful. **Decision: both ship in the same image; there is no CLI-only variant and no
second tag.**

---

## 3. Base image and pinning

**Decision D4.** The Dockerfile declares a literal, pinned default and nothing cleverer:

```dockerfile
ARG BASE_IMAGE=ghcr.io/selkies-project/selkies/desktop:2.0.0-ubuntu26.04
FROM ${BASE_IMAGE}
```

`--build-arg BASE_IMAGE=…` (tag or `@sha256:` digest) overrides it; when CI overrides, the resolved
digest is recorded in the image labels. The floating `main-`/`latest-` tags are never used in the
Dockerfile.

Why `2.0.0-ubuntu26.04` (observed 2026-10-08 from the GHCR tag list): the published `-ubuntu26.04`
desktop tags are `main-…`, `latest-…`, `2.0.0rc0-…`, `2.0.0rc1-…`, `2.0.0-…`. `latest-ubuntu26.04` and
`2.0.0-ubuntu26.04` resolve to the **same** manifest digest
`sha256:17366ded0187e635bc40bdafaf6b9955854a70a4ff091a17f3034a12d7a74090`, so `2.0.0-ubuntu26.04` *is*
current stable while being reproducible; `main-` only moves. The base underneath it,
`selkies/base:2.0.0-ubuntu26.04`, resolves to `sha256:191428b47ee11e6670547a5012a2a939c1b4df257a0a5293c226ab337c8a4723`.

**Why build on the Selkies reference desktop instead of assembling a desktop by hand**
([base-image docs](https://github.com/selkies-project/selkies/blob/main/docs/components/base-image.md),
[desktop-image docs](https://github.com/selkies-project/selkies/blob/main/docs/components/desktop-image.md),
[base Dockerfile](https://raw.githubusercontent.com/selkies-project/selkies/main/addons/base/Dockerfile),
[desktop Dockerfile](https://raw.githubusercontent.com/selkies-project/selkies/main/addons/desktop/Dockerfile)):

* The base already *is* the session: XLibre `Xvfb` built from a checksum-pinned archive **with five
  upstream patches**, headless Wayland capture plus a nested `labwc`, PipeWire/WirePlumber audio with a
  tuned PulseAudio target, the GPU runtime and `selkies-gpu-probe`, s6 supervision, an embedded coTURN,
  the `selkies` wheel with `pixelflux`/`pcmflux` and the input/V4L2 interposers, `selkies-privileged-files`,
  and a `HEALTHCHECK` (D9). Hand-assembling that means re-deriving and maintaining all of it.
* The desktop layer adds exactly what this project needs and no more: LXQt with Openbox on X11 and on
  Wayland (`SELKIES_WAYLAND=true`), the xdg-desktop-portal, and **the browsers — Firefox from Mozilla's
  APT repo and Google Chrome from `dl.google.com` as a `.deb`**, "for the H.264/AV1 media stack the
  distribution Chromium builds do not carry".
* Both images are rootless-by-design: *"every layer runs as uid 1000 through `fakeroot`, so the package
  database and apt cache belong to the session user"*, `/home/ubuntu` is *"the session user's home, uid
  1000"*, and the bundle must be released around dpkg work for the root-owned setuid files. That is the
  foundation of the PUID/PGID policy in §4.
* The container entrypoint is PID-agnostic (`/etc/container-entrypoint.sh`, ends by launching
  `s6-svscan /etc/service`) and reads `PASSWD`, `SELKIES_MODE`, `SELKIES_WAYLAND`, `START_LXQT`, `TZ`,
  `DISPLAY_SIZEW/H`, TURN settings, and more.

**Decision D12.** Google Chrome is already installed and already patched by the upstream layer: its
launcher is rewritten to pass `--password-store=basic` and a sandbox flag chosen by an
`unshare --user --map-root-user` probe (`--no-sandbox` where user namespaces are unavailable, "the
container is the isolation boundary there"). This project does **not** re-download, reinstall or
re-patch Chrome. Ubuntu's `chromium-browser` is forbidden: it is a transitional package to the snap and
does not work here.

**The default browser is named explicitly.** Neither the base nor its desktop layer names a default
browser, and both Firefox and Chrome register themselves as `http`/`https` handlers, so the image ships
`rootfs/etc/xdg/mimeapps.list` mapping `x-scheme-handler/http`, `x-scheme-handler/https` and `text/html`
to `google-chrome.desktop`. That is what makes the accepted *"Chrome is the OAuth browser"* criterion
concrete: Claude Desktop hands the claude.ai sign-in URL to the session's browser. It lives in `/etc/xdg`
(the LXQt service puts that on `XDG_CONFIG_DIRS`, so GIO and `xdg-open` both read it), `xdg-utils` ships
no such file so nothing is overwritten, and a user's own `~/.config/mimeapps.list` still outranks it.
`x-scheme-handler/claude` is deliberately absent — the package is already the only handler for its own
scheme.

**The app's launcher is a wrapper, because the packaged launcher has nowhere to put a switch.**
`/usr/bin/claude-desktop` is a bare symlink to the Electron binary
(`/usr/lib/claude-desktop/claude-desktop`), so the image ships `/usr/local/bin/claude-desktop` ahead of it
in `PATH` — the menu entry, `xdg-open`, a shell and the autostart all reach the wrapper. It reuses
upstream's own probe (`unshare --user --map-root-user --pid --net --fork true`, else `--no-sandbox`)
because Docker's default seccomp profile denies `CLONE_NEWUSER` and Electron's zygote otherwise aborts
with nothing in the session to click. `chrome-sandbox` keeps its packaged ownership `root:root` mode
`4755`, and the wrapper deliberately does **not** pass `--password-store=basic` (unlike Chrome): Claude
Desktop has to reach the secret service, which is what keeps the sign-in across recreation (§5.1).

---

## 4. PUID/PGID policy (DECIDED)

### 4.1 The decision

* **Supported configuration: `PUID=1000`, `PGID=1000`. Exclusively.**
* Defaults: `ENV PUID=1000 PGID=1000` in the image and `Default="1000"` on both `Config` entries in the
  Unraid template ([spec §2.3](../unraid-ca-puid-pgid-spec.md#23-making-10001000-the-default-while-remaining-overridable)).
* **Any other value is rejected at container start** with the message in §4.4 and exit status `78`
  (EX_CONFIG). The container never silently runs as a different user.

### 4.2 Mechanism: one root step, then drop to 1000:1000

The image is built with `USER 0` and a wrapper entrypoint (`docker-entrypoint.sh`) that:

1. validates `PUID == 1000 && PGID == 1000` (else §4.4, exit 78);
2. if the process is root (`id -u` == 0): `chown -R 1000:1000 /home/ubuntu` and, if it exists,
   `chown 1000:1000 "${XDG_RUNTIME_DIR:-/tmp/runtime-ubuntu}"`; a chown failure is fatal with the
   remediation line from §4.5;
3. `setpriv --reuid=1000 --regid=1000 --init-groups /etc/container-entrypoint.sh "$@" &` — **as a child,
   not by `exec`**, so pid 1 stays root for the container's whole life; the wrapper traps
   `TERM`/`INT`/`QUIT` and hands `TERM` to the session, `wait`s for it, and exits with the session's
   status (the base entrypoint is PID-agnostic, so running it below the wrapper is supported);
   fall back to `--clear-groups` only if `--init-groups` fails;
4. if the process is *not* root (e.g. `docker run --user 1000`), skip the chown and run a writability
   preflight on `/home/ubuntu` — unwritable ⇒ §4.4's remediation line, exit 78; otherwise `exec` the base
   entrypoint directly, since pid 1 is already uid 1000 and there is no root process to keep.

`setpriv` is used for the same reason the house pattern uses it
([entrypoint](https://raw.githubusercontent.com/prv-ctech/deepseek-harness/HEAD/docker-entrypoint.sh)):
it needs no writable `/etc` and no PAM, so the drop is transparent. `--init-groups` rather than
`--clear-groups` because uid 1000 *has* a passwd entry here (`ubuntu`) and its supplementary groups
(render/video for the GPU path, audio) must survive; `--clear-groups` stays as the fallback.

**Supervision model: pid 1 is the root wrapper and the session is its child.** In the root
path the wrapper never `exec`s over itself, which is what makes §6.3's check — *"the session process uid is
1000 while pid 1 is root"* — satisfiable. It forwards the termination signal `docker stop` sends to pid 1
and exits with the session's status, so the container's lifecycle still ends with the session's.

**Test-only path overrides, for the self-check gate.** `docker-entrypoint.sh` reads three overrides, and
each default is exactly the path this contract names: `DOCKER_ENTRYPOINT_PREFIX` (default `/etc`, which
resolves the base entrypoint to `/etc/container-entrypoint.sh` — step 3 above and §3), `STATE_DIR`
(default `/home/ubuntu` — D7/§5) and `MOUNTINFO` (default `/proc/self/mountinfo`, the file the
unmounted-state warning is read from). They exist for one reason: `scripts/selfcheck.sh` has to exercise
this wrapper on a plain checkout host **where `/home/ubuntu` does not exist and with no container
runtime**, so it must be able to present *both* mount states — a state path with a matching `mountinfo`
entry, and one without — and to point the wrapper at a stub base entrypoint it controls. **Nothing in the
image, `compose.yaml` or the Unraid template sets any of them**, so a container always takes the defaults
and its behaviour is what the rest of this document describes: **unset means unchanged.** They displace
two paths and one read and nothing else — every enforceable outcome in D5/§4.4 (PUID/PGID 1000/1000, the
FATAL text, the chown remediation, the `exit 78` paths) is unconditional and independent of them. The
harness's other test variables (`FAKE_EUID`, `CHOWN_STATUS`, `SETPRIV_INIT_GROUPS`) are read by
`selfcheck.sh`'s own stubs, not by the entrypoint: the entrypoint has exactly these three seams.

**No `usermod` / `groupmod` anywhere — including remap paths.** This is recorded explicitly because a
remap would require `usermod -o -u` / `groupmod -o -g`: uid 1000 already exists as `ubuntu`, so a remap
without `-o` fails with *"UID 1000 already exists"*. We avoid the trap by not remapping at all.

**Why the root step is necessary at all:** Unraid creates a missing host Path **before** the container
starts, with mode `0777` and `@chown($hostConfig, 99); @chgrp($hostConfig, 100);`
([`Helpers.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/Helpers.php),
[spec §4.1](../unraid-ca-puid-pgid-spec.md#41-uid-1000-inside-vs-unraids-99100-outside)). The Selkies
base ends `USER 1000` and is rootless by design, so a container running as 1000 **cannot chown its own
state mount**. Stock Unraid appdata is world-writable so 1000 *usually* works; but a host whose appdata
is the canonical `0755 nobody:users` gives uid 1000 `EACCES`, and the failure surfaces as a Selkies page
that loads but never authenticates — a broken login with no obvious cause. The root step removes that
whole class of failure: the default Unraid flow boots with no user action.

### 4.3 Why non-1000 is rejected instead of remapped

Remapping would have to re-own uid 1000 out of an image that is built around it:

* `/home/ubuntu` ownership, the **build-time `fakeroot` package database**, the root-owned setuid bracket
  (`selkies-privileged-files` — whose entire premise is that uid 1000 does *not* own the setuid files),
  Chrome's profile, and the desktop session defaults all assume uid 1000
  ([base-image docs](https://github.com/selkies-project/selkies/blob/main/docs/components/base-image.md)).
* `usermod -o -u 99 ubuntu` leaves `/home/ubuntu` owned by 1000, so the session user could not write its
  own home (settings, keyring, Claude state) unless the whole home were recursively re-chowned on every
  start — expensive, and it contradicts the image's own runtime model where the supported privileged path
  is `sudo-root selkies-privileged-files run …` for uid 1000.
* Upstream supports exactly one session user at one id. Inventing a second one is unverifiable work with
  no requirement behind it: the team goal and the CA template both specify 1000/1000.

**Failure mode this leaves behind:** a user who edits PUID to 99/100 gets a container that exits
immediately with §4.4's message. That is deliberate, loud and diagnosable, and the Unraid template's
`<Overview>` states the supported value. It is strictly better than a container that boots into a
half-working session.

### 4.4 Exact rejection message (contract text)

```
FATAL: PUID/PGID must be 1000/1000 (got PUID=99 PGID=100).
The Selkies desktop layer is rootless by design at uid 1000: /home/ubuntu, the
build-time fakeroot database and the root-owned setuid bracket all assume that
id, and no supported path remaps it. Set PUID=1000 and PGID=1000 and recreate
the container. If /mnt/user/appdata/claude-code-linux still cannot be written:
  chown -R 1000:1000 /mnt/user/appdata/claude-code-linux
```

### 4.5 Failure modes, behaviour, remediation

| Situation | Behaviour | Remediation |
|---|---|---|
| Unraid creates appdata as `0777 99:100` (stock) | root bootstrap chowns to `1000:1000`, boots | none |
| appdata tightened to `0755 nobody:users` | root bootstrap chowns (root + `CAP_CHOWN`), boots | if the chown itself fails (e.g. root-squashed NFS), the fatal error prints the command | 
| container forced non-root (`docker run --user 1000`, or an Unraid tweak) | preflight fails → exit 78 with the remediation line | run the chown below, or drop `--user` |
| Unraid "New Permissions" / "Docker Safe New Perms" resets appdata to `nobody:users` | next start re-chowns; state stays `1000:1000` | none |
| user edits PUID/PGID | exit 78 with §4.4 | set both back to `1000` |

**The one-line remediation command (exact, quoted in the template `<Overview>` and README):**

```bash
chown -R 1000:1000 /mnt/user/appdata/claude-code-linux
```

**Read-only root filesystem is not supported** on this image (the base entrypoint sets the account
password, timezone and XDG dirs), so `--read-only`/`read_only: true` — which the house pattern does use —
is explicitly out of scope here. `/tmp` may still be a tmpfs.

---

## 5. Runtime shape

| Item | Decision |
|---|---|
| Web port | **`8080/tcp`** published; that is the only port the base documents for the UI (`EXPOSE 8080`, [base Dockerfile](https://raw.githubusercontent.com/selkies-project/selkies/main/addons/base/Dockerfile), [faq](https://raw.githubusercontent.com/selkies-project/selkies/main/docs/faq.md)). |
| Transport | Default `SELKIES_MODE=websocket` — no TURN needed. TURN (`3478/tcp+udp` plus the relay range) is opt-in only for WebRTC mode, documented but not published by the template. |
| `/dev/shm` | **2 GB** (`--shm-size=2g` / `shm_size: 2gb`; compose takes `${CLAUDE_SHM_SIZE:-2gb}`). Docker's default is 64 MB and the browsers in this desktop are killed on it, and 1 GB leaves too little headroom — 2g is what upstream Selkies documents ([spec §4.3](../unraid-ca-puid-pgid-spec.md#43-shm-size-pitfalls-for-a-browserdesktop-container), [egl-desktop compose](https://raw.githubusercontent.com/selkies-project/docker-selkies-egl-desktop/HEAD/docker-compose.yml)). In a CA template this goes in `ExtraParams`; in compose, `shm_size`. |
| State | **`/home/ubuntu`** bind-mounted (Desktop config + Electron `userData`, `~/.claude/.credentials.json`, `~/.claude.json`, `~/.local/share/keyrings`). `/config` is never used as a Target: Unraid globally rewrites the `Default`/`Value` of any Path Config whose Target is `/config` ([spec §4.2](../unraid-ca-puid-pgid-spec.md#42-appdata-path-convention)). |
| Appdata | Template default `/mnt/user/appdata/claude-code-linux` ([spec §4.2](../unraid-ca-puid-pgid-spec.md#42-appdata-path-convention)). |
| Auth | `PASSWD` **must** be provided by the user; the base's default login is `ubuntu`/`mypasswd` and the template must not ship it silently ([faq](https://raw.githubusercontent.com/selkies-project/selkies/main/docs/faq.md)). Selkies' default is legacy mode with HTTP Basic auth enabled ([secure-mode](https://github.com/selkies-project/selkies/blob/main/docs/secure-mode.md)). |
| Host-facing env names (D13) | Host/compose interpolation uses the `CLAUDE_` prefix — `${CLAUDE_PUID:-1000}`, `${CLAUDE_PGID:-1000}`, `${CLAUDE_TZ:-Etc/UTC}`, `${CLAUDE_SHM_SIZE:-2gb}` — while the names handed *to the container* stay plain `PUID`, `PGID`, `TZ`. Reason: compose interpolates the ambient host environment, an Unraid-shaped host exports `PUID=99`/`PGID=100` for its own tooling, and a plain `${PUID}` silently resolved the container to uid 99, which the entrypoint then refused with exit 78 (§0/C2). Never reintroduce un-prefixed `${PUID}`/`${PGID}` in host-facing interpolation. |
| TLS | Served in-container with a self-signed certificate (the base healthcheck itself uses `curl -k`); browsers will warn, and clipboard APIs need a secure context or `localhost` ([usage](https://github.com/selkies-project/selkies/blob/main/docs/usage.md)). |
| Health (D9) | Inherit the base's `HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3` against `https://localhost:8080/api/health` with an HTTP fallback ([base Dockerfile](https://raw.githubusercontent.com/selkies-project/selkies/main/addons/base/Dockerfile)). `/api/health` and `/api/status` stay open for probes even in secure mode ([secure-mode](https://github.com/selkies-project/selkies/blob/main/docs/secure-mode.md)). Do not add a second healthcheck and do not probe `/`. |
| Restart | Unraid emits no `--restart` flag of its own (it manages autostart, [spec §3.2](../unraid-ca-puid-pgid-spec.md#32-restart-unless-stopped)); the compose file uses `restart: unless-stopped`. |

### 5.1 Desktop install and the keyring

* **Install method — the whole chain, as implemented (`scripts/install-claude-desktop.sh`):** fetch
  `key.asc` over TLS and require its SHA256 to equal the build's pin
  (`CLAUDE_DESKTOP_KEY_SHA256=bd70a5e4…`, `Dockerfile:79`); strip the armour and require `gpgv` to report a
  `VALIDSIG` over the repository's `InRelease` whose fingerprint is the documented
  **`31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE`** (`CLAUDE_DESKTOP_KEY_FINGERPRINT`, `Dockerfile:80`); only
  then install that key as `/usr/share/keyrings/claude-desktop-archive-keyring.asc`. The index is bound to
  that signature **before it is parsed**: the `SHA256` the signed `InRelease` lists for
  `main/binary-amd64/Packages` must equal `sha256sum` of the fetched index, and the script refuses to parse
  a mismatch. Read the pinned version's stanza out of the amd64 `Packages` index (Version, `SHA256`, `Filename` and `Architecture`
  from that one stanza — D2's semantics, with the version supplied by the caller instead of derived),
  download the `.deb` from that stanza's `Filename`, and require it to hash to **that stanza's `SHA256`**.
  As an independent check, `apt` is made to validate the documented `deb` line against that keyring with a
  throwaway source list and apt state. The install itself is `apt-get install <local .deb>` with the
  repository unregistered (D10), and the script asserts afterwards that dpkg's version equals the pin and
  that the keyring the package wrote hashes to the same pin. The `.deb` does carry its own copy of the key
  — that is the shortcut for installing a downloaded file by hand, and the docs point at it for that case
  ([docs](https://code.claude.com/docs/en/desktop-linux)) — but the build does not rely on it: the key is
  fetched, hash-pinned and fingerprint-checked first. The chain is therefore unbroken end to end: key hash
  and fingerprint, then the index hash against the signed `InRelease`, then the stanza's fields, then the
  `.deb` hash. The optional `CLAUDE_DESKTOP_SHA256` / `CLAUDE_DESKTOP_DEB_URL` pins CI passes stay a
  cross-check on top, not a substitute for any of it.
* **No apt repo inside the image (D10):** create `/etc/default/claude-desktop` containing
  `CLAUDE_DESKTOP_ADD_REPO="false"` *before* installing, which is the documented way to install without
  registering the repository. Otherwise the package registers `downloads.claude.ai` in
  `/etc/apt/sources.list.d/claude-desktop.list` and `apt upgrade` inside the container could silently
  diverge from the image's pin. The image's version moves when it is rebuilt, not when a user runs apt.
* **Recommends policy:** `--no-install-recommends` plus an explicit allowlist:
  `gnome-keyring ca-certificates libayatana-appindicator3-1 bubblewrap socat libasound2t64 pipewire-alsa
  xdg-desktop-portal-gtk gpgv libsecret-tools`. Deliberately absent: `qemu-system-x86`, `ovmf`, `virtiofsd` — Cowork is out
  of scope (§7.2) and their absence is what keeps the image honest about it. (`libasound2`/`libasound2t64`
  and `pipewire-alsa` are named because PipeWire is the base's audio stack and the app is an ALSA client;
  `xdg-desktop-portal-gtk` because the `.deb`'s Depends names the gtk/gnome/kde portals, not the LXQt one
  the desktop layer installs; `gpgv` because the build verifies the repository's signed `InRelease` and the
  key's fingerprint before trusting a `Version`/`SHA256` pair; `libsecret-tools` because `secret-tool` is how the
  image proves the secret service actually stores a secret — the R2 failure mode.)
* **Keyring (secret service):** install `gnome-keyring` and start `gnome-keyring-daemon` for
  `org.freedesktop.secrets` inside the session, **unlocked**, before Desktop starts. Rationale straight
  from the docs: *"Claude Desktop saves your sign-in in your desktop's keyring… If it can't reach an
  unlocked keyring, your sign-in isn't saved and you sign in again each time you launch the app"*, and
  the fix for *"a desktop other than KDE Plasma"* is `apt install gnome-keyring`. LXQt is not Plasma, so
  gnome-keyring — not KWallet — is the correct component, and the docs warn the two conflict if both are
  present.
* **Unlock without an interactive prompt:** on first start, generate a random password into
  `/home/ubuntu/.config/claude-code-linux/keyring.password` (`0600`, inside the state mount) if it does
  not exist, and feed it to `gnome-keyring-daemon --unlock` on every start. Sign-in therefore survives
  container recreation with no user action and no secret outside the user's own appdata.
* Chrome is unaffected by the keyring because upstream patched it to `--password-store=basic` (§3).
* **Package-layer rule:** any dpkg work in an image layer must be bracketed by
  `selkies-privileged-files release` / `selkies-privileged-files restore` (and re-`chown root:root` +
  `chmod` any *new* setuid helper), or the layer fails when dpkg hardlinks a root-owned setuid file aside
  ([base-image docs](https://github.com/selkies-project/selkies/blob/main/docs/components/base-image.md)).

---

## 6. Versioning, tagging and the update path

### 6.1 Recipe identity

```
recipe = first 12 hex of sha256( CLAUDE_DESKTOP_VERSION \n CLAUDE_CODE_VERSION \n
                                 BASE_IMAGE \n sorted(recipe files: Dockerfile, docker-entrypoint.sh,
                                 rootfs/**, compose.yaml, unraid/*.xml) )
```

Labels stamped on every build (the house pattern's idempotency key, read back from the registry):

| Label | Value |
|---|---|
| `org.opencontainers.image.version` | `CLAUDE_DESKTOP_VERSION` |
| `org.opencontainers.image.source` | `https://github.com/prv-ctech/claude-code-linux` |
| `org.opencontainers.image.licenses` | *(see R3 — filled only after the licensing review)* |
| `com.prvctech.claude-desktop-version` | `CLAUDE_DESKTOP_VERSION` |
| `com.prvctech.claude-code-version` | `CLAUDE_CODE_VERSION` |
| `com.prvctech.claude-base-digest` | resolved `BASE_IMAGE` digest |
| `com.prvctech.claude-recipe` | `recipe` |

### 6.2 Tags (D8)

| Tag | Meaning |
|---|---|
| `:latest` | Moving. **What the Unraid template and `compose.yaml` reference.** Moved only by `docker buildx imagetools create -t <repo>:latest <repo>:<version>` from an already smoke-tested digest; never rebuilt. |
| `:<CLAUDE_DESKTOP_VERSION>` (e.g. `2.26454.2`) | Precision tag for the newest build of that desktop version. **Re-pointed** when the CLI pin or the recipe changes — state plainly that it is *not* byte-immutable. |

No date tags, no `-plus` variant, no Docker Hub mirror, no `arm64` tag (D11).

### 6.3 CI sweep and rebuild reasons

* Trigger: `schedule` cron every 6 hours (a scan, not a build), plus `push` to `main` on recipe paths,
  plus `workflow_dispatch` with `version`/`rebuild` inputs. **No `repository_dispatch`** — the house
  pattern's mechanism is a cron sweep plus an idempotent plan job
  ([build.yml](https://raw.githubusercontent.com/prv-ctech/deepseek-harness/HEAD/.github/workflows/build.yml)).
* One fetch of the apt index per run; it yields both the version and the SHA256 (§2.1). The CLI version
  comes from one packument fetch (§2.2).
* Rebuild when **any** of: the desktop version is new and `>= MIN_VERSION`; the CLI version differs from
  the published label; the recipe hash differs from the published label; the version tag does not exist;
  `rebuild=true` was dispatched. Otherwise "up to date".
* Publish order (gate before publish): build with `load: true` → smoke test → push `:<version>` → move
  `:latest`.
* Smoke test (blocks the push; the "Smoke test (gates the push)" step): the container reaches
  `.State.Health.Status == healthy` without exiting early (health polled up to 60×10s);
  `dpkg-query -W -f='${Version}' claude-desktop` equals the ARG; `claude --version` equals the CLI pin,
  run as the session identity (`-u 1000:1000`, `HOME=/home/ubuntu`) because that is who runs it; pid 1 is
  root while the session identity is `1000:1000` and `/home/ubuntu` ends up owned by `1000:1000`;
  `https://localhost:8080/api/health` answers `200` over the self-signed TLS; the streamed desktop is
  **actually up**, not merely health-answering — `DISPLAY` read from the base's own
  `${XDG_RUNTIME_DIR}/container-env`, its `/tmp/.X11-unix/X<n>` socket present, `xdpyinfo` reporting
  dimensions, and `Xvfb`, `lxqt-session` and `openbox` all running as uid 1000 (bounded settle, 30×2s);
  Google Chrome **executes** as uid 1000, exactly one `google-chrome*` package is installed, its dotted
  `--version` equals that package's version with the Debian revision stripped, and a bounded headless
  `--dump-dom about:blank` produces a DOM; and `docker run -e PUID=99 -e PGID=100 …` exits `78` with the
  message naming the supported values (§4.4).
* Fail loudly on anomalies (no stanza, a version lower than `MIN_VERSION`, a SHA256 mismatch) rather than
  publishing.

### 6.4 How an Unraid user actually receives an update

Unraid detects a newer image by **comparing the registry manifest digest of the tag the user installed**
with the local `RepoDigests` — `getRemoteVersionV2()` HEADs the manifest, `inspectLocalVersion()` reads
`docker inspect` ([`DockerClient.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/DockerClient.php),
[spec §3.4/§3.6](../unraid-ca-puid-pgid-spec.md#34-how-unraid-detects-a-newer-image)). It does **not**
use the template's `<Date>`, which the CA field reference calls legacy
([field reference](https://ca.unraid.net/submit/help/xml-field-reference)). That is exactly why the
template points at the moving `:latest` while immutable precision tags are also published: when CI pushes
a new digest to `:latest`, Unraid shows **"update ready"** and recreates the container from the stored
template with the same Config values; the bind-mounted `/home/ubuntu` path is what carries the sign-in
across that recreation. If the tag never moved, users would never be prompted.

---

## 7. Scope

### 7.1 IS built

| In scope | Detail / owner |
|---|---|
| Selkies desktop streaming layer | Inherited, pinned base image (§3); no fork, no patch of Selkies. |
| Official `claude-desktop` install | Pinned `.deb` + SHA256 verification + no apt repo inside the image (§2.1, §5.1). |
| Chrome-based claude.ai OAuth sign-in | Uses the base's own Chrome; login flow runs inside the streamed desktop (§3, D12). |
| Persisted sign-in via secret service | `gnome-keyring` installed and started unlocked (§5.1). |
| Pinned Claude Code CLI fallback | npm pin + `DISABLE_AUTOUPDATER`/`DISABLE_UPDATES`; state under `/home/ubuntu` (§2.2). |
| Root bootstrap + PUID/PGID guard | Wrapper entrypoint, `setpriv` drop, rejection path (§4). |
| Unraid CA template | `unraid/claude-code-linux.xml`, in-repo, `:latest`, `PUID/PGID Default="1000"`, `/home/ubuntu` path Config, `ExtraParams` `--shm-size=2g`, `<Overview>` stating the chown line and supported PUID/PGID. |
| GitHub Actions | Build + 6-hourly upstream sweep + publish + `:latest` move (§6). |
| `compose.yaml` | `${VAR:-default}` everywhere, 8080, `shm_size: ${CLAUDE_SHM_SIZE:-2gb}`, `restart: unless-stopped`; host-facing interpolation is `CLAUDE_`-prefixed (D13, §0/C2). |
| Docs | README, `.env.example`, this document. |

### 7.2 IS NOT built (explicit non-goals)

| Out of scope | Why |
|---|---|
| **arm64** | Both apps publish arm64, but this project ships amd64 only: emulated/extra builds for a target nobody asked for, and the house pattern is amd64-only. No `Dockerfile.aarch64`. |
| **Cowork (QEMU/KVM)** | Needs `/dev/kvm` and `/dev/vhost-vsock`; the docs say the missing case is common in containers. The template grants no devices and qemu/ovmf/virtiofsd are not installed (R1). |
| **Computer Use** | *"isn't available on Linux"* ([docs](https://code.claude.com/docs/en/desktop-linux)). |
| **Dictation** | Not available in the Linux desktop app; CLI voice dictation only. |
| **Quick Entry global hotkey on native Wayland** | Works on X11; on native Wayland it needs the desktop's GlobalShortcuts portal. We run X11 by default. |
| **CLI-only fallback image** | The CLI ships *inside* the same image (§2.3); no second tag, no `-cli` variant. |
| **`chromium-browser` / snap Chromium** | Transitional deb to the snap; does not work here (D12). |
| **Any self-update inside the container** | Anthropic's apt repo is not registered and the CLI updater is disabled (D10). |
| **`--read-only` rootfs, `--privileged`, seccomp overrides by default** | Not needed: the base already handles Chrome's sandbox and the desktop needs writable `/etc`/`/tmp` (§4.5). Add only if a verifier proves a concrete failure. |
| **Docker Hub, multi-arch buildx, date tags** | GHCR only, `linux/amd64` only (§6.2). |

---

## 8. Risk register

| # | Risk | Mitigation / accepted risk |
|---|---|---|
| **R1** | **Cowork cannot run.** It requires QEMU + UEFI firmware, hardware virtualization, `/dev/kvm` **and** `/dev/vhost-vsock`; Anthropic's docs state that a kernel without `vhost_vsock` support *"is common on ChromeOS and in container-based Linux environments"*. | **Accepted, with a mitigation for usefulness:** the Unraid template adds no `--device /dev/kvm|/dev/vhost-vsock` and the image does not install qemu/ovmf/virtiofsd, so the Cowork tab reports its requirement instead of half-failing. The pinned **Claude Code CLI ships in the same image** as the documented fallback (§2.3), and the README states Cowork is unsupported. A user who wants to try it may add the devices themselves; no support claim is made. |
| **R2** | **Sign-in is not persisted** if the secret-service keyring is missing or locked. Claude Desktop *"saves your sign-in in your desktop's keyring"* and *"If it can't reach an unlocked keyring, your sign-in isn't saved"*; LXQt is not KDE Plasma, so KWallet is not the answer and the docs' remedy for a non-Plasma desktop is to install gnome-keyring. | **Mitigated:** `gnome-keyring` installed explicitly (the `.deb` only *recommends* it, and we install with `--no-install-recommends`), `gnome-keyring-daemon` started for `org.freedesktop.secrets`, and unlocked with a password generated once into the state mount (§5.1). Verification: sign in, quit the container, recreate it, confirm the app opens signed in. |
| **R3** | **Redistribution of a proprietary binary.** The published image contains Anthropic's closed-source `.deb`; the repo's own license text is *"© Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial Terms of Service"*, which grants no redistribution right. | **Mitigated by withholding distribution:** the GHCR package stays **private** until the terms are reviewed; the `.deb` is never vendored into this repository (it is fetched from Anthropic's own repository at build time and verified by SHA256); `org.opencontainers.image.licenses` is left unset until review; the README states the restriction. Residual: making the package public is a licensing decision, not an engineering one. |
| **R4** | **The image is multiple GB.** Selkies desktop (X11/Wayland/audio/GPU/s6/coTURN/web client) + Google Chrome + Firefox + 181 MB of Claude `.deb` (~589 MB installed) + LXQt + npm CLI. | **Mitigated, and partly accepted:** single arch, no qemu/ovmf/virtiofsd, `--no-install-recommends` everywhere, apt lists/caches cleaned per layer, one variant only, base layers shared. CI records the compressed and uncompressed size in the run summary. The size itself is accepted: a streamed desktop with two browsers and the app cannot be small. |
| **R5** | **No build verification is possible in this workspace.** There is no `docker`, `podman`, `buildah` or `nerdctl` binary and no `/var/run/docker.sock` on the host (host is Debian 12, x86_64). | **Accepted; verification is relocated, not skipped:** every build/run check happens in GitHub Actions (`ubuntu-latest` has Docker) or on the user's own host. CI must produce the evidence (smoke-test log, `docker inspect` health, version assertions, rejection-path exit code) as run artifacts, and the verifier task must cite CI output rather than claim a local build. Local reproducibility steps are documented in the README. |
| **R6** | **Version-signal drift.** The index is append-only and the scheme already jumped `1.x`→`2.x`; a naive string compare (or a max scan of npm versions — see §2.2) publishes the wrong version. | **Mitigated:** one fetch per run feeding both fields; `sort -V`; SHA256 taken from the same stanza; `MIN_VERSION` floor; build-time equality assertions against `dpkg-query`/`claude --version`; CI fails loudly instead of publishing on a missing stanza or a downgrade. |
| **R7** | **Unraid appdata ownership.** Unraid pre-creates the path `0777 99:100`, and its maintenance tools ("New Permissions") can reset ownership later. | **Mitigated:** the root bootstrap re-chowns on every start (§4.2), the exact `chown` remediation line is printed on failure and quoted in the template `<Overview>`, and a non-root start fails fast with that line. Residual: a root-squashed network appdata share cannot be chowned by the container — the same line then has to be run on the server holding the share. |
| **R8** | **Exposure.** The streamed desktop is a full browser session holding the user's claude.ai and Claude Code credentials; Selkies' base default login is `ubuntu`/`mypasswd`, TLS is self-signed, and there is exactly one port in front of it. | **Mitigated by configuration:** the template/compose require `PASSWD` and refuse to start without it, only `8080` is published (TURN is opt-in), and the README states plainly that this port must not be exposed to the Internet without a reverse proxy and TLS. Accepted residual: a user who publishes 8080 without a password owns that outcome. |
| **R9** | **Two upstreams drift apart.** The CLI pinned in the image can fall behind the desktop app's expectations, or vice versa. | **Accepted with tracking:** both versions are resolved by the same sweep and both are stamped as OCI labels, so either moving produces a rebuild and an auditable image (§6.1). |

---

## 9. Sources

| Claim area | Source |
|---|---|
| Desktop: apt-only distribution, signing key, no self-update, keyring, Cowork/KVM, unsupported features | <https://code.claude.com/docs/en/desktop-linux> |
| Desktop version index (the signal) | <https://downloads.claude.ai/claude-desktop/apt/stable/dists/stable/main/binary-amd64/Packages> |
| Signing key | <https://downloads.claude.ai/claude-desktop/key.asc> |
| `anthropics/claude-code` is the CLI, not the desktop app | <https://github.com/anthropics/claude-code> · <https://raw.githubusercontent.com/anthropics/claude-code/HEAD/README.md> · <https://raw.githubusercontent.com/anthropics/claude-code/HEAD/LICENSE.md> |
| CLI npm dist-tags / release signal | <https://registry.npmjs.org/@anthropic-ai/claude-code> · <https://api.github.com/repos/anthropics/claude-code/releases/latest> |
| CLI pinning in a Dockerfile, `DISABLE_AUTOUPDATER` | <https://code.claude.com/docs/en/devcontainer.md> · <https://code.claude.com/docs/en/env-vars.md> |
| CLI credentials path (Linux, `0600`) | <https://code.claude.com/docs/en/authentication.md> |
| Selkies base: rootless uid 1000, fakeroot, setuid bracket, `/home/ubuntu`, service set | <https://github.com/selkies-project/selkies/blob/main/docs/components/base-image.md> · <https://raw.githubusercontent.com/selkies-project/selkies/main/addons/base/Dockerfile> |
| Selkies desktop layer: LXQt, Chrome `.deb` + launcher patch, `USER 1000` | <https://github.com/selkies-project/selkies/blob/main/docs/components/desktop-image.md> · <https://raw.githubusercontent.com/selkies-project/selkies/main/addons/desktop/Dockerfile> |
| Selkies health routes open for probes | <https://github.com/selkies-project/selkies/blob/main/docs/secure-mode.md> |
| Selkies run example, port 8080, default `ubuntu`/`mypasswd` | <https://github.com/selkies-project/selkies/blob/main/docs/faq.md> |
| Unraid: appdata pre-created `0777 99:100` | <https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/Helpers.php> |
| Unraid: digest-based update detection, `/config` rewrite | <https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/DockerClient.php> · <https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/CreateDocker.php> |
| Unraid: `<Date>` is legacy | <https://ca.unraid.net/submit/help/xml-field-reference> |
| Docker 64 MB default `/dev/shm`; upstream Selkies ships `shm_size: '2gb'`; PUID/PGID rationale | <https://docs.docker.com/reference/cli/docker/container/run/> · <https://raw.githubusercontent.com/selkies-project/docker-selkies-egl-desktop/HEAD/docker-compose.yml> · <https://docs.linuxserver.io/general/understanding-puid-and-pgid/> |
| House pattern: ARG pin + version assertion, cron sweep, recipe hash label, `imagetools create` `:latest`, `setpriv` entrypoint | <https://raw.githubusercontent.com/prv-ctech/deepseek-harness/HEAD/Dockerfile> · <https://raw.githubusercontent.com/prv-ctech/deepseek-harness/HEAD/docker-entrypoint.sh> · <https://raw.githubusercontent.com/prv-ctech/deepseek-harness/HEAD/.github/workflows/build.yml> |
| Selkies + Unraid analogue (template/CI shape) | <https://github.com/shoyrock/Brave-Origin> · <https://github.com/selkies-project/docker-selkies-egl-desktop> |
| Workspace research artifacts | [`docs/research/reference-architecture.md`](research/reference-architecture.md) · [`unraid-ca-puid-pgid-spec.md`](../unraid-ca-puid-pgid-spec.md) · [`claude-code-distribution-report.md`](../claude-code-distribution-report.md) |

---

## 10. Acceptance map

| Acceptance criterion | Where satisfied | Observable check |
|---|---|---|
| Desktop version signal = apt index max `Version` via `sort -V` + matching `SHA256`; `anthropics/claude-code` is not the desktop channel | §2.1, D2 | Re-run Appendix A; output must be `2.26454.2` / `b251a022…`; grep `claude-code` never appears in the desktop resolver. |
| PUID/PGID decided: 1000/1000 default and primary; other values chosen explicitly and justified against the rootless base + setuid bracket | §4, D5/D6 | `docker run -e PUID=99` exits 78 with §4.4; default start owns `/home/ubuntu` as `1000:1000`. |
| Base image pinning fixed: `ARG BASE_IMAGE` default `ghcr.io/selkies-project/selkies/desktop:2.0.0-ubuntu26.04`; why the reference desktop | §3, D4 | `grep -n 'ARG BASE_IMAGE' Dockerfile` shows the literal; image labels record the resolved digest. |
| Scope table lists what IS / IS NOT built | §7 | Table rows present; CI never produces arm64 or qemu packages; no `chromium-browser`. |
| Risk register ≥5 named risks with mitigations | §8 (R1–R9) | R1, R2, R3, R4, R5 present with mitigation or explicit acceptance. |
| Every factual claim carries a source URL; exact version + SHA256 recorded | §9 and §2.1 | `2.26454.2` + `b251a0224a8635874f33598df8ed8952b427f84815ee59580cc022d6bdb2430f` appear in §2.1. |
| Two tracked upstreams, both observed values named | §2.1, §2.2, §6 | Desktop `2.26454.2`; CLI `latest 2.1.294` (with the `next 2.1.295` trap documented). |

---

## Appendix A — version resolver (verified) and observed output

```sh
#!/bin/sh
set -eu
INDEX_URL="https://downloads.claude.ai/claude-desktop/apt/stable/dists/stable/main/binary-amd64/Packages"
idx=$(mktemp); trap 'rm -f "$idx"' EXIT
curl -fsSL "$INDEX_URL" -o "$idx"
row=$(awk -v RS='' '
  {
    n = split($0, L, "\n");
    if (L[1] != "Package: claude-desktop") next;
    v = ""; s = ""; f = "";
    for (i = 1; i <= n; i++) {
      if (L[i] ~ /^Version: /)  v = substr(L[i], 10);
      if (L[i] ~ /^SHA256: /)   s = substr(L[i], 9);
      if (L[i] ~ /^Filename: /) f = substr(L[i], 11);
    }
    if (v != "") print v, s, f;
  }' "$idx" | sort -V | tail -n 1)
CLAUDE_DESKTOP_VERSION=$(printf '%s' "$row" | cut -d' ' -f1)
CLAUDE_DESKTOP_SHA256=$(printf '%s' "$row" | cut -d' ' -f2)
CLAUDE_DESKTOP_DEB=$(printf '%s' "$row" | cut -d' ' -f3)
echo "VERSION=$CLAUDE_DESKTOP_VERSION"
echo "SHA256=$CLAUDE_DESKTOP_SHA256"
echo "DEB_URL=https://downloads.claude.ai/claude-desktop/apt/stable/$CLAUDE_DESKTOP_DEB"
```

Observed (2026-10-08, exit 0):

```
STANZAS=50
VERSION=2.26454.2
SHA256=b251a0224a8635874f33598df8ed8952b427f84815ee59580cc022d6bdb2430f
DEB_URL=https://downloads.claude.ai/claude-desktop/apt/stable/pool/main/c/claude-desktop/claude-desktop_2.26454.2_amd64.deb
```

The CI may reimplement this; it may **not** change the semantics (single fetch, stanza-scoped
`Version`+`SHA256`, `sort -V`, last line wins).

## Appendix B — commands run at authoring time

| Command | Result |
|---|---|
| [Appendix A resolver](#appendix-a--version-resolver-verified-and-observed-output) | `2.26454.2` / `b251a022…`, 50 stanzas, exit 0 |
| `curl -fsSI https://downloads.claude.ai/…/claude-desktop_2.26454.2_amd64.deb` | HTTP 200 |
| `curl -fsSL https://registry.npmjs.org/@anthropic-ai/claude-code` | `dist-tags` = `{stable 2.1.286, latest 2.1.294, next 2.1.295}`, 537 versions |
| `curl -sS https://registry.npmjs.org/@anthropic-ai/claude-code/-/package.json` | `{"code":"ResourceNotFound"}` |
| `curl -fsSL https://api.github.com/repos/anthropics/claude-code/releases/latest` | `v2.1.294` @ 2026-10-08T05:03:54Z |
| GHCR tag list for `selkies-project/selkies/desktop` | `-ubuntu26.04` tags: `main-`, `latest-`, `2.0.0rc0-`, `2.0.0rc1-`, `2.0.0-`; `latest-` and `2.0.0-` share digest `sha256:17366ded…` |
| `grep -n 'HEALTHCHECK\|EXPOSE\|^USER\|ENTRYPOINT' addons/base/Dockerfile` | `USER 1000`; `ENV SELKIES_PORT=8080`; `EXPOSE 8080`; `HEALTHCHECK … --start-period=60s … /api/health`; `ENTRYPOINT ["/etc/container-entrypoint.sh"]` |
| `which docker podman buildah nerdctl` | none found (exit 1); no `/var/run/docker.sock`; host Debian 12, `x86_64` |

**No open questions.** Every decision above is closed; the implementer implements it, the verifier
falsifies it, the reviewer checks this document against the code.
