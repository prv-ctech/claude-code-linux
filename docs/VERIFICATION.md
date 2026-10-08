# Verification record — image artifact, PUID/PGID ownership, persistence, upstream detection

Task: **t4** (verifier), attempt 1. Date: 2026-10-08. Verifier: independent (did not
write the Dockerfile, the entrypoint, the scripts or the workflow).

Scope of this record: everything below was **re-derived from the artifacts in this
repository**, not copied from the authors' reports. Where a claim can only be made by
building and starting a container, the row is marked **CI-owned** and names the workflow
file, job, step and line that makes it — see §7 for the audit of those credits.

> **Note on absolute paths (provenance, not requirements).** The absolute paths quoted in
> the transcripts below — e.g. `/workspace/claude-code-linux`, `/tmp/lint/hadolint`,
> `/tmp/lint/shellcheck-v0.10.0/shellcheck`, `/tmp/t4-bin/jq`, and the `tar` line that
> excludes `.agent-teams` — are the paths of the host on which the evidence was recorded.
> They are quoted verbatim because the transcripts are the evidence and are deliberately
> **not** rewritten. They are not requirements on any other host, and none of them is a
> dependency of the shipped image. To reproduce the gate anywhere, supply the linters via
> `$HADOLINT` and `$SHELLCHECK`, let them resolve from `PATH`, or omit them and let
> `scripts/selfcheck.sh` fetch its own pinned, SHA256-verified downloads
> (`scripts/selfcheck.sh:49-53`, `:74-83`, `:133-191`) — a missing linter is a failure,
> never a silent skip.

## 0. Method, and the limits of this workspace

* **No container runtime exists here.** `command -v docker` returns nothing and exits 1.
  No image was built, pulled or started in this workspace, and **no docker command was
  executed here**, successfully or otherwise. Nothing in this document is a construction
  or container-start log.
* Two evidence classes are used, never mixed:
  * **observed here** — a command whose raw output is quoted in this file;
  * **CI-owned** — only `docker build` / starting a container can produce it; attributed
    by `file:line` to `.github/workflows/build.yml`, which is the whole reason the
    workflow exists.
* The gate `scripts/selfcheck.sh` is the only executable proof available without a
  container runtime, so it is both re-run (§2) and **falsified on purpose** (§2.2) to show
  that a green run means something.
* Versions of the host tools used, all resolved from the workspace or `/tmp`:
  `/tmp/lint/hadolint` → `Haskell Dockerfile Linter 2.15.1`;
  `/tmp/lint/shellcheck-v0.10.0/shellcheck` → `version: 0.10.0`;
  `jq` is **not** installed on this host, so the plan job's literal jq filter was executed
  with a real `jq 1.7.1` fetched to `/tmp/t4-bin/jq` (§5.2) — the jq *filter text* is
  copied byte-for-byte from `build.yml:125`.

## 1. Gate re-run and fault injection (acceptance 1)

### 1.1 Re-run, verbatim

```
$ cd /workspace/claude-code-linux
$ HADOLINT=/tmp/lint/hadolint SHELLCHECK=/tmp/lint/shellcheck-v0.10.0/shellcheck sh scripts/selfcheck.sh
```
exit status **0**, wall clock 20s. Output (52 lines) verbatim, head and tail:

```
=== 1/5 hadolint /tmp/lint/hadolint

=== 2/5 shellcheck, repository shell files
  shellcheck docker-entrypoint.sh
  shellcheck scripts/install-claude-desktop.sh
  shellcheck scripts/latest-upstream-version.sh
  shellcheck scripts/published-recipe.sh
  shellcheck scripts/recipe-inputs.sh
  shellcheck scripts/selfcheck.sh
  shellcheck rootfs/usr/local/bin/claude-desktop
  shellcheck rootfs/usr/local/bin/claude-desktop-session
  shellcheck rootfs/usr/local/bin/claude-keyring-init
...
=== 5/5 behaviour, with command stubs
  ok   PUID=99 exits 78 with the reason and the remediation, before anything is chowned
  ok   PGID=99 and 99/99 exit 78 as well
  ok   a missing base entrypoint exits 78 instead of half-starting
  ok   the unmounted warning fires on both start paths and only when nothing is mounted
  ok   without root: writable state runs the base entrypoint, unwritable state exits 78 with the fix, and a non-1000 uid is refused
  ok   the root path chowns once, drops with setpriv --init-groups, forwards TERM and exits 42 with the session
  ok   a refused chown exits 78 with the root-squash explanation and starts nothing
  ok   a failing --init-groups falls back to --clear-groups and still starts the session
  ok   a running secret service is probed with a real store/lookup/clear round trip, and the marker is published
  ok   a locked keyring warns, exits 1, and still publishes the marker
  ok   a secret service that never appears warns, exits 1, and still publishes the marker
  ok   CLAUDE_DESKTOP_AUTOSTART=false prints why and starts nothing
  ok   with the marker present the wrapper starts the app through the launcher
  ok   with no marker the wrapper warns and still starts the app
  ok   a missing packaged binary exits 127 with the reason
  ok   the launcher probes unshare, agrees with the real unshare on this host, and adds --no-sandbox only when namespaces are gone
  ok   the Dockerfile does not mention selfcheck (the gate is never shipped)

selfcheck: 17 checks passed; no docker, no container, no network.
selfcheck: runtime proof (build, boot, Selkies, PUID/PGID ownership on a real
selfcheck: volume) is CI-owned — DESIGN §R5 — and is asserted by the CI smoke test,
selfcheck: not here. This gate proves the shell, nothing about the built image.
```

