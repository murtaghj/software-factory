// The pod-facing wire contract between the runner's listener and a supervisor (W-019, P-27). Pure: no I/O, no dependency.
// Parsers accept a plain object's own keys only and refuse any key that is not listed, `__proto__` and `constructor` included.

export const ROUTES = { acquire: '/pod/v1/permit/acquire', renew: '/pod/v1/permit/renew', stopAck: '/pod/v1/stop-ack' } as const;
export type RouteName = keyof typeof ROUTES;

// The caps (bytes).
export const BODY_MAX_BYTES = 16 * 1024;
export const TOKEN_MAX_BYTES = 8 * 1024;
export const REPORT_MAX_BYTES = 1024;

export type PermitDenialCode =
  | 'invalid_request' | 'unauthenticated' | 'throttled' | 'review_unavailable'
  | 'not_this_job' | 'duplicate_writer' | 'no_receipt' | 'stale_epoch' | 'not_ready' | 'not_startable' | 'not_renewable';
export const DENIAL_CODES: readonly PermitDenialCode[] = [
  'invalid_request', 'unauthenticated', 'throttled', 'review_unavailable',
  'not_this_job', 'duplicate_writer', 'no_receipt', 'stale_epoch', 'not_ready', 'not_startable', 'not_renewable',
];

// What the cluster says about the harness container of the pod the call was read against. The cluster's statement, never the pod's.
export type HarnessState = { state: 'waiting' | 'running' | 'terminated' | 'unknown'; exitCode?: number };

export type AcquireRequest = { orgId: string; allocationId: string; epoch: number; report?: string };
export type RenewRequest = { orgId: string; allocationId: string; epoch: number };
export type StopAckRequest = { orgId: string; allocationId: string; epoch: number };

export type PermitGrantAnswer = {
  granted: true; allocationId: string; generation: number; epoch: number; podUid: string; leaseSeconds: number; beatSeconds: number; harness?: HarnessState;
};
export type PermitDenialAnswer = { granted: false; code: PermitDenialCode; retryable: boolean; reason?: string };
export type PermitAnswer = PermitGrantAnswer | PermitDenialAnswer;
export type StopAckAnswer = { acknowledged: true } | PermitDenialAnswer;

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const p: unknown = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};
// Own, enumerable keys only; every key must be allowed. JSON.parse makes `__proto__` an own key, and it is refused here like any other.
function keysOk(o: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) return `unknown key ${k.slice(0, 32)}`;
  return undefined;
}
function ids(o: Record<string, unknown>): string | undefined {
  if (typeof o['orgId'] !== 'string' || !UUID.test(o['orgId'])) return 'orgId';
  if (typeof o['allocationId'] !== 'string' || !UUID.test(o['allocationId'])) return 'allocationId';
  const e = o['epoch'];
  if (typeof e !== 'number' || !Number.isSafeInteger(e) || e < 1) return 'epoch';
  return undefined;
}

export function parseAcquireRequest(v: unknown): Parsed<AcquireRequest> {
  if (!isPlain(v)) return { ok: false, reason: 'not an object' };
  const k = keysOk(v, ['orgId', 'allocationId', 'epoch', 'report']);
  if (k) return { ok: false, reason: k };
  const bad = ids(v);
  if (bad) return { ok: false, reason: bad };
  const report = v['report'];
  if (report !== undefined && (typeof report !== 'string' || Buffer.byteLength(report) > REPORT_MAX_BYTES)) return { ok: false, reason: 'report' };
  return { ok: true, value: { orgId: v['orgId'] as string, allocationId: v['allocationId'] as string, epoch: v['epoch'] as number, ...(report === undefined ? {} : { report }) } };
}
function parseBare(v: unknown): Parsed<RenewRequest> {
  if (!isPlain(v)) return { ok: false, reason: 'not an object' };
  const k = keysOk(v, ['orgId', 'allocationId', 'epoch']);
  if (k) return { ok: false, reason: k };
  const bad = ids(v);
  if (bad) return { ok: false, reason: bad };
  return { ok: true, value: { orgId: v['orgId'] as string, allocationId: v['allocationId'] as string, epoch: v['epoch'] as number } };
}
export const parseRenewRequest = (v: unknown): Parsed<RenewRequest> => parseBare(v);
export const parseStopAckRequest = (v: unknown): Parsed<StopAckRequest> => parseBare(v);

