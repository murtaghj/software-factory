// Maps a stored gate_evaluation row onto the GateEvaluation contract. Nothing is invented to fill a
// field: a row whose binding cannot be expressed as an InputBinding (created before the snapshot
// was pinned) has no contract view and is reported as such.
import type { GateEvaluation } from '@factory/contracts';

export type GateRow = { id: string; task_id: string; gate_id: GateEvaluation['gateId']; input_hash: string; input_binding: Record<string, unknown>; verdict: GateEvaluation['verdict']; evidence_refs: GateEvaluation['evidenceRefs']; evaluator_id: string; reason_codes: string[]; created_at: Date; superseded_by: string | null; resolved_mode: GateEvaluation['resolvedMode'] | null };
const INPUT_BINDING_KEYS = ['taskSpecVersion', 'planVersion', 'policyRef', 'applicationSnapshotRef', 'criteriaRef', 'candidateRef', 'canonicalPackageRef', 'setupProfileRef', 'environmentPlanRef', 'baselineRef', 'reviewPacketRef', 'planApprovalSetRef'] as const;

export function gateEvaluationView(g: GateRow): GateEvaluation | undefined {
  const b = g.input_binding;
  const template = b.workflowTemplateRef as { definitionRef?: unknown } | undefined;
  if (b.applicationSnapshotRef === undefined || template?.definitionRef === undefined) return undefined;
  const inputBinding = Object.fromEntries(INPUT_BINDING_KEYS.flatMap((k) => (b[k] === undefined ? [] : [[k, b[k]]]))) as unknown as GateEvaluation['inputBinding'];
  (inputBinding as unknown as Record<string, unknown>).workflowTemplateRef = template.definitionRef;
  const view: GateEvaluation = { id: g.id, taskId: g.task_id, gateId: g.gate_id, inputBinding, inputHash: g.input_hash, verdict: g.verdict, evidenceRefs: g.evidence_refs, evaluatorId: g.evaluator_id, reasonCodes: g.reason_codes, evaluatedAt: g.created_at.toISOString() };
  if (g.superseded_by) view.supersededBy = g.superseded_by;
  if (g.resolved_mode) view.resolvedMode = g.resolved_mode;
  return view;
}