`grep -c FAIL` over that output → `0`; `17 checks passed` matches the 17 `ok` lines
counted by hand. The gate's own final lines refuse to overclaim, which is the property
being tested here rather than its prose.

### 1.2 Deliberate fault injection — the gate must go red

The injections were made **in a throwaway copy** (`/tmp/t4-fault`); the repository's
`docker-entrypoint.sh` and `rootfs/**` were not modified. Copy command:

```
$ rm -rf /tmp/t4-fault && mkdir -p /tmp/t4-fault
$ tar cf - --exclude=.git --exclude=.agent-teams . | (cd /tmp/t4-fault && tar xf -)
```

**Injection A — a behavioural regression, not a syntax error.** `docker-entrypoint.sh`
exits 78 on a rejected PUID. Every `exit 78` was changed to `exit 79` (valid POSIX sh,
wrong behaviour — exactly what a real regression looks like):

```
$ sed -i 's/^\texit 78$/\texit 79/' docker-entrypoint.sh      # inside /tmp/t4-fault
$ SELFCHECK_CACHE=/tmp/t4-fault-cache HADOLINT=/tmp/lint/hadolint \
    SHELLCHECK=/tmp/lint/shellcheck-v0.10.0/shellcheck sh scripts/selfcheck.sh
```
exit status **1**, verbatim tail:

```
=== 5/5 behaviour, with command stubs
FATAL: PUID/PGID must be 1000/1000 (got PUID=99 PGID=100).
...
selfcheck: FAIL: puid78: expected exit 78, got 79 (env -i PATH=... PUID=99 PGID=100 FAKE_EUID=0 ... /tmp/t4-fault/docker-entrypoint.sh)
```

**Injection B — a pure lint fault** in another gated file (an unterminated `if` appended
to `rootfs/usr/local/bin/claude-desktop`):

```
$ SELFCHECK_CACHE=/tmp/t4-fault-cache HADOLINT=/tmp/lint/hadolint \
    SHELLCHECK=/tmp/lint/shellcheck-v0.10.0/shellcheck sh scripts/selfcheck.sh
```
exit status **1**:
```
  shellcheck rootfs/usr/local/bin/claude-desktop

In rootfs/usr/local/bin/claude-desktop line 49:
if [ "$x" = 1 ]; then
^-- SC1046 (error): Couldn't find 'fi' for this 'if'.
selfcheck: FAIL: shellcheck rejected a repository shell file
```

Both injections produce a non-zero exit naming the check that caught them: the green run
in §1.1 is load-bearing, and the linter gate is *not* silently skipping (§1.1 resolves
both linters from `$HADOLINT`/`$SHELLCHECK` and fails if either is unusable —
`selfcheck.sh:86`, `:162-163`).

## 2. PUID=99 → exit 78, re-derived independently (acceptance 2)

No stub, no harness, no copy: the repository's own file, the real host shell, the real
exit status.

```
$ cd /workspace/claude-code-linux
$ PUID=99 PGID=1000 sh docker-entrypoint.sh; echo "exit=$?"
FATAL: PUID/PGID must be 1000/1000 (got PUID=99 PGID=1000).
The Selkies desktop layer is rootless by design at uid 1000: /home/ubuntu, the
build-time fakeroot database and the root-owned setuid bracket all assume that
id, and no supported path remaps it. Set PUID=1000 and PGID=1000 and recreate
the container. If /mnt/user/appdata/claude-code-linux still cannot be written:
  chown -R 1000:1000 /mnt/user/appdata/claude-code-linux
exit=78
```

The guard is a literal string comparison (`docker-entrypoint.sh:82-84`), so it fails
closed for every other value and cannot be smuggled through by formatting. Measured here
on the real file:

| PUID | PGID | exit | first line of stderr |
|---|---|---|---|
| 1000 | 99 | 78 | `FATAL: PUID/PGID must be 1000/1000 (got PUID=1000 PGID=99).` |
| 99 | 1000 | 78 | `FATAL: PUID/PGID must be 1000/1000 (got PUID=99 PGID=1000).` |
| 0 | 0 | 78 | `FATAL: PUID/PGID must be 1000/1000 (got PUID=0 PGID=0).` |
| 01000 | 1000 | 78 | `FATAL: PUID/PGID must be 1000/1000 (got PUID=01000 PGID=1000).` |
| 1000 | 1000 | 78 | `FATAL: /etc/container-entrypoint.sh is missing or not executable.` (this host) |

The last row is the important negative control: with the supported ids the script does
**not** fail on the ids — it proceeds to the next precondition. The rejection is specific
to non-1000, not a blanket refusal. The rejection also fires **before** any `chown`
(`:82-84` precedes `:111`), which is what makes "no ownership is touched on a rejected
start" true rather than incidental.

## 3. State-mount ownership — the Unraid precondition, 99:100 (adversarial core)

**Answer, stated before the evidence: a `99:100` mount is not a special case, and the
container takes it over by construction.** It does not inspect the existing owner and does
not refuse; it takes one unconditional root step —
`chown -R 1000:1000 "${STATE_DIR}"` (`docker-entrypoint.sh:111`) — and only then drops to
uid 1000. If that `chown` itself fails, the container exits 78 **and names the fix
verbatim** (below), and nothing is half-started. Whether the ownership really lands on
`1000:1000` is a runtime fact and is asserted in CI (§3.2); what is proven here is that the
recovery path runs unconditionally for that input.

### 3.1 Why this cannot be done against the real image here

The `chown` branch needs uid 0 (`docker-entrypoint.sh:101`), and this workspace runs as
uid 99 without a container runtime. The branch is therefore reconstructed against the real
script with **a purpose-built stub PATH written for this task** (not the author's harness,
not `scripts/selfcheck.sh`): a real `99:100` mode-0700 state directory created on disk, an
`id` stub reporting euid 0, a logging `chown` stub that can be told to fail, a logging
`setpriv` stub, and a `/proc/self/mountinfo`-shaped fixture whose field 5 is the state
path. Harness: `/tmp/t4-h`.

```
$ stat -c 'mode=%a uid=%u gid=%g' /tmp/t4-h/state
mode=700 uid=99 gid=100
```

**S1 — the Unraid precondition, `chown` allowed:**
```
$ env -i PATH="$H/bin:/usr/bin:/bin" STUB_LOG=$H/log FAKE_EUID=0 PUID=1000 PGID=1000 \
    STATE_DIR=$H/state MOUNTINFO=$H/mountinfo DOCKER_ENTRYPOINT_PREFIX=$H/etc \
    sh /workspace/claude-code-linux/docker-entrypoint.sh
exit=0
# script stdout/stderr: (empty)
# commands the script actually issued, in order:
chown -R 1000:1000 /tmp/t4-h/state
setpriv --reuid=1000 --regid=1000 --init-groups /bin/true
setpriv --reuid=1000 --regid=1000 --init-groups /tmp/t4-h/etc/container-entrypoint.sh
```
So: `chown` on a `99:100` directory, then the privilege drop, then the base entrypoint —
in that order, unconditionally, and with no diagnostic noise for this expected state.

**S2 — the same start, with the `chown` refused** (a root-squashed export is the real
case):
```
$ env -i PATH="$H/bin:/usr/bin:/bin" STUB_LOG=$H/log FAKE_EUID=0 PUID=1000 PGID=1000 \
    CHOWN_STATUS=1 STATE_DIR=$H/state MOUNTINFO=$H/mountinfo \
    DOCKER_ENTRYPOINT_PREFIX=$H/etc sh /workspace/claude-code-linux/docker-entrypoint.sh
exit=78
FATAL: could not take ownership of /tmp/t4-h/state. The bind-mounted appdata is not
writable by root — a root-squashed NFS export does this. On the server that holds
the share, run:
  chown -R 1000:1000 /mnt/user/appdata/claude-code-linux
# commands issued: chown -R 1000:1000 /tmp/t4-h/state   (and nothing else)
```
Nothing is half-started: the base entrypoint is never invoked. The message names the one
command that fixes it, and it is the same string the Unraid template's `<Overview>`
carries (`unraid/claude-code-linux.xml:35-38`).

**S3 — started without root at all** (uid 99, ids correct), same 99:100 directory:
```
exit=78
FATAL: this container runs its session as uid 1000 and was started as
uid 99. The image drops privileges itself, precisely so that it can take
ownership of the state path first (§4.2). Either start it as root, or start it as
1000:1000 with /tmp/t4-h/state already owned by that id.
```
Refusing here is the correct outcome: without root the container cannot repair a state
path it does not own, so a silent start is exactly the "Selkies page that never
authenticates" failure the design set out to eliminate.

