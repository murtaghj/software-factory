// The reconciler: one pass per allocation, the loop, and the sweep of Jobs that should not exist. Every
// pass is "unlocked preparation, then a short locked phase that touches only Postgres, then commit, then
// Kubernetes" (rule 1): the helpers that lock never call the port, and the port is never called inside
// `withTenant`. Two controllers are kept apart by deterministic names, compare-and-swap and the 409, not by a lease (rule 2).
import { randomUUID } from 'node:crypto';
import {
  countLiveWriters, countQuarantinedOlderThan, getAllocation, getRunnerStageRunById, getWorkspace, listActiveOrganizationIds, listReconcilableAllocationIds, lockAllocation, lockWorkspace, readDbClock,
  recordRunnerAudit, setLockWait, transitionAllocation, isLockTimeout, workspaceFenced, type AllocationRow, type AllocationState, type RunnerStageRun, type Tx, type WorkspaceRow,
} from '@factory/database';
import { canonicalJson } from '@factory/domain';
import {
  MAX_RECORD_BYTES, QUARANTINE_RECORD_SCHEMA, QUIESCENCE_PROOF_SCHEMA, WorkspaceError, quarantineRecord, quiescenceProof,
  type QuarantineRecordBody, type QuiescenceProofBody, type RecordDeps, type RecordHandle,
} from '@factory/workspace';
import { releaseCapacity } from './capacity-standin.ts';
import { UUID, faultsOf, runnerCtx, sha256, type RunnerDeps } from './core.ts';
import { claimedAllocation, jobIsOurs, pvcIsOurs, renderJob, renderPvc, templateDifferences, type RenderInput } from './job-manifest.ts';
import { KubeError, type KubeJob, type KubePod, type KubePvc } from './kube/api.ts';
import { labelKeys, pvcName } from './names.ts';
import { parseMaterializeStatus } from './pod/receipt.ts';
import { evaluateQuiescence, type PodObservation } from './quiescence.ts';
import { hasCancelStop, hasStopAck, hasUrgentStop, readWriterStart } from './records.ts';
import { assertEdge } from './states.ts';
import { settleWorkspace } from './workspaces.ts';
import { RunnerError } from './errors.ts';

const MAX_SWEPT_JOBS = 500;
const finished = (p: KubePod): boolean => p.status.phase === 'Succeeded' || p.status.phase === 'Failed';
const terminating = (p: KubePod): boolean => p.metadata.deletionTimestamp !== undefined;
const containerTerminated = (p: KubePod, name: string): boolean => (p.status.containerStatuses ?? []).some((c) => c.name === name && c.state.terminated !== undefined);

// ---------------------------------------------------------------- locked transitions (Postgres only)

export type MoveOptions = { leaseSeconds?: number | null; heartbeat?: boolean; jobUid?: string; audit?: { action: string; reason: string } };

// Lock the row, then compare-and-swap from the state the caller judged on. Returns the new row, or
// undefined when the row was not in that state any more (another controller moved it).
export async function move(d: RunnerDeps, a: AllocationRow, to: AllocationState, o: MoveOptions = {}): Promise<AllocationRow | undefined> {
  assertEdge(a.state, to);
  return d.db.withTenant({ orgId: a.orgId }, async (tx) => {
    await setLockWait(tx, 5000);
    const locked = await lockAllocation(tx, a.orgId, a.id);
    // The judgement was made on `a`: if the state or the writer claim changed since, it is stale and nothing moves.
    if (!locked || locked.state !== a.state || locked.podUid !== a.podUid) return undefined;
    const next = await transitionAllocation(tx, { orgId: a.orgId, id: a.id, ownerEpoch: a.ownerEpoch, from: [a.state], to, ...(o.leaseSeconds === undefined ? {} : { leaseSeconds: o.leaseSeconds }),
      ...(o.heartbeat === undefined ? {} : { heartbeat: o.heartbeat }), ...(o.jobUid === undefined ? {} : { jobUid: o.jobUid }) });
    if (next && o.audit) await auditAllocation(tx, d, a, o.audit.action, o.audit.reason);
    return next;
  });
}
export async function auditAllocation(tx: Tx, d: RunnerDeps, a: AllocationRow, action: string, reason: string, extra: Record<string, unknown> = {}): Promise<void> {
  await recordRunnerAudit(tx, { orgId: a.orgId, actorId: d.config.runnerIdentity, action, resourceKind: 'execution_allocation', resourceId: a.id, outcome: 'accepted',
    correlationId: `${action}:${a.id}`, requestDigest: sha256(canonicalJson({ action, reason })), details: { reason, generation: a.generation, state: a.state, ...extra } });
}
// `→ stopping` with the stop deadline in controller_lease_until and a diagnostic reason row. Nothing decides on the reason.
export const toStopping = (d: RunnerDeps, a: AllocationRow, reason: string): Promise<AllocationRow | undefined> =>
  move(d, a, 'stopping', { leaseSeconds: d.config.stopDeadlineSeconds, audit: { action: 'runner.allocation_stopping', reason } });
