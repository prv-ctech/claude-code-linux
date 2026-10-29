import { z } from 'zod';
import { crud, idField, resolveFlows, seg } from '../registry.mjs';

export const PROVIDER_MODELS = [
  'authentik_providers_oauth2.oauth2provider', 'authentik_providers_saml.samlprovider',
  'authentik_providers_proxy.proxyprovider', 'authentik_providers_ldap.ldapprovider',
  'authentik_providers_rac.racprovider', 'authentik_providers_radius.radiusprovider',
  'authentik_providers_scim.scimprovider', 'authentik_providers_ws_federation.wsfederationprovider',
  'authentik_providers_ssf.ssfprovider', 'authentik_providers_google_workspace.googleworkspaceprovider',
  'authentik_providers_microsoft_entra.microsoftentraprovider',
];

export function register(reg, cfg) {
  crud(reg, cfg, {
    domain: 'applications', noun: 'application', base: '/core/applications',
    summary: ['pk', 'name', 'slug', 'provider', 'group', 'meta_launch_url', 'open_in_new_tab', 'policy_engine_mode'],
    hint: 'A provider is attached by its integer pk in data.provider; launch_url is read-only, set meta_launch_url.',
  });

  reg.add({
    domain: 'applications', name: 'authentik_applications_create_with_provider', mode: 'write', reveal: true,
    description: 'Create an application and its provider in one transaction (all or nothing). Flow fields accept slugs; for oauth2/saml/proxy the default authorization and invalidation flows are used when omitted. client_secret is shown once.',
    input: {
      app: z.record(z.string(), z.unknown()).describe('Application fields: name and slug are required.'),
      provider_model: z.enum(PROVIDER_MODELS),
      provider: z.record(z.string(), z.unknown()).describe('Provider fields for that model.'),
      policy_bindings: z.array(z.record(z.string(), z.unknown())).optional(),
    },
    run: async (a, { api }) => {
      let provider = { ...a.provider };
      if (/oauth2|saml|proxy|wsfederation/.test(a.provider_model)) {
        provider.authorization_flow ??= cfg.defaultAuthFlow;
        provider.invalidation_flow ??= cfg.defaultInvalidationFlow;
      }
      provider = await resolveFlows(api, provider);
      return api.put('/core/transactional/applications/', { app: a.app, provider_model: a.provider_model, provider, policy_bindings: a.policy_bindings });
    },
  });

  reg.add({
    domain: 'applications', name: 'authentik_applications_check_access',
    description: 'Check whether a user may open an application, and why not.',
    input: { slug: z.string(), user: z.number().int().optional().describe('User pk; defaults to the token user.') },
    run: (a, { api }) => api.get(`/core/applications/${seg(a.slug)}/check_access/`, { for_user: a.user }),
  });

  crud(reg, cfg, {
    domain: 'applications', noun: 'entitlement', base: '/core/application_entitlements',
    summary: ['pbm_uuid', 'name', 'app', 'attributes'],
  });
}