**S4 — nothing mounted at the state path:** the start fails as in S3 (this workspace's
uid) but precedes it with the durability warning, which is the instruction the user needs
before they lose a sign-in:
```
WARNING: nothing is mounted at /tmp/t4-h/state: Claude Desktop's sign-in, the keyring and the Chrome profile will be lost when this container is recreated. Mount a volume there (Unraid: Path → /home/ubuntu).
```

### 3.2 What CI covers, and what it does not

`build.yml:384-389` starts the smoke container with a bind mount of a directory the runner
created (`mkdir -p "$RUNNER_TEMP/state"`, `build.yml:379`) — that is owned by **root**, not
by `99:100`. `build.yml:426-427` then asserts the mount is `1000:1000` afterwards.

* Covered by CI: "a state directory the session does not own is taken over, and the result
  is really `1000:1000`". `chown -R` does not consult the previous owner, so this covers
  the `99:100` case as well.
* Covered **only** by §3.1 here: the literal `99:100` value, and the refusal message for a
  `chown` that cannot succeed. No CI step mounts a `99:100` directory and none makes the
  `chown` fail; see §9.

## 4. Upstream auto-update detection (two upstreams)

### 4.1 Desktop: the maximum `Version` in the signed apt index

```
$ sh scripts/latest-upstream-version.sh --json
{"version":"2.26454.2","sha256":"b251a0224a8635874f33598df8ed8952b427f84815ee59580cc022d6bdb2430f","filename":"pool/main/c/claude-desktop/claude-desktop_2.26454.2_amd64.deb","deb_url":"https://downloads.claude.ai/claude-desktop/apt/stable/pool/main/c/claude-desktop/claude-desktop_2.26454.2_amd64.deb","index_url":"https://downloads.claude.ai/claude-desktop/apt/stable/dists/stable/main/binary-amd64/Packages","stanzas":50,"min_version":"2.0.0"}
exit=0
```
This matches, exactly, the version and SHA256 that the locked build contract recorded for
the same index on the same day (t1 result, `docs/DESIGN.md` D2): the signal has not drifted
and the resolver is reproducible from a second, independent execution.

**Version-ordering trap.** A fixture with `Version: 2.9.0` and `Version: 2.10.0` for
`claude-desktop`, plus a decoy stanza `Package: claude-desktop-helper` at `9.99.9`:

```
$ INDEX_URL="file:///tmp/t4-fix/Packages" sh scripts/latest-upstream-version.sh --json
{"version":"2.10.0","sha256":"ccc0...","filename":"pool/main/c/claude-desktop/claude-desktop_2.10.0_amd64.deb",...,"stanzas":2,...}
$ grep '^Version: ' /tmp/t4-fix/Packages | cut -d' ' -f2 | sort     | tail -1
9.99.9            # a lexical max picks the decoy
$ grep '^Version: ' /tmp/t4-fix/Packages | cut -d' ' -f2 | sort -V  | tail -1
9.99.9
```
The resolver answered `2.10.0` and reported `stanzas: 2` — `sort -V` ordering, and the
`Package: claude-desktop` stanza filter excluding the `9.99.9` decoy (`latest-upstream-version.sh:49`,
`:60`, `:68`).

**The same trap, with the decoy removed** (only `2.9.0` and `2.10.0`, which is the case a
lexical compare gets wrong):
```
$ grep '^Version: ' /tmp/t4-fix/Lexical | cut -d' ' -f2 | sort    | tail -1
2.9.0            # what a lexical max would have pinned
$ grep '^Version: ' /tmp/t4-fix/Lexical | cut -d' ' -f2 | sort -V | tail -1
2.10.0
$ INDEX_URL=file:///tmp/t4-fix/Lexical sh scripts/latest-upstream-version.sh
2.10.0
```

**Fail-closed paths**, both non-zero rather than "newest available":
```
$ INDEX_URL="file:///tmp/t4-fix/Empty" sh scripts/latest-upstream-version.sh
FATAL: no 'Package: claude-desktop' stanza in file:///tmp/t4-fix/Empty
exit=1
$ INDEX_URL="file:///tmp/t4-fix/Packages" MIN_VERSION=3.0.0 sh scripts/latest-upstream-version.sh
exit=1
```

**The pin is fetchable and its hash is the index's hash** — the two things that make the
pin real rather than a string in a table:
```
$ curl -fsSI <claude-desktop_2.26454.2_amd64.deb>   | head -1
HTTP/2 200
$ curl -fsSL -o /tmp/t4-claude-desktop.deb <same URL> && sha256sum /tmp/t4-claude-desktop.deb
b251a0224a8635874f33598df8ed8952b427f84815ee59580cc022d6bdb2430f  /tmp/t4-claude-desktop.deb
```
identical to the `sha256` field above, over a 180,943,856-byte download.

