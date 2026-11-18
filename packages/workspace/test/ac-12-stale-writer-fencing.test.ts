// AC-12, the Git fencing half only: after a replacement the old epoch cannot update a task ref or
// change workspace state, and a new writer never gets the old directory. Stale-epoch denial of
// artifact finalization, result publication and tool operations is W-019/W-023/W-075; reuse on proof
// of quiescence and the quarantine record are W-019/W-024; isolated restore is W-020.
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transitionWorkspace } from '@factory/database';
import { IDLE_IN_TRANSACTION_MS, createPublisher, createWorkspaceManager } from '../src/index.ts';
import { ArtifactService } from '@factory/artifacts';
import { Database } from '@factory/database';
import { checkpointedWorkspace, createEnv, fileGit, generationDir, isAlive, sleep, slowPushGit, snapshotTree, specFor, type Env } from './harness.ts';

let e: Env;
beforeAll(async () => { e = await createEnv('w018_ac12'); });
afterAll(async () => { await e.close(); });

const publisher = () => createPublisher({ db: e.db, artifacts: e.artifacts, publisherIdentity: 'service:git-publisher', scratchRoot: e.scratch, git: fileGit() });
const PUB = 'service:git-publisher';
const state = (id: string) => e.db.withTenant({ orgId: e.a.orgId }, async (tx) => (await tx.query<{ state: string; generation: number; owner_epoch: string; owner_pod_uid: string | null }>('SELECT state, generation, owner_epoch, owner_pod_uid FROM factory.workspace WHERE id = $1', [id])).rows[0]);
const inodes = (dir: string): Set<string> => {
  const out = new Set<string>();
  const walk = (d: string): void => { for (const n of readdirSync(d)) { const p = join(d, n); const s = lstatSync(p); if (s.isDirectory()) walk(p); else out.add(`${String(s.dev)}:${String(s.ino)}`); } };
  walk(dir);
  return out;
};

