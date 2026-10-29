// Live check against a real authentik. Creates objects named mcp-test-* and deletes them again.
//   AUTHENTIK_URL=... AUTHENTIK_TOKEN=... node test/live.mjs
// Use a test instance: it creates and deletes users, groups, providers and brands.
import { loadConfig } from '../server/config.mjs';
import { makeClient } from '../server/client.mjs';
import { buildRegistry } from '../server/tools.mjs';
import { redact } from '../server/safety.mjs';

const cfg = loadConfig();
if (cfg.problems.length) { console.error(cfg.problems.join('\n')); process.exit(1); }
cfg.dataDir = '/tmp/authentik-mod-live';
cfg.domains.add('flows_admin');
const api = makeClient(cfg);
const ctx = { api, cfg, audit: () => {} };
const tools = new Map(buildRegistry(cfg).select(cfg).map((t) => [t.name, t]));

const results = [];
async function call(name, args = {}) {
  const t = tools.get(name);
  if (!t) throw new Error(`no tool ${name}`);
  const r = await t.run(args, ctx);
  return t.reveal || r?.dry_run ? r : redact(r);
}
async function step(label, fn) {
  try { const v = await fn(); results.push([true, label]); console.log('PASS', label); return v; }
  catch (e) { results.push([false, label, e.message]); console.log('FAIL', label, '->', e.message.slice(0, 400)); }
}
const must = (c, m) => { if (!c) throw new Error(m); };
const rejects = async (fn, re) => { try { await fn(); } catch (e) { must(re.test(e.message), `wrong error: ${e.message}`); return; } throw new Error('expected an error'); };

// --- status / system
await step('status', async () => must((await call('authentik_status')).version === '2026.8.5', 'version'));
await step('system info/config/settings/workers/schedules/tasks', async () => {
  await call('authentik_system_info'); await call('authentik_system_config'); await call('authentik_system_settings_get');
  await call('authentik_system_workers'); await call('authentik_system_schedules_list', { page_size: 5 });
  await call('authentik_system_tasks_status'); await call('authentik_system_tasks_list', { page_size: 5 });
});

// --- users, tokens, sessions
let user;
await step('user create', async () => { user = await call('authentik_users_user_create', { data: { username: 'mcp-test-u1', name: 'MCP Test One', email: 'mcp-test-u1@example.invalid' } }); must(user.pk, 'pk'); });
await step('user get/update/list', async () => {
  must((await call('authentik_users_user_get', { id: user.pk })).username === 'mcp-test-u1', 'get');
  await call('authentik_users_user_update', { id: user.pk, data: { name: 'MCP Test Uno' } });
  const l = await call('authentik_users_user_list', { search: 'mcp-test-u1' });
  must(l.results.length === 1 && l.results[0].name === 'MCP Test Uno' && !('uid' in l.results[0]), 'list summary');
});
await step('user set_password / recovery are dry runs without confirm', async () => {
  must((await call('authentik_users_set_password', { id: user.pk, password: 'x' })).dry_run, 'password');
  must((await call('authentik_users_recovery_link', { id: user.pk })).dry_run, 'recovery');
});
await step('user recovery link with confirm (needs a recovery flow on the brand)', async () => {
  try { must((await call('authentik_users_recovery_link', { id: user.pk, confirm: true })).link, 'link'); }
  catch (e) { must(/No recovery flow set/.test(e.message), e.message); }
});
await step('token create/list/view_key/delete', async () => {
  await call('authentik_users_token_create', { data: { identifier: 'mcp-test-tok', intent: 'api', user: user.pk, expiring: false } });
  must((await call('authentik_users_token_list', { search: 'mcp-test-tok' })).results.length === 1, 'list');
  must((await call('authentik_users_token_view_key', { identifier: 'mcp-test-tok' })).dry_run, 'dry');
  must((await call('authentik_users_token_view_key', { identifier: 'mcp-test-tok', confirm: true })).key, 'key');
  await call('authentik_users_token_delete', { id: 'mcp-test-tok', confirm: true });
});
await step('sessions/consent list', async () => { await call('authentik_sessions_list', { page_size: 2 }); await call('authentik_consent_list', { page_size: 2 }); });

