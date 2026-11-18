// AC-38, the local ref half: a person's push to the task branch is never overwritten by the
// publisher. Publishing through a real provider is W-030.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transitionWorkspace } from '@factory/database';
import { createPublisher } from '../src/index.ts';
import { checkpointedWorkspace, createEnv, fileGit, specFor, type Env } from './harness.ts';
import { randomUUID } from 'node:crypto';

let e: Env;
const pushes: string[][] = [];
const git = fileGit({ onRun: (a) => { if (a.includes('push')) pushes.push([...a]); } });
let publisher: ReturnType<typeof createPublisher>;
beforeAll(async () => {
  e = await createEnv('w018_ac38');
  publisher = createPublisher({ db: e.db, artifacts: e.artifacts, publisherIdentity: 'service:git-publisher', scratchRoot: e.scratch, git });
});
afterAll(async () => { await e.close(); });

// A person commits on top of the base and pushes to the task branch.
function humanPush(branch: string): string {
  e.fx.git(e.repoA.work, ['checkout', '--quiet', '-B', `human-${branch.replace(/\//g, '-')}`, e.repoA.base]);
  writeFileSync(join(e.repoA.work, 'human.txt'), `a person edited ${branch}\n`);
  e.fx.git(e.repoA.work, ['add', '-A']);
  e.fx.git(e.repoA.work, ['commit', '--quiet', '-m', 'human edit']);
  const commit = e.fx.git(e.repoA.work, ['rev-parse', 'HEAD']).trim();
  e.fx.git(e.repoA.work, ['push', '--quiet', e.repoA.bare, `HEAD:refs/heads/${branch}`]);
  e.fx.git(e.repoA.work, ['checkout', '--quiet', 'main']);
  return commit;
}
const request = (w: { id: string; sourceRef: Parameters<typeof publisher.compareAndUpdateRef>[1]['sourceRef'] }, expectedHead: string | null) => ({ workspaceId: w.id, expectedEpoch: 1, expectedHead, sourceRef: w.sourceRef });

