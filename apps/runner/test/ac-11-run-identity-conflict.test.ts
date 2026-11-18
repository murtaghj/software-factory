// AC-11 (runner half): a different input hash or specHash is a conflict, and nothing is altered or attached.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalHash } from '@factory/domain';
import { createEnv, hex, type Env } from './harness.ts';

let e: Env;
beforeAll(async () => { e = await createEnv('w017_ac11'); });
afterAll(async () => { await e.close(); });

describe('AC-11 run identity conflict', () => {
  it('a different input hash, role, node, attempt or limits is a conflict against a live allocation, and nothing changes; the same request attaches', async () => {
    const inst = e.newRunner();
    const s = await e.newStage(e.a);
    const first = await inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s), hex('e'));
    const before = { tables: await e.tables(e.a), kube: inst.kube.snapshot(), writes: inst.kube.writes.length };
    const otherBinding = { ...s.binding, planVersion: 2 };
    const requests = [
      e.input(e.a, s, { inputBinding: otherBinding as never, inputHash: canonicalHash(otherBinding) }), // hash B
      e.input(e.a, s, { role: 'reviewer' }),
      e.input(e.a, s, { nodeId: 'other-node' }),
      e.input(e.a, s, { semanticAttempt: 2 }),
      e.input(e.a, s, { limits: { ...s.limits, wallSeconds: 60 } as never }),
    ];
    for (const r of requests) await expect(inst.runner.startOrAttach(e.ctx(e.a), r, hex('e'))).rejects.toMatchObject({ code: 'conflict' });
    await expect(inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s), hex('f'))).rejects.toMatchObject({ code: 'conflict' }); // another specHash
    expect(await e.tables(e.a)).toBe(before.tables);
    expect(inst.kube.snapshot()).toBe(before.kube);
    expect(inst.kube.writes).toHaveLength(before.writes); // not one request at the cluster
    // Control: hash A attaches and returns the existing handle.
    expect(await inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s), hex('e'))).toEqual(first);
    expect(await e.allocations(e.a, s)).toHaveLength(1);
  });

  it('a different specHash is also a conflict against a terminated allocation, which a new generation must not hide', async () => {
    const inst = e.newRunner();
    const s = await e.newStage(e.a);
    await inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s), hex('e'));
    const alloc = (await e.allocations(e.a, s))[0]?.id as string;
    await e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query("UPDATE factory.execution_allocation SET state = 'terminated', terminated_at = now() WHERE id = $1", [alloc]));
    const before = { tables: await e.tables(e.a), kube: inst.kube.snapshot() };
    await expect(inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s), hex('f'))).rejects.toMatchObject({ code: 'conflict' });
    expect(await e.tables(e.a)).toBe(before.tables);
    expect(inst.kube.snapshot()).toBe(before.kube);
    // Control: the same specHash is a new generation.
    const h = await inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s), hex('e'));
    expect(h).toMatchObject({ generation: 2 });
  });

  it('a malformed request is refused as invalid_request with nothing written (control: the valid one is accepted)', async () => {
    const inst = e.newRunner();
    const s = await e.newStage(e.a);
    const before = await e.tables(e.a);
    const good = e.input(e.a, s);
    await expect(inst.runner.startOrAttach(e.ctx(e.a), { ...good, inputHash: hex('0') }, hex('e'))).rejects.toMatchObject({ code: 'invalid_request' }); // not the binding's hash
    await expect(inst.runner.startOrAttach(e.ctx(e.a), good, 'xyz')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(inst.runner.startOrAttach(e.ctx(e.a), { ...good, extra: 1 } as never, hex('e'))).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(inst.runner.startOrAttach(e.ctx(e.a), { ...good, limits: { ...good.limits, wallSeconds: 7201 } }, hex('e'))).rejects.toMatchObject({ code: 'limits_exceed_cap' });
    await expect(inst.runner.startOrAttach(e.ctx(e.a), { ...good, contextRef: { ...good.contextRef, sizeBytes: 1 }, capabilityGrants: Array.from({ length: 3000 }, (_, i) => ({ grantId: `g${String(i)}`.repeat(10), operation: 'read', resourceIds: ['x'.repeat(100)], environmentScope: 'e', expiresAt: '2026-01-01T00:00:00Z', maxCalls: 1, sideEffect: 'read' as const, allocationEpoch: 1 })) }, hex('e'))).rejects.toThrow(/larger than 262144 bytes/); // over 256 KiB
    await expect(inst.runner.startOrAttach(e.ctx(e.a), { ...good, stageRunId: `task-${e.a.taskId}/plan-1/unknown/attempt-1` }, hex('e'))).rejects.toMatchObject({ code: 'unknown_stage_run' });
    expect(await e.tables(e.a)).toBe(before);
    expect(inst.kube.writes).toHaveLength(0);
    await expect(inst.runner.startOrAttach(e.ctx(e.a), good, hex('e'))).resolves.toMatchObject({ state: 'accepted' });
  });
});
