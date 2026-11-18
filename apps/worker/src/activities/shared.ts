// Shared pieces of the TaskWorkflow Activities: dependency and behaviour types, constants, and the
// tenant, artifact and authority helpers every Activity group uses.
import { validateContract } from '@factory/contracts';
import { canonicalJson, checkOutcomeProvenance, evaluateOutcomeRecorded, resolveAuthorities, type AuthorityIo, type ContractCheck, type GateDecision } from '@factory/domain';
import type { Database, Tx } from '@factory/database';
import type { ArtifactService } from '@factory/artifacts';
import type { ArtifactRefLike, FakeStageResult } from '../workflows/types.ts';

export const PLAN_SECTIONS = ['intent_scope', 'current_state', 'design', 'interfaces_data', 'implementation', 'acceptance_tests', 'quality_security', 'delivery_recovery', 'operations', 'risks_decisions', 'definition_of_done', 'review_ownership'] as const;
export const DEFAULT_DECISION_TTL_MS = 72 * 60 * 60 * 1000;
// M1 default policy (A-10). W-013 replaces this with the resolved PolicyProfile.
export const M1_POLICY = { id: 'm1-default-policy', revision: 1, defaultAssurance: 'standard' } as const;

export type FakeStageBehavior = {
  delayMs?: (nodeId: string, attempt: number, planVersion: number) => number;
  outcome?: (nodeId: string, attempt: number, planVersion: number) => FakeStageResult['status'];
  // Overrides the structured evidence the fake stage emits (e.g. a blocking review finding).
  evidence?: (nodeId: string, defaults: Record<string, unknown>) => Record<string, unknown>;
  // Estimated and actual model cost of a fake stage, in micro-USD (default 1 USD each).
  estimateMicroUsd?: (nodeId: string) => number;
  actualMicroUsd?: (nodeId: string) => number;
  // Makes the fake runner fail outright (as a crashed pod would), instead of returning a result.
  crash?: (nodeId: string, attempt: number) => boolean;
  // Holds the stage (heartbeating) until the returned promise settles: a latch a test controls, for
  // tests that must act while a stage is in flight without relying on timing.
  hold?: (nodeId: string, attempt: number, planVersion: number) => Promise<void> | undefined;
  // Overrides the producer identity the fake runner reports (e.g. a reviewer that is the author).
  producerId?: (nodeId: string) => string;
};

export const EVALUATOR_ID = 'gate-evaluator:m1';
export const REVIEWER_PRODUCER = 'fake-reviewer';
export const AUTHOR_PRODUCER = 'fake-runner';
export type ActivityDeps = { db: Database; artifacts: ArtifactService; fakeStage?: FakeStageBehavior; templateOverrides?: Record<string, string>; decisionTtlMs?: number };

export const CONTROLLER = 'control-plane:worker';
export const contractCheck: ContractCheck = (contract, value) => validateContract(contract, value).ok;

