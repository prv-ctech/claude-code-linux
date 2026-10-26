# syntax=docker/dockerfile:1
#
# claude-code-linux — LinuxServer.io's baseimage-selkies with the official Claude
# Desktop for Linux package, Google Chrome for its sign-in, and the pinned Claude
# Code CLI layered on top. The Unraid wiring (PUID/PGID, UMASK, /config, the
# abc user, s6-overlay) is the base image's own, the same setup
# junkerderprovinz/artcraft-apps uses, so this file adds no identity or
# permission handling of its own.
#
# WHAT THIS FILE ADDS
#   The streamed desktop (Selkies on Xvfb with Openbox), nginx on 3000/3001,
#   PulseAudio and the s6 supervision tree come from the pinned base. This file
#   adds the Anthropic signing key (verified, not merely trusted), the official
#   `claude-desktop` package at a pinned version, the secret service the
#   claude.ai sign-in is stored in, Google Chrome, and the pinned Claude Code CLI.
#
# THE ONE PATH TO MOUNT
#   /config, the session user's HOME (Unraid: /mnt/user/appdata/claude-code-linux).
#   It holds Claude Desktop's Electron userData, the keyring that stores the
#   sign-in (~/.local/share/keyrings, plus the generated password in
#   ~/.config/claude-code-linux/keyring.password), the Chrome profile the OAuth
#   flow runs in (~/.config/google-chrome), and the CLI's
#   ~/.claude/.credentials.json and ~/.claude.json.
#
# PUID/PGID/UMASK
#   The base's init remaps the abc user to PUID/PGID (Unraid: 99/100) and applies
#   UMASK before any service starts, so files written to /config and /workspaces
#   belong to the host user that owns the share.
#
# NO DESKTOP LOGIN
#   With CUSTOM_USER/PASSWORD unset, the base's nginx serves the desktop without
#   basic auth; a reverse proxy (Pangolin) is the gate. SELKIES_ENABLE_BASIC_AUTH
#   stays false as well, since Selkies refuses to start with it on and no password.
#
# THE IMAGE DOES NOT SELF-UPDATE
#   Anthropic's apt repository is not registered inside it — /etc/default/
#   claude-desktop is written with CLAUDE_DESKTOP_ADD_REPO="false" before the
#   package is installed — and the CLI cannot update itself. A new version of
#   either arrives by rebuilding this image, which is what the CI sweep does.
#
# Labels: the two version labels below are stamped here; the recipe hash is the
# CI build's to stamp.

ARG BASE_IMAGE=ghcr.io/linuxserver/baseimage-selkies:ubunturesolute
FROM ${BASE_IMAGE}

# ---------------------------------------------------------------------------
# Pinned upstreams (the CI resolves the same two signals and passes what it
# resolved).
# ---------------------------------------------------------------------------
# Claude Desktop: the maximum `Version` stanza of the Anthropic apt index.
ARG CLAUDE_DESKTOP_VERSION=2.26454.2
# Claude Code CLI: npm `dist-tags.latest`. Never a max scan of versions[], where
# dist-tags.next sits ahead of latest and would publish an unreleased build.
ARG CLAUDE_CODE_VERSION=2.1.294
# The Anthropic Claude Code signing key, fingerprint
# 31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE. install-claude-desktop.sh
# refuses to install anything unless the repository's signed InRelease verifies
# against both pins.
ARG CLAUDE_DESKTOP_KEY_SHA256=bd70a5e4a268002704024ceba7f8446024114e94f3f0bdd11c23a9e592be81c6
ARG CLAUDE_DESKTOP_KEY_FINGERPRINT=31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE
# Optional cross-checks passed by the CI sweep, empty for a manual build: when
# given, the build fails if the signed index no longer agrees with them.
ARG CLAUDE_DESKTOP_SHA256=
ARG CLAUDE_DESKTOP_DEB_URL=
# Cowork is a KVM feature and is NOT installed by default. It needs /dev/kvm AND
# /dev/vhost-vsock, which the Unraid template does not grant. To opt in:
#   docker build --build-arg CLAUDE_DESKTOP_COWORK=true -t claude-code-linux .
ARG CLAUDE_DESKTOP_COWORK=false