// The supervisor's side: an answer from the runner, parsed with the same strictness.
export function parsePermitAnswer(v: unknown): Parsed<PermitAnswer> {
  if (!isPlain(v)) return { ok: false, reason: 'not an object' };
  if (v['granted'] === true) {
    const k = keysOk(v, ['granted', 'allocationId', 'generation', 'epoch', 'podUid', 'leaseSeconds', 'beatSeconds', 'harness']);
    if (k) return { ok: false, reason: k };
    for (const f of ['generation', 'epoch', 'leaseSeconds', 'beatSeconds'] as const) if (typeof v[f] !== 'number' || !Number.isSafeInteger(v[f]) || v[f] < 1) return { ok: false, reason: f };
    if (typeof v['allocationId'] !== 'string' || !UUID.test(v['allocationId'])) return { ok: false, reason: 'allocationId' };
    if (typeof v['podUid'] !== 'string' || v['podUid'] === '' || v['podUid'].length > 128) return { ok: false, reason: 'podUid' };
    let harness: HarnessState | undefined;
    if (v['harness'] !== undefined) {
      const h = v['harness'];
      if (!isPlain(h) || keysOk(h, ['state', 'exitCode']) !== undefined || !['waiting', 'running', 'terminated', 'unknown'].includes(h['state'] as string)) return { ok: false, reason: 'harness' };
      if (h['exitCode'] !== undefined && (typeof h['exitCode'] !== 'number' || !Number.isSafeInteger(h['exitCode']))) return { ok: false, reason: 'harness' };
      harness = { state: h['state'] as HarnessState['state'], ...(h['exitCode'] === undefined ? {} : { exitCode: h['exitCode'] }) };
    }
    return { ok: true, value: { granted: true, allocationId: v['allocationId'], generation: v['generation'] as number, epoch: v['epoch'] as number, podUid: v['podUid'],
      leaseSeconds: v['leaseSeconds'] as number, beatSeconds: v['beatSeconds'] as number, ...(harness ? { harness } : {}) } };
  }
  if (v['granted'] === false) {
    const k = keysOk(v, ['granted', 'code', 'retryable', 'reason']);
    if (k) return { ok: false, reason: k };
    if (typeof v['code'] !== 'string' || !DENIAL_CODES.includes(v['code'] as PermitDenialCode)) return { ok: false, reason: 'code' };
    if (typeof v['retryable'] !== 'boolean') return { ok: false, reason: 'retryable' };
    if (v['reason'] !== undefined && (typeof v['reason'] !== 'string' || v['reason'].length > 256)) return { ok: false, reason: 'reason' };
    return { ok: true, value: { granted: false, code: v['code'] as PermitDenialCode, retryable: v['retryable'], ...(v['reason'] === undefined ? {} : { reason: v['reason'] }) } };
  }
  return { ok: false, reason: 'granted' };
}
export function parseStopAckAnswer(v: unknown): Parsed<StopAckAnswer> {
  if (isPlain(v) && v['acknowledged'] === true) {
    return keysOk(v, ['acknowledged']) === undefined ? { ok: true, value: { acknowledged: true } } : { ok: false, reason: 'unknown key' };
  }
  const r = parsePermitAnswer(v);
  return r.ok && !r.value.granted ? { ok: true, value: r.value } : { ok: false, reason: 'answer' };
}

// The status is a hint; the body is the answer. 200 granted; 400 invalid_request; 401 unauthenticated; 429 throttled; 503 review_unavailable; 409 every other denial.
export function statusOf(a: PermitAnswer | StopAckAnswer): number {
  if ('acknowledged' in a || a.granted) return 200;
  switch (a.code) {
    case 'invalid_request': return 400;
    case 'unauthenticated': return 401;
    case 'throttled': return 429;
    case 'review_unavailable': return 503;
    default: return 409;
  }
}