export const recordDeps = (d: RunnerDeps): RecordDeps => ({ db: d.db, artifacts: d.artifacts, runnerIdentity: d.config.runnerIdentity });

// ---------------------------------------------------------------- the quarantine move (rule 6: a stored proof is a one-way door)
export type QuarantineSource = { source: 'desired' | 'starting' | 'stopping'; notProvedBecause?: string; observation?: PodObservation[]; claim?: { name: string; uid: string | null } | null };
export type QuarantineOutcome = 'quarantined' | 'proof_exists' | 'stale';

// `→ quarantined`: nothing was proved; the PVC is left alone, the quarantine record is written in the same transaction as the move, and the
// move itself **reads the proof link under the row lock and refuses when one exists**. The object is put first, outside any transaction.
export async function quarantine(d: RunnerDeps, a: AllocationRow, reason: string, q: QuarantineSource): Promise<QuarantineOutcome> {
  assertEdge(a.state, 'quarantined');
  const rd = recordDeps(d);
  const at = await d.db.withTenant({ orgId: a.orgId }, (tx) => readDbClock(tx));
  const day = 86_400_000;
  const base = Date.parse(at);
  const body = fit((limit): QuarantineRecordBody => ({
    schema: QUARANTINE_RECORD_SCHEMA, organizationId: a.orgId, taskId: a.taskId, allocationId: a.id, stageRunId: a.stageRunLogicalId, generation: a.generation, epoch: a.ownerEpoch, workspaceId: a.workspaceId,
    source: q.source, reason, notProvedBecause: q.notProvedBecause ?? null, lastObservation: (q.observation ?? []).slice(0, limit).map((p) => ({ podUid: p.podUid, phase: p.phase, containers: p.containers.map((c) => ({ name: c.name, kind: c.kind, state: c.state, ...(c.exitCode === undefined ? {} : { exitCode: c.exitCode }) })) })),
    claim: q.claim ?? null, writer: a.podUid === null ? null : { podUid: a.podUid }, recordedAt: at,
    preserveUntil: new Date(base + d.config.quarantinePreserveDays * day).toISOString(), escalateAfter: new Date(base + d.config.quarantineEscalateDays * day).toISOString(),
    obligation: { kind: 'quarantined_allocation', owner: d.config.quarantineOwner, needsOperator: true }, podCount: (q.observation ?? []).length,
  }));
  const handle: RecordHandle = await quarantineRecord.prepare(rd, d.config.runnerIdentity, { orgId: a.orgId, taskId: a.taskId, allocationId: a.id, body: body });
  await faultsOf(d).hit('runner.after_quarantine_put');
  await faultsOf(d).hit('runner.before_quarantine_move');
  return d.db.withTenant({ orgId: a.orgId }, async (tx): Promise<QuarantineOutcome> => {
    await setLockWait(tx, 5000);
    const locked = await lockAllocation(tx, a.orgId, a.id);
    if (!locked || locked.state !== a.state || locked.podUid !== a.podUid) return 'stale';
    if ((await quiescenceProof.read(tx, rd, a.orgId, a.id)).kind === 'present') return 'proof_exists';
    const next = await transitionAllocation(tx, { orgId: a.orgId, id: a.id, ownerEpoch: a.ownerEpoch, from: [a.state], to: 'quarantined' });
    if (!next) return 'stale';
    await quarantineRecord.register(tx, rd, handle);
    await auditAllocation(tx, d, a, 'runner.allocation_quarantined', reason);
    return 'quarantined';
  });
}
// The three sources that remain (`desired`, `starting`, `stopping`). Callers that have an observation use `quarantine` directly.
export async function toQuarantined(d: RunnerDeps, a: AllocationRow, reason: string): Promise<AllocationRow | undefined> {
  let claim: QuarantineSource['claim'] = null;
  if (a.workspaceId !== null) {
    const name = pvcName(a.orgId, a.workspaceId, a.generation);
    try { claim = { name, uid: (await d.kube.getPvc(name)).metadata.uid }; } catch (e) { if (e instanceof KubeError) claim = { name, uid: null }; else throw e; }
  }
  const source = a.state === 'desired' || a.state === 'starting' || a.state === 'stopping' ? a.state : undefined;
  if (source === undefined) throw new Error(`illegal allocation transition ${a.state} -> quarantined`);
  const r = await quarantine(d, a, reason, { source, claim });
  return r === 'quarantined' ? read(d, a.orgId, a.id) : undefined;
}