### 4.2 CLI: `dist-tags.latest`, never `next`, never a max scan

The selector is inline in the workflow (`build.yml:125`, gate at `:126`), so it was
executed with a real `jq` against the live packument and against a purpose-built trap:

```
$ jq -c '."dist-tags"' /tmp/t4-packument.json
{"stable":"2.1.286","next":"2.1.295","latest":"2.1.294"}
$ jq -r '."dist-tags".latest' /tmp/t4-packument.json          # build.yml:125 verbatim
2.1.294
$ jq -r '[.versions|keys[]]|map(select(test("^[0-9]+\\.[0-9]+\\.[0-9]+$")))|sort_by(split(".")|map(tonumber))|last' /tmp/t4-packument.json
2.1.295
```
**The trap is live, not hypothetical**: a max scan over `versions[]` answers `2.1.295` —
the deliberately-ahead `next` — while the shipped selector answers `2.1.294`. With the
fixture `{"latest":"2.1.294","next":"9.0.0","stable":"2.1.286"}` and `versions` containing
`2.1.294`, `8.0.0`, `9.0.0`:

```
exact selector -> 2.1.294
version regex (build.yml:126) ACCEPTS '2.1.294'
max-scan on same fixture -> 9.0.0
REJECT '2.1.294-beta.1'   REJECT 'v2.1.294'   REJECT ''
```
`next` beats `latest` in both fixtures and `latest` still wins. The `^[0-9]+\.[0-9]+\.[0-9]+$`
gate rejects a pre-release and a `v`-prefixed tag instead of pinning them.

### 4.3 CI-owned remainder for detection

That a *new* upstream version actually results in a rebuilt and republished image — the
sweep, the skip-if-unchanged decision, and the push — is end-to-end and CI-owned:
`build.yml:19-23` (6-hourly cron), job `plan` (`:78`), step *Resolve desktop signal*
(`:100`, invoking the script at `:104`), step *Resolve CLI signal* (`:113`), step *Compute
recipe hash base* (`:146`), step *Decide what to build* (`:186`) with the fetchability walk
(`:213-228`, ranged GET at `:221`), the "already published with this recipe" short-circuit
(`:243-252`) and the walked-down candidate chosen as the single build target (`:270-277`).
No run's output is quoted anywhere in this record.

## 5. Guarantee → evidence map (acceptance 3)

Each row: what the user was promised, what is proven here, the command, the observed
result, and the CI-owned remainder with its job/step/line.

### G1 — "auto-rebuilt whenever Anthropic publishes a newer claude-desktop version"

| | |
|---|---|
| Evidence here | §4.1, §4.2 |
| Commands | `sh scripts/latest-upstream-version.sh --json`; `INDEX_URL=file://… sh scripts/latest-upstream-version.sh --json`; `jq -r '."dist-tags".latest'` (live + trap fixture); `curl -fsSI <deb>`; `sha256sum` |
| Observed | desktop `2.26454.2` / sha256 `b251a0…` and a 200 on the .deb whose hash matches the index; CLI `2.1.294` while `next` is `2.1.295` and a max scan yields `2.1.295`; both fail-closed paths exit 1 |
| CI-owned remainder | that a bump produces a build + push: `build.yml` job `plan` (`:78`), steps `:100` (desktop), `:113` (CLI), `:186` (decision, incl. `:213-228` fetchability and `:243-252` up-to-date short-circuit); job `build` `:315`; job `latest` `:506` |

### G2 — "Unraid PUID/PGID 1000/1000 compatibility"

| | |
|---|---|
| Evidence here | §2, §3.1 |
| Commands | `PUID=99 PGID=1000 sh docker-entrypoint.sh`; the id/PUID/PGID matrix; the `/tmp/t4-h` stub reconstruction of the root branch (S1–S4) |
| Observed | every non-`1000` value → `exit 78` with `FATAL: PUID/PGID must be 1000/1000 …`; a `99:100` state directory is unconditionally `chown`ed to `1000:1000` and the session is dropped with `setpriv --init-groups`; a refused `chown` exits 78 naming `chown -R 1000:1000 /mnt/user/appdata/claude-code-linux`; nothing mounted → the "sign-in will be lost" warning |
| Packaging alignment | `unraid/claude-code-linux.xml:66,70` default `PUID`/`PGID` to `1000`; `:62` binds appdata to container target `/home/ubuntu`; `:35-38` carries the same remediation line |
| CI-owned remainder | the real root bootstrap in a container: `build.yml:370` step *Smoke test (gates the push)* — pid 1 root `:421-422`, session identity `1000:1000` `:423-425`, mount owner `1000:1000` `:426-427`, PUID=99 exits 78 `:434-439` |

