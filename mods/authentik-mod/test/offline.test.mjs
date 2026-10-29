// Offline checks: no network, no authentik. Run with: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.mjs';
import { redact } from '../server/safety.mjs';
import { buildRegistry } from '../server/tools.mjs';
import { validateCss, checkSvg } from '../server/domains/branding.mjs';
import { select, DOMAINS } from '../scripts/role.mjs';

const env = { AUTHENTIK_URL: 'https://auth.example.com/', AUTHENTIK_TOKEN: 't' };
const cfg = (extra = {}) => loadConfig({ ...env, ...extra });

test('config: needs url and token, https only, trims the slash', () => {
  assert.equal(cfg().url, 'https://auth.example.com');
  assert.deepEqual(loadConfig({}).problems.length, 2);
  assert.match(loadConfig({ ...env, AUTHENTIK_URL: 'http://auth.example.com' }).problems[0], /https/);
  assert.equal(loadConfig({ ...env, AUTHENTIK_URL: 'http://localhost:9000' }).problems.length, 0);
});

test('config: flows_admin is off unless asked, unknown domains are reported', () => {
  assert.equal(cfg().domains.has('flows_admin'), false);
  assert.equal(cfg({ AUTHENTIK_ALLOW_FLOWS_ADMIN: 'true' }).domains.has('flows_admin'), true);
  assert.match(cfg({ AUTHENTIK_DOMAINS: 'users,nope' }).problems[0], /nope/);
});

test('redact hides secrets but keeps durations and ids', () => {
  const out = redact({ client_secret: 'a', password: 'b', key: 'c', token_validity: 'hours=1', signing_key: 'uuid', avatar: 'data:image/svg+xml;base64,AAAA', nested: [{ bind_password: 'd' }] });
  assert.equal(out.client_secret, '***redacted***');
  assert.equal(out.password, '***redacted***');
  assert.equal(out.key, '***redacted***');
  assert.equal(out.nested[0].bind_password, '***redacted***');
  assert.equal(out.token_validity, 'hours=1');
  assert.equal(out.signing_key, 'uuid');
  assert.equal(out.avatar, '(inline image omitted)');
});

test('registry: names are unique, valid and short; every domain has tools', () => {
  const reg = buildRegistry(cfg());
  const names = reg.tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) assert.match(n, /^authentik_[a-z0-9_]+$/);
  assert.ok(names.every((n) => n.length <= 64));
  for (const d of Object.keys(DOMAINS)) assert.ok(reg.tools.some((t) => t.domain === d), `no tools for ${d}`);
});

test('registry: read-only registers only read tools; flows writes need flows_admin', () => {
  const reg = buildRegistry(cfg());
  assert.ok(reg.select(cfg({ AUTHENTIK_READ_ONLY: 'true' })).every((t) => t.mode === 'read'));
  const names = (c) => reg.select(c).map((t) => t.name);
  assert.ok(!names(cfg()).includes('authentik_flows_flow_create'));
  assert.ok(names(cfg()).includes('authentik_flows_flow_list'));
  assert.ok(names(cfg({ AUTHENTIK_ALLOW_FLOWS_ADMIN: '1' })).includes('authentik_flows_flow_create'));
  assert.ok(names(cfg({ AUTHENTIK_DOMAINS: 'users' })).includes('authentik_status'));
  assert.ok(!names(cfg({ AUTHENTIK_DOMAINS: 'users' })).includes('authentik_groups_group_list'));
});

