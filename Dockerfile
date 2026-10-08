# syntax=docker/dockerfile:1
#
# claude-code-linux — the Selkies reference desktop with the official Claude
# Desktop for Linux package and the pinned Claude Code CLI layered on top.
# Every decision below is docs/DESIGN.md; §/D references point at it.
#
# WHAT THIS FILE ADDS, AND WHY ONLY THIS
#   The streamed desktop, X11 and the Wayland capture stack, PipeWire audio,
#   LXQt with Openbox, Google Chrome (already sandbox- and password-store-patched
#   by the upstream layer) and the s6 supervision tree all come from the pinned
#   base image (§3, D4, D12). This file adds four things: the Anthropic signing
#   key (verified, not merely trusted), the official `claude-desktop` package at
#   a pinned version, the secret service that the claude.ai sign-in is stored in,
#   and the pinned Claude Code CLI.
#
# THE ONE PATH TO MOUNT
#   /home/ubuntu
#   Mount a volume there (Unraid: Path → Container /home/ubuntu, Host Path
#   /mnt/user/appdata/claude-code-linux). It holds everything that has to
#   survive container recreation: Claude Desktop's Electron userData, the keyring
#   that stores the sign-in (~/.local/share/keyrings, plus the generated password
#   in ~/.config/claude-code-linux/keyring.password), the Chrome profile the
#   OAuth flow runs in (~/.config/google-chrome), and the CLI's
#   ~/.claude/.credentials.json and ~/.claude.json. /config is never used (D7):
#   Unraid rewrites a Path Config whose Target is /config to its own app-config
#   path, which makes the mount host-dependent. docker-entrypoint.sh warns at
#   start when nothing is mounted there, because without the mount the sign-in
#   is silently lost on recreation.
#
# THE BUILD IS ROOTLESS, SO PACKAGE LAYERS ARE BRACKETED
#   The base is rootless by design: its layers run as uid 1000 through fakeroot
#   and the whole filesystem belongs to the session user, while the setuid and
#   setgid files belong to root. dpkg replaces a file by hardlinking the old one
#   aside first, and the kernel denies uid 1000 a hardlink to a root-owned setuid
#   file, so a layer that installs packages is wrapped in the image's own
#   `selkies-privileged-files release` / `restore` pair, and a setuid helper that
#   a new package brings (here chrome-sandbox) is named and re-owned by hand.
#
# PUID/PGID
#   1000/1000 exclusively (D5). The image runs USER 0 so that
#   docker-entrypoint.sh can take ownership of a state path Unraid pre-created as
#   0777 99:100 and then drop to uid 1000 for the rest of the container's life
#   (D6). Any other PUID/PGID exits 78 with the message in §4.4. No remap path
#   exists: /home/ubuntu, the build-time fakeroot package database and the
#   root-owned setuid bracket all assume uid 1000.
#
# THE IMAGE DOES NOT SELF-UPDATE (D10)
#   Anthropic's apt repository is not registered inside it — /etc/default/
#   claude-desktop is written with CLAUDE_DESKTOP_ADD_REPO="false" before the
#   package is installed — and the CLI cannot update itself. A new version of
#   either arrives by rebuilding this image, which is what the CI sweep does
#   (§6.3). The repository's own deb line is still what the build verifies
#   against, in scripts/install-claude-desktop.sh:
#     deb [arch=amd64,arm64 signed-by=/usr/share/keyrings/claude-desktop-archive-keyring.asc] https://downloads.claude.ai/claude-desktop/apt/stable stable main
#
# Labels: the two version labels below are stamped here; the resolved base digest,
# the recipe hash and the license label are the CI build's to stamp (§6.1, R3).

ARG BASE_IMAGE=ghcr.io/selkies-project/selkies/desktop:2.0.0-ubuntu26.04
FROM ${BASE_IMAGE}

