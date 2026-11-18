// The hold (06:90): a cancel waits up to 30 s for a recently live writer to acknowledge, and nothing else ever waits.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toStopping } from '../src/testing.ts';
import { createEnv, type Env, type Instance, type Stage } from './harness.ts';

let e: Env;
beforeAll(async () => { e = await createEnv('w019_window', { config: { cancelCheckpointWaitSeconds: 30, podRate: { burst: 1000, intervalMs: 1 } } }); });
afterAll(async () => { await e.close(); });

const never = (): never => { throw new Error('no such pod'); };
const deletes = (inst: Instance): string[] => inst.kube.writes.filter((w) => w.startsWith('deletePod') || w.startsWith('deleteJob'));
const cancel = (inst: Instance, s: Stage, o: { urgent?: boolean } = {}) => inst.runner.cancel(e.ctx(e.a), s.logicalId, randomUUID(), 'stop', o);
const rec = (action: string, id: string) => e.q<{ n: number }>(e.a, 'SELECT count(*)::int AS n FROM factory.audit_event WHERE action = $1 AND resource_id = $2', [action, id]);
const ack = (inst: Instance, x: { allocationId: string; token: string }) => inst.runner.stopAck({ token: x.token, orgId: e.a.orgId, allocationId: x.allocationId, epoch: 1 });
async function run() {
  const inst = e.newRunner();
  const s = await e.newStage(e.a);
  const x = await e.runningAllocation(e.a, s, inst);
  return { inst, s, x };
}

