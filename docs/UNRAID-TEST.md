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
| WebUI Port | `8080` → container `8080` |
| AppData path | `/mnt/user/appdata/claude-code-linux` → container `/home/ubuntu` |
| PUID / PGID | **`1000` / `1000`** — leave them exactly there |
| PASSWD | a password you choose — **required**, no default |
| Extra Parameters | `--shm-size=2g` |

**Keep PUID and PGID at 1000/1000.** Unraid's own default is 99/100, but this image is rootless at uid
1000 and refuses any other value: the container exits with code `78` and a message saying so. That is not
a bug to work around; there is no remap.

`--shm-size=2g` is required too — Docker's 64 MB default kills the browsers in this desktop.

**If a start still reports a permission or write error**, run this once on the Unraid terminal and start
the container again:

```bash
chown -R 1000:1000 /mnt/user/appdata/claude-code-linux
```

(Unraid creates that directory as `nobody:users` = 99:100 before the container exists. The image re-chowns
it at every start, so this line is the fallback, not the normal path.)

**Non-Unraid hosts, or if you prefer compose on Unraid:**

```bash
git clone https://github.com/prv-ctech/claude-code-linux && cd claude-code-linux
cp .env.example .env        # set CLAUDE_PASSWORD; leave CLAUDE_PUID/CLAUDE_PGID at 1000
docker compose up -d
docker compose logs -f
```

## 3. First run

1. Open the WebUI on **`https://<your-unraid-ip>:8080`**. The certificate is self-signed, so the browser
   warns — accept it and continue.
2. Log in to the desktop: user **`ubuntu`**, password = the `PASSWD` you set.
3. Claude Desktop starts by itself and its sign-in page opens in **Google Chrome**. Sign in with your
   Anthropic account.
4. You should land on the Claude Desktop window. The Claude Code CLI is also there: open a terminal in
   the session (or `docker exec -it claude-code-linux bash`) and run `claude`.
5. **Do not forward port 8080 to the Internet.** The session holds your claude.ai and Claude Code
   credentials and the TLS certificate is self-signed; the desktop login is the only gate.

## 4. Confirm it is healthy

```bash
docker inspect --format '{{.State.Health.Status}}' claude-code-linux     # healthy
docker exec claude-code-linux dpkg-query -W -f='${Version}' claude-desktop   # 2.26454.2
docker exec -u 1000 claude-code-linux id -u                              # 1000
ls -ln /mnt/user/appdata/claude-code-linux | head                        # owned by 1000 1000
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
4. docker exec -u 1000 claude-code-linux id 2>&1 || true
5. ls -ln /mnt/user/appdata/claude-code-linux | head
6. docker inspect --format '{{index .RepoDigests 0}}' claude-code-linux
7. the exact command you ran and its full output (e.g. the `docker login` or the `docker pull` line)
```

That set answers almost every first-run question without a round trip: whether the host architecture is
supported at all, whether the image pulled (and which digest), whether the container is alive but
unhealthy, whether the session uid matches the appdata owner, and whether the failure was authentication,
permissions or the application itself.
