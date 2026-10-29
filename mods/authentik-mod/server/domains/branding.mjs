import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { crud, UserError, confirmField, listInput } from '../registry.mjs';
import { needConfirm } from '../safety.mjs';

const FORBIDDEN_CSS = [/<\/?style/i, /<script/i, /expression\s*\(/i, /javascript:/i, /vbscript:/i, /-moz-binding/i, /behavior\s*:/i];
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// Custom CSS runs on the sign-in page of every user. Keep it plain styling: no scripts, and
// remote fonts or images only from hosts the admin allowed.
export function validateCss(css, cfg) {
  if (Buffer.byteLength(css) > cfg.maxCssKb * 1024) throw new UserError(`CSS is larger than ${cfg.maxCssKb} KB.`);
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const re of FORBIDDEN_CSS) if (re.test(bare)) throw new UserError(`CSS contains a forbidden construct (${re.source}).`);
  const refs = [...bare.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)].map((m) => m[1]);
  refs.push(...[...bare.matchAll(/@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)/gi)].map((m) => m[1]));
  for (const ref of refs) {
    if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(ref) || !/^(https?:)?\/\//i.test(ref) && !/^data:/i.test(ref)) continue;
    let host;
    try { host = new URL(ref.startsWith('//') ? `https:${ref}` : ref).hostname.toLowerCase(); } catch { host = ''; }
    if (!cfg.cssAllowedHosts.includes(host)) throw new UserError(`CSS loads "${ref}", host "${host}" is not in AUTHENTIK_BRANDING_ALLOWED_HOSTS (${cfg.cssAllowedHosts.join(', ') || 'none'}).`);
    if (/^data:/i.test(ref)) throw new UserError('CSS contains a data: URL that is not a plain image.');
  }
  return css;
}

export function checkSvg(text) {
  if (/<script|on[a-z]+\s*=|javascript:|<foreignObject|<iframe|<!ENTITY/i.test(text)) throw new UserError('SVG contains script, event handlers, foreignObject or entities; not uploaded.');
}

function snapshotDir(cfg) { return path.join(cfg.dataDir, 'brand-snapshots'); }

export function snapshot(cfg, brand) {
  const dir = snapshotDir(cfg);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${brand.brand_uuid}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(path.join(dir, name), JSON.stringify(brand, null, 2), { mode: 0o600 });
  return name;
}