type Terminate = 'terminated' | 'needs_settle' | 'needs_proof' | 'moved' | 'busy';
// `stopping → terminated`. The workspace is locked FOR SHARE first (the lock order of the allocate step) and
// the move is refused while it is `active` or `quiescing` at this epoch for this allocation's pod. It is also refused without the proof link
// (`needs_proof`): `terminated` without a proof cannot be written. Capacity is released in the same transaction.
export async function terminateTx(d: RunnerDeps, a: AllocationRow): Promise<Terminate> {
  await faultsOf(d).hit('runner.before_terminate_tx');
  try {
    return await d.db.withTenant({ orgId: a.orgId }, async (tx) => {
      await setLockWait(tx, 5000);
      if (a.workspaceId !== null) {
        const ws = await lockWorkspace(tx, a.orgId, a.workspaceId, 'share');
        if (ws && a.podUid !== null && ws.ownerEpoch === a.ownerEpoch && ws.ownerPodUid === a.podUid && (ws.state === 'active' || ws.state === 'quiescing')) return 'needs_settle';
      }
      const locked = await lockAllocation(tx, a.orgId, a.id);
      if (!locked || locked.state !== 'stopping') return 'moved';
      if ((await quiescenceProof.read(tx, recordDeps(d), a.orgId, a.id)).kind === 'absent') return 'needs_proof';
      const next = await transitionAllocation(tx, { orgId: a.orgId, id: a.id, ownerEpoch: a.ownerEpoch, from: ['stopping'], to: 'terminated', terminated: true, leaseSeconds: null });
      if (!next) return 'moved';
      const stage = await getRunnerStageRunById(tx, a.orgId, a.stageRunId);
      if (stage) await releaseCapacity(tx, d.config, { orgId: a.orgId, stageRunId: a.stageRunId, role: stage.role, generation: a.generation });
      return 'terminated';
    });
  } catch (e) {
    if (isLockTimeout(e)) return 'busy';
    throw e;
  }
}

// ---------------------------------------------------------------- Kubernetes helpers

async function deleteQuietly(f: () => Promise<void>): Promise<void> {
  try { await f(); } catch (e) {
    // 404: already gone. 409 Conflict on a UID precondition: the name now belongs to something else, left alone.
    if (e instanceof KubeError && (e.isNotFound || e.isConflict)) return;
    throw e;
  }
}
const ownedByJobOrNone = (p: KubePod, a: AllocationRow, jobUid: string | null): boolean => {
  const owners = p.metadata.ownerReferences ?? [];
  return owners.length === 0 || owners.some((o) => o.kind === 'Job' && o.name === a.jobName && (jobUid === null || o.uid === jobUid));
};
const allocationSelector = (d: RunnerDeps, a: AllocationRow): string => `${labelKeys(d.config.labelPrefix).allocation}=${a.id}`;
const deletePod = (d: RunnerDeps, p: KubePod): Promise<void> => deleteQuietly(() => d.kube.deletePod(p.metadata.name, p.metadata.uid));

type Fetched<T> = { kind: 'ok'; object: T } | { kind: 'foreign' } | { kind: 'retry' };
// Create, or fetch and validate on AlreadyExists. A timeout is an unknown outcome: read by name before trying again.
async function createOrFetch<T>(create: () => Promise<T>, get: () => Promise<T>, ours: (o: T) => boolean): Promise<Fetched<T>> {
  try { return { kind: 'ok', object: await create() }; } catch (e) {
    if (!(e instanceof KubeError)) throw e;
    if (!e.isAlreadyExists && !e.isUnknownOutcome) throw e;
    try { const found = await get(); return ours(found) ? { kind: 'ok', object: found } : { kind: 'foreign' }; } catch (g) {
      if (g instanceof KubeError && g.isNotFound && e.isUnknownOutcome) return { kind: 'retry' };
      throw g;
    }
  }
}

const read = (d: RunnerDeps, orgId: string, id: string): Promise<AllocationRow | undefined> => d.db.withTenant({ orgId }, (tx) => getAllocation(tx, orgId, id));

// ---------------------------------------------------------------- passes
// Each pass returns true when it changed something (the caller runs another pass) and false when it is waiting.

