// PodVolumeMaterializer (W-017, 17b): the GitMaterializer handed to `createWorkspaceManager` in pod mode. The clone is
// a step of the Job, not a call, so `materialize` is a typed `not_supported`. `remove` is the PVC delete the W-018
// README hand-off asks for, and it is what `release` calls once the row is `releasing`.
//
// Rules, in order (section 5):
//   1. A workspace with a live allocation answers `absent: false` (W-018 lets an `allocated` workspace go to
//      `releasing` whatever its allocations are, so the check has to be here). Sound because once `releasing` is
//      committed the allocate step refuses the workspace, and its live allocations can only stop.
//   2. A pod that carries the workspace and generation labels, in any phase, answers `absent: false`.
//   3. The PVC under the derived name is deleted only if its ownership labels are ours, by the UID just observed, then
//      read until 404 or the settle deadline. Still present (a deletion timestamp, the pvc-protection finalizer): `absent: false`.
//   4. Any PVC left with the workspace's label, of any generation: `absent: false`. No row may be `released` while a
//      PVC with its label exists (D15). Only an empty list is `absent: true`.
// No Kubernetes call happens inside a database transaction: the one lookup the runner supplies opens and closes its own.
import { getWorkspace, listAllocationsOfWorkspace, type Database } from '@factory/database';
import type { GitMaterializer, MaterializeResult, RemoveResult, MaterializeTarget } from '@factory/workspace';
import type { RunnerConfig } from './config.ts';
import { UUID } from './core.ts';
import { pvcIsOurs } from './job-manifest.ts';
import { KubeError, type KubeApi, type KubePvc } from './kube/api.ts';
import { labelKeys, pvcName } from './names.ts';
import { isLive } from './states.ts';

export type PodVolumeMaterializerOptions = {
  kube: KubeApi;
  config: RunnerConfig;
  // The one read-only lookup the runner supplies: the workspace's task (the ownership predicate compares it) and whether it has an
  // allocation in a live state. `undefined`: no such workspace.
  lookup: (orgId: string, workspaceId: string) => Promise<{ taskId: string; live: boolean } | undefined>;
  settle?: { timeoutMs: number; pollMs: number };            // after the delete: read until 404 (default 30 s, every 250 ms)
  wait?: (ms: number) => Promise<void>;                      // a test replaces it with a gate; production sleeps
};

const DEFAULT_SETTLE = { timeoutMs: 30_000, pollMs: 250 };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class PodVolumeMaterializer implements GitMaterializer {
  readonly #o: PodVolumeMaterializerOptions;
  constructor(o: PodVolumeMaterializerOptions) { this.#o = o; }

  materialize(): Promise<MaterializeResult> {
    return Promise.resolve({ ok: false, code: 'not_supported', message: 'in pod mode the clone is a step of the Job, not a call' });
  }

  async remove(target: MaterializeTarget): Promise<RemoveResult> {
    const o = this.#o;
    const no = (error: string): RemoveResult => ({ absent: false, error });
    if (!UUID.test(target.orgId) || !UUID.test(target.workspaceId) || !Number.isSafeInteger(target.generation) || target.generation < 1) return no('invalid target');
    const k = labelKeys(o.config.labelPrefix);
    try {
      // 1. A live allocation of the workspace.
      const ws = await o.lookup(target.orgId, target.workspaceId);
      if (!ws) return no('unknown workspace');
      if (ws.live) return no('the workspace has a live allocation');

      // 2. A pod of this workspace and generation, in any phase, counts until it is gone.
      const pods = await o.kube.listPods(`${k.org}=${target.orgId},${k.workspace}=${target.workspaceId},${k.generation}=${String(target.generation)}`);
      if (pods.truncated) return no('the pod list reached its cap');
      if (pods.items.length > 0) return no('a pod of this workspace generation still exists');

      // 3. The generation's own claim, by its derived name, only if its ownership labels say it is ours.
      const name = pvcName(target.orgId, target.workspaceId, target.generation);
      let found: KubePvc | undefined;
      try { found = await o.kube.getPvc(name); } catch (e) { if (!(e instanceof KubeError && e.isNotFound)) throw e; }
      if (found) {
        // The same predicate the controller attaches by (task label included), not a second copy of it.
        if (!pvcIsOurs(found, { orgId: target.orgId, taskId: ws.taskId, generation: target.generation }, target.workspaceId, o.config)) return no('a claim under this name is not this workspace\'s; it was left alone');
        try { await o.kube.deletePvc(name, found.metadata.uid); } catch (e) {
          if (e instanceof KubeError && e.isConflict) return no('the claim under this name is not the one observed; it was left alone');
          if (!(e instanceof KubeError && e.isNotFound)) throw e; // 404: already gone
        }
        const gone = await this.#untilGone(name, found.metadata.uid);
        if (gone !== 'gone') return no(gone === 'terminating' ? 'the claim is still terminating' : 'a claim now sits under this name; it was left alone');
      }

      // 4. Any claim left with the workspace's label, of any generation.
      const rest = await o.kube.listPvcs(`${k.org}=${target.orgId},${k.workspace}=${target.workspaceId}`);
      if (rest.truncated) return no('the claim list reached its cap');
      if (rest.items.length > 0) return no(`${String(rest.items.length)} claim(s) of this workspace remain: ${rest.items.slice(0, 5).map((p) => p.metadata.name).join(', ')}`);
      return { absent: true };
    } catch (e) {
      return no(e instanceof Error ? e.message : 'unknown error'); // an unknown outcome is never "absent"
    }
  }

  async #untilGone(name: string, uid: string): Promise<'gone' | 'terminating' | 'replaced'> {
    const o = this.#o;
    const { timeoutMs, pollMs } = o.settle ?? DEFAULT_SETTLE;
    const wait = o.wait ?? sleep;
    const polls = Math.max(1, Math.ceil(timeoutMs / pollMs));
    for (let i = 0; i < polls; i += 1) {
      try {
        const now = await o.kube.getPvc(name);
        if (now.metadata.uid !== uid) return 'replaced';
      } catch (e) { if (e instanceof KubeError && e.isNotFound) return 'gone'; throw e; }
      await wait(pollMs);
    }
    try { const last = await o.kube.getPvc(name); return last.metadata.uid === uid ? 'terminating' : 'replaced'; } catch (e) { if (e instanceof KubeError && e.isNotFound) return 'gone'; throw e; }
  }
}

// The lookup the runner supplies. It opens and closes its own short transaction (Postgres only) and returns before any Kubernetes call.
export const workspaceLookup = (db: Database): PodVolumeMaterializerOptions['lookup'] =>
  (orgId, workspaceId) => db.withTenant({ orgId }, async (tx) => {
    const ws = await getWorkspace(tx, orgId, workspaceId);
    return ws ? { taskId: ws.taskId, live: (await listAllocationsOfWorkspace(tx, orgId, workspaceId)).some((a) => isLive(a.state)) } : undefined;
  });

export const createPodVolumeMaterializer = (o: Omit<PodVolumeMaterializerOptions, 'lookup'> & { db: Database }): PodVolumeMaterializer =>
  new PodVolumeMaterializer({ ...o, lookup: workspaceLookup(o.db) });
