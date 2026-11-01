// Seeds one organization's row graph as the runtime role, inside its tenant context.
import { randomUUID } from 'node:crypto';
import type { Database, Tx } from '../src/index.ts';

export const sha = (c: string): string => c.repeat(64).slice(0, 64);
export const COMMIT_A = 'a'.repeat(40);
const ref = (n: string) => JSON.stringify({ artifactId: randomUUID(), sha256: sha(n), mediaType: 'application/json', schemaVersion: '2.0', sizeBytes: 10 });

export type Seeded = {
  orgId: string; principalId: string; applicationId: string; taskId: string; specId: string; planId: string; stageRunId: string;
  repositoryId: string; workspaceId: string; allocationId: string; artifactId: string; definitionId: string; observationId: string;
  relationshipId: string; artifactLinkId: string; inboxId: string; commandId: string; commentId: string; gateId: string; toolCallId: string;
};

export async function seedTenant(db: Database, orgId: string): Promise<Seeded> {
  const ids = {
    orgId, principalId: randomUUID(), applicationId: randomUUID(), taskId: randomUUID(), specId: randomUUID(), planId: randomUUID(), stageRunId: randomUUID(),
    repositoryId: randomUUID(), workspaceId: randomUUID(), allocationId: randomUUID(), artifactId: randomUUID(), definitionId: randomUUID(), observationId: randomUUID(),
    relationshipId: randomUUID(), artifactLinkId: randomUUID(), inboxId: randomUUID(), commandId: randomUUID(), commentId: randomUUID(), gateId: randomUUID(), toolCallId: randomUUID(),
  };
  await db.withTenant({ orgId }, async (tx: Tx) => {
    const q = (sql: string, params: unknown[]) => tx.query(sql, params);
    await q('INSERT INTO factory.principal (org_id, id, issuer, subject, display_name) VALUES ($1,$2,$3,$4,$5)', [orgId, ids.principalId, 'https://issuer.test', `user-${ids.principalId}`, 'Test User']);
    await q("INSERT INTO factory.application (org_id, id, app_key, name, owner_ids, lifecycle) VALUES ($1,$2,$3,'Orders','[]','production')", [orgId, ids.applicationId, `orders-${ids.applicationId.slice(0, 8)}`]);
    const target = JSON.stringify({ kind: 'existing_application', applicationId: ids.applicationId, definitionRef: JSON.parse(ref('1')) as unknown });
    await q("INSERT INTO factory.task (org_id, id, creator_id, primary_application_id, target_kind, target_context, work_type, change_class, delivery_scope, status) VALUES ($1,$2,$3,$4,'existing_application',$5,'feature','feature','pr','accepted')",
      [orgId, ids.taskId, ids.principalId, ids.applicationId, target]);
    await q("INSERT INTO factory.task_spec_version (org_id, id, task_id, version, spec, spec_hash, actor_id) VALUES ($1,$2,$3,1,'{}',$4,$5)", [orgId, ids.specId, ids.taskId, sha('b'), ids.principalId]);
    await q("INSERT INTO factory.execution_plan (org_id, id, task_id, version, spec_version, plan_ref, policy_ref, plan_hash, template_id, template_version, template_ref) VALUES ($1,$2,$3,1,1,$4,$4,$5,'existing_feature','3.0.0',$4)",
      [orgId, ids.planId, ids.taskId, ref('2'), sha('c')]);
    await q("INSERT INTO factory.stage_run (org_id, id, task_id, plan_version, node_id, semantic_attempt, logical_id, input_hash, input_ref, role, status, limits) VALUES ($1,$2,$3,1,'implement',1,$4,$5,$6,'implementer','running','{}')",
      [orgId, ids.stageRunId, ids.taskId, `task-${ids.taskId}/plan-1/implement/attempt-1`, sha('d'), ref('3')]);
    await q("INSERT INTO factory.repository (org_id, id, provider, installation_ref, external_id, clone_url, default_branch, policy_ref) VALUES ($1,$2,'github','inst-1',$3,'https://git.test/o/r','main','{}')", [orgId, ids.repositoryId, `repo-${ids.repositoryId}`]);
    await q("INSERT INTO factory.workspace (org_id, id, task_id, repository_id, stage_run_id, role, base_commit, state, generation, owner_epoch, setup_profile_ref) VALUES ($1,$2,$3,$4,$5,'implementer',$6,'active',1,1,'{}')",
      [orgId, ids.workspaceId, ids.taskId, ids.repositoryId, ids.stageRunId, COMMIT_A]);
    await q("INSERT INTO factory.execution_allocation (org_id, id, stage_run_id, workspace_id, generation, owner_epoch, spec_hash, job_name, namespace, supervisor_identity, state) VALUES ($1,$2,$3,$4,1,1,$5,$6,'exec','sup-1','running')",
      [orgId, ids.allocationId, ids.stageRunId, ids.workspaceId, sha('e'), `job-${ids.allocationId}`]);
    await q("INSERT INTO factory.artifact (org_id, id, sha256, media_type, schema_version, size_bytes, storage_key, producer_id, classification, finalized_at, retention_until) VALUES ($1,$2,$3,'application/json','2.0',10,$4,'test','ordinary',now(),now() + interval '1 day')",
      [orgId, ids.artifactId, sha('f'), `org/${orgId}/sha256/${sha('f')}`]);
    await q("INSERT INTO factory.definition_version (org_id, id, entity_kind, entity_key, source_repository_id, source_commit, source_path, artifact_id, document_digest, validation_state) VALUES ($1,$2,'application','orders',$3,$4,'apps/orders.yaml',$5,$6,'valid')",
      [orgId, ids.definitionId, ids.repositoryId, COMMIT_A, ids.artifactId, sha('1')]);
    await q("INSERT INTO factory.observation (org_id, id, application_id, environment, observation_kind, valid_from, valid_until, evidence_ref) VALUES ($1,$2,$3,'prod','trace_relation',now(),now() + interval '1 day',$4)",
      [orgId, ids.observationId, ids.applicationId, ref('4')]);
    await q("INSERT INTO factory.relationship (org_id, id, source_key, target_key, kind, basis, definition_id, valid_from) VALUES ($1,$2,'orders','inventory','calls','declared',$3,now())", [orgId, ids.relationshipId, ids.definitionId]);
    await q("INSERT INTO factory.artifact_link (org_id, id, artifact_id, task_id, stage_run_id, purpose, retain_until) VALUES ($1,$2,$3,$4,$5,'stage_output',now() + interval '1 day')",
      [orgId, ids.artifactLinkId, ids.artifactId, ids.taskId, ids.stageRunId]);
    await q("INSERT INTO factory.inbox (org_id, id, provider, installation_ref, external_event_id, body_digest, body_ref, verified_at) VALUES ($1,$2,'github','inst-1',$3,$4,$5,now())",
      [orgId, ids.inboxId, `evt-${ids.inboxId}`, sha('5'), ref('5')]);
    await q("INSERT INTO factory.command (org_id, id, task_id, principal_id, expected_revision, kind, request_hash, payload, state) VALUES ($1,$2,$3,$4,1,'comment_plan',$5,'{}','queued')",
      [orgId, ids.commandId, ids.taskId, ids.principalId, sha('6')]);
    await q("INSERT INTO factory.plan_review_comment (org_id, id, task_id, command_id, subject_hash, author_id, note, state) VALUES ($1,$2,$3,$4,$5,$6,'{}','open')",
      [orgId, ids.commentId, ids.taskId, ids.commandId, sha('7'), ids.principalId]);
    await q("INSERT INTO factory.gate_evaluation (org_id, id, task_id, gate_id, input_hash, input_binding, verdict, evidence_refs, evaluator_id, policy_ref, reason_codes) VALUES ($1,$2,$3,'review_passed',$4,'{}','passed','[]','evaluator','{}','[]')",
      [orgId, ids.gateId, ids.taskId, sha('8')]);
    await q("INSERT INTO factory.factory_tool_call (org_id, id, task_id, stage_run_id, allocation_id, call_id, epoch, tool_name, request_hash, input_hash, role, sequence, state, request_ref) VALUES ($1,$2,$3,$4,$5,$6,1,'submit_result',$7,$8,'implementer',1,'reserved',$9)",
      [orgId, ids.toolCallId, ids.taskId, ids.stageRunId, ids.allocationId, randomUUID(), sha('9'), sha('d'), ref('6')]);
  });
  return ids;
}