async function passDesired(d: RunnerDeps, a: AllocationRow): Promise<boolean> {
  const ctx = { stage: undefined as RunnerStageRun | undefined, ws: undefined as WorkspaceRow | undefined };
  await d.db.withTenant({ orgId: a.orgId }, async (tx) => {
    ctx.stage = await getRunnerStageRunById(tx, a.orgId, a.stageRunId);
    if (a.workspaceId !== null) ctx.ws = await getWorkspace(tx, a.orgId, a.workspaceId);
  });
  const stage = ctx.stage;
  if (!stage) return false;
  // Another controller may have moved the row since it was read: stop doing anything for a row that is not `desired`.
  const stopUnlessMoved = async (reason: string): Promise<boolean> => {
    const fresh = await read(d, a.orgId, a.id);
    if (fresh?.state !== 'desired') return true;
    return (await toStopping(d, fresh, reason)) !== undefined;
  };
  let request: RenderInput['request'];
  if (a.workspaceId !== null) {
    const ws = ctx.ws;
    if (!ws || ws.state !== 'allocated' || ws.generation !== a.generation || ws.ownerEpoch !== a.ownerEpoch) return stopUnlessMoved('workspace_not_allocated');
    // The only call site of W-018's materializationRequest: it answers while the row is `allocated` with no receipt.
    try {
      const r = await d.workspaces.materializationRequest(runnerCtx(d, a.orgId, a.taskId), a.workspaceId, a.ownerEpoch);
      if (!r.ok) return await stopUnlessMoved(`materialization_${r.code}`);
      if (r.request.kind !== 'remote') return await stopUnlessMoved('not_supported_bundle_source'); // D13
      request = r.request;
    } catch (e) {
      if (e instanceof WorkspaceError) return stopUnlessMoved(`materialization_${e.code}`);
      throw e;
    }
  }
  let input: RenderInput;
  let job: ReturnType<typeof renderJob>;
  let pvc: ReturnType<typeof renderPvc> | undefined;
  try {
    input = { allocation: a, stage, workspace: ctx.ws, request, config: d.config };
    job = renderJob(input);
    pvc = ctx.ws ? renderPvc(input) : undefined;
  } catch (e) {
    if (e instanceof RunnerError) return stopUnlessMoved(e.code);
    throw e;
  }
  const stillDesired = async (): Promise<AllocationRow | undefined> => { const f = await read(d, a.orgId, a.id); return f?.state === 'desired' && f.ownerEpoch === a.ownerEpoch ? f : undefined; };

  // Claim first, then Job. Never wait for `Bound` (WaitForFirstConsumer).
  if (pvc) {
    if (!(await stillDesired())) return true;
    const spec = pvc;
    const got = await createOrFetch<KubePvc>(() => d.kube.createPvc(spec), () => d.kube.getPvc(spec.metadata.name), (o) => ctx.ws !== undefined && pvcIsOurs(o, a, ctx.ws.id, d.config));
    if (got.kind === 'foreign') return (await toQuarantined(d, a, 'pvc_not_ours')) !== undefined;
    if (got.kind === 'retry') return false;
    await faultsOf(d).hit('runner.after_pvc_create');
  }
  const current = await stillDesired();
  if (!current) return true;
  // The reason is diagnostic only (nothing decides on it): which part of the live Job differs, as paths, so an operator can see why.
  let whyNot = 'job_not_ours';
  const got = await createOrFetch<KubeJob>(() => d.kube.createJob(job), () => d.kube.getJob(job.metadata.name), (o) => {
    if (!jobIsOurs(o, a, d.config)) { whyNot = 'job_not_ours:identity'; return false; }
    const diffs = templateDifferences(o, job);
    if (diffs.length > 0) whyNot = `job_not_ours:template:${diffs.slice(0, 12).join(',')}`.slice(0, 512);
    return diffs.length === 0;
  });
  if (got.kind === 'foreign') return (await toQuarantined(d, a, whyNot)) !== undefined;
  if (got.kind === 'retry') return false;
  const held = got.object;
  await faultsOf(d).hit('runner.after_job_create');

  const bound = await move(d, a, 'starting', { jobUid: held.metadata.uid });
  if (bound) { await faultsOf(d).hit('runner.after_job_bind'); return true; }
  // The compare-and-swap failed. Re-read before doing anything: if the row records the UID we hold, the other
  // controller bound the same Job and there is nothing to do. Only a different UID, or a stopping or finished
  // row, means the Job we hold is not wanted.
  const now = await read(d, a.orgId, a.id);
  if (!now) return true;
  if (now.state === 'desired' && now.jobUid === null) return false; // lost a race for nothing: try again next pass
  // Delete the Job we hold only if the row records another UID, or is stopping or finished. A row that records our UID
  // and is starting, running, suspect, finalizing or completed owns it.
  const another = now.jobUid !== null && now.jobUid !== held.metadata.uid;
  const unwanted = now.state === 'stopping' || now.state === 'terminated' || now.state === 'quarantined';
  if (!another && !unwanted) return true;
  await deleteQuietly(() => d.kube.deleteJob(held.metadata.name, held.metadata.uid));
  return true;
}

