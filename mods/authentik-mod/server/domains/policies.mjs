import { crud } from '../registry.mjs';

const TYPES = {
  dummy: 'dummy', event_matcher: 'event_matcher', expression: 'expression', geoip: 'geoip',
  password: 'password', password_expiry: 'password_expiry', reputation: 'reputation', unique_password: 'unique_password',
};

export function register(reg, cfg) {
  crud(reg, cfg, {
    domain: 'policies', noun: 'policy', base: '/policies', types: TYPES, allPath: '/policies/all/',
    summary: ['pk', 'name', 'component', 'verbose_name', 'bound_to'],
    hint: 'An expression policy runs Python inside authentik: treat its expression as code and show it to the user before creating or changing it.',
  });
  crud(reg, cfg, {
    domain: 'policies', noun: 'binding', base: '/policies/bindings',
    summary: ['pk', 'target', 'policy', 'group', 'user', 'order', 'negate', 'enabled', 'timeout', 'failure_result'],
    hint: 'A binding attaches a policy, group or user to a target (application, flow, stage binding...) at an order. Exactly one of policy, group, user is set.',
  });
}
