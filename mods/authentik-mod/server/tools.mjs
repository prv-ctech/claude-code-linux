import { Registry } from './registry.mjs';
import * as users from './domains/users.mjs';
import * as groups from './domains/groups.mjs';
import * as applications from './domains/applications.mjs';
import * as providers from './domains/providers.mjs';
import * as outposts from './domains/outposts.mjs';
import * as flows from './domains/flows.mjs';
import * as events from './domains/events.mjs';
import * as crypto from './domains/crypto.mjs';
import * as policies from './domains/policies.mjs';
import * as sources from './domains/sources.mjs';
import * as rbac from './domains/rbac.mjs';
import * as blueprints from './domains/blueprints.mjs';
import * as system from './domains/system.mjs';
import * as branding from './domains/branding.mjs';

export function buildRegistry(cfg) {
  const reg = new Registry();
  for (const d of [users, groups, applications, providers, outposts, flows, events, crypto, policies, sources, rbac, blueprints, system, branding]) d.register(reg, cfg);
  return reg;
}
