// Redaction of secrets, the confirm gate for risky calls, and the audit log.
import fs from 'node:fs';
import path from 'node:path';

const SECRET_KEY = /(^|_)(secret|password|passwd|private_key|key_data|client_secret|bind_password|token_key|jwks|webhook_ca)$|^(key|token|password_hash)$/i;

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'avatar' && typeof v === 'string' && v.startsWith('data:')) { out[k] = '(inline image omitted)'; continue; }
      out[k] = SECRET_KEY.test(k) && v !== null && v !== '' && v !== undefined ? '***redacted***' : redact(v);
    }
    return out;
  }
  return value;
}

// A risky call without confirm:true is answered with this and changes nothing.
export function needConfirm(what, preview) {
  return {
    dry_run: true,
    changed: false,
    would: what,
    ...(preview === undefined ? {} : { preview }),
    next: 'Show this to the user. If they agree, call the same tool again with confirm: true.',
  };
}

export function makeAudit(dataDir) {
  const file = path.join(dataDir, 'audit.log');
  let ready = false;
  return function audit(entry) {
    const line = JSON.stringify({ type: 'audit', timestamp: new Date().toISOString(), ...entry });
    process.stderr.write(line + '\n');
    try {
      if (!ready) { fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 }); ready = true; }
      fs.appendFileSync(file, line + '\n', { mode: 0o600 });
    } catch { /* the stderr copy is enough; a full disk must not break a tool call */ }
  };
}
