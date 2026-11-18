// The cluster's service-account key set: fetched once at a time, never in a storm, served from the last good copy when the
// cluster cannot be reached, and re-read when a key id it has not seen arrives. All of it is reachable without authentication.
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KubeError, tokenAudience } from '../src/index.ts';
import { JwksCache } from '../src/token.ts';
import { createEnv, hex, type Env, type Instance } from './harness.ts';

let e: Env;
beforeAll(async () => { e = await createEnv('w017_jwks'); });
afterAll(async () => { await e.close(); });

const req = (token: string, allocationId: string) => ({ token, orgId: e.a.orgId, allocationId, epoch: 1 });
const jwksCalls = (inst: Instance): number => inst.kube.calls.filter((c) => c.startsWith('getServiceAccountJwks')).length;
async function started(inst: Instance) {
  const s = await e.newStage(e.a);
  await inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s), hex('e'));
  const a = (await e.allocations(e.a, s))[0] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
  const pod = inst.kube.driver.podsOf(a.jobName)[0] as NonNullable<ReturnType<typeof inst.kube.driver.podsOf>[number]>;
  inst.kube.driver.startPod(pod.metadata.name);
  return { a, pod, aud: tokenAudience(e.a.orgId, a.id) };
}
const tick = (state: { now: number }) => (): number => state.now;