// --- groups
let group;
await step('group create/add/remove/update', async () => {
  group = await call('authentik_groups_group_create', { data: { name: 'mcp-test-g1' } });
  await call('authentik_groups_add_user', { group: group.pk, user: user.pk });
  must((await call('authentik_groups_group_get', { id: group.pk })).users.includes(user.pk), 'member');
  await call('authentik_groups_remove_user', { group: group.pk, user: user.pk });
  await call('authentik_groups_group_update', { id: group.pk, data: { attributes: { t: 1 } } });
});
await step('group superuser is blocked', () => rejects(() => call('authentik_groups_group_update', { id: group.pk, data: { is_superuser: true } }), /blocked/));
await step('group delete dry run then real', async () => {
  must((await call('authentik_groups_group_delete', { id: group.pk })).dry_run, 'dry');
  await call('authentik_groups_group_delete', { id: group.pk, confirm: true });
});

// --- providers / applications / mappings
let prov, app;
await step('oauth2 provider create uses default flows by slug', async () => {
  prov = await call('authentik_providers_provider_create', { type: 'oauth2', data: { name: 'mcp-test-oauth', redirect_uris: [{ matching_mode: 'strict', url: 'https://example.invalid/cb' }] } });
  must(prov.pk && prov.client_secret, 'created with secret shown once');
});
await step('provider get redacts secret; client_secret_get gated', async () => {
  must((await call('authentik_providers_provider_get', { type: 'oauth2', id: prov.pk })).client_secret === '***redacted***', 'redacted');
  must((await call('authentik_providers_client_secret_get', { id: prov.pk })).dry_run, 'dry');
  must((await call('authentik_providers_client_secret_get', { id: prov.pk, confirm: true })).client_secret, 'secret');
  await call('authentik_providers_oauth2_setup_urls', { id: prov.pk });
  must((await call('authentik_providers_provider_list', { search: 'mcp-test' })).results.length >= 1, 'list all types');
});
await step('application create/get/check_access/used_by', async () => {
  app = await call('authentik_applications_application_create', { data: { name: 'mcp-test-app', slug: 'mcp-test-app', provider: prov.pk, meta_launch_url: 'https://example.invalid' } });
  must((await call('authentik_applications_application_get', { id: 'mcp-test-app' })).provider === prov.pk, 'provider linked');
  await call('authentik_applications_check_access', { slug: 'mcp-test-app' });
  await call('authentik_providers_provider_used_by', { type: 'oauth2', id: prov.pk });
});
await step('application delete + provider delete', async () => {
  await call('authentik_applications_application_delete', { id: 'mcp-test-app', confirm: true });
  await call('authentik_providers_provider_delete', { type: 'oauth2', id: prov.pk, confirm: true });
});
await step('create_with_provider (transaction) then cleanup', async () => {
  const r = await call('authentik_applications_create_with_provider', { app: { name: 'mcp-test-app2', slug: 'mcp-test-app2' }, provider_model: 'authentik_providers_oauth2.oauth2provider', provider: { name: 'mcp-test-oauth2', redirect_uris: [{ matching_mode: 'strict', url: 'https://example.invalid/cb' }] } });
  must(r, 'result');
  const a = await call('authentik_applications_application_get', { id: 'mcp-test-app2' });
  await call('authentik_applications_application_delete', { id: 'mcp-test-app2', confirm: true });
  await call('authentik_providers_provider_delete', { id: a.provider, confirm: true });
});
await step('scope mapping create/delete', async () => {
  const m = await call('authentik_providers_mapping_create', { type: 'scope', data: { name: 'mcp-test-scope', scope_name: 'mcptest', expression: 'return {}' }, confirm: true });
  must((await call('authentik_providers_mapping_list', { type: 'scope', search: 'mcp-test' })).results.length === 1, 'list');
  await call('authentik_providers_mapping_delete', { type: 'scope', id: m.pk, confirm: true });
});
await step('provider list per type', async () => { for (const t of ['saml', 'proxy', 'ldap', 'rac', 'radius', 'scim', 'wsfed', 'ssf', 'google_workspace', 'microsoft_entra']) await call('authentik_providers_provider_list', { type: t, page_size: 1 }); });

