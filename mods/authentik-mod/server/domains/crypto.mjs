import { z } from 'zod';
import { crud, idField, confirmField } from '../registry.mjs';
import { needConfirm } from '../safety.mjs';

export function register(reg, cfg) {
  crud(reg, cfg, {
    domain: 'crypto', noun: 'keypair', base: '/crypto/certificatekeypairs',
    summary: ['pk', 'name', 'fingerprint_sha256', 'cert_expiry', 'cert_subject', 'private_key_available', 'key_type', 'managed'],
    hint: 'To upload, data needs name and certificate_data (PEM), and key_data (PEM) if there is a private key.',
  });
  reg.add({
    domain: 'crypto', name: 'authentik_crypto_keypair_generate', mode: 'write',
    description: 'Generate a self-signed certificate and private key.',
    input: {
      common_name: z.string().min(1),
      validity_days: z.number().int().min(1).max(3650),
      subject_alt_name: z.string().optional().describe('Comma-separated DNS names or IPs.'),
      alg: z.enum(['rsa', 'ecdsa', 'ed25519', 'ed448']).optional(),
    },
    run: (a, { api }) => api.post('/crypto/certificatekeypairs/generate/', a),
  });
  reg.add({
    domain: 'crypto', name: 'authentik_crypto_keypair_view_certificate', reveal: true,
    description: 'Get the certificate (PEM, public) of a keypair.',
    input: { id: idField },
    run: (a, { api }) => api.get(`/crypto/certificatekeypairs/${a.id}/view_certificate/`),
  });
  reg.add({
    domain: 'crypto', name: 'authentik_crypto_keypair_view_private_key', mode: 'destructive', reveal: true,
    description: 'Get the PRIVATE KEY of a keypair. It lands in the chat transcript; only do this when really needed.',
    input: { id: idField, confirm: confirmField },
    run: async (a, { api }) => {
      if (!a.confirm) return needConfirm(`reveal the private key of keypair ${a.id}`);
      return api.get(`/crypto/certificatekeypairs/${a.id}/view_private_key/`);
    },
  });
}
