# authentik-mod

Manage an **authentik 2026.8** instance from Claude Code. An MCP server (about 190 tools) for users, groups, applications, providers, outposts, flows, events, certificates, policies, sources, roles and permissions, blueprints, system settings and branding; a skill; and `/authentik <task>`.

Written for this repo in English against authentik's own 2026.8.5 API (`/api/v3/schema/`). It was inspired by [Misterbck10/authentik-mcp](https://github.com/Misterbck10/authentik-mcp), which has no license, so no code was taken from it.

## Install

```
/plugin marketplace add prv-ctech/claude-code-linux
/plugin install authentik-mod@claude-code-linux
```

Claude Code asks for the settings below. The token is stored in the system keychain, never in a file. Change them later with `/plugin configure authentik-mod@claude-code-linux`. The first start installs the server's two npm packages (about 2 seconds).

| Setting | Meaning |
|---|---|
| authentik URL | `https://auth.example.com` (https required, http only for localhost) |
| API token | Token with intent **API** (not app password) of a service account |
| Read-only | Only register tools that read |
| Enabled domains | `users,groups,applications,providers,outposts,flows,events,crypto,policies,sources,rbac,blueprints,system,branding` |
| Allow editing flows and stages | Off by default: a broken authentication flow locks everyone out |
| Max items per list | Cap for one list call (default 200) |
| Default authorization / invalidation flow | Slugs used when a new OAuth2, SAML or proxy provider names none |
| Allowed hosts in custom CSS | Hosts brand CSS may load fonts or images from |

## Give Claude a limited account, not an admin

1. In authentik: **Directory > Users > Create Service Account** (no expiry).
2. **Directory > Roles > Create** a role, for example `mcp-server`, and put the service account in it.
3. Print the permissions the role needs and assign them. With an admin API token:

   ```bash
   AUTHENTIK_URL=https://auth.example.com AUTHENTIK_TOKEN=... node scripts/role.mjs --domains users,groups,applications --json
   ```

   Add `--read-only` for view permissions only. Give the list to `authentik_rbac_permissions_assign` (or the role's *Assign permission* dialog).
4. **Directory > Tokens and App passwords > Create**: user = the service account, intent = **API**, expiring off. Paste it as the token setting.

## Safety

- Deletes, permission grants, password sets, recovery links, token and private-key reveals, blueprint apply/import and settings changes return a dry run until called again with `confirm: true`. Read-only mode removes every tool that changes anything.
- Secrets (`client_secret`, passwords, keys, tokens) are redacted from results. A new provider's `client_secret` is shown once.
- Making a group superuser is blocked. Flow, stage and binding writes are a separate opt-in.
- Brand CSS is checked (size, forbidden constructs, remote hosts) and brand changes are snapshotted first; SVG uploads with scripts are refused.
- Every call is logged as one JSON line to stderr and `${CLAUDE_PLUGIN_DATA}/audit.log`, with secrets redacted.

## Develop

```bash
cd mods/authentik-mod/server && npm ci
node --test ../test/offline.test.mjs                     # offline
AUTHENTIK_URL=... AUTHENTIK_TOKEN=... node ../test/live.mjs   # against a TEST instance; creates and deletes mcp-test-* objects
```

`live.mjs` exercises every domain against a real authentik. Run it on a throwaway instance with a token whose role has all domains' permissions.
