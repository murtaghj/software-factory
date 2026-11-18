// AC-10 (runner half): one allocation, one Job, one permit winner, whatever the controllers do.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InjectedFault } from '@factory/test-support';
import { encodeRefusalMessage, jobName, tokenAudience } from '../src/index.ts';
import { createEnv, hex, type Env, type Instance, type Stage } from './harness.ts';

let e: Env;
beforeAll(async () => { e = await createEnv('w017_ac10'); });
afterAll(async () => { await e.close(); });

const start = async (inst: Instance, s: Stage, workspaceId?: string) => inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s, workspaceId ? { workspaceId } : {}), hex('e'));
const jobs = (inst: Instance) => [...inst.kube.jobs.values()];
const deletes = (inst: Instance, kind: 'deleteJob' | 'deletePod'): string[] => inst.kube.writes.filter((w) => w.startsWith(`${kind} `));
const tokenFor = (inst: Instance, podName: string, allocationId: string): string => inst.kube.mintToken(inst.kube.driver.pod(podName), tokenAudience(e.a.orgId, allocationId));
const acquire = (inst: Instance, token: string, allocationId: string, epoch = 1) => inst.runner.acquireStartPermit({ token, orgId: e.a.orgId, allocationId, epoch });

describe('AC-10 duplicate run start', () => {
  it('twelve concurrent calls from two controllers (separate pools, one cluster) give one allocation, one Job, one PVC and twelve equal handles', async () => {
    const a = e.newRunner({ ownPool: true });
    const b = e.newRunner({ ownPool: true, kube: a.kube });
    const s = await e.newStage(e.a);
    const ws = await e.newWorkspace(e.a, s, a);
    const handles = await Promise.all(Array.from({ length: 12 }, (_, i) => start(i % 2 === 0 ? a : b, s, ws)));
    expect(new Set(handles.map((h) => JSON.stringify(h))).size).toBe(1);
    expect(handles[0]).toMatchObject({ generation: 1, epoch: 1, state: 'accepted' });
    expect(await e.allocations(e.a, s)).toHaveLength(1);
    expect(jobs(a)).toHaveLength(1);
    expect(a.kube.pvcs.size).toBe(1);
    // Exactly one create of each succeeded; the other attempts (there may be several) were answered AlreadyExists and attached.
    expect(a.kube.created).toEqual({ jobs: 1, pvcs: 1 });
    expect(a.kube.writes.filter((w) => w.startsWith('createJob ')).length).toBeGreaterThanOrEqual(1);
    // Both controllers finish the work: the row is bound to the one Job's UID.
    await b.runner.reconcileOne(e.a.orgId, (await e.allocations(e.a, s))[0]?.id as string);
    expect((await e.allocations(e.a, s))[0]).toMatchObject({ state: 'starting', jobUid: jobs(a)[0]?.metadata.uid });
  });

  it('controller A dies at after_job_create: the row is still desired with no job_uid, and B\'s pass gets AlreadyExists, validates, and binds the fake\'s UID', async () => {
    const a = e.newRunner({ ownPool: true });
    const b = e.newRunner({ ownPool: true, kube: a.kube });
    const s = await e.newStage(e.a);
    a.faults.throwAt('runner.after_job_create');
    const died: unknown[] = [];
    a.deps.onError = (x) => died.push(x);
    await start(a, s); // the committed row is returned; the pass that died is reported, never thrown
    expect(died).toHaveLength(1);
    expect(died[0]).toBeInstanceOf(InjectedFault);
    await a.db.close(); // A is gone: its loop stopped and its pool closed
    const [row] = await e.allocations(e.a, s);
    expect(row).toMatchObject({ state: 'desired', jobUid: null });
    expect(jobs(a)).toHaveLength(1); // what A left behind, before B does anything
    await b.runner.reconcileOne(e.a.orgId, row?.id as string);
    expect((await e.allocations(e.a, s))[0]).toMatchObject({ state: 'starting', jobUid: jobs(a)[0]?.metadata.uid });
    expect(jobs(a)).toHaveLength(1);
  });

  it('forced interleaving: A is held between its create and its compare-and-swap while B binds the same Job; A resumes, re-reads, and deletes nothing', async () => {
    const a = e.newRunner({ ownPool: true });
    const b = e.newRunner({ ownPool: true, kube: a.kube });
    const s = await e.newStage(e.a);
    const hold = a.faults.holdAt('runner.after_job_create');
    const pending = start(a, s);
    await hold.reached;
    const [row] = await e.allocations(e.a, s);
    await b.runner.reconcileOne(e.a.orgId, row?.id as string);
    expect((await e.allocations(e.a, s))[0]?.state).toBe('starting');
    const before = deletes(a, 'deleteJob').length;
    hold.release();
    await pending;
    expect(deletes(a, 'deleteJob')).toHaveLength(before); // nothing deleted
    expect(jobs(a)).toHaveLength(1);
    expect((await e.allocations(e.a, s))[0]).toMatchObject({ state: 'starting', jobUid: jobs(a)[0]?.metadata.uid });
  });

  it('control: the same hold, but the allocation has been taken to terminated first; A then does delete the Job it holds', async () => {
    const a = e.newRunner({ ownPool: true });
    const s = await e.newStage(e.a);
    const hold = a.faults.holdAt('runner.after_job_create');
    const pending = start(a, s);
    await hold.reached;
    const [row] = await e.allocations(e.a, s);
    // As another controller's proof would leave it.
    await e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query("UPDATE factory.execution_allocation SET state = 'terminated', terminated_at = now() WHERE id = $1", [row?.id]));
    expect(jobs(a)).toHaveLength(1);
    hold.release();
    await pending;
    expect(deletes(a, 'deleteJob')).toHaveLength(1);
    expect(jobs(a)).toHaveLength(0); // A deleted the Job it held
  });

  it('AlreadyExists with a foreign Job (other annotations) or with a different UID is quarantined, and nothing attaches', async () => {
    const inst = e.newRunner();
    // Foreign annotations under our name.
    const s = await e.newStage(e.a);
    const name = jobName(e.a.orgId, s.logicalId, 1);
    await inst.kube.createJob({ apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace: inst.kube.namespace, labels: {}, annotations: { 'factory.local/org': e.b.orgId } },
      spec: { backoffLimit: 0, activeDeadlineSeconds: 10, template: { metadata: { labels: {}, annotations: {} }, spec: { restartPolicy: 'Never', terminationGracePeriodSeconds: 15, serviceAccountName: 'x', automountServiceAccountToken: false, shareProcessNamespace: false, securityContext: {}, containers: [], volumes: [] } } } });
    const h = await start(inst, s);
    expect(h.state).toBe('reconciling');
    expect((await e.allocations(e.a, s))[0]).toMatchObject({ state: 'quarantined', jobUid: null });
    expect(await e.auditCount(e.a, "action = 'runner.allocation_quarantined' AND resource_id = $1", [(await e.allocations(e.a, s))[0]?.id])).toBe(1);
    // A different UID: the Job we bound is replaced under the same name with the same annotations.
    const s2 = await e.newStage(e.a);
    await start(inst, s2);
    const bound = (await e.allocations(e.a, s2))[0];
    expect(bound?.state).toBe('starting');
    const old = inst.kube.jobs.get(bound?.jobName as string);
    inst.kube.jobs.delete(bound?.jobName as string);
    if (!old) throw new Error('no job');
    await inst.kube.createJob({ apiVersion: old.apiVersion, kind: old.kind, metadata: { name: old.metadata.name, namespace: old.metadata.namespace, labels: old.metadata.labels, annotations: old.metadata.annotations }, spec: old.spec });
    await inst.runner.reconcileOne(e.a.orgId, bound?.id as string);
    expect((await e.allocation(e.a, bound?.id as string)).state).toBe('quarantined');
    // Control: an honest Job under our name attaches (the crash-between-create-and-record case).
    const s3 = await e.newStage(e.a);
    await start(inst, s3);
    expect((await e.allocations(e.a, s3))[0]?.state).toBe('starting');
  });

  describe('permit, two candidates', () => {
    async function twoCandidates() {
      const a = e.newRunner({ ownPool: true });
      const b = e.newRunner({ ownPool: true, kube: a.kube });
      const s = await e.newStage(e.a);
      const ws = await e.newWorkspace(e.a, s, a);
      await start(a, s, ws);
      const alloc = (await e.allocations(e.a, s))[0];
      const p1 = a.kube.driver.podsOf(alloc?.jobName as string)[0];
      const p2 = a.kube.driver.addDuplicatePod(alloc?.jobName as string);
      for (const p of [p1, p2]) a.kube.driver.initFinished(p?.metadata.name as string, { exitCode: 0, message: e.receiptMessage() });
      return { a, b, s, ws, alloc: alloc as NonNullable<typeof alloc>, p1: p1 as NonNullable<typeof p1>, p2 };
    }

    it('the controllers read the pods in opposite orders and neither pod is deleted; both ask at once: exactly one is granted, the other is duplicate_writer, and the next pass deletes the loser only', async () => {
      const { a, b, ws, alloc, p1, p2 } = await twoCandidates();
      a.kube.listOrder = 'forward';
      await a.runner.reconcileOne(e.a.orgId, alloc.id);
      a.kube.listOrder = 'reverse';
      await b.runner.reconcileOne(e.a.orgId, alloc.id);
      expect(deletes(a, 'deletePod')).toHaveLength(0);
      expect(a.kube.pods.size).toBe(2);
      expect((await e.allocation(e.a, alloc.id)).state).toBe('starting');
      const results = await Promise.all([p1, p2].map((p, i) => acquire(i === 0 ? a : b, tokenFor(a, p.metadata.name, alloc.id), alloc.id)));
      const granted = results.filter((r) => r.granted);
      expect(granted).toHaveLength(1);
      expect(results.filter((r) => !r.granted)).toEqual([expect.objectContaining({ code: 'duplicate_writer' })]);
      const winner = results[0]?.granted ? p1 : p2;
      const loser = winner === p1 ? p2 : p1;
      expect((await e.workspace(e.a, ws))).toMatchObject({ state: 'active', ownerPodUid: winner.metadata.uid });
      expect((await e.allocation(e.a, alloc.id))).toMatchObject({ state: 'running', podUid: winner.metadata.uid });
      await b.runner.reconcileOne(e.a.orgId, alloc.id);
      expect(deletes(a, 'deletePod')).toEqual([`deletePod ${loser.metadata.name}`]);
      expect([...a.kube.pods.keys()]).toEqual([winner.metadata.name]);
    });

    it('control: a second pod alone, with its own receipt, is granted', async () => {
      const a = e.newRunner();
      const s = await e.newStage(e.a);
      const run = await e.runningAllocation(e.a, s, a, { withWorkspace: true });
      expect((await e.allocation(e.a, run.allocationId)).podUid).toBe(run.podUid);
    });
  });

  describe('permit, a bad duplicate', () => {
    for (const order of ['forward', 'reverse'] as const) {
      it(`the second pod answers target_exists: in ${order} read order it is deleted, the allocation stays starting, and the first pod is granted`, async () => {
        const a = e.newRunner();
        const s = await e.newStage(e.a);
        const ws = await e.newWorkspace(e.a, s, a);
        await start(a, s, ws);
        const alloc = (await e.allocations(e.a, s))[0] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
        const good = a.kube.driver.podsOf(alloc.jobName)[0] as NonNullable<ReturnType<typeof a.kube.driver.podsOf>[number]>;
        const bad = a.kube.driver.addDuplicatePod(alloc.jobName);
        const bad2 = a.kube.driver.addDuplicatePod(alloc.jobName);
        a.kube.driver.initFinished(good.metadata.name, { exitCode: 0, message: e.receiptMessage() });
        for (const p of [bad, bad2]) a.kube.driver.initFinished(p.metadata.name, { exitCode: 1, message: encodeRefusalMessage('target_exists', 'the generation directory already exists') });
        a.kube.listOrder = order;
        await a.runner.reconcileOne(e.a.orgId, alloc.id);
        // The read order is the processing order (the deletes follow it), and the outcome is the same either way.
        const expected = order === 'forward' ? [bad, bad2] : [bad2, bad];
        expect(deletes(a, 'deletePod')).toEqual(expected.map((p) => `deletePod ${p.metadata.name}`));
        expect([...a.kube.pods.keys()]).toEqual([good.metadata.name]);
        expect((await e.allocation(e.a, alloc.id)).state).toBe('starting');
        const r = await acquire(a, tokenFor(a, good.metadata.name, alloc.id), alloc.id);
        expect(r).toMatchObject({ granted: true, podUid: good.metadata.uid });
      });
    }

    it('control: a lone pod that answers target_exists stops the allocation', async () => {
      const a = e.newRunner();
      const s = await e.newStage(e.a);
      const ws = await e.newWorkspace(e.a, s, a);
      await start(a, s, ws);
      const alloc = (await e.allocations(e.a, s))[0] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
      const only = a.kube.driver.podsOf(alloc.jobName)[0] as NonNullable<ReturnType<typeof a.kube.driver.podsOf>[number]>;
      a.kube.driver.initFinished(only.metadata.name, { exitCode: 1, message: encodeRefusalMessage('target_exists', 'the generation directory already exists') });
      await a.runner.reconcileOne(e.a.orgId, alloc.id, 1000);
      const now = await e.allocation(e.a, alloc.id);
      expect(['stopping', 'terminated']).toContain(now.state);
      const d = await a.runner.describeRun(e.ctx(e.a), s.logicalId);
      expect(d.stopReason).toBe('every_pod_bad');
    });
  });
});
