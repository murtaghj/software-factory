// Publisher (W-018, part four): compareAndUpdateRef. It runs in the control plane, where the Git
// credential lives, and touches a row lock in Postgres plus a factory-owned staging repository
// built from an artifact. It never touches a workspace directory.
//
// Three phases, so the lock is held only for the push:
//   1. before the lock, no transaction held: read the row, read and verify the bundle, build a
//      staging repository at a path unique to this call (nothing slow runs under the lock, and a
//      second connection is never needed while one is held);
//   2. lock the row FOR SHARE, re-check epoch, state, branch and candidate_commit, and prove the
//      session is alive;
//   3. push and ls-remote under one deadline (default 45 s) well below the 90 s
//      idle_in_transaction_session_timeout, then commit.
// A replaceWriter needs the row exclusively, so it waits for an in-flight push, and a push that starts
// after a replacement sees the new epoch and is refused.
//
// Residual risk: if the publisher loses its database connection mid-push the lock is gone. Git runs in
// its own process group; on the deadline or a lost session the whole group is killed and the call
// waits for it to exit, so no transfer started by this call can land after the lock is released. The
// push's outcome at the moment of the kill is unknown and is reported as needs_reconciliation with
// outcomeUnknown. A remote that had already accepted the data is beyond our reach without fencing on
// the provider's side.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactService, AuthContext } from '@factory/artifacts';
import type { ArtifactRef } from '@factory/contracts';
import { canonicalJson } from '@factory/domain';
import { getWorkspace, lockWorkspace, recordWorkspaceAudit, sessionLostSignal, type Database, type WorkspaceRow } from '@factory/database';
import { assertTaskBranch } from './branch.ts';
import { WorkspaceError } from './errors.ts';
import { claimFactoryOwned, GitRunner } from './git.ts';
import { assertFullBundle, MATERIALIZE_LIMITS } from './materializer.ts';
import { assertSafeRoot, ensureSafeChild, isUuid, resolveSource } from './paths.ts';

export type PublisherOptions = {
  db: Database; artifacts: ArtifactService; publisherIdentity: string; scratchRoot: string;
  git?: GitRunner;
  // One deadline for push and ls-remote together. Must stay below IDLE_IN_TRANSACTION_MS.
  pushDeadlineMs?: number;
  faults?: {
    // Between reading the row and taking the lock (slow pre-steps; no lock is held here).
    beforeLock?: () => void | Promise<void>;
    // Under the lock, after the re-check, before the push.
    afterEpochCheck?: () => void | Promise<void>;
  };
};
export type PublishRequest = { workspaceId: string; expectedEpoch: number; expectedHead: string | null; sourceRef: ArtifactRef };
export type PublishResult =
  | { outcome: 'updated'; head: string }
  // outcomeUnknown: the push was interrupted (deadline or lost session); its Git process group is gone, but
  // the remote may or may not have applied it before the kill.
  | { outcome: 'needs_reconciliation'; expectedHead: string | null; actualHead: string | null; outcomeUnknown?: true }
  | { outcome: 'stale_epoch'; currentEpoch: number };

const COMMIT = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
export const IDLE_IN_TRANSACTION_MS = 90_000;
export const PUSH_DEADLINE_MS = 45_000;
const STEP_TIMEOUT_MS = 20_000;

export interface Publisher {
  compareAndUpdateRef(ctx: AuthContext, request: PublishRequest): Promise<PublishResult>;
}

type Publishable = { row: WorkspaceRow; commit: string; ref: string; cloneUrl: string };

function publishable(row: WorkspaceRow | undefined, expectedEpoch: number): { stale: number } | { row: WorkspaceRow; commit: string; branch: string } {
  if (!row) throw new WorkspaceError('not_found', 'unknown workspace');
  if (row.ownerEpoch !== expectedEpoch) return { stale: row.ownerEpoch };
  if (row.state !== 'checkpointed' && row.state !== 'retained') throw new WorkspaceError('not_publishable', `a workspace in ${row.state} cannot be published`);
  if (row.candidateCommit === null || row.branch === null) throw new WorkspaceError('not_publishable', 'the workspace has no candidate commit or no branch');
  assertTaskBranch(row.taskId, row.branch);
  return { row, commit: row.candidateCommit, branch: row.branch };
}