describe('AC-38 human edit preserved (local ref)', () => {
  it('a person pushes to the task branch: the publisher is refused, the person\'s commit is still the head, and the result names both heads', async () => {
    const w = await checkpointedWorkspace(e, e.a, e.repoA, 'human1');
    const person = humanPush(w.branch);
    const stale = await publisher.compareAndUpdateRef(e.publisher(e.a), request(w, e.repoA.base)); // the head the writer last saw
    expect(stale).toEqual({ outcome: 'needs_reconciliation', expectedHead: e.repoA.base, actualHead: person });
    expect(e.repoA.remoteRef(`refs/heads/${w.branch}`)).toBe(person);

    // Positive control: with the person's head as the lease, the very same call lands.
    expect(await publisher.compareAndUpdateRef(e.publisher(e.a), request(w, person))).toEqual({ outcome: 'updated', head: w.commit });
    expect(e.repoA.remoteRef(`refs/heads/${w.branch}`)).toBe(w.commit);
  });

  it('a first publish (expected head null) to a branch that already exists is refused the same way', async () => {
    const w = await checkpointedWorkspace(e, e.a, e.repoA, 'human2');
    const person = humanPush(w.branch);
    expect(await publisher.compareAndUpdateRef(e.publisher(e.a), request(w, null))).toEqual({ outcome: 'needs_reconciliation', expectedHead: null, actualHead: person });
    expect(e.repoA.remoteRef(`refs/heads/${w.branch}`)).toBe(person);
    const fresh = await checkpointedWorkspace(e, e.a, e.repoA, 'human2-fresh');
    expect(await publisher.compareAndUpdateRef(e.publisher(e.a), request(fresh, null))).toEqual({ outcome: 'updated', head: fresh.commit });
  });

  it('never uses plain force: every push carries an explicit lease and no force flag or forced refspec', () => {
    expect(pushes.length).toBeGreaterThanOrEqual(4);
    for (const args of pushes) {
      expect(args.some((a) => a.startsWith('--force-with-lease=refs/heads/factory/'))).toBe(true);
      expect(args).not.toContain('--force');
      expect(args).not.toContain('-f');
      expect(args.filter((a) => a.includes(':refs/heads/')).every((a) => !a.startsWith('+'))).toBe(true);
    }
    expect(pushes.some((a) => a.some((x) => x.endsWith(':')))).toBe(true); // the "must not exist" lease
  });

  it('a caller that is not the publisher identity is refused and audited, even the runner', async () => {
    const w = await checkpointedWorkspace(e, e.a, e.repoA, 'who');
    for (const ctx of [e.runner(e.a), e.ctxFor(e.a, 'service:git-publisher', 'human'), e.ctxFor(e.a, 'pod:harness')]) {
      await expect(publisher.compareAndUpdateRef(ctx, request(w, null))).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(e.repoA.remoteRef(`refs/heads/${w.branch}`)).toBeNull();
    const audit = await e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query("SELECT outcome FROM factory.audit_event WHERE resource_id = $1 AND action = 'workspace.compare_and_update_ref'", [w.id]));
    expect(audit.rows).toHaveLength(3);
    expect(await publisher.compareAndUpdateRef(e.publisher(e.a), request(w, null))).toMatchObject({ outcome: 'updated' }); // control
  });

  it('refuses a row in active, a row with no candidate_commit, and a request that names its own target', async () => {
    const active = randomUUID();
    await e.manager.allocateOrAttach(e.runner(e.a), active, specFor(e.a, await e.setupRef(e.a), e.repoA.base, { branch: `factory/${e.a.taskId}/active1` }));
    await e.host.ensureMaterialized(e.runner(e.a), active);
    await e.manager.markWriterStarted(e.runner(e.a), active, 1, 'pod');
    const w = await checkpointedWorkspace(e, e.a, e.repoA, 'states');
    await expect(publisher.compareAndUpdateRef(e.publisher(e.a), request({ id: active, sourceRef: w.sourceRef }, null))).rejects.toMatchObject({ code: 'not_publishable' });

    const noCommit = randomUUID();
    await e.manager.allocateOrAttach(e.runner(e.a), noCommit, specFor(e.a, await e.setupRef(e.a), e.repoA.base, { branch: `factory/${e.a.taskId}/nocommit` }));
    await e.host.ensureMaterialized(e.runner(e.a), noCommit);
    await e.manager.markWriterStarted(e.runner(e.a), noCommit, 1, 'pod');
    await e.db.withTenant({ orgId: e.a.orgId }, (tx) => transitionWorkspace(tx, { orgId: e.a.orgId, id: noCommit, expectedEpoch: 1, from: ['active'], patch: { state: 'checkpointed' } }));
    await expect(publisher.compareAndUpdateRef(e.publisher(e.a), request({ id: noCommit, sourceRef: w.sourceRef }, null))).rejects.toMatchObject({ code: 'not_publishable' });
    expect(e.repoA.remoteRef(`refs/heads/factory/${e.a.taskId}/nocommit`)).toBeNull();

    // Extra fields naming another repository, branch or commit are ignored: all three come from the row.
    const hostile = { ...request(w, null), cloneUrl: '/nonexistent/evil.git', repositoryId: randomUUID(), branch: `factory/${e.a.taskId}/elsewhere`, commit: 'f'.repeat(40) };
    expect(await publisher.compareAndUpdateRef(e.publisher(e.a), hostile)).toEqual({ outcome: 'updated', head: w.commit });
    expect(e.repoA.remoteRef(`refs/heads/${w.branch}`)).toBe(w.commit);
    expect(e.repoA.remoteRef(`refs/heads/factory/${e.a.taskId}/elsewhere`)).toBeNull();
  });

  it('refuses a thin bundle and a bundle without the row\'s candidate commit, and leaves no staging repository behind', async () => {
    const w = await checkpointedWorkspace(e, e.a, e.repoA, 'bundles');
    const thin = await e.putArtifact(e.a, e.repoA.thinBundle(), 'application/x-git-bundle', 'candidate_source/thin');
    await expect(publisher.compareAndUpdateRef(e.publisher(e.a), { ...request(w, null), sourceRef: thin })).rejects.toMatchObject({ code: 'thin_bundle' });
    const other = e.fx.makeRepo({ 'unrelated.txt': 'x' });
    const wrong = await e.putArtifact(e.a, other.bundle(), 'application/x-git-bundle', 'candidate_source/wrong');
    await expect(publisher.compareAndUpdateRef(e.publisher(e.a), { ...request(w, null), sourceRef: wrong })).rejects.toMatchObject({ code: 'commit_not_found' });
    expect(e.repoA.remoteRef(`refs/heads/${w.branch}`)).toBeNull();
    const leftovers = existsSync(e.scratch) ? readdirSync(join(e.scratch, e.a.orgId), { recursive: true }).filter((n) => String(n).includes('publish-')) : [];
    expect(leftovers).toEqual([]);
  });

  it('a publisher context that is not scoped to the workspace\'s task is refused, and its scope is never rewritten', async () => {
    const w = await checkpointedWorkspace(e, e.a, e.repoA, 'scope');
    const unscoped = e.publisher(e.a);
    Reflect.deleteProperty(unscoped, 'taskId');
    await expect(publisher.compareAndUpdateRef(unscoped, request(w, null))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(publisher.compareAndUpdateRef({ ...e.publisher(e.a), taskId: randomUUID() }, request(w, null))).rejects.toMatchObject({ code: 'forbidden' });
    expect(e.repoA.remoteRef(`refs/heads/${w.branch}`)).toBeNull();
    expect(await publisher.compareAndUpdateRef(e.publisher(e.a), request(w, null))).toMatchObject({ outcome: 'updated' }); // control
  });
});
