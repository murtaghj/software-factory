// AC-15, the protocol and the reconciled side effects (the tree stop is claimed at K only): a cancel holds, the supervisor learns of it from its next beat, acknowledges,
// its launcher stops the group, the pod is deleted, and the proof is stored. A child that leaves its process group is NOT claimed here.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { isAlive, rig, until, type Rig } from './kit.ts';

let r: Rig | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
const sql = (x: Rig, text: string, p: unknown[]) => x.e.q<Record<string, unknown>>(x.e.a, text, p);

async function started(script: string, o: { killAfterMs?: number } = {}) {
  r = await rig('w019_ac15', { ...o });
  r.setScript(() => script);
  const run = await r.startRun();
  const pod = r.podsOf(run.jobName)[0] as NonNullable<ReturnType<Rig['podsOf']>[number]>;
  await until('the harness started', () => r?.events(pod.metadata.name, 'launcher').some((x) => x['event'] === 'started') === true, 40_000);
  const pid = Number(r.events(pod.metadata.name, 'launcher').find((x) => x['event'] === 'started')?.['pid']);
  return { x: r, run, pod, pid };
}
const deletes = (x: Rig): string[] => x.kube.writes.filter((w) => w.startsWith('deletePod') || w.startsWith('deleteJob'));
const cancel = (x: Rig, run: { s: { logicalId: string } }, urgent = false) => x.inst.runner.cancel(x.e.ctx(x.e.a), run.s.logicalId, randomUUID(), 'stop', { urgent });

describe('AC-15 cancellation of a running stage', () => {
  it('the hold; the supervisor\'s next beat is denied; it sets the stop flag and acknowledges; the launcher\'s TERM reaches the group; the pod delete follows; the child is gone; terminated with the proof, retained, capacity released, the reason recorded; getRun says cancelled', async () => {
    const { x, run, pod, pid } = await started('idle');
    // control: before the cancel the child is alive and a renewal is granted
    expect(isAlive(pid)).toBe(true);
    await until('a renewal is granted', () => x.calls.some((c) => c.route === 'renew' && c.granted), 15_000);
    await cancel(x, run);
    expect((await x.e.allocation(x.e.a, run.allocationId)).state).toBe('stopping');
    expect(deletes(x)).toEqual([]); // the hold: nothing is deleted while the supervisor may still acknowledge
    await until('the supervisor\'s beat was denied and it acknowledged', async () => (await sql(x, "SELECT count(*)::int AS n FROM factory.audit_event WHERE action = 'runner.stop_ack' AND resource_id = $1", [run.allocationId]))[0]?.['n'] === 1, 20_000);
    expect(x.calls.some((c) => c.route === 'renew' && !c.granted && c.code === 'not_renewable')).toBe(true);
    expect(x.events(pod.metadata.name, 'supervisor').map((e) => e['event'])).toContain('stop_ack');
    await until('the pod is stopped and the allocation terminated', async () => { await x.inst.runner.reconcileOne(x.e.a.orgId, run.allocationId); return (await x.e.allocation(x.e.a, run.allocationId)).state === 'terminated'; }, 30_000);
    expect(isAlive(pid)).toBe(false);
    expect(await sql(x, 'SELECT count(*)::int AS n FROM factory.artifact_link WHERE purpose = $1', [`quiescence_proof/${run.allocationId}`])).toEqual([{ n: 1 }]);
    expect((await x.e.workspace(x.e.a, run.ws)).state).toBe('retained');
    expect(await sql(x, "SELECT count(*)::int AS n FROM factory.capacity_reservation WHERE stage_run_id = (SELECT stage_run_id FROM factory.execution_allocation WHERE id = $1) AND state = 'released'", [run.allocationId])).toEqual([{ n: 1 }]);
    expect(await sql(x, "SELECT details_ref->>'reason' AS r FROM factory.audit_event WHERE resource_id = $1 AND action = 'runner.allocation_stopping'", [run.allocationId])).toEqual([{ r: 'cancel' }]);
    expect((await x.inst.runner.getRun(x.e.ctx(x.e.a), run.s.logicalId)).state).toBe('cancelled');
  }, 120_000);

  it('a child that ignores TERM ends the same way, after KILL', async () => {
    const { x, run, pid } = await started('ignore-term', { killAfterMs: 400 });
    expect(isAlive(pid)).toBe(true);
    await cancel(x, run);
    await until('terminated', async () => { await x.inst.runner.reconcileOne(x.e.a.orgId, run.allocationId); return (await x.e.allocation(x.e.a, run.allocationId)).state === 'terminated'; }, 40_000);
    expect(isAlive(pid)).toBe(false);
    expect((await x.inst.runner.getRun(x.e.ctx(x.e.a), run.s.logicalId)).state).toBe('cancelled');
  }, 120_000);

  it('with an urgent cancel the delete does not wait for the beat; control: a plain cancel has not deleted anything at the same point', async () => {
    const plain = await started('idle');
    await cancel(plain.x, plain.run);
    expect(deletes(plain.x)).toEqual([]);
    await r?.close(); r = undefined;
    const { x, run, pid } = await started('idle');
    await cancel(x, run, true);
    expect(deletes(x).length).toBeGreaterThan(0); // the delete is already sent when the cancel returns
    expect(x.calls.some((c) => c.route === 'stopAck')).toBe(false); // nobody was asked
    await until('terminated', async () => { await x.inst.runner.reconcileOne(x.e.a.orgId, run.allocationId); return (await x.e.allocation(x.e.a, run.allocationId)).state === 'terminated'; }, 30_000);
    expect(isAlive(pid)).toBe(false);
  }, 120_000);
});