async function passStarting(d: RunnerDeps, seen: AllocationRow): Promise<boolean> {
  let a = seen;
  if (a.leaseExpired) return (await toStopping(d, a, 'start_deadline')) !== undefined;
  let job: KubeJob;
  try { job = await d.kube.getJob(a.jobName); } catch (e) {
    if (e instanceof KubeError && e.isNotFound) return (await toStopping(d, a, 'job_missing')) !== undefined;
    throw e;
  }
  if (a.jobUid !== null && job.metadata.uid !== a.jobUid) return (await toQuarantined(d, a, 'job_replaced')) !== undefined;
  // The row was read before the cluster call. A permit may have claimed the writer pod and started the workspace in the
  // meantime, and judging the workspace against the stale claim would stop a good start: judge on a fresh read.
  const fresh = await read(d, a.orgId, a.id);
  if (fresh?.state !== 'starting') return fresh !== undefined;
  a = fresh;

  let ws: WorkspaceRow | undefined;
  if (a.workspaceId !== null) {
    ws = await d.db.withTenant({ orgId: a.orgId }, (tx) => getWorkspace(tx, a.orgId, a.workspaceId as string));
    // Before a permit the workspace at this epoch is `allocated`, or `active` and owned by this allocation's pod (a permit between its steps).
    const ok = ws !== undefined && ws.ownerEpoch === a.ownerEpoch && (ws.state === 'allocated' || (ws.state === 'active' && a.podUid !== null && ws.ownerPodUid === a.podUid));
    if (!ok) return (await toStopping(d, a, 'workspace_not_allocated')) !== undefined;
  }

  const listed = await d.kube.listPods(allocationSelector(d, a), { signal: d.deadline });
  // Read in the order the cluster answered: two controllers may read in different orders, and the outcome must not depend on it.
  const pods = listed.items;
  const candidates: KubePod[] = []; const bad: KubePod[] = []; const live: KubePod[] = [];
  for (const p of pods) {
    if (!ownedByJobOrNone(p, a, a.jobUid ?? job.metadata.uid)) continue; // a foreign owner's pod is not touched
    if (terminating(p)) { live.push(p); continue; }
    if (finished(p) || containerTerminated(p, 'supervisor')) { bad.push(p); continue; } // a pod whose supervisor has exited is a bad pod: it does not sit until the start deadline
    if (a.workspaceId === null) { candidates.push(p); continue; }
    const st = parseMaterializeStatus(p);
    if (st.kind === 'not_finished') { live.push(p); continue; }
    if (st.kind !== 'receipt') { bad.push(p); continue; }
    try {
      await d.workspaces.acceptMaterialization(runnerCtx(d, a.orgId, a.taskId), a.workspaceId, a.ownerEpoch, st.receipt); // the same receipt again is a no-op there
      candidates.push(p);
    } catch (e) {
      if (e instanceof WorkspaceError && (e.code === 'receipt_mismatch' || e.code === 'conflict' || e.code === 'invalid_state')) bad.push(p);
      else throw e;
    }
  }
  let changed = false;
  if (a.podUid !== null) {
    // After the writer claim `pod_uid` governs: every other pod of the allocation is a duplicate.
    for (const p of pods) if (p.metadata.uid !== a.podUid && ownedByJobOrNone(p, a, a.jobUid ?? job.metadata.uid) && !terminating(p)) { await deletePod(d, p); changed = true; }
    const governing = pods.find((p) => p.metadata.uid === a.podUid);
    if (!governing || finished(governing)) return (await toStopping(d, a, 'writer_pod_gone')) !== undefined;
    if (containerTerminated(governing, 'supervisor') && !terminating(governing)) return (await toStopping(d, a, 'supervisor_exited')) !== undefined;
    return changed;
  }
  // Before the claim no candidate is ever deleted: the permit's compare-and-swap on pod_uid picks the winner.
  for (const p of bad) if (!terminating(p)) { await deletePod(d, p); changed = true; }
  if (!listed.truncated && candidates.length === 0 && live.length === 0 && bad.length > 0) return (await toStopping(d, a, 'every_pod_bad')) !== undefined;
  return changed;
}

async function passRunning(d: RunnerDeps, a: AllocationRow): Promise<boolean> {
  if (a.leaseExpired) return (await toStopping(d, a, 'lease_expired')) !== undefined;
  // A workspace that is no longer at this allocation's epoch, or no longer this pod's, means the writer was fenced: stop it (C11).
  if (a.workspaceId !== null && a.podUid !== null && await d.db.withTenant({ orgId: a.orgId }, (tx) => workspaceFenced(tx, a.orgId, a.id))) return (await toStopping(d, a, 'workspace_fenced')) !== undefined;
  const listed = await d.kube.listPods(allocationSelector(d, a), { signal: d.deadline });
  const owned = listed.items.filter((p) => ownedByJobOrNone(p, a, a.jobUid));
  let changed = false;
  for (const p of owned) if (p.metadata.uid !== a.podUid && !terminating(p)) { await deletePod(d, p); changed = true; }
  const governing = owned.find((p) => p.metadata.uid === a.podUid);
  if (!governing || finished(governing) || terminating(governing)) return (await toStopping(d, a, 'writer_pod_gone')) !== undefined;
  // Either container of the writer's pod has exited: stop the whole pod at once, without waiting for the lease or for a hold (the stage run has no cancel record).
  // The harness's exit is read from the cluster, never from anything the pod reported (rule 5).
  if (containerTerminated(governing, 'harness')) return (await toStopping(d, a, 'harness_exited')) !== undefined;
  if (containerTerminated(governing, 'supervisor')) return (await toStopping(d, a, 'supervisor_exited')) !== undefined;
  const heartbeatOld = a.heartbeatAgeMs !== null && a.heartbeatAgeMs > d.config.suspectSeconds * 1000;
  if (a.state === 'running' && (governing.status.phase !== 'Running' || heartbeatOld)) return (await move(d, a, 'suspect')) !== undefined;
  return changed;
}

// The hold (06:90): the pass waits, and deletes nothing, while every one of these is true, each read in SQL.
async function holdApplies(d: RunnerDeps, a: AllocationRow): Promise<boolean> {
  const waitMs = d.config.cancelCheckpointWaitSeconds * 1000;
  if (waitMs <= 0 || a.sinceUpdateMs >= waitMs) return false;
  if (a.heartbeatBeforeUpdateMs === null || a.heartbeatBeforeUpdateMs > d.config.suspectSeconds * 1000) return false; // the last heartbeat must be recent when the stop began
  return d.db.withTenant({ orgId: a.orgId }, async (tx) => {
    if (!(await hasCancelStop(tx, a.orgId, a.id))) return false;                   // this stop was caused by the cancel
    if (await hasUrgentStop(tx, a.orgId, a.stageRunLogicalId)) return false;       // an urgent stop skips the hold
    if ((await readWriterStart(tx, a.orgId, a.id)) === undefined) return false;    // a supervisor was granted
    return !(await hasStopAck(tx, a.orgId, a.id));                                 // nobody has acknowledged yet
  });
}