describe('W-019 the cancel window', () => {
  it('after a cancel, a pass sends no delete while every condition holds; the renewal answers not_renewable/stopping; stop-ack is recorded and its pass deletes; a repeat writes nothing', async () => {
    const { inst, s, x } = await run();
    await cancel(inst, s);
    expect((await e.allocation(e.a, x.allocationId)).state).toBe('stopping');
    await inst.runner.reconcileOne(e.a.orgId, x.allocationId);
    expect(deletes(inst)).toEqual([]); // held
    expect(await inst.runner.renewPermit({ token: x.token, orgId: e.a.orgId, allocationId: x.allocationId, epoch: 1 })).toMatchObject({ code: 'not_renewable', reason: 'stopping' });
    expect(await ack(inst, x)).toEqual({ acknowledged: true, repeat: false });
    await inst.runner.reconcileOne(e.a.orgId, x.allocationId);
    expect(deletes(inst).length).toBeGreaterThan(0); // the acknowledgement ended the hold
    expect((await e.allocation(e.a, x.allocationId)).state).toBe('terminated');
    expect(await rec('runner.cancel_stop', x.allocationId)).toEqual([{ n: 1 }]);
    expect(await rec('runner.stop_ack', x.allocationId)).toEqual([{ n: 1 }]);
  });

  it('a repeat of stop-ack inside the hold finds the record: nothing new is written and it starts no second pass', async () => {
    const { inst, s, x } = await run();
    await cancel(inst, s);
    expect(await ack(inst, x)).toMatchObject({ repeat: false });
    const writes = inst.kube.writes.length;
    expect(await ack(inst, x)).toMatchObject({ acknowledged: true, repeat: true });
    expect(await rec('runner.stop_ack', x.allocationId)).toEqual([{ n: 1 }]);
    expect(inst.kube.writes.length).toBe(writes);
  });

  it('backdated 31 s with no acknowledgement: deleted; control: at 29 s it still waits', async () => {
    const { inst, s, x } = await run();
    await cancel(inst, s);
    await e.backdate(e.a, x.allocationId, { updatedSecondsAgo: 29 });
    await inst.runner.reconcileOne(e.a.orgId, x.allocationId);
    expect(deletes(inst)).toEqual([]);
    await e.backdate(e.a, x.allocationId, { updatedSecondsAgo: 31 });
    await inst.runner.reconcileOne(e.a.orgId, x.allocationId);
    expect((await e.allocation(e.a, x.allocationId)).state).toBe('terminated');
  });

  it('each condition removed in turn deletes on the first pass: no start record, a stale heartbeat, a stop for a lost lease, an urgent cancel; control: the window at 0 deletes at once as in W-017', async () => {
    // no start record: cancelled while starting
    const a = e.newRunner();
    const sa = await e.newStage(e.a);
    await a.runner.startOrAttach(e.ctx(e.a), e.input(e.a, sa), 'e'.repeat(64));
    await cancel(a, sa);
    expect((await e.allocations(e.a, sa))[0]?.state).toBe('terminated');
    // a stale heartbeat when the stop began
    const b = await run();
    await e.backdate(e.a, b.x.allocationId, { heartbeatSecondsAgo: 100 });
    await cancel(b.inst, b.s);
    expect((await e.allocation(e.a, b.x.allocationId)).state).toBe('terminated');
    // a stop for a lost lease (no cancel-stop record: the stop was not caused by the cancel)
    const c = await run();
    await e.backdate(e.a, c.x.allocationId, { leaseUntilSecondsAgo: 1 });
    await c.inst.runner.reconcileOne(e.a.orgId, c.x.allocationId); // lease_expired -> stopping, and the same pass goes on
    expect((await e.allocation(e.a, c.x.allocationId)).state).toBe('terminated');
    expect(await rec('runner.cancel_stop', c.x.allocationId)).toEqual([{ n: 0 }]);
    // an urgent cancel
    const d = await run();
    await cancel(d.inst, d.s, { urgent: true });
    expect((await e.allocation(e.a, d.x.allocationId)).state).toBe('terminated');
    // control: the window at 0
    const f = e.newRunner({ config: { cancelCheckpointWaitSeconds: 0 } });
    const sf = await e.newStage(e.a);
    const xf = await e.runningAllocation(e.a, sf, f);
    await cancel(f, sf);
    expect((await e.allocation(e.a, xf.allocationId)).state).toBe('terminated');
  });

  it('a second, urgent cancel during a hold ends it', async () => {
    const { inst, s, x } = await run();
    await cancel(inst, s);
    expect(deletes(inst)).toEqual([]);
    await cancel(inst, s, { urgent: true }); // a new command id; the urgent record is written although a cancel record exists
    expect((await e.allocation(e.a, x.allocationId)).state).toBe('terminated');
  });

  it('a pod already Terminating from outside the runner: stop-ack is refused, the pass sends no delete, and the hold ends at 30 s, well inside the stop deadline; the proof decides the outcome', async () => {
    const { inst, s, x } = await run();
    inst.kube.delayDeletes = true; // the kubelet has not reaped it
    (inst.kube.pods.get(x.podName) ?? never()).metadata.deletionTimestamp = inst.kube.now(); // an eviction, a deadline, a manual delete
    await cancel(inst, s);
    expect(await ack(inst, x)).toMatchObject({ granted: false, code: 'not_this_job', reason: 'pod' });
    await inst.runner.reconcileOne(e.a.orgId, x.allocationId);
    expect(deletes(inst)).toEqual([]);
    expect((await e.allocation(e.a, x.allocationId)).leaseRemainingMs).toBeGreaterThan(100_000); // the 180 s stop deadline is far away
    await e.backdate(e.a, x.allocationId, { updatedSecondsAgo: 31 });
    await inst.runner.reconcileOne(e.a.orgId, x.allocationId);
    expect(deletes(inst).length).toBeGreaterThan(0);
    inst.kube.driver.finishDeletes();
    await inst.runner.reconcileOne(e.a.orgId, x.allocationId);
    expect((await e.allocation(e.a, x.allocationId)).state).toBe('terminated');
    inst.kube.delayDeletes = false;
  });

  it('a cancel after a container-exit stop: it makes no transition and writes no cancel-stop record, so the next pass deletes at once; also when the cancel waits on the row lock while the stop is written', async () => {
    // After the stop was written, before any pass deleted.
    const one = await run();
    await toStopping(one.inst.deps, await e.allocation(e.a, one.x.allocationId), 'supervisor_exited');
    await cancel(one.inst, one.s);
    expect((await e.allocation(e.a, one.x.allocationId)).state).toBe('terminated');
    expect(await rec('runner.cancel_stop', one.x.allocationId)).toEqual([{ n: 0 }]);
    // The cancel holds the stage run's lock at the fault; the stop is written; the released cancel finds the row stopping.
    const two = await run();
    const hold = two.inst.faults.holdAt('runner.before_cancel_allocation_lock');
    const pending = cancel(two.inst, two.s);
    await hold.reached;
    await toStopping(two.inst.deps, await e.allocation(e.a, two.x.allocationId), 'supervisor_exited');
    hold.release();
    await pending;
    expect((await e.allocation(e.a, two.x.allocationId)).state).toBe('terminated');
    expect(await rec('runner.cancel_stop', two.x.allocationId)).toEqual([{ n: 0 }]);
    // Control: a cancel that itself moves a running allocation writes the record, and the pass holds.
    const three = await run();
    await cancel(three.inst, three.s);
    expect(await rec('runner.cancel_stop', three.x.allocationId)).toEqual([{ n: 1 }]);
    expect((await e.allocation(e.a, three.x.allocationId)).state).toBe('stopping');
  });
});
