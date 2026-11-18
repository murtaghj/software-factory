import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalMaterializer, LocalWorkspaceHost, createWorkspaceManager } from '../src/index.ts';
import { checkpointedWorkspace, createEnv, fileGit, generationDir, specFor, RUNNER, type Env, type Tenant } from './harness.ts';

let e: Env;
beforeAll(async () => { e = await createEnv('w018_alloc'); });
afterAll(async () => { await e.close(); });

async function allocate(t: Tenant, repoBase: string, over: Record<string, unknown> = {}) {
  const id = randomUUID();
  const spec = specFor(t, await e.setupRef(t), repoBase, over);
  const rec = await e.manager.allocateOrAttach(e.runner(t), id, spec);
  return { id, spec, rec };
}
const linkCount = (t: Tenant, purpose: string) => e.db.withTenant({ orgId: t.orgId }, async (tx) =>
  Number((await tx.query<{ n: string }>('SELECT count(*) AS n FROM factory.artifact_link WHERE purpose = $1', [purpose])).rows[0]?.n));
const rowCount = (t: Tenant, id: string) => e.db.withTenant({ orgId: t.orgId }, async (tx) => (await tx.query('SELECT 1 FROM factory.workspace WHERE id = $1', [id])).rowCount);
const stateOf = (t: Tenant, id: string) => e.db.withTenant({ orgId: t.orgId }, async (tx) => (await tx.query<{ state: string; generation: number; owner_epoch: string }>('SELECT state, generation, owner_epoch FROM factory.workspace WHERE id = $1', [id])).rows[0]);