### G3 — "streamed to a browser via Selkies"

| | |
|---|---|
| Command | `grep -n '^ARG BASE_IMAGE\|^FROM\|^ENTRYPOINT' Dockerfile`; `grep -n '^HEALTHCHECK\|^EXPOSE\|^VOLUME' Dockerfile`; `docker-entrypoint.sh:201` |
| Observed output | `59:ARG BASE_IMAGE=ghcr.io/selkies-project/selkies/desktop:2.0.0-ubuntu26.04`, `60:FROM ${BASE_IMAGE}`, `402:ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]`; the second grep prints nothing and exits 1 (no anchored directive), and `Dockerfile:135-137` says why: health and port are the base's — `HEALTHCHECK` on `https://localhost:8080/api/health`, `EXPOSE 8080` — and "neither is repeated here" |
| Evidence | the streaming stack is the base image's, un-replaced: the entrypoint `exec`s the base's own entrypoint (`docker-entrypoint.sh:201`) instead of rewriting its s6 service set; 8080 is the only port served; TLS is self-signed, hence `-k`; WebRTC/TURN are opt-in and asserted nowhere (`compose.yaml:48-51`, `unraid/claude-code-linux.xml:58-60`) |
| CI-owned remainder | that the base actually serves over TLS **from this image**: `build.yml:370` smoke step — health reaches `healthy` in the poll `:391-406`, then `curl -k … https://localhost:8080/api/health` must return `200` `:429-430`. Note the only HTTP assertion in the whole workflow is `/api/health`; the site root is never used as evidence |

### G4 — "runs the official Claude Desktop for Linux (Anthropic apt repo) plus Google Chrome"

| | |
|---|---|
| Command | §4.1 (`sh scripts/latest-upstream-version.sh --json`, `curl -fsSI <deb>`, `sha256sum`); `grep -n '^ARG CLAUDE_DESKTOP_VERSION\|^ARG CLAUDE_CODE_VERSION' Dockerfile`; `grep -n 'command -v claude-desktop\|command -v google-chrome\|google-chrome.desktop' Dockerfile` |
| Observed output | `69:ARG CLAUDE_DESKTOP_VERSION=2.26454.2`, `72:ARG CLAUDE_CODE_VERSION=2.1.294` — the first equals the live index maximum and its .deb is fetchable with a matching hash (§4.1); `375:    command -v claude-desktop > /dev/null; \`, `376:    command -v google-chrome > /dev/null; \`, `379:    test -e /usr/share/applications/google-chrome.desktop; \` |
| Evidence | the installer's chain, read but not modified: signing key pinned by SHA256 (`scripts/install-claude-desktop.sh:78-80`), `gpgv` + `VALIDSIG` fingerprint (`:91-105`), stanza taken from the fetched index and SHA256 cross-checked against the caller's pin (`:108-148`), downloaded .deb hashed against the stanza (`:152-154`), installed version re-asserted from dpkg (`:197`) — with the §7 discrepancy against its own comment; `Dockerfile:375-384` asserts the desktop binary, Chrome, `gnome-keyring-daemon`, `secret-tool` and `HOME=/home/ubuntu` during the build |
| Note | Chrome is **not** installed by this Dockerfile — it comes from the Selkies base and is only asserted (`Dockerfile:376`, `:379`); the CLI is pinned to `2.1.294` (`Dockerfile:72`) and shipped as the KVM-free fallback |
| CI-owned remainder | that the install succeeds in a real build and that dpkg then reports exactly the plan's version: `build.yml:315` job `build`, build step `:331` (`:347-366`), smoke assertion `dpkg-query … claude-desktop` `:409-410`; the CLI assertion `:416-418`; the build-time `command -v` assertions are executed as part of the build step itself |

### G5 — prerequisites for a claude.ai sign-in (interactive sign-in itself out of scope)

| | |
|---|---|
| Command | `grep -n 'gnome-keyring\|libsecret-1-0\|libsecret-tools' Dockerfile`; `HADOLINT=… SHELLCHECK=… sh scripts/selfcheck.sh` (§1.1) |
| Observed output | `256:        gnome-keyring \`, `257:        libsecret-1-0 \`, `258:        libsecret-tools \`, plus `377:    command -v gnome-keyring-daemon > /dev/null; \` and `378:    command -v secret-tool > /dev/null; \`; and the gate's four `ok` lines about the secret service, quoted verbatim in §1.1 |
| Evidence | the gate's stub-level round trip is green including the two failure paths (*locked keyring*, *service never appears*) which warn, exit 1, and still publish the readiness marker the session wrapper waits for; `CLAUDE_CONFIG_DIR` is forced under `/home/ubuntu` or the build fails (`Dockerfile:382-384`) |
| CI-owned remainder | **none exists.** No CI step asserts the secret service, the app's window, or the CLI's credentials. The live round trip is asserted only *inside the container at start* by `claude-keyring-init` (which is what makes the failure loud) and at stub level by the gate |
| Note | launching the desktop under the session's X display is likewise exercised only at stub level: the launcher probes `unshare`, is asserted against the host's real `unshare`, and adds `--no-sandbox` only when user namespaces are gone (§1.1, 17/17) |
| Out of scope | the claude.ai sign-in itself: it requires a human, and is not claimed anywhere in this record |

## 6. Does CI really make the runtime proof it is credited with? (acceptance 4)

Every citation in this section is to `.github/workflows/build.yml` source. Rows here
credit what the workflow performs; they are not reports of results.

### 6.1 The build job does build the image and then smoke-test the running container

* Job `build` (`:315`) runs only when the plan says there is something to build
  (`:316-317`), after `docker/setup-buildx-action` (`:322`) and a GHCR login (`:324-329`).
* Build step *Build linux/amd64 with load true, not yet pushed* (`:331-368`): single
  `linux/amd64` build, `--load`ed into the local engine (`:347-349`) and tagged
  `:$VERSION`, `:$VERSION-$FLAVOR` and a local smoke ref (`:363-365`). `:latest` is
  deliberately **not** among the built tags — the comment at `:344-346` says so.
* Smoke step *Smoke test (gates the push)* (`:370-451`): the container is started with a
  real bind mount of the state path and 8080 published (`:384-389`), then the step asserts
  — health reaches `healthy`, or the job fails with the container log (`:391-406`);
  `dpkg-query` version equals the plan (`:409-410`); the CLI reports the pin, as uid
  `1000:1000` with `HOME=/home/ubuntu` (`:416-418`); pid 1 is root (`:421-422`); the session
  identity is `1000:1000` (`:423-425`); the state mount ends up owned `1000:1000`
  (`:426-427`); `https://localhost:8080/api/health` returns `200` over the self-signed
  certificate (`:429-430`); and a container started with `PUID=99` exits `78` with
  `PUID/PGID must be 1000/1000` in its output (`:433-439`). Every failure path is `exit 1`,
  so a failed assertion stops the job before the next step.
