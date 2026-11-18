// The wire contract (W-019): every committed vector parses as expected, and each refusal has its accepted control.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BODY_MAX_BYTES, REPORT_MAX_BYTES, ROUTES, SUPERVISOR_EXIT, TOKEN_MAX_BYTES,
  parseAcquireRequest, parsePermitAnswer, parseRenewRequest, parseStopAckAnswer, parseStopAckRequest, statusOf,
} from '../src/index.ts';
import type { PermitDenialCode } from '../src/index.ts';

type Vector = { name: string; parser: 'acquire' | 'renew' | 'stopAck' | 'answer' | 'stopAnswer'; input: unknown; ok: boolean };
const vectors = (JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8')) as { vectors: Vector[] }).vectors;
const parsers = { acquire: parseAcquireRequest, renew: parseRenewRequest, stopAck: parseStopAckRequest, answer: parsePermitAnswer, stopAnswer: parseStopAckAnswer };
const ORG = '11111111-1111-4111-8111-111111111111';
const ALLOC = '22222222-2222-4222-8222-222222222222';
const good = { orgId: ORG, allocationId: ALLOC, epoch: 1 };

describe('the pod-facing wire contract', () => {
  for (const v of vectors) {
    it(`vector: ${v.name}`, () => { expect(parsers[v.parser](v.input).ok).toBe(v.ok); });
  }

  it('the vector file itself parses: the accepted vectors outnumber nothing and refused ones are not all of them (control)', () => {
    expect(vectors.filter((v) => v.ok).length).toBeGreaterThanOrEqual(7);
    expect(vectors.filter((v) => !v.ok).length).toBeGreaterThanOrEqual(5);
  });

  it('round trip: a parsed request is the request, and a parsed answer is the answer', () => {
    const r = parseAcquireRequest({ ...good, report: '{"gate":"passed"}' });
    expect(r).toEqual({ ok: true, value: { ...good, report: '{"gate":"passed"}' } });
    const a = { granted: true, allocationId: ALLOC, generation: 2, epoch: 3, podUid: 'p', leaseSeconds: 60, beatSeconds: 10, harness: { state: 'terminated', exitCode: 3 } };
    expect(parsePermitAnswer(JSON.parse(JSON.stringify(a)))).toEqual({ ok: true, value: a });
  });

  it('refuses an unknown key, __proto__, constructor, an oversized report, a non-integer epoch and a bad id; the same request without them is accepted', () => {
    expect(parseRenewRequest(good).ok).toBe(true);
    expect(parseRenewRequest({ ...good, extra: 1 }).ok).toBe(false);
    expect(parseRenewRequest(JSON.parse(`{"orgId":"${ORG}","allocationId":"${ALLOC}","epoch":1,"__proto__":{"x":1}}`)).ok).toBe(false);
    expect(parseRenewRequest({ ...good, constructor: 'x' }).ok).toBe(false);
    expect(parseAcquireRequest({ ...good, report: 'x'.repeat(REPORT_MAX_BYTES) }).ok).toBe(true);
    expect(parseAcquireRequest({ ...good, report: 'x'.repeat(REPORT_MAX_BYTES + 1) }).ok).toBe(false);
    expect(parseRenewRequest({ ...good, epoch: 1.5 }).ok).toBe(false);
    expect(parseRenewRequest({ ...good, epoch: 0 }).ok).toBe(false);
    expect(parseRenewRequest({ ...good, orgId: 'nope' }).ok).toBe(false);
    expect(parseRenewRequest([good]).ok).toBe(false);
    expect(parseRenewRequest(Object.create({ inherited: 1 })).ok).toBe(false); // not a plain object
  });

  it('the caps are the ones of the brief, and the status mapping is a hint over a typed answer', () => {
    expect([BODY_MAX_BYTES, TOKEN_MAX_BYTES, REPORT_MAX_BYTES]).toEqual([16384, 8192, 1024]);
    expect(Object.values(ROUTES)).toEqual(['/pod/v1/permit/acquire', '/pod/v1/permit/renew', '/pod/v1/stop-ack']);
    const den = (code: PermitDenialCode) => statusOf({ granted: false, code, retryable: false });
    expect([den('invalid_request'), den('unauthenticated'), den('throttled'), den('review_unavailable'), den('duplicate_writer'), den('not_renewable')]).toEqual([400, 401, 429, 503, 409, 409]);
    expect(statusOf({ acknowledged: true })).toBe(200);
    expect(statusOf({ granted: true, allocationId: ALLOC, generation: 1, epoch: 1, podUid: 'p', leaseSeconds: 60, beatSeconds: 10 })).toBe(200);
  });

  it('the exit-code table has no duplicate', () => {
    const codes = Object.values(SUPERVISOR_EXIT);
    expect(new Set(codes).size).toBe(codes.length);
    expect(SUPERVISOR_EXIT).toMatchObject({ ok: 0, bad_arguments: 64, duplicate_writer: 65, denied: 66, gate_failed: 68, workspace_unreadable: 69, fenced: 70, terminated: 143 });
  });
});
