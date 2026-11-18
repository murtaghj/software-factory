// LocalWorkspaceHost (W-018, part three): joins the manager and a materializer for the local case
// (tests, local runs, the fake tier). W-017's controller plays this part for pods.
//
// ensureMaterialized takes the row FOR UPDATE and holds it across the clone. A concurrent release
// therefore either runs first (the host then sees `releasing` and does nothing) or waits and then
// removes a complete directory: a live directory under a released row cannot occur.
import type { AuthContext } from '@factory/artifacts';
import { lockWorkspace, sessionLostSignal, type Database } from '@factory/database';
import { WorkspaceError } from './errors.ts';
import type { GitMaterializer, MaterializeReceipt } from './materializer.ts';
import { hostInternals, type WorkspaceManagerService } from './manager.ts';
import { isUuid } from './paths.ts';

export type LocalWorkspaceHostOptions = {
  db: Database; manager: WorkspaceManagerService; materializer: GitMaterializer;
  // Fault points for tests: a crash between the rename and the accept.
  faults?: { afterMaterialize?: () => void | Promise<void> };
};
export type EnsureResult =
  | { outcome: 'materialized'; receipt: MaterializeReceipt }
  | { outcome: 'unchanged'; reason: 'not_materializable' | 'restore_unavailable' };

export class LocalWorkspaceHost {
  readonly #o: LocalWorkspaceHostOptions;
  constructor(o: LocalWorkspaceHostOptions) { this.#o = o; }

  async ensureMaterialized(ctx: AuthContext, id: string): Promise<EnsureResult> {
    const { db, manager, materializer } = this.#o;
    const host = hostInternals(manager);
    if (!host.isRunner(ctx)) throw new WorkspaceError('forbidden', 'ensureMaterialized plays the runner and needs the runner identity');
    if (!isUuid(id)) throw new WorkspaceError('invalid_request', 'workspace id must be a UUID');
    // Cheap check first, so a row that cannot be materialized never makes us fetch up to 512 MB.
    const early = await host.probe(ctx, id);
    if (early !== 'ready') return { outcome: 'unchanged', reason: early };
    // Anything that needs another database connection is fetched before the lock is taken, so
    // twelve callers cannot exhaust the pool while each holds a row lock.
    const source = await host.resolveCandidateSource(ctx, id, true);
    return db.withTenant({ orgId: ctx.orgId }, async (tx): Promise<EnsureResult> => {
      const row = await lockWorkspace(tx, ctx.orgId, id, 'update');
      if (!row) throw new WorkspaceError('not_found', 'unknown workspace');
      const req = await host.requestInTx(tx, row, source);
      if (!req.ok) return { outcome: 'unchanged', reason: req.code };
      // Allocated with no accepted receipt means no writer has ever started on this generation, and
      // the lock is held: a directory already at the target is a crash leftover, safe to delete.
      const cleared = await materializer.remove(req.request.target);
      if (!cleared.absent) throw new WorkspaceError('target_exists', `could not clear a leftover target: ${cleared.error ?? 'unknown'}`);
      // If this session dies, the row lock dies with it and a release may proceed: the clone is
      // aborted, and on any failure the directory is removed before the error leaves.
      const lost = sessionLostSignal(tx);
      try {
        const result = await materializer.materialize(req.request, { ...(source?.bytes ? { bundle: source.bytes } : {}), signal: lost });
        if (!result.ok) throw new WorkspaceError(result.code, result.message);
        await this.#o.faults?.afterMaterialize?.();
        if (lost.aborted) throw new WorkspaceError('git_failed', 'the database session was lost during materialization');
        await host.acceptInTx(tx, row, result.receipt, source);
        return { outcome: 'materialized', receipt: result.receipt };
      } catch (e) {
        // Whatever failed after the directory was moved into place, nothing is left behind for a row
        // that has no accepted receipt (and, if the session died, no lock to protect it).
        await materializer.remove(req.request.target);
        throw e;
      }
    });
  }
}