// "One entry per pod still listed" does not fit the 64 KiB cap at the port's 500-pod page, so the body keeps the writer's pod and the first of the
// rest, the count, and a digest over the whole observation (the cap would otherwise refuse every proof of a crowded namespace).
const MAX_PROOF_PODS = 100;
function boundedPods(observation: readonly PodObservation[], writerUid: string | null, limit: number = MAX_PROOF_PODS): QuiescenceProofBody['pods'] {
  const map = (p: PodObservation): QuiescenceProofBody['pods'][number] => ({ podUid: p.podUid, phase: p.phase, containers: p.containers.map((c) => ({ name: c.name, kind: c.kind, state: c.state, ...(c.exitCode === undefined ? {} : { exitCode: c.exitCode }) })) });
  const writer = observation.filter((p) => p.podUid === writerUid);
  return [...writer, ...observation.filter((p) => p.podUid !== writerUid)].slice(0, limit).map(map);
}
// A body that would not fit the 64 KiB cap shrinks until it does (the writer's pod first, then the count and digest alone): a proof that cannot be written would
// throw in every pass and stop the allocation for good. Pods carry up to 64 containers each, so 100 of them can exceed the cap.
function fit<T extends object>(make: (limit: number) => T): T {
  for (const limit of [MAX_PROOF_PODS, 25, 5, 1]) { const b = make(limit); if (Buffer.byteLength(canonicalJson(b)) <= MAX_RECORD_BYTES - 2048) return b; }
  return make(0);
}

type Registered = 'registered' | 'exists' | 'not_stopping';
// The proof, on the caller's transaction under the allocation's row lock, in `stopping` only. A second controller finds the first one's link.
async function registerProof(d: RunnerDeps, a: AllocationRow, handle: RecordHandle): Promise<Registered> {
  const rd = recordDeps(d);
  return d.db.withTenant({ orgId: a.orgId }, async (tx): Promise<Registered> => {
    await setLockWait(tx, 5000);
    const locked = await lockAllocation(tx, a.orgId, a.id);
    if (!locked || locked.state !== 'stopping' || locked.ownerEpoch !== a.ownerEpoch) return 'not_stopping'; // moved (a quarantine that committed first): nothing is registered
    return (await quiescenceProof.register(tx, rd, handle)).kind;
  });
}

// Step 5 and 6: settle the workspace on the proof, then `terminated`.
async function finishStop(d: RunnerDeps, a: AllocationRow): Promise<boolean> {
  await settleWorkspace(d, a, 'proof');
  let r = await terminateTx(d, a);
  if (r === 'needs_settle') { await settleWorkspace(d, a, 'proof'); r = await terminateTx(d, a); }
  return r === 'terminated';
}