test('registry: every destructive tool takes confirm and stops without it', async () => {
  const c = cfg();
  const reg = buildRegistry(c);
  const calls = [];
  const api = new Proxy({}, { get: (_, verb) => async (...a) => { calls.push([verb, a[0]]); return verb === 'get' ? { pk: 1, name: 'x', results: [] } : {}; } });
  for (const t of reg.select(c).filter((t) => t.mode === 'destructive')) {
    assert.ok('confirm' in t.input, `${t.name} has no confirm`);
    const args = Object.fromEntries(Object.keys(t.input).map((k) => [k, k === 'confirm' ? undefined : k === 'data' ? {} : k === 'permissions' ? ['a.b'] : k === 'content' || k === 'css' ? 'x' : 'abc']));
    calls.length = 0;
    const out = await t.run(args, { api, cfg: c, audit() {} }).catch((e) => ({ error: e.message }));
    assert.ok(out.dry_run || out.error, `${t.name} did not stop`);
    assert.ok(calls.every(([verb]) => verb === 'get'), `${t.name} wrote without confirm: ${JSON.stringify(calls)}`);
  }
});

test('css: allows plain styling and allowed font hosts, rejects the rest', () => {
  const c = cfg();
  validateCss('body{color:red;background:url(/static/x.png)}', c);
  validateCss('@import url("https://fonts.googleapis.com/css2?family=Inter");', c);
  validateCss('a{background:url(data:image/png;base64,AAAA)}', c);
  for (const bad of ['@import url(https://evil.example/a.css);', 'a{background:url(//evil.example/x.png)}', 'a{width:expression(alert(1))}', 'a{background:url(javascript:alert(1))}', '</style><script>x</script>', 'a{background:url(data:text/html;base64,AAAA)}']) {
    assert.throws(() => validateCss(bad, c), undefined, bad);
  }
  assert.throws(() => validateCss('a{}'.repeat(60000), c), /larger/);
});

test('svg: scripts and handlers are rejected', () => {
  checkSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
  for (const bad of ['<svg><script>1</script></svg>', '<svg onload="x()"></svg>', '<svg><foreignObject/></svg>']) assert.throws(() => checkSvg(bad));
});

test('role script: picks permissions by domain and read-only', () => {
  const all = [
    { app_label: 'authentik_core', model: 'user', codename: 'view_user' },
    { app_label: 'authentik_core', model: 'user', codename: 'delete_user' },
    { app_label: 'authentik_events', model: 'event', codename: 'view_event' },
  ];
  assert.deepEqual(select(all, { domains: ['users'], readOnly: false }).users, ['authentik_core.delete_user', 'authentik_core.view_user']);
  assert.deepEqual(select(all, { domains: ['users', 'events'], readOnly: true }), { users: ['authentik_core.view_user'], events: ['authentik_events.view_event'] });
});

test('ids: path-like values are refused before any request', async () => {
  const c = cfg();
  const reg = buildRegistry(c);
  const calls = [];
  const api = new Proxy({}, { get: () => async (...a) => { calls.push(a[0]); return {}; } });
  for (const [name, args] of [
    ['authentik_consent_delete', { id: '../users/5', confirm: true }],
    ['authentik_users_set_password', { id: '5/../6', password: 'x', confirm: true }],
    ['authentik_users_user_delete', { id: '..', confirm: true }],
    ['authentik_system_task_retry', { id: 'a?b', confirm: true }],
    ['authentik_rbac_permissions_assign', { role: 'a/b', permissions: ['x.y'], confirm: true }],
  ]) {
    const t = reg.tools.find((t) => t.name === name);
    await assert.rejects(() => t.run(args, { api, cfg: c, audit() {} }), /not a valid id/, name);
  }
  assert.deepEqual(calls, []);
});

test('blueprints: instances are saved disabled', async () => {
  const reg = buildRegistry(cfg());
  const sent = [];
  const api = { post: async (p, b) => { sent.push(b); return {}; }, patch: async (p, b) => { sent.push(b); return {}; } };
  for (const name of ['authentik_blueprints_blueprint_create', 'authentik_blueprints_blueprint_update']) {
    await reg.tools.find((t) => t.name === name).run({ id: 'abc', data: { name: 'x', content: 'y', enabled: true } }, { api, cfg: cfg(), audit() {} });
  }
  assert.ok(sent.every((b) => b.enabled === false));
});
