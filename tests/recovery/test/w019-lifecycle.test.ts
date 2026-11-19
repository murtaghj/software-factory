// Start to end, and the runner and the supervisor surviving each other's trouble: the gate, the permit, the view, the start, the harness's exit, the proof.
import net from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { harnessExit, rig, supervisorExit, until, type Rig } from './kit.ts';

let r: Rig | undefined;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); await r?.close(); r = undefined; });
const ev = (x: Rig, pod: string, who: 'supervisor' | 'launcher'): string[] => x.events(pod, who).map((e) => String(e['event']));
const stateOf = async (x: Rig, id: string) => (await x.e.allocation(x.e.a, id));
const openPort = async (): Promise<{ port: number; close: () => Promise<void> }> => {
  const s = net.createServer((c) => { c.end(); });
  await new Promise<void>((resolve) => { s.listen(0, '127.0.0.1', resolve); });
  const close = (): Promise<void> => new Promise((resolve) => { s.close(() => { resolve(); }); });
  closers.push(close);
  return { port: (s.address() as net.AddressInfo).port, close };
};

describe('W-019 lifecycle', () => {
  it('start to end with exit0: the gate waits for the test to close its port, then the permit, the view, the start; the harness exits; the pass sees it: stopping with harness_exited, the pod stopped, a proof, terminated, retained, and getRun says reconciling', async () => {
    const deny = await openPort();
    r = await rig('w019_life1', { gate: { mode: 'required', denyTargets: [`127.0.0.1:${String(deny.port)}`] } });
    r.setScript(() => 'exit0');
    const run = await r.startRun();
    const pod = r.podsOf(run.jobName)[0] as NonNullable<ReturnType<Rig['podsOf']>[number]>;
    await new Promise((x) => setTimeout(x, 1500)); // the gate holds while the target accepts: no permit yet
    expect((await stateOf(r, run.allocationId)).state).toBe('starting');
    expect(r.calls.filter((c) => c.route === 'acquire')).toHaveLength(0);
    await deny.close(); // the rule is "active": the target no longer accepts
    await until('the permit was granted and the harness exited', () => (r ? r.kube.pods.get(pod.metadata.name)?.status.containerStatuses?.find((c) => c.name === 'harness')?.state.terminated !== undefined : false), 30_000);
    const sup = ev(r, pod.metadata.name, 'supervisor');
    expect(sup.indexOf('gate')).toBeLessThan(sup.indexOf('running')); // the gate, then the start
    expect(r.calls.filter((c) => c.route === 'acquire')).toHaveLength(1);
    expect(sup).toContain('workspace_view_lstat');
    expect(harnessExit(r.kube, pod.metadata.name)).toBe(0);
    await until('the pass stops the writer', async () => { await r?.inst.runner.reconcileOne(r.e.a.orgId, run.allocationId); return (await stateOf(r as Rig, run.allocationId)).state === 'terminated'; }, 30_000);
    expect(await r.e.q(r.e.a, "SELECT details_ref->>'reason' AS r FROM factory.audit_event WHERE resource_id = $1 AND action = 'runner.allocation_stopping'", [run.allocationId])).toEqual([{ r: 'harness_exited' }]);
    expect(await r.e.q(r.e.a, "SELECT count(*)::int AS n FROM factory.artifact_link WHERE purpose = $1", [`quiescence_proof/${run.allocationId}`])).toEqual([{ n: 1 }]);
    expect((await r.e.workspace(r.e.a, run.ws)).state).toBe('retained');
    expect((await r.inst.runner.getRun(r.e.ctx(r.e.a), run.s.logicalId)).state).toBe('reconciling');
  }, 90_000);

  it('with write-file the file is in the tree and the view listed the directory; a supervisor killed mid-run is stopped by the next pass as supervisor_exited before its lease expires', async () => {
    r = await rig('w019_life2');
    r.setScript(() => 'write-file');
    const run = await r.startRun();
    const pod = r.podsOf(run.jobName)[0] as NonNullable<ReturnType<Rig['podsOf']>[number]>;
    await until('the file is written', () => existsSync(join(r?.claimDir(run.ws) ?? '', 'factory', r?.e.a.orgId ?? '', run.ws, 'g1', 'work', 'main', 'harness-was-here')), 30_000);
    expect(readFileSync(join(r.claimDir(run.ws), 'factory', r.e.a.orgId, run.ws, 'g1', 'work', 'main', 'harness-was-here'), 'utf8')).toContain('scripted harness');
    expect(r.events(pod.metadata.name, 'supervisor').find((x) => x['event'] === 'workspace_view_list')).toBeDefined();
  }, 90_000);

  it('a supervisor killed mid-run is stopped by the next pass as supervisor_exited, before its lease expires', async () => {
    r = await rig('w019_life2b');
    const run = await r.startRun();
    const pod = r.podsOf(run.jobName)[0] as NonNullable<ReturnType<Rig['podsOf']>[number]>;
    await until('running', async () => (await stateOf(r as Rig, run.allocationId)).state === 'running', 30_000);
    r.kube.driver.finishApp(pod.metadata.name, 'supervisor', 137); // the cluster says the supervisor's container ended
    expect((await stateOf(r, run.allocationId)).leaseRemainingMs).toBeGreaterThan(0); // the lease is still fresh
    await r.inst.runner.reconcileOne(r.e.a.orgId, run.allocationId);
    expect((await r.e.q(r.e.a, "SELECT details_ref->>'reason' AS r FROM factory.audit_event WHERE resource_id = $1 AND action = 'runner.allocation_stopping' ORDER BY created_at DESC LIMIT 1", [run.allocationId]))[0]?.r).toBe('supervisor_exited');
  }, 90_000);

  it('a rotated token file is used by the next beat: the old token is revoked, and the writer is still renewed', async () => {
    r = await rig('w019_life3');
    const run = await r.startRun();
    const pod = r.podsOf(run.jobName)[0] as NonNullable<ReturnType<Rig['podsOf']>[number]>;
    await until('running', async () => (await stateOf(r as Rig, run.allocationId)).state === 'running', 30_000);
    const old = readFileSync(r.kubelet.tokenFile(pod.metadata.uid) as string, 'utf8');
    const fresh = r.kubelet.rotateToken(pod.metadata.uid);
    r.kube.tokens.delete(old); // only the rotated token reviews now
    const beatsBefore = r.calls.filter((c) => c.route === 'renew' && c.token === fresh).length;
    await until('a beat with the new token', () => (r?.calls.filter((c) => c.route === 'renew' && c.token === fresh && c.granted).length ?? 0) > beatsBefore, 15_000);
    expect(r.calls.some((c) => c.route === 'renew' && c.token === old && c.at > performance.now() - 500 && !c.granted)).toBe(false);
    expect((await stateOf(r, run.allocationId)).state).toBe('running');
  }, 90_000);

  it('runner outage: the listener closed for less than the fence time and reopened, the writer survives; control: closed past it, the supervisor exits 70 and the pass stops the allocation', async () => {
    r = await rig('w019_life4'); // lease 10 s, beat 1 s: the supervisor fences itself 9 s after its last grant was sent
    const run = await r.startRun();
    const pod = r.podsOf(run.jobName)[0] as NonNullable<ReturnType<Rig['podsOf']>[number]>;
    await until('running', async () => (await stateOf(r as Rig, run.allocationId)).state === 'running', 30_000);
    const { startPodListener } = await import('@factory/runner/testing');
    await r.listener.close();
    await new Promise((x) => setTimeout(x, 3000)); // shorter than the fence time
    r.listener = await startPodListener({ runner: r.inst.runner, config: r.inst.config });
    await new Promise((x) => setTimeout(x, 3000));
    expect(supervisorExit(r.kube, pod.metadata.name)).toBeUndefined(); // the supervisor lived through it
    expect((await stateOf(r, run.allocationId)).state).toBe('running');
    // control: closed past the fence time
    await r.listener.close();
    await until('the supervisor fenced itself', () => supervisorExit(r?.kube as Rig['kube'], pod.metadata.name) === 70, 20_000);
    r.listener = await startPodListener({ runner: r.inst.runner, config: r.inst.config });
    await until('the pass stops the allocation', async () => { await r?.inst.runner.reconcileOne(r.e.a.orgId, run.allocationId); return ['stopping', 'terminated'].includes((await stateOf(r as Rig, run.allocationId)).state); }, 20_000);
  }, 120_000);

  it('a late acquire retry: the first grant\'s answer is lost and the lease backdated; the retry is denied and no program started', async () => {
    r = await rig('w019_life5', { dropFirstAcquireAnswer: true });
    const run = await r.startRun();
    const pod = r.podsOf(run.jobName)[0] as NonNullable<ReturnType<Rig['podsOf']>[number]>;
    await until('the first grant committed', async () => (await stateOf(r as Rig, run.allocationId)).state === 'running', 30_000);
    await r.e.backdate(r.e.a, run.allocationId, { leaseUntilSecondsAgo: 1 }); // the lease expired before the retry arrives
    await until('the supervisor gave up', () => supervisorExit(r?.kube as Rig['kube'], pod.metadata.name) === 66, 20_000);
    expect(r.events(pod.metadata.name, 'launcher').map((x) => x['event'])).not.toContain('started');
    const retry = r.calls.filter((c) => c.route === 'acquire');
    expect(retry[0]).toMatchObject({ granted: true }); // the lost one
    expect(retry.at(1)).toMatchObject({ granted: false, code: 'not_startable' });
  }, 90_000);
});
