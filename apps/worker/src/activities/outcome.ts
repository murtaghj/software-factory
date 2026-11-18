// Controller-stage Activities: delivery of the report and recording of the OutcomeManifest.
import { canonicalJson, checkOutcomeProvenance, gateEvaluationView, resolveAuthorities, type GateRow } from '@factory/domain';
import { validateContract } from '@factory/contracts';
import type { ArtifactRefLike, TaskActivities } from '../workflows/types.ts';
import { contractCheck, type ActivityKit } from './shared.ts';

type Outcome = Pick<TaskActivities, 'deliverReport' | 'recordOutcome'>;

export function outcomeActivities({ tenant, store, readJson, authorityIo }: ActivityKit): Outcome {
  return {
    // deliver (outcome-v1): a trusted controller stage. Authorization and evidence are re-verified
    // immediately before the side effect (chapter 01): every gate required upstream must have a
    // current passing evaluation on this plan, and review_passed must name this exact candidate and
    // review. The delivered report is a finalized artifact; nothing is published elsewhere.
    async deliverReport({ orgId, taskId, planVersion, candidateRef, reviewRef, requiredGateIds }) {
      const rows = await tenant(orgId, (tx) => tx.query<{ gate_id: string; verdict: string; input_binding: Record<string, unknown>; evidence_refs: ArtifactRefLike[] }>(
        "SELECT gate_id, verdict, input_binding, evidence_refs FROM factory.gate_evaluation WHERE task_id = $1 AND superseded_by IS NULL AND verdict <> 'superseded' AND (input_binding->>'planVersion')::int = $2", [taskId, planVersion]));
      for (const gateId of requiredGateIds) {
        if (!rows.rows.some((g) => g.gate_id === gateId && g.verdict === 'passed')) return { ok: false as const, reason: `gate_not_current:${gateId}` };
      }
      const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
      const review = rows.rows.find((g) => g.gate_id === 'review_passed' && g.verdict === 'passed' && same(g.input_binding.candidateRef, candidateRef) && g.evidence_refs.some((r) => same(r, reviewRef)));
      if (!review) return { ok: false as const, reason: 'review_not_bound_to_candidate' };
      let candidate: Record<string, unknown>;
      let reviewDoc: Record<string, unknown>;
      try {
        candidate = await readJson<Record<string, unknown>>(orgId, taskId, candidateRef);
        reviewDoc = await readJson<Record<string, unknown>>(orgId, taskId, reviewRef);
      } catch { return { ok: false as const, reason: 'delivery_evidence_unverifiable' }; }
      const spec = await tenant(orgId, (tx) => tx.query<{ spec: { title?: string; acceptanceCriteria?: string[] }; spec_version: number }>(
        'SELECT s.spec, p.spec_version FROM factory.execution_plan p JOIN factory.task_spec_version s ON s.org_id = p.org_id AND s.task_id = p.task_id AND s.version = p.spec_version WHERE p.task_id = $1 AND p.version = $2', [taskId, planVersion]));
      const row = spec.rows[0];
      if (!row) return { ok: false as const, reason: 'plan_not_found' };
      const report = {
        schemaVersion: '2.0', kind: 'investigation_report', taskId, specVersion: row.spec_version, planVersion, title: row.spec.title ?? '',
        criteria: (row.spec.acceptanceCriteria ?? []).map((text, i) => ({ id: `C${String(i + 1)}`, text })),
        summary: candidate.summary ?? null, reviewedCandidateRef: candidateRef, reviewRef, reviewFindings: Array.isArray(reviewDoc.findings) ? reviewDoc.findings : [],
        limitations: ['Produced by the M1 deterministic fake runner: the findings are synthetic and no system was inspected.'],
      };
      return { ok: true as const, ref: await store(orgId, taskId, report, 'delivered_report') };
    },

    // close (outcome-v1): builds the OutcomeManifest from control-plane facts only. Gate evaluations
    // and human decisions are exported as immutable artifacts so the manifest's refs are
    // digest-checkable. Fails closed on anything this release cannot account for: AI review mode,
    // allocated execution resources (unknown cleanup) or a provenance violation.
    async recordOutcome({ orgId, taskId, planVersion, deliveredRefs, providerHandles }) {
      const facts = await tenant(orgId, async (tx) => {
        const task = await tx.query<{ delivery_scope: string; primary_application_id: string }>('SELECT delivery_scope, primary_application_id FROM factory.task WHERE id = $1', [taskId]);
        const t = task.rows[0];
        if (!t) return undefined;
        const aiMode = await tx.query('SELECT 1 FROM factory.review_mode_decision WHERE application_id = $1 LIMIT 1', [t.primary_application_id]);
        const allocations = await tx.query<{ n: string }>('SELECT count(*) AS n FROM factory.execution_allocation a JOIN factory.stage_run s ON s.org_id = a.org_id AND s.id = a.stage_run_id WHERE s.task_id = $1', [taskId]);
        const gates = await tx.query<GateRow>(`SELECT id, task_id, gate_id, input_hash, input_binding, verdict, evidence_refs, evaluator_id, reason_codes, created_at, superseded_by, resolved_mode
          FROM factory.gate_evaluation WHERE task_id = $1 AND superseded_by IS NULL AND verdict <> 'superseded' AND (input_binding->>'planVersion')::int = $2 ORDER BY created_at, id`, [taskId, planVersion]);
        // Only human approvals that a current passing gate is bound to are cited as authority.
        const subjects = gates.rows.filter((g) => g.verdict === 'passed' && typeof g.input_binding.subjectHash === 'string').map((g) => g.input_binding.subjectHash as string);
        const decisions = await tx.query<{ id: string; task_id: string; action: string; subject_hash: string; subject_ref: ArtifactRefLike; policy_ref: ArtifactRefLike; evidence_refs: ArtifactRefLike[]; eligible_roles: string[]; state: string; reason: string; expires_at: Date; required_principal_id: string | null; decider_id: string }>(
          `SELECT r.id, r.task_id, r.action, r.subject_hash, r.subject_ref, r.policy_ref, r.evidence_refs, r.eligible_roles, r.state, r.reason, r.expires_at, r.required_principal_id, d.decider_id
           FROM factory.decision_request r JOIN factory.decision d ON d.org_id = r.org_id AND d.request_id = r.id
           WHERE r.task_id = $1 AND r.state = 'approved' AND d.actor_kind = 'human' AND r.subject_hash = ANY($2::text[]) ORDER BY d.created_at, r.id`, [taskId, subjects]);
        const ledger = await tx.query<{ operation_key: string; amount_micro_usd: string; created_at: Date }>(
          "SELECT l.operation_key, l.amount_micro_usd, l.created_at FROM factory.budget_ledger l JOIN factory.budget_account a ON a.org_id = l.org_id AND a.id = l.account_id WHERE a.task_id = $1 AND l.kind = 'observed_usage' ORDER BY l.created_at, l.id", [taskId]);
        return { t, aiMode: (aiMode.rowCount ?? 0) > 0, allocations: Number(allocations.rows[0]?.n ?? 0), gates: gates.rows, decisions: decisions.rows, ledger: ledger.rows };
      });
      if (!facts) return { ok: false as const, reason: 'task_not_found' };
      if (facts.aiMode) return { ok: false as const, reason: 'ai_only_not_supported' };
      if (facts.allocations > 0) return { ok: false as const, reason: 'cleanup_obligations_unresolved' };
      if (deliveredRefs.length === 0) return { ok: false as const, reason: 'no_delivered_artifact' };
      const gateEvaluationRefs: ArtifactRefLike[] = [];
      for (const row of facts.gates) {
        const view = gateEvaluationView(row);
        if (!view || !validateContract('GateEvaluation', view).ok) return { ok: false as const, reason: `gate_without_contract_view:${row.gate_id}` };
        gateEvaluationRefs.push(await store(orgId, taskId, view, 'gate_evaluation_record'));
      }
      // Every passing human-mode gate must be backed by a cited human decision on its subject.
      for (const g of facts.gates.filter((x) => x.verdict === 'passed' && x.resolved_mode === 'human')) {
        if (!facts.decisions.some((d) => d.subject_hash === g.input_binding.subjectHash)) return { ok: false as const, reason: `human_gate_without_decision:${g.gate_id}` };
      }
      const decisionRefs: ArtifactRefLike[] = [];
      for (const r of facts.decisions) {
        const view = { id: r.id, taskId: r.task_id, action: r.action, subjectHash: r.subject_hash, subjectRef: r.subject_ref, policyRef: r.policy_ref, evidenceRefs: r.evidence_refs, eligibleRoles: r.eligible_roles, state: r.state, reason: r.reason, expiresAt: r.expires_at.toISOString(),
          ...(r.required_principal_id ? { requiredPrincipalId: r.required_principal_id } : {}), deciderId: r.decider_id, actorKind: 'human' };
        if (!validateContract('DecisionView', view).ok) return { ok: false as const, reason: 'decision_without_contract_view' };
        decisionRefs.push(await store(orgId, taskId, view, 'human_decision_record'));
      }
      const usage = facts.ledger.map((l) => ({ provider: 'm1-fake-runner', modelProfile: 'fake-deterministic', quality: 'estimated', costMicroUsd: Number(l.amount_micro_usd), source: `budget_ledger:${l.operation_key}`, observedAt: l.created_at.toISOString() }));
      const manifest = {
        schemaVersion: '2.0', taskId, status: 'succeeded', deliveryScope: facts.t.delivery_scope, outcomeKind: 'delivered', deliveredArtifactRefs: deliveredRefs,
        providerHandles: [...providerHandles, ...deliveredRefs.map((r) => `artifact-store:${r.artifactId}`)], gateEvaluationRefs, decisionRefs, usage,
        limitations: ['M1 fake vertical slice: stage outputs come from the deterministic fake runner; no harness, model, repository or environment was used.', 'Usage costs are configured fake-runner values recorded in the budget ledger, not provider-reported usage.'],
        knowledgeProposalIds: [], cleanupObligationRefs: [], completedAt: new Date().toISOString(), reviewMode: 'human',
      };
      if (!validateContract('OutcomeManifest', manifest).ok) return { ok: false as const, reason: 'outcome_manifest_invalid' };
      const provenance = checkOutcomeProvenance(manifest, await resolveAuthorities(manifest, authorityIo(orgId, taskId)), { aiOnlySupported: false, validate: contractCheck });
      if (!provenance.ok) return { ok: false as const, reason: `provenance_${provenance.reason}` };
      // No execution resources were allocated, so nothing remains to clean up.
      await tenant(orgId, (tx) => tx.query("UPDATE factory.task SET cleanup_state = 'complete', updated_at = now() WHERE id = $1 AND cleanup_state <> 'complete'", [taskId]));
      return { ok: true as const, ref: await store(orgId, taskId, manifest, 'outcome_manifest') };
    },
  };
}
