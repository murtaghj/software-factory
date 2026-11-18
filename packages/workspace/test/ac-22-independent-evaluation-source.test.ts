// AC-22, the source half: an independent, fixed, digest-verified copy of a candidate. The canonical
// test package mount is W-022.
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveWorkspaceId } from '../src/index.ts';
import { checkpointedWorkspace, createEnv, generationDir, registerCandidate, snapshotTree, treeDigestOf, type Env } from './harness.ts';

let e: Env;
beforeAll(async () => { e = await createEnv('w018_ac22'); });
afterAll(async () => { await e.close(); });

const inodes = (dir: string): Set<string> => {
  const out = new Set<string>();
  const walk = (d: string): void => { for (const n of readdirSync(d)) { const p = join(d, n); const s = lstatSync(p); if (s.isDirectory()) walk(p); else out.add(`${String(s.dev)}:${String(s.ino)}`); } };
  walk(dir);
  return out;
};
const shared = (a: Set<string>, b: Set<string>): string[] => [...a].filter((x) => b.has(x));
const workspaceRows = (orgId: string, ids: string[]) => e.db.withTenant({ orgId }, async (tx) => (await tx.query('SELECT id FROM factory.workspace WHERE id = ANY($1)', [ids])).rowCount);

async function candidateOf(name: string, over: { digest?: string; bundle?: Buffer } = {}) {
  const author = await checkpointedWorkspace(e, e.a, e.repoA, name);
  const digest = treeDigestOf(e.fx, e.repoA.work, author.commit);
  const cand = await registerCandidate(e, e.a, e.repoA, over.digest ?? digest, e.a.stages.implementer, over.bundle);
  return { author, digest, cand, binding: { stageRunId: e.a.stages.verifier, setupProfileRef: await e.setupRef(e.a) } };
}

