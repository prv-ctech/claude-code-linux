import { z } from 'zod';
import { crud, confirmField, UserError } from '../registry.mjs';
import { needConfirm } from '../safety.mjs';

export function register(reg, cfg) {
  crud(reg, cfg, {
    domain: 'blueprints', noun: 'blueprint', base: '/managed/blueprints',
    summary: ['pk', 'name', 'path', 'enabled', 'status', 'last_applied', 'managed_models'],
    hint: 'A blueprint is YAML that creates or changes authentik objects, including users, permissions and tokens. data.content holds inline YAML, data.path a file under the blueprints directory.',
  });
  reg.add({
    domain: 'blueprints', name: 'authentik_blueprints_available',
    description: 'List blueprint files authentik found on disk.',
    run: (a, { api }) => api.get('/managed/blueprints/available/'),
  });
  reg.add({
    domain: 'blueprints', name: 'authentik_blueprints_apply', mode: 'destructive',
    description: 'Queue a blueprint instance to be applied now. It can create or change many objects at once, in one transaction. The worker runs it a moment later: check status with authentik_blueprints_blueprint_get.',
    input: { id: z.string().describe('Blueprint instance uuid.'), confirm: confirmField },
    run: async (a, { api }) => {
      const bp = await api.get(`/managed/blueprints/${a.id}/`);
      if (!a.confirm) return needConfirm(`apply blueprint "${bp.name}"`, { name: bp.name, path: bp.path, enabled: bp.enabled, content: bp.content?.slice(0, 4000) });
      return api.post(`/managed/blueprints/${a.id}/apply/`);
    },
  });
  reg.add({
    domain: 'blueprints', name: 'authentik_blueprints_import', mode: 'destructive',
    description: 'Run blueprint YAML once without saving an instance. Same power as apply.',
    input: { content: z.string().min(1).describe('Blueprint YAML.'), confirm: confirmField },
    run: async (a, { api }) => {
      if (!a.confirm) return needConfirm('import and apply this blueprint YAML', { content: a.content.slice(0, 4000) });
      const form = new FormData();
      form.set('file', new Blob([a.content], { type: 'text/yaml' }), 'blueprint.yaml');
      return api.upload('/managed/blueprints/import/', form);
    },
  });
}