export type ActivityKit = {
  deps: ActivityDeps;
  tenant: <T>(orgId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>;
  store: (orgId: string, taskId: string, doc: unknown, purpose: string, tx?: Tx) => Promise<ArtifactRefLike>;
  readJson: <T>(orgId: string, taskId: string, ref: ArtifactRefLike) => Promise<T>;
  authorityIo: (orgId: string, taskId: string) => AuthorityIo;
  outcomeDecision: (orgId: string, taskId: string, manifestRef: ArtifactRefLike) => Promise<GateDecision>;
};

export function createActivityKit(deps: ActivityDeps): ActivityKit {
  const tenant = <T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> => deps.db.withTenant({ orgId }, fn);
  const store = async (orgId: string, taskId: string, doc: unknown, purpose: string, tx?: Tx): Promise<ArtifactRefLike> => {
    const object = await deps.artifacts.putControllerObject(orgId, Buffer.from(canonicalJson(doc)));
    const register = (t: Tx) => deps.artifacts.registerControllerArtifact(t, { orgId, taskId, producerId: CONTROLLER, object, mediaType: 'application/json', schemaVersion: '2.0', classification: 'ordinary', purpose });
    return tx ? register(tx) : tenant(orgId, register);
  };
  const readJson = async <T>(orgId: string, taskId: string, ref: ArtifactRefLike): Promise<T> =>
    JSON.parse((await deps.artifacts.readVerified({ orgId, actorId: CONTROLLER, actorKind: 'service', taskId, grantIds: [], correlationId: taskId }, ref)).toString('utf8')) as T;

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  // Human-authority resolution against the ArtifactStore (digest-verified bytes) and the immutable
  // decision rows (INV-29). Shared by manifest construction and the outcome_recorded evaluator.
  const authorityIo = (orgId: string, taskId: string): AuthorityIo => ({
    read: async (ref) => { try { return await readJson<unknown>(orgId, taskId, ref); } catch { return undefined; } },
    decision: (requestId) => UUID.test(requestId) ? tenant(orgId, async (tx) => {
      const r = await tx.query<{ id: string; task_id: string; state: string; subject_hash: string; decider_id: string; actor_kind: string; created_at: Date }>(
        'SELECT r.id, r.task_id, r.state, r.subject_hash, d.decider_id, d.actor_kind, d.created_at FROM factory.decision_request r JOIN factory.decision d ON d.org_id = r.org_id AND d.request_id = r.id WHERE r.id = $1', [requestId]);
      const row = r.rows[0];
      return row ? { requestId: row.id, taskId: row.task_id, deciderId: row.decider_id, actorKind: row.actor_kind, state: row.state, subjectHash: row.subject_hash, decidedAt: row.created_at.toISOString() } : undefined;
    }) : Promise.resolve(undefined),
    isAi: (ref) => tenant(orgId, async (tx) => ((await tx.query("SELECT 1 FROM factory.ai_review_decision WHERE id::text = $1 OR decision_ref->>'artifactId' = $1 LIMIT 1", [ref.artifactId])).rowCount ?? 0) > 0),
  });
  const verifies = async (orgId: string, taskId: string, ref: ArtifactRefLike): Promise<boolean> => {
    try { await deps.artifacts.readVerified({ orgId, actorId: CONTROLLER, actorKind: 'service', taskId, grantIds: [], correlationId: taskId }, ref); return true; } catch { return false; }
  };
  // outcome_recorded on the real manifest: schema, task, scope, delivered bytes, human provenance
  // and cleanup are all re-established from trusted state, not read from the manifest's claims.
  const outcomeDecision = async (orgId: string, taskId: string, manifestRef: ArtifactRefLike): Promise<GateDecision> => {
    let manifest: Record<string, unknown>;
    try { manifest = await readJson<Record<string, unknown>>(orgId, taskId, manifestRef); } catch { return { verdict: 'failed', reasonCodes: ['outcome_manifest_unreadable'] }; }
    const task = await tenant(orgId, (tx) => tx.query<{ delivery_scope: string; cleanup_state: string; allocations: string }>(
      'SELECT t.delivery_scope, t.cleanup_state, (SELECT count(*) FROM factory.execution_allocation a JOIN factory.stage_run s ON s.org_id = a.org_id AND s.id = a.stage_run_id WHERE s.task_id = t.id) AS allocations FROM factory.task t WHERE t.id = $1', [taskId]));
    const t = task.rows[0];
    if (!t) return { verdict: 'failed', reasonCodes: ['task_not_found'] };
    const delivered = Array.isArray(manifest.deliveredArtifactRefs) ? (manifest.deliveredArtifactRefs as ArtifactRefLike[]) : [];
    let verifiedDeliveredRefs = 0;
    for (const ref of delivered) if (await verifies(orgId, taskId, ref)) verifiedDeliveredRefs += 1;
    const provenance = checkOutcomeProvenance(manifest, await resolveAuthorities(manifest, authorityIo(orgId, taskId)), { aiOnlySupported: false, validate: contractCheck });
    return evaluateOutcomeRecorded({ manifest, taskId, deliveryScope: t.delivery_scope, verifiedDeliveredRefs, provenance, cleanupKnown: t.cleanup_state === 'complete' && Number(t.allocations) === 0, validate: contractCheck });
  };

  return { deps, tenant, store, readJson, authorityIo, outcomeDecision };
}