* Evidence is durable, not just logged: the assertion table is appended to the run summary
  (`:441-451`) and the container log is uploaded as an artifact (`:493-500`).

### 6.2 `:latest` only ever moves from a smoke-tested digest

* The smoke step `exit 1`s on any failed assertion (`:406, :410, :418, :422, :425, :427,
  :430, :437, :439`) and step order is unconditional, so the push step (`:459-468`) cannot
  execute in a run whose smoke test failed. A failed push is retried once (`:470-483`), and
  what it pushes is the same local image the smoke test read.
* The `latest` job (`:506`) requires `needs.plan.outputs.publish_latest == 'true'` **and**
  that either nothing was built or the build job succeeded (`:508-510`) — a failed build
  blocks the move.
* The move is a manifest copy by digest, never a rebuild (`:521-549`): it reads the source
  tag's digest (`:530-531`), copies it with `--prefer-index=false` so the source manifest
  bytes are written through rather than re-wrapped (`:545-546`), re-reads `:latest`
  (`:547-548`) and asserts equality with the source digest (`:550-551`) — the assertion is
  only meaningful because of `--prefer-index=false`, which the comment at `:540-544`
  explains.
* In the "nothing to build" path there is no smoke test in that run, so the link is the
  recipe label: the plan job compares the published image's
  `org.opencontainers.image.claude-code-linux-recipe` label (`:359`, `:362`) read back from
  GHCR (`:243`) against the hash it just computed (`:248`). That label is written only by a
  run that had already passed the smoke step, so the copy still lands on a smoke-gated
  digest. Residual, stated for completeness: that label is the only link in that path —
  nothing re-verifies the source image at copy time.
* `build.yml:490` reads back the pushed digest and records it in the summary, but the
  workflow does not assert that digest against the local image id. That comparison is
  redundant — `docker push` sends the local image — yet it is the one assertion that would
  catch a registry-side substitution; it is not present.

### 6.3 Where the smoke test is weaker than the Unraid flow

The smoke container's state directory is created by the runner (`:379`), so it is owned by
root and not by `99:100`; and no step makes the `chown` fail. The general
"not owned by the session → taken over → really `1000:1000`" case is asserted (`:426-427`);
the literal `99:100` value and the root-squash refusal message are covered only by §3.1
here.

## 7. Discrepancy found while auditing G4

