// Configuration that fails closed (W-019, review M1, L4, L5): the review ceiling, the buckets' inputs, the listener's key and address, and the test switches.
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildConfig, createConfig, isUnspecified, reviewRateForWriters } from '../src/config.ts';
import { BucketTable, TokenBucket } from '../src/listener/buckets.ts';
import { createTestConfig } from '../src/testing.ts';
import { makePki, type Pki } from './listener-kit.ts';

let pki: Pki;
let other: Pki;
beforeAll(() => { pki = makePki(); other = makePki(); });
afterAll(() => { pki.cleanup(); other.cleanup(); });

const d = `sha256:${'a'.repeat(64)}`;
const prod = (): Parameters<typeof createConfig>[0] => ({ runnerIdentity: 'r', controlPlaneIdentities: ['c'], identityOrgs: { c: '00000000-0000-4000-8000-000000000001' }, images: { supervisor: `s@${d}`, harness: `h@${d}`, materializer: `m@${d}` }, networkGate: { mode: 'disabled', denyTargets: [] } });
const listener = (host: string, cert = pki.cert, key = pki.key) => ({ ...prod(), podListener: { host, port: 1, cert, key } });

describe('W-019 the review ceiling and the buckets', () => {
  it('outside the test configuration the ceiling must be a safe integer of at least 20: undefined, null, NaN, a string, 0, a negative and 19 are each refused; the default and 20 pass', () => {
    for (const bad of [undefined, null, Number.NaN, '200', 0, -5, 19, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() => createConfig({ ...prod(), review: { ceilingPerSecond: bad as number } }), String(bad)).toThrow(/ceilingPerSecond/);
    }
    expect(createConfig(prod()).review.ceilingPerSecond).toBe(200);
    expect(createConfig({ ...prod(), review: { ceilingPerSecond: 20 } }).review.ceilingPerSecond).toBe(20);
    expect(createConfig({ ...prod(), review: { ceilingPerSecond: 20 } }).review.perSecond).toBeGreaterThanOrEqual(20);
  });

  it('the node-read grace may not exceed the stop deadline (review round 2); control: equal to it is accepted', () => {
    expect(() => createConfig({ ...prod(), stopDeadlineSeconds: 180, nodeReadGraceSeconds: 181 })).toThrow(/nodeReadGraceSeconds/);
    expect(createConfig({ ...prod(), stopDeadlineSeconds: 180, nodeReadGraceSeconds: 180 }).nodeReadGraceSeconds).toBe(180);
    expect(createConfig(prod()).nodeReadGraceSeconds).toBe(60);
  });

  it('sizing has no off switch: with the ceiling unset (the test configuration only) the rate still follows the writers, up to infinity', () => {
    const c = createTestConfig({ runnerIdentity: 'r', controlPlaneIdentities: ['c'] });
    expect(c.review.ceilingPerSecond).toBeUndefined();
    expect(reviewRateForWriters(c, 100)).toMatchObject({ perSecond: 100, ceilingBound: false });
    expect(reviewRateForWriters(c, 2).perSecond).toBe(20);
  });

  it('a token bucket and a bucket table refuse a rate or a burst that is undefined, null, NaN, a string, zero or negative; control: a sane one works', () => {
    for (const bad of [undefined, null, Number.NaN, '5', 0, -1, Number.POSITIVE_INFINITY]) {
      expect(() => new TokenBucket(bad as number, 5, 0), `rate ${String(bad)}`).toThrow(RangeError);
      expect(() => new TokenBucket(5, bad as number, 0), `burst ${String(bad)}`).toThrow(RangeError);
      expect(() => new BucketTable(4, bad as number, 5), `table rate ${String(bad)}`).toThrow(RangeError);
    }
    const b = new TokenBucket(1, 2, 0);
    expect([b.take(0), b.take(0), b.take(0)]).toEqual([true, true, false]);
  });

  it('resize carries the tokens over and clamps them to the new burst; it is not a refill', () => {
    const b = new TokenBucket(10, 40, 0);
    for (let i = 0; i < 40; i += 1) expect(b.take(0)).toBe(true);
    b.resize(10, 40, 0);
    expect(b.take(0)).toBe(false); // still empty
    b.resize(10, 80, 0);
    expect(b.take(0)).toBe(false); // a bigger burst does not hand out tokens
    expect(b.take(1000)).toBe(true); // time does
    const full = new TokenBucket(10, 40, 0);
    full.resize(10, 5, 0);
    const taken = Array.from({ length: 10 }, () => full.take(0)).filter(Boolean).length;
    expect(taken).toBe(5); // clamped to the new burst
    expect(() => { b.resize(Number.NaN, 5, 0); }).toThrow(RangeError);
  });
});

describe('W-019 the listener\'s key, address and the test switches', () => {
  it('the key must be ECDSA P-256, and the certificate and key must be a pair; control: the pair is accepted', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    expect(() => createConfig(listener('127.0.0.1', pki.cert, rsa))).toThrow(/ECDSA P-256/);
    expect(() => createConfig(listener('127.0.0.1', pki.cert, p384))).toThrow(/ECDSA P-256/);
    expect(() => createConfig(listener('127.0.0.1', pki.cert, other.key))).toThrow(/do not match/); // another pair's key
    expect(() => createConfig(listener('127.0.0.1', 'garbage', pki.key))).toThrow(/unusable|match/);
    expect(createConfig(listener('127.0.0.1')).podListener?.host).toBe('127.0.0.1');
  });

  it('one named address: every spelling of the unspecified address, and a hostname, are refused; control: literal addresses are accepted', () => {
    for (const host of ['0.0.0.0', '0', '0.0.0', '::', '::0', '[::]', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0', '', 'localhost', 'listener.example.test']) {
      expect(() => createConfig(listener(host)), host).toThrow(/named address/);
    }
    for (const host of ['127.0.0.1', '10.0.0.5', '::1']) expect(() => createConfig(listener(host)), host).not.toThrow();
    expect([isUnspecified('0.0.0.0'), isUnspecified('::0'), isUnspecified('[::]'), isUnspecified('127.0.0.1'), isUnspecified('::1')]).toEqual([true, true, true, false, false]);
  });

  it('buildConfig refuses `test` unless the test flag is set; a built configuration is frozen, so a `test` key cannot be added or a limit changed afterwards', () => {
    expect(() => buildConfig({ runnerIdentity: 'r', controlPlaneIdentities: ['c'], test: { plaintext: true } }, false)).toThrow(/test switches/);
    expect(buildConfig({ runnerIdentity: 'r', controlPlaneIdentities: ['c'], test: { plaintext: true } }, true).test?.plaintext).toBe(true); // control
    const c = createConfig(prod());
    expect(Object.isFrozen(c)).toBe(true);
    expect(() => { (c as unknown as { test: unknown }).test = { plaintext: true }; }).toThrow(TypeError);
    expect(() => { (c as unknown as { leaseSeconds: number }).leaseSeconds = 1; }).toThrow(TypeError);
    expect(() => { Object.assign(createTestConfig({ runnerIdentity: 'r', controlPlaneIdentities: ['c'] }), { test: { plaintext: true } }); }).toThrow(TypeError);
  });
});
