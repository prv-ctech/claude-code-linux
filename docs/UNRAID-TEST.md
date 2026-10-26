# Unraid first-run test — what to do, and what to send back

This is the handoff for **your** side of the build: everything below happens on your Unraid server, not
in this repository. It assumes the code has been pushed to `prv-ctech/claude-code-linux` and that GitHub
Actions has run once. If it has not, do §1 and §2 first — they are also the two settings that silently
block that first run.

Target version of this test: Claude Desktop **2.26454.2** with the Claude Code CLI **2.1.294**, on
`ghcr.io/prv-ctech/claude-code-linux:latest`.

## 1. Two settings that will block the first build

**a) GitHub Actions must be allowed to write packages.** In the repository: *Settings → Actions →
General → Workflow permissions* → **Read and write permissions** → Save. Without this the build fails at
the push step with `denied: permission_denied: write_package` and no image is ever created. (A single
such failure on the very first push is expected — GHCR creates the package on first write and the
workflow retries once.)

**b) The package is private, so pulling it needs a login.** Start the build: *Actions → build → Run
workflow* (nothing to fill in), wait for both jobs to go green. Then, **in the Unraid terminal**:

```bash
docker login ghcr.io -u YOUR-GITHUB-USERNAME
# password: a GitHub personal access token (classic) with the read:packages scope
```

Anonymous pulls fail with `denied`/`unauthorized`. The package stays private until the licensing review
closes; this README will say when that changes.

## 2. Install it

**Via Community Applications** — add the template repository once, then install:

1. *Apps* → *Settings* → *Template repositories*: add
   `https://raw.githubusercontent.com/prv-ctech/claude-code-linux/main/unraid/claude-code-linux.xml`
2. *Apps* → search *claude-code-linux* → *Install*.

**Or by hand** — *Docker → Add Container*, then set:

| Field | Value |
|---|---|
| Repository | `ghcr.io/prv-ctech/claude-code-linux:latest` |
| Network | `bridge` |
| WebUI Port (HTTP) | `3000` → container `3000` (for the reverse proxy) |
| WebUI Port (HTTPS) | `3001` → container `3001` (LAN, self-signed) |
| AppData path | `/mnt/user/appdata/claude-code-linux` → container `/config` |
| Workspace path (optional) | your projects folder → container `/workspaces` |
| PUID / PGID / UMASK | `99` / `100` / `002` (the Unraid defaults) |
| TZ | IANA zone, default `Etc/UTC` |
| Extra Parameters | `--restart=unless-stopped --shm-size=2g` |

`--shm-size=2g` is required — Docker's 64 MB default kills Chrome in this desktop. There is no desktop
login; do not add `CUSTOM_USER`/`PASSWORD` unless you want nginx basic auth in front of the reverse
proxy's.

Coming from the old `/home/ubuntu` image? Use a new, empty AppData folder: the old one is uid 1000 and
uses the old layout.

**Non-Unraid hosts, or if you prefer compose on Unraid:**

```bash
git clone https://github.com/prv-ctech/claude-code-linux && cd claude-code-linux
cp .env.example .env        # CLAUDE_PUID/CLAUDE_PGID/CLAUDE_UMASK: your host's ids
docker compose up -d
docker compose logs -f
```

## 3. First run

1. Open the session through your reverse proxy (pointed at port `3000`), or on the LAN at
   **`https://<your-unraid-ip>:3001`**; the certificate is self-signed, so accept it once. There is no
   desktop login.
2. Claude Desktop starts by itself and its sign-in page opens in **Google Chrome**. Sign in with your
   Anthropic account.
3. You should land on the Claude Desktop window. The Claude Code CLI is also there: *Terminal* in the
   desktop's right-click menu, or `docker exec -it -u abc claude-code-linux claude`.
4. **Do not forward 3000 or 3001 to the Internet.** The session holds your claude.ai and Claude Code
   credentials, and the reverse proxy is the only gate.

## 4. Confirm it is healthy

```bash
docker inspect --format '{{.State.Health.Status}}' claude-code-linux     # healthy
docker exec claude-code-linux dpkg-query -W -f='${Version}' claude-desktop   # 2.26454.2
docker exec claude-code-linux id abc                                     # uid=99 gid=100
ls -ln /mnt/user/appdata/claude-code-linux | head                        # owned by 99 100
```

Then close the browser tab, reopen the WebUI, and check that **you are still signed in** — nothing should
ask you to sign in again. That is the persistence promise this test exists to confirm.

## 5. One caveat about automatic updates

GitHub disables a repository's scheduled workflows after **60 days without activity** (a commit, a pull
request, a manual run — automatic scheduled runs do not count). When that happens the upstream sweep stops
silently and the last image simply stays in place; nothing breaks, but you stop getting new versions.

Noticing it: *Actions → build* shows the last scheduled run as old, or the workflow is marked disabled.

Recovering:

- *Actions → build → **Run workflow*** — one click, builds on demand **and** resets the 60-day clock.
- Or *Actions → build → **Enable workflow*** if GitHub already disabled it.
- Or push any commit.

## 6. If something fails, send back exactly this

```
1. uname -m                                        # is this x86_64? arm64 is not supported
2. docker logs --tail 100 claude-code-linux
3. docker inspect --format '{{.State.Health.Status}} {{.State.Status}}' claude-code-linux
4. docker exec claude-code-linux id abc 2>&1 || true
5. ls -ln /mnt/user/appdata/claude-code-linux | head
6. docker inspect --format '{{index .RepoDigests 0}}' claude-code-linux
7. the exact command you ran and its full output (e.g. the `docker login` or the `docker pull` line)
```

That set answers almost every first-run question without a round trip: whether the host architecture is
supported at all, whether the image pulled (and which digest), whether the container is alive but
unhealthy, whether the session uid matches the appdata owner, and whether the failure was authentication,
permissions or the application itself.
