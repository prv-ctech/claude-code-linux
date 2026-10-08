# Claude Code — Distribution, Install Methods, and Auto-Tracking Upstream Versions in Docker

**Snapshot taken:** 2026-10-08 (all live HTTP observations below were made on this date)
**Scope:** web research only. No local repository files exist in this workspace.

**Version facts observed at snapshot time** (these are the numbers every claim below is anchored to):

| Signal | Value | Source |
|---|---|---|
| npm `dist-tags.latest` | `2.1.294` | <https://registry.npmjs.org/@anthropic-ai/claude-code> |
| npm `dist-tags.stable` | `2.1.286` | same |
| npm `dist-tags.next` | `2.1.295` | same |
| GitHub `releases/latest` | `v2.1.294` (published `2026-10-08T05:03:54Z`) | <https://api.github.com/repos/anthropics/claude-code/releases/latest> |
| `downloads.claude.ai/claude-code-releases/latest` | `2.1.294` | live curl |
| `downloads.claude.ai/claude-code-releases/stable` | `2.1.286` | live curl |
| GCS `claude-code-dist-…/claude-code-releases/latest` | `2.1.294` | live curl |
| GCS `claude-code-dist-…/claude-code-releases/stable` | `2.1.286` | live curl |

> **Trap:** `dist-tags.next` (`2.1.295`) is **ahead of** `dist-tags.latest` (`2.1.294`). Never derive "latest" by taking the max of the version list. Use `dist-tags.latest`, or the official channel endpoint.

---

## 1. Is there an official Claude Code DESKTOP app for Linux?

**Yes — official, first-party, and labelled beta for Linux.** It is the *Claude Desktop* app (the Code tab runs Claude Code), not a separate Linux-only product.

Source: <https://code.claude.com/docs/en/desktop-linux> ("Claude Desktop on Linux (beta)")

### What exists and what does not

| Distribution format | Supported? |
|---|---|
| `.deb` via Anthropic apt repo | ✅ the only documented Linux method |
| `.rpm` | ❌ not offered for Desktop |
| AppImage | ❌ not offered |
| Direct `.deb` download URL | ✅ (docs give a lookup command, see below) |

**Hard platform requirement:** Debian-based only — "A Debian-based distribution: Ubuntu 22.04 or later, or Debian 12 or later", x86_64 or arm64. The docs explicitly say: *"On distributions that aren't Debian-based, such as Fedora or Arch, run the [CLI] instead."* — <https://code.claude.com/docs/en/desktop-linux#requirements>

The "What's not in the Linux beta yet" section repeats: *"**Fedora and RHEL**: only Debian-based distributions are supported today."*

### EXACT install method — apt repository

**Step 1 — install key tooling** (fresh Debian/Ubuntu may lack these):

```bash
sudo apt install curl gnupg
```

**Step 2 — download Anthropic's signing key:**

```bash
sudo curl -fsSLo /usr/share/keyrings/claude-desktop-archive-keyring.asc https://downloads.claude.ai/claude-desktop/key.asc
```

**Step 3 — verify the key fingerprint** (must be `31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE`):

```bash
gpg --show-keys /usr/share/keyrings/claude-desktop-archive-keyring.asc
```

**Step 4 — register the apt repository** (exact `deb` line, including the arch list):

```bash
echo "deb [arch=amd64,arm64 signed-by=/usr/share/keyrings/claude-desktop-archive-keyring.asc] https://downloads.claude.ai/claude-desktop/apt/stable stable main" | sudo tee /etc/apt/sources.list.d/claude-desktop.list
```

**Step 5 — install:**

```bash
sudo apt update && sudo apt install claude-desktop
```

**Step 6 — launch:** run `claude-desktop`, or launch **Claude** from the application launcher.

> Note the `deb` line pins `arch=amd64,arm64`. The apt repo URL is `https://downloads.claude.ai/claude-desktop/apt/stable`, suite `stable`, component `main`.
> **UNVERIFIED:** the docs' own troubleshooting text says a missing key makes `apt update` fail with `NO_PUBKEY BAA929FF1A7ECACE` — that is the trailing 64 bits of the same fingerprint, not a second key.

### EXACT install method — direct `.deb` from the package pool

The docs give this lookup-and-download one-liner (reads the repo `Packages` index, picks the newest for your arch):

```bash
curl -fLO "https://downloads.claude.ai/claude-desktop/apt/stable/$(curl -s "https://downloads.claude.ai/claude-desktop/apt/stable/dists/stable/main/binary-$(dpkg --print-architecture)/Packages" | grep '^Filename: pool/main/c/claude-desktop/claude-desktop_' | sort -V | tail -n 1 | cut -d' ' -f2)"
```

Then install:

```bash
sudo apt install ./claude-desktop_*.deb
```

**URL pattern:** `https://downloads.claude.ai/claude-desktop/apt/stable/pool/main/c/claude-desktop/claude-desktop_<version>_<arch>.deb`
**Index URL pattern:** `https://downloads.claude.ai/claude-desktop/apt/stable/dists/stable/main/binary-{amd64,arm64}/Packages`

The `.deb` bundles the signing key (installs it to `/usr/share/keyrings/claude-desktop-archive-keyring.asc`) and registers the apt repo itself unless you opt out by creating `/etc/default/claude-desktop` containing `CLAUDE_DESKTOP_ADD_REPO="false"`.

### Update / uninstall

* **No self-update on Linux.** *"The desktop app doesn't update itself on Linux."* Updates arrive via `sudo apt update && sudo apt upgrade`.
* Uninstall: `sudo apt remove claude-desktop` (also removes the repo entry and key it registered).

### Sibling pages — what actually exists

Verified by HTTP status on the `.md` doc endpoints:

| Page | Status |
|---|---|
| `/docs/en/desktop` | 200 — <https://code.claude.com/docs/en/desktop> |
| `/docs/en/desktop-linux` | 200 |
| `/docs/en/desktop-wsl` | 200 |
| `/docs/en/desktop-quickstart` | 200 |
| `/docs/en/desktop-windows` | **404** |
| `/docs/en/desktop-macos` | **404** |

