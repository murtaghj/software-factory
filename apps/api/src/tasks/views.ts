// Stage-run and gate views (W-014). Rows are mapped onto the exact RunView / GateEvaluation
// contracts; nothing is invented to fill a field.
import type { GateEvaluation, GatePage, RunPage, RunView } from '@factory/contracts';
import type { Tx } from '@factory/database';

type StageRow = { logical_id: string; task_id: string; node_id: string; plan_version: number; semantic_attempt: number; status: RunView['status']; role: RunView['role']; input_hash: string; result_ref: RunView['resultRef'] | null; started_at: Date | null; completed_at: Date | null; superseded_at: Date | null; superseded_by_plan_version: number | null; superseded_logical_id: string | null; generations: string };

export async function listRuns(tx: Tx, taskId: string, q: { nodeId?: string; status?: string; limit: number }): Promise<RunPage> {
  const r = await tx.query<StageRow>(`SELECT s.logical_id, s.task_id, s.node_id, s.plan_version, s.semantic_attempt, s.status, s.role, s.input_hash, s.result_ref, s.started_at, s.completed_at,
      s.superseded_at, s.superseded_by_plan_version, n.logical_id AS superseded_logical_id,
      (SELECT count(*) FROM factory.execution_allocation a WHERE a.org_id = s.org_id AND a.stage_run_id = s.id) AS generations
    FROM factory.stage_run s LEFT JOIN factory.stage_run n ON n.org_id = s.org_id AND n.id = s.superseded_by_stage_run_id
    WHERE s.task_id = $1 AND ($2::text IS NULL OR s.node_id = $2) AND ($3::text IS NULL OR s.status = $3)
    ORDER BY s.plan_version, s.created_at, s.id LIMIT $4`, [taskId, q.nodeId ?? null, q.status ?? null, q.limit]);
  return {
    items: r.rows.map((s) => {
      const v: RunView = { id: s.logical_id, taskId: s.task_id, nodeId: s.node_id, planVersion: s.plan_version, semanticAttempt: s.semantic_attempt, status: s.status, role: s.role, inputHash: s.input_hash, allocationGeneration: Number(s.generations), usage: [] };
      if (s.result_ref) v.resultRef = s.result_ref;
      if (s.started_at) v.startedAt = s.started_at.toISOString();
      if (s.completed_at) v.completedAt = s.completed_at.toISOString();
      if (s.superseded_at) v.supersededAt = s.superseded_at.toISOString();
      if (s.superseded_by_plan_version !== null) v.supersededByPlanVersion = s.superseded_by_plan_version;
      if (s.superseded_logical_id) v.supersededByStageRunId = s.superseded_logical_id;
      return v;
    }),
  };
}

const INPUT_BINDING_KEYS = ['taskSpecVersion', 'planVersion', 'policyRef', 'applicationSnapshotRef', 'criteriaRef', 'candidateRef', 'canonicalPackageRef', 'setupProfileRef', 'environmentPlanRef', 'baselineRef', 'reviewPacketRef', 'planApprovalSetRef'] as const;
type GateRow = { id: string; task_id: string; gate_id: GateEvaluation['gateId']; input_hash: string; input_binding: Record<string, unknown>; verdict: GateEvaluation['verdict']; evidence_refs: GateEvaluation['evidenceRefs']; evaluator_id: string; reason_codes: string[]; created_at: Date; superseded_by: string | null; resolved_mode: GateEvaluation['resolvedMode'] | null };

// Gate evaluations as recorded. By default only current requirements are listed; historical
// (superseded) evaluations and invalidation markers are included on request. Rows whose stored
// binding cannot be expressed as an InputBinding (e.g. created before the snapshot was pinned) are
// reported as historical only.
export async function listGates(tx: Tx, taskId: string, q: { includeHistorical: boolean; inputHash?: string; limit: number }): Promise<GatePage> {
  const r = await tx.query<GateRow>(`SELECT id, task_id, gate_id, input_hash, input_binding, verdict, evidence_refs, evaluator_id, reason_codes, created_at, superseded_by, resolved_mode
    FROM factory.gate_evaluation WHERE task_id = $1 AND ($2 OR (superseded_by IS NULL AND verdict <> 'superseded')) AND ($3::text IS NULL OR input_hash = $3)
    ORDER BY created_at, id LIMIT $4`, [taskId, q.includeHistorical, q.inputHash ?? null, q.limit]);
  const items: GateEvaluation[] = [];
  for (const g of r.rows) {
    const b = g.input_binding;
    const template = b.workflowTemplateRef as { definitionRef?: unknown } | undefined;
    if (b.applicationSnapshotRef === undefined || template?.definitionRef === undefined) continue;
    const inputBinding = Object.fromEntries(INPUT_BINDING_KEYS.flatMap((k) => (b[k] === undefined ? [] : [[k, b[k]]]))) as unknown as GateEvaluation['inputBinding'];
    (inputBinding as unknown as Record<string, unknown>).workflowTemplateRef = template.definitionRef;
    const view: GateEvaluation = { id: g.id, taskId: g.task_id, gateId: g.gate_id, inputBinding, inputHash: g.input_hash, verdict: g.verdict, evidenceRefs: g.evidence_refs, evaluatorId: g.evaluator_id, reasonCodes: g.reason_codes, evaluatedAt: g.created_at.toISOString() };
    if (g.superseded_by) view.supersededBy = g.superseded_by;
    if (g.resolved_mode) view.resolvedMode = g.resolved_mode;
    items.push(view);
  }
  return { items };
}
