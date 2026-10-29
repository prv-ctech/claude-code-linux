import { z } from 'zod';
import { crud, listInput, page, confirmField, seg } from '../registry.mjs';
import { needConfirm } from '../safety.mjs';

export function register(reg, cfg) {
  reg.add({
    domain: 'events', name: 'authentik_events_list',
    description: 'List audit events, newest first. Filter with filters, for example {"action": "login_failed", "username": "x", "client_ip": "1.2.3.4", "context_authorized_application": "..."}.',
    input: { ...listInput, ordering: z.string().optional().describe('Default "-created".') },
    run: async (a, { api }) => {
      const res = await api.get('/events/events/', { ...page(cfg, a), ordering: a.ordering ?? '-created' });
      if (a.full) return res;
      return { ...res, results: res.results.map((e) => ({ pk: e.pk, action: e.action, app: e.app, user: e.user?.username, client_ip: e.client_ip, created: e.created, context: e.context })) };
    },
  });
  reg.add({
    domain: 'events', name: 'authentik_events_get',
    description: 'Get one audit event.',
    input: { id: z.string().describe('Event uuid.') },
    run: (a, { api }) => api.get(`/events/events/${seg(a.id)}/`),
  });
  reg.add({
    domain: 'events', name: 'authentik_events_actions',
    description: 'List the event action names that exist.',
    run: (a, { api }) => api.get('/events/events/actions/'),
  });
  reg.add({
    domain: 'events', name: 'authentik_events_volume',
    description: 'Event counts over time, optionally filtered like the list.',
    input: { filters: listInput.filters },
    run: (a, { api }) => api.get('/events/events/volume/', a.filters),
  });
  reg.add({
    domain: 'events', name: 'authentik_events_top_per_user',
    description: 'Users with the most events of one action.',
    input: { action: z.string().optional(), top_n: z.number().int().min(1).max(100).optional() },
    run: (a, { api }) => api.get('/events/events/top_per_user/', a),
  });

  crud(reg, cfg, {
    domain: 'events', noun: 'rule', base: '/events/rules',
    summary: ['pk', 'name', 'severity', 'destination_group', 'transports', 'destination_event_user'],
    hint: 'A notification rule sends matching events through its transports. Bind event_matcher policies to select events.',
  });
  crud(reg, cfg, {
    domain: 'events', noun: 'transport', base: '/events/transports',
    summary: ['pk', 'name', 'mode', 'mode_verbose', 'send_once'],
    hint: 'mode: webhook, webhook_slack, email, local.',
  });
  reg.add({
    domain: 'events', name: 'authentik_events_transport_test', mode: 'write',
    description: 'Send a real test notification through a transport.',
    input: { id: z.string().describe('Transport uuid.'), confirm: confirmField },
    run: async (a, { api }) => {
      if (!a.confirm) return needConfirm(`send a test message through transport ${a.id}`);
      return api.post(`/events/transports/${seg(a.id)}/test/`);
    },
  });
  reg.add({
    domain: 'events', name: 'authentik_events_notifications_list',
    description: 'List notifications of the token user.',
    input: listInput,
    run: (a, { api }) => api.get('/events/notifications/', page(cfg, a)),
  });
}