The docs index confirms the real sibling set: <https://code.claude.com/docs/llms.txt> lists `desktop-quickstart`, `desktop`, `desktop-linux`, `desktop-wsl`, `desktop-scheduled-tasks`, `desktop-ios-simulator`. There is no `desktop-windows` or `desktop-macos` page.
<https://code.claude.com/docs/en/desktop-quickstart> describes Linux as "apt or .deb for Ubuntu and Debian".

---

## 2. The npm distribution

* **Package name:** `@anthropic-ai/claude-code`
* **Registry document:** <https://registry.npmjs.org/@anthropic-ai/claude-code>
* **Latest-version-only document:** <https://registry.npmjs.org/@anthropic-ai/claude-code/latest>

### Observed metadata (2026-10-08)

| Field | Value |
|---|---|
| `dist-tags` | `{"stable": "2.1.286", "next": "2.1.295", "latest": "2.1.294"}` |
| `dist-tags.latest` | `2.1.294` (published `2026-10-08T03:42:57.084Z`) |
| `dist-tags.stable` | `2.1.286` (published `2026-09-30T17:14:38.859Z`) |
| **versions list size** | **537 versions** |
| package `created` | `2025-02-24T18:03:40.929Z` |
| registry `modified` | `2026-10-08T18:22:58.802Z` |
| `engines` | `{"node": ">=22.0.0"}` |
| `dependencies` | `{}` (none) |
| `bin` | `{"claude": "bin/claude.exe"}` (launcher shim only) |
| `license` | `"SEE LICENSE IN README.md"` (proprietary) |
| `repository` | `git+https://github.com/anthropics/claude-cli-internal.git` (internal; not the public repo) |
| `scripts.postinstall` | `node install.cjs` |

### Programmatic version query (exact commands)

```bash
npm view @anthropic-ai/claude-code version
# -> 2.1.294   (verified on this host)

npm view @anthropic-ai/claude-code dist-tags --json
# -> {"latest":"2.1.294","next":"2.1.295","stable":"2.1.286"}
```

Registry-only equivalent (no npm CLI, one HTTP GET):

```bash
curl -fsSL https://registry.npmjs.org/@anthropic-ai/claude-code/latest | jq -r .version
curl -fsSL https://registry.npmjs.org/@anthropic-ai/claude-code | jq -r '."dist-tags"'
```

> **Do not** use `https://registry.npmjs.org/@anthropic-ai/claude-code/-/package.json` for dist-tags — verified: that document contains no `dist-tags` object (it 404s or lacks the field; the `dist-tags` live on the full packument). Use `/latest` or the full packument.

### npm is a deprecated install path

The public README states plainly:

> *"Installation via npm is deprecated. Use one of the recommended methods below."*
> — <https://github.com/anthropics/claude-code/blob/main/README.md>

The docs still document it, with caveats:
<https://code.claude.com/docs/en/setup#install-with-npm>

```bash
npm install -g @anthropic-ai/claude-code
# upgrade:
npm install -g @anthropic-ai/claude-code@latest
```

Key behavioural notes from that doc:
* *"The npm package installs the same native binary as the standalone installer. npm pulls the binary in through a per-platform optional dependency… and a postinstall step links it into place. The installed `claude` binary does not itself invoke Node."*
* Node.js 22 or later required. On older Node, npm prints `EBADENGINE` but the install still works because the runtime is a native binary.
* Supported npm install platforms: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`, `win32-x64`, `win32-arm64`.
* *"Avoid `npm update -g`, which respects the semver range from the original install and may not move you to the newest release."*
* *"Do NOT use `sudo npm install -g`."*

> Note: the README badges still say "Node.js 18+" but `package.json` `engines` says `>=22.0.0` and the setup doc says Node 22+ — treat **Node 22+** as authoritative.

---

## 3. Native / binary installer and the GCS stable download bucket

### The user-facing installer

<https://code.claude.com/docs/en/setup#install-claude-code> and <https://code.claude.com/docs/en/setup#install-a-specific-version>

```bash
# macOS / Linux / WSL — latest channel (default)
curl -fsSL https://claude.ai/install.sh | bash

# stable channel
curl -fsSL https://claude.ai/install.sh | bash -s stable

# exact version
curl -fsSL https://claude.ai/install.sh | bash -s 2.1.89
```

Installer variants:

| Platform | URL |
|---|---|
| macOS / Linux / WSL | `https://claude.ai/install.sh` |
| Windows PowerShell | `https://claude.ai/install.ps1` |
| Windows CMD | `https://claude.ai/install.cmd` |

**Verified redirect chain:** `https://claude.ai/install.sh` → **HTTP 302** → `https://downloads.claude.ai/claude-code-releases/bootstrap.sh` (both `.ps1` and `.cmd` also 302).

### What the installer actually does (read from the live script)

Source: <https://downloads.claude.ai/claude-code-releases/bootstrap.sh>

```bash
DOWNLOAD_BASE_URL="https://downloads.claude.ai/claude-code-releases"
DOWNLOAD_DIR="$HOME/.claude/downloads"
```

Sequence:
1. `version=$(curl -fsSL "$DOWNLOAD_BASE_URL/latest")` — a bare version string, e.g. `2.1.294`.
2. `manifest.json` ← `"$DOWNLOAD_BASE_URL/$version/manifest.json"`; read `.platforms["$platform"].checksum` (SHA-256, 64 hex) and `.size`.
3. Optional compressed path: `manifest.zst.json` + `"$DOWNLOAD_BASE_URL/$version/$platform/claude.zst"`.
4. Fallback plain binary: `"$DOWNLOAD_BASE_URL/$version/$platform/claude"`.
5. SHA-256 verify, `chmod +x`, then `"$binary_path" install ${TARGET:+$TARGET}`.

Platform keys: `linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`, `darwin-x64`, `darwin-arm64`. musl detection is `[ -f /lib/libc.musl-x86_64.so.1 ] || ldd /bin/ls | grep -q musl`.