LABEL org.opencontainers.image.title="claude-code-linux" \
      org.opencontainers.image.description="Claude Desktop for Linux and the Claude Code CLI on a Selkies web desktop for Unraid" \
      org.opencontainers.image.source="https://github.com/prv-ctech/claude-code-linux" \
      org.opencontainers.image.version="${CLAUDE_DESKTOP_VERSION}" \
      com.prvctech.claude-desktop-version="${CLAUDE_DESKTOP_VERSION}" \
      com.prvctech.claude-code-version="${CLAUDE_CODE_VERSION}"

# TITLE feeds the PWA manifest the base writes; SELKIES_UI_TITLE is the tab and
# sidebar title of the Selkies web client.
ENV TITLE="Claude Code" \
    SELKIES_UI_TITLE="Claude Code" \
    SELKIES_ENABLE_BASIC_AUTH="false" \
    SELKIES_WEBCAM_ENCODER=h264

# Intel Arc (DG2): with CCS compression on, VA-API encodes the captured screen as
# scrambled tiles. noccs stops Mesa's Intel drivers from offering compressed
# buffers; other GPUs and CPU-only hosts ignore it.
ENV INTEL_DEBUG=noccs

# Neither application may mutate this container; it moves when the image is
# rebuilt. Those two switches also turn off plugin auto-update, which
# FORCE_AUTOUPDATE_PLUGINS keeps on, so the mods update without a rebuild.
ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_UPDATES=1 \
    FORCE_AUTOUPDATE_PLUGINS=1

# Python tooling: uv from Astral's pinned image, pip from apt. What a user
# installs lands under HOME=/config: `pip install --user` in ~/.local (PEP 668
# override; no PIP_USER, which breaks venvs), `uv tool` in ~/.local/bin.
ENV PIP_BREAK_SYSTEM_PACKAGES=1 \
    PATH="${PATH}:/config/.local/bin"
COPY --from=ghcr.io/astral-sh/uv:0.9.0 /uv /uvx /usr/local/bin/

# rootfs/ carries the session's entry points and the s6 init:
#   /usr/local/bin/claude-init            init-claude (s6, root): state fix-ups
#   /usr/local/bin/claude-keyring-init    starts and unlocks the secret service
#   /usr/local/bin/claude-desktop-session starts the app once that is up
#   /usr/local/bin/claude-desktop         the app's launcher (sandbox probe)
#   /usr/local/bin/google-chrome          Chrome's launcher (sandbox probe)
#   /defaults/autostart, /defaults/menu.xml  the Openbox session and menu
COPY scripts/install-claude-desktop.sh /usr/local/bin/install-claude-desktop.sh
COPY rootfs/ /
# Tab and sidebar icon of the Selkies web client; the base copies it into the
# web root at every start.
COPY unraid/icon.png /usr/share/selkies/www/icon.png

# git push over HTTPS for github.com goes through the GitHub CLI, so `gh auth
# login` (once, in the desktop's terminal) is the only sign-in. Its token lives in
# ~/.config/gh, inside /config, so it survives a container recreate.
RUN set -eu; \
    git config --system credential.https://github.com.helper '!/usr/bin/gh auth git-credential'; \
    git config --system credential.https://gist.github.com.helper '!/usr/bin/gh auth git-credential'; \
    test "$(git config --system --get credential.https://github.com.helper)" = '!/usr/bin/gh auth git-credential'

