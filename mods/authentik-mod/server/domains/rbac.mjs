import { z } from 'zod';
import { crud, idField, confirmField, listInput, page } from '../registry.mjs';
import { needConfirm } from '../safety.mjs';

export function register(reg, cfg) {
  crud(reg, cfg, {
    domain: 'rbac', noun: 'role', base: '/rbac/roles',
    summary: ['pk', 'name', 'group'],
    hint: 'In 2026.8 permissions belong to roles; users and groups get them by holding a role.',
  });
  for (const act of ['add', 'remove']) {
    reg.add({
      domain: 'rbac', name: `authentik_rbac_role_${act}_user`, mode: 'write',
      description: `${act === 'add' ? 'Give a role to' : 'Take a role from'} a user.`,
      input: { role: z.string().describe('Role uuid.'), user: z.number().int().describe('User pk.') },
      run: async (a, { api }) => {
        await api.post(`/rbac/roles/${a.role}/${act}_user/`, { pk: a.user });
        return { ok: true, role: a.role, user: a.user, action: act };
      },
    });
  }
  reg.add({
    domain: 'rbac', name: 'authentik_rbac_permissions_list',
    description: 'List the permissions that exist. Filters: codename, content_type__app_label, content_type__model, role.',
    input: listInput,
    run: (a, { api }) => api.get('/rbac/permissions/', page(cfg, a)),
  });
  reg.add({
    domain: 'rbac', name: 'authentik_rbac_role_permissions',
    description: 'List the global permissions a role holds.',
    input: { role: z.string().describe('Role uuid.') },
    run: (a, { api }) => api.get('/rbac/permissions/assigned_by_roles/', { uuid: a.role }).catch(() => api.get('/rbac/permissions/', { role: a.role })),
  });
  for (const act of ['assign', 'unassign']) {
    reg.add({
      domain: 'rbac', name: `authentik_rbac_permissions_${act}`, mode: 'destructive',
      description: `${act === 'assign' ? 'Grant' : 'Revoke'} permissions on a role. permissions are "app_label.codename" strings such as "authentik_core.view_user". With model and object_pk the permission is for that one object, otherwise it is global. Granting permissions raises what the role can do.`,
      input: {
        role: z.string().describe('Role uuid.'),
        permissions: z.array(z.string().min(1)).min(1),
        model: z.string().optional().describe('Model, for example "authentik_core.application".'),
        object_pk: z.string().optional(),
        confirm: confirmField,
      },
      run: async (a, { api }) => {
        const { role, confirm, ...body } = a;
        if (!confirm) return needConfirm(`${act} ${a.permissions.length} permission(s) ${act === 'assign' ? 'to' : 'from'} role ${role}`, body);
        const path = `/rbac/permissions/assigned_by_roles/${role}/${act}/`;
        return act === 'assign' ? api.post(path, body) : api.patch(path, body);
      },
    });
  }
  crud(reg, cfg, {
    domain: 'rbac', noun: 'initial_permission', base: '/rbac/initial_permissions',
    summary: ['pk', 'name', 'role', 'permissions'],
    hint: 'Initial permissions are given to the creator of an object.',
  });
}
