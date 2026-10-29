// Tool registry: domains declare tools here; start-up registers the ones the config allows.
import { z } from 'zod';
import { AuthentikError } from './client.mjs';
import { redact, needConfirm } from './safety.mjs';

const MAX_OUTPUT_CHARS = 60000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s) => typeof s === 'string' && UUID.test(s);

export const confirmField = z.boolean().optional().describe('Set true to really do it. Without it the call is a dry run that changes nothing.');
export const idField = z.union([z.string(), z.number()]).describe('The object id: pk, uuid or slug, as the resource uses.');
export const dataField = z.record(z.string(), z.unknown()).describe('Request body fields, exactly as the authentik API names them.');

export class Registry {
  constructor() { this.tools = []; }

  // mode: 'read' | 'write' (changes state) | 'destructive' (deletes or exposes a secret).
  add({ domain, name, description, input = {}, mode = 'read', reveal = false, run }) {
    if (this.tools.some((t) => t.name === name)) throw new Error(`duplicate tool ${name}`);
    this.tools.push({ domain, name, description, input, mode, reveal, run });
  }

  select(cfg) {
    return this.tools.filter((t) => (t.domain === '*' || cfg.domains.has(t.domain)) && !(cfg.readOnly && t.mode !== 'read'));
  }

  register(server, cfg, ctx) {
    const picked = this.select(cfg);
    for (const t of picked) {
      server.registerTool(t.name, {
        description: t.description,
        inputSchema: t.input,
        annotations: {
          readOnlyHint: t.mode === 'read',
          destructiveHint: t.mode === 'destructive',
          idempotentHint: t.mode === 'read',
          openWorldHint: false,
        },
      }, async (args) => {
        const started = Date.now();
        const base = { tool: t.name, args: redact(args) };
        try {
          const result = await t.run(args, ctx);
          ctx.audit({ ...base, result: result?.dry_run ? 'dry_run' : 'ok', durationMs: Date.now() - started });
          return reply(t.reveal || result?.dry_run ? result : redact(result));
        } catch (e) {
          const message = e instanceof AuthentikError || e?.userFacing ? e.message : `Internal error: ${e?.message || e}`;
          ctx.audit({ ...base, result: 'error', error: message.slice(0, 300), durationMs: Date.now() - started });
          return { isError: true, content: [{ type: 'text', text: message }] };
        }
      });
    }
    return picked.length;
  }
}