# ---------------------------------------------------------------------------
# Package layer 1 — the keyring the sign-in needs, Chrome, and the rest.
#   gnome-keyring libsecret-*  the secret service Claude Desktop stores the
#                              claude.ai sign-in in, and `secret-tool`, which
#                              claude-keyring-init probes it with
#   libayatana-appindicator3-1 the app's tray icon
#   bubblewrap socat           the app's sandbox and socket helpers
#   libasound2-plugins         the ALSA to PulseAudio bridge, so the app's sound
#                              reaches the browser
#   xdg-desktop-portal-gtk     the .deb Depends on one of the gtk/gnome/kde portals
#   gpgv                       install-claude-desktop.sh verifies the repository
#                              signature with it
#   nodejs                     Node 22 from the NodeSource repository the base
#                              registers; the CLI's `engines` requires 22+
#   google-chrome-stable       the browser Claude Desktop hands its sign-in to,
#                              from Google's repository, key checked by fingerprint
# ---------------------------------------------------------------------------
# DL3008: no package version pins — the base does not pin either, and the image is
#   rebuilt on every upstream move.
# DL4006: the pipes are `dpkg-query | grep -q` and `gpg | awk` inside tests, and
#   dash — the /bin/sh here — has no pipefail.
# hadolint ignore=DL3008,DL4006
RUN set -eu; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y gpg; \
    curl -fsSL --retry 3 https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor > /usr/share/keyrings/google-chrome.gpg; \
    gpg --show-keys --with-colons /usr/share/keyrings/google-chrome.gpg \
        | awk -F: '$1 == "fpr" { print $10 }' | grep -qx 'EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796'; \
    echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' \
        > /etc/apt/sources.list.d/google-chrome.list; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y \
        gnome-keyring \
        libsecret-1-0 \
        libsecret-tools \
        gh \
        libayatana-appindicator3-1 \
        bubblewrap \
        socat \
        libasound2-plugins \
        xdg-desktop-portal-gtk \
        gpgv \
        nodejs \
        python3-pip \
        google-chrome-stable; \
    command -v npm > /dev/null || DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y npm; \
    if [ "${CLAUDE_DESKTOP_COWORK}" = "true" ]; then \
        DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y qemu-system-x86 ovmf virtiofsd; \
    else \
        for pkg in qemu-system-x86 ovmf virtiofsd; do \
            if dpkg-query -W -f='${Status}' "${pkg}" 2>/dev/null | grep -q 'install ok installed'; then \
                echo "FATAL: ${pkg} is installed but CLAUDE_DESKTOP_COWORK is not true" >&2; \
                exit 1; \
            fi; \
        done; \
    fi; \
    ln -sf /usr/local/bin/google-chrome /usr/bin/google-chrome-stable; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/* /var/tmp/* /tmp/*

# ---------------------------------------------------------------------------
# Package layer 2 — the official Claude Desktop package, SHA256-verified against
# the stanza it came from, installed from the local file with the apt repository
# left unregistered.
# ---------------------------------------------------------------------------
RUN set -eu; \
    /usr/local/bin/install-claude-desktop.sh \
        "${CLAUDE_DESKTOP_VERSION}" \
        "${CLAUDE_DESKTOP_KEY_SHA256}" \
        "${CLAUDE_DESKTOP_KEY_FINGERPRINT}" \
        "${CLAUDE_DESKTOP_SHA256}" \
        "${CLAUDE_DESKTOP_DEB_URL}"; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/* /var/tmp/* /tmp/*

# ---------------------------------------------------------------------------
# Package layer 3 — the Claude Code CLI, pinned exactly, from npm. From the host:
#   docker exec -it -u abc claude-code-linux claude
# (-u abc because the CLI refuses to run as root.) The npm cache is kept out of
# /config so the image does not seed the state mount with a package cache.
# ---------------------------------------------------------------------------
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
    command -v claude > /dev/null; \
    echo "claude-code ${cli_version} installed and on PATH"

# The setuid sandbox helpers ship root:root 4755 from their packages; asserted so
# a base or package change cannot leave an ignored setuid bit. The rest proves the
# entry points the session is judged by resolve.
RUN set -eu; \
    for helper in /usr/lib/claude-desktop/chrome-sandbox /opt/google/chrome/chrome-sandbox; do \
        test "$(stat -c '%U:%G %a' "${helper}")" = "root:root 4755"; \
    done; \
    chmod 755 /usr/local/bin/install-claude-desktop.sh \
              /usr/local/bin/claude-init \
              /usr/local/bin/claude-desktop \
              /usr/local/bin/claude-desktop-session \
              /usr/local/bin/claude-keyring-init \
              /usr/local/bin/google-chrome \
              /defaults/autostart \
              /etc/s6-overlay/s6-rc.d/init-claude/run; \
    test "$(dpkg --print-architecture)" = amd64; \
    command -v claude-desktop > /dev/null; \
    command -v gnome-keyring-daemon > /dev/null; \
    command -v secret-tool > /dev/null; \
    command -v gh > /dev/null; \
    test "$(readlink -f /usr/bin/google-chrome)" = /usr/local/bin/google-chrome; \
    test -e /usr/share/applications/google-chrome.desktop; \
    test -e /usr/share/applications/com.anthropic.Claude.desktop; \
    test "${HOME}" = "/config"

# Answers once nginx serves the web client; any HTTP status counts, so a login a
# user turns on with PASSWORD does not make the container unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["curl", "-s", "-o", "/dev/null", "http://localhost:3000/"]
