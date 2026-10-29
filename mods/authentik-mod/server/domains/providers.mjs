import { z } from 'zod';
import { crud, idField, confirmField, listInput, page } from '../registry.mjs';
import { needConfirm } from '../safety.mjs';

const TYPES = {
  oauth2: 'oauth2', saml: 'saml', proxy: 'proxy', ldap: 'ldap', rac: 'rac', radius: 'radius',
  scim: 'scim', wsfed: 'wsfed', ssf: 'ssf', google_workspace: 'google_workspace', microsoft_entra: 'microsoft_entra',
};
const NEEDS_FLOWS = new Set(['oauth2', 'saml', 'proxy']);

const MAPPING_TYPES = {
  scope: 'provider/scope', saml: 'provider/saml', rac: 'provider/rac', radius: 'provider/radius', scim: 'provider/scim',
  google_workspace: 'provider/google_workspace', microsoft_entra: 'provider/microsoft_entra',
  source_oauth: 'source/oauth', source_saml: 'source/saml', source_ldap: 'source/ldap', source_kerberos: 'source/kerberos',
  source_plex: 'source/plex', source_scim: 'source/scim', source_telegram: 'source/telegram', notification: 'notification',
};

export function register(reg, cfg) {
  crud(reg, cfg, {
    domain: 'providers', noun: 'provider', base: '/providers', types: TYPES, allPath: '/providers/all/',
    summary: ['pk', 'name', 'component', 'assigned_application_slug', 'authorization_flow', 'verbose_name'],
    hint: 'Providers are attached to an application via the application\'s provider field. oauth2 needs redirect_uris entries {matching_mode, url}.',
    guard: async (kind, data, { api }, a) => {
      if (kind === 'create' && NEEDS_FLOWS.has(a.type)) {
        return { authorization_flow: cfg.defaultAuthFlow, invalidation_flow: cfg.defaultInvalidationFlow, ...data };
      }
      return data;
    },
  });

  reg.add({
    domain: 'providers', name: 'authentik_providers_client_secret_get', mode: 'destructive', reveal: true,
    description: 'Show the OAuth2 client_id and client_secret of a provider.',
    input: { id: z.number().int().describe('OAuth2 provider pk.'), confirm: confirmField },
    run: async (a, { api }) => {
      if (!a.confirm) return needConfirm(`reveal the client secret of OAuth2 provider ${a.id}`);
      const p = await api.get(`/providers/oauth2/${a.id}/`);
      return { client_id: p.client_id, client_secret: p.client_secret };
    },
  });
  reg.add({
    domain: 'providers', name: 'authentik_providers_oauth2_setup_urls',
    description: 'Show the issuer, authorize, token, userinfo and JWKS URLs of an OAuth2 provider.',
    input: { id: z.number().int() },
    run: (a, { api }) => api.get(`/providers/oauth2/${a.id}/setup_urls/`),
  });
  reg.add({
    domain: 'providers', name: 'authentik_providers_saml_metadata',
    description: 'Get the SAML metadata XML of a provider.',
    input: { id: z.number().int() },
    run: async (a, { api }) => ({ metadata: await api.text(`/providers/saml/${a.id}/metadata/`) }),
  });
  reg.add({
    domain: 'providers', name: 'authentik_providers_sync_status',
    description: 'Show the sync status of a SCIM, Google Workspace or Microsoft Entra provider.',
    input: { type: z.enum(['scim', 'google_workspace', 'microsoft_entra']), id: z.number().int() },
    run: (a, { api }) => api.get(`/providers/${a.type}/${a.id}/sync/status/`),
  });

  crud(reg, cfg, {
    domain: 'providers', noun: 'mapping', base: '/propertymappings', types: MAPPING_TYPES, allPath: '/propertymappings/all/',
    summary: ['pk', 'name', 'managed', 'verbose_name'],
    hint: 'Property mappings hold Python expressions that run in authentik; treat the expression field as code.',
  });
}
