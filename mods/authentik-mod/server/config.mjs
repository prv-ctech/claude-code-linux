// Settings come from the environment. The plugin's userConfig fills them in through .mcp.json;
// the same names work when the server is run by hand for testing.
import os from 'node:os';
import path from 'node:path';

export const ALL_DOMAINS = [
  'users', 'groups', 'applications', 'providers', 'outposts', 'flows', 'events', 'crypto',
  'policies', 'sources', 'rbac', 'blueprints', 'system', 'branding',
];
// Writing flows, stages and stage bindings can lock everyone out of the instance, so it is opt-in.
export const OPT_IN_DOMAINS = ['flows_admin'];

const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, d, min, max) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

export function loadConfig(env = process.env) {
  const url = (env.AUTHENTIK_URL || '').trim().replace(/\/+$/, '');
  const token = (env.AUTHENTIK_TOKEN || '').trim();
  const problems = [];
  if (!url) problems.push('AUTHENTIK_URL is not set');
  else {
    let u;
    try { u = new URL(url); } catch { problems.push('AUTHENTIK_URL is not a valid URL'); }
    if (u && u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
      problems.push('AUTHENTIK_URL must be https (http is allowed only for localhost)');
    }
  }
  if (!token) problems.push('AUTHENTIK_TOKEN is not set');

  const requested = (env.AUTHENTIK_DOMAINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const domains = new Set(requested.length ? requested : ALL_DOMAINS);
  if (bool(env.AUTHENTIK_ALLOW_FLOWS_ADMIN, false)) domains.add('flows_admin');
  const unknown = [...domains].filter((d) => ![...ALL_DOMAINS, ...OPT_IN_DOMAINS].includes(d));
  if (unknown.length) problems.push(`unknown domain(s) in AUTHENTIK_DOMAINS: ${unknown.join(', ')}`);

  const data = env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'plugins', 'data', 'authentik-mod-claude-code-linux');
  return {
    url, token, problems, domains,
    readOnly: bool(env.AUTHENTIK_READ_ONLY, false),
    timeoutMs: int(env.AUTHENTIK_TIMEOUT_MS, 15000, 1000, 120000),
    maxPageItems: int(env.AUTHENTIK_MAX_PAGE_ITEMS, 200, 1, 1000),
    maxCssKb: int(env.AUTHENTIK_BRANDING_MAX_CSS_KB, 100, 1, 1024),
    maxImageMb: int(env.AUTHENTIK_BRANDING_MAX_IMAGE_MB, 5, 1, 25),
    cssAllowedHosts: (env.AUTHENTIK_BRANDING_ALLOWED_HOSTS || 'fonts.googleapis.com,fonts.gstatic.com')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    defaultAuthFlow: env.AUTHENTIK_DEFAULT_AUTH_FLOW || 'default-provider-authorization-implicit-consent',
    defaultInvalidationFlow: env.AUTHENTIK_DEFAULT_INVALIDATION_FLOW || 'default-provider-invalidation-flow',
    dataDir: data,
  };
}