async function passStopping(d: RunnerDeps, a: AllocationRow): Promise<boolean> {
  const rd = recordDeps(d);
  // 1. A stored proof is a one-way door: the hold is never consulted once one exists, and the deletes below still run for hygiene.
  const stored = await d.db.withTenant({ orgId: a.orgId }, (tx) => quiescenceProof.read(tx, rd, a.orgId, a.id));
  // 2. The hold.
  if (stored.kind === 'absent' && await holdApplies(d, a)) return false;
  // 3. As before: settle the first edge, delete, list, evaluate.
  await settleWorkspace(d, a, 'stopping');
  // The Job: with a recorded UID delete by it; with none, read by name, validate as an attach would, delete by the UID just read.
  let jobUid = a.jobUid;
  if (jobUid === null) {
    try {
      const found = await d.kube.getJob(a.jobName);
      if (!jobIsOurs(found, a, d.config)) return (await toQuarantined(d, a, 'job_not_ours')) !== undefined;
      jobUid = found.metadata.uid;
    } catch (e) { if (!(e instanceof KubeError && e.isNotFound)) throw e; }
  }
  if (jobUid !== null) { const uid = jobUid; await deleteQuietly(() => d.kube.deleteJob(a.jobName, uid)); await faultsOf(d).hit('runner.after_job_delete'); }
  // Every pod that carries the allocation's label and has this Job, or nothing, as its owner.
  const before = await d.kube.listPods(allocationSelector(d, a), { signal: d.deadline });
  for (const p of before.items) if (ownedByJobOrNone(p, a, jobUid) && !terminating(p) && !finished(p)) await deletePod(d, p);
  if (stored.kind === 'present') return finishStop(d, a);
  // The proof, read fresh.
  let jobAbsent = false;
  try { await d.kube.getJob(a.jobName); } catch (e) { if (e instanceof KubeError && e.isNotFound) jobAbsent = true; else throw e; }
  const after = await d.kube.listPods(allocationSelector(d, a), { signal: d.deadline });
  const startRecord = await d.db.withTenant({ orgId: a.orgId }, (tx) => readWriterStart(tx, a.orgId, a.id));
  const sr = startRecord === undefined ? undefined : { nodeName: typeof startRecord.details?.['nodeName'] === 'string' ? startRecord.details['nodeName'] : null, nodeUid: typeof startRecord.details?.['nodeUid'] === 'string' ? startRecord.details['nodeUid'] : null };
  const writerListed = a.podUid !== null && after.items.some((p) => p.metadata.uid === a.podUid);
  let nodeNow: { name: string; uid: string } | 'absent' | 'unreadable' | undefined;
  if (d.config.nodeCheck === 'required' && sr !== undefined && sr.nodeName !== null && a.podUid !== null && !writerListed) {
    try { nodeNow = await d.kube.getNode(sr.nodeName); } catch (e) { if (e instanceof KubeError) nodeNow = e.isNotFound ? 'absent' : 'unreadable'; else throw e; }
  }
  let claim: { name: string; uid: string | null } | undefined;
  let nsPods: Awaited<ReturnType<RunnerDeps['kube']['listPods']>> | undefined;
  if (a.workspaceId !== null) {
    const name = pvcName(a.orgId, a.workspaceId, a.generation);
    let uid: string | null = null;
    try { uid = (await d.kube.getPvc(name)).metadata.uid; } catch (e) { if (!(e instanceof KubeError && e.isNotFound)) throw e; }
    claim = { name, uid };
    nsPods = await d.kube.listPods('', { signal: d.deadline }); // WITHOUT a selector: an unlabelled pod on the claim is exactly what the labelled lists miss
  }
  const q = evaluateQuiescence({ jobAbsent, pods: after.items, podsTruncated: after.truncated, jobUidRecorded: a.jobUid !== null, stoppingForMs: a.sinceUpdateMs, requestDeadlineMs: d.config.requestDeadlineSeconds * 1000,
    writerPodUid: a.podUid, startRecord: sr, nodeNow, nodeCheck: d.config.nodeCheck, claim, namespacePods: nsPods?.items ?? [], namespaceTruncated: nsPods?.truncated ?? false });
  if (q.proved) {
    // 4. prepare (the put, no transaction), then lock, re-check and register. The observation time is read here, before the put.
    const observedAt = await d.db.withTenant({ orgId: a.orgId }, (tx) => readDbClock(tx));
    const body = fit((limit): QuiescenceProofBody => ({
      schema: QUIESCENCE_PROOF_SCHEMA, organizationId: a.orgId, taskId: a.taskId, allocationId: a.id, stageRunId: a.stageRunLogicalId, generation: a.generation, epoch: a.ownerEpoch, workspaceId: a.workspaceId,
      job: { name: a.jobName, uid: a.jobUid, absent: true },
      writer: a.podUid === null ? null : { podUid: a.podUid, podName: typeof startRecord?.details?.['podName'] === 'string' ? startRecord.details['podName'] : null, nodeName: sr?.nodeName ?? null, nodeUid: sr?.nodeUid ?? null },
      pods: boundedPods(q.observation, a.podUid, limit), podCount: q.observation.length, observationDigest: sha256(canonicalJson(q.observation)),
      writerPod: q.facts.writerPod, nodeCheck: q.facts.nodeCheck, detachment: q.facts.detachment, storage: 'pod_scoped_local', observedAt,
    }));
    const handle = await quiescenceProof.prepare(rd, d.config.runnerIdentity, { orgId: a.orgId, taskId: a.taskId, allocationId: a.id, body: body });
    await faultsOf(d).hit('runner.after_proof_put');
    const reg = await registerProof(d, a, handle);
    if (reg === 'not_stopping') return true; // another controller moved the row; the next pass reads what it left
    await faultsOf(d).hit('runner.after_proof_registered');
    return finishStop(d, a);
  }
  // Not proved by the stop deadline (held in controller_lease_until): quarantined, with the obligation recorded. The move reads the proof link
  // under the row lock; if a proof was stored in the meantime it refuses, and this pass goes on to settle and terminate with that proof.
  if (a.leaseExpired) {
    // An unreadable node is retried, not quarantined, until `nodeReadGraceSeconds` past the stop deadline: a transient API error at the deadline would
    // quarantine a stop that proves one pass later. The bound is the grace; after it the stop is quarantined as before (lease_remaining is negative once expired).
    if (q.reason === 'writer_node_unreadable' && (a.leaseRemainingMs ?? 0) > -d.config.nodeReadGraceSeconds * 1000) return false;
    const out = await quarantine(d, a, `no_proof_of_quiescence:${q.reason}`, { source: 'stopping', notProvedBecause: q.reason, observation: q.observation, claim: claim ?? null });
    if (out === 'proof_exists') return finishStop(d, a);
    return out === 'quarantined';
  }
  return false;
}

