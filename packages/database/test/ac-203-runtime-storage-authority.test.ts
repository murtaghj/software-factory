import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database, createMigratedDatabase, provisionOrganization, type MigratedDatabase } from '../src/index.ts';
import { seedTenant, sha, type Seeded } from './seed.ts';

describe('AC-203 runtime storage authority', () => {
  let m: MigratedDatabase;
  let db: Database;
  let s: Seeded;
  beforeAll(async () => {
    m = await createMigratedDatabase('ac203');
    const orgId = randomUUID();
    await provisionOrganization(m.migratorUrl, { id: orgId, name: 'Org' });
    db = Database.connect(m.runtimeUrl);
    s = await seedTenant(db, orgId);
  });
  afterAll(async () => { await db.close(); await m.drop(); });

  const run = (sql: string, params: unknown[] = []) => db.withTenant({ orgId: s.orgId }, (tx) => tx.query(sql, params));
  const denied = { code: '42501' };

  it('named status updates succeed, including comment resolution and gate supersession', async () => {
    expect((await run("UPDATE factory.task SET status = 'queued', updated_at = now() WHERE id = $1", [s.taskId])).rowCount).toBe(1);
    expect((await run("UPDATE factory.plan_review_comment SET state = 'resolved', resolution_ref = '{\"artifactId\":\"x\"}' WHERE id = $1", [s.commentId])).rowCount).toBe(1);
    const newer = randomUUID();
    await run("INSERT INTO factory.gate_evaluation (org_id, id, task_id, gate_id, input_hash, input_binding, verdict, evidence_refs, evaluator_id, policy_ref, reason_codes) VALUES ($1,$2,$3,'review_passed',$4,'{}','passed','[]','evaluator','{}','[]')", [s.orgId, newer, s.taskId, sha('9')]);
    expect((await run('UPDATE factory.gate_evaluation SET superseded_by = $2 WHERE id = $1', [s.gateId, newer])).rowCount).toBe(1);
    expect((await run("UPDATE factory.inbox SET processed_at = now() WHERE id = $1", [s.inboxId])).rowCount).toBe(1);
    expect((await run("UPDATE factory.factory_tool_call SET state = 'proposal_received' WHERE id = $1", [s.toolCallId])).rowCount).toBe(1);
  });

  it('organization creation fails for the runtime role', async () => {
    await expect(run("INSERT INTO factory.organization (id, name, status) VALUES ($1, 'Rogue', 'active')", [randomUUID()])).rejects.toMatchObject(denied);
  });

  it.each([
    ['artifact digest', 'UPDATE factory.artifact SET sha256 = $2 WHERE id = $1', 'artifactId'],
    ['artifact storage key', "UPDATE factory.artifact SET storage_key = 'elsewhere' WHERE id = $1", 'artifactId'],
    ['definition digest', 'UPDATE factory.definition_version SET document_digest = $2 WHERE id = $1', 'definitionId'],
    ['definition source commit', "UPDATE factory.definition_version SET source_commit = 'b' || repeat('0', 39) WHERE id = $1", 'definitionId'],
    ['observation', "UPDATE factory.observation SET evidence_ref = '{}' WHERE id = $1", 'observationId'],
    ['relationship', "UPDATE factory.relationship SET target_key = 'payments' WHERE id = $1", 'relationshipId'],
    ['artifact link', "UPDATE factory.artifact_link SET purpose = 'other' WHERE id = $1", 'artifactLinkId'],
    ['inbox evidence', 'UPDATE factory.inbox SET body_digest = $2 WHERE id = $1', 'inboxId'],
    ['tool request identity', 'UPDATE factory.factory_tool_call SET request_hash = $2 WHERE id = $1', 'toolCallId'],
    ['gate verdict', "UPDATE factory.gate_evaluation SET verdict = 'failed' WHERE id = $1", 'gateId'],
    ['comment text', "UPDATE factory.plan_review_comment SET note = '{\"edited\":true}' WHERE id = $1", 'commentId'],
    ['task identity', 'UPDATE factory.task SET org_id = org_id, creator_id = creator_id WHERE id = $1', 'taskId'],
  ] as const)('rewriting %s fails', async (_label, sql, key) => {
    const params: unknown[] = [s[key]];
    if (sql.includes('$2')) params.push(sha('0'));
    await expect(run(sql, params)).rejects.toMatchObject(denied);
  });

  it('deleting evidence fails (no DELETE grant)', async () => {
    await expect(run('DELETE FROM factory.artifact WHERE id = $1', [s.artifactId])).rejects.toMatchObject(denied);
    await expect(run('DELETE FROM factory.task_event')).rejects.toMatchObject(denied);
  });

  it('an accepted proposal cannot be cleared and a terminal tool call cannot transition', async () => {
    const call = randomUUID();
    await run("INSERT INTO factory.factory_tool_call (org_id, id, task_id, stage_run_id, allocation_id, call_id, epoch, tool_name, request_hash, input_hash, role, sequence, state, request_ref) VALUES ($1,$2,$3,$4,$5,$6,1,'submit_result',$7,$7,'implementer',2,'proposal_received','{}')",
      [s.orgId, call, s.taskId, s.stageRunId, s.allocationId, randomUUID(), sha('a')]);
    await run('UPDATE factory.factory_tool_call SET proposal_accepted = true WHERE id = $1', [call]);
    await expect(run('UPDATE factory.factory_tool_call SET proposal_accepted = false WHERE id = $1', [call])).rejects.toThrow('accepted proposal cannot be cleared');
    await run("UPDATE factory.factory_tool_call SET state = 'finalized' WHERE id = $1", [call]);
    await expect(run("UPDATE factory.factory_tool_call SET state = 'running' WHERE id = $1", [call])).rejects.toThrow('terminal tool call cannot transition');
    const second = randomUUID();
    await run("INSERT INTO factory.factory_tool_call (org_id, id, task_id, stage_run_id, allocation_id, call_id, epoch, tool_name, request_hash, input_hash, role, sequence, state, request_ref) VALUES ($1,$2,$3,$4,$5,$6,1,'submit_result',$7,$7,'implementer',3,'proposal_received','{}')",
      [s.orgId, second, s.taskId, s.stageRunId, s.allocationId, randomUUID(), sha('b')]);
    await expect(run('UPDATE factory.factory_tool_call SET proposal_accepted = true WHERE id = $1', [second])).rejects.toMatchObject({ code: '23505' }); // one accepted proposal per stage run
  });

  it('a terminal stage outcome is immutable except for supersession metadata', async () => {
    await run("UPDATE factory.stage_run SET status = 'passed', completed_at = now() WHERE id = $1", [s.stageRunId]);
    await expect(run("UPDATE factory.stage_run SET status = 'failed' WHERE id = $1", [s.stageRunId])).rejects.toThrow('terminal stage outcome is immutable');
  });

  it.each([
    ['abbreviated', 'abc1234'],
    ['all-zero SHA-1', '0'.repeat(40)],
    ['all-zero SHA-256', '0'.repeat(64)],
    ['uppercase', 'A'.repeat(40)],
    ['41 characters', 'a'.repeat(41)],
  ])('an invalid %s Git object ID is rejected', async (_label, oid) => {
    await expect(run("UPDATE factory.workspace SET candidate_commit = $2 WHERE id = $1", [s.workspaceId, oid])).rejects.toMatchObject({ code: '23514' });
  });

  it('full 40- and 64-character object IDs are accepted', async () => {
    expect((await run('UPDATE factory.workspace SET candidate_commit = $2 WHERE id = $1', [s.workspaceId, '0123456789abcdef0123456789abcdef01234567'])).rowCount).toBe(1);
    expect((await run('UPDATE factory.workspace SET candidate_commit = $2 WHERE id = $1', [s.workspaceId, 'f'.repeat(64)])).rowCount).toBe(1);
  });
});
