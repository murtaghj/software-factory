// Local verification of a pod's service-account token, done before the shared TokenReview budget is spent
// (S1): the signature against the cluster's own JWKS, `exp`, the exact audience, the subject and the pod-binding
// claims. A token that passes here is only a candidate: TokenReview and the pod read both stay mandatory.
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { KubeError, type Jwk, type KubeApi } from './kube/api.ts';

const MAX_PART_BYTES = 4096;
const B64URL = /^[A-Za-z0-9_-]+$/;
const JWKS_TTL_MS = 5 * 60_000;           // keys are refreshed once they are this old
const JWKS_STALE_OK_MS = 60 * 60_000;     // last-known-good keys are served this long when a refresh fails (TokenReview stays mandatory)
const JWKS_MIN_REFETCH_MS = 30_000;       // an unknown key id triggers a refetch at most this often
const JWKS_FAIL_BACKOFF_MS = 5_000;       // after a failed fetch, no new fetch for this long
const CLOCK_SKEW_SECONDS = 60;            // the same allowance for exp and nbf
const NAME_CAP = 253;
const UID_CAP = 128;

export type LocalReason = 'malformed_token' | 'unsupported_alg' | 'unknown_key' | 'bad_signature' | 'expired' | 'audience_mismatch' | 'wrong_subject' | 'wrong_binding';
export type LocalResult = { ok: true; podName: string; podUid: string } | { ok: false; reason: LocalReason };
export type Expected = { audience: string; subject: string; namespace: string; serviceAccount: string };

type CachedKey = { key: KeyObject; alg: string | undefined; type: string | undefined; curve: string | undefined };