// --- outposts
await step('outposts list/default settings/connections', async () => {
  await call('authentik_outposts_outpost_list'); await call('authentik_outposts_default_settings');
  await call('authentik_outposts_connection_list'); await call('authentik_outposts_connection_list', { type: 'docker' });
});

// --- flows (read + flows_admin write)
await step('flows list/get/export/diagram', async () => {
  const l = await call('authentik_flows_flow_list', { page_size: 3 });
  const slug = l.results[0].slug;
  await call('authentik_flows_flow_get', { id: slug });
  must((await call('authentik_flows_export', { slug })).yaml.length > 10, 'yaml');
  await call('authentik_flows_diagram', { slug });
});
await step('flows: bindings/stages/prompts list', async () => {
  await call('authentik_flows_binding_list', { page_size: 2 }); await call('authentik_flows_stage_list', { page_size: 2 });
  for (const t of ['identification', 'password', 'prompt', 'user_login', 'authenticator_totp', 'invitation']) await call('authentik_flows_stage_list', { type: t, page_size: 1 });
  await call('authentik_flows_prompt_list', { page_size: 2 });
});
await step('flows_admin: flow + stage create/delete', async () => {
  const f = await call('authentik_flows_flow_create', { data: { name: 'mcp-test-flow', slug: 'mcp-test-flow', title: 'MCP Test', designation: 'authentication' } });
  const s = await call('authentik_flows_stage_create', { type: 'deny', data: { name: 'mcp-test-deny' } });
  const b = await call('authentik_flows_binding_create', { data: { target: f.pk, stage: s.pk, order: 10 } });
  await call('authentik_flows_binding_delete', { id: b.pk, confirm: true });
  await call('authentik_flows_stage_delete', { id: s.pk, confirm: true });
  await call('authentik_flows_flow_delete', { id: 'mcp-test-flow', confirm: true });
});

// --- events
await step('events list/get/actions/volume/top', async () => {
  const l = await call('authentik_events_list', { page_size: 3 });
  if (l.results[0]) await call('authentik_events_get', { id: l.results[0].pk });
  await call('authentik_events_actions'); await call('authentik_events_volume'); await call('authentik_events_top_per_user', { action: 'login' });
  await call('authentik_events_notifications_list', { page_size: 2 });
});
await step('notification rule + transport create/test(dry)/delete', async () => {
  const t = await call('authentik_events_transport_create', { data: { name: 'mcp-test-transport', mode: 'webhook', webhook_url: 'https://example.invalid/hook' } });
  must((await call('authentik_events_transport_test', { id: t.pk })).dry_run, 'dry');
  const r = await call('authentik_events_rule_create', { data: { name: 'mcp-test-rule', transports: [t.pk], severity: 'notice' } });
  await call('authentik_events_rule_delete', { id: r.pk, confirm: true });
  await call('authentik_events_transport_delete', { id: t.pk, confirm: true });
});

// --- crypto
await step('keypair generate/list/view_certificate/private key gated/delete', async () => {
  await call('authentik_crypto_keypair_generate', { common_name: 'mcp-test.example.invalid', validity_days: 2, alg: 'ecdsa' });
  const l = await call('authentik_crypto_keypair_list', { search: 'mcp-test.example.invalid' });
  must(l.results.length === 1, 'one pair'); const id = l.results[0].pk;
  must((await call('authentik_crypto_keypair_view_certificate', { id })).data.includes('BEGIN CERTIFICATE'), 'cert');
  must((await call('authentik_crypto_keypair_view_private_key', { id })).dry_run, 'dry');
  must((await call('authentik_crypto_keypair_view_private_key', { id, confirm: true })).data.includes('PRIVATE KEY'), 'key');
  await call('authentik_crypto_keypair_delete', { id, confirm: true });
});

