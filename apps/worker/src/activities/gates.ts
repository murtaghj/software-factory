// Gate Activities: trusted evaluation of gates and invalidation on a plan revision.
import { randomUUID } from 'node:crypto';
import { canonicalHash, evaluateReviewPassed, evaluateScopeAccepted, gateBinding, gateInputHash, type GateDecision, type GateId } from '@factory/domain';
import type { ArtifactRefLike, GateResult, TaskActivities } from '../workflows/types.ts';
import { EVALUATOR_ID, type ActivityKit } from './shared.ts';

type Gates = Pick<TaskActivities, 'evaluateGates' | 'supersedeGates'>;

export function gateActivities({ tenant, readJson, outcomeDecision }: ActivityKit): Gates {
  return {
    // Trusted gate evaluation: reads finalized evidence, applies the pure evaluator and records an
    // immutable gate_evaluation bound to the gate's declared input projection (INV-04). A gate with
    // no qualified evaluator in this release is inconclusive, never passed.
    async evaluateGates({ orgId, taskId, logicalId, requiredGateIds, binding, outputRefs, dependencyRefs, producers }) {
      const results: GateResult[] = [];
      const primary = outputRefs[0];
      for (const gateId of requiredGateIds as GateId[]) {
        const evidenceField: Partial<Record<GateId, { field: string; extra?: Record<string, unknown> }>> = {
          scope_accepted: { field: 'scopeEvidenceRef' },
          review_passed: { field: 'reviewReportRef', extra: { candidateRef: dependencyRefs[0] } },
          outcome_recorded: { field: 'outcomeManifestRef' },
        };
        const spec = evidenceField[gateId];
        let decision: GateDecision;
        let full: Record<string, unknown> = binding;
        if (!spec || !primary) {
          decision = { verdict: 'inconclusive', reasonCodes: [primary ? 'no_qualified_evaluator' : 'no_evidence'] };
        } else {
          full = { ...binding, [spec.field]: primary, ...spec.extra };
          if (gateId === 'outcome_recorded') {
            decision = await outcomeDecision(orgId, taskId, primary);
          } else {
            const doc = await readJson<Record<string, unknown>>(orgId, taskId, primary);
            if (gateId === 'scope_accepted') {
              // The criteria to map are the pinned ones, not the discovery stage's own list.
              const pinned = binding.criteriaRef ? (await readJson<{ criteria: Array<{ id: string }> }>(orgId, taskId, binding.criteriaRef as ArtifactRefLike)).criteria.map((c) => c.id) : doc.criteriaIds;
              decision = evaluateScopeAccepted({ ...doc, criteriaIds: pinned });
            } else {
              // Independence comes from the producers recorded for the stage runs, not from the
              // reviewer's description of itself.
              decision = evaluateReviewPassed(producers ? { ...doc, reviewerProducerId: producers.reviewerProducerId, authorProducerIds: producers.authorProducerIds } : doc);
            }
          }
        }
        let inputHash: string;
        let projection: Record<string, unknown>;
        try {
          inputHash = gateInputHash(gateId, full);
          projection = gateBinding(gateId, full);
        } catch {
          inputHash = canonicalHash({ gateId, incomplete: full });
          projection = full;
          decision = { verdict: 'inconclusive', reasonCodes: ['incomplete_binding'] };
        }
        const evaluationId = await tenant(orgId, async (tx) => {
          await tx.query('SELECT 1 FROM factory.task WHERE id = $1 FOR UPDATE', [taskId]); // serialize per task
          const prior = await tx.query<{ id: string; verdict: string; reason_codes: string[] }>('SELECT id, verdict, reason_codes FROM factory.gate_evaluation WHERE task_id = $1 AND gate_id = $2 AND input_hash = $3 AND superseded_by IS NULL AND verdict <> $4', [taskId, gateId, inputHash, 'superseded']);
          const existing = prior.rows[0];
          if (existing) { decision = { verdict: existing.verdict as GateDecision['verdict'], reasonCodes: existing.reason_codes }; return existing.id; }
          const id = randomUUID();
          await tx.query(`INSERT INTO factory.gate_evaluation (org_id, id, task_id, gate_id, input_hash, input_binding, verdict, evidence_refs, evaluator_id, policy_ref, reason_codes, resolved_mode)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'automated')`,
            [orgId, id, taskId, gateId, inputHash, JSON.stringify({ ...projection, ...(binding.applicationSnapshotRef ? { applicationSnapshotRef: binding.applicationSnapshotRef } : {}), stageRunId: logicalId }), decision.verdict, JSON.stringify(primary ? [primary] : []), EVALUATOR_ID, JSON.stringify(binding.policyRef ?? null), JSON.stringify(decision.reasonCodes)]);
          return id;
        });
        results.push({ gateId, verdict: decision.verdict, evaluationId, reasonCodes: decision.reasonCodes });
      }
      return { allPassed: results.every((r) => r.verdict === 'passed'), results };
    },

    // A plan revision invalidates every evaluation bound to the old plan. The old rows stay
    // immutable; an appended 'superseded' marker records why and old rows point to it.
    async supersedeGates({ orgId, taskId, oldPlanVersion, newPlanVersion }) {
      return tenant(orgId, async (tx) => {
        const rows = await tx.query<{ id: string; gate_id: string; policy_ref: unknown }>("SELECT id, gate_id, policy_ref FROM factory.gate_evaluation WHERE task_id = $1 AND superseded_by IS NULL AND verdict <> 'superseded' AND (input_binding->>'planVersion')::int = $2", [taskId, oldPlanVersion]);
        for (const r of rows.rows) {
          const marker = randomUUID();
          await tx.query(`INSERT INTO factory.gate_evaluation (org_id, id, task_id, gate_id, input_hash, input_binding, verdict, evidence_refs, evaluator_id, policy_ref, reason_codes)
            VALUES ($1,$2,$3,$4,$5,$6,'superseded','[]','gate-engine:invalidation',$7,$8)`,
            [orgId, marker, taskId, r.gate_id, canonicalHash({ supersedes: r.id, newPlanVersion }), JSON.stringify({ supersedes: r.id, newPlanVersion }), JSON.stringify(r.policy_ref), JSON.stringify(['plan_revised'])]);
          await tx.query('UPDATE factory.gate_evaluation SET superseded_by = $2, updated_at = now() WHERE id = $1', [r.id, marker]);
        }
        return rows.rowCount ?? 0;
      });
    },
  };
}