# ---------------------------------------------------------------------------
# Pinned upstreams (both observed 2026-10-08; the CI resolves the same two
# signals and passes what it resolved — §2, §6.3).
# ---------------------------------------------------------------------------
# Claude Desktop: the maximum `Version` stanza of the Anthropic apt index. The
# app does not update itself on Linux, so this pin plus an image rebuild is the
# update mechanism.
ARG CLAUDE_DESKTOP_VERSION=2.26454.2
# Claude Code CLI: npm `dist-tags.latest`. Never a max scan of versions[], where
# dist-tags.next sits ahead of latest and would publish an unreleased build.
ARG CLAUDE_CODE_VERSION=2.1.294
# The Anthropic Claude Code signing key, fingerprint
# 31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE. The SHA256 is the pin over
# the key's own bytes (the same file is served as
# downloads.claude.ai/claude-desktop/key.asc and .../keys/claude-code.asc, and
# the .deb carries it verbatim). install-claude-desktop.sh refuses to install
# anything unless the repository's signed InRelease verifies against both.
ARG CLAUDE_DESKTOP_KEY_SHA256=bd70a5e4a268002704024ceba7f8446024114e94f3f0bdd11c23a9e592be81c6
ARG CLAUDE_DESKTOP_KEY_FINGERPRINT=31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE
# Optional cross-checks, passed by the CI sweep and empty for a manual build: the
# SHA256 and the deb URL the caller resolved from the same index. When they are
# given, the build fails if the index no longer agrees with them — the index is
# append-only, so a disagreement means the pin or the caller's snapshot is wrong,
# and it is better to fail than to install a package nobody verified.
ARG CLAUDE_DESKTOP_SHA256=
ARG CLAUDE_DESKTOP_DEB_URL=
# Cowork is a KVM feature and is NOT installed by default (§7.2, R1). It needs
# /dev/kvm AND /dev/vhost-vsock (openable only by the kvm group), ~25 GB of disk
# and 8 GB of RAM, and Anthropic's own documentation says that combination is
# commonly missing in container-based Linux environments — the Unraid template
# grants no devices. The pinned CLI in this same image is the path that stays
# useful without it. To opt in:
#   docker build --build-arg CLAUDE_DESKTOP_COWORK=true -t claude-code-linux .
#   docker run --device /dev/kvm --device /dev/vhost-vsock --group-add kvm --shm-size=1g -p 8080:8080 claude-code-linux
# (plus the memory and disk the VM itself needs). Without this ARG, the build
# asserts that qemu-system-x86, ovmf and virtiofsd are absent, so the Cowork tab
# reports its requirement instead of half-failing.
ARG CLAUDE_DESKTOP_COWORK=false

LABEL org.opencontainers.image.title="claude-code-linux" \
      org.opencontainers.image.description="Claude Desktop for Linux and the Claude Code CLI on the Selkies streaming desktop" \
      org.opencontainers.image.source="https://github.com/prv-ctech/claude-code-linux" \
      org.opencontainers.image.version="${CLAUDE_DESKTOP_VERSION}" \
      com.prvctech.claude-desktop-version="${CLAUDE_DESKTOP_VERSION}" \
      com.prvctech.claude-code-version="${CLAUDE_CODE_VERSION}"

# PUID/PGID are the Selkies session user's id. Enforced at start, never remapped.
ENV PUID=1000 \
    PGID=1000

# Neither application may mutate this container; it moves when the image is
# rebuilt (D10). DISABLE_AUTOUPDATER stops the CLI's background update check.
# DISABLE_UPDATES is the documented stronger seal — it blocks `claude update` and
# `claude install` too, which is what "distributing Claude Code through your own
# channels" means — and it is set as well. A user who wants `claude update` to
# work inside the session can start the container with -e DISABLE_UPDATES=0 and
# keep the background check off; what changes then is that one container, never
# the image the next container starts from.
ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_UPDATES=1