export function createPublisher(o: PublisherOptions): Publisher {
  const git = o.git ?? new GitRunner();
  const pushDeadline = o.pushDeadlineMs ?? PUSH_DEADLINE_MS;
  if (pushDeadline >= IDLE_IN_TRANSACTION_MS) throw new WorkspaceError('invalid_request', 'the push deadline must be below the idle-in-transaction timeout');

  return {
    async compareAndUpdateRef(ctx, req) {
      // Only the Git publisher service identity; anyone else is refused and audited.
      if (ctx.actorKind !== 'service' || ctx.actorId !== o.publisherIdentity) {
        await o.db.withTenant({ orgId: ctx.orgId }, (tx) => recordWorkspaceAudit(tx, {
          orgId: ctx.orgId, actorId: ctx.actorId, action: 'workspace.compare_and_update_ref', resourceId: req.workspaceId, outcome: 'denied',
          correlationId: ctx.correlationId, requestDigest: createHash('sha256').update(canonicalJson({ workspaceId: req.workspaceId })).digest('hex') }));
        throw new WorkspaceError('forbidden', 'compareAndUpdateRef is limited to the Git publisher service identity');
      }
      if (!isUuid(req.workspaceId) || !Number.isSafeInteger(req.expectedEpoch) || (req.expectedHead !== null && !COMMIT.test(req.expectedHead))) {
        throw new WorkspaceError('invalid_request', 'workspaceId, expectedEpoch and expectedHead must be well-formed');
      }

      // ---- phase 1: no lock, no transaction held
      const first = await o.db.withTenant({ orgId: ctx.orgId }, async (tx) => {
        const row = await getWorkspace(tx, ctx.orgId, req.workspaceId);
        const p = publishable(row, req.expectedEpoch);
        if ('stale' in p) return p;
        // The publisher's context must be scoped to the workspace's task; its scope is never rewritten.
        if (ctx.taskId !== p.row.taskId) throw new WorkspaceError('forbidden', 'the publisher context must be scoped to the workspace\'s task');
        // Repository, branch and commit all come from the row; the request names none of them.
        const source = await resolveSource(tx, ctx.orgId, p.row.taskId, p.row.repositoryId);
        const target: Publishable = { row: p.row, commit: p.commit, ref: `refs/heads/${p.branch}`, cloneUrl: source.cloneUrl };
        return { target };
      });
      if ('stale' in first) return { outcome: 'stale_epoch', currentEpoch: first.stale };
      const { row, commit, ref, cloneUrl } = first.target;
      await o.faults?.beforeLock?.();

      // The bundle is read and verified here, on its own connection, before any lock exists.
      const bytes = await o.artifacts.readVerified(ctx, req.sourceRef, MATERIALIZE_LIMITS.maxBundleBytes);
      assertFullBundle(bytes);
      assertSafeRoot(o.scratchRoot);
      const dir = join(ensureSafeChild(ensureSafeChild(o.scratchRoot, ctx.orgId, true), row.id, true), `publish-e${String(row.ownerEpoch)}-${randomUUID()}`);
      mkdirSync(dir, { mode: 0o700 }); // unique per call: concurrent publishes never share or delete each other's staging
      try {
        const owned = claimFactoryOwned(dir);
        await git.version();
        const step = { timeoutMs: STEP_TIMEOUT_MS };
        await git.run(['init', '--quiet', '--bare', 'stage'], { cwd: owned, ...step });
        const repo = claimFactoryOwned(join(dir, 'stage'));
        writeFileSync(join(dir, 'in.bundle'), bytes, { mode: 0o600 });
        const verify = await git.run(['bundle', 'verify', '../in.bundle'], { cwd: repo, allowFailure: true, ...step });
        if (verify.code !== 0) throw new WorkspaceError('bundle_invalid', `bundle verification failed: ${verify.stderr.trim().slice(0, 300)}`);
        const fetched = await git.run(['fetch', '--no-tags', '--quiet', '../in.bundle', '+refs/*:refs/factory/bundle/*'], { cwd: repo, allowFailure: true, ...step });
        if (fetched.code !== 0) throw new WorkspaceError('bundle_invalid', `bundle fetch failed: ${fetched.stderr.trim().slice(0, 300)}`);
        const has = await git.run(['cat-file', '-e', `${commit}^{commit}`], { cwd: repo, allowFailure: true, ...step });
        if (has.code !== 0) throw new WorkspaceError('commit_not_found', 'the source bundle does not contain the workspace\'s candidate commit', { commit });

        // ---- phases 2 and 3: the lock, held for the push only
        return await o.db.withTenant({ orgId: ctx.orgId }, async (tx): Promise<PublishResult> => {
          await tx.query("SELECT set_config('idle_in_transaction_session_timeout', $1, true)", [`${String(IDLE_IN_TRANSACTION_MS)}ms`]);
          {
            const locked = publishable(await lockWorkspace(tx, ctx.orgId, req.workspaceId, 'share'), req.expectedEpoch);
            if ('stale' in locked) return { outcome: 'stale_epoch', currentEpoch: locked.stale };
            if (locked.commit !== commit || `refs/heads/${locked.branch}` !== ref) throw new WorkspaceError('not_publishable', 'the workspace changed since it was read');
            await o.faults?.afterEpochCheck?.();
            await tx.query('SELECT 1'); // the session, and so the lock, is still ours; throws if it was killed

            const deadline = AbortSignal.any([sessionLostSignal(tx), AbortSignal.timeout(pushDeadline)]);
            // An explicit expected-head lease; "must not exist" when there is no expected head.
            // Plain force is never used.
            const lease = `--force-with-lease=${ref}:${req.expectedHead ?? ''}`;
            let push;
            try {
              push = await git.run(['push', '--porcelain', lease, cloneUrl, `${commit}:${ref}`], { cwd: repo, allowFailure: true, timeoutMs: pushDeadline, signal: deadline });
            } catch (e) {
              if (!(e instanceof WorkspaceError) || e.details?.['interrupted'] === undefined) throw e;
              // The deadline passed or the session was lost, and the Git process group is now fully gone
              // (the runner waited for it), so nothing can land after the lock is released. What the
              // remote did before the kill is unknown: look once, briefly, and report it as such.
              if (sessionLostSignal(tx).aborted) throw e;
              const look = await git.run(['ls-remote', cloneUrl, ref], { cwd: repo, allowFailure: true, timeoutMs: STEP_TIMEOUT_MS }).catch(() => undefined);
              const seen = look?.code === 0 ? (look.stdout.toString('utf8').split('\n').map((l) => l.split('\t')).find((p) => p[1] === ref)?.[0] ?? null) : null;
              if (seen === commit) return { outcome: 'updated', head: commit };
              return { outcome: 'needs_reconciliation', expectedHead: req.expectedHead, actualHead: seen, outcomeUnknown: true };
            }
            const remote = await git.run(['ls-remote', cloneUrl, ref], { cwd: repo, allowFailure: true, timeoutMs: STEP_TIMEOUT_MS, signal: deadline });
            if (remote.code !== 0) throw new WorkspaceError('push_failed', `push failed and the remote head could not be read: ${push.stderr.trim().slice(0, 300)}`);
            const actual = remote.stdout.toString('utf8').split('\n').map((l) => l.split('\t')).find((p) => p[1] === ref)?.[0] ?? null;
            if (actual === commit) return { outcome: 'updated', head: commit }; // an earlier attempt already landed
            if (actual !== req.expectedHead) return { outcome: 'needs_reconciliation', expectedHead: req.expectedHead, actualHead: actual };
            throw new WorkspaceError('push_failed', `push failed: ${push.stderr.trim().slice(0, 300)}`);
          }
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
