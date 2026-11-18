// The flood (B1, H1): one pod's valid token must not spend everyone's review budget. The per-pod bucket sits after local verification and before the shared budget.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tokenAudience } from '../src/index.ts';
import { createEnv, hex, type Env, type Instance } from './harness.ts';

let e: Env;
beforeAll(async () => { e = await createEnv('w019_rate'); });
afterAll(async () => { await e.close(); });

const calls = (inst: Instance, name: string): number => inst.kube.calls.filter((c) => c.startsWith(name)).length;
async function running(inst: Instance) {
  const s = await e.newStage(e.a);
  await inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s), hex('e'));
  const a = (await e.allocations(e.a, s)).at(-1) as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
  const pod = inst.kube.driver.podsOf(a.jobName)[0] as NonNullable<ReturnType<typeof inst.kube.driver.podsOf>[number]>;
  inst.kube.driver.startPod(pod.metadata.name);
  const token = inst.kube.mintToken(pod, tokenAudience(e.a.orgId, a.id));
  expect(await inst.runner.acquireStartPermit({ token, orgId: e.a.orgId, allocationId: a.id, epoch: 1 })).toMatchObject({ granted: true });
  return { a, pod, token, renew: () => inst.runner.renewPermit({ token, orgId: e.a.orgId, allocationId: a.id, epoch: 1 }) };
}
const frozen = { review: { perSecond: 20, burst: 40 }, podRate: { burst: 6, intervalMs: 2000 } }; // 6: the acquire above took one

describe('W-019 the per-pod bucket', () => {
  it('200 renewals with pod A\'s valid token in one burst: five reach the review, the rest are throttled with no review, no pod read, no row and no audit row; pod B\'s renewal, sent in the middle, is granted', async () => {
    const inst = e.newRunner({ nowMs: () => 0, config: frozen }); // a frozen clock: nothing refills
    const a = await running(inst);
    const b = await running(inst);
    const reviewsBefore = calls(inst, 'reviewToken');
    const podReadsBefore = calls(inst, 'getPod');
    const rowsBefore = JSON.stringify(await e.tables(e.a));
    const auditBefore = await e.auditCount(e.a, 'true');
    const burst = [...Array.from({ length: 100 }, () => a.renew()), b.renew(), ...Array.from({ length: 100 }, () => a.renew())];
    const results = await Promise.all(burst);
    const granted = results.filter((r) => r.granted).length;
    expect(granted).toBe(5 + 1); // five of A, and B
    expect(results[100]).toMatchObject({ granted: true }); // B, in the middle
    expect(results.filter((r) => !r.granted && r.code === 'throttled' && r.reason === 'pod_rate')).toHaveLength(195);
    expect(calls(inst, 'reviewToken') - reviewsBefore).toBe(6);
    expect(calls(inst, 'getPod') - podReadsBefore).toBe(6);
    expect(await e.auditCount(e.a, 'true')).toBe(auditBefore); // no audit row for the throttled
    expect(JSON.stringify(await e.tables(e.a))).not.toBe(rowsBefore); // control: the six grants did write (heartbeats)
  });

  it('control: with the per-pod bucket off the same burst empties the shared budget and pod B is throttled', async () => {
    const inst = e.newRunner({ nowMs: () => 0, config: { ...frozen, test: { noPodBucket: true } } });
    const a = await running(inst);
    const b = await running(inst);
    const results = await Promise.all([...Array.from({ length: 100 }, () => a.renew()), b.renew(), ...Array.from({ length: 100 }, () => a.renew())]);
    expect(results[100]).toMatchObject({ granted: false, code: 'throttled' });
    expect((results[100] as { reason?: string }).reason).toBeUndefined(); // the shared budget, not the pod's
    expect(calls(inst, 'reviewToken')).toBeLessThanOrEqual(40);
  });

  it('the audit cap: 100 denied renewals for a stopping allocation write at most the cap\'s rows and the rest are counted; control: the first denial is audited', async () => {
    const inst = e.newRunner({ config: { refusalAudit: { perSecond: 1, burst: 20 }, podRate: { burst: 1000, intervalMs: 1 } } });
    const a = await running(inst);
    await e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query("UPDATE factory.execution_allocation SET state = 'stopping' WHERE id = $1", [a.a.id]));
    const denied = () => e.q<{ n: number }>(e.a, "SELECT count(*)::int AS n FROM factory.audit_event WHERE action = 'runner.permit.renew' AND resource_id = $1 AND outcome = 'denied'", [a.a.id]);
    expect(await a.renew()).toMatchObject({ code: 'not_renewable', reason: 'stopping' });
    expect(await denied()).toEqual([{ n: 1 }]); // the first is audited
    for (let i = 0; i < 99; i += 1) expect(await a.renew()).toMatchObject({ code: 'not_renewable' });
    const rows = (await denied())[0]?.n as number;
    expect(rows).toBeLessThanOrEqual(21); // the burst of 20, and at most a token's worth of refill
    expect(inst.runner.permitRefusals()['denial_audit_capped']).toBe(100 - rows);
  });

  it('the review budget follows the writers a pass saw: 100 writers give 100 a second, 2 give the floor of 20, 1,000 give the ceiling and the counter moves', async () => {
    const inst = e.newRunner({ config: { review: { perSecond: 20, burst: 40, ceilingPerSecond: 200 } } });
    const warnings: string[] = [];
    inst.deps.onWarning = (m) => warnings.push(m);
    expect(inst.runner.reviewRate()).toEqual({ perSecond: 20, burst: 40 });
    inst.deps.onLiveWriters?.(100);
    expect(inst.runner.reviewRate()).toEqual({ perSecond: 100, burst: 200 });
    inst.deps.onLiveWriters?.(2);
    expect(inst.runner.reviewRate()).toEqual({ perSecond: 20, burst: 40 });
    expect(warnings).toHaveLength(0);
    inst.deps.onLiveWriters?.(1000);
    expect(inst.runner.reviewRate()).toEqual({ perSecond: 200, burst: 400 });
    expect(inst.runner.permitRefusals()['review_ceiling_bound']).toBe(1);
    expect(warnings).toHaveLength(1);
    // a pass hands over the count: two running writers are two
    await running(inst); await running(inst);
    const summary = await inst.runner.reconcileOnce();
    expect(summary.liveWriters).toBeGreaterThanOrEqual(2);
    expect(inst.runner.reviewRate().perSecond).toBe(20);
  });
});