# CLAUDE_CONFIG_DIR is deliberately NOT set (§2.2): with HOME=/home/ubuntu the CLI
# keeps ~/.claude/.credentials.json and the separate ~/.claude.json under the one
# mounted state path. Pointing CLAUDE_CONFIG_DIR anywhere else would split the
# CLI's sign-in away from the volume the user mounts — and mounting only
# ~/.claude would not preserve it either.
#
# Nothing else is added to the runtime environment: audio needs no work (PipeWire
# and pipewire-pulse already run with PULSE_SERVER on the session's runtime dir,
# SELKIES_AUDIO_ENABLED defaults true and microphone forwarding stays the opt-in
# SELKIES_MICROPHONE_ENABLED), and the base's own defaults for SELKIES_PORT,
# SELKIES_MODE and TLS are what the template documents.
#
# Health and port are the base's: HEALTHCHECK on
# https://localhost:${SELKIES_PORT}/api/health with a 60s start period, /api/health
# and /api/status open for probes, EXPOSE 8080 (D9). Neither is repeated here — a
# second healthcheck on the same route would only race the first.

# The base leaves the fakeroot SHELL active from the layer that installed its own
# packages, and ends as USER 1000. Every phase below states the user and the shell
# it means, and this file closes as USER 0 because docker-entrypoint.sh needs one
# root step before it drops to uid 1000 (§4.2).
USER 0
SHELL ["/bin/sh", "-c"]

# ---------------------------------------------------------------------------
# The files this image adds. Copied before the package bracket so that the
# bracket only ever owns package state.
# ---------------------------------------------------------------------------
# rootfs/ carries three entry points and two autostart entries:
#   /usr/local/bin/claude-keyring-init    starts and unlocks the secret service
#   /usr/local/bin/claude-desktop-session starts the app once that is up
#   /usr/local/bin/claude-desktop         the app's launcher (sandbox probe)
#   /etc/xdg/autostart/10-…, 20-…         what lxqt-session starts
COPY --chown=1000:1000 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --chown=1000:1000 scripts/install-claude-desktop.sh /usr/local/bin/install-claude-desktop.sh
COPY --chown=1000:1000 rootfs/ /
RUN set -eu; \
    for f in /usr/local/bin/docker-entrypoint.sh \
             /usr/local/bin/install-claude-desktop.sh \
             /usr/local/bin/claude-desktop \
             /usr/local/bin/claude-desktop-session \
             /usr/local/bin/claude-keyring-init \
             /etc/xdg/autostart/10-claude-code-linux-keyring.desktop \
             /etc/xdg/autostart/20-claude-code-linux-claude-desktop.desktop \
             /etc/xdg/mimeapps.list; do \
        test -e "${f}" || { echo "FATAL: the build did not copy ${f}" >&2; exit 1; }; \
    done; \
    chmod 755 /usr/local/bin/docker-entrypoint.sh \
              /usr/local/bin/install-claude-desktop.sh \
              /usr/local/bin/claude-desktop \
              /usr/local/bin/claude-desktop-session \
              /usr/local/bin/claude-keyring-init; \
    chmod 644 /etc/xdg/autostart/10-claude-code-linux-keyring.desktop \
              /etc/xdg/autostart/20-claude-code-linux-claude-desktop.desktop \
              /etc/xdg/mimeapps.list; \
    test -x /etc/container-entrypoint.sh; \
    test -d /etc/service; \
    test -x /usr/local/bin/selkies-privileged-files; \
    if [ "$(dpkg --print-architecture)" != "amd64" ]; then \
        echo "FATAL: this image is amd64 only (D11), got $(dpkg --print-architecture)" >&2; \
        exit 1; \
    fi; \
    echo "base entrypoint and s6 service set present; arch amd64"