**URL patterns (native installer / auto-updater):**
```
https://downloads.claude.ai/claude-code-releases/latest
https://downloads.claude.ai/claude-code-releases/stable
https://downloads.claude.ai/claude-code-releases/<VERSION>/manifest.json
https://downloads.claude.ai/claude-code-releases/<VERSION>/manifest.zst.json
https://downloads.claude.ai/claude-code-releases/<VERSION>/<platform>/claude
https://downloads.claude.ai/claude-code-releases/<VERSION>/<platform>/claude.zst
```
A bogus version returns **404** (verified with `9.9.9`).

### The GCS bucket

**Bucket name (verified live):**
```
storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/
```

Verified live:

```bash
curl -fsSL https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/stable   # -> 2.1.286
curl -fsSL https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest   # -> 2.1.294
```

The GCS `manifest.json` for `2.1.286` is **byte-identical** (both `sha256 c84e2bef8910fdec338c5e198192fc02d574182f71e57f2c262519541c697523`) to `https://downloads.claude.ai/claude-code-releases/2.1.286/manifest.json`. Sample content:

```json
{
  "version": "2.1.286",
  "manifestSignatureEnforcement": "flag",
  "commit": "f344a08993bbba4fc1ea9b295245324610f02c58",
  "modsCommit": "732e167ee9d71296b4b63d6f529ac1334513826a",
  "buildDate": "2026-09-30T15:55:40Z",
  "platforms": { "linux-x64": { "binary": "claude", "checksum": "…", "size": … }, … }
}
```

Bucket listing is denied to anonymous callers (verified: `storage.objects.list` → 401), so you must know the exact object path — you cannot enumerate.

### Docs statement on which host is current

<https://code.claude.com/docs/en/network-config#network-access-requirements> lists both, with a version split:

| Host | Purpose (verbatim from docs) |
|---|---|
| `downloads.claude.ai` | "Plugin executable downloads; native installer, native auto-updater, and update version checks" |
| `storage.googleapis.com` | "Plugin install counts and metadata shown in `/plugin`" |
| `storage.googleapis.com` | "Native installer and native auto-updater on versions prior to 2.1.116" |

> So per the docs, GCS is legacy for ≤2.1.116 and `downloads.claude.ai` is the current host. **Both are live and serving identical content as of 2026-10-08** (empirically verified above). Prefer `downloads.claude.ai`; it is the documented, current, and forward-compatible host.

### Install-directory / launcher layout

