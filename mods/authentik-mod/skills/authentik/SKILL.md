---
name: authentik
description: Manage an authentik 2026.8 identity provider (users, groups, SSO applications and providers, outposts, flows, events, certificates, policies, sources, roles and permissions, blueprints, system settings, branding) through the authentik MCP tools. Use when the task is about authentik, SSO, OIDC/SAML/LDAP/proxy providers, or the authentik admin interface.
---

# authentik

Tools: `mcp__plugin_authentik-mod_authentik__authentik_<domain>_<action>`. Schemas are deferred, so load the ones you need with one ToolSearch call. Run `authentik_status` first.

## How the tools are shaped

- Per resource: `_list`, `_get`, `_create`, `_update`, `_delete`, `_used_by`. Types with many kinds (providers, stages, policies, sources, mappings) take `type`, for example `type: "oauth2"`. Without `type`, list/get/delete search all kinds.
- `data` is the request body with the field names of the authentik API. When unsure of a field, create with the few required ones and read the 400 error: it names the missing or invalid fields.
- `_update` is a PATCH: only the fields in `data` change.
- List results are summaries. Pass `full: true` or use `_get` for every field. `filters` passes extra query filters; `search` and `ordering` work everywhere.
- Flow fields (`authorization_flow`, `invalidation_flow`, `flow_authentication`...) accept a flow **slug**; the tool resolves it.
- Secrets are redacted in results. `client_secret` is shown once when a provider is created; later use `authentik_providers_client_secret_get`.

## Safety you must keep

- Deletes, permission grants, recovery links, password sets, token and private-key reveals, blueprint apply/import and settings changes are dry runs until `confirm: true`. Show the dry-run `would`/`preview` to the user, get a yes, then repeat with `confirm: true`. Never add `confirm: true` on the first call.
- Before deleting, read `_used_by` and tell the user what depends on the object.
- Expression policies, property mappings and blueprints are code that runs inside authentik. Show the code to the user before creating or changing it.
- Making a group superuser is blocked; tell the user to do it in the admin UI. Editing flows, stages and stage bindings is off unless the user turned on "Allow editing flows and stages", because a broken login flow locks everyone out.
- Do not paste secrets, recovery links or private keys into files, commits or messages.

## Recipes

- **New SSO app (OIDC):** `authentik_applications_create_with_provider` with `provider_model: "authentik_providers_oauth2.oauth2provider"`, `provider: {name, redirect_uris: [{matching_mode: "strict", url}]}`, `app: {name, slug}`. Flows default sensibly. Then give the user `authentik_providers_oauth2_setup_urls` and, with confirm, the client secret.
- **Restrict an app to a group:** `authentik_policies_binding_create` with `data: {target: <application pk>, group: <group uuid>, order: 0}`.
- **Onboard a user:** `authentik_users_user_create`, `authentik_groups_add_user`, then `authentik_users_recovery_link` (or `_recovery_email`) rather than setting a password.
- **Offboard:** `authentik_users_user_update` with `is_active: false`, `authentik_sessions_list` filtered to the user then `authentik_sessions_revoke`, and delete tokens. Delete the user only if asked.
- **Why can't X sign in:** `authentik_events_list` with `filters: {username: ...}` and action `login_failed`, `authentik_applications_check_access`, `authentik_users_user_get`.
- **Branding:** `authentik_branding_file_upload` then set the brand field to the returned name; custom CSS goes through `authentik_branding_css_set` (checked, snapshotted). Restore with `authentik_branding_snapshot_restore`.
- **Least-privilege role:** `node scripts/role.mjs` in the plugin folder prints the permissions the token's role needs, per domain; assign them with `authentik_rbac_permissions_assign`.

## Limits

- Blueprint apply is queued for the worker: poll `authentik_blueprints_blueprint_get` for `status`.
- Not covered: enterprise-only features (licenses, lifecycle, endpoints/devices), the flow executor, OAuth2 token endpoints. For those, tell the user to use the admin UI.