# ---------------------------------------------------------------------------
# Package layer 1 — the keyring the sign-in needs, plus the rest of the
# recommends allowlist (§5.1). Every package is named for the same reason: the
# layer installs with --no-install-recommends, so a Recommendations-only package
# (`gnome-keyring`) has to be asked for by name.
#   ca-certificates            the app's own TLS trust store
#   gnome-keyring              the secret service Claude Desktop stores the
#                              claude.ai sign-in in. gnome-keyring and not
#                              KWallet: LXQt is not KDE Plasma, and Anthropic's
#                              documentation names gnome-keyring as the fix for
#                              a desktop other than Plasma. The two conflict if
#                              both are installed, so only one is.
#   libsecret-1-0              what the app talks to that service with (the .deb
#                              Depends on it; naming it keeps it alongside the
#                              daemon rather than implicit)
#   libsecret-tools            `secret-tool`, which claude-keyring-init uses to
#                              store and read a probe secret back at session
#                              start: a daemon that answers on its socket is not
#                              the same thing as an unlocked keyring, and that is
#                              exactly the difference the app's documentation
#                              warns about
#   libayatana-appindicator3-1 the app's tray icon
#   bubblewrap socat           the app's sandbox and socket helpers
#   libasound2t64 pipewire-alsa  PipeWire is the base's audio stack and the app
#                              is an ALSA client
#   xdg-desktop-portal-gtk     the .deb Depends on one of the gtk/gnome/kde
#                              portals. At runtime XDG_CURRENT_DESKTOP=LXQt
#                              selects the LXQt portal the desktop layer already
#                              ships — this is the backend for the interfaces
#                              that one does not implement.
#   gpgv                       install-claude-desktop.sh verifies the
#                              repository's signature and reads the fingerprint
#                              out of it with this. apt needs a signature
#                              verifier of its own, which need not be this one,
#                              so it is installed explicitly rather than assumed.
#   nodejs npm                 Node 22+ because the CLI's `engines` requires it
#                              (Ubuntu 26.04 ships 22.22); npm because installing
#                              the CLI pinned is the documented way to reproduce
#                              a version, unlike the devcontainer feature whose
#                              tag pins only its install script.
#
# `release`, in the root phase that installed the files above, hands the
# root-owned setuid and setgid files to the session user for the duration of the
# package work; `restore` at the end of this file gives every recorded owner and
# bit back. This is the pair the base documents for a layer that installs
# packages.
# ---------------------------------------------------------------------------
RUN selkies-privileged-files release

