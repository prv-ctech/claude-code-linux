# Maintaining

## How the image is built

- Base: `ghcr.io/linuxserver/baseimage-selkies:ubunturesolute`. Its s6 init handles PUID/PGID, UMASK, `/config` and the `abc` user.
- On top: Claude Desktop (Anthropic's apt `.deb`, signature and SHA256 checked), Google Chrome, gnome-keyring, Node 22 and the Claude Code CLI (npm, pinned).
- `rootfs/usr/local/bin/claude-init` runs as the `init-claude` s6 step on every start. It refreshes the Openbox autostart, removes a Chrome lock left by an old container, and turns on plugin marketplace auto-update.
- `rootfs/defaults/autostart` starts the keyring, then Claude Desktop.
- The image never updates itself. A rebuild is the only update path.

## CI (`.github/workflows/build.yml`)

- Every 6 hours, and on a push to `main`, it checks for a new Claude Desktop (`scripts/latest-upstream-version.sh`) and a new Claude Code CLI (npm `dist-tags.latest`).
- It rebuilds only when something changed. A recipe hash over every build input (`scripts/recipe-inputs.sh`) is compared with the hash on the published image (`scripts/published-recipe.sh`).
- Before pushing, a smoke test starts the image with PUID 99, PGID 100 and UMASK 002 and checks:
  - the versions;
  - who owns `/config`;
  - that port 3000 answers with no login;
  - that Xvfb, Openbox and Claude Desktop are running;
  - that Chrome works.
- `:latest` is moved only to an image that passed the smoke test.
- Only files that reach the image count. Editing the docs, the Unraid template, `compose.yaml` or `.env.example` starts no build. The icon is the exception: it is also the browser-tab icon, so changing it rebuilds.
- Bump `RECIPE_SCHEMA` when the way the hash is computed changes.

Force a build: **Actions → build → Run workflow**. Set `rebuild=true` to skip the registry check.

GitHub pauses scheduled workflows after 60 days without activity. A manual run or any commit wakes it up.

## Local checks

```bash
sh scripts/selfcheck.sh
```

This runs hadolint, shellcheck and the behaviour tests of the shell scripts. It needs no Docker.

## Tags

- `:latest`: what users get.
- `:<desktop-version>` and `:<desktop-version>-ubunturesolute`: the newest build of that Claude Desktop version. These can be re-pointed; the digest is the exact handle.

## Roll a user back

1. Get a known-good digest:

   ```bash
   docker buildx imagetools inspect ghcr.io/prv-ctech/claude-code-linux:<version>
   ```

2. In Unraid, set **Repository** to `ghcr.io/prv-ctech/claude-code-linux@sha256:<digest>` and click **Apply**.
3. Set it back to `:latest` once a fixed build is out.
