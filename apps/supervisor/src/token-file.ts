// The only places outside the workspace view that read a file: the projected token (every call, never kept: the kubelet rotates it) and the CA (once, at boot).
import { X509Certificate, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const readToken = (path: string): string => readFileSync(path, 'utf8').trim();
export function readCa(path: string, expectedSha256: string): Buffer {
  const bytes = readFileSync(path);
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new Error('the CA file is not the one the arguments name (digest)');
  // Exactly one X.509 certificate, and a CA: an empty file (whose digest anyone can compute) would make Node fall back to the public roots, and a leaf or a bundle is not what the
  // arguments pin. The digest says WHICH file; this says it is a CA certificate at all.
  const text = bytes.toString('utf8');
  if ((text.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1 || (text.match(/-----END CERTIFICATE-----/g) ?? []).length !== 1) throw new Error('the CA file must hold exactly one certificate');
  let cert: X509Certificate;
  try { cert = new X509Certificate(bytes); } catch { throw new Error('the CA file is not a valid X.509 certificate'); }
  if (!cert.ca) throw new Error('the CA file is not a CA certificate');
  return bytes;
}
