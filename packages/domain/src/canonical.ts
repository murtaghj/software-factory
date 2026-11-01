// RFC 8785-compatible canonical JSON and SHA-256 (chapter 02: "use RFC 8785-compatible JSON
// canonicalization"). Pure and deterministic, so workflow code can hash bindings too.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON cannot encode non-finite numbers');
    return JSON.stringify(value); // ES number serialization, as RFC 8785 requires
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    // RFC 8785 orders keys by UTF-16 code units, which is JavaScript's default string ordering.
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
}

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
