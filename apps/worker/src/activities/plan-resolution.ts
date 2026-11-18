// Plan resolution Activities: the pinned plan for a task spec version, and amend_spec
// materialization of a new spec version when the workflow applies the command.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ApplicationFailure } from '@temporalio/activity';
import { validateContract } from '@factory/contracts';
import { canonicalHash } from '@factory/domain';
import type { ArtifactRefLike, PlanSnapshot, TaskActivities } from '../workflows/types.ts';
import { M1_POLICY, type ActivityKit } from './shared.ts';

export const TEMPLATES_DIR = join(import.meta.dirname, '..', 'templates');
// Pinned template per work type. investigation 0.2.0 carries the mandatory plan + plan_review
// (peer sign-off) nodes; the 0.1.0 skeleton (no human gate) is only selectable through an explicit
// templateOverrides entry, which the scheduler-mechanics tests use.
const TEMPLATE_BY_WORK_TYPE: Record<string, string> = { investigation: 'investigation-0.2.0.json' };

type PlanResolution = Pick<TaskActivities, 'resolvePlan' | 'materializeSpec'>;

export function planResolutionActivities({ deps, tenant, store, readJson }: ActivityKit): PlanResolution {
  return {
    async resolvePlan({ orgId, taskId, specVersion, planVersion }) {
      const existing = await tenant(orgId, (tx) => tx.query<{ plan_ref: ArtifactRefLike }>('SELECT plan_ref FROM factory.execution_plan WHERE task_id = $1 AND version = $2', [taskId, planVersion]));
      if (existing.rows[0]) return readJson<PlanSnapshot>(orgId, taskId, existing.rows[0].plan_ref);
      const spec = await tenant(orgId, (tx) => tx.query<{ spec: { workType: string } }>('SELECT spec FROM factory.task_spec_version WHERE task_id = $1 AND version = $2', [taskId, specVersion]));
      const workType = spec.rows[0]?.spec.workType;
      if (!workType) throw ApplicationFailure.nonRetryable(`task spec ${String(specVersion)} not found`, 'spec_not_found');
      const file = deps.templateOverrides?.[workType] ?? TEMPLATE_BY_WORK_TYPE[workType];
      if (!file) throw ApplicationFailure.nonRetryable(`no compatible pinned template for ${workType}`, 'no_compatible_template');
      const template = JSON.parse(readFileSync(join(TEMPLATES_DIR, file), 'utf8')) as { id: string; version: string; nodes: PlanSnapshot['nodes'] };
      const valid = validateContract('WorkflowTemplateDefinition', template);
      if (!valid.ok) throw ApplicationFailure.nonRetryable(`template ${file} is invalid`, 'invalid_template');
      const definitionRef = await store(orgId, taskId, template, 'workflow_template');
      const policyRef = await store(orgId, taskId, M1_POLICY, 'policy_snapshot');
      const criteria = ((spec.rows[0]?.spec as { acceptanceCriteria?: string[] }).acceptanceCriteria ?? []).map((text, i) => ({ id: `C${String(i + 1)}`, text }));
      // The pinned ApplicationSnapshot: the accepted target context. No registry import exists yet
      // (W-037), so it carries no definition refs (A-10).
      const snapshot = { schemaVersion: '2.0', snapshotId: randomUUID(), targetContext: (spec.rows[0]?.spec as { targetContext?: unknown }).targetContext, applicationDefinitionRefs: [], applicationDraftRefs: [], createdAt: new Date().toISOString() };
      if (!validateContract('ApplicationSnapshot', snapshot).ok) throw ApplicationFailure.nonRetryable('cannot build a valid ApplicationSnapshot', 'invalid_snapshot');
      const applicationSnapshotRef = await store(orgId, taskId, snapshot, 'application_snapshot');
      const criteriaRef = await store(orgId, taskId, { schemaVersion: '2.0', specVersion, criteria }, 'criteria');
      const nodes = template.nodes.map((n) => ({ id: n.id, stageKind: n.stageKind, role: n.role, dependsOn: n.dependsOn, requiredGateIds: n.requiredGateIds, timeoutClass: n.timeoutClass, mandatory: n.mandatory }));
      const body = { taskId, version: planVersion, specVersion, templateRef: { id: template.id, version: template.version, definitionRef }, policyRef, nodes };
      const b = (spec.rows[0]?.spec as { budget?: PlanSnapshot['budget'] }).budget;
      const budget = b ? { maxMicroUsd: b.maxMicroUsd, maxActiveSeconds: b.maxActiveSeconds, maxCalendarSeconds: b.maxCalendarSeconds, maxAuthoringInvocations: b.maxAuthoringInvocations, maxSemanticAttemptsPerNode: b.maxSemanticAttemptsPerNode, invocationMode: b.invocationMode } : undefined;
      const plan: PlanSnapshot = { version: planVersion, specVersion, planHash: canonicalHash({ ...body, criteriaRef, budget, applicationSnapshotRef }), policyRef, templateRef: body.templateRef, nodes, criteriaRef, applicationSnapshotRef, ...(budget ? { budget } : {}) };
      const planRef = await store(orgId, taskId, plan, 'execution_plan');
      await tenant(orgId, (tx) => tx.query(`INSERT INTO factory.execution_plan (org_id, id, task_id, version, spec_version, plan_ref, policy_ref, plan_hash, template_id, template_version, template_ref)
        VALUES ($1, $11, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (org_id, task_id, version) DO NOTHING`,
        [orgId, taskId, planVersion, specVersion, JSON.stringify(planRef), JSON.stringify(policyRef), plan.planHash, template.id, template.version, JSON.stringify(plan.templateRef), randomUUID()]));
      const stored = await tenant(orgId, (tx) => tx.query<{ plan_ref: ArtifactRefLike }>('SELECT plan_ref FROM factory.execution_plan WHERE task_id = $1 AND version = $2', [taskId, planVersion]));
      const ref = stored.rows[0]?.plan_ref;
      if (!ref) throw new Error('execution plan not persisted');
      return readJson<PlanSnapshot>(orgId, taskId, ref); // a concurrent attempt's plan wins; never two plans per version
    },

    // amend_spec: the new TaskSpec version is created only when the workflow applies the command.
    async materializeSpec({ orgId, taskId, specRef, version, actorCommandId }) {
      let doc: unknown;
      try { doc = await readJson<unknown>(orgId, taskId, specRef); } catch (e) { return { ok: false, reason: `spec artifact unreadable: ${e instanceof Error ? e.message : 'error'}` }; }
      const valid = validateContract('TaskRequest', doc);
      if (!valid.ok) return { ok: false, reason: 'amended spec is not a valid TaskRequest' };
      return tenant(orgId, async (tx) => {
        const task = await tx.query<{ delivery_scope: string; primary_application_id: string; creator_id: string }>('SELECT delivery_scope, primary_application_id, creator_id FROM factory.task WHERE id = $1', [taskId]);
        const t = task.rows[0];
        if (!t) return { ok: false as const, reason: 'task not found' };
        if ((t.delivery_scope === 'design') !== (valid.value.deliveryScope === 'design')) return { ok: false as const, reason: 'design_scope_change_requires_new_task' };
        if (valid.value.targetContext.applicationId !== t.primary_application_id) return { ok: false as const, reason: 'primary target cannot change; create a linked task' };
        const current = await tx.query<{ spec: { deliveryScope?: string; priorityClass?: string; budget?: unknown } }>('SELECT s.spec FROM factory.task_spec_version s JOIN factory.task t ON t.org_id = s.org_id AND t.id = s.task_id AND t.spec_version = s.version WHERE t.id = $1', [taskId]);
        const was = current.rows[0]?.spec;
        if (!was) return { ok: false as const, reason: 'current spec not found' };
        if (valid.value.deliveryScope !== was.deliveryScope || (valid.value.priorityClass ?? 'normal') !== (was.priorityClass ?? 'normal') || canonicalHash(valid.value.budget) !== canonicalHash(was.budget ?? null)) return { ok: false as const, reason: 'amendment changes scope, priority or budget' };
        const cmd = await tx.query<{ principal_id: string }>("SELECT principal_id FROM factory.command WHERE id = $1 AND task_id = $2 AND kind = 'amend_spec'", [actorCommandId, taskId]);
        const actor = cmd.rows[0]?.principal_id;
        if (!actor) return { ok: false as const, reason: 'amending command not found' };
        await tx.query('INSERT INTO factory.task_spec_version (org_id, id, task_id, version, spec, spec_hash, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (org_id, task_id, version) DO NOTHING',
          [orgId, randomUUID(), taskId, version, JSON.stringify(valid.value), canonicalHash(valid.value), actor]);
        return { ok: true as const, version };
      });
    },
  };
}