export function register(reg, cfg) {
  crud(reg, cfg, {
    domain: 'branding', noun: 'brand', base: '/core/brands',
    summary: ['brand_uuid', 'domain', 'default', 'branding_title', 'branding_logo', 'branding_favicon', 'flow_authentication', 'flow_invalidation'],
    hint: 'Updates and deletes save a snapshot of the brand first (see authentik_branding_snapshots_list). branding_custom_css is checked before it is sent.',
    guard: async (kind, data, { api }, a) => {
      if (kind === 'delete') {
        if (data.default) throw new UserError('The default brand is protected and is not deleted by this mod.');
        snapshot(cfg, data);
        return data;
      }
      if (typeof data.branding_custom_css === 'string') validateCss(data.branding_custom_css, cfg);
      if (kind === 'update') snapshot(cfg, await api.get(`/core/brands/${a.id}/`));
      return data;
    },
  });
  reg.add({
    domain: 'branding', name: 'authentik_branding_current',
    description: 'Show the brand that applies to the authentik URL being used.',
    run: (a, { api }) => api.get('/core/brands/current/'),
  });
  reg.add({
    domain: 'branding', name: 'authentik_branding_css_set', mode: 'write',
    description: 'Set a brand\'s custom CSS after checking it (size, forbidden constructs, remote hosts) and saving a snapshot. Pass css "" to clear.',
    input: { id: z.string().describe('Brand uuid.'), css: z.string(), confirm: confirmField },
    run: async (a, { api }) => {
      validateCss(a.css, cfg);
      const current = await api.get(`/core/brands/${a.id}/`);
      if (!a.confirm) return needConfirm(`replace the custom CSS of brand ${current.domain} (${Buffer.byteLength(a.css)} bytes)`, { old_css_bytes: Buffer.byteLength(current.branding_custom_css || '') });
      const saved = snapshot(cfg, current);
      const res = await api.patch(`/core/brands/${a.id}/`, { branding_custom_css: a.css });
      return { ok: true, snapshot: saved, brand: res.brand_uuid };
    },
  });
  reg.add({
    domain: 'branding', name: 'authentik_branding_snapshots_list',
    description: 'List saved brand snapshots, newest first.',
    run: async () => {
      const dir = snapshotDir(cfg);
      const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort().reverse() : [];
      return { directory: dir, snapshots: names };
    },
  });
  reg.add({
    domain: 'branding', name: 'authentik_branding_snapshot_restore', mode: 'destructive',
    description: 'Restore a brand from a snapshot file name returned by authentik_branding_snapshots_list.',
    input: { snapshot: z.string(), confirm: confirmField },
    run: async (a, { api }) => {
      if (a.snapshot !== path.basename(a.snapshot) || !a.snapshot.endsWith('.json')) throw new UserError('snapshot must be a file name from the list.');
      const file = path.join(snapshotDir(cfg), a.snapshot);
      if (!fs.existsSync(file)) throw new UserError('No such snapshot.');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      const { brand_uuid, ...body } = saved;
      if (!a.confirm) return needConfirm(`restore brand ${saved.domain} from ${a.snapshot}`, { domain: saved.domain, title: saved.branding_title });
      const exists = await api.get(`/core/brands/${brand_uuid}/`).then(() => true, (e) => { if (e.status === 404) return false; throw e; });
      return exists ? api.patch(`/core/brands/${brand_uuid}/`, body) : api.post('/core/brands/', body);
    },
  });

  reg.add({
    domain: 'branding', name: 'authentik_branding_files_list',
    description: 'List uploaded media files (logos, icons, backgrounds).',
    input: { search: listInput.search, usage: z.string().optional().describe('Default "media".') },
    run: (a, { api }) => api.get('/admin/file/', { search: a.search, usage: a.usage, manageable_only: true }),
  });
  reg.add({
    domain: 'branding', name: 'authentik_branding_file_upload', mode: 'write',
    description: 'Upload a local image file (png, jpg, gif, webp, svg, ico) as a media file. Then set the brand field (branding_logo, ...) to the returned name.',
    input: { path: z.string().describe('Absolute path of a file on this machine.'), name: z.string().optional().describe('Name in authentik, for example "branding/logo.svg". Defaults to the file name.'), usage: z.string().optional() },
    run: async (a, { api }) => {
      const ext = path.extname(a.path).toLowerCase();
      const type = IMAGE_TYPES[ext];
      if (!type) throw new UserError(`Only ${Object.keys(IMAGE_TYPES).join(', ')} files can be uploaded.`);
      const stat = fs.statSync(a.path);
      if (!stat.isFile()) throw new UserError('path is not a file.');
      if (stat.size > cfg.maxImageMb * 1024 * 1024) throw new UserError(`File is larger than ${cfg.maxImageMb} MB.`);
      const bytes = fs.readFileSync(a.path);
      if (ext === '.svg') checkSvg(bytes.toString('utf8'));
      const form = new FormData();
      form.set('file', new Blob([bytes], { type }), path.basename(a.path));
      form.set('name', a.name ?? path.basename(a.path));
      form.set('usage', a.usage ?? 'media');
      return api.upload('/admin/file/', form);
    },
  });
  reg.add({
    domain: 'branding', name: 'authentik_branding_file_delete', mode: 'destructive',
    description: 'Delete an uploaded media file.',
    input: { name: z.string(), usage: z.string().optional(), confirm: confirmField },
    run: async (a, { api }) => {
      if (!a.confirm) return needConfirm(`delete media file ${a.name}`);
      await api.del('/admin/file/', { name: a.name, usage: a.usage ?? 'media' });
      return { deleted: true };
    },
  });
}