function reply(value) {
  let text = JSON.stringify(value ?? { ok: true }, null, 2);
  if (text.length > MAX_OUTPUT_CHARS) {
    text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n... output cut at ${MAX_OUTPUT_CHARS} characters. Narrow it with filters, page, page_size or fields.`;
  }
  return { content: [{ type: 'text', text }] };
}

export class UserError extends Error { constructor(m) { super(m); this.userFacing = true; } }

// Anything put into a URL path goes through here: one plain segment, never "..", "/", "?" or "#".
export function seg(v) {
  const s = String(v);
  if (!/^[\w.@+:-]+$/.test(s) || /^\.+$/.test(s)) throw new UserError(`"${s.slice(0, 60)}" is not a valid id or slug.`);
  return s;
}

// Flow fields accept a slug; the API wants the flow's pk. Resolve slugs once, in one place.
export async function resolveFlows(api, data) {
  const out = { ...data };
  for (const [k, v] of Object.entries(out)) {
    if (!/(^|_)flow$/.test(k) || typeof v !== 'string' || v === '' || isUuid(v)) continue;
    const flow = await api.get(`/flows/instances/${seg(v)}/`).catch((e) => {
      if (e.status === 404) throw new UserError(`${k}: no flow with slug "${v}"`);
      throw e;
    });
    out[k] = flow.pk;
  }
  return out;
}

export function page(cfg, args) {
  const size = Math.min(args.page_size ?? 50, cfg.maxPageItems);
  return { page: args.page, page_size: size, search: args.search, ordering: args.ordering, ...(args.filters || {}) };
}

export function slim(list, fields) {
  if (!fields) return list;
  const pick = (o) => Object.fromEntries(fields.filter((f) => f in o).map((f) => [f, o[f]]));
  return { ...list, results: list.results.map(pick) };
}

export const listInput = {
  search: z.string().optional().describe('Free-text search.'),
  ordering: z.string().optional().describe('Field to sort by, "-" prefix to reverse.'),
  page: z.number().int().min(1).optional(),
  page_size: z.number().int().min(1).optional().describe('Items per page. Capped by AUTHENTIK_MAX_PAGE_ITEMS.'),
  filters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
    .describe('Extra query filters the endpoint supports, for example {"is_active": true}.'),
  full: z.boolean().optional().describe('Return every field. Default is a short summary.'),
};

// Standard list/get/create/update/delete set for one family of resources.
//   types: { typeName: 'path under base' }; without types the family is a single resource.
export function crud(reg, cfg, o) {
  const { domain, noun, base, idName = 'id', summary, types, allPath, writeDomain = domain, noCreate, noUpdate, noDelete, usedBy = true, guard, hint = '' } = o;
  const typeKeys = types ? Object.keys(types) : null;
  const typeField = typeKeys ? { type: z.enum(typeKeys).describe(`Which ${noun} type.`) } : {};
  const optType = typeKeys ? { type: z.enum(typeKeys).optional().describe(`Which ${noun} type. Omit to search all types.`) } : {};
  const collection = (type) => (types ? `${base}/${types[type]}/` : `${base}/`);
  const item = (type, id) => `${collection(type)}${seg(id)}/`;
  const all = allPath ?? (types ? `${base}/all/` : null);
  const withType = (args, need) => {
    if (typeKeys && need && !args.type) throw new UserError(`type is required: ${typeKeys.join(', ')}`);
  };
  const tool = (suffix, spec) => reg.add({ domain: spec.mode === 'read' ? domain : writeDomain, name: `authentik_${domain}_${noun}_${suffix}`, ...spec });

  tool('list', {
    mode: 'read',
    description: `List ${noun}s.${typeKeys ? ` Types: ${typeKeys.join(', ')}; without type, lists all types.` : ''} Returns a summary of each unless full is set. ${hint}`,
    input: { ...optType, ...listInput },
    run: async (a, { api }) => {
      const path = typeKeys && a.type ? collection(a.type) : typeKeys ? all : `${base}/`;
      const res = await api.get(path, page(cfg, a));
      return slim(res, a.full ? null : summary);
    },
  });
  tool('get', {
    mode: 'read',
    description: `Get one ${noun} with all its fields. Secrets are redacted.`,
    input: { ...optType, id: idField },
    run: async (a, { api }) => api.get(typeKeys && !a.type ? `${all}${seg(a.id)}/` : item(a.type, a.id)),
  });
  if (!noCreate) {
    tool('create', {
      mode: 'write',
      description: `Create a ${noun}. data holds the fields; flow fields accept a flow slug. ${hint}`,
      input: { ...typeField, data: dataField },
      reveal: true,
      run: async (a, ctx) => {
        withType(a, true);
        let data = a.data;
        if (guard) data = await guard('create', data, ctx, a);
        data = await resolveFlows(ctx.api, data);
        return ctx.api.post(collection(a.type), data);
      },
    });
  }
  if (!noUpdate) {
    tool('update', {
      mode: 'write',
      description: `Change fields of a ${noun} (PATCH: only the fields in data change).`,
      input: { ...typeField, id: idField, data: dataField },
      run: async (a, ctx) => {
        withType(a, true);
        let data = a.data;
        if (guard) data = await guard('update', data, ctx, a);
        data = await resolveFlows(ctx.api, data);
        return ctx.api.patch(item(a.type, a.id), data);
      },
    });
  }
  if (!noDelete) {
    tool('delete', {
      mode: 'destructive',
      description: `Delete a ${noun}. Permanent. Without confirm it only shows what would go and what uses it.`,
      input: { ...optType, id: idField, confirm: confirmField },
      run: async (a, ctx) => {
        const path = typeKeys && !a.type ? `${all}${seg(a.id)}/` : item(a.type, a.id);
        const current = await ctx.api.get(path);
        if (!a.confirm) {
          const used = usedBy ? await ctx.api.get(`${path}used_by/`).catch(() => null) : null;
          return needConfirm(`delete ${noun} ${a.id}`, { object: slimOne(current, summary), used_by: used });
        }
        if (guard) await guard('delete', current, ctx, a);
        await ctx.api.del(path);
        return { deleted: true, noun, id: a.id };
      },
    });
  }
  if (usedBy) {
    tool('used_by', {
      mode: 'read',
      description: `List the objects that reference a ${noun}. Check before deleting.`,
      input: { ...optType, id: idField },
      run: async (a, { api }) => api.get(`${typeKeys && !a.type ? all + seg(a.id) + '/' : item(a.type, a.id)}used_by/`),
    });
  }
}

export function slimOne(o, fields) {
  return fields ? Object.fromEntries(fields.filter((f) => f in o).map((f) => [f, o[f]])) : o;
}
