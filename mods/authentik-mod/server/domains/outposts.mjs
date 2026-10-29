import { z } from 'zod';
import { crud } from '../registry.mjs';

export function register(reg, cfg) {
  crud(reg, cfg, {
    domain: 'outposts', noun: 'outpost', base: '/outposts/instances',
    summary: ['pk', 'name', 'type', 'providers', 'service_connection', 'managed'],
    hint: 'type: proxy, ldap, radius, rac.',
  });
  reg.add({
    domain: 'outposts', name: 'authentik_outposts_health',
    description: 'Show the connected instances and version of an outpost.',
    input: { id: z.string().describe('Outpost uuid.') },
    run: (a, { api }) => api.get(`/outposts/instances/${a.id}/health/`),
  });
  reg.add({
    domain: 'outposts', name: 'authentik_outposts_default_settings',
    description: 'Show the default outpost configuration.',
    run: (a, { api }) => api.get('/outposts/instances/default_settings/'),
  });
  crud(reg, cfg, {
    domain: 'outposts', noun: 'connection', base: '/outposts/service_connections',
    types: { docker: 'docker', kubernetes: 'kubernetes' }, allPath: '/outposts/service_connections/all/',
    summary: ['pk', 'name', 'component', 'local', 'verbose_name'],
    hint: 'Service connections tell authentik where to deploy managed outposts.',
  });
  reg.add({
    domain: 'outposts', name: 'authentik_outposts_connection_state',
    description: 'Show whether a service connection works.',
    input: { id: z.string().describe('Connection uuid.') },
    run: (a, { api }) => api.get(`/outposts/service_connections/all/${a.id}/state/`),
  });
}
