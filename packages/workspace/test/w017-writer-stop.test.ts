// W-017 (D17): the two transitions that end a writer, `active` to `quiescing` and `quiescing` to `retained`.
// Each requires the right source state, the runner identity, the caller's task scope, the expected epoch and
// the pod that owns the workspace. Neither touches a volume, and `release` and `replaceWriter` are unchanged.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, specFor, type Env } from './harness.ts';

let e: Env;
beforeAll(async () => { e = await createEnv('w017_stop'); });
afterAll(async () => { await e.close(); });

const POD = 'pod-uid-1';
const row = (id: string) => e.db.withTenant({ orgId: e.a.orgId }, async (tx) => (await tx.query<{ state: string; generation: number; owner_epoch: string; owner_pod_uid: string | null }>('SELECT state, generation, owner_epoch, owner_pod_uid FROM factory.workspace WHERE id = $1', [id])).rows[0]);
const denied = (id: string) => e.db.withTenant({ orgId: e.a.orgId }, async (tx) => Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM factory.audit_event WHERE resource_id = $1 AND outcome = 'denied'", [id])).rows[0]?.n));

// A workspace in the given state: allocated, or with a materialized clone and a started writer (`active`).
async function workspace(upTo: 'allocated' | 'active'): Promise<string> {
  const id = randomUUID();
  await e.manager.allocateOrAttach(e.runner(e.a), id, specFor(e.a, await e.setupRef(e.a), e.repoA.base));
  if (upTo === 'active') {
    await e.host.ensureMaterialized(e.runner(e.a), id);
    await e.manager.markWriterStarted(e.runner(e.a), id, 1, POD);
  }
  return id;
}

describe('W-017 writer stop transitions', () => {
  it('active to quiescing to retained, for the owning pod; the owner is kept as the last writer, and a repeat is a no-op', async () => {
    const id = await workspace('active');
    expect(await e.manager.markWriterQuiescing(e.runner(e.a), id, 1, POD)).toMatchObject({ state: 'quiescing', generation: 1, ownerEpoch: 1 });
    expect(await e.manager.markWriterQuiescing(e.runner(e.a), id, 1, POD)).toMatchObject({ state: 'quiescing' }); // repeat
    expect(await row(id)).toMatchObject({ state: 'quiescing', owner_pod_uid: POD });
    expect(await e.manager.markWriterStopped(e.runner(e.a), id, 1, POD)).toMatchObject({ state: 'retained' });
    expect(await e.manager.markWriterStopped(e.runner(e.a), id, 1, POD)).toMatchObject({ state: 'retained' }); // repeat
    expect(await e.manager.markWriterQuiescing(e.runner(e.a), id, 1, POD)).toMatchObject({ state: 'retained' }); // already shown stopped by this pod: nothing left to quiesce
    expect(await row(id)).toMatchObject({ state: 'retained', owner_pod_uid: POD, generation: 1 });
  });

  it('each of the right source state, the owning pod and the epoch is required, and a refusal changes nothing', async () => {
    const fresh = await workspace('allocated');
    await expect(e.manager.markWriterQuiescing(e.runner(e.a), fresh, 1, POD)).rejects.toMatchObject({ code: 'invalid_state' }); // allocated to quiescing
    await expect(e.manager.markWriterStopped(e.runner(e.a), fresh, 1, POD)).rejects.toMatchObject({ code: 'invalid_state' });
    expect(await row(fresh)).toMatchObject({ state: 'allocated' });

    const id = await workspace('active');
    await expect(e.manager.markWriterStopped(e.runner(e.a), id, 1, POD)).rejects.toMatchObject({ code: 'invalid_state' }); // active to retained skips quiescing
    await expect(e.manager.markWriterQuiescing(e.runner(e.a), id, 1, 'someone-elses-pod')).rejects.toMatchObject({ code: 'conflict' });
    await expect(e.manager.markWriterQuiescing(e.runner(e.a), id, 2, POD)).rejects.toMatchObject({ code: 'stale_epoch' });
    await expect(e.manager.markWriterQuiescing(e.runner(e.a), id, 1, '')).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await row(id)).toMatchObject({ state: 'active', owner_pod_uid: POD });

    await e.manager.markWriterQuiescing(e.runner(e.a), id, 1, POD);
    await expect(e.manager.markWriterStopped(e.runner(e.a), id, 1, 'someone-elses-pod')).rejects.toMatchObject({ code: 'conflict' });
    await expect(e.manager.markWriterStopped(e.runner(e.a), id, 9, POD)).rejects.toMatchObject({ code: 'stale_epoch' });
    expect(await row(id)).toMatchObject({ state: 'quiescing' });
    // Control: the owning pod at the right epoch goes through.
    expect(await e.manager.markWriterStopped(e.runner(e.a), id, 1, POD)).toMatchObject({ state: 'retained' });
  });

  it('only the runner identity may call them, and a refusal is audited; a caller scoped to another task is refused', async () => {
    const id = await workspace('active');
    const before = await denied(id);
    for (const call of [e.manager.markWriterQuiescing.bind(e.manager), e.manager.markWriterStopped.bind(e.manager)]) {
      await expect(call(e.ctxFor(e.a, 'someone-else'), id, 1, POD)).rejects.toMatchObject({ code: 'forbidden' });
      await expect(call(e.ctxFor(e.a, 'human:dana', 'human'), id, 1, POD)).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(await denied(id)).toBe(before + 4);
    await expect(e.manager.markWriterQuiescing({ ...e.runner(e.a), taskId: randomUUID() }, id, 1, POD)).rejects.toMatchObject({ code: 'forbidden' }); // the scope is never widened
    expect(await row(id)).toMatchObject({ state: 'active' });
    // Another organization cannot see it at all.
    await expect(e.manager.markWriterQuiescing(e.runner(e.b), id, 1, POD)).rejects.toMatchObject({ code: 'not_found' });
    // Control: the runner, scoped to the workspace's own task, does.
    expect(await e.manager.markWriterQuiescing(e.runner(e.a), id, 1, POD)).toMatchObject({ state: 'quiescing' });
  });

  it('release still refuses quiescing and active as writer_active, and a retained workspace with no accepted checkpoint as checkpoint_not_accepted', async () => {
    const id = await workspace('active');
    await expect(e.manager.release(e.runner(e.a), id, 1)).rejects.toMatchObject({ code: 'writer_active' }); // active
    await e.manager.markWriterQuiescing(e.runner(e.a), id, 1, POD);
    await expect(e.manager.release(e.runner(e.a), id, 1)).rejects.toMatchObject({ code: 'writer_active' }); // quiescing
    await e.manager.markWriterStopped(e.runner(e.a), id, 1, POD);
    await expect(e.manager.release(e.runner(e.a), id, 1)).rejects.toMatchObject({ code: 'checkpoint_not_accepted' }); // retained: its work is unacknowledged
    expect(await row(id)).toMatchObject({ state: 'retained' });
  });

  it('replaceWriter still fences from quiescing and from retained, to a new generation and epoch with the old owner cleared', async () => {
    for (const stopAt of ['quiescing', 'retained'] as const) {
      const id = await workspace('active');
      await e.manager.markWriterQuiescing(e.runner(e.a), id, 1, POD);
      if (stopAt === 'retained') await e.manager.markWriterStopped(e.runner(e.a), id, 1, POD);
      expect(await e.manager.replaceWriter(e.runner(e.a), id, 1)).toMatchObject({ generation: 2, ownerEpoch: 2, next: 'materialize', record: { state: 'allocated' } });
      expect(await row(id)).toMatchObject({ state: 'allocated', generation: 2, owner_pod_uid: null });
      // The old epoch can no longer move the writer's state.
      await expect(e.manager.markWriterStopped(e.runner(e.a), id, 1, POD)).rejects.toMatchObject({ code: 'stale_epoch' });
    }
  });
});