export async function passOnce(d: RunnerDeps, orgId: string, id: string): Promise<boolean> {
  const a = await read(d, orgId, id);
  if (!a) return false;
  switch (a.state) {
    case 'desired': return passDesired(d, a);
    case 'starting': return passStarting(d, a);
    case 'running': case 'suspect': return passRunning(d, a);
    case 'stopping': return passStopping(d, a);
    default: return false; // finalizing is W-020's (D22); terminal states have nothing more to do
  }
}

// Passes for one allocation until nothing changes or the budget is spent.
export async function reconcileOne(d: RunnerDeps, orgId: string, id: string, budgetMs: number = d.config.inlineReconcileBudgetMs): Promise<void> {
  // A real deadline: list calls inside a pass stop paging when it fires, not only between passes.
  const dd: RunnerDeps = { ...d, deadline: AbortSignal.timeout(budgetMs) };
  for (let i = 0; i < 12 && !dd.deadline?.aborted; i += 1) if (!(await passOnce(dd, orgId, id))) return;
}

// ---------------------------------------------------------------- the sweep and the loop

// Jobs that should not exist are deleted on sight. A Job whose annotations validate as allocation X's is
// deleted (UID precondition, Background) when X is in any state but `desired` and the Job's UID is not
// X's recorded one, or when X is `terminated`, whatever the UID. In `desired` an unrecorded Job is bound, not deleted.
export async function sweepJobs(d: RunnerDeps): Promise<number> {
  const listed = await d.kube.listJobs(labelKeys(d.config.labelPrefix).allocation, { signal: d.deadline });
  let deleted = 0;
  for (const job of listed.items.slice(0, MAX_SWEPT_JOBS)) {
    const claim = claimedAllocation(job, d.config);
    if (!claim || !UUID.test(claim.orgId) || !UUID.test(claim.allocationId)) continue;
    const a = await read(d, claim.orgId, claim.allocationId);
    if (!a || a.state === 'desired') continue;
    if (!jobIsOurs({ metadata: { ...job.metadata, uid: a.jobUid ?? job.metadata.uid } }, a, d.config)) continue;
    const unknownToRow = a.jobUid !== job.metadata.uid;
    if (a.state === 'terminated' || unknownToRow) {
      await deleteQuietly(() => d.kube.deleteJob(job.metadata.name, job.metadata.uid));
      deleted += 1;
    }
  }
  return deleted;
}

export type PassSummary = { allocations: number; errors: unknown[]; swept: number; openQuarantines: number; liveWriters: number };
// One pass over every organization: at most `maxAllocationsPerPass` allocations each, one failure not stopping the pass.
export async function reconcileOnce(d: RunnerDeps): Promise<PassSummary> {
  const summary: PassSummary = { allocations: 0, errors: [], swept: 0, openQuarantines: 0, liveWriters: 0 };
  const orgs = await d.db.withoutTenant((tx) => listActiveOrganizationIds(tx));
  for (const orgId of orgs) {
    let ids: string[];
    try { ids = await d.db.withTenant({ orgId }, (tx) => listReconcilableAllocationIds(tx, orgId, d.config.maxAllocationsPerPass)); } catch (e) { summary.errors.push(e); continue; }
    try {
      summary.liveWriters += await d.db.withTenant({ orgId }, (tx) => countLiveWriters(tx, orgId));
      summary.openQuarantines += await d.db.withTenant({ orgId }, (tx) => countQuarantinedOlderThan(tx, orgId, d.config.quarantineEscalateDays * 86_400));
    } catch (e) { summary.errors.push(e); }
    for (const id of ids) {
      summary.allocations += 1;
      try { await reconcileOne(d, orgId, id); } catch (e) { summary.errors.push(e); }
    }
  }
  try { summary.swept = await sweepJobs(d); } catch (e) { summary.errors.push(e); }
  // The review budget follows the writers that are running, across organizations (the permit service sizes itself from this).
  d.onLiveWriters?.(summary.liveWriters);
  if (summary.openQuarantines > 0) (d.onWarning ?? ((m: string): void => { console.warn(m); }))(`[runner] ${String(summary.openQuarantines)} quarantined allocation(s) are past their escalation time and need an operator`);
  return summary;
}

export type LoopHandle = { stop: () => Promise<void> };
// A loop every 15 s with 20% jitter. A pass that fails (a lost session, a cluster error) does not stop the loop.
export function startReconcileLoop(d: RunnerDeps, onPass?: (s: PassSummary) => void): LoopHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  const schedule = (): void => {
    if (stopped) return;
    const delay = d.config.reconcileIntervalMs * (0.8 + Math.random() * 0.4);
    timer = setTimeout(() => {
      running = (async (): Promise<void> => {
        try { onPass?.(await reconcileOnce(d)); } catch (e) { onPass?.({ allocations: 0, errors: [e], swept: 0, openQuarantines: 0, liveWriters: 0 }); }
        schedule();
      })();
    }, delay);
  };
  schedule();
  return { stop: async () => { stopped = true; if (timer) clearTimeout(timer); await running; } };
}
export const newCorrelation = (): string => randomUUID();
