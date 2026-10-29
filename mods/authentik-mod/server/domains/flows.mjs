import { z } from 'zod';
import { crud, seg } from '../registry.mjs';

const STAGES = {
  account_lockdown: 'account_lockdown', captcha: 'captcha', consent: 'consent', deny: 'deny', dummy: 'dummy',
  email: 'email', endpoints: 'endpoints', identification: 'identification', mtls: 'mtls', password: 'password',
  redirect: 'redirect', source: 'source', user_delete: 'user_delete', user_login: 'user_login',
  user_logout: 'user_logout', user_write: 'user_write', prompt: 'prompt/stages', invitation: 'invitation/stages',
  authenticator_duo: 'authenticator/duo', authenticator_email: 'authenticator/email', authenticator_sms: 'authenticator/sms',
  authenticator_static: 'authenticator/static', authenticator_totp: 'authenticator/totp',
  authenticator_validate: 'authenticator/validate', authenticator_webauthn: 'authenticator/webauthn',
};

// Reading flows is safe. Writing them is the opt-in flows_admin domain: a broken
// authentication flow can lock every user out, including the token's own admin.
export function register(reg, cfg) {
  crud(reg, cfg, {
    domain: 'flows', writeDomain: 'flows_admin', noun: 'flow', base: '/flows/instances', idName: 'slug',
    summary: ['pk', 'name', 'slug', 'title', 'designation', 'authentication', 'policy_engine_mode'],
    hint: 'designation: authentication, authorization, invalidation, enrollment, unenrollment, recovery, stage_configuration.',
  });
  reg.add({
    domain: 'flows', name: 'authentik_flows_export',
    description: 'Export a flow with its stages and bindings as blueprint YAML.',
    input: { slug: z.string() },
    run: async (a, { api }) => ({ yaml: await api.text(`/flows/instances/${seg(a.slug)}/export/`) }),
  });
  reg.add({
    domain: 'flows', name: 'authentik_flows_diagram',
    description: 'Get a Mermaid diagram of a flow.',
    input: { slug: z.string() },
    run: (a, { api }) => api.get(`/flows/instances/${seg(a.slug)}/diagram/`),
  });
  crud(reg, cfg, {
    domain: 'flows', writeDomain: 'flows_admin', noun: 'binding', base: '/flows/bindings',
    summary: ['pk', 'target', 'stage', 'order', 'evaluate_on_plan', 're_evaluate_policies', 'policy_engine_mode'],
    hint: 'A stage binding puts a stage into a flow at an order.',
  });
  crud(reg, cfg, {
    domain: 'flows', writeDomain: 'flows_admin', noun: 'stage', base: '/stages', types: STAGES, allPath: '/stages/all/',
    summary: ['pk', 'name', 'component', 'verbose_name', 'flow_set'],
  });
  crud(reg, cfg, {
    domain: 'flows', writeDomain: 'flows_admin', noun: 'prompt', base: '/stages/prompt/prompts',
    summary: ['pk', 'name', 'field_key', 'type', 'label', 'required', 'order'],
    codeFields: ['placeholder', 'initial_value'],
    hint: 'A prompt is one field shown by a prompt stage.',
  });
}