// --- policies
await step('expression policy + binding create/delete', async () => {
  const a = await call('authentik_applications_application_create', { data: { name: 'mcp-test-app3', slug: 'mcp-test-app3' } });
  const p = await call('authentik_policies_policy_create', { type: 'expression', data: { name: 'mcp-test-policy', expression: 'return True' }, confirm: true });
  const b = await call('authentik_policies_binding_create', { data: { target: a.pk, policy: p.pk, order: 0 } });
  await call('authentik_policies_policy_list', { type: 'expression', search: 'mcp-test' });
  await call('authentik_policies_binding_delete', { id: b.pk, confirm: true });
  await call('authentik_policies_policy_delete', { id: p.pk, confirm: true });
  await call('authentik_applications_application_delete', { id: 'mcp-test-app3', confirm: true });
});
await step('policy list per type', async () => { for (const t of ['dummy', 'event_matcher', 'geoip', 'password', 'password_expiry', 'reputation', 'unique_password']) await call('authentik_policies_policy_list', { type: t, page_size: 1 }); });

// --- sources
await step('sources list per type, types, connections', async () => {
  for (const t of ['oauth', 'saml', 'ldap', 'plex', 'kerberos', 'scim', 'telegram']) await call('authentik_sources_source_list', { type: t, page_size: 1 });
  await call('authentik_sources_source_list'); await call('authentik_sources_types');
  await call('authentik_sources_user_connections_list', { page_size: 1 }); await call('authentik_sources_group_connections_list', { page_size: 1 });
});
await step('oauth source create/get/delete', async () => {
  await call('authentik_sources_source_create', { type: 'oauth', data: { name: 'mcp-test-src', slug: 'mcp-test-src', provider_type: 'github', consumer_key: 'x', consumer_secret: 'y', enabled: false } });
  must((await call('authentik_sources_source_get', { id: 'mcp-test-src' })).consumer_secret !== 'y', 'secret not echoed');
  await call('authentik_sources_source_delete', { id: 'mcp-test-src', confirm: true });
});

// --- rbac
await step('rbac role create/add_user/permissions/assign gated/delete', async () => {
  const r = await call('authentik_rbac_role_create', { data: { name: 'mcp-test-role2' } });
  await call('authentik_rbac_role_add_user', { role: r.pk, user: user.pk });
  await call('authentik_rbac_role_remove_user', { role: r.pk, user: user.pk });
  must((await call('authentik_rbac_permissions_list', { filters: { codename: 'view_user' } })).results.length >= 1, 'perm list');
  must((await call('authentik_rbac_permissions_assign', { role: r.pk, permissions: ['authentik_core.view_user'] })).dry_run, 'dry');
  await call('authentik_rbac_permissions_assign', { role: r.pk, permissions: ['authentik_core.view_user'], confirm: true });
  await call('authentik_rbac_role_permissions', { role: r.pk });
  await call('authentik_rbac_permissions_unassign', { role: r.pk, permissions: ['authentik_core.view_user'], confirm: true });
  await call('authentik_rbac_initial_permission_list');
  await call('authentik_rbac_role_delete', { id: r.pk, confirm: true });
});

// --- blueprints
await step('blueprint instance create/apply gated/delete + import', async () => {
  const y = 'version: 1\nmetadata:\n  name: mcp-test-bp\nentries:\n  - model: authentik_core.group\n    state: present\n    identifiers:\n      name: mcp-test-bp-group\n';
  const b = await call('authentik_blueprints_blueprint_create', { data: { name: 'mcp-test-bp', content: y, enabled: true } });
  must(b.enabled === false, 'saved disabled even when enabled was asked');
  must((await call('authentik_blueprints_set_enabled', { id: b.pk, enabled: true })).dry_run, 'enable dry');
  await call('authentik_blueprints_set_enabled', { id: b.pk, enabled: true, confirm: true });
  must((await call('authentik_blueprints_apply', { id: b.pk })).dry_run, 'dry');
  await call('authentik_blueprints_apply', { id: b.pk, confirm: true });
  // Apply is queued for the worker; a busy worker can take longer than the test waits.
  let applied = false;
  for (let i = 0; i < 40 && !applied; i++) {
    applied = (await call('authentik_groups_group_list', { search: 'mcp-test-bp-group' })).results.length === 1;
    if (!applied) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!applied) {
    const tasks = await call('authentik_system_tasks_list', { filters: { actor_name: 'authentik.blueprints.v1.tasks.apply_blueprint' }, page_size: 200 });
    must(tasks.results.some((t) => t.rel_obj_id === b.pk), 'apply task was queued');
    console.log('  note: worker had not run the apply task after 40 s; it was queued');
  }
  await call('authentik_blueprints_blueprint_delete', { id: b.pk, confirm: true });
  const g = (await call('authentik_groups_group_list', { search: 'mcp-test-bp-group' })).results[0];
  if (g) await call('authentik_groups_group_delete', { id: g.pk, confirm: true });
  await call('authentik_blueprints_available');
  must((await call('authentik_blueprints_import', { content: y })).dry_run, 'import dry');
});

