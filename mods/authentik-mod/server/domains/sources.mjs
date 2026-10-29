import { z } from 'zod';
import { crud, listInput, page, confirmField } from '../registry.mjs';
import { needConfirm } from '../safety.mjs';

const TYPES = { oauth: 'oauth', saml: 'saml', ldap: 'ldap', plex: 'plex', kerberos: 'kerberos', scim: 'scim', telegram: 'telegram' };

export function register(reg, cfg) {
  crud(reg, cfg, {
    domain: 'sources', noun: 'source', base: '/sources', types: TYPES, allPath: '/sources/all/', idName: 'slug',
    summary: ['pk', 'name', 'slug', 'component', 'enabled', 'user_matching_mode', 'managed'],
    hint: 'Deleting a source also removes the user and group connections made through it.',
  });
  reg.add({
    domain: 'sources', name: 'authentik_sources_types',
    description: 'List the OAuth source types (GitHub, Google, ...) and their URLs.',
    run: (a, { api }) => api.get('/sources/oauth/source_types/'),
  });
  reg.add({
    domain: 'sources', name: 'authentik_sources_sync_status',
    description: 'Show the last sync of an LDAP or Kerberos source.',
    input: { type: z.enum(['ldap', 'kerberos']), slug: z.string() },
    run: (a, { api }) => api.get(`/sources/${a.type}/${encodeURIComponent(a.slug)}/sync/status/`),
  });
  reg.add({
    domain: 'sources', name: 'authentik_sources_saml_metadata',
    description: 'Get the service-provider metadata XML of a SAML source.',
    input: { slug: z.string() },
    run: async (a, { api }) => ({ metadata: await api.text(`/sources/saml/${encodeURIComponent(a.slug)}/metadata/`) }),
  });
  for (const kind of ['user', 'group']) {
    reg.add({
      domain: 'sources', name: `authentik_sources_${kind}_connections_list`,
      description: `List which ${kind}s are linked to which source.`,
      input: listInput,
      run: (a, { api }) => api.get(`/sources/${kind}_connections/all/`, page(cfg, a)),
    });
    reg.add({
      domain: 'sources', name: `authentik_sources_${kind}_connection_delete`, mode: 'destructive',
      description: `Unlink a ${kind} from a source.`,
      input: { id: z.union([z.string(), z.number()]), confirm: confirmField },
      run: async (a, { api }) => {
        if (!a.confirm) return needConfirm(`delete ${kind} connection ${a.id}`);
        await api.del(`/sources/${kind}_connections/all/${a.id}/`);
        return { deleted: true };
      },
    });
  }
}
