import { z } from 'zod';
import { crud, idField, UserError, seg } from '../registry.mjs';

export function register(reg, cfg) {
  crud(reg, cfg, {
    domain: 'groups', noun: 'group', base: '/core/groups',
    summary: ['pk', 'name', 'is_superuser', 'parent', 'users', 'roles'],
    // A superuser group hands every member full admin rights, so it stays a human decision in the admin UI.
    guard: async (kind, data) => {
      if (data.is_superuser === true) throw new UserError('Making a group superuser is blocked here. Do it in the authentik admin UI.');
      return data;
    },
  });
  for (const act of ['add', 'remove']) {
    reg.add({
      domain: 'groups', name: `authentik_groups_${act}_user`, mode: 'write',
      description: `${act === 'add' ? 'Add a user to' : 'Remove a user from'} a group.`,
      input: { group: idField.describe('Group uuid.'), user: z.number().int().describe('User pk.') },
      run: async (a, { api }) => {
        await api.post(`/core/groups/${seg(a.group)}/${act}_user/`, { pk: a.user });
        return { ok: true, group: a.group, user: a.user, action: act };
      },
    });
  }
}
