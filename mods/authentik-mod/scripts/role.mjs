#!/usr/bin/env node
// Prints the permissions the mod's service-account role needs, as "app_label.codename" lines the
// rbac assign endpoint takes. Reads the list of permissions that exist from your authentik, so it
// matches your version. Usage:
//   AUTHENTIK_URL=... AUTHENTIK_TOKEN=... node scripts/role.mjs [--domains users,groups] [--read-only] [--json]
// The token only needs to read /rbac/permissions/. Domains default to all but flows_admin.

// Which authentik models each tool domain touches: app_label regex, optional model regex.
export const DOMAINS = {
  users: [[/^authentik_core$/, /^(user|token|authenticatedsession|userconsent)$/]],
  groups: [[/^authentik_core$/, /^(group|grouprole)$/]],
  applications: [[/^authentik_core$/, /^(application|applicationentitlement)$/]],
  providers: [[/^authentik_providers_/], [/^authentik_core$/, /^(provider|propertymapping)$/]],
  outposts: [[/^authentik_outposts$/]],
  flows: [[/^authentik_flows$/], [/^authentik_stages_/]],
  events: [[/^authentik_events$/]],
  crypto: [[/^authentik_crypto$/]],
  policies: [[/^authentik_policies/]],
  sources: [[/^authentik_sources_/], [/^authentik_core$/, /^(source|usersourceconnection|groupsourceconnection)$/]],
  rbac: [[/^authentik_rbac$/]],
  blueprints: [[/^authentik_blueprints$/]],
  system: [[/^authentik_rbac$/, /^systempermission$/], [/^authentik_tenants$/], [/^authentik_tasks/]],
  branding: [[/^authentik_brands$/], [/^authentik_flows$/, /^flow$/]],
};
// flows_admin only matters for flows and stages; the flows domain already lists them.

export function select(all, { domains, readOnly }) {
  const out = {};
  for (const d of domains) {
    const rules = DOMAINS[d];
    if (!rules) throw new Error(`unknown domain ${d}`);
    out[d] = all
      .filter((p) => rules.some(([app, model]) => app.test(p.app_label) && (!model || model.test(p.model))))
      .filter((p) => !readOnly || /^view_/.test(p.codename))
      .map((p) => `${p.app_label}.${p.codename}`)
      .sort();
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i < 0 ? null : args[i + 1]; };
  const url = (process.env.AUTHENTIK_URL || '').replace(/\/+$/, '');
  if (!url || !process.env.AUTHENTIK_TOKEN) { console.error('Set AUTHENTIK_URL and AUTHENTIK_TOKEN.'); process.exit(1); }
  const all = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`${url}/api/v3/rbac/permissions/?page=${page}&page_size=200`, { headers: { Authorization: `Bearer ${process.env.AUTHENTIK_TOKEN}` } });
    if (!res.ok) { console.error(`authentik answered ${res.status}`); process.exit(1); }
    const j = await res.json();
    all.push(...j.results);
    if (!j.pagination?.next) break;
  }
  const domains = (opt('--domains') || Object.keys(DOMAINS).join(',')).split(',');
  const picked = select(all, { domains, readOnly: args.includes('--read-only') });
  if (args.includes('--json')) console.log(JSON.stringify([...new Set(Object.values(picked).flat())].sort(), null, 2));
  else for (const [d, list] of Object.entries(picked)) console.log(`# ${d} (${list.length})\n${list.join('\n')}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
