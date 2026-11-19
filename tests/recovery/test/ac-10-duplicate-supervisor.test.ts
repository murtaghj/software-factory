// AC-10 at the runner, with real supervisors: a duplicate supervisor exits without touching the workspace, and exactly one launches the harness.
// The fake injects a second pod for the Job (an identical receipt); both name the same claim, so both see the same directory, and both run the real supervisor.
import { afterEach, describe, expect, it } from 'vitest';
import { harnessExit, rig, snapshotTree, supervisorExit, until, type Rig } from './kit.ts';

let r: Rig | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
const names = (x: Rig, jobName: string): string[] => x.podsOf(jobName).map((p) => p.metadata.name);

describe('AC-10 a duplicate supervisor', () => {
  it('exactly one is granted; the other exits 65 having read nothing of the workspace, its tree snapshot is unchanged, its launcher started no program, and the next pass deletes only the loser', async () => {
    r = await rig('w019_ac10');
    const run = await r.startRun();
    const first = r.podsOf(run.jobName)[0];
    expect(first).toBeDefined();
    // Both pods name the same claim: relax the claim's access mode so the fake schedules the duplicate beside the first (on a cluster ReadWriteOncePod keeps it Pending).
    for (const c of r.kube.pvcs.values()) c.spec.accessModes = ['ReadWriteOnce'];
    await until('the winner is running', async () => (await r?.e.allocation(r.e.a, run.allocationId))?.state === 'running', 30_000);
    const winnerPod = r.podsOf(run.jobName)[0] as NonNullable<ReturnType<Rig['podsOf']>[number]>;
    const tree = r.claimDir(run.ws);
    const before = snapshotTree(tree);
    const dup = r.kube.driver.addDuplicatePod(run.jobName);
    await until('the duplicate\'s supervisor exited', () => r?.kube.pods.get(dup.metadata.name)?.status.containerStatuses?.some((c) => c.name === 'supervisor' && c.state.terminated !== undefined) === true, 30_000);
    expect(supervisorExit(r.kube, dup.metadata.name)).toBe(65);
    // it probed nothing of the workspace: no view event, and nothing in the tree changed (paths, modes, sizes, hashes)
    expect(r.events(dup.metadata.name, 'supervisor').map((x) => x['event'])).not.toContain('workspace_view_lstat');
    expect(r.events(dup.metadata.name, 'supervisor').find((x) => x['event'] === 'acquire_denied')).toMatchObject({ code: 'duplicate_writer' });
    expect(snapshotTree(tree)).toBe(before);
    // its launcher started no program (it is still waiting for a start signal that will never come)
    expect(r.events(dup.metadata.name, 'launcher').map((x) => x['event'])).not.toContain('started');
    // the winner: the view event is there, and its launcher started one program, once
    expect(r.events(winnerPod.metadata.name, 'supervisor').map((x) => x['event'])).toContain('workspace_view_lstat');
    await until('the winner\'s launcher started its program', () => r?.events(winnerPod.metadata.name, 'launcher').some((x) => x['event'] === 'started') === true);
    expect(r.events(winnerPod.metadata.name, 'launcher').filter((x) => x['event'] === 'started')).toHaveLength(1);
    expect((await r.e.allocation(r.e.a, run.allocationId)).podUid).toBe(winnerPod.metadata.uid);
    // the next pass deletes the loser, and only the loser
    await r.inst.runner.reconcileOne(r.e.a.orgId, run.allocationId);
    await until('the loser is gone', () => !(r?.kube.pods.has(dup.metadata.name) ?? true), 15_000);
    expect(r.kube.pods.has(winnerPod.metadata.name)).toBe(true);
    expect(harnessExit(r.kube, winnerPod.metadata.name)).toBeUndefined(); // the winner's harness still runs
    expect(names(r, run.jobName)).toEqual([winnerPod.metadata.name]);
    expect((await r.e.allocation(r.e.a, run.allocationId)).state).toBe('running');
  }, 90_000);

  it('control: in a fresh setup the second pod alone is granted', async () => {
    r = await rig('w019_ac10c');
    r.holdNextSupervisor(); // the first pod's supervisor stops itself before it asks for anything: only the duplicate runs
    const run = await r.startRun();
    for (const c of r.kube.pvcs.values()) c.spec.accessModes = ['ReadWriteOnce'];
    const first = r.podsOf(run.jobName)[0] as NonNullable<ReturnType<Rig['podsOf']>[number]>;
    const second = r.kube.driver.addDuplicatePod(run.jobName);
    await until('the second pod holds the permit', async () => (await r?.e.allocation(r.e.a, run.allocationId))?.podUid === second.metadata.uid, 30_000);
    expect(supervisorExit(r.kube, second.metadata.name)).toBeUndefined(); // it is the writer: it runs on
    r.kube.driver.resume(first.metadata.uid, 'supervisor');
    await until('the paused one, resumed, is the duplicate now', () => supervisorExit(r?.kube as Rig['kube'], first.metadata.name) === 65, 30_000);
  }, 90_000);
});
