# Shipping a Docker image as an Unraid Community Applications template with PUID/PGID = 1000/1000

Research date: web-only. Every schema claim below is cited to a URL. Items I could not confirm from a primary source are marked **UNVERIFIED**.

Primary sources used throughout:

- [CA XML Field Reference](https://ca.unraid.net/submit/help/xml-field-reference) — parser-backed catalog of public XML tags
- [CA Repository XML Format](https://ca.unraid.net/submit/help/repository-xml) — minimum template contract
- [CA starter `example-app.xml`](https://raw.githubusercontent.com/unraid/unraid-community-apps-starter/main/templates/example-app.xml) — canonical commented starter
- [`webgui` `include/Helpers.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/Helpers.php) — template XML → `docker create` command builder
- [`webgui` `include/DockerClient.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/DockerClient.php) — digest-based update check, label read-back
- [`webgui` `include/DockerContainers.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/DockerContainers.php) — update-state UI
- [Unraid Docs — Managing & customizing containers](https://docs.unraid.net/unraid-os/using-unraid-to/run-docker-containers/managing-and-customizing-containers/)
- [Unraid Docs — Shares](https://docs.unraid.net/unraid-os/using-unraid-to/manage-storage/shares/)
- [LinuxServer.io — Understanding PUID and PGID](https://docs.linuxserver.io/general/understanding-puid-and-pgid/)
- [`linuxserver/docker-baseimage-ubuntu` `init-adduser/run`](https://github.com/linuxserver/docker-baseimage-ubuntu/blob/master/root/etc/s6-overlay/s6-rc.d/init-adduser/run)
- [LinuxServer.io — docker-chrome](https://docs.linuxserver.io/images/docker-chrome/)
- [jlesage/docker-templates `firefox.xml`](https://raw.githubusercontent.com/jlesage/docker-templates/master/jlesage/firefox.xml) — real-world browser+desktop CA template
- [Docker run reference](https://docs.docker.com/reference/cli/docker/container/run/) · [`docker/cli` `docker-run.1.md`](https://github.com/docker/cli/blob/master/man/docker-run.1.md) · [dockerd reference](https://docs.docker.com/reference/cli/dockerd/)
- [Docker — Seccomp security profiles](https://docs.docker.com/engine/security/seccomp/)

---

## 1. Unraid CA template XML

### 1.1 Root element and required fields

The root element is `<Container version="2">`. The `2` is the template schema version; the starter explicitly states *"v2 templates should define ports/paths/variables with Config entries"* ([starter](https://raw.githubusercontent.com/unraid/unraid-community-apps-starter/main/templates/example-app.xml)).

Minimum accepted by the CA parser ([field reference](https://ca.unraid.net/submit/help/xml-field-reference), level `minimum`):

| Tag | Level | Parser note (verbatim) |
| --- | --- | --- |
| `<Name>` | minimum | Display name shown in Community Apps. |
| `<Repository>` | minimum | Docker image reference for the application. |

The repository format doc adds: *"Your repository must contain valid template XML files. For scan success, each app entry must include either a `<Repository>` tag for Docker applications or a `<PluginURL>` tag for plugins"* and *"Include readable `<Name>` and `<Overview>` content"* ([repository-xml](https://ca.unraid.net/submit/help/repository-xml)).

The starter adds a hard requirement in comments: *"NOTE: Either Support or Project is REQUIRED"* ([starter](https://raw.githubusercontent.com/unraid/unraid-community-apps-starter/main/templates/example-app.xml)). This is a documentation-level requirement, not a parser `minimum` level — treat it as required for review.

### 1.2 Commonly used elements and what Unraid actually does with them

All mappings below are read directly from the command builder in [`Helpers.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/Helpers.php).

| Element | Level ([field ref](https://ca.unraid.net/submit/help/xml-field-reference)) | Effect |
| --- | --- | --- |
| `<Repository>` | minimum | Final argument to `docker create`; image reference. |
| `<Name>` | minimum | `--name=` value. |
| `<Registry>` | advanced | "Registry homepage URL shown for Docker templates." Starter emits the full image path (`https://ghcr.io/USER/app`), jlesage emits the Hub page (`https://hub.docker.com/r/jlesage/firefox/`) — both forms appear in the wild. Exact expected form: **UNVERIFIED**. |
| `<Network>` | advanced | `--net=<lowercased value>` unless `ExtraParams` already contains a network flag. |
| `<MyIP>` | advanced | `--ip=` / `--ip6=` (skipped for `host`/`none`). Parser "Accepted … but removed from final feed projection." |
| `<Privileged>` | advanced | `--privileged=true` only when the string is exactly `true` (case-insensitive). |
| `<Shell>` | advanced | Shell used for container exec actions. |
| `<ExtraParams>` | advanced | Appended raw immediately **before** the image reference. *"Parser source transforms and security checks may rewrite or reject unsafe values."* |
| `<PostArgs>` | — (not in public list) | Appended **after** the image reference (container command/args). Present in the builder; not documented in the public field reference. |
| `<Support>` | recommended | Support URL. Also surfaced in the container context menu. |
| `<Project>` | recommended | Homepage / source repo URL. |
| `<Overview>` | recommended | Primary summary. `<Description>` is legacy long text that is *"Promoted to `Overview` when `Overview` is missing, then removed from parser output."* |
| `<Category>` | recommended | "Legacy category string normalized into `CategoryList`." Starter uses `Tools:System`. |
| `<Icon>` | recommended | Icon URL. Becomes the `net.unraid.docker.icon` label at create time. |
| `<WebUI>` | advanced | Becomes the `net.unraid.docker.webui` label; supports `[IP]` and `[PORT:<containerPort>]` placeholders. |
| `<TemplateURL>` | recommended | Canonical raw template URL, used for identity and review. |
| `<Date>` | advanced | *"Legacy date input accepted from XML and normalized against feed first-seen metadata."* Format per starter: `YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS`. In jlesage's template `<Date>` equals the last changelog release date — i.e. app release date, **not** template edit date and **not** an update trigger. |
| `<Beta>` | advanced | *"Legacy beta marker. Only `true` survives final output projection."* |
| `<Changes>` | advanced | Changelog text. |
| `<MinVer>` / `<MaxVer>` | advanced | Unraid version compatibility filtering. |
| `<License>` | advanced | Displayed in the app details popup. |
| `<ReadMe>`, `<ExtraSearchTerms>`, `<Requires>`, `<Screenshot>`, `<Video>`, `<Deprecated>`, `<DeprecatedMaxVer>` | advanced | As described by their names in the field reference. |

Additionally, the builder injects variables the image receives for free (no `<Config>` needed): `TZ`, `HOST_OS="Unraid"`, `HOST_HOSTNAME`, `HOST_CONTAINERNAME`, and `--pids-limit 2048` (or `DOCKER_PID_LIMIT`) when ExtraParams does not set one ([`Helpers.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/Helpers.php)).

### 1.3 `<Config>` attributes

Attribute set observed in the official starter and in a real-world CA template ([starter](https://raw.githubusercontent.com/unraid/unraid-community-apps-starter/main/templates/example-app.xml), [jlesage firefox.xml](https://raw.githubusercontent.com/jlesage/docker-templates/master/jlesage/firefox.xml)):

| Attribute | Meaning | Observed values |
| --- | --- | --- |
| `Name` | UI label | free text |
| `Target` | container-side identifier | container path for `Path`; **container port** for `Port`; env var name for `Variable`; label key for `Label` |
| `Default` | host-side / user-facing default | host path, **host port**, env value |
| `Mode` | mode qualifier | `rw`/`ro` (Path), `tcp`/`udp` (Port), empty for Variable |
| `Description` | help text under the field | free text |
| `Type` | drives which `docker create` flag is emitted | `Path`, `Port`, `Variable`, `Device`, `Label` |
| `Display` | visibility | `always`, `advanced`, `advanced-hide` (and `hidden`, which the webgui sets internally for the injected `/unraid` path) |
| `Required` | form validation | `true`/`True`, `false`/`False` |
| `Mask` | mask value in UI | `true`/`False` |

A `Value` attribute also exists: the builder prefers `Value` over `Default` when set (`$hostConfig = strlen($config['Value']) ? $config['Value'] : $config['Default'];`) — this is how Unraid persists user edits back into the template ([`Helpers.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/Helpers.php)).

Exact `Type` → flag mapping ([`Helpers.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/Helpers.php)):

- `Path` → `-v <hostConfig>:<Target>:<Mode>`. If the host path does not exist when the container is created, Unraid does `@mkdir($hostConfig, 0777, true); @chown($hostConfig, 99); @chgrp($hostConfig, 100);`
- `Port` → `-p <hostConfig>:<Target>/<Mode>` **only for bridge networks**. For `host`, `macvlan`, `ipvlan` it instead exports an environment variable `<MODE>_PORT_<Target>=<hostConfig>` (e.g. `TCP_PORT_3000=3000`) and emits no `-p`. For `none`, nothing.
- `Label` → `-l <Target>=<hostConfig>`
- `Variable` → `-e <Target>=<hostConfig>`
- `Device` → `--device=<hostConfig>` (Target may be empty)

### 1.4 Minimal complete valid template — web-streamed desktop app

Assumes the image exposes an HTTP/VNC-over-websocket UI on container port 3000, keeps state in `/config`, and is a browser/desktop stack that needs a larger `/dev/shm`.

```xml
<?xml version="1.0"?>
<Container version="2">

  <!-- ==== required ==== -->
  <Name>StreamDesk</Name>
  <Repository>ghcr.io/example/streamdesk:latest</Repository>

  <!-- ==== strongly recommended metadata ==== -->
  <Registry>https://ghcr.io/example/streamdesk</Registry>
  <Network>bridge</Network>
  <Shell>bash</Shell>
  <Privileged>false</Privileged>
  <Support>https://forums.unraid.net/topic/000000-support-streamdesk/</Support>
  <Project>https://github.com/example/streamdesk</Project>
  <Overview>Web-streamed Linux desktop. Open the WebUI in a browser; no client install required.</Overview>
  <Category>Tools:Utilities</Category>
  <Icon>https://raw.githubusercontent.com/example/streamdesk/main/icon.png</Icon>
  <WebUI>http://[IP]:[PORT:3000]</WebUI>
  <TemplateURL>https://raw.githubusercontent.com/example/streamdesk/main/templates/streamdesk.xml</TemplateURL>
  <ReadMe>https://raw.githubusercontent.com/example/streamdesk/main/README.md</ReadMe>
  <Date>2026-01-01</Date>
  <Beta>false</Beta>
  <MinVer>6.10</MinVer>
  <License>MIT</License>
  <Changes>Initial release.</Changes>

  <!-- shm-size has no Config Type, so it must live in ExtraParams -->
  <ExtraParams>--shm-size=1g</ExtraParams>

  <!-- ==== ports / paths / variables (v2 templates use Config entries) ==== -->
  <Config Name="WebUI Port" Target="3000" Default="3000" Mode="tcp"
          Description="HTTP port for the streamed desktop (container port 3000)."
          Type="Port" Display="always" Required="true" Mask="false"/>

  <Config Name="AppData" Target="/config" Default="/mnt/user/appdata/streamdesk" Mode="rw"
          Description="Persistent state: profiles, bookmarks, app settings."
          Type="Path" Display="always" Required="true" Mask="false"/>

  <!-- PUID/PGID default to 1000/1000; overridable in the Unraid UI -->
  <Config Name="PUID" Target="PUID" Default="1000" Mode=""
          Description="User ID the container runs as. Unraid's own default is 99 (nobody)."
          Type="Variable" Display="advanced" Required="false" Mask="false"/>

  <Config Name="PGID" Target="PGID" Default="1000" Mode=""
          Description="Group ID the container runs as. Unraid's own default is 100 (users)."
          Type="Variable" Display="advanced" Required="false" Mask="false"/>

  <Config Name="UMASK" Target="UMASK" Default="022" Mode=""
          Description="Umask applied to files created by the app. Subtracts from permissions; 022 -> 644/755."
          Type="Variable" Display="advanced" Required="false" Mask="false"/>

</Container>
```

Notes on this template:

- `<WebUI>` uses `[PORT:3000]`, which must match a `Type="Port"` `Target`, the **container** port ([starter comment](https://raw.githubusercontent.com/unraid/unraid-community-apps-starter/main/templates/example-app.xml): *"The port in the entry ALWAYS refers to the container port, not the host port"*).
- `Default` on a `Port` Config is the **host** port; `Target` is the container port.
- `--shm-size=1g` cannot be expressed as a `Config`, because no `Config Type` maps to it. `ExtraParams` is appended verbatim before the image reference ([`Helpers.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/Helpers.php)), and the CA parser warns it may *"rewrite or reject unsafe values"* ([field ref](https://ca.unraid.net/submit/help/xml-field-reference)).
- The official starter itself defaults PUID/PGID to `99`/`100` ([starter](https://raw.githubusercontent.com/unraid/unraid-community-apps-starter/main/templates/example-app.xml)); this template intentionally changes those defaults to `1000`/`1000` per the requirement — see §2.3.

---

## 2. PUID / PGID conventions

### 2.1 The linuxserver.io pattern (verified from source)

The current LSIO base image does exactly this at container start ([`docker-baseimage-ubuntu` `init-adduser/run`](https://github.com/linuxserver/docker-baseimage-ubuntu/blob/master/root/etc/s6-overlay/s6-rc.d/init-adduser/run), identical in [`docker-baseimage-alpine`](https://github.com/linuxserver/docker-baseimage-alpine/blob/master/root/etc/s6-overlay/s6-rc.d/init-adduser/run)):

```sh
PUID=${PUID:-911}
PGID=${PGID:-911}

USERHOME=$(grep abc /etc/passwd | cut -d ":" -f6)
usermod -d "/root" abc            # move home out of the way first

groupmod -o -g "${PGID}" abc
usermod   -o -u "${PUID}" abc     # -o = allow non-unique id

usermod -d "${USERHOME}" abc      # restore home
...
lsiown abc:abc /app /config /defaults
```

Key facts:

- The **image-level default is 911**, not 1000. The 99/100 numbers users see come from the **Unraid template**, not from the image.
- `-o` on both `usermod` and `groupmod` is load-bearing: without it, remapping to a UID/GID that already exists in the image's `/etc/passwd` (e.g. `ubuntu` at 1000) fails.
- Ownership of the app's directories is then forced to the runtime user with the image's `lsiown` helper.
- LSIO explicitly warns: *"We are aware that recent versions of the Docker engine have introduced the `--user` flag. Our images are not yet compatible with this, so we recommend continuing usage of PUID and PGID."* ([Understanding PUID and PGID](https://docs.linuxserver.io/general/understanding-puid-and-pgid/))
- LSIO images support `-e UMASK=022` to override the umask *"for services started within the containers"* ([docker-chrome](https://docs.linuxserver.io/images/docker-chrome/)). Umask semantics: *"umask is not chmod it subtracts from permissions based on it's value it does not add."*

The jlesage desktop/browser base image uses the same concept under different variable names — `USER_ID` (default `99`) and `GROUP_ID` (default `100`), plus `UMASK` (default `0000`) — as shown in its CA template ([jlesage firefox.xml](https://raw.githubusercontent.com/jlesage/docker-templates/master/jlesage/firefox.xml)). So "PUID/PGID" is a convention, not a Docker feature: the image's entrypoint must read the variables and apply them itself.

### 2.2 Why it exists at all

From LSIO ([Understanding PUID and PGID](https://docs.linuxserver.io/general/understanding-puid-and-pgid/)): containers run as `root` by default because Docker needs root for network config, process management and filesystem access; therefore *"If the process is running under `root`, all files and directories created during the container's lifespan will be owned by `root`, thus becoming inaccessible by you."* PUID/PGID maps the container-internal user onto a host UID/GID.

### 2.3 Making 1000/1000 the DEFAULT while remaining overridable

Do it in two independent layers, so both paths agree:

1. **Image layer** — default the variables in the entrypoint: `PUID=${PUID:-1000}` / `PGID=${PGID:-1000}`. Then a bare `docker run image` already runs as 1000/1000.
2. **Template layer** — `Default="1000"` on both `Config` entries. Unraid renders 1000 in the UI and emits `-e PUID=1000 -e PGID=1000`. The user can still edit the field to 99/100, and Unraid persists the edit as a `Value` attribute ([`Helpers.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/Helpers.php) prefers `Value` over `Default`).

Always use `usermod -o -u` / `groupmod -o -g`; without `-o` the remap fails when the target ID collides with an existing image user, which is likely at 1000.

### 2.4 What breaks when the container runs as root

- Files created inside the mapped appdata volume are owned by `root:root` on the host → the Unraid user cannot read/modify/delete them, and SMB/NFS access breaks ([LSIO](https://docs.linuxserver.io/general/understanding-puid-and-pgid/)).
- Unraid pre-creates missing host paths as `99:100` ([`Helpers.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/Helpers.php)), so a root-running container immediately produces mixed ownership inside its own appdata folder.
- `root` inside the container has full write access to anything under the bind-mounted host path — a stolen config or a malicious mount escapes into the array share.
- Postgres/MySQL images are the classic counterexample: they refuse to run as a mismatched UID, which is why some containers must be pinned to a fixed UID instead of PUID/PGID.

---

## 3. Unraid-specific runtime quirks

### 3.1 Host vs Bridge vs Custom network

Unraid documents four network types ([Managing & customizing containers](https://docs.unraid.net/unraid-os/using-unraid-to/run-docker-containers/managing-and-customizing-containers/)):

- **Bridge (default)** — internal Docker network; *"Only ports you explicitly map will be accessible"*. This is the only mode where `-p` mappings are emitted ([`Helpers.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/Helpers.php)).
- **Host** — shares the server's network stack; no port mapping, port conflicts are the user's problem.
- **None** — no network.
- **Custom (macvlan/ipvlan)** — own LAN IP; may need extra network config.

Template consequence: for Host/Custom, `Type="Port"` `Config` entries turn into `TCP_PORT_<containerport>=<hostport>` environment variables instead of `-p` flags ([`Helpers.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/Helpers.php)). A web-streamed desktop app that hard-codes its listening port from `-p` will behave differently on Host/Custom; read the `*_PORT_*` env var or document that Bridge is recommended.

### 3.2 `--restart unless-stopped`

`--restart unless-stopped` is the normal flag for **`docker run` and Compose** deployments — LSIO's own chrome docs use it in both the Compose and CLI examples ([docker-chrome](https://docs.linuxserver.io/images/docker-chrome/)).

It is **not** what Unraid does for dockerman-managed containers. The command builder in [`Helpers.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/Helpers.php) never emits a `--restart` flag; Unraid starts containers itself from its own autostart list (`dockerManPaths['autostart-file']`, read in [`DockerClient.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/DockerClient.php)). So on Unraid the container's Docker restart policy stays at Docker's default `no`, and start-on-boot is Unraid's job.

Practical rule: do not put `--restart` in the CA template. If a maintainer wants it anyway, it goes in `<ExtraParams>`.

### 3.3 The `net.unraid.docker.*` labels

Unraid injects these at container-creation time from the template; the **image itself does not need to ship them** ([`Helpers.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/Helpers.php)):

```
-l net.unraid.docker.managed=dockerman
-l net.unraid.docker.webui=<WebUI>      # only if <WebUI> is non-empty
-l net.unraid.docker.icon=<Icon>        # only if <Icon> is non-empty
```

Additional labels exist for shell and Tailscale: `net.unraid.docker.shell`, `net.unraid.docker.tailscale.webui`, `net.unraid.docker.tailscale.hostname` ([`DockerClient.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/DockerClient.php)).

Unraid reads them back from `docker inspect` ([`DockerClient.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/DockerClient.php)):

```php
$c['Manager'] = $info['Config']['Labels']['net.unraid.docker.managed'] ?? false;
$c['Icon']    = $info['Config']['Labels']['net.unraid.docker.icon'] ?? false;
$c['Url']     = $info['Config']['Labels']['net.unraid.docker.webui'] ?? false;
$c['Shell']   = $info['Config']['Labels']['net.unraid.docker.shell'] ?? false;
```

Consequence ([`DockerContainers.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/DockerContainers.php)): only when `Manager == "dockerman"` does Unraid render the **up-to-date / force update** controls; anything without the label is shown as **"3rd Party"**. A container started by hand with `docker run` is therefore invisible to Unraid's update workflow.

### 3.4 How Unraid detects a NEWER image

It is a **registry digest comparison of the same repo tag**. It does **not** use the template `<Date>`.

From [`DockerClient.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/DockerClient.php):

- `getRemoteVersionV2($image)`: HEADs the registry manifest (`manifestURL`, `'HEAD'`), sets the `Accept` header, then:
  ```php
  preg_match('@Docker-Content-Digest:\s*(.*)@i', $reply, $matches);
  $digest = trim($matches[1]);
  ```
- `inspectLocalVersion($image)`: reads `docker inspect` → `RepoDigests`, takes the last entry and strips everything before `sha256:`. So the comparison is *manifest digest string vs `sha256:...` from RepoDigests*, not a version string.
- `reloadUpdateStatus()`: `status = ($remoteVersion == $localVersion) ? 'true' : 'false'`, persisted to `/var/lib/docker/unraid-update-status.json`. If either side is empty the status is `undef` and the UI shows **"not available"**.
- `dockerupdate check` walks all containers and, for any whose `updated == "false"`, fires a notification of the form `Docker - <name> [abcd..wxyz]` built from the remote digest ([`scripts/dockerupdate`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/scripts/dockerupdate)).

`<Date>` is explicitly legacy: *"Legacy date input accepted from XML and normalized against feed first-seen metadata."* ([field ref](https://ca.unraid.net/submit/help/xml-field-reference)) — it plays no part in image update detection. **UNVERIFIED**: the exact cron schedule/frequency at which `dockerupdate check` runs; I confirmed the script and the UI but not the timer entry.

### 3.5 UI update states and "force update"

From [`DockerContainers.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/DockerContainers.php):

| `updateStatus` | UI |
| --- | --- |
| 0 | green **"up-to-date"** + (dockerman only) a **"force update"** link |
| 1 | orange **"update ready"** + **"apply update"** link |
| 2 | **"rebuild ready"** (network mode changed, e.g. `host:<something>`) |
| 3 / other | orange **"not available"** + **"force update"** link |

"Force update" is exposed even when Unraid believes the image is up to date — it simply re-pulls and recreates. Both entry points call the same `updateContainer()`.

### 3.6 Exactly how a user receives an upstream app update

1. Upstream publishes new layers and pushes the **same tag** (`:latest`). The registry's `Docker-Content-Digest` for that tag changes.
2. Unraid's update check HEADs the manifest, gets the new digest, compares with the local `RepoDigests` digest, and writes `false` ([`DockerClient.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/DockerClient.php)).
3. Docker tab shows **"update ready"** and Unraid sends a notification `Docker - <name> [<first4>..<last4>]` ([`scripts/dockerupdate`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/scripts/dockerupdate)); the Docker page also has **Check for Updates** and **Update All** buttons ([`DockerContainers.page`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/DockerContainers.page)).
4. User clicks **apply update** → `update_container` stops the container, pulls the image, removes/recreates the container **from the stored template XML with the same Config values** (so PUID/PGID, paths and ports are preserved), then starts it ([`scripts/update_container`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/scripts/update_container)).
5. Because `/config` is a bind mount to `/mnt/user/appdata/<app>`, state survives the recreate.

Maintainer implication: **ship a moving tag** (`:latest`) for Unraid users, or if you use versioned tags give Unraid a `<Branch>` so it knows which tag to track. If you never move the tag Unraid tracks, users get no update prompt. Digest pinning (`repo@sha256:...`) makes the container permanently "up-to-date".

---

## 4. Array / permissions reality check

### 4.1 UID 1000 inside vs Unraid's 99:100 outside

- Unraid's own convention is **PUID 99 = `nobody`, PGID 100 = `users`**; the official starter template defaults to exactly those values ([starter](https://raw.githubusercontent.com/unraid/unraid-community-apps-starter/main/templates/example-app.xml)), and Unraid's create path literally does `@chown($hostConfig, 99); @chgrp($hostConfig, 100);` for every host path it has to create ([`Helpers.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/Helpers.php)). The numeric identity of 99/100 is also stated on the Unraid forum ([PUID PGID and UMASK](https://forums.unraid.net/topic/118751-puid-pgid-and-umask/), [Docker user (puid) and group (pgid) settings](https://forums.unraid.net/topic/117661-docker-user-puid-and-group-pgid-settings/)); `docs.unraid.net` itself does not enumerate the numeric mapping — treat the 99=nobody / 100=users naming as community+source verified, docs-UNVERIFIED.
- Ubuntu/Debian images commonly already have UID 1000 (`ubuntu`) and GID 1000 (`ubuntu`). Running as 1000 is **not** a problem inside the container, but on the host the files appear as numeric `1000:1000` with no matching name.
- Direct consequence: **a brand-new appdata folder is created 99:100, then the container chowns it to 1000:1000** on first boot. Every subsequent Unraid maintenance action that resets ownership ("Docker Safe New Perms" / New Permissions) will flip it back to `nobody:users` and can break an app that now expects 1000:1000. Unraid docs warn: *"It's best not to change the permissions on most of these default shares because doing so might cause issues with how Docker containers … work."* ([Shares](https://docs.unraid.net/unraid-os/using-unraid-to/manage-storage/shares/))
- With the Unraid default `drwxrwxrwx nobody:users` appdata permissions, UID 1000 can still write (world-writable bit), so PUID/PGID=1000 usually *works* on a stock Unraid box — it just produces ownership that Unraid's tools consider non-canonical. If an admin has tightened appdata to `0755 nobody:users`, UID 1000 gets `EACCES` and the app fails to start.

### 4.2 Appdata path convention

`/mnt/user/appdata/<app>` — Unraid docs: *"`appdata`: This is where all the working files for your Docker containers are stored. Each Docker container usually has its own folder here."* ([Shares](https://docs.unraid.net/unraid-os/using-unraid-to/manage-storage/shares/)). The starter template's path Config uses exactly this shape: `Default="/mnt/user/appdata/example-app"` ([starter](https://raw.githubusercontent.com/unraid/unraid-community-apps-starter/main/templates/example-app.xml)).

Note that Unraid also has a global `DOCKER_APP_CONFIG_PATH` override that rewrites the `Default`/`Value` of any `Type="Path"` Config whose `Target` is `/config` ([`CreateDocker.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/CreateDocker.php)). So `/config` is the magic target for the appdata volume.

### 4.3 shm-size pitfalls for a browser+desktop container

- `/dev/shm` inside a container defaults to **64m**: *"`--shm-size=""` Size of `/dev/shm`. … If you omit the size entirely, the system uses `64m`."* ([docker-run(1)](https://github.com/docker/cli/blob/master/man/docker-run.1.md)); dockerd's `--default-shm-size` is *"default 64MiB"* ([dockerd reference](https://docs.docker.com/reference/cli/dockerd/)).
- Browser/renderer processes use shared memory heavily; 64 MB causes tab/app crashes. LSIO's chrome image therefore ships `--shm-size=1gb` (and `shm_size: "1gb"` in Compose) as part of its **minimal** documented command ([docker-chrome](https://docs.linuxserver.io/images/docker-chrome/)).
- In a CA template this must be `ExtraParams`; there is no Config Type for it. The CA parser *"may rewrite or reject unsafe values"* in `ExtraParams` ([field ref](https://ca.unraid.net/submit/help/xml-field-reference)) — verify with the CA **Validate** / **Scan** flow after any change ([repository-xml](https://ca.unraid.net/submit/help/repository-xml)).
- **UNVERIFIED**: whether a 1 GB `/dev/shm` tmpfs is accounted against the container's `--memory` limit in a way that causes OOM-kills on small Unraid boxes. Behavior is kernel/tmpfs dependent; test on the target host.

### 4.4 seccomp / AppArmor pitfalls

- Docker applies a **default seccomp profile** to every container unless overridden: *"When you run a container, it uses the default profile unless you override it with the `--security-opt` option"*; `--security-opt seccomp=unconfined` *"Turn[s] off the default seccomp profile"* ([Docker seccomp docs](https://docs.docker.com/engine/security/seccomp/), [docker run reference](https://docs.docker.com/reference/cli/docker/container/run/)).
- Chrome/Electron/Chromium-based desktops can hit the profile (user namespaces, `clone` flags, `io_uring`, `personality`, `ptrace` for the crash reporter). Common fixes are `--security-opt seccomp=unconfined`, `--cap-add=SYS_ADMIN` (setuid sandbox), or `--no-sandbox` — in a CA template those go in `<ExtraParams>`.
- The LSIO chrome docs do **not** list any seccomp or AppArmor option in their minimal or GPU commands; they list `--shm-size=1gb`, `--device /dev/dri`, `--runtime nvidia --gpus all --device /dev/nvidia-modeset`, and `--privileged` only for Docker-in-Docker ([docker-chrome](https://docs.linuxserver.io/images/docker-chrome/)). So a well-built Selkies/KasmVNC-style image normally needs **no** seccomp override.
- **UNVERIFIED**: whether Unraid's kernel enables AppArmor by default, and whether LSIO chrome needs an AppArmor override on Unraid. I found no primary source either way; test with `aa-status` on the target host.
- Security note straight from LSIO: *"This container provides privileged access to the host system. Do not expose it to the Internet unless you have secured it properly."* ([docker-chrome](https://docs.linuxserver.io/images/docker-chrome/))

---

## 5. VERIFY

### 5.1 Run the container the way Unraid will (bridge, PUID/PGID=1000, shm, appdata, restart)

```bash
docker run -d --name sd-test \
  -e PUID=1000 -e PGID=1000 -e UMASK=022 \
  -p 3000:3000 \
  -v /mnt/user/appdata/sd-test:/config \
  --shm-size=1g \
  --restart unless-stopped \
  ghcr.io/example/streamdesk:latest
```

Then confirm Unraid created the host path the way it does in production (99:100 when Unraid, not docker, creates it):

```bash
stat -c '%u:%g %a %n' /mnt/user/appdata/sd-test
```

### 5.2 Prove PUID/PGID actually took effect

```bash
docker exec sd-test id
docker exec sd-test sh -c 'id -u; id -g; umask'
docker exec sd-test ls -ln /config
docker exec sd-test sh -c 'touch /config/.permcheck && ls -ln /config/.permcheck'
docker top sd-test -o uid,user,pid,comm
ls -ln /mnt/user/appdata/sd-test
```

Expected:

| Check | Expected output |
| --- | --- |
| `id` | `uid=1000 gid=1000 groups=1000` (LSIO images additionally print `User UID: 1000` / `User GID: 1000` in the container log at boot) |
| `id -u` / `id -g` | `1000` / `1000` |
| `umask` | `0022` (or `022`) when `UMASK=022` |
| `ls -ln /config` | owner/group columns are numeric `1000 1000`, **not** `0 0` and **not** `99 100` |
| `/config/.permcheck` | `-rw-r--r-- 1 1000 1000 … /config/.permcheck` |
| `docker top … -o uid,user` | main PID uid `1000`, not `0`/`root` |
| `ls -ln /mnt/user/appdata/sd-test` | host sees `1000 1000` — proves the mapping is visible outside the container |

Failure signatures:

- `uid=0(root)` → entrypoint ignored PUID/PGID, or the app re-execs as root.
- `uid=1000` but `/config` shows `0 0` → ownership was never applied to the volume (missing `chown`).
- `usermod: UID '1000' already exists` in the log → the entrypoint used `usermod -u` without `-o`.

### 5.3 Prove overridability

```bash
docker rm -f sd-test
docker run -d --name sd-test -e PUID=99 -e PGID=100 ... ghcr.io/example/streamdesk:latest
docker exec sd-test id     # expect uid=99(nobody) gid=100(users)
```

This proves the hard-coded default did not win over the environment variable.

### 5.4 Prove appdata persists across container recreation (the real Unraid update path)

```bash
docker exec sd-test sh -c 'echo persist-marker > /config/marker.txt'
docker inspect -f '{{.Id}}' sd-test
docker rm -f sd-test                       # simulates "apply update": remove + recreate
docker run -d --name sd-test \
  -e PUID=1000 -e PGID=1000 -e UMASK=022 \
  -p 3000:3000 -v /mnt/user/appdata/sd-test:/config \
  --shm-size=1g --restart unless-stopped \
  ghcr.io/example/streamdesk:latest
docker exec sd-test cat /config/marker.txt
docker inspect -f '{{.Id}}' sd-test
```

Expected: `persist-marker` is still readable and the container ID changed. That is exactly what Unraid's **apply update** does — new container, same bind-mounted `/config` ([`scripts/update_container`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/scripts/update_container)).

### 5.5 Prove shm-size landed

```bash
docker exec sd-test df -h /dev/shm      # expect ~1.0G, not 64M
docker inspect -f '{{.HostConfig.ShmSize}}' sd-test   # expect 1073741824
```

### 5.6 Prove the Unraid label / update-detection wiring

```bash
docker inspect -f '{{index .Config.Labels "net.unraid.docker.managed"}}' sd-test
docker inspect -f '{{index .Config.Labels "net.unraid.docker.webui"}}'   sd-test
docker inspect -f '{{index .Config.Labels "net.unraid.docker.icon"}}'    sd-test
docker inspect -f '{{.HostConfig.RestartPolicy.Name}}'                   sd-test
docker inspect -f '{{.RepoDigests}}'                                     sd-test
```

- When created through the Unraid UI from the template, `managed` is `dockerman`; created by hand, it is empty and Unraid will label the container **"3rd Party"** ([`DockerContainers.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/DockerContainers.php)).
- `RestartPolicy.Name` on an Unraid-managed container is Docker's default `no` (Unraid emits no `--restart`); it becomes `unless-stopped` only if you put it in `ExtraParams`.
- To reproduce Unraid's digest check by hand and confirm an update *will* be detected:

```bash
# local digest (what Unraid's inspectLocalVersion reads)
docker inspect -f '{{index .RepoDigests 0}}' ghcr.io/example/streamdesk:latest

# remote digest (what Unraid's getRemoteVersionV2 reads from the HEAD response)
# public/GHCR example; add auth for private registries
curl -sI -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
  https://ghcr.io/v2/example/streamdesk/manifests/latest | grep -i docker-content-digest
```

If the two `sha256:` strings match, Unraid shows **up-to-date**; if they differ, **update ready**. The curl form above is illustrative — I verified the header name and the comparison logic in [`DockerClient.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/DockerClient.php) but did not execute it against GHCR. **UNVERIFIED**: exact GHCR `Accept`/token flow.

---

## ENTRYPOINT PUID/PGID SNIPPET

### A. Verbatim from the linuxserver.io base image (source of truth)

[`linuxserver/docker-baseimage-ubuntu` → `root/etc/s6-overlay/s6-rc.d/init-adduser/run`](https://github.com/linuxserver/docker-baseimage-ubuntu/blob/master/root/etc/s6-overlay/s6-rc.d/init-adduser/run)

```sh
#!/usr/bin/with-contenv bash
# shellcheck shell=bash

PUID=${PUID:-911}
PGID=${PGID:-911}

if [[ -z ${LSIO_READ_ONLY_FS} ]] && [[ -z ${LSIO_NON_ROOT_USER} ]]; then
    USERHOME=$(grep abc /etc/passwd | cut -d ":" -f6)
    usermod -d "/root" abc

    groupmod -o -g "${PGID}" abc
    usermod -o -u "${PUID}" abc

    usermod -d "${USERHOME}" abc
fi
...
if [[ -z ${LSIO_READ_ONLY_FS} ]] && [[ -z ${LSIO_NON_ROOT_USER} ]]; then
    lsiown abc:abc /app
    lsiown abc:abc /config
    lsiown abc:abc /defaults
fi
```

### B. Minimal generic entrypoint with 1000/1000 as the default (adapt names)

```sh
#!/bin/sh
set -eu

# --- defaults: 1000/1000 requested, still fully overridable ---
PUID=${PUID:-1000}
PGID=${PGID:-1000}
UMASK=${UMASK:-022}

APP_USER=app          # pre-created in the Dockerfile: adduser -u 1000 ...
APP_HOME=$(getent passwd "$APP_USER" | cut -d: -f6)

# remap the runtime user; -o is REQUIRED when the target id already exists
usermod  -o -u "$PUID" -d /tmp "$APP_USER"
usermod  -d "$APP_HOME" "$APP_USER"
groupmod -o -g "$PGID" "$APP_USER"

# keep ownership of the persisted volume aligned with the runtime id
chown -R "$PUID:$PGID" /config

umask "$UMASK"

# drop privileges for the actual app; do NOT run it as root
exec gosu "$APP_USER" /app/start.sh
```

Dockerfile counterpart:

```dockerfile
RUN groupadd -g 1000 app \
 && useradd  -u 1000 -g 1000 -m -d /home/app app \
 && mkdir -p /config && chown -R app:app /config
VOLUME /config
ENV PUID=1000 PGID=1000 UMASK=022

ENTRYPOINT ["/entrypoint.sh"]
```

Why each line exists: `-o` prevents `UID already exists`; the two-step `usermod -d` dance avoids `usermod` refusing to move a home directory that is in use (LSIO does the same); `chown -R` is what makes host-visible ownership match; `gosu`/`su-exec`/`s6-setuidgid` drops root for PID 1's child — without it you have a root process and a cosmetic UID change.

---

## UNVERIFIED items (consolidated)

1. Exact expected form of `<Registry>` (registry host URL vs full image path vs Hub page) — three variants exist in official/real templates.
2. `docs.unraid.net` never states numerically that PUID 99 = `nobody` and PGID 100 = `users`; the numeric mapping is verified from [`Helpers.php`](https://github.com/unraid/webgui/blob/master/emhttp/plugins/dynamix.docker.manager/include/Helpers.php) (`chown 99` / `chgrp 100`) and Unraid forum posts, not from current official docs.
3. The cron/timer frequency at which `dockerupdate check` runs (script and UI confirmed; schedule not).
4. Whether `/dev/shm` tmpfs counts against `--memory` on Unraid in a way that triggers OOM for a 1 GB shm on low-RAM hosts.
5. Whether Unraid's kernel enables AppArmor by default, and whether a Selkies/KasmVNC-style browser image needs `--apparmor=unconfined` there.
6. The exact GHCR `Accept` header / token dance for the manual remote-digest check (the header name and comparison logic are verified in `DockerClient.php`).
7. `<PostArgs>` and `<GitHub>` appear in real templates / the builder but are absent from the public CA field reference; their supported status is inferred, not documented.