// The cluster's signing keys, cached. One fetch in flight at a time shared by every caller (single-flight); a fetch
// that failed is not retried for 5 s; an unknown key id refetches at most once per 30 s; and when a refresh fails the
// last-known-good keys keep being served for up to an hour. All of this is reachable without authentication, so none of
// it may fan out to the cluster.
export class JwksCache {
  readonly #kube: Pick<KubeApi, 'getServiceAccountJwks'>;
  readonly #now: () => number;
  #keys = new Map<string, CachedKey>();
  #fetchedAt: number | undefined;
  #attemptedAt: number | undefined;
  #failedAt: number | undefined;
  #inflight: Promise<void> | undefined;
  constructor(kube: Pick<KubeApi, 'getServiceAccountJwks'>, nowMs: () => number) { this.#kube = kube; this.#now = nowMs; }

  // The key for `kid`, or undefined when the cluster's key set (as far as it could be read) has none. Throws a KubeError
  // when there is no usable key set at all (first fetch failed or the last good one is too old).
  async key(kid: string): Promise<CachedKey | undefined> {
    const now = this.#now();
    const age = this.#fetchedAt === undefined ? Number.POSITIVE_INFINITY : now - this.#fetchedAt;
    const known = this.#keys.has(kid);
    const wantRefresh = age > JWKS_TTL_MS || (!known && (this.#attemptedAt === undefined || now - this.#attemptedAt >= JWKS_MIN_REFETCH_MS));
    const backingOff = this.#failedAt !== undefined && now - this.#failedAt < JWKS_FAIL_BACKOFF_MS;
    if (wantRefresh) {
      if (this.#inflight) await this.#inflight.catch(() => undefined);
      else if (!backingOff) {
        this.#attemptedAt = now;
        this.#inflight = this.#refresh(now).then(() => { this.#failedAt = undefined; }, (e: unknown) => { this.#failedAt = now; throw e; }).finally(() => { this.#inflight = undefined; });
        try { await this.#inflight; } catch (e) { if (age > JWKS_STALE_OK_MS) throw e; /* otherwise serve what we last had */ }
      } else if (age > JWKS_STALE_OK_MS) throw new KubeError(0, 'Timeout', 'the cluster\'s key set is unavailable');
    }
    if (this.#fetchedAt === undefined || now - this.#fetchedAt > JWKS_STALE_OK_MS) throw new KubeError(0, 'Timeout', 'the cluster\'s key set is unavailable');
    return this.#keys.get(kid);
  }
  async #refresh(now: number): Promise<void> {
    const jwks = await this.#kube.getServiceAccountJwks();
    const next = new Map<string, CachedKey>();
    const list: unknown[] = Array.isArray(jwks.keys) ? jwks.keys : [];
    for (const jwk of list.slice(0, 32)) {
      if (typeof jwk !== 'object' || jwk === null || Array.isArray(jwk)) continue; // a null or non-object entry is no key
      const j = jwk as Jwk;
      if (typeof j.kid !== 'string') continue;
      try {
        const key = createPublicKey({ key: j, format: 'jwk' });
        next.set(j.kid, { key, alg: typeof j.alg === 'string' ? j.alg : undefined, type: key.asymmetricKeyType, curve: key.asymmetricKeyDetails?.namedCurve });
      } catch { /* an unusable key is no key */ }
    }
    this.#keys = next;
    this.#fetchedAt = now;
  }
}

const decode = (part: string): unknown => {
  if (part === '' || part.length > MAX_PART_BYTES || !B64URL.test(part)) throw new Error('part');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
};
const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

export async function verifyTokenLocally(token: string, want: Expected, keys: JwksCache, nowSeconds: number): Promise<LocalResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed_token' };
  const [h, p, sigPart] = parts as [string, string, string];
  let header: Record<string, unknown> | undefined;
  let claims: Record<string, unknown> | undefined;
  try { header = obj(decode(h)); claims = obj(decode(p)); } catch { return { ok: false, reason: 'malformed_token' }; }
  if (!header || !claims || sigPart === '' || sigPart.length > MAX_PART_BYTES || !B64URL.test(sigPart)) return { ok: false, reason: 'malformed_token' };
  const alg = header['alg'];
  if (alg !== 'ES256' && alg !== 'RS256') return { ok: false, reason: 'unsupported_alg' };
  const kid = header['kid'];
  if (typeof kid !== 'string' || kid === '' || kid.length > 256) return { ok: false, reason: 'unknown_key' };
  const found = await keys.key(kid);
  if (!found) return { ok: false, reason: 'unknown_key' };
  // The key's type is bound to the algorithm: RS256 needs an RSA key, ES256 an EC P-256 key (never the other way round).
  if ((found.alg !== undefined && found.alg !== alg) || (alg === 'RS256' ? found.type !== 'rsa' : found.type !== 'ec' || found.curve !== 'prime256v1')) return { ok: false, reason: 'unsupported_alg' };
  const data = Buffer.from(`${h}.${p}`);
  const sig = Buffer.from(sigPart, 'base64url');
  let valid: boolean;
  try { valid = alg === 'ES256' ? verify('sha256', data, { key: found.key, dsaEncoding: 'ieee-p1363' }, sig) : verify('sha256', data, found.key, sig); } catch { valid = false; }
  if (!valid) return { ok: false, reason: 'bad_signature' };
  const exp = claims['exp'];
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp + CLOCK_SKEW_SECONDS <= nowSeconds) return { ok: false, reason: 'expired' };
  const nbf = claims['nbf'];
  if (nbf !== undefined && (typeof nbf !== 'number' || nbf > nowSeconds + CLOCK_SKEW_SECONDS)) return { ok: false, reason: 'expired' };
  const aud = claims['aud'];
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(want.audience)) return { ok: false, reason: 'audience_mismatch' };
  if (claims['sub'] !== want.subject) return { ok: false, reason: 'wrong_subject' };
  const k8s = obj(claims['kubernetes.io']);
  const pod = obj(k8s?.['pod']);
  const sa = obj(k8s?.['serviceaccount']);
  if (!k8s || k8s['namespace'] !== want.namespace || sa?.['name'] !== want.serviceAccount) return { ok: false, reason: 'wrong_subject' };
  const name = pod?.['name']; const uid = pod?.['uid'];
  if (typeof name !== 'string' || name === '' || name.length > NAME_CAP || typeof uid !== 'string' || uid === '' || uid.length > UID_CAP) return { ok: false, reason: 'wrong_binding' };
  return { ok: true, podName: name, podUid: uid };
}
