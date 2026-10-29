import { z } from 'zod';
import { crud, idField, confirmField, listInput, page, UserError, seg } from '../registry.mjs';
import { needConfirm } from '../safety.mjs';

export function register(reg, cfg) {
  crud(reg, cfg, {
    domain: 'users', noun: 'user', base: '/core/users', usedBy: false,
    summary: ['pk', 'username', 'name', 'email', 'is_active', 'type', 'path', 'last_login', 'groups', 'roles'],
    hint: 'Only username and name are required to create. type: internal, external, service_account.',
  });

  reg.add({
    domain: 'users', name: 'authentik_users_me',
    description: 'Show the account the token belongs to.',
    run: (a, { api }) => api.get('/core/users/me/'),
  });
  reg.add({
    domain: 'users', name: 'authentik_users_paths',
    description: 'List the user paths (folders) in use.',
    run: (a, { api }) => api.get('/core/users/paths/'),
  });
  reg.add({
    domain: 'users', name: 'authentik_users_service_account_create', mode: 'write', reveal: true,
    description: 'Create a service account. The returned app-password token is shown once.',
    input: { name: z.string().min(1), create_group: z.boolean().optional(), expiring: z.boolean().optional(), expires: z.string().optional().describe('ISO date-time when expiring is true.') },
    run: (a, { api }) => api.post('/core/users/service_account/', a),
  });
  reg.add({
    domain: 'users', name: 'authentik_users_set_password', mode: 'destructive',
    description: 'Set a user\'s password. The password passes through the chat, so prefer a recovery link.',
    input: { id: idField, password: z.string().min(1), confirm: confirmField },
    run: async (a, { api }) => {
      if (!a.confirm) return needConfirm(`set the password of user ${a.id}`);
      await api.post(`/core/users/${seg(a.id)}/set_password/`, { password: a.password });
      return { changed: true };
    },
  });
  reg.add({
    domain: 'users', name: 'authentik_users_recovery_link', mode: 'destructive', reveal: true,
    description: 'Create a one-time account recovery link for a user. Whoever has the link can sign in as them.',
    input: { id: idField, confirm: confirmField },
    run: async (a, { api }) => {
      if (!a.confirm) return needConfirm(`create a recovery link for user ${a.id}`);
      return api.post(`/core/users/${seg(a.id)}/recovery/`);
    },
  });
  reg.add({
    domain: 'users', name: 'authentik_users_recovery_email', mode: 'write',
    description: 'Email a recovery link to a user. Needs the recovery email stage slug.',
    input: { id: idField, email_stage: z.string().describe('Slug or uuid of the email stage.'), confirm: confirmField },
    run: async (a, { api }) => {
      if (!a.confirm) return needConfirm(`email a recovery link to user ${a.id}`);
      await api.post(`/core/users/${seg(a.id)}/recovery_email/`, { email_stage: a.email_stage });
      return { sent: true };
    },
  });

  reg.add({
    domain: 'users', name: 'authentik_sessions_list',
    description: 'List signed-in sessions.',
    input: listInput,
    run: (a, { api }) => api.get('/core/authenticated_sessions/', page(cfg, a)),
  });
  reg.add({
    domain: 'users', name: 'authentik_sessions_revoke', mode: 'destructive',
    description: 'Sign a session out.',
    input: { uuid: z.string(), confirm: confirmField },
    run: async (a, { api }) => {
      if (!a.confirm) return needConfirm(`revoke session ${a.uuid}`);
      await api.del(`/core/authenticated_sessions/${seg(a.uuid)}/`);
      return { revoked: true };
    },
  });

  crud(reg, cfg, {
    domain: 'users', noun: 'token', base: '/core/tokens', usedBy: false,
    summary: ['identifier', 'intent', 'user', 'expiring', 'expires', 'description'],
    hint: 'Use intent "api" for API tokens. The key is not returned here; view_key shows it.',
  });
  reg.add({
    domain: 'users', name: 'authentik_users_token_view_key', mode: 'destructive', reveal: true,
    description: 'Show the secret key of a token.',
    input: { identifier: z.string(), confirm: confirmField },
    run: async (a, { api }) => {
      if (!a.confirm) return needConfirm(`reveal the key of token ${a.identifier}`);
      return api.get(`/core/tokens/${seg(a.identifier)}/view_key/`);
    },
  });

  reg.add({
    domain: 'users', name: 'authentik_consent_list',
    description: 'List consents users gave to applications.',
    input: listInput,
    run: (a, { api }) => api.get('/core/user_consent/', page(cfg, a)),
  });
  reg.add({
    domain: 'users', name: 'authentik_consent_delete', mode: 'destructive',
    description: 'Remove a stored consent; the user is asked again on next sign-in.',
    input: { id: idField, confirm: confirmField },
    run: async (a, { api }) => {
      if (!a.confirm) return needConfirm(`delete consent ${a.id}`);
      await api.del(`/core/user_consent/${seg(a.id)}/`);
      return { deleted: true };
    },
  });
}
