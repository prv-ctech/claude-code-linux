// Thin fetch wrapper around the authentik REST API (/api/v3).
import { redact } from './safety.mjs';

export class AuthentikError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const HINTS = {
  401: 'The token is missing, expired or not an API token (intent must be API, not app password).',
  403: 'The token is valid but its role lacks the permission. See the README for the role this mod needs.',
  404: 'Not found. Check the id or slug.',
};

export function makeClient(cfg) {
  async function request(method, apiPath, { query, body, form, raw } = {}) {
    // Last line of defence behind seg(): a path must stay inside /api/v3.
    if (/(^|\/)(\.|\.\.|%2e|%2e%2e)(\/|$)|[?#\\]/i.test(apiPath)) throw new AuthentikError(`Refusing path ${apiPath.slice(0, 80)}`);
    const url = new URL(`${cfg.url}/api/v3${apiPath}`);
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
      else url.searchParams.set(k, String(v));
    }
    const headers = { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json', 'User-Agent': 'authentik-mod' };
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    let res;
    try {
      res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(cfg.timeoutMs), redirect: 'error' });
    } catch (e) {
      const why = e.name === 'TimeoutError' ? `timed out after ${cfg.timeoutMs} ms` : e.cause?.code || e.message;
      throw new AuthentikError(`Cannot reach authentik at ${cfg.url}: ${why}`);
    }
    const text = await res.text();
    if (raw && res.ok) return text;
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const detail = data && typeof data === 'object' ? JSON.stringify(redact(data)) : String(data || '').slice(0, 300);
      const dead = /Token invalid/i.test(detail) ? ' The token itself is invalid or was deleted; create a new API token.' : '';
      throw new AuthentikError(`authentik ${method} ${apiPath} failed with ${res.status}: ${detail}${dead || (HINTS[res.status] ? ` ${HINTS[res.status]}` : '')}`, { status: res.status, body: data });
    }
    if (typeof data === 'string' && data.trim()) {
      throw new AuthentikError(`authentik ${method} ${apiPath} answered ${res.status} with ${res.headers.get('content-type') || 'no content type'} instead of JSON. A proxy or login page may sit in front of the API.`, { status: res.status });
    }
    return data;
  }
  return {
    get: (p, query) => request('GET', p, { query }),
    post: (p, body, query) => request('POST', p, { body, query }),
    put: (p, body) => request('PUT', p, { body }),
    patch: (p, body) => request('PATCH', p, { body }),
    del: (p, query) => request('DELETE', p, { query }),
    text: (p, query) => request('GET', p, { query, raw: true }),
    upload: (p, form) => request('POST', p, { form }),
    request,
  };
}
