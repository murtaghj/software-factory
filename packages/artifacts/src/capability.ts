// Short-lived, HMAC-signed capabilities for upload and download. A capability names exactly one
// upload or artifact registration and expires; it carries no reusable credential.
import { createHmac, timingSafeEqual } from 'node:crypto';

export type UploadCapability = { kind: 'upload'; orgId: string; uploadId: string; temporaryKey: string; maxBytes: number; expiresAt: number };
export type DownloadCapability = { kind: 'download'; orgId: string; artifactId: string; storageKey: string; sha256: string; sizeBytes: number; mediaType: string; disposition: 'attachment' | 'isolated_preview'; expiresAt: number };
export type Capability = UploadCapability | DownloadCapability;

export class CapabilitySigner {
  private readonly key: Buffer;
  constructor(key: Buffer) {
    if (key.length < 32) throw new Error('capability signing key must be at least 32 bytes');
    this.key = key;
  }

  sign(c: Capability): string {
    const body = Buffer.from(JSON.stringify(c)).toString('base64url');
    return `${body}.${createHmac('sha256', this.key).update(body).digest('base64url')}`;
  }

  verify<K extends Capability['kind']>(token: string, kind: K, nowMs: number): Extract<Capability, { kind: K }> | undefined {
    const [body, mac, extra] = token.split('.');
    if (!body || !mac || extra !== undefined) return undefined;
    const expected = createHmac('sha256', this.key).update(body).digest();
    const given = Buffer.from(mac, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    let c: Capability;
    try { c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Capability; } catch { return undefined; }
    if (c.kind !== kind || !(nowMs < c.expiresAt)) return undefined;
    return c as Extract<Capability, { kind: K }>;
  }
}
