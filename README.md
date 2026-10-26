# claude-code-linux

Claude Desktop and Claude Code on your Unraid server, opened in your web browser. Nothing to install on your computer.

## Before you start

The image is private for now. Once, in the Unraid terminal:

```bash
docker login ghcr.io -u YOUR-GITHUB-USERNAME
```

When it asks for a password, paste a GitHub token with the `read:packages` permission.

## Install on Unraid

1. **Apps** → search **claude-code-linux** → **Install**.
   (Or add this template by hand: `https://raw.githubusercontent.com/prv-ctech/claude-code-linux/main/unraid/claude-code-linux.xml`)
2. **Workspace**: pick the folder where your projects live, for example `/mnt/user/projects`.
3. Leave everything else as it is and click **Apply**.

Not on Unraid? Copy `.env.example` to `.env`, then run `docker compose up -d`.

## Open it

- **From outside your home**: point your reverse proxy (for example Pangolin) at port **3000**.
- **At home**: open `https://YOUR-SERVER-IP:3001` and accept the certificate warning once.

There is no password on the desktop itself. Your reverse proxy is the lock, so **never open ports 3000 or 3001 to the Internet directly**.

## First time

1. Claude opens by itself. Click **Sign in**; a Chrome window opens. Sign in to your Claude account.
2. Done. You stay signed in, even after updates and restarts.

Closed Claude by accident? **Right-click the desktop** → **Claude**. The same menu has **Google Chrome** and **Terminal**.

To use Claude Code in a terminal: open **Terminal** from that menu and type `claude`.

## Where your things are kept

| Folder on Unraid | What is in it |
|---|---|
| `/mnt/user/appdata/claude-code-linux` | Your sign-ins and all settings for Claude, Claude Code and Chrome. Back this up. |
| Your **Workspace** folder | Your projects. Inside the desktop they are at `/workspaces`. |

Anything you install *outside* these folders is gone after an update.

## Updates

New versions of Claude arrive automatically. When Unraid shows **update ready**, click it. You stay signed in.

## Upgrading from the old version

The old version kept its files differently. Set **AppData** to a new, empty folder (for example `/mnt/user/appdata/claude-code-linux-new`) and sign in again once.

## Something is wrong?

| Problem | Fix |
|---|---|
| `denied` when installing | Do the `docker login` step above. |
| Page says it needs a secure connection | Use `https://…:3001`, or go through your reverse proxy. |
| Claude forgets your sign-in | Make sure AppData is a new folder (see above). |
| Pages or tabs keep crashing | Keep `--shm-size=2g` in **Extra Parameters**. |

## Good to know

- Only for normal PCs and servers (`x86_64`). Not for ARM.
- Claude's **Cowork** feature and **Computer Use** don't work here. Claude Code does.
- Want to build or run Docker containers inside the desktop? Add `--privileged` to **Extra Parameters**. This gives the container full control of your server, so only do it if you understand that.

## Licensing

The image contains software this project doesn't own: Anthropic's Claude Desktop, Google Chrome and LinuxServer.io's Selkies base. They are downloaded from their makers when the image is built, and their own terms apply. The image stays private until that is reviewed.

Maintainers: see [docs/MAINTAINING.md](docs/MAINTAINING.md).
