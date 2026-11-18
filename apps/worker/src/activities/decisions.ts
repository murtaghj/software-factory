// Decision Activities: the bound plan-review request, the immutable human decision with the
// authority re-check at application time, and supersession.
import { randomUUID } from 'node:crypto';
import { canonicalHash, gateBinding, gateInputHash } from '@factory/domain';
import type { ArtifactRefLike, TaskActivities } from '../workflows/types.ts';
import { DEFAULT_DECISION_TTL_MS, EVALUATOR_ID, PLAN_SECTIONS, type ActivityKit } from './shared.ts';

type Decisions = Pick<TaskActivities, 'requestPlanReview' | 'settleDecision' | 'supersedeDecisions'>;

export function decisionActivities({ deps, tenant, store }: ActivityKit): Decisions {
  return {
    // Opens the bound approve_plan request for one independent required peer: an active reviewer on
    // the application who is neither the task's creator nor its owner.
    async requestPlanReview({ orgId, taskId, planVersion, nodeId, packetRef, policyRef }) {
      return tenant(orgId, async (tx) => {
        const task = await tx.query<{ creator_id: string; owner_principal_id: string; primary_application_id: string }>('SELECT creator_id, owner_principal_id, primary_application_id FROM factory.task WHERE id = $1', [taskId]);
        const t = task.rows[0];
        if (!t) return { ok: false as const, reason: 'task_not_found' };
        const authors = [...new Set([t.creator_id, t.owner_principal_id])];
        const reviewers = await tx.query<{ principal_id: string }>(`SELECT DISTINCT m.principal_id FROM factory.membership m JOIN factory.principal p ON p.org_id = m.org_id AND p.id = m.principal_id
          WHERE m.role = 'reviewer' AND m.revoked_at IS NULL AND p.disabled_at IS NULL AND (m.application_scope ? $1 OR m.application_scope ? '*') AND NOT (m.principal_id = ANY($2::uuid[])) ORDER BY m.principal_id`, [t.primary_application_id, authors]);
        const required = reviewers.rows[0]?.principal_id;
        if (!required) return { ok: false as const, reason: 'no_eligible_independent_reviewer' };
        const ttlMs = deps.decisionTtlMs ?? DEFAULT_DECISION_TTL_MS;
        const sectionIds = [...PLAN_SECTIONS];
        const subjectHash = canonicalHash({ action: 'approve_plan', taskId, planVersion, nodeId, packetRef, policyRef, requiredPrincipalId: required, sectionIds });
        await tx.query(`INSERT INTO factory.decision_request (org_id, id, task_id, action, subject_hash, subject_ref, policy_ref, evidence_refs, eligible_roles, required_principal_id, state, expires_at, reason)
          VALUES ($1,$2,$3,'approve_plan',$4,$5,$6,$7,'["reviewer"]',$8,'pending',now() + make_interval(secs => $9::bigint / 1000.0),$10)
          ON CONFLICT (org_id, task_id, subject_hash, required_principal_id) WHERE action = 'approve_plan' DO NOTHING`,
          [orgId, randomUUID(), taskId, subjectHash, JSON.stringify(packetRef), JSON.stringify(policyRef), JSON.stringify([packetRef]), required, ttlMs, 'Approve the exact engineering plan packet before implementation']);
        const r = await tx.query<{ id: string }>("SELECT id FROM factory.decision_request WHERE task_id = $1 AND subject_hash = $2 AND required_principal_id = $3 AND action = 'approve_plan'", [taskId, subjectHash, required]);
        const id = r.rows[0]?.id;
        if (!id) throw new Error('decision request not persisted');
        return { ok: true as const, decision: { nodeId, requestId: id, subjectHash, requiredPrincipalId: required, sectionIds, authorPrincipalIds: authors, ttlMs, state: 'pending' as const } };
      });
    },

    // Records the immutable human decision (or the expiry/supersession) and evaluates
    // plan_peer_approved, re-checking the decider's authority at application time.
    async settleDecision({ orgId, taskId, decision, binding }) {
      return tenant(orgId, async (tx) => {
        const reasons: string[] = [];
        if (decision.state === 'approve' || decision.state === 'reject' || decision.state === 'request_changes') {
          const decider = decision.deciderPrincipalId ?? '';
          // The durable timer can fire late (worker down); the stored expiry still binds.
          const live = await tx.query<{ expired: boolean }>('SELECT expires_at <= now() AS expired FROM factory.decision_request WHERE id = $1', [decision.requestId]);
          if (live.rows[0]?.expired !== false) reasons.push('decision_expired');
          const authority = await tx.query<{ id: string }>(`SELECT m.id FROM factory.membership m JOIN factory.principal p ON p.org_id = m.org_id AND p.id = m.principal_id JOIN factory.task t ON t.id = $2
            WHERE m.principal_id = $1 AND m.role = 'reviewer' AND m.revoked_at IS NULL AND p.disabled_at IS NULL AND (m.application_scope ? t.primary_application_id::text OR m.application_scope ? '*')`, [decider, taskId]);
          const membership = authority.rows[0]?.id;
          if (!membership) reasons.push('decider_authority_revoked');
          await tx.query(`INSERT INTO factory.decision (org_id, id, request_id, decider_id, subject_hash, command_id, reviewed_section_ids, outcome, reason, authority_ref)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (org_id, request_id) DO NOTHING`,
            [orgId, randomUUID(), decision.requestId, decider, decision.subjectHash, decision.commandId ?? randomUUID(), JSON.stringify(decision.reviewedSectionIds ?? []), decision.state, decision.reason ?? decision.state, JSON.stringify({ role: 'reviewer', membershipId: membership ?? null, revalidatedAtApply: true })]);
          const stateName = decision.state === 'approve' ? 'approved' : decision.state === 'reject' ? 'rejected' : 'changes_requested';
          await tx.query("UPDATE factory.decision_request SET state = $2, updated_at = now() WHERE id = $1 AND state = 'pending'", [decision.requestId, stateName]);
        } else {
          await tx.query("UPDATE factory.decision_request SET state = $2, updated_at = now() WHERE id = $1 AND state = 'pending'", [decision.requestId, decision.state]);
          reasons.push(decision.state === 'expired' ? 'decision_expired' : 'decision_superseded');
        }
        if (decision.state !== 'approve') reasons.push(`outcome_${decision.state}`);
        const passed = reasons.length === 0;
        const request = await tx.query<{ subject_ref: ArtifactRefLike; policy_ref: unknown }>('SELECT subject_ref, policy_ref FROM factory.decision_request WHERE id = $1', [decision.requestId]);
        const approvals = await store(orgId, taskId, { schemaVersion: '2.0', requestId: decision.requestId, subjectHash: decision.subjectHash, decisions: [{ decider: decision.deciderPrincipalId ?? null, outcome: decision.state, reviewedSectionIds: decision.reviewedSectionIds ?? [] }] }, 'plan_approval_set', tx);
        const full = { ...binding, reviewPacketRef: request.rows[0]?.subject_ref, planApprovalSetRef: approvals };
        const inputs = { ...gateBinding('plan_peer_approved', full), ...(binding.applicationSnapshotRef ? { applicationSnapshotRef: binding.applicationSnapshotRef } : {}), subjectHash: decision.subjectHash };
        await tx.query(`INSERT INTO factory.gate_evaluation (org_id, id, task_id, gate_id, input_hash, input_binding, verdict, evidence_refs, evaluator_id, policy_ref, reason_codes, resolved_mode)
          VALUES ($1,$2,$3,'plan_peer_approved',$4,$5,$6,$7,$8,$9,$10,'human')`,
          [orgId, randomUUID(), taskId, gateInputHash('plan_peer_approved', full), JSON.stringify(inputs), passed ? 'passed' : 'failed', JSON.stringify([approvals]), EVALUATOR_ID, JSON.stringify(request.rows[0]?.policy_ref ?? null), JSON.stringify(passed ? ['exact_subject_peer_approval'] : reasons)]);
        return { gate: passed ? 'passed' as const : 'failed' as const, reasonCodes: passed ? ['exact_subject_peer_approval'] : reasons };
      });
    },

    async supersedeDecisions({ orgId, taskId }) {
      return tenant(orgId, async (tx) => (await tx.query("UPDATE factory.decision_request SET state = 'superseded', updated_at = now() WHERE task_id = $1 AND state = 'pending'", [taskId])).rowCount ?? 0);
    },
  };
}