describe('W-018 allocate, materialize, release', () => {
  it('allocateOrAttach is idempotent and a changed field is a conflict that changes nothing', async () => {
    const { id, spec, rec } = await allocate(e.a, e.repoA.base);
    expect(rec).toMatchObject({ id, state: 'allocated', generation: 1, ownerEpoch: 1, baseCommit: e.repoA.base, role: 'implementer', stageRunId: e.a.stages.implementer });
    expect(await e.manager.allocateOrAttach(e.runner(e.a), id, spec)).toEqual(rec);
    const other = e.repoA.commit({ 'x.txt': 'x' });
    for (const change of [{ baseCommit: other }, { role: 'reviewer' as const }, { branch: `factory/${e.a.taskId}/other` }, { setupProfileRef: await e.setupRef(e.a).then((r) => ({ ...r, sizeBytes: r.sizeBytes + 1 })) }]) {
      await expect(e.manager.allocateOrAttach(e.runner(e.a), id, { ...spec, ...change })).rejects.toMatchObject({ code: 'conflict' });
    }
    expect(await e.manager.allocateOrAttach(e.runner(e.a), id, spec)).toEqual(rec);
    expect(rec.setupProfileRef).toEqual(spec.setupProfileRef);
  });

  it('materializes into g1/{git,work/main} on the task branch, records one receipt, and the manager touched no filesystem', async () => {
    const { id } = await allocate(e.a, e.repoA.base);
    expect(existsSync(join(e.root, e.a.orgId, id))).toBe(false); // allocateOrAttach does no filesystem work
    const req = await e.manager.materializationRequest(e.runner(e.a), id, 1);
    expect(req).toMatchObject({ ok: true, request: { kind: 'remote', cloneUrl: e.repoA.bare, commit: e.repoA.base, branch: `factory/${e.a.taskId}/main`, subpath: '', target: { orgId: e.a.orgId, workspaceId: id, generation: 1 } } });
    const out = await e.host.ensureMaterialized(e.runner(e.a), id);
    expect(out).toMatchObject({ outcome: 'materialized', receipt: { generation: 1, headCommit: e.repoA.base } });
    const g1 = generationDir(e, e.a, id, 1);
    expect(readFileSync(join(g1, 'work/main/README.md'), 'utf8')).toBe('hello\n');
    expect(e.fx.git(join(g1, 'work/main'), ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(`factory/${e.a.taskId}/main`);
    expect(e.fx.git(join(g1, 'work/main'), ['rev-parse', 'HEAD']).trim()).toBe(e.repoA.base);
    expect(await linkCount(e.a, `workspace_materialization/${id}/g1`)).toBe(1);
    expect(await e.manager.materializationRequest(e.runner(e.a), id, 1)).toEqual({ ok: false, code: 'not_materializable' });
    await expect(e.manager.materializationRequest(e.runner(e.a), id, 2)).rejects.toMatchObject({ code: 'stale_epoch' });
    expect(readdirSync(join(e.root, e.a.orgId, id))).toEqual(['g1']);
  });

  it('acceptMaterialization: same receipt is a no-op, a different one conflicts, a wrong commit or generation is refused, non-runner is forbidden and audited', async () => {
    const { id } = await allocate(e.a, e.repoA.base);
    const rec = e.runner(e.a);
    const receipt = { generation: 1, headCommit: e.repoA.base, treeDigest: 'a'.repeat(64), gitVersion: 'git version 2.50.1' };
    await expect(e.manager.acceptMaterialization(rec, id, 1, { ...receipt, headCommit: 'b'.repeat(40) })).rejects.toMatchObject({ code: 'receipt_mismatch' });
    await expect(e.manager.acceptMaterialization(rec, id, 1, { ...receipt, generation: 2 })).rejects.toMatchObject({ code: 'receipt_mismatch' });
    await expect(e.manager.acceptMaterialization(rec, id, 7, receipt)).rejects.toMatchObject({ code: 'stale_epoch' });
    await expect(e.manager.acceptMaterialization(e.ctxFor(e.a, 'someone-else'), id, 1, receipt)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await linkCount(e.a, `workspace_materialization/${id}/g1`)).toBe(0);
    await e.manager.acceptMaterialization(rec, id, 1, receipt);
    await e.manager.acceptMaterialization(rec, id, 1, receipt);
    expect(await linkCount(e.a, `workspace_materialization/${id}/g1`)).toBe(1);
    await expect(e.manager.acceptMaterialization(rec, id, 1, { ...receipt, treeDigest: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'conflict' });
    const audit = await e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query("SELECT outcome FROM factory.audit_event WHERE resource_id = $1 AND action = 'workspace.accept_materialization'", [id]));
    expect(audit.rows).toEqual([{ outcome: 'denied' }]);
  });

  it('markWriterStarted needs the runner identity, an accepted receipt and the current epoch; it is the one transition that ends allocated', async () => {
    const { id } = await allocate(e.a, e.repoA.base);
    await expect(e.manager.markWriterStarted(e.runner(e.a), id, 1, 'pod-1')).rejects.toMatchObject({ code: 'invalid_state' }); // no receipt yet
    await e.host.ensureMaterialized(e.runner(e.a), id);
    await expect(e.manager.markWriterStarted(e.ctxFor(e.a, 'pod-self'), id, 1, 'pod-1')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(e.manager.markWriterStarted(e.runner(e.a), id, 9, 'pod-1')).rejects.toMatchObject({ code: 'stale_epoch' });
    expect(await e.manager.markWriterStarted(e.runner(e.a), id, 1, 'pod-1')).toMatchObject({ state: 'active' });
    expect((await stateOf(e.a, id))?.state).toBe('active');
    // From here the directory is candidate-writable: no further materialization is offered.
    expect(await e.host.ensureMaterialized(e.runner(e.a), id)).toEqual({ outcome: 'unchanged', reason: 'not_materializable' });
  });

  it('twelve concurrent ensureMaterialized calls give one row, one directory, one receipt and no staging path (one clone ran)', async () => {
    let clones = 0;
    const git = fileGit({ onRun: (args) => { if (args[0] === 'clone') clones += 1; } });
    const mine = e.newManager({ git });
    const { id } = await allocate(e.a, e.repoA.base);
    const results = await Promise.all(Array.from({ length: 12 }, () => mine.host.ensureMaterialized(e.runner(e.a), id)));
    expect(results.filter((r) => r.outcome === 'materialized')).toHaveLength(1);
    expect(clones).toBe(1);
    expect(await rowCount(e.a, id)).toBe(1);
    expect(await linkCount(e.a, `workspace_materialization/${id}/g1`)).toBe(1);
    expect(readdirSync(join(e.root, e.a.orgId, id))).toEqual(['g1']);
    expect(existsSync(join(e.root, e.a.orgId, id, '.staging-g1'))).toBe(false);
  });

  // Each ordering is forced, not hoped for: the host's fault point holds the row lock between the
  // materialization and the accept, so a release has to queue behind it.
  describe('materialize against a concurrent release, in each ordering', () => {
    const gateHost = () => {
      let entered!: () => void; const hasEntered = new Promise<void>((r) => { entered = r; });
      let open!: () => void; const gate = new Promise<void>((r) => { open = r; });
      const materializer = new LocalMaterializer({ root: e.root, git: fileGit() });
      const manager = createWorkspaceManager({ db: e.db, artifacts: e.artifacts, runnerIdentity: RUNNER, materializer });
      const host = new LocalWorkspaceHost({ db: e.db, manager, materializer, faults: { afterMaterialize: async () => { entered(); await gate; } } });
      return { host, hasEntered, open };
    };

    it('release first: the host then sees `releasing` and does nothing, so no directory ever exists', async () => {
      const { id } = await allocate(e.a, e.repoA.base);
      expect(await e.manager.release(e.runner(e.a), id, 1)).toEqual({ state: 'released' });
      const after = await Promise.all(Array.from({ length: 6 }, () => e.host.ensureMaterialized(e.runner(e.a), id)));
      expect(after.every((r) => r.outcome === 'unchanged')).toBe(true);
      expect(existsSync(generationDir(e, e.a, id, 1))).toBe(false);
      expect(await linkCount(e.a, `workspace_materialization/${id}/g1`)).toBe(0);
      expect((await stateOf(e.a, id))?.state).toBe('released');
    });

    it('materialize first: the release waits for the row lock, then removes a complete directory', async () => {
      const { host, hasEntered, open } = gateHost();
      const { id } = await allocate(e.a, e.repoA.base);
      const ensures = Array.from({ length: 6 }, () => host.ensureMaterialized(e.runner(e.a), id));
      await hasEntered; // the directory exists, the receipt is not yet accepted, the lock is held
      expect(existsSync(generationDir(e, e.a, id, 1))).toBe(true);
      let released = false;
      const release = e.manager.release(e.runner(e.a), id, 1).then((r) => { released = true; return r; });
      await new Promise((r) => setTimeout(r, 400));
      expect(released).toBe(false); // queued behind the host's lock
      expect((await stateOf(e.a, id))?.state).toBe('allocated');
      open();
      const results = await Promise.all(ensures);
      expect(results.filter((r) => r.outcome === 'materialized')).toHaveLength(1);
      expect(await release).toEqual({ state: 'released' });
      expect(existsSync(generationDir(e, e.a, id, 1))).toBe(false);
      expect(existsSync(join(e.root, e.a.orgId, id, '.staging-g1'))).toBe(false);
      expect(await linkCount(e.a, `workspace_materialization/${id}/g1`)).toBe(1); // it was materialized, then released
      expect((await stateOf(e.a, id))?.state).toBe('released');
    });

    it('a release that commits between two ensure calls: the second sees `releasing` and creates nothing', async () => {
      const { id } = await allocate(e.a, e.repoA.base);
      expect(await e.host.ensureMaterialized(e.runner(e.a), id)).toMatchObject({ outcome: 'materialized' });
      expect(await e.manager.release(e.runner(e.a), id, 1)).toEqual({ state: 'released' });
      expect(await e.host.ensureMaterialized(e.runner(e.a), id)).toMatchObject({ outcome: 'unchanged' });
      expect(existsSync(generationDir(e, e.a, id, 1))).toBe(false);
    });
  });

  it('a crash between rename and accept is repaired on the next call', async () => {
    // A real crash cannot clean up after itself, so the leftover is made by running the materializer alone.
    const { id } = await allocate(e.a, e.repoA.base);
    const req = await e.manager.materializationRequest(e.runner(e.a), id, 1);
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    expect(await e.materializer.materialize(req.request)).toMatchObject({ ok: true }); // renamed into place, never accepted
    const g1 = generationDir(e, e.a, id, 1);
    expect(existsSync(g1)).toBe(true);
    expect(await linkCount(e.a, `workspace_materialization/${id}/g1`)).toBe(0);
    writeFileSync(join(g1, 'stale-marker'), 'left by the crashed attempt');
    expect(await e.host.ensureMaterialized(e.runner(e.a), id)).toMatchObject({ outcome: 'materialized' });
    expect(existsSync(join(g1, 'stale-marker'))).toBe(false);
    expect(readFileSync(join(g1, 'work/main/README.md'), 'utf8')).toBe('hello\n');
    expect(await linkCount(e.a, `workspace_materialization/${id}/g1`)).toBe(1);
  });

  it('any failure after the directory is moved into place removes it before the error leaves', async () => {
    let fail = true;
    const materializer = new LocalMaterializer({ root: e.root, git: fileGit() });
    const manager = createWorkspaceManager({ db: e.db, artifacts: e.artifacts, runnerIdentity: RUNNER, materializer });
    const host = new LocalWorkspaceHost({ db: e.db, manager, materializer, faults: { afterMaterialize: () => { if (fail) { fail = false; throw new Error('boom after rename'); } } } });
    const { id } = await allocate(e.a, e.repoA.base);
    await expect(host.ensureMaterialized(e.runner(e.a), id)).rejects.toThrow('boom after rename');
    expect(existsSync(generationDir(e, e.a, id, 1))).toBe(false);
    expect(await host.ensureMaterialized(e.runner(e.a), id)).toMatchObject({ outcome: 'materialized' });
  });

  it('a materializer given an existing target refuses and runs no Git', async () => {
    const ran: string[][] = [];
    const m = new LocalMaterializer({ root: e.root, git: fileGit({ onRun: (a) => ran.push([...a]) }) });
    const target = { orgId: e.a.orgId, workspaceId: randomUUID(), generation: 1 };
    const dir = join(e.root, target.orgId, target.workspaceId, 'g1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'precious'), 'do not touch');
    const r = await m.materialize({ kind: 'remote', target, taskId: e.a.taskId, cloneUrl: e.repoA.bare, commit: e.repoA.base, subpath: '' });
    expect(r).toMatchObject({ ok: false, code: 'target_exists' });
    expect(ran).toEqual([]);
    expect(readFileSync(join(dir, 'precious'), 'utf8')).toBe('do not touch');
  });

  it('two organizations never share a directory or an inode', async () => {
    const a = await allocate(e.a, e.repoA.base);
    const b = await allocate(e.b, e.repoB.base);
    await e.host.ensureMaterialized(e.runner(e.a), a.id);
    await e.host.ensureMaterialized(e.runner(e.b), b.id);
    const inodes = (dir: string): Set<string> => {
      const out = new Set<string>();
      const walk = (d: string): void => { for (const n of readdirSync(d)) { const p = join(d, n); const s = lstatSync(p); if (s.isDirectory()) walk(p); else out.add(`${String(s.dev)}:${String(s.ino)}`); } };
      walk(dir);
      return out;
    };
    const ia = inodes(join(e.root, e.a.orgId)), ib = inodes(join(e.root, e.b.orgId));
    expect(ia.size).toBeGreaterThan(5);
    expect([...ia].filter((x) => ib.has(x))).toEqual([]);
    expect(generationDir(e, e.a, a.id, 1).startsWith(join(e.root, e.a.orgId))).toBe(true);
    expect(generationDir(e, e.b, b.id, 1).startsWith(join(e.root, e.a.orgId))).toBe(false);
    // The clone is its own copy: no object file of the workspace shares an inode with the remote.
    const remote = inodes(e.repoA.bare);
    expect([...ia].filter((x) => remote.has(x))).toEqual([]);
  });

  it('worktree links are relative and survive moving the generation directory', async () => {
    const { id } = await allocate(e.a, e.repoA.base);
    await e.host.ensureMaterialized(e.runner(e.a), id);
    const g1 = generationDir(e, e.a, id, 1);
    const link = readFileSync(join(g1, 'work/main/.git'), 'utf8').trim();
    expect(link).toBe('gitdir: ../../git/.git/worktrees/main');
    expect(readFileSync(join(g1, 'git/.git/worktrees/main/gitdir'), 'utf8').trim().startsWith('/')).toBe(false);
    const moved = join(e.root, 'moved-' + id);
    renameSync(g1, moved);
    expect(e.fx.git(join(moved, 'work/main'), ['status', '--porcelain']).trim()).toBe('');
    expect(e.fx.git(join(moved, 'work/main'), ['rev-parse', 'HEAD']).trim()).toBe(e.repoA.base);
  });

  it('release: an active row is refused; an allocated, materialized one is removed and proved absent; again is idempotent; no materializer leaves it releasing', async () => {
    const live = await allocate(e.a, e.repoA.base);
    await e.host.ensureMaterialized(e.runner(e.a), live.id);
    await e.manager.markWriterStarted(e.runner(e.a), live.id, 1, 'pod-9');
    await expect(e.manager.release(e.runner(e.a), live.id, 1)).rejects.toMatchObject({ code: 'writer_active' });
    expect((await stateOf(e.a, live.id))?.state).toBe('active');
    expect(existsSync(generationDir(e, e.a, live.id, 1))).toBe(true);

    const idle = await allocate(e.a, e.repoA.base);
    await e.host.ensureMaterialized(e.runner(e.a), idle.id);
    await expect(e.manager.release(e.runner(e.a), idle.id, 5)).rejects.toMatchObject({ code: 'stale_epoch' });
    expect(await e.manager.release(e.runner(e.a), idle.id, 1)).toEqual({ state: 'released' });
    expect(existsSync(generationDir(e, e.a, idle.id, 1))).toBe(false);
    expect(await e.manager.release(e.runner(e.a), idle.id, 1)).toEqual({ state: 'released' });

    const bare = createWorkspaceManager({ db: e.db, artifacts: e.artifacts, runnerIdentity: RUNNER });
    const orphan = await allocate(e.a, e.repoA.base);
    expect(await bare.release(e.runner(e.a), orphan.id, 1)).toEqual({ state: 'releasing', needsOperator: true });
    expect((await stateOf(e.a, orphan.id))?.state).toBe('releasing');
  });

  it('checkpoint and restore are not supported until W-020, and a released or unknown workspace is not found', async () => {
    const { id } = await allocate(e.a, e.repoA.base);
    await expect(e.manager.checkpoint(e.runner(e.a), id, 1)).rejects.toMatchObject({ code: 'not_supported' });
    await expect(e.manager.restore(e.runner(e.a), { artifactId: randomUUID(), sha256: 'a'.repeat(64), mediaType: 'x/y', schemaVersion: '1.0', sizeBytes: 1 }, 1, 1)).rejects.toMatchObject({ code: 'not_supported' });
    await expect(e.manager.release(e.runner(e.a), randomUUID(), 1)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('a database session lost during a held materialization', () => {
  it('leaves no directory, gives the session\'s own error, and the next call materializes normally', async () => {
    const materializer = new LocalMaterializer({ root: e.root, git: fileGit() });
    const manager = createWorkspaceManager({ db: e.db, artifacts: e.artifacts, runnerIdentity: RUNNER, materializer });
    let kill = true;
    const host = new LocalWorkspaceHost({ db: e.db, manager, materializer, faults: { afterMaterialize: async () => {
      if (!kill) return;
      kill = false;
      expect(existsSync(generationDir(e, e.a, id, 1))).toBe(true); // renamed into place, lock still held
      const r = await e.db.pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'");
      expect(r.rowCount).toBe(1);
      await new Promise((res) => setTimeout(res, 300));
    } } });
    const { id } = await allocate(e.a, e.repoA.base);
    await expect(host.ensureMaterialized(e.runner(e.a), id)).rejects.toMatchObject({ code: '57P01' });
    expect(existsSync(generationDir(e, e.a, id, 1))).toBe(false); // a lost lock leaves no live g1 behind
    expect(existsSync(join(e.root, e.a.orgId, id, '.staging-g1'))).toBe(false);
    expect(await linkCount(e.a, `workspace_materialization/${id}/g1`)).toBe(0);
    expect((await stateOf(e.a, id))?.state).toBe('allocated');
    expect(await host.ensureMaterialized(e.runner(e.a), id)).toMatchObject({ outcome: 'materialized' }); // control
  });
});

describe('identity and task scope on every call', () => {
  const impostor = () => e.ctxFor(e.a, 'service:someone-else');
  const wrongTask = () => ({ ...e.runner(e.a), taskId: randomUUID() });
  const denied = (id: string) => e.db.withTenant({ orgId: e.a.orgId }, async (tx) => Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM factory.audit_event WHERE resource_id = $1 AND outcome = 'denied'", [id])).rows[0]?.n));

  it('a caller that is not the runner is refused, and audited, on every call that changes or reads workspace state', async () => {
    const { id, spec } = await allocate(e.a, e.repoA.base);
    await e.host.ensureMaterialized(e.runner(e.a), id);
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['allocateOrAttach', () => e.manager.allocateOrAttach(impostor(), id, spec)],
      ['materializationRequest', () => e.manager.materializationRequest(impostor(), id, 1)],
      ['acceptMaterialization', () => e.manager.acceptMaterialization(impostor(), id, 1, { generation: 1, headCommit: e.repoA.base, treeDigest: 'a'.repeat(64), gitVersion: 'x' })],
      ['markWriterStarted', () => e.manager.markWriterStarted(impostor(), id, 1, 'pod')],
      ['replaceWriter', () => e.manager.replaceWriter(impostor(), id, 1)],
      ['release', () => e.manager.release(impostor(), id, 1)],
      ['materializeCandidate', () => e.manager.materializeCandidate(impostor(), { artifactId: randomUUID(), sha256: 'a'.repeat(64), mediaType: 'x/y', schemaVersion: '1.0', sizeBytes: 1 }, 'verifier', { stageRunId: e.a.stages.verifier, setupProfileRef: spec.setupProfileRef })],
      ['ensureMaterialized', () => e.host.ensureMaterialized(impostor(), id)],
    ];
    for (const [name, call] of calls) await expect(call(), name).rejects.toMatchObject({ code: 'forbidden' });
    expect(await denied(id)).toBe(6); // the six manager calls that name the workspace
    expect((await stateOf(e.a, id))).toMatchObject({ state: 'allocated', generation: 1 });
    expect(existsSync(generationDir(e, e.a, id, 1))).toBe(true); // nothing was removed or fenced
    expect(await e.manager.replaceWriter(e.runner(e.a), id, 1)).toMatchObject({ generation: 2 }); // control: the runner can
  });

  it('a caller scoped to another task cannot touch this task\'s workspace, and allocateOrAttach needs a task scope at all', async () => {
    const { id, spec } = await allocate(e.a, e.repoA.base);
    await e.host.ensureMaterialized(e.runner(e.a), id);
    for (const [name, call] of [
      ['materializationRequest', () => e.manager.materializationRequest(wrongTask(), id, 1)],
      ['markWriterStarted', () => e.manager.markWriterStarted(wrongTask(), id, 1, 'pod')],
      ['replaceWriter', () => e.manager.replaceWriter(wrongTask(), id, 1)],
      ['release', () => e.manager.release(wrongTask(), id, 1)],
      ['allocateOrAttach', () => e.manager.allocateOrAttach(wrongTask(), id, spec)],
      ['ensureMaterialized', () => e.host.ensureMaterialized(wrongTask(), id)],
    ] as const) await expect(call(), name).rejects.toMatchObject({ code: 'forbidden' });
    const unscoped = e.runner(e.a);
    Reflect.deleteProperty(unscoped, 'taskId');
    await expect(e.manager.allocateOrAttach(unscoped, id, spec)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await stateOf(e.a, id))?.state).toBe('allocated');
  });

  it('release of a checkpointed or retained copy needs an accepted, retained checkpoint (until W-020 builds the full check)', async () => {
    const bare = await checkpointedWorkspace(e, e.a, e.repoA, 'rel-noref');
    await expect(e.manager.release(e.runner(e.a), bare.id, 1)).rejects.toMatchObject({ code: 'checkpoint_not_accepted' });
    expect(existsSync(generationDir(e, e.a, bare.id, 1))).toBe(true);
    expect((await stateOf(e.a, bare.id))?.state).toBe('checkpointed');
    const accepted = await checkpointedWorkspace(e, e.a, e.repoA, 'rel-ref', { accepted: true });
    expect(await e.manager.release(e.runner(e.a), accepted.id, 1)).toEqual({ state: 'released' });
    expect(existsSync(generationDir(e, e.a, accepted.id, 1))).toBe(false);
  });
});