describe('AC-22 independent evaluation source', () => {
  it('the verifier copy has its own object store and no alternates, shares no inode with the author workspace or the remote, and survives deleting both', async () => {
    const { author, digest, cand, binding } = await candidateOf('src1');
    const [ws] = await e.manager.materializeCandidate(e.runner(e.a), cand.manifestRef, 'verifier', binding);
    expect(ws).toMatchObject({ role: 'verifier', state: 'allocated', baseCommit: e.repoA.base, candidateCommit: author.commit, generation: 1, ownerEpoch: 1, stageRunId: e.a.stages.verifier });
    expect(ws?.branch).toBeUndefined();
    const out = await e.host.ensureMaterialized(e.runner(e.a), ws?.id ?? '');
    expect(out).toMatchObject({ outcome: 'materialized', receipt: { headCommit: author.commit, treeDigest: digest } });

    const copy = generationDir(e, e.a, ws?.id ?? '', 1);
    const authorDir = generationDir(e, e.a, author.id, 1);
    expect(existsSync(join(copy, 'git/.git/objects/info/alternates'))).toBe(false);
    expect(e.fx.git(join(copy, 'work/main'), ['rev-parse', '--git-common-dir']).trim().endsWith(`/${ws?.id ?? ''}/g1/git/.git`)).toBe(true); // its own common directory
    expect(e.fx.git(join(copy, 'work/main'), ['rev-parse', 'HEAD']).trim()).toBe(author.commit);
    expect(e.fx.git(join(copy, 'work/main'), ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('HEAD'); // detached: never a branch name
    expect(shared(inodes(copy), inodes(authorDir))).toEqual([]);
    expect(shared(inodes(copy), inodes(e.repoA.bare))).toEqual([]);
    expect(shared(inodes(copy), inodes(e.repoA.work))).toEqual([]);

    // Control: a plain local clone in the very same directories does share inodes, so the check above is not vacuous.
    const plain = join(e.fx.dir('plain'), 'clone');
    e.fx.git(e.fx.base, ['clone', '--quiet', e.repoA.bare, plain]);
    expect(shared(inodes(plain), inodes(e.repoA.bare)).length).toBeGreaterThan(0);

    // Editing the author's test copy after freeze changes nothing in the verifier's copy.
    const before = snapshotTree(copy);
    writeFileSync(join(authorDir, 'work/main/src/app.txt'), 'edited after freeze');
    expect(snapshotTree(copy)).toBe(before);

    // Deleting the author's workspace and the remote leaves the copy complete.
    rmSync(authorDir, { recursive: true, force: true });
    rmSync(e.repoA.bare, { recursive: true, force: true });
    expect(e.fx.git(join(copy, 'git'), ['fsck', '--full', '--strict']).length).toBeGreaterThanOrEqual(0);
    expect(e.fx.git(join(copy, 'work/main'), ['status', '--porcelain']).trim()).toBe('');
    expect(e.fx.git(join(copy, 'work/main'), ['cat-file', '-t', author.commit]).trim()).toBe('commit');
    // Restore the remote for later tests.
    e.fx.git(e.fx.base, ['init', '--quiet', '--bare', '--initial-branch=main', e.repoA.bare]);
    e.fx.git(e.repoA.work, ['push', '--quiet', e.repoA.bare, 'main']);
  });

  it('a wrong treeDigest and a thin bundle are refused, and nothing is left behind', async () => {
    const wrong = await candidateOf('src2', { digest: 'f'.repeat(64) });
    const [w1] = await e.manager.materializeCandidate(e.runner(e.a), wrong.cand.manifestRef, 'verifier', wrong.binding);
    await expect(e.host.ensureMaterialized(e.runner(e.a), w1?.id ?? '')).rejects.toMatchObject({ code: 'tree_digest_mismatch' });
    expect(readdirSync(join(e.root, e.a.orgId, w1?.id ?? '')).filter((n) => !n.startsWith('.'))).toEqual([]);
    expect(existsSync(join(e.root, e.a.orgId, w1?.id ?? '', '.staging-g1'))).toBe(false);

    const thin = await candidateOf('src3', { bundle: e.repoA.thinBundle() });
    const [w2] = await e.manager.materializeCandidate(e.runner(e.a), thin.cand.manifestRef, 'verifier', thin.binding);
    await expect(e.host.ensureMaterialized(e.runner(e.a), w2?.id ?? '')).rejects.toMatchObject({ code: 'thin_bundle' });
    expect(existsSync(generationDir(e, e.a, w2?.id ?? '', 1))).toBe(false);
    expect((await e.manager.materializationRequest(e.runner(e.a), w2?.id ?? '', 1)).ok).toBe(true); // still allocated, no receipt
  });

  it('retry: materializeCandidate twice gives the same ids, rows and directories; a changed role gets different ones', async () => {
    const { cand, binding, author } = await candidateOf('src4');
    const first = await e.manager.materializeCandidate(e.runner(e.a), cand.manifestRef, 'verifier', binding);
    const second = await e.manager.materializeCandidate(e.runner(e.a), cand.manifestRef, 'verifier', binding);
    expect(second).toEqual(first);
    const id = first[0]?.id ?? '';
    expect(id).toBe(deriveWorkspaceId(e.a.orgId, cand.candidateId, e.a.repositoryId, 'verifier', e.a.stages.verifier));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await workspaceRows(e.a.orgId, [id])).toBe(1);
    await e.host.ensureMaterialized(e.runner(e.a), id);
    const again = await e.manager.materializeCandidate(e.runner(e.a), cand.manifestRef, 'verifier', binding);
    expect(again[0]?.id).toBe(id);
    expect(await e.host.ensureMaterialized(e.runner(e.a), id)).toEqual({ outcome: 'unchanged', reason: 'not_materializable' });
    expect(readdirSync(join(e.root, e.a.orgId, id))).toEqual(['g1']);
    expect(e.fx.git(join(generationDir(e, e.a, id, 1), 'work/main'), ['rev-parse', 'HEAD']).trim()).toBe(author.commit);
    // Same candidate, same stage run, different binding profile: the existing row is not silently re-pointed.
    await expect(e.manager.materializeCandidate(e.runner(e.a), cand.manifestRef, 'verifier', { ...binding, setupProfileRef: await e.setupRef(e.a).then((r) => ({ ...r, sizeBytes: r.sizeBytes + 1 })) })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('no binding, or a binding to the author\'s stage run, a wrong role, or a stage of another task is refused', async () => {
    const { cand, binding } = await candidateOf('src5');
    const ctx = e.runner(e.a);
    await expect(e.manager.materializeCandidate(ctx, cand.manifestRef, 'verifier')).rejects.toMatchObject({ code: 'verifier_binding_required' });
    await expect(e.manager.materializeCandidate(ctx, cand.manifestRef, 'verifier', { ...binding, stageRunId: e.a.stages.implementer })).rejects.toMatchObject({ code: 'binding_mismatch' });
    await expect(e.manager.materializeCandidate(ctx, cand.manifestRef, 'reviewer', binding)).rejects.toMatchObject({ code: 'binding_mismatch' }); // verifier stage, reviewer role
    await expect(e.manager.materializeCandidate(ctx, cand.manifestRef, 'verifier', { ...binding, stageRunId: e.b.stages.verifier })).rejects.toMatchObject({ code: 'binding_mismatch' });
    await expect(e.manager.materializeCandidate(ctx, cand.manifestRef, 'verifier', { ...binding, stageRunId: `task-${randomUUID()}/plan-1/verify/attempt-1` })).rejects.toMatchObject({ code: 'binding_mismatch' });
    await expect(e.manager.materializeCandidate(ctx, { ...cand.manifestRef, artifactId: randomUUID() }, 'verifier', binding)).rejects.toMatchObject({ code: 'not_found' });
    const reviewer = await e.manager.materializeCandidate(ctx, cand.manifestRef, 'reviewer', { ...binding, stageRunId: e.a.stages.reviewer });
    expect(reviewer[0]?.id).not.toBe((await e.manager.materializeCandidate(ctx, cand.manifestRef, 'verifier', binding))[0]?.id);
  });

  it('acceptMaterialization checks a candidate copy\'s receipt against the manifest', async () => {
    const { author, digest, cand, binding } = await candidateOf('src6');
    const [ws] = await e.manager.materializeCandidate(e.runner(e.a), cand.manifestRef, 'verifier', binding);
    const id = ws?.id ?? '';
    const receipt = { generation: 1, headCommit: author.commit, treeDigest: digest, gitVersion: 'git version 2.50.1' };
    await expect(e.manager.acceptMaterialization(e.runner(e.a), id, 1, { ...receipt, treeDigest: 'e'.repeat(64) })).rejects.toMatchObject({ code: 'receipt_mismatch' });
    await expect(e.manager.acceptMaterialization(e.runner(e.a), id, 1, { ...receipt, headCommit: e.repoA.base })).rejects.toMatchObject({ code: 'receipt_mismatch' });
    await e.manager.acceptMaterialization(e.runner(e.a), id, 1, receipt); // control: the manifest's own digest is accepted
    expect(await e.manager.materializationRequest(e.runner(e.a), id, 1)).toEqual({ ok: false, code: 'not_materializable' });
  });

  it('a caller scoped to another task cannot read this candidate or make reviewer rows for it', async () => {
    const { cand, binding } = await candidateOf('src7');
    const other = { ...e.runner(e.a), taskId: randomUUID() };
    await expect(e.manager.materializeCandidate(other, cand.manifestRef, 'verifier', binding)).rejects.toMatchObject({ code: 'forbidden' });
    const rows = await e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query("SELECT 1 FROM factory.artifact_link WHERE purpose LIKE 'workspace_candidate/%' AND candidate_id = $1", [cand.candidateId]));
    expect(rows.rowCount).toBe(0);
  });
});