describe('AC-12 stale-writer fencing (Git half)', () => {
  it('after a replacement the old epoch cannot publish, change state or release, the old directory is untouched, and the new generation lands at a new path', async () => {
    const w = await checkpointedWorkspace(e, e.a, e.repoA, 'fence1');
    const g1 = generationDir(e, e.a, w.id, 1);
    writeFileSync(join(g1, 'work/main/dirty.txt'), 'the old writer was here'); // a candidate-writable directory
    const before = snapshotTree(g1);

    // Positive control: before the replacement the same epoch and the same call do publish.
    const control = await checkpointedWorkspace(e, e.a, e.repoA, 'fence1-control');
    expect(await publisher().compareAndUpdateRef(e.publisher(e.a), { workspaceId: control.id, expectedEpoch: 1, expectedHead: null, sourceRef: control.sourceRef })).toEqual({ outcome: 'updated', head: control.commit });
    expect(e.repoA.remoteRef(`refs/heads/${control.branch}`)).toBe(control.commit);

    const out = await e.manager.replaceWriter(e.runner(e.a), w.id, 1);
    expect(out).toMatchObject({ generation: 2, ownerEpoch: 2, next: 'materialize', record: { state: 'allocated', generation: 2, ownerEpoch: 2 } });
    expect((await state(w.id))).toMatchObject({ state: 'allocated', generation: 2, owner_pod_uid: null });

    // The old epoch is refused everywhere that matters in W-018.
    expect(await publisher().compareAndUpdateRef(e.publisher(e.a), { workspaceId: w.id, expectedEpoch: 1, expectedHead: null, sourceRef: w.sourceRef })).toEqual({ outcome: 'stale_epoch', currentEpoch: 2 });
    expect(e.repoA.remoteRef(`refs/heads/${w.branch}`)).toBeNull();
    await expect(e.manager.markWriterStarted(e.runner(e.a), w.id, 1, 'pod-old')).rejects.toMatchObject({ code: 'stale_epoch' });
    await expect(e.manager.release(e.runner(e.a), w.id, 1)).rejects.toMatchObject({ code: 'stale_epoch' });
    await expect(e.manager.replaceWriter(e.runner(e.a), w.id, 1)).rejects.toMatchObject({ code: 'stale_epoch' });
    await expect(e.manager.acceptMaterialization(e.runner(e.a), w.id, 1, { generation: 2, headCommit: e.repoA.base, treeDigest: 'a'.repeat(64), gitVersion: 'x' })).rejects.toMatchObject({ code: 'stale_epoch' });
    expect(snapshotTree(g1)).toBe(before);

    // The new writer gets a new directory, never the old one.
    expect(existsSync(generationDir(e, e.a, w.id, 2))).toBe(false);
    expect(await e.host.ensureMaterialized(e.runner(e.a), w.id)).toMatchObject({ outcome: 'materialized', receipt: { generation: 2 } });
    const g2 = generationDir(e, e.a, w.id, 2);
    expect(g2).not.toBe(g1);
    expect(snapshotTree(g1)).toBe(before);
    expect(existsSync(join(g2, 'work/main/dirty.txt'))).toBe(false);
    expect([...inodes(g1)].filter((x) => inodes(g2).has(x))).toEqual([]);
    expect(await e.manager.markWriterStarted(e.runner(e.a), w.id, 2, 'pod-new')).toMatchObject({ state: 'active', ownerEpoch: 2 });
  });

  it('with a checkpoint_ref set the fence still commits and the request answers restore_unavailable (no fresh clone papers over lost work)', async () => {
    const w = await checkpointedWorkspace(e, e.a, e.repoA, 'fence2');
    await e.db.withTenant({ orgId: e.a.orgId }, (tx) => transitionWorkspace(tx, { orgId: e.a.orgId, id: w.id, expectedEpoch: 1, from: ['checkpointed'], patch: { checkpointRef: { artifactId: randomUUID(), sha256: 'a'.repeat(64), mediaType: 'application/json', schemaVersion: '2.0', sizeBytes: 2 } } }));
    const g1 = generationDir(e, e.a, w.id, 1);
    const before = snapshotTree(g1);
    const out = await e.manager.replaceWriter(e.runner(e.a), w.id, 1);
    expect(out).toMatchObject({ generation: 2, ownerEpoch: 2, next: 'restore_required' });
    expect(await e.manager.materializationRequest(e.runner(e.a), w.id, 2)).toEqual({ ok: false, code: 'restore_unavailable' });
    expect(await e.host.ensureMaterialized(e.runner(e.a), w.id)).toEqual({ outcome: 'unchanged', reason: 'restore_unavailable' });
    expect(existsSync(generationDir(e, e.a, w.id, 2))).toBe(false);
    expect(snapshotTree(g1)).toBe(before);
  });

  it('replaceWriter works from every replaceable state and refuses the rest', async () => {
    for (const from of ['allocated', 'quiescing', 'retained'] as const) {
      const id = randomUUID();
      await e.manager.allocateOrAttach(e.runner(e.a), id, specFor(e.a, await e.setupRef(e.a), e.repoA.base));
      if (from !== 'allocated') {
        await e.host.ensureMaterialized(e.runner(e.a), id);
        await e.manager.markWriterStarted(e.runner(e.a), id, 1, 'pod');
        await e.db.withTenant({ orgId: e.a.orgId }, (tx) => transitionWorkspace(tx, { orgId: e.a.orgId, id, expectedEpoch: 1, from: ['active'], patch: { state: from } }));
      }
      expect(await e.manager.replaceWriter(e.runner(e.a), id, 1)).toMatchObject({ next: 'materialize', record: { state: 'allocated', generation: 2, ownerEpoch: 2 } });
    }
    const id = randomUUID();
    await e.manager.allocateOrAttach(e.runner(e.a), id, specFor(e.a, await e.setupRef(e.a), e.repoA.base));
    await e.manager.release(e.runner(e.a), id, 1);
    await expect(e.manager.replaceWriter(e.runner(e.a), id, 1)).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('a replaceWriter that cannot get the row lock in time fails with a retryable publish_in_progress and does not fence', async () => {
    const w = await checkpointedWorkspace(e, e.a, e.repoA, 'timeout');
    let entered!: () => void; const hasEntered = new Promise<void>((r) => { entered = r; });
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const pub = createPublisher({ db: e.db, artifacts: e.artifacts, publisherIdentity: 'service:git-publisher', scratchRoot: e.scratch, git: fileGit(), faults: { afterEpochCheck: async () => { entered(); await gate; } } });
    const push = pub.compareAndUpdateRef(e.publisher(e.a), { workspaceId: w.id, expectedEpoch: 1, expectedHead: null, sourceRef: w.sourceRef });
    await hasEntered;
    const impatient = createWorkspaceManager({ db: e.db, artifacts: e.artifacts, runnerIdentity: 'runner:factory', lockWaitMs: 300 });
    await expect(impatient.replaceWriter(e.runner(e.a), w.id, 1)).rejects.toMatchObject({ code: 'publish_in_progress' });
    expect(await state(w.id)).toMatchObject({ state: 'checkpointed', generation: 1, owner_epoch: '1' });
    release();
    expect(await push).toMatchObject({ outcome: 'updated' });
    expect(await impatient.replaceWriter(e.runner(e.a), w.id, 1)).toMatchObject({ generation: 2 }); // retry succeeds once the push is done
  });

  it('race: a concurrent replaceWriter blocks until an in-flight push ends; a heartbeat update is not blocked; a replacement that commits first makes the push stale_epoch', async () => {
    const w = await checkpointedWorkspace(e, e.a, e.repoA, 'race');
    const stageId = (await e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query<{ id: string }>('SELECT id FROM factory.stage_run WHERE logical_id = $1', [e.a.stages.implementer]))).rows[0]?.id;
    const allocationId = randomUUID();
    await e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query(`INSERT INTO factory.execution_allocation (org_id, id, stage_run_id, workspace_id, generation, owner_epoch, spec_hash, job_name, namespace, supervisor_identity, state)
      VALUES ($1,$2,$3,$4,1,1,$5,$6,'ns','sup','running')`, [e.a.orgId, allocationId, stageId, w.id, 'a'.repeat(64), `job-${allocationId}`]));

    let entered!: () => void; const hasEntered = new Promise<void>((r) => { entered = r; });
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const pub = createPublisher({ db: e.db, artifacts: e.artifacts, publisherIdentity: 'service:git-publisher', scratchRoot: e.scratch, git: fileGit(),
      faults: { afterEpochCheck: async () => { entered(); await gate; } } });
    const push = pub.compareAndUpdateRef(e.publisher(e.a), { workspaceId: w.id, expectedEpoch: 1, expectedHead: null, sourceRef: w.sourceRef });
    await hasEntered;

    let replaced = false;
    const replace = e.manager.replaceWriter(e.runner(e.a), w.id, 1).then((r) => { replaced = true; return r; });
    // The replacement must be waiting on the publisher's row lock, not merely slow.
    let waiting = 0;
    for (let i = 0; i < 40 && waiting === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      // Blocked by another backend, in this database, on the workspace row.
      waiting = Number((await e.db.pool.query<{ n: string }>("SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0 AND query ILIKE '%FOR UPDATE%' AND query ILIKE '%factory.workspace%'")).rows[0]?.n);
    }
    expect(waiting).toBeGreaterThan(0);
    expect(replaced).toBe(false);

    // An unrelated allocation heartbeat is not blocked while the push is in flight.
    await e.db.withTenant({ orgId: e.a.orgId }, async (tx) => {
      await tx.query("SET LOCAL lock_timeout = '500ms'");
      await tx.query('UPDATE factory.execution_allocation SET last_heartbeat_at = now(), controller_lease_until = now() + interval \'60 seconds\' WHERE id = $1', [allocationId]);
    });
    expect(replaced).toBe(false);

    release();
    expect(await push).toEqual({ outcome: 'updated', head: w.commit });
    expect(e.repoA.remoteRef(`refs/heads/${w.branch}`)).toBe(w.commit);
    expect(await replace).toMatchObject({ generation: 2, ownerEpoch: 2 });

    // Postgres clock: W-018 never writes a lease, so a publisher's row lock cannot make a healthy writer look dead.
    const leases = await e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query('SELECT count(*) FILTER (WHERE lease_until IS NOT NULL) AS n FROM factory.workspace'));
    expect(Number((leases.rows[0] as { n: string }).n)).toBe(0);

    // And the other order: the replacement commits first, so the push sees the new epoch and writes nothing.
    const w2 = await checkpointedWorkspace(e, e.a, e.repoA, 'race2');
    await e.manager.replaceWriter(e.runner(e.a), w2.id, 1);
    expect(await publisher().compareAndUpdateRef(e.publisher(e.a), { workspaceId: w2.id, expectedEpoch: 1, expectedHead: null, sourceRef: w2.sourceRef })).toEqual({ outcome: 'stale_epoch', currentEpoch: 2 });
    expect(e.repoA.remoteRef(`refs/heads/${w2.branch}`)).toBeNull();
  });

  it('slow pre-steps hold no lock: a replaceWriter is not blocked while the publisher is still preparing, and the publish then sees the new epoch', async () => {
    const w = await checkpointedWorkspace(e, e.a, e.repoA, 'prelock');
    let entered!: () => void; const hasEntered = new Promise<void>((r) => { entered = r; });
    let open!: () => void; const gate = new Promise<void>((r) => { open = r; });
    const pub = createPublisher({ db: e.db, artifacts: e.artifacts, publisherIdentity: PUB, scratchRoot: e.scratch, git: fileGit(), faults: { beforeLock: async () => { entered(); await gate; } } });
    const push = pub.compareAndUpdateRef(e.publisher(e.a), { workspaceId: w.id, expectedEpoch: 1, expectedHead: null, sourceRef: w.sourceRef });
    await hasEntered;
    const started = Date.now();
    expect(await e.manager.replaceWriter(e.runner(e.a), w.id, 1)).toMatchObject({ generation: 2 });
    expect(Date.now() - started).toBeLessThan(5_000); // nothing was holding the row
    open();
    expect(await push).toEqual({ outcome: 'stale_epoch', currentEpoch: 2 }); // re-checked under the lock
    expect(e.repoA.remoteRef(`refs/heads/${w.branch}`)).toBeNull();
  });

  it('concurrent publishes with a small pool do not deadlock (no second connection while the lock is held)', async () => {
    const small = Database.connect(e.m.runtimeUrl, 2);
    const smallArtifacts = new ArtifactService({ db: small, store: e.store, signingKey: Buffer.alloc(32, 7), downloadOrigin: 'http://127.0.0.1:1' });
    try {
      const ws = await Promise.all(Array.from({ length: 6 }, (_, i) => checkpointedWorkspace(e, e.a, e.repoA, `pool${String(i)}`)));
      const pub = createPublisher({ db: small, artifacts: smallArtifacts, publisherIdentity: PUB, scratchRoot: e.scratch, git: fileGit() });
      const results = await Promise.all(ws.map((w) => pub.compareAndUpdateRef(e.publisher(e.a), { workspaceId: w.id, expectedEpoch: 1, expectedHead: null, sourceRef: w.sourceRef })));
      expect(results.every((r) => r.outcome === 'updated')).toBe(true);
      for (const w of ws) expect(e.repoA.remoteRef(`refs/heads/${w.branch}`)).toBe(w.commit);
    } finally { await small.close(); }
  }, 60_000);

  it('concurrent publishes of one workspace and epoch use separate staging and neither fails', async () => {
    const w = await checkpointedWorkspace(e, e.a, e.repoA, 'same');
    const results = await Promise.all(Array.from({ length: 4 }, () => publisher().compareAndUpdateRef(e.publisher(e.a), { workspaceId: w.id, expectedEpoch: 1, expectedHead: null, sourceRef: w.sourceRef })));
    expect(results.every((r) => r.outcome === 'updated')).toBe(true); // the first lands it; the rest find it already landed
    expect(e.repoA.remoteRef(`refs/heads/${w.branch}`)).toBe(w.commit);
    expect(readdirSync(join(e.scratch, e.a.orgId, w.id))).toEqual([]);
  });

  // A push that is still running when the deadline passes, or when the session is lost, must not be able to
  // land afterwards: the whole Git process group is killed and waited for before the lock is released.
  it('a push past its deadline: the process group is gone before the transaction ends, the result says the outcome is unknown, and nothing lands after the fence', async () => {
    const w = await checkpointedWorkspace(e, e.a, e.repoA, 'deadline');
    const { git, pidFile } = slowPushGit(e.fx.dir('slow'), 2);
    let entered!: () => void; const hasEntered = new Promise<void>((r) => { entered = r; });
    let open!: () => void; const gate = new Promise<void>((r) => { open = r; });
    const pub = createPublisher({ db: e.db, artifacts: e.artifacts, publisherIdentity: PUB, scratchRoot: e.scratch, git, pushDeadlineMs: 400, faults: { afterEpochCheck: async () => { entered(); await gate; } } });
    const publish = pub.compareAndUpdateRef(e.publisher(e.a), { workspaceId: w.id, expectedEpoch: 1, expectedHead: null, sourceRef: w.sourceRef });
    await hasEntered;
    let fenced = false;
    const replace = e.manager.replaceWriter(e.runner(e.a), w.id, 1).then((r) => { fenced = true; return r; });
    await sleep(200);
    expect(fenced).toBe(false); // waiting on the publisher's lock
    open();
    expect(await publish).toEqual({ outcome: 'needs_reconciliation', expectedHead: null, actualHead: null, outcomeUnknown: true });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    expect(isAlive(pid)).toBe(false); // gone by the time the call returned, hence before the lock was released
    expect(await replace).toMatchObject({ generation: 2, ownerEpoch: 2 });
    await sleep(2_500); // longer than the push's own delay: had the child survived, it would have pushed by now
    expect(e.repoA.remoteRef(`refs/heads/${w.branch}`)).toBeNull();
  });

  it('control: the same slow push inside its deadline completes', async () => {
    const w = await checkpointedWorkspace(e, e.a, e.repoA, 'slow-ok');
    const { git } = slowPushGit(e.fx.dir('slow'), 1);
    const pub = createPublisher({ db: e.db, artifacts: e.artifacts, publisherIdentity: PUB, scratchRoot: e.scratch, git, pushDeadlineMs: 20_000 });
    expect(await pub.compareAndUpdateRef(e.publisher(e.a), { workspaceId: w.id, expectedEpoch: 1, expectedHead: null, sourceRef: w.sourceRef })).toEqual({ outcome: 'updated', head: w.commit });
  });

  it('abort path: the session is killed during a running push, so the publish rejects with the session\'s own error, the group is gone and the remote is unchanged', async () => {
    const w = await checkpointedWorkspace(e, e.a, e.repoA, 'killed');
    const { git, pidFile } = slowPushGit(e.fx.dir('slow'), 3);
    const pub = createPublisher({ db: e.db, artifacts: e.artifacts, publisherIdentity: PUB, scratchRoot: e.scratch, git });
    const publish = pub.compareAndUpdateRef(e.publisher(e.a), { workspaceId: w.id, expectedEpoch: 1, expectedHead: null, sourceRef: w.sourceRef });
    const outcome = publish.then(() => undefined, (err: unknown) => err as { code?: string; cause?: unknown });
    for (let i = 0; i < 100 && !existsSync(pidFile); i += 1) await sleep(50); // the push is running now
    expect(existsSync(pidFile)).toBe(true);
    const killed = await e.db.pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'"); // the publisher's session, parked while Git runs
    expect(killed.rowCount).toBe(1);
    const error = await outcome;
    expect(error).toMatchObject({ code: '57P01' }); // terminating connection due to administrator command
    expect(isAlive(Number(readFileSync(pidFile, 'utf8')))).toBe(false);
    await sleep(3_500);
    expect(e.repoA.remoteRef(`refs/heads/${w.branch}`)).toBeNull();
    expect(readdirSync(join(e.scratch, e.a.orgId, w.id))).toEqual([]);
    // Control: the workspace publishes once nothing kills the session.
    expect(await publisher().compareAndUpdateRef(e.publisher(e.a), { workspaceId: w.id, expectedEpoch: 1, expectedHead: null, sourceRef: w.sourceRef })).toMatchObject({ outcome: 'updated' });
  }, 30_000);

  it('the push deadline must stay below the idle-in-transaction timeout', () => {
    expect(() => createPublisher({ db: e.db, artifacts: e.artifacts, publisherIdentity: PUB, scratchRoot: e.scratch, pushDeadlineMs: IDLE_IN_TRANSACTION_MS })).toThrow();
  });
});
