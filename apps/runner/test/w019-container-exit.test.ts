// A harness exit, a supervisor exit: the whole pod is stopped at once, without waiting for the lease or a hold (D22: `running -> stopping`, never `finalizing`).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tokenAudience } from '../src/index.ts';
import { createEnv, hex, type Env, type Instance } from './harness.ts';

let e: Env;
beforeAll(async () => { e = await createEnv('w019_exit', { config: { cancelCheckpointWaitSeconds: 30, podRate: { burst: 1000, intervalMs: 1 } } }); });
afterAll(async () => { await e.close(); });

const reason = (id: string) => e.q<{ r: string }>(e.a, "SELECT details_ref->>'reason' AS r FROM factory.audit_event WHERE resource_id = $1 AND action = 'runner.allocation_stopping' ORDER BY created_at DESC LIMIT 1", [id]);
async function running(inst: Instance, workspace = true) {
  const s = await e.newStage(e.a);
  const x = await e.runningAllocation(e.a, s, inst, { withWorkspace: workspace });
  return { s, x };
}

describe('W-019 container exits', () => {
  it('the harness container exits 0 while the supervisor runs: the next pass moves running to stopping with harness_exited, deletes without a hold, stores the proof and ends terminated with the workspace retained; getRun answers reconciling', async () => {
    const inst = e.newRunner();
    const { s, x } = await running(inst);
    // control: with both containers running, ten passes change nothing
    for (let i = 0; i < 10; i += 1) await inst.runner.reconcileOne(e.a.orgId, x.allocationId);
    expect((await e.allocation(e.a, x.allocationId)).state).toBe('running');
    expect(inst.kube.writes.filter((w) => w.startsWith('delete'))).toEqual([]);
    inst.kube.driver.finishApp(x.podName, 'harness', 0);
    await inst.runner.reconcileOne(e.a.orgId, x.allocationId);
    expect(await reason(x.allocationId)).toEqual([{ r: 'harness_exited' }]);
    const a = await e.allocation(e.a, x.allocationId);
    expect(a.state).toBe('terminated');
    expect((await e.workspace(e.a, x.workspaceId as string)).state).toBe('retained');
    expect(await e.q(e.a, "SELECT count(*)::int AS n FROM factory.artifact_link WHERE purpose = $1", [`quiescence_proof/${x.allocationId}`])).toEqual([{ n: 1 }]);
    expect((await inst.runner.getRun(e.ctx(e.a), s.logicalId)).state).toBe('reconciling');
  });

  it('the supervisor container exits while the harness runs: supervisor_exited on the next pass, with the lease still fresh', async () => {
    const inst = e.newRunner();
    const { x } = await running(inst, false);
    expect((await e.allocation(e.a, x.allocationId)).leaseRemainingMs).toBeGreaterThan(50_000);
    inst.kube.driver.finishApp(x.podName, 'supervisor', 1);
    await inst.runner.reconcileOne(e.a.orgId, x.allocationId);
    expect(await reason(x.allocationId)).toEqual([{ r: 'supervisor_exited' }]);
    expect((await e.allocation(e.a, x.allocationId)).state).toBe('terminated');
  });

  it('in starting, a pod whose supervisor has exited is deleted as a bad pod, and a lone one stops the allocation; control: a pod whose supervisor runs is left alone', async () => {
    const inst = e.newRunner();
    const s = await e.newStage(e.a);
    await inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s), hex('e'));
    const a = (await e.allocations(e.a, s))[0] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
    const pod = inst.kube.driver.podsOf(a.jobName)[0] as NonNullable<ReturnType<typeof inst.kube.driver.podsOf>[number]>;
    inst.kube.driver.startPod(pod.metadata.name);
    await inst.runner.reconcileOne(e.a.orgId, a.id);
    expect((await e.allocation(e.a, a.id)).state).toBe('starting'); // control
    inst.kube.driver.finishApp(pod.metadata.name, 'supervisor', 65); // a duplicate that lost, or a gate that never passed
    await inst.runner.reconcileOne(e.a.orgId, a.id);
    expect(await reason(a.id)).toEqual([{ r: 'every_pod_bad' }]);
    expect((await e.allocation(e.a, a.id)).state).toBe('terminated');
  });

  it('a renewal that sees the exited container answers; the pass it sets off is the listener\'s (W-019 route tests); finalizing rows are unchanged by a pass', async () => {
    const inst = e.newRunner();
    const { x } = await running(inst, false);
    inst.kube.driver.finishApp(x.podName, 'harness', 7);
    const answer = await inst.runner.renewPermit({ token: inst.kube.mintToken(inst.kube.driver.pod(x.podName), tokenAudience(e.a.orgId, x.allocationId)), orgId: e.a.orgId, allocationId: x.allocationId, epoch: 1 });
    expect(answer).toMatchObject({ granted: true, harness: { state: 'terminated', exitCode: 7 } });
    expect((await e.allocation(e.a, x.allocationId)).state).toBe('running'); // the answer set nothing off by itself
    // W-017's assertion, kept: a finalizing row is left alone
    const y = await running(inst, false);
    await e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query("UPDATE factory.execution_allocation SET state = 'finalizing' WHERE id = $1", [y.x.allocationId]));
    inst.kube.driver.finishApp(y.x.podName, 'harness', 0);
    await inst.runner.reconcileOne(e.a.orgId, y.x.allocationId);
    expect((await e.allocation(e.a, y.x.allocationId)).state).toBe('finalizing');
  });
});
