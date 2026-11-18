import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hex, createEnv, type Env, type Stage } from './harness.ts';

let e: Env;
beforeAll(async () => { e = await createEnv('w017_authz'); });
afterAll(async () => { await e.close(); });

const refusals = (orgT: typeof e.a, action: string, reason: string) => e.auditCount(orgT, "action = $1 AND outcome = 'denied' AND details_ref->>'reason' = $2", [action, reason]);

describe('W-017 authorization', () => {
  it('every Runner and facade method refuses an identity that is not configured, a caller with no task scope and another task\'s scope, an audit row for each configured caller that is refused, and only a counter for one that is not; the configured caller is accepted', async () => {
    const inst = e.newRunner();
    const s = await e.newStage(e.a);
    const ws = await e.newWorkspace(e.a, s, inst);
    await inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s), hex('e'));
    const setup = await e.putArtifact(e.a, Buffer.from('{}'), 'setup_profile');
    const spec = { repositoryId: e.a.repositoryId, baseCommit: 'c'.repeat(40), role: 'implementer' as const, stageRunId: s.logicalId, setupProfileRef: setup, specHash: hex('e') };
    const calls: Array<[string, (ctx: ReturnType<typeof e.ctx>) => Promise<unknown>]> = [
      ['runner.start_or_attach', (c) => inst.runner.startOrAttach(c, e.input(e.a, s), hex('e'))],
      ['runner.get_run', (c) => inst.runner.getRun(c, s.logicalId)],
      ['runner.describe_run', (c) => inst.runner.describeRun(c, s.logicalId)],
      ['runner.cancel', (c) => inst.runner.cancel(c, s.logicalId, randomUUID(), 'x')],
      ['runner.get_result', (c) => inst.runner.getResult(c, s.logicalId)],
      ['runner.workspace.allocate', (c) => inst.runner.allocateWorkspace(c, randomUUID(), spec)],
      ['runner.workspace.release', (c) => inst.runner.releaseWorkspace(c, ws, 1)],
    ];
    const bad: Array<[string, Partial<ReturnType<typeof e.ctx>>]> = [
      ['identity_not_configured', { actorId: 'service:intruder' }],
      ['identity_not_configured', { actorKind: 'human', actorId: 'service:worker' }],
      ['no_task_scope', { taskId: undefined as never }],
      ['task_scope', { taskId: e.b.taskId }],
    ];
    const kubeWrites = inst.kube.writes.length;
    for (const [action, call] of calls) {
      for (const [reason, over] of bad) {
        const before = await refusals(e.a, action, reason);
        const counted = inst.runner.refusalCounts()['identity_not_configured'] ?? 0;
        const rows = await e.auditCount(e.a, 'true');
        const ctx = { ...e.ctx(e.a), ...over };
        if (Object.hasOwn(over, 'taskId') && over.taskId === undefined) delete (ctx as { taskId?: string }).taskId;
        await expect(call(ctx), `${action} / ${reason}`).rejects.toMatchObject({ code: 'forbidden' });
        if (reason === 'identity_not_configured') {
          // An identity that is not configured is counted in memory and writes nothing, in any organization.
          expect(await refusals(e.a, action, reason)).toBe(before);
          expect(await e.auditCount(e.a, 'true'), `${action} writes no row`).toBe(rows);
          expect(inst.runner.refusalCounts()['identity_not_configured']).toBe(counted + 1);
        } else {
          expect(await refusals(e.a, action, reason), `${action} / ${reason} is audited`).toBe(before + 1);
        }
      }
    }
    expect(inst.kube.writes).toHaveLength(kubeWrites); // none of it reached the cluster
    // Controls: the configured identity, scoped to the stage run's task, is accepted by each.
    const ok = e.ctx(e.a);
    await expect(calls[1]?.[1](ok)).resolves.toMatchObject({ generation: 1 });
    await expect(calls[2]?.[1](ok)).resolves.toMatchObject({ allocationId: expect.any(String) as unknown });
    await expect(calls[4]?.[1](ok)).resolves.toBeNull();
    await expect(calls[5]?.[1](ok)).resolves.toMatchObject({ state: 'allocated', role: 'implementer' });
  });

  it('another organization: a start whose input names a different organization than the caller is refused and audited; a read of another organization\'s run is an unknown stage run', async () => {
    const inst = e.newRunner();
    const s = await e.newStage(e.a);
    const before = await refusals(e.b, 'runner.start_or_attach', 'organization');
    await expect(inst.runner.startOrAttach(e.ctx(e.b), e.input(e.a, s), hex('e'))).rejects.toMatchObject({ code: 'forbidden' });
    expect(await refusals(e.b, 'runner.start_or_attach', 'organization')).toBe(before + 1); // in the caller's own organization
    await expect(inst.runner.getRun(e.ctx(e.b), s.logicalId)).rejects.toMatchObject({ code: 'unknown_stage_run' }); // row security hides it
    expect(await e.allocations(e.a, s)).toHaveLength(0);
    await expect(inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s), hex('e'))).resolves.toMatchObject({ state: 'accepted' });
  });

  it('the facade\'s allocateOrAttach creates the row for a configured caller and refuses a role that is not the stage run\'s (conflict), writing nothing', async () => {
    const inst = e.newRunner();
    const s = await e.newStage(e.a, 'implementer');
    const setup = await e.putArtifact(e.a, Buffer.from('{}'), 'setup_profile');
    const spec = { repositoryId: e.a.repositoryId, baseCommit: 'c'.repeat(40), role: 'reviewer' as const, stageRunId: s.logicalId, setupProfileRef: setup, specHash: hex('e') };
    const before = (await e.q(e.a, 'SELECT id FROM factory.workspace')).length;
    await expect(inst.runner.allocateWorkspace(e.ctx(e.a), randomUUID(), spec)).rejects.toMatchObject({ code: 'conflict' });
    expect((await e.q(e.a, 'SELECT id FROM factory.workspace')).length).toBe(before);
    const id = randomUUID();
    expect(await inst.runner.allocateWorkspace(e.ctx(e.a), id, { ...spec, role: 'implementer' })).toMatchObject({ id, state: 'allocated', generation: 1, ownerEpoch: 1 });
    // Called with the caller's own task scope, never widened: another task's workspace is not reachable.
    await expect(inst.runner.allocateWorkspace(e.ctx(e.b), randomUUID(), { ...spec, role: 'implementer' })).rejects.toMatchObject({ code: 'unknown_stage_run' });
  });

  it('release through the facade is refused with a retryable allocation_live while the workspace has a live allocation, and goes through after terminated (never-written workspace)', async () => {
    const inst = e.newRunner();
    const s: Stage = await e.newStage(e.a);
    const ws = await e.newWorkspace(e.a, s, inst);
    await inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s, { workspaceId: ws }), hex('e'));
    await expect(inst.runner.releaseWorkspace(e.ctx(e.a), ws, 1)).rejects.toMatchObject({ code: 'allocation_live', retryable: true });
    await inst.runner.cancel(e.ctx(e.a), s.logicalId, randomUUID(), 'stop');
    expect((await e.allocations(e.a, s))[0]?.state).toBe('terminated');
    expect(await inst.runner.releaseWorkspace(e.ctx(e.a), ws, 1)).toMatchObject({ state: 'released' }); // the stub materializer says the volume is absent
  });

  it('a configured identity\'s denied calls are audited, but only at a bounded rate; the rest are counted', async () => {
    const clock = { now: 0 };
    const inst = e.newRunner({ nowMs: () => clock.now, config: { refusalAudit: { perSecond: 5, burst: 20 } } });
    const s = await e.newStage(e.a);
    const before = await e.auditCount(e.a, "outcome = 'denied' AND details_ref->>'reason' = 'task_scope'");
    for (let i = 0; i < 100; i += 1) await expect(inst.runner.getRun(e.ctx(e.a, { taskId: e.b.taskId }), s.logicalId)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await e.auditCount(e.a, "outcome = 'denied' AND details_ref->>'reason' = 'task_scope'")) - before).toBe(20); // the burst, and no more
    expect(inst.runner.refusalCounts()['audit_capped']).toBe(80);
    clock.now += 2000; // 10 more tokens
    for (let i = 0; i < 30; i += 1) await expect(inst.runner.getRun(e.ctx(e.a, { taskId: e.b.taskId }), s.logicalId)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await e.auditCount(e.a, "outcome = 'denied' AND details_ref->>'reason' = 'task_scope'")) - before).toBe(30);
    // Another identity has its own allowance (control: the cap is per identity, not global).
    const other = e.newRunner({ nowMs: () => clock.now, config: { controlPlaneIdentities: ['service:worker', 'service:other'], refusalAudit: { perSecond: 5, burst: 20 } } });
    await expect(other.runner.getRun(e.ctx(e.a, { actorId: 'service:other', taskId: e.b.taskId }), s.logicalId)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await e.auditCount(e.a, "outcome = 'denied' AND details_ref->>'reason' = 'task_scope'")) - before).toBe(31);
  });
});