describe('W-017 service-account key set', () => {
  it('a burst of tokens during a key-set outage makes a bounded number of fetches, and every answer is the retryable review_unavailable (never remembered)', async () => {
    const clock = { now: 0 };
    const inst = e.newRunner({ nowMs: tick(clock) });
    const x = await started(inst);
    inst.kube.failNext('getServiceAccountJwks', new KubeError(0, 'Timeout', 'the API server is down'), 1);
    const good = inst.kube.mintToken(x.pod, x.aud);
    // 300 tokens, each a different one, all well-formed; none has any key to be checked against.
    const results = await Promise.all(Array.from({ length: 300 }, (_, i) => inst.runner.acquireStartPermit(req(i === 0 ? good : inst.kube.mintToken(x.pod, x.aud), x.a.id))));
    expect(results.every((r) => !r.granted && (r as { code: string }).code === 'review_unavailable')).toBe(true);
    expect(jwksCalls(inst)).toBe(1); // one fetch (single-flight), not 300
    // Still inside the 5 s back-off: no new fetch, however many ask.
    for (let i = 0; i < 100; i += 1) await inst.runner.acquireStartPermit(req(inst.kube.mintToken(x.pod, x.aud), x.a.id));
    expect(jwksCalls(inst)).toBe(1);
    // Past it, one more attempt is allowed, it succeeds, and the very token that was refused is not remembered as failed.
    clock.now += 6000;
    expect(await inst.runner.acquireStartPermit(req(good, x.a.id))).toMatchObject({ granted: true });
    expect(jwksCalls(inst)).toBe(2);
    expect(inst.runner.permitRefusals()['recently_failed'] ?? 0).toBe(0);
  });

  it('rotation: a key id the cache has not seen is a retryable refusal that is not remembered, and succeeds after the one allowed refetch', async () => {
    const clock = { now: 0 };
    const inst = e.newRunner({ nowMs: tick(clock) });
    const x = await started(inst);
    expect(await inst.runner.renewPermit(req(inst.kube.mintToken(x.pod, x.aud), x.a.id))).toMatchObject({ granted: false }); // not running yet, but the token verified: the key set is cached
    expect(jwksCalls(inst)).toBe(1);
    const newKid = inst.kube.rotateSigningKey();
    const rotated = inst.kube.mintToken(x.pod, x.aud);
    clock.now += 5000; // inside the 30 s refetch limit
    expect(await inst.runner.acquireStartPermit(req(rotated, x.a.id))).toMatchObject({ granted: false, code: 'review_unavailable', reason: 'unknown_key', retryable: true });
    for (let i = 0; i < 50; i += 1) await inst.runner.acquireStartPermit(req(rotated, x.a.id));
    expect(jwksCalls(inst)).toBe(1); // an unknown key id does not make a storm of fetches
    clock.now += 31_000;
    expect(await inst.runner.acquireStartPermit(req(rotated, x.a.id))).toMatchObject({ granted: true }); // one refetch, and the same token goes through
    expect(jwksCalls(inst)).toBe(2);
    expect(newKid).toBe('fake-sa-key-2');
    // The old key stayed published, so a token minted before the rotation still verifies (control).
    expect(inst.runner.permitRefusals()['recently_failed'] ?? 0).toBe(0);
  });

  it('when the cluster cannot be reached the last good key set keeps being served for a bounded time, and then stops', async () => {
    const clock = { now: 0 };
    const inst = e.newRunner({ nowMs: tick(clock) });
    const x = await started(inst);
    await inst.runner.renewPermit(req(inst.kube.mintToken(x.pod, x.aud), x.a.id)); // keys cached at t = 0
    clock.now += 6 * 60_000; // past the 5 minute TTL: a refresh is due, and fails
    inst.kube.failNext('getServiceAccountJwks', new KubeError(0, 'Timeout', 'down'), 100);
    expect(await inst.runner.acquireStartPermit(req(inst.kube.mintToken(x.pod, x.aud), x.a.id))).toMatchObject({ granted: true }); // served from the last good copy; TokenReview still ran
    clock.now += 61 * 60_000; // an hour past the last good fetch
    const y = await started(inst);
    expect(await inst.runner.acquireStartPermit(req(inst.kube.mintToken(y.pod, y.aud), y.a.id))).toMatchObject({ granted: false, code: 'review_unavailable' });
  });

  it('exp has the same 60 s allowance as nbf; a key of the wrong type for the algorithm, and the algorithm none, are refused', async () => {
    const inst = e.newRunner();
    const x = await started(inst);
    expect(await inst.runner.acquireStartPermit(req(inst.kube.mintToken(x.pod, x.aud, { expiresInSeconds: -30 }), x.a.id))).toMatchObject({ granted: true }); // 30 s late: within the allowance
    const y = await started(inst);
    expect(await inst.runner.acquireStartPermit(req(inst.kube.mintToken(y.pod, y.aud, { expiresInSeconds: -120 }), y.a.id))).toMatchObject({ reason: 'local_expired' });
    const z = await started(inst);
    const [h, p, sig] = inst.kube.mintToken(z.pod, z.aud).split('.') as [string, string, string];
    const head = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url');
    expect(await inst.runner.acquireStartPermit(req(`${head({ alg: 'RS256', kid: 'fake-sa-key-1', typ: 'JWT' })}.${p}.${sig}`, z.a.id))).toMatchObject({ reason: 'local_unsupported_alg' }); // an EC key cannot serve RS256
    expect(await inst.runner.acquireStartPermit(req(`${head({ alg: 'none', typ: 'JWT' })}.${p}.${sig}`, z.a.id))).toMatchObject({ reason: 'local_unsupported_alg' });
    expect(h).toBeDefined();
    expect(await inst.runner.acquireStartPermit(req(inst.kube.mintToken(z.pod, z.aud), z.a.id))).toMatchObject({ granted: true }); // control
  });

  it('entries that are null, a number or have no key id are skipped, a malformed key list is an empty one, and neither throws', async () => {
    const k = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
    const cache = new JwksCache({ getServiceAccountJwks: () => Promise.resolve({ keys: [null, 5, 'x', [], { kid: 7 }, { kid: 'broken', kty: 'EC' }, { ...k, kid: 'good' }] as never }) }, () => 0);
    expect(await cache.key('good')).toMatchObject({ type: 'ec', curve: 'prime256v1' });
    expect(await cache.key('broken')).toBeUndefined();
    const empty = new JwksCache({ getServiceAccountJwks: () => Promise.resolve({ keys: 'nonsense' as never }) }, () => 0);
    expect(await empty.key('good')).toBeUndefined();
  });
});
