// Capability proxy (AC-19; chapter 07: "Tool grants name operation, resource scope, environment,
// lifetime, maximum calls and side-effect class. The proxy checks each call against task state,
// allocation epoch and current capability."). Grants are minted only by the trusted control plane
// from the stage's role and the task's delivery scope. A call carries no authority of its own: any
// grant ID, justification or prompt text inside the request is ignored. Every decision is audited.
import { createHash, randomUUID } from 'node:crypto';
import type { CapabilityGrant } from '@factory/contracts';
import type { Database, Tx } from '@factory/database';

export type StageRole = 'discovery' | 'planner' | 'criteria_author' | 'implementer' | 'reviewer' | 'adversarial_tester' | 'verifier' | 'publisher' | 'knowledge_curator';
export type AllocationIdentity = { orgId: string; taskId: string; stageRunId: string; allocationId: string; allocationEpoch: number; role: StageRole; workspaceId: string; repositoryId: string };
export type ToolCall = { operation: string; resourceId: string; environment: string; request: Record<string, unknown> };
export type ProxyDecision = { allowed: boolean; reason: string; grantId?: string };

// Operations an authoring or reviewing role may ever receive. Publishing, merge, deployment and
// credential issuance are never minted for these roles; they go through controller workflows.
const ROLE_OPERATIONS: Record<StageRole, Array<{ operation: string; sideEffect: CapabilityGrant['sideEffect']; resource: 'workspace' | 'repository' }>> = {
  discovery: [{ operation: 'source.read', sideEffect: 'read', resource: 'workspace' }, { operation: 'telemetry.query', sideEffect: 'read', resource: 'repository' }],
  planner: [{ operation: 'source.read', sideEffect: 'read', resource: 'workspace' }],
  criteria_author: [{ operation: 'source.read', sideEffect: 'read', resource: 'workspace' }, { operation: 'workspace.write', sideEffect: 'workspace_write', resource: 'workspace' }],
  implementer: [{ operation: 'source.read', sideEffect: 'read', resource: 'workspace' }, { operation: 'workspace.write', sideEffect: 'workspace_write', resource: 'workspace' }, { operation: 'factory.verify', sideEffect: 'read', resource: 'workspace' }],
  reviewer: [{ operation: 'source.read', sideEffect: 'read', resource: 'workspace' }],
  adversarial_tester: [{ operation: 'source.read', sideEffect: 'read', resource: 'workspace' }, { operation: 'workspace.write', sideEffect: 'workspace_write', resource: 'workspace' }],
  verifier: [{ operation: 'source.read', sideEffect: 'read', resource: 'workspace' }],
  publisher: [{ operation: 'source.read', sideEffect: 'read', resource: 'workspace' }],
  knowledge_curator: [{ operation: 'knowledge.read', sideEffect: 'read', resource: 'repository' }],
};

export function mintGrants(a: AllocationIdentity, nowMs: number, lifetimeMs: number, maxCalls = 500): CapabilityGrant[] {
  return ROLE_OPERATIONS[a.role].map((op) => ({
    grantId: randomUUID(),
    operation: op.operation,
    resourceIds: [op.resource === 'workspace' ? a.workspaceId : a.repositoryId],
    environmentScope: 'task-workspace',
    expiresAt: new Date(nowMs + lifetimeMs).toISOString(),
    maxCalls,
    sideEffect: op.sideEffect,
    allocationEpoch: a.allocationEpoch,
  }));
}

export class CapabilityProxy {
  private readonly db: Database;
  private readonly grants: CapabilityGrant[];
  private readonly identity: AllocationIdentity;
  private readonly now: () => number;
  private readonly calls = new Map<string, number>();

  constructor(db: Database, identity: AllocationIdentity, grants: CapabilityGrant[], now: () => number = Date.now) {
    this.db = db;
    this.identity = identity;
    this.grants = grants;
    this.now = now;
  }

  private evaluate(call: ToolCall, current: { epoch: number; allocationState: string; taskStatus: string } | undefined): ProxyDecision {
    if (!current) return { allowed: false, reason: 'allocation or task not found' };
    if (current.epoch !== this.identity.allocationEpoch) return { allowed: false, reason: 'stale allocation epoch' };
    if (!['starting', 'running'].includes(current.allocationState)) return { allowed: false, reason: `allocation is ${current.allocationState}` };
    if (!['running'].includes(current.taskStatus)) return { allowed: false, reason: `task is ${current.taskStatus}` };
    const grant = this.grants.find((g) => g.operation === call.operation && g.resourceIds.includes(call.resourceId) && g.environmentScope === call.environment);
    if (!grant) return { allowed: false, reason: `no capability grants ${call.operation} on ${call.resourceId} in ${call.environment}` };
    if (grant.allocationEpoch !== current.epoch) return { allowed: false, reason: 'grant belongs to another allocation epoch', grantId: grant.grantId };
    if (!(Date.parse(grant.expiresAt) > this.now())) return { allowed: false, reason: 'grant expired', grantId: grant.grantId };
    if ((this.calls.get(grant.grantId) ?? 0) >= grant.maxCalls) return { allowed: false, reason: 'grant call limit reached', grantId: grant.grantId };
    return { allowed: true, reason: `grant ${grant.operation}`, grantId: grant.grantId };
  }

  async check(call: ToolCall): Promise<ProxyDecision> {
    const id = this.identity;
    return this.db.withTenant({ orgId: id.orgId }, async (tx: Tx) => {
      const r = await tx.query<{ owner_epoch: string; state: string; status: string }>(
        `SELECT a.owner_epoch, a.state, t.status FROM factory.execution_allocation a
         JOIN factory.stage_run s ON s.org_id = a.org_id AND s.id = a.stage_run_id
         JOIN factory.task t ON t.org_id = s.org_id AND t.id = s.task_id
         WHERE a.id = $1 AND s.id = $2 AND t.id = $3`, [id.allocationId, id.stageRunId, id.taskId]);
      const row = r.rows[0];
      const decision = this.evaluate(call, row ? { epoch: Number(row.owner_epoch), allocationState: row.state, taskStatus: row.status } : undefined);
      if (decision.allowed && decision.grantId) this.calls.set(decision.grantId, (this.calls.get(decision.grantId) ?? 0) + 1);
      // The request body is recorded only as a digest; nothing in it is interpreted.
      await tx.query('INSERT INTO factory.audit_event (org_id, id, actor_id, action, resource_kind, resource_id, outcome, correlation_id, request_digest, details_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [id.orgId, randomUUID(), `allocation:${id.allocationId}`, `capability.${call.operation}`, 'capability', call.resourceId, decision.allowed ? 'allowed' : 'denied', id.stageRunId,
          createHash('sha256').update(JSON.stringify(call)).digest('hex'), JSON.stringify({ reason: decision.reason, role: id.role, epoch: id.allocationEpoch, environment: call.environment })]);
      return decision;
    });
  }
}