`scripts/install-claude-desktop.sh:22` claims, as part of the six-step install chain:

> `#      the SHA256 of every Packages file, which is what makes step 2 trustworthy.`

No such comparison exists in the file. `grep -n Packages scripts/install-claude-desktop.sh`
returns four hits — the comment at `:22`, the index URL at `:53`, the `fetch` at `:108` and
the `awk` at `:125` — and none of them hashes the fetched `Packages` against the
`InRelease` that `gpgv` just validated at `:91-105`.

* Consequence: the signing key (SHA256-pinned) and `InRelease` (signature + fingerprint)
  authenticate the repository, but the `Packages` index the stanza is read from is anchored
  by TLS alone, so the stanza's `Version`/`SHA256` are not bound to the signature.
* Impact is narrower than it sounds because the pair is self-consistent — the `.deb` is
  hashed against that same stanza (`:152-154`) and against the caller's pin (`:142-143`) —
  and both the pin and the stanza originate from the same index fetch, so this is not a
  silent-corruption path; it is a *missing* anchor, not a wrong one.
* Severity: medium, and code-only. It is outside this task's in-scope path
  (`docs/VERIFICATION.md`), so it is recorded here rather than fixed. The claim in the
  comment should be either implemented (compare the fetched `Packages` SHA256 with the
  `InRelease` entry) or deleted so the recorded chain matches the code.

## 8. The single remaining unproven item

**No image built from this tree has ever been built, started or observed serving
anywhere.** In this workspace there is no container runtime at all; and the workflow that
would do it has never executed for this repository — `GET
https://api.github.com/repos/prv-ctech/claude-code-linux/actions/runs` returns
`"total_count": 0`, `git ls-remote origin` returns no refs, and an anonymous GHCR pull
token for `prv-ctech/claude-code-linux` answers `HTTP 403 {"errors":[{"code":"DENIED",
"message":"requested access to the resource is denied"}]}` (no published package). Every
row marked **CI-owned** in §5 and §6 — boot, Selkies on `https://localhost:8080/api/health`,
the desktop and CLI binaries in a running session, the keyring round trip, and the real
`99:100` state-mount recovery — depends on that first successful run, and none of it is
verified by this record.

## 9. Reproduction index

| # | Command (from `/workspace/claude-code-linux`) | Exit | Recorded at |
|---|---|---|---|
| 1 | `HADOLINT=/tmp/lint/hadolint SHELLCHECK=/tmp/lint/shellcheck-v0.10.0/shellcheck sh scripts/selfcheck.sh` | 0 | §1.1 |
| 2 | same, in `/tmp/t4-fault` after `sed -i 's/^\texit 78$/\texit 79/' docker-entrypoint.sh` | 1 | §1.2 A |
| 3 | same, in `/tmp/t4-fault` after appending an unterminated `if` to `rootfs/usr/local/bin/claude-desktop` | 1 | §1.2 B |
| 4 | `PUID=99 PGID=1000 sh docker-entrypoint.sh` | 78 | §2 |
| 5 | the id matrix at §2 (5 runs, `PUID`/`PGID` varied) | 78 except the negative control | §2 |
| 6 | `/tmp/t4-h` stub reconstruction, S1 / S2 / S3 / S4 | 0 / 78 / 78 / 78 | §3.1 |
| 7 | `sh scripts/latest-upstream-version.sh --json` | 0 | §4.1 |
| 8 | `INDEX_URL=file:///tmp/t4-fix/Packages sh scripts/latest-upstream-version.sh --json`; and `INDEX_URL=file:///tmp/t4-fix/Lexical sh scripts/latest-upstream-version.sh` | 0 | §4.1 |
| 9 | `INDEX_URL=file:///tmp/t4-fix/Empty sh scripts/latest-upstream-version.sh` | 1 | §4.1 |
| 10 | `INDEX_URL=… MIN_VERSION=3.0.0 sh scripts/latest-upstream-version.sh` | 1 | §4.1 |
| 11 | `curl -fsSI <deb>` / `curl -fsSL -o … && sha256sum …` | 0 | §4.1 |
| 12 | `jq -r '."dist-tags".latest' /tmp/t4-packument.json` (and the trap fixture, and the max-scan comparison) | 0 | §4.2 |
| 13 | `git ls-remote origin`; `curl …/actions/runs`; GHCR anonymous token request | 0 / HTTP 200 / HTTP 403 | §8 |

Files read for this record and deliberately **not** modified: `Dockerfile`,
`docker-entrypoint.sh`, `scripts/*.sh`, `.github/workflows/build.yml`,
`unraid/claude-code-linux.xml`, `compose.yaml`; `rootfs/**` was exercised only through the
gate and shellcheck. The only file written is `docs/VERIFICATION.md`.
