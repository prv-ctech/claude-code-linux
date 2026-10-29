import { z } from 'zod';
import { confirmField, listInput, page, seg } from '../registry.mjs';
import { needConfirm } from '../safety.mjs';

export function register(reg, cfg) {
  reg.add({
    domain: '*', name: 'authentik_status',
    description: 'Check the connection: authentik version, the token user, and which tool domains and modes this mod has on.',
    run: async (a, { api }) => {
      const [version, me] = await Promise.all([api.get('/admin/version/'), api.get('/core/users/me/')]);
      return {
        url: cfg.url, version: version.version_current, outdated: version.outdated,
        token_user: me.user.username, token_user_is_superuser: me.user.is_superuser,
        read_only: cfg.readOnly, domains: [...cfg.domains].sort(), max_page_items: cfg.maxPageItems,
      };
    },
  });
  reg.add({
    domain: 'system', name: 'authentik_system_info',
    description: 'Version, server time, runtime and base URL.',
    run: async (a, { api }) => ({ version: await api.get('/admin/version/'), system: await api.get('/admin/system/') }),
  });
  reg.add({
    domain: 'system', name: 'authentik_system_config',
    description: 'Public instance configuration (capabilities, error reporting).',
    run: (a, { api }) => api.get('/root/config/'),
  });
  reg.add({
    domain: 'system', name: 'authentik_system_settings_get',
    description: 'Get instance settings: event retention, token defaults, impersonation, page sizes...',
    run: (a, { api }) => api.get('/admin/settings/'),
  });
  reg.add({
    domain: 'system', name: 'authentik_system_settings_update', mode: 'destructive',
    description: 'Change instance settings (PATCH: only the fields in data change). Affects every user.',
    input: { data: z.record(z.string(), z.unknown()), confirm: confirmField },
    run: async (a, { api }) => {
      if (!a.confirm) return needConfirm('change instance settings', { current: await api.get('/admin/settings/'), change: a.data });
      return api.patch('/admin/settings/', a.data);
    },
  });
  reg.add({
    domain: 'system', name: 'authentik_system_workers',
    description: 'Count the connected workers.',
    run: (a, { api }) => api.get('/tasks/workers/'),
  });
  reg.add({
    domain: 'system', name: 'authentik_system_schedules_list',
    description: 'List scheduled background jobs.',
    input: listInput,
    run: (a, { api }) => api.get('/tasks/schedules/', page(cfg, a)),
  });
  reg.add({
    domain: 'system', name: 'authentik_system_schedule_get',
    description: 'Get one schedule.',
    input: { id: z.string() },
    run: (a, { api }) => api.get(`/tasks/schedules/${seg(a.id)}/`),
  });
  reg.add({
    domain: 'system', name: 'authentik_system_schedule_update', mode: 'write',
    description: 'Change a schedule (crontab, paused...).',
    input: { id: z.string(), data: z.record(z.string(), z.unknown()) },
    run: (a, { api }) => api.patch(`/tasks/schedules/${seg(a.id)}/`, a.data),
  });
  reg.add({
    domain: 'system', name: 'authentik_system_schedule_run', mode: 'write',
    description: 'Run a scheduled job now.',
    input: { id: z.string(), confirm: confirmField },
    run: async (a, { api }) => {
      if (!a.confirm) return needConfirm(`run schedule ${a.id} now`, await api.get(`/tasks/schedules/${seg(a.id)}/`));
      await api.post(`/tasks/schedules/${seg(a.id)}/send/`);
      return { triggered: true };
    },
  });
  reg.add({
    domain: 'system', name: 'authentik_system_tasks_list',
    description: 'List background task runs. Filters: state, aggregated_status, actor_name, queue_name.',
    input: listInput,
    run: (a, { api }) => api.get('/tasks/tasks/', page(cfg, a)),
  });
  reg.add({
    domain: 'system', name: 'authentik_system_tasks_status',
    description: 'Task counts by status.',
    run: (a, { api }) => api.get('/tasks/tasks/status/'),
  });
  reg.add({
    domain: 'system', name: 'authentik_system_task_retry', mode: 'write',
    description: 'Retry a failed task.',
    input: { id: z.string().describe('Task message id.'), confirm: confirmField },
    run: async (a, { api }) => {
      if (!a.confirm) return needConfirm(`retry task ${a.id}`);
      await api.post(`/tasks/tasks/${seg(a.id)}/retry/`);
      return { retried: true };
    },
  });
}