# fakeroot makes the package work look like root to dpkg while the files stay
# owned by the session user — the base's own model, and the reason an in-session
# `sudo apt-get install` behaves the same way.
USER 1000
SHELL ["/usr/bin/fakeroot", "--", "/bin/sh", "-c"]
# DL3008: no package version pins — the base image does not pin either, and a
#   pinned Ubuntu version stops resolving the day the archive moves it, failing
#   this build for no security gain (the image is rebuilt on every upstream move).
# DL4006: the only pipe is `dpkg-query | grep -q` inside an `if`, where grep's
#   status is the answer and dpkg-query's failure is the normal "not installed".
#   `pipefail` is not wanted, and dash — the /bin/sh here — has none.
# SC1008: these layers run under the fakeroot SHELL, which hadolint cannot read as
#   a shebang and therefore skips. Every RUN body in this file was checked
#   separately as POSIX sh with `shellcheck -s sh`.
# hadolint ignore=DL3008,DL4006,SC1008
RUN set -eu; \
    apt-get clean; \
    apt-get update; \
    apt-get install --no-install-recommends -y \
        ca-certificates \
        gnome-keyring \
        libsecret-1-0 \
        libsecret-tools \
        libayatana-appindicator3-1 \
        bubblewrap \
        socat \
        libasound2t64 \
        pipewire-alsa \
        xdg-desktop-portal-gtk \
        gpgv \
        nodejs \
        npm; \
    if [ "${CLAUDE_DESKTOP_COWORK}" = "true" ]; then \
        echo "Cowork requested: installing qemu-system-x86, ovmf and virtiofsd (the devices are still the caller's to pass)"; \
        apt-get install --no-install-recommends -y qemu-system-x86 ovmf virtiofsd; \
    else \
        for pkg in qemu-system-x86 ovmf virtiofsd; do \
            if dpkg-query -W -f='${Status}' "${pkg}" 2>/dev/null | grep -q 'install ok installed'; then \
                echo "FATAL: ${pkg} is installed but CLAUDE_DESKTOP_COWORK is not true" >&2; \
                exit 1; \
            fi; \
        done; \
        echo "Cowork (qemu-system-x86 ovmf virtiofsd) not installed: --build-arg CLAUDE_DESKTOP_COWORK=true opts in (§7.2, R1)"; \
    fi; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/* /var/cache/debconf/* /var/log/* /tmp/* /var/tmp/*

# ---------------------------------------------------------------------------
# Package layer 2 — the official Claude Desktop package, SHA256-verified against
# the stanza it came from, installed from the local file with the apt repository
# left unregistered (D10). The script also proves the signing key by
# fingerprint before it downloads anything.
#
# CLAUDE_DESKTOP_SHA256 and CLAUDE_DESKTOP_DEB_URL are the CI's own resolution of
# the same two fields. The build re-resolves them from the signed index and fails
# if the two disagree; empty means "resolve, do not cross-check".
#
# It runs its own `apt-get update` because it resolves the package's Depends from
# the archive, and the layer above cleaned the lists.
# ---------------------------------------------------------------------------
# SC1008 (fakeroot SHELL, as above; the body was checked with `shellcheck -s sh`)
# hadolint ignore=SC1008
RUN set -eu; \
    /usr/local/bin/install-claude-desktop.sh \
        "${CLAUDE_DESKTOP_VERSION}" \
        "${CLAUDE_DESKTOP_KEY_SHA256}" \
        "${CLAUDE_DESKTOP_KEY_FINGERPRINT}" \
        "${CLAUDE_DESKTOP_SHA256}" \
        "${CLAUDE_DESKTOP_DEB_URL}"; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/* /var/cache/debconf/* /var/log/* /tmp/* /var/tmp/*

# ---------------------------------------------------------------------------
# Package layer 3 — the Claude Code CLI, pinned, from npm.
#
# WHY THE CLI IS IN THIS IMAGE AT ALL (§2.3, R1): Cowork is a QEMU/KVM feature
# and the Unraid template grants no KVM devices, so the agentic path that works
# here is the CLI, which runs the same engine and needs no virtualisation. It is
# usable without an interactive terminal: the streamed desktop's own terminal
# (qterminal, and SELKIES_COMMAND_ENABLED is true in the desktop layer) runs it as
# the session user, and from the host it is
#   docker exec -u 1000 -it <container> claude
# — -u 1000 because pid 1 is root here and no session process is root; the CLI
# refuses to run as root. `claude --version` is asserted as uid 1000 at the end of
# this file, and the CI smoke test asserts it again against the pin (§6.3).
#
# The install is pinned exactly, not by a range, and not through the Anthropic
# devcontainer feature: the feature installs the latest CLI and its version tag
# pins only its own install script (§2.2). The npm cache is kept out of
# /home/ubuntu so the image does not seed the state mount with a package cache.
# ---------------------------------------------------------------------------
# SC1008 (fakeroot SHELL, as above; the body was checked with `shellcheck -s sh`)
# hadolint ignore=SC1008
RUN set -eu; \
    npm install -g --no-fund --no-audit --cache /tmp/npm-cache \
        "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"; \
    rm -rf /tmp/npm-cache; \
    cli_root="$(npm root -g)"; \
    cli_version="$(node -p "require('${cli_root}/@anthropic-ai/claude-code/package.json').version")"; \
    if [ "${cli_version}" != "${CLAUDE_CODE_VERSION}" ]; then \
        echo "FATAL: installed @anthropic-ai/claude-code ${cli_version}, pinned ${CLAUDE_CODE_VERSION}" >&2; \
        exit 1; \
    fi; \
    test -x "${cli_root}/@anthropic-ai/claude-code/bin/claude.exe"; \
    command -v claude > /dev/null; \
    echo "claude-code ${cli_version} installed and on PATH"

# ---------------------------------------------------------------------------
# Close the bracket: real root, outside the fakeroot shell.
# ---------------------------------------------------------------------------
# Under fakeroot an ownership change lands only in fakeroot's database while the
# mode change goes through to the filesystem, which leaves a setuid bit on a file
# uid 1000 owns — and the kernel refuses to honor that. So `restore` and the
# re-owning below both need this shell.
#
# chrome-sandbox is the one setuid helper the package brings and no record covers
# it (it was created by the fakeroot layer above, after `release` recorded what
# existed). It is chowned root:root and given mode 4755 exactly as the archive
# ships it: Electron's zygote needs either unprivileged user namespaces or a
# correctly configured setuid helper, and a helper that exists with the setuid bit
# ignored is worse than none. The fix does not weaken the session user's ability
# to run the app — the app execs the helper, it does not own it.
#
# The same phase proves what the image claims: the base's own setuid path is
# intact (sudo-root is what lets the session set its own PASSWD), the base
# entrypoint is still there, the three commands the container is judged by
# resolve, and the CLI really executes as the session user.
USER 0
SHELL ["/bin/sh", "-c"]
RUN set -eu; \
    selkies-privileged-files restore; \
    helper=/usr/lib/claude-desktop/chrome-sandbox; \
    test -e "${helper}"; \
    chown root:root "${helper}"; \
    chmod 4755 "${helper}"; \
    test "$(stat -c '%U:%G %a' "${helper}")" = "root:root 4755"; \
    echo "chrome-sandbox: $(stat -c '%U:%G %a' "${helper}")"; \
    test -u /usr/bin/sudo-root; \
    test -x /etc/container-entrypoint.sh; \
    command -v claude-desktop > /dev/null; \
    command -v google-chrome > /dev/null; \
    command -v gnome-keyring-daemon > /dev/null; \
    command -v secret-tool > /dev/null; \
    test -e /usr/share/applications/google-chrome.desktop; \
    test -e /usr/share/applications/com.anthropic.Claude.desktop; \
    test "${HOME}" = "/home/ubuntu"; \
    case "${CLAUDE_CONFIG_DIR:-/home/ubuntu/.claude}" in \
        /home/ubuntu/*) echo "CLI state: HOME=${HOME}, CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-unset} — both under the mounted path";; \
        *) echo "FATAL: CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR} is outside /home/ubuntu, so the CLI sign-in would not be on the volume the user mounts" >&2; exit 1;; \
    esac; \
    cli_out="$(setpriv --reuid=1000 --regid=1000 --init-groups claude --version 2>&1 || true)"; \
    case "${cli_out}" in \
        "${CLAUDE_CODE_VERSION}"*) echo "claude --version as uid 1000: ${cli_out}";; \
        *) echo "FATAL: claude --version as uid 1000 printed '${cli_out}'" >&2; exit 1;; \
    esac

# PID 1 is root, and the session below it is uid 1000: docker-entrypoint.sh needs
# one root step to take ownership of a state path Unraid pre-created as 0777 99:100
# and then drops privileges with setpriv (§4.2, §6.3). Everything in the session —
# Selkies, LXQt, Chrome, Claude Desktop, the CLI — runs as 1000, and the entrypoint
# rejects any PUID/PGID other than 1000/1000 with exit 78. The base image's
# entrypoint is still what runs the container: the wrapper starts it, unchanged.
#
# DL3002 (USER 0 is the design, not an oversight: see D6 and the paragraph above)
# hadolint ignore=DL3002
USER 0
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