<https://code.claude.com/docs/en/setup#auto-updates>:
* Launcher: `~/.local/bin/claude` — a **symlink** into `~/.local/share/claude/versions/`.
* If you replace that launcher with your own script/symlink, auto-update and `claude update` leave it in place, but Claude Code then keeps *every* installed version on disk.
* The installer's scratch download dir is `$HOME/.claude/downloads` (from the script).
* Config dir default `~/.claude`, overridable with `CLAUDE_CONFIG_DIR` (<https://code.claude.com/docs/en/env-vars>).

### Documented environment variables (verbatim rows)

From <https://code.claude.com/docs/en/env-vars>:

| Variable | Documented behaviour |
|---|---|
| `DISABLE_AUTOUPDATER` | "Set to `1` to disable automatic background updates. Manual `claude update` still works. Use `DISABLE_UPDATES` to block both" |
| `DISABLE_UPDATES` | "Set to `1` to block all updates including manual `claude update` and `claude install`. Stricter than `DISABLE_AUTOUPDATER`. Use when distributing Claude Code through your own channels and users should not self-update" |
| `DISABLE_UPGRADE_COMMAND` | "Set to `1` to hide the `/upgrade` command" |
| `FORCE_AUTOUPDATE_PLUGINS` | "Set to `1` to force plugin auto-updates even when the main auto-updater is disabled via `DISABLE_AUTOUPDATER`" |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | "Set to any non-empty value, such as `1`, to disable nonessential network traffic: auto-updates, telemetry, error reporting…" (note: any non-empty value, **including `0`**, turns it on) |
| `CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE` | "Set to `1` to let Claude Code run your package manager's upgrade command in the background… Applies to Homebrew and WinGet installations." |
| `CLAUDE_CONFIG_DIR` | "Override the configuration directory (default: `~/.claude`). All settings, session history, and plugins are stored under this path." |
| `USE_BUILTIN_RIPGREP` | "Set to `0` to use system-installed `rg` instead of `rg` included with Claude Code" |
| `CLAUDE_CODE_OAUTH_TOKEN` | "OAuth access token for claude.ai authentication… Generate one with `claude setup-token`" |

**Verdict on "`CLAUDE_CODE_*` install dirs":** there is **no** documented `CLAUDE_CODE_*INSTALL*` / install-directory environment variable. Grep of the full env-vars page found only `CLAUDE_INSTALL_ALLOW_SUDO`, and that appears **only in the `bootstrap.sh` script source**, not in the docs:

> `"To intentionally install Claude Code for the root user, re-run with CLAUDE_INSTALL_ALLOW_SUDO=1 set in the installer's environment"` — <https://downloads.claude.ai/claude-code-releases/bootstrap.sh> (marked UNVERIFIED against official docs)

The installer refuses to run under `sudo` from a non-root login unless `CLAUDE_INSTALL_ALLOW_SUDO` is set. **Plain root with no `sudo` (containers, CI) is unaffected** — this is exactly the container case.

### Signing keys

| Key URL | Purpose |
|---|---|
| `https://downloads.claude.ai/keys/claude-code.asc` | CLI apt/dnf/apk repos + release manifest signature |
| `https://downloads.claude.ai/claude-desktop/key.asc` | Claude Desktop apt repo |

**Verified:** both files are **byte-identical** (`sha256 bd70a5e4a268002704024ceba7f8446024114e94f3f0bdd11c23a9e592be81c6`, 1688 bytes each). Fingerprint for both: `31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE`. Signer identity per docs: `Anthropic Claude Code Release Signing <security@anthropic.com>`.

---

## 4. GitHub repo `anthropics/claude-code` — what is actually in it

**Conclusion: docs, issues, plugin/example content, and the devcontainer reference — the product source code is NOT here. The CLI is closed source.**

### Evidence

* `LICENSE.md` (150 bytes, full text): *"© Anthropic PBC. All rights reserved. Use is subject to Anthropic's [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms)."*
  <https://github.com/anthropics/claude-code/blob/main/LICENSE.md>
* npm `license` field: `"SEE LICENSE IN README.md"`; npm `repository` field points at `anthropics/claude-cli-internal` (a private internal repo), **not** `anthropics/claude-code`.
* Root contents (verified via `GET /repos/anthropics/claude-code/contents/`):

```
.claude-plugin  .claude  .devcontainer  .gitattributes  .github  .gitignore
.vscode  CHANGELOG.md  CLAUDE.md  LICENSE.md  README.md  SECURITY.md
Script  demo.gif  examples  feed.xml  mods  plugins  scripts
```

No `src/`, no `packages/`, no language source tree. `README.md` is a marketing/install doc that ends with bug-reporting and data-usage sections.

### Does it publish GitHub Releases or tags usable as a version signal?

**Yes — both, and they are richer than expected.**

* **Releases:** ~**239 releases** (paginated 100 / 100 / 39). Every release found carries **10 assets**, e.g. for `v2.1.294`:

```
claude-darwin-arm64.tar.gz         ~101 MB
claude-darwin-x64.tar.gz           ~106 MB
claude-linux-arm64-musl.tar.gz     ~109 MB
claude-linux-arm64.tar.gz          ~111 MB
claude-linux-x64-musl.tar.gz       ~109 MB
claude-linux-x64.tar.gz            ~111 MB
claude-win32-arm64.zip             ~109 MB
claude-win32-x64.zip               ~114 MB
SHASUMS256.txt
SHASUMS256.txt.sig                 (PGP signature)
```
  Download pattern: `https://github.com/anthropics/claude-code/releases/download/v<VERSION>/<asset>`
  <https://api.github.com/repos/anthropics/claude-code/releases>

* **`releases/latest`** works and is cheap:
  `https://api.github.com/repos/anthropics/claude-code/releases/latest` → `v2.1.294`, published `2026-10-08T05:03:54Z`.
  `https://github.com/anthropics/claude-code/releases/latest` → `302` → `https://github.com/anthropics/claude-code/releases/tag/v2.1.294`

* **Tags:** 243 refs via `git ls-remote --tags`, `v`-prefixed, exactly mirroring npm versions (`v2.1.294` … `v2.1.176` on page 1 alone).
  <https://api.github.com/repos/anthropics/claude-code/tags>

> ⚠️ **API-listing gotcha:** the default `GET /releases` returns only ~1 page worth in raw form and the GitHub *web* releases page paginates. Always pass `?per_page=100` and follow the `Link` header (`rel="next"` / `rel="last"`) — a naive single fetch makes it look like only 3 releases exist.

### Which upstream version signal should a container build use?

**Recommendation: use the channel endpoint as the source of truth, with npm `dist-tags.latest` as the earliest-available early warning.**

Observed publish ordering for `2.1.294` (all 2026-10-08):

| Signal | Timestamp | Lead |
|---|---|---|
| npm `latest` | `03:42:57Z` | — (earliest observed) |
| GitHub release | `05:03:54Z` | +1h21m |
| `downloads.claude.ai` / GCS `latest` | same value at snapshot | — |

Ranking:

| Signal | Cost | Auth | Rate limit risk | Semantics |
|---|---|---|---|---|
| **Channel endpoint** `…/claude-code-releases/{latest,stable}` | 1 tiny GET, plain text | none | none documented | **Exact version the installer will fetch.** Best for "does my pin match what a rebuild would install?" |
| **npm `dist-tags.latest`** | 1 GET (packument ~1.5 MB) or `/latest` (~3.6 KB) | none | none | Earliest reliable release signal; also gives `stable` and `next` |
| **GitHub `releases/latest`** | 1 GET | none but **60 req/h unauthenticated** | yes, in busy CI | Also gives release notes + signed `SHASUMS256.txt` assets |
| **GitHub tags** | 1 GET + pagination | none, 60 req/h unauth | yes | Redundant given `releases/latest` |
| **GCS bucket** | 1 GET | none | none | Identical content to `downloads.claude.ai`, but documented as legacy for ≤2.1.116 |

**Why not `ghcr.io` or Docker Hub tags:** there is no official versioned Claude Code image (see §5), so no image tag is a valid upstream signal.

---

## 5. Containerization guidance

### 5a. Is there an official Anthropic Docker image?

**No official published Claude Code container image exists in Anthropic's documentation.** Verified:

* Grep of <https://code.claude.com/docs/llms.txt> and all fetched docs pages for `ghcr.io`, `docker pull`, `docker.io`, `Docker Hub` yields **only one** Anthropic-owned image reference — the Dev Container *Feature*, not an app image:
  `ghcr.io/anthropics/devcontainer-features/claude-code:1.0`
* `ghcr.io/anthropics/claude-code` — **UNVERIFIED / does not resolve to a public repo.** Anonymous token was issued but the tags endpoint returned `{"errors":[{"code":"DENIED","message":"invalid token"}]}`.
* `anthropics/claude-code-sandbox` on GitHub → **HTTP 404** (repo does not exist publicly).
* The docs describe the in-repo devcontainer as *"provided as a working example rather than a maintained base image"* — <https://code.claude.com/docs/en/devcontainer#try-the-reference-container>

**⚠️ `docker.io/anthropics/claude-code:latest` exists but should not be used.** It is not referenced by any Anthropic doc. Observed: registered `2026-06-18`, exactly **1 tag** (`latest`), last updated `2026-06-18T06:59:49Z` (~4 months stale vs. a daily release cadence), pull_count 6320. Its image config shows only `apt-get install curl ca-certificates` plus a `COPY entrypoint.sh` on a Debian trixie base — no Claude Code binary layer. **Provenance UNVERIFIED; treat as unofficial.**

### 5b. The official Anthropic Dev Container Feature (the real official containerization path)

* **Repository:** <https://github.com/anthropics/devcontainer-features> ("Anthropic Dev Container Features, including Claude Code CLI", MIT licence)
* **Feature image:** `ghcr.io/anthropics/devcontainer-features/claude-code`
* **Published tags (verified via GHCR API):** `1`, `1.0`, `1.0.0`, `1.0.1`, `1.0.2`, `1.0.3`, `1.0.4`, `1.0.5`, `latest`
* **Feature options:** the feature's `README.md` "Options" table is **empty** — i.e. **no version option exists.**
* **Installer content (verified):** the feature's `install.sh` runs `npm install -g @anthropic-ai/claude-code` — **unpinned**.

Documented usage (<https://code.claude.com/docs/en/devcontainer#add-claude-code-to-your-dev-container>):

```json
{
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": {
    "ghcr.io/anthropics/devcontainer-features/claude-code:1.0": {}
  }
}
```

Docs warning, verbatim: *"The version tag at the end, such as `:1.0`, pins the feature's install script, not the Claude Code release. The feature installs the latest Claude Code, and Claude Code auto-updates itself inside the container by default."*

If Node auto-install fails with `Failed to install Node.js and npm`, add `"ghcr.io/devcontainers/features/node:1": {}` **above** the Claude Code feature.

### 5c. The reference devcontainer in `anthropics/claude-code`

Files (all in <https://github.com/anthropics/claude-code/tree/main/.devcontainer>):

| File | Purpose (docs' own description) |
|---|---|
| `devcontainer.json` | "Volume mounts, `runArgs` capabilities, VS Code extensions, and `containerEnv`" |
| `Dockerfile` | "Base image, development tools, and the Claude Code install" |
| `init-firewall.sh` | "Limits outbound network traffic to the destinations the script allows" |

**Verified `Dockerfile` essentials:**

```dockerfile
FROM node:20
ARG CLAUDE_CODE_VERSION=latest
# apt-get install: less git procps sudo fzf zsh man-db unzip gnupg2 gh iptables ipset iproute2 dnsutils aggregate jq nano vim
ARG USERNAME=node
USER node
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}
```
Note the built-in **pin hook**: `--build-arg CLAUDE_CODE_VERSION=<x.y.z>`. The default is `latest`.

**Verified `devcontainer.json` essentials:**

```json
{
  "runArgs": ["--cap-add=NET_ADMIN", "--cap-add=NET_RAW"],
  "remoteUser": "node",
  "mounts": [
    "source=claude-code-bashhistory-${devcontainerId},target=/commandhistory,type=volume",
    "source=claude-code-config-${devcontainerId},target=/home/node/.claude,type=volume"
  ],
  "containerEnv": {
    "NODE_OPTIONS": "--max-old-space-size=4096",
    "CLAUDE_CONFIG_DIR": "/home/node/.claude",
    "POWERLEVEL9K_DISABLE_GITSTATUS": "true"
  },
  "workspaceFolder": "/workspace",
  "postStartCommand": "sudo /usr/local/bin/init-firewall.sh",
  "waitFor": "postStartCommand"
}
```

Runs as **non-root user `node`**; `NET_ADMIN`/`NET_RAW` are required only for the in-container firewall, and the docs say *"The firewall script and these capabilities are not required for Claude Code itself."*

### 5d. Auth inside Docker — `ANTHROPIC_API_KEY` vs `claude setup-token`

Source: <https://code.claude.com/docs/en/authentication> and <https://code.claude.com/docs/en/devcontainer#persist-authentication-and-settings-across-rebuilds>

**Option A — API key:**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```
Sent as the `X-Api-Key` header. *"In non-interactive mode (`-p`), the key is always used when present."* In interactive mode you are prompted once to approve it.
**Constraint:** *"Desktop doesn't accept a Claude Console API key directly; use the CLI for API-key authentication."* (API keys are billed per token; subscription plans are not.)

**Option B — long-lived OAuth token (`claude setup-token`):**

> *"For CI pipelines, scripts, or other environments where interactive browser login isn't available, generate a one-year OAuth token with `claude setup-token`"*

```bash
claude setup-token                      # opens browser auth flow; token prints to terminal
export CLAUDE_CODE_OAUTH_TOKEN=your-token
```
The command **does not save the token anywhere** — you must capture it (e.g. as a CI secret). It is a **one-year** token.

**Authentication precedence** (docs, highest first) — relevant because it decides which of your container secrets actually wins:
1. Cloud provider credentials (`CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY`)
2. `ANTHROPIC_AUTH_TOKEN` (bearer)
3. `ANTHROPIC_API_KEY` (`X-Api-Key`)
4. `apiKeyHelper` script output
5. `CLAUDE_CODE_OAUTH_TOKEN` ← `claude setup-token`
6. Anthropic profile / federation credentials
7. Subscription OAuth from `/login`

A signed-in Claude apps gateway session outranks all of these.

**Credential file locations (Linux):**

| Path | Contents |
|---|---|
| `~/.claude/.credentials.json` (**mode `0600`**) | Linux credential store |
| `$CLAUDE_CONFIG_DIR/.credentials.json` | if `CLAUDE_CONFIG_DIR` is set, credentials move here instead |
| `~/.claude.json` | OAuth account, personal MCP servers, per-project trust — **a separate file outside `~/.claude/`** |
| `~/.claude/` | user settings, session history, plugins, transcripts (and `agent-memory/`, `jobs/`, `daemon/` state) |
| `/etc/claude-code/managed-settings.json` | Linux managed settings, highest precedence |

> **Critical volume gotcha, verbatim from the docs:** *"Claude Code stores its authentication token, user settings, and session history under the `~/.claude` directory. It stores your OAuth account, personal MCP servers, and per-project trust in `~/.claude.json`, a separate file outside that directory, **so mounting a volume at `~/.claude` alone doesn't keep you signed in.**"*
> Fix — mount the volume **and** set `CLAUDE_CONFIG_DIR` to the same path:
> ```json
> "mounts": ["source=claude-code-config,target=/home/node/.claude,type=volume"],
> "containerEnv": { "CLAUDE_CONFIG_DIR": "/home/node/.claude" }
> ```

**Cookies/browser in containers:** *"OAuth login fails in WSL2, SSH, or containers"* — the browser opens on a different host and the localhost callback can't reach Claude Code. Workaround: paste the displayed code at the `Paste code here if prompted` prompt. <https://code.claude.com/docs/en/troubleshoot-install>

### 5e. Known container constraints

| Constraint | Detail | Source |
|---|---|---|
| **Must be non-root** | *"The CLI rejects `--dangerously-skip-permissions` when launched as root, so confirm `remoteUser` is set to a non-root account."* | <https://code.claude.com/docs/en/devcontainer#run-without-permission-prompts> |
| **`WORKDIR` before installing** | *"When run from `/`, the installer scans the entire filesystem, which causes excessive memory usage."* Fix: `WORKDIR /tmp` before `RUN curl -fsSL https://claude.ai/install.sh \| bash` | <https://code.claude.com/docs/en/troubleshoot-install#install-hangs-in-docker> |
| **Memory** | 4 GB+ RAM required; Docker Desktop build containers share the VM's memory | <https://code.claude.com/docs/en/setup#system-requirements>, troubleshoot-install |
| **bash + curl needed** | Alpine/`musl` install requires `bash` and `curl`; runtime requires `libgcc`, `libstdc++`, `ripgrep` | <https://code.claude.com/docs/en/setup#alpine-linux-and-musl-based-distributions> |
| **Alpine recipe** | `apk add bash curl libgcc libstdc++ ripgrep` then set `USE_BUILTIN_RIPGREP=0` | same |
| **ripgrep** | "usually included with Claude Code"; override with `USE_BUILTIN_RIPGREP=0` to use system `rg` | <https://code.claude.com/docs/en/setup#additional-dependencies>, env-vars |
| **git** | Required for git workflows; devcontainer base installs `git` explicitly. Git for Windows is optional and Windows-only | Dockerfile; setup doc |
| **Node runtime** | npm install path needs Node **22+**; the installed `claude` binary does **not** invoke Node at runtime | <https://code.claude.com/docs/en/setup#install-with-npm>, npm `engines` |
| **Network egress** | Must allowlist `api.anthropic.com`, `claude.ai`, `claude.com`, `platform.claude.com`, `mcp-proxy.anthropic.com`, `downloads.claude.ai` (and `storage.googleapis.com` pre-2.1.116) | <https://code.claude.com/docs/en/network-config#network-access-requirements> |
| **Managed settings** | `RUN mkdir -p /etc/claude-code && COPY managed-settings.json /etc/claude-code/managed-settings.json` — but *"Because the Dockerfile lives in the repository, anyone with write access can change or remove this step."* Use server-managed settings or MDM for non-bypassable policy | <https://code.claude.com/docs/en/devcontainer#enforce-organization-policy> |
| **Trust model** | *"Only use dev containers when developing with trusted repositories, and monitor Claude's activities."* | <https://code.claude.com/docs/en/devcontainer> |

---

## 6. Auto-update behaviour inside containers

### What the docs say

* **Default: native installs self-update.** *"Claude Code checks for updates on startup and periodically while running. Updates download and install in the background, then take effect the next time you start Claude Code."* — <https://code.claude.com/docs/en/setup#auto-updates>
* **Package-manager installs do not.** *"Homebrew, WinGet, apt, dnf, and apk installations do not auto-update by default."* Also: *"apt, dnf, and apk continue to require a manual upgrade because those commands need elevated privileges."*
* **Inside a dev container the Feature installs latest and auto-updates.** *"The feature installs the latest Claude Code, and Claude Code auto-updates itself inside the container by default."* — <https://code.claude.com/docs/en/devcontainer>
* **The official disable recipe** (verbatim, in `containerEnv`):
  ```json
  "containerEnv": {
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "DISABLE_AUTOUPDATER": "1"
  }
  ```
* **Verification of the disable:** run `claude doctor` and check the `Auto-updates` line reads `disabled (set by env: DISABLE_AUTOUPDATER)` instead of `enabled`.
* **`DISABLE_AUTOUPDATER` is not a hard seal:** *"`DISABLE_AUTOUPDATER` only stops the background check; `claude update` and `claude install` still work."* For a hard seal use `DISABLE_UPDATES`.
* **The docs' own statement of why pinning matters**, verbatim:
  > *"The Dev Container Feature always installs the latest Claude Code release. To pin a specific Claude Code version for reproducible builds, install it from your Dockerfile with `npm install -g @anthropic-ai/claude-code@X.Y.Z` instead of using the feature, and set `DISABLE_AUTOUPDATER` to `1` in `containerEnv`."*
  > — <https://code.claude.com/docs/en/devcontainer#enforce-organization-policy>

### Why a container should pin and rebuild instead of self-updating

Derived strictly from the documented behaviour above:

1. **The Feature's version tag is not a CLI version.** `:1.0` pins the *install script*, not Claude Code. Two builds of the same Dockerfile on different days produce different CLI versions → non-reproducible image.
2. **Runtime self-update mutates a running container's filesystem**, which contradicts the immutable-image model. The update lands under `~/.local/share/claude/versions/` (native) or the npm global prefix, i.e. inside a writable layer or a volume — depending on your mount layout it may silently vanish on restart, or persist invisibly and diverge from the pinned `Dockerfile`.
3. **Skipping the stable channel by accident.** `autoUpdatesChannel` defaults to unset ⇒ `"latest"`. A container pinned to `stable` semantics must say so explicitly, or the runtime update jumps to `latest`.
4. **Cache/registry mismatch.** If you pin `X.Y.Z` in the Dockerfile but leave auto-update on, `claude --version` inside a long-lived container no longer matches the image label. Any image-level version metadata becomes a lie.
5. **Network policy is a second lever.** Claude Code's update check needs `downloads.claude.ai`. A container that only allowlists `api.anthropic.com` already cannot self-update — but this fails *silently*, so `DISABLE_AUTOUPDATER` is still the correct explicit signal.

### Extra version-pinning controls that apply to containers

From <https://code.claude.com/docs/en/settings-reference> and <https://code.claude.com/docs/en/setup#pin-a-minimum-version>:

| Setting | Effect | Scope |
|---|---|---|
| `autoUpdatesChannel` | `"latest"` (default) or `"stable"` | Any file; set in managed settings to enforce org-wide |
| `minimumVersion` | Floor — auto-update and `claude update` refuse anything below it | Any file; managed sets an unoverridable org floor |
| `requiredMinimumVersion` | Blocks **startup** below the floor (unlike `minimumVersion`, which only constrains updates) | Managed |
| `requiredMaximumVersion` | Ceiling — updates also respect it | Managed |

The docs explicitly recommend the managed route for containers, because a Dockerfile is editable by anyone with repo write access.

---

## EXACT COMMANDS

Copy-pasteable shell for a GitHub Actions job (or any CI) that resolves the latest upstream version and compares it to a pinned value. **Every snippet below was executed on 2026-10-08 and produced the annotated output.** `jq` and `sort -V` (GNU coreutils) are both present on GitHub-hosted `ubuntu-latest` runners.

### A. Minimal: resolve latest from npm, compare to a pin

```bash
set -euo pipefail
PINNED="2.1.286"                                    # your Dockerfile pin

LATEST=$(curl -fsSL https://registry.npmjs.org/@anthropic-ai/claude-code/latest | jq -r .version)

echo "pinned=${PINNED}  latest=${LATEST}"
if [ "$LATEST" != "$PINNED" ]; then
  echo "UPDATE_AVAILABLE ${PINNED} -> ${LATEST}"
  echo "update=true"  >> "$GITHUB_OUTPUT"
else
  echo "UP_TO_DATE ${PINNED}"
  echo "update=false" >> "$GITHUB_OUTPUT"
fi
```

Verified output: `pinned=2.1.286 latest=2.1.294` → `UPDATE_AVAILABLE 2.1.286 -> 2.1.294`

### B. All three npm channels at once (one packument fetch)

```bash
curl -fsSL https://registry.npmjs.org/@anthropic-ai/claude-code \
  | jq -r '."dist-tags" | to_entries[] | "\(.key)=\(.value)"'
```
Verified output:
```
latest=2.1.294
next=2.1.295
stable=2.1.286
```

### C. Channel endpoint — "what would a rebuild actually install?" (fastest, download-host only)

```bash
DL_BASE="https://downloads.claude.ai/claude-code-releases"
CHANNEL="stable"                                    # or: latest
CHANNEL_VERSION=$(curl -fsSL "${DL_BASE}/${CHANNEL}")
echo "channel(${CHANNEL})=${CHANNEL_VERSION}"
```
Verified: `stable` → `2.1.286`, `latest` → `2.1.294`

### D. Semver "is it newer than my pin?" without Node

```bash
NEWEST=$(printf '%s\n%s\n' "$PINNED" "$LATEST" | sort -V | tail -n1)
[ "$NEWEST" = "$LATEST" ] && [ "$LATEST" != "$PINNED" ] \
  && echo "newer release available" || echo "pin is current or ahead"
```
Verified: `sort -V` max of `2.1.286` / `2.1.294` → `2.1.294`

### E. GitHub Releases signal (release notes + signed checksums)

```bash
GH_LATEST=$(curl -fsSL -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/anthropics/claude-code/releases/latest \
  | jq -r '.tag_name | sub("^v";"")')
echo "github=${GH_LATEST}"                          # -> 2.1.294
```

For the full release history, **you must paginate** (`per_page=100`, follow `Link: rel="next"`):

```bash
page=1
while :; do
  body=$(curl -fsSL "https://api.github.com/repos/anthropics/claude-code/releases?per_page=100&page=${page}")
  echo "$body" | jq -r '.[].tag_name'
  [[ "$body" == "[]" ]] && break
  page=$((page+1)); [ "$page" -gt 5 ] && break
done
```
Verified: 3 pages hold ~239 releases.

> Unauthenticated GitHub API is **60 requests/hour per IP**. For a busy CI matrix, use `GITHUB_TOKEN` or prefer the npm/channel endpoints (no rate limit).

### F. Verify a release's binary integrity against the signed manifest

```bash
VERSION="2.1.286"
REPO="https://downloads.claude.ai/claude-code-releases"

curl -fsSL https://downloads.claude.ai/keys/claude-code.asc | gpg --import
gpg --fingerprint security@anthropic.com   # expect 31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE

curl -fsSLO "${REPO}/${VERSION}/manifest.json"
curl -fsSLO "${REPO}/${VERSION}/manifest.json.sig"
gpg --verify manifest.json.sig manifest.json

# expected per-platform SHA-256 for linux-x64:
jq -r '.platforms["linux-x64"].checksum' manifest.json
```
Verified manifest for `2.1.286`: `version=2.1.286`, `buildDate=2026-09-30T15:55:40Z`, `linux-x64.checksum=fe503f65c6289d59c23e5b21ae44f03583f997dd33a2cbfc75ab4f96fb8fc73f`.

> Per <https://code.claude.com/docs/en/setup#binary-integrity-and-code-signing>: detached manifest signatures exist **from `2.1.89` onward**. Linux binaries are **not** individually code-signed — the manifest signature is the Linux integrity mechanism.

### G. GitHub release asset checksums (alternative integrity path)

```bash
curl -fsSL "https://github.com/anthropics/claude-code/releases/download/v${LATEST}/SHASUMS256.txt" | grep linux-x64
```
Verified for `v2.1.294`:
```
b6ff07e61fb06ac62019cbaddedc76147d859a0048cb30417595c87eb1527656  claude-linux-x64-musl.tar.gz
c152a9520cbe30adfaa7dbff26016d74c668c7dfb093fca2a06fa72cb6e98369  claude-linux-x64.tar.gz
```

### H. Full GitHub Actions step — pin guard with a rebuild trigger

```yaml
- name: Resolve Claude Code upstream version
  id: cc
  run: |
    set -euo pipefail
    PINNED=$(grep -oP 'CLAUDE_CODE_VERSION=\K[0-9.]+' Dockerfile || echo "")
    LATEST=$(curl -fsSL https://registry.npmjs.org/@anthropic-ai/claude-code/latest | jq -r .version)
    STABLE=$(curl -fsSL https://downloads.claude.ai/claude-code-releases/stable)
    echo "pinned=${PINNED} npm_latest=${LATEST} stable_channel=${STABLE}"
    if [ -n "${PINNED}" ] && [ "${PINNED}" != "${LATEST}" ]; then
      echo "rebuild=true"   >> "$GITHUB_OUTPUT"
      echo "version=${LATEST}" >> "$GITHUB_OUTPUT"
    else
      echo "rebuild=false"  >> "$GITHUB_OUTPUT"
    fi
```

### I. Dockerfile pin pattern (recommended shape)

```dockerfile
FROM node:22-bookworm-slim
ARG CLAUDE_CODE_VERSION=2.1.294          # <- the value your CI updates
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}
ENV DISABLE_AUTOUPDATER=1                # background updates off
ENV DISABLE_UPDATES=1                    # also block `claude update` / `claude install`
ENV CLAUDE_CONFIG_DIR=/home/node/.claude
RUN useradd -m -u 1000 node && chown -R node:node /home/node
USER node
WORKDIR /workspace
```

### J. Failure modes these commands guard against

| Guard | Why |
|---|---|
| Use `dist-tags.latest`, **not** max-of-versions | `next` (`2.1.295`) > `latest` (`2.1.294`) today |
| Use the channel endpoint for the *rebuild* decision | It is literally the string the installer reads |
| `sort -V`, not string compare | `2.1.99` > `2.1.100` lexicographically |
| Paginate GitHub releases | A single fetch makes 239 releases look like 3 |
| Authenticate GitHub API calls in busy CI | 60 req/h unauthenticated |
| Verify `manifest.json.sig` | Linux binaries have no per-binary signature |

---

## Items marked UNVERIFIED

| Claim | Status |
|---|---|
| `ghcr.io/anthropics/claude-code` as an official image | **Does not exist / not resolvable.** Docs never mention it; GHCR tags endpoint returned `DENIED: invalid token`. No supported official app image exists. |
| `docker.io/anthropics/claude-code:latest` | Exists (1 tag, `latest`, last updated `2026-06-18`) but **referenced by no Anthropic doc**. Image layers are Debian trixie + `curl` + a custom `entrypoint.sh` — no Claude Code binary. **Provenance UNVERIFIED. Do not rely on it.** |
| `anthropics/claude-code-sandbox` GitHub repo | **HTTP 404 — does not exist.** |
| `CLAUDE_INSTALL_ALLOW_SUDO` | Present only in the `bootstrap.sh` source, absent from official env-vars docs. **UNVERIFIED against documentation.** |
| Any `CLAUDE_CODE_*` install-directory env var | **None found.** Grep of the full env-vars page yields no install-dir variable. Install paths are fixed (`~/.local/share/claude/versions/`, `~/.local/bin/claude`) or governed by `CLAUDE_CONFIG_DIR`. |
| GCS bucket object listing | Denied to anonymous callers (`storage.objects.list` → 401). Exact object paths required; the bucket cannot be enumerated. |
| Desktop app for Linux on non-Debian distros | **Not supported** — docs say use the CLI, and list Fedora/RHEL support as "coming in the future". |

---

## Source index (all URLs cited above)

**Official docs**
- <https://code.claude.com/docs/en/desktop-linux>
- <https://code.claude.com/docs/en/desktop>
- <https://code.claude.com/docs/en/desktop-quickstart>
- <https://code.claude.com/docs/en/desktop-wsl>
- <https://code.claude.com/docs/en/setup>
- <https://code.claude.com/docs/en/env-vars>
- <https://code.claude.com/docs/en/settings-reference>
- <https://code.claude.com/docs/en/authentication>
- <https://code.claude.com/docs/en/devcontainer>
- <https://code.claude.com/docs/en/sandbox-environments>
- <https://code.claude.com/docs/en/network-config>
- <https://code.claude.com/docs/en/troubleshoot-install>
- <https://code.claude.com/docs/en/claude-directory>
- <https://code.claude.com/docs/en/changelog>
- <https://code.claude.com/docs/llms.txt>

**Registries / APIs (live observations)**
- <https://registry.npmjs.org/@anthropic-ai/claude-code>
- <https://registry.npmjs.org/@anthropic-ai/claude-code/latest>
- <https://api.github.com/repos/anthropics/claude-code>
- <https://api.github.com/repos/anthropics/claude-code/contents/>
- <https://api.github.com/repos/anthropics/claude-code/releases>
- <https://api.github.com/repos/anthropics/claude-code/releases/latest>
- <https://api.github.com/repos/anthropics/claude-code/tags>
- <https://hub.docker.com/v2/repositories/anthropics/claude-code/>

**Anthropic-hosted artifacts**
- <https://claude.ai/install.sh> (302 → bootstrap.sh)
- <https://downloads.claude.ai/claude-code-releases/bootstrap.sh>
- <https://downloads.claude.ai/claude-code-releases/latest>
- <https://downloads.claude.ai/claude-code-releases/stable>
- <https://downloads.claude.ai/claude-code-releases/2.1.286/manifest.json>
- <https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/stable>
- <https://downloads.claude.ai/keys/claude-code.asc>
- <https://downloads.claude.ai/claude-desktop/key.asc>

**GitHub repos / files**
- <https://github.com/anthropics/claude-code>
- <https://github.com/anthropics/claude-code/blob/main/README.md>
- <https://github.com/anthropics/claude-code/blob/main/LICENSE.md>
- <https://github.com/anthropics/claude-code/blob/main/.devcontainer/Dockerfile>
- <https://github.com/anthropics/claude-code/blob/main/.devcontainer/devcontainer.json>
- <https://github.com/anthropics/devcontainer-features>
- <https://github.com/anthropics/devcontainer-features/blob/main/src/claude-code/install.sh>

**Secondary (informational only, not relied on for any claim)**
- <https://github.com/anthropics/claude-code/issues/20569> — `claude update` vs stable endpoint mismatch
- <https://github.com/anthropics/claude-code/issues/30332> — `claude update` re-downloads latest
- <https://github.com/anthropics/claude-code/issues/10079> — `DISABLE_AUTOUPDATER` doc gap