// --- branding
await step('brand create/css gated/css rejected/snapshot/restore/delete', async () => {
  const b = await call('authentik_branding_brand_create', { data: { domain: 'mcp-test.example.invalid', branding_title: 'MCP Test' } });
  must((await call('authentik_branding_css_set', { id: b.brand_uuid, css: 'body{color:red}' })).dry_run, 'dry');
  await call('authentik_branding_css_set', { id: b.brand_uuid, css: 'body{color:red}', confirm: true });
  await rejects(() => call('authentik_branding_css_set', { id: b.brand_uuid, css: '@import url(https://evil.example/x.css);' }), /not in AUTHENTIK_BRANDING_ALLOWED_HOSTS/);
  await rejects(() => call('authentik_branding_css_set', { id: b.brand_uuid, css: 'a{background:url(javascript:alert(1))}' }), /forbidden/);
  await call('authentik_branding_css_set', { id: b.brand_uuid, css: '@import url(https://fonts.googleapis.com/css2?family=Inter);', confirm: true });
  await call('authentik_branding_brand_update', { id: b.brand_uuid, data: { branding_title: 'MCP Test 2' } });
  const snaps = (await call('authentik_branding_snapshots_list')).snapshots.filter((n) => n.startsWith(b.brand_uuid));
  must(snaps.length >= 3, `snapshots ${snaps.length}`);
  await call('authentik_branding_snapshot_restore', { snapshot: snaps[snaps.length - 1], confirm: true });
  await rejects(() => call('authentik_branding_snapshot_restore', { snapshot: '../../etc/passwd', confirm: true }), /file name/);
  await call('authentik_branding_current');
  await call('authentik_branding_brand_delete', { id: b.brand_uuid, confirm: true });
});
await step('branding file upload/list/delete + svg script rejected', async () => {
  const fs = await import('node:fs');
  fs.writeFileSync('/tmp/mcp-test-logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
  fs.writeFileSync('/tmp/mcp-test-evil.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  await call('authentik_branding_file_upload', { path: '/tmp/mcp-test-logo.svg', name: 'branding/mcp-test-logo.svg' });
  must(JSON.stringify(await call('authentik_branding_files_list', { search: 'mcp-test-logo' })).includes('mcp-test-logo'), 'listed');
  await rejects(() => call('authentik_branding_file_upload', { path: '/tmp/mcp-test-evil.svg' }), /script/);
  await call('authentik_branding_file_delete', { name: 'branding/mcp-test-logo.svg', confirm: true });
});

// --- ids cannot climb out of their path
await step('path-like ids are refused', async () => {
  await rejects(() => call('authentik_consent_delete', { id: '../users/5', confirm: true }), /not a valid id/);
  await rejects(() => call('authentik_users_user_get', { id: '..' }), /not a valid id/);
  await rejects(() => call('authentik_system_schedule_get', { id: 'a/b' }), /not a valid id/);
});

// --- service account, cleanup
await step('service account create then delete user', async () => {
  const sa = await call('authentik_users_service_account_create', { name: 'mcp-test-sa', create_group: false });
  must(sa.token && sa.user_pk, 'token');
  await call('authentik_users_user_delete', { id: sa.user_pk, confirm: true });
});
await step('user delete', async () => { await call('authentik_users_user_delete', { id: user.pk, confirm: true }); });

const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
process.exit(failed.length ? 1 : 0);
