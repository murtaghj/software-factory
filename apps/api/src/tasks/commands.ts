// Task commands and human decision responses (W-015; chapter 03 "Commands and safe application").
// The API authorizes at ingress and inserts command + dispatch atomically; the workflow re-checks
// revision, subject and decider when it applies the command, so an HTTP precheck alone never decides.
import { randomUUID } from 'node:crypto';
import { validateContract, type CommandReceipt, type DecisionPage, type DecisionView, type TaskRequest } from '@factory/contracts';
import { canonicalHash } from '@factory/domain';
import type { Database, Tx } from '@factory/database';
import type { ArtifactService } from '@factory/artifacts';
import { effectiveRoles, type Principal } from '../auth/rbac.ts';
import { ApiError, admitTaskRequest, workflowIdFor } from './service.ts';

const M1_COMMANDS = new Set(['pause', 'resume', 'cancel', 'amend_spec', 'change_budget']);
const RESPONSE_ENDPOINT_ACTIONS = new Set(['confirm_intent', 'approve_plan', 'approve_rule_exception']);

type TaskRow = { id: string; org_id: string; creator_id: string; owner_principal_id: string; interactive_holder_principal_id: string | null; primary_application_id: string; control_revision: string; status: string; owner_ids: unknown; delivery_scope: string };

export class CommandService {
  private readonly db: Database;
  private readonly artifacts: ArtifactService;
  constructor(o: { db: Database; artifacts: ArtifactService }) { this.db = o.db; this.artifacts = o.artifacts; }

  private tenant<T>(p: Principal, fn: (tx: Tx) => Promise<T>): Promise<T> { return this.db.withTenant({ orgId: p.orgId, principalId: p.principalId }, fn); }

  private async loadTask(tx: Tx, p: Principal, taskId: string): Promise<TaskRow> {
    const r = await tx.query<TaskRow>('SELECT t.id, t.org_id, t.creator_id, t.owner_principal_id, t.interactive_holder_principal_id, t.primary_application_id, t.control_revision, t.status, t.delivery_scope, a.owner_ids FROM factory.task t JOIN factory.application a ON a.org_id = t.org_id AND a.id = t.primary_application_id WHERE t.id = $1', [taskId]);
    const t = r.rows[0];
    const owners = Array.isArray(t?.owner_ids) ? (t.owner_ids as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    if (!t || effectiveRoles(p, { applicationId: t.primary_application_id, applicationOwnerIds: owners }).length === 0) throw new ApiError(404, 'not_found', 'unknown or inaccessible resource');
    return t;
  }

  private canControl(p: Principal, t: TaskRow): boolean {
    if (t.owner_principal_id === p.principalId || t.interactive_holder_principal_id === p.principalId) return true;
    const owners = Array.isArray(t.owner_ids) ? (t.owner_ids as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    return effectiveRoles(p, { applicationId: t.primary_application_id, applicationOwnerIds: owners }).some((g) => g.role === 'operator');
  }

  private async insertCommand(tx: Tx, p: Principal, t: TaskRow, envelope: { commandId: string; kind: string; expectedRevision: number }, payload: Record<string, unknown>, requestHash: string): Promise<CommandReceipt> {
    const inserted = await tx.query('INSERT INTO factory.command (org_id, id, task_id, principal_id, expected_revision, kind, request_hash, payload, state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,\'queued\') ON CONFLICT (org_id, id) DO NOTHING',
      [p.orgId, envelope.commandId, t.id, p.principalId, envelope.expectedRevision, envelope.kind, requestHash, JSON.stringify(payload)]);
    if (inserted.rowCount !== 1) {
      const prior = await tx.query<{ request_hash: string; task_id: string }>('SELECT request_hash, task_id FROM factory.command WHERE id = $1', [envelope.commandId]);
      if (prior.rows[0]?.request_hash !== requestHash || prior.rows[0].task_id !== t.id) throw new ApiError(409, 'command_conflict', 'this commandId was already used for a different command');
      return this.receipt(tx, envelope.commandId);
    }
    await tx.query("INSERT INTO factory.outbox (org_id, id, kind, aggregate_id, dedupe_key, payload, state) VALUES ($1,$2,'task.command',$3,$4,$5,'pending')", [p.orgId, randomUUID(), t.id, `command:${envelope.commandId}`, JSON.stringify(payload)]);
    await tx.query("INSERT INTO factory.audit_event (org_id, id, actor_id, action, resource_kind, resource_id, outcome, correlation_id, request_digest) VALUES ($1,$2,$3,$4,'task',$5,'allowed',$6,$7)", [p.orgId, randomUUID(), p.principalId, `command.${envelope.kind}`, t.id, envelope.commandId, requestHash]);
    return { commandId: envelope.commandId, taskId: t.id, state: 'queued', statusUrl: `/v2/commands/${envelope.commandId}` };
  }

  // A retried command is reconciled by commandId before any state check: once the first attempt has
  // been applied the revision has moved (or the task closed), and the retry must get the original
  // receipt, not 412/409 (AC-212). The same commandId with a different request is a conflict.
  private async replayIfKnown(tx: Tx, p: Principal, commandId: string, taskId: string, requestHash: string): Promise<CommandReceipt | undefined> {
    const prior = await tx.query<{ request_hash: string; task_id: string; principal_id: string }>('SELECT request_hash, task_id, principal_id FROM factory.command WHERE id = $1', [commandId]);
    const row = prior.rows[0];
    if (!row) return undefined;
    if (row.request_hash !== requestHash || row.task_id !== taskId || row.principal_id !== p.principalId) throw new ApiError(409, 'command_conflict', 'this commandId was already used for a different command');
    return this.receipt(tx, commandId);
  }

  private async receipt(tx: Tx, commandId: string): Promise<CommandReceipt> {
    const r = await tx.query<{ task_id: string; state: CommandReceipt['state']; rejection_reason: string | null; workflow_result: { resultingRevision?: number } | null }>('SELECT task_id, state, rejection_reason, workflow_result FROM factory.command WHERE id = $1', [commandId]);
    const c = r.rows[0];
    if (!c) throw new ApiError(404, 'not_found', 'unknown or inaccessible resource');
    return { commandId, taskId: c.task_id, state: c.state, statusUrl: `/v2/commands/${commandId}`, ...(c.rejection_reason ? { reason: c.rejection_reason } : {}), ...(typeof c.workflow_result?.resultingRevision === 'number' ? { resultingRevision: c.workflow_result.resultingRevision } : {}) };
  }

  async submit(p: Principal, taskId: string, ifMatch: string | undefined, idempotencyKey: string | undefined, raw: unknown): Promise<CommandReceipt> {
    if (!idempotencyKey) throw new ApiError(400, 'idempotency_key_required', 'Idempotency-Key header is required');
    const v = validateContract('CommandEnvelope', raw);
    if (!v.ok) throw new ApiError(422, 'invalid_command', 'request does not match CommandEnvelope', v.errors.slice(0, 10).map((e) => `${e.path || '/'} ${e.message}`));
    const env = v.value;
    if (ifMatch === undefined || ifMatch.replace(/"/g, '') !== String(env.expectedRevision)) throw new ApiError(412, 'if_match_mismatch', 'If-Match must carry the expected control revision');
    return this.tenant(p, async (tx) => {
      const t = await this.loadTask(tx, p, taskId);
      const replayed = await this.replayIfKnown(tx, p, env.commandId, t.id, canonicalHash(env));
      if (replayed) return replayed;
      if (env.kind === 'respond_decision' || env.decisionId !== undefined) {
        const d = await tx.query<{ action: string }>('SELECT action FROM factory.decision_request WHERE id = $1 AND task_id = $2', [env.decisionId ?? null, taskId]);
        if (d.rows[0] && RESPONSE_ENDPOINT_ACTIONS.has(d.rows[0].action)) throw new ApiError(422, 'decision_requires_response_endpoint', `${d.rows[0].action} decisions use POST /decisions/{decisionId}/responses`);
      }
      if (!M1_COMMANDS.has(env.kind)) throw new ApiError(422, 'unsupported_command', `${env.kind} is not available in this release`);
      if (['succeeded', 'incomplete', 'failed', 'cancelled'].includes(t.status)) throw new ApiError(409, 'task_terminal', `task is ${t.status}; new work uses a linked task`);
      if (!this.canControl(p, t)) throw new ApiError(403, 'not_task_controller', 'only the task owner, the interactive holder or an operator may control this task');
      if (String(env.expectedRevision) !== t.control_revision) throw new ApiError(412, 'stale_revision', `expected revision ${String(env.expectedRevision)} is not current (${t.control_revision})`);
      const payload: Record<string, unknown> = { workflowId: workflowIdFor(p.orgId, taskId), commandId: env.commandId, kind: env.kind, expectedRevision: env.expectedRevision, reason: env.reason };
      if (env.kind === 'amend_spec') {
        if (!env.specRef) throw new ApiError(422, 'invalid_command', 'amend_spec requires specRef');
        let spec: TaskRequest;
        try {
          const body = await this.artifacts.readVerified({ orgId: p.orgId, actorId: p.principalId, principalId: p.principalId, actorKind: 'human', groups: p.groups, grantIds: p.grants.map((g) => g.membershipId), correlationId: env.commandId, taskId }, env.specRef);
          const parsed = validateContract('TaskRequest', JSON.parse(body.toString('utf8')));
          if (!parsed.ok) throw new ApiError(422, 'invalid_spec', 'specRef does not contain a valid TaskRequest');
          spec = parsed.value;
        } catch (e) {
          if (e instanceof ApiError) throw e;
          throw new ApiError(422, 'invalid_spec', 'specRef is not a readable finalized artifact of this task');
        }
        if ((spec.deliveryScope === 'design') !== (t.delivery_scope === 'design')) throw new ApiError(422, 'design_scope_change_requires_new_task', 'a change into or out of design scope requires a new task');
        if (spec.targetContext.applicationId !== t.primary_application_id) throw new ApiError(422, 'target_change_requires_new_task', 'the primary target cannot change; create a linked task');
        // The amended spec is admitted exactly like a new request (application authority, incident
        // priority, unsupported capabilities), and may not change what the task row and budget
        // account were opened for: scope, priority and budget change only through their own paths.
        await admitTaskRequest(tx, p, spec);
        const current = await tx.query<{ spec: TaskRequest }>('SELECT s.spec FROM factory.task_spec_version s JOIN factory.task t ON t.org_id = s.org_id AND t.id = s.task_id AND t.spec_version = s.version WHERE t.id = $1', [t.id]);
        const was = current.rows[0]?.spec;
        if (!was) throw new ApiError(409, 'spec_not_found', 'the current task spec is not recorded');
        if (spec.deliveryScope !== was.deliveryScope) throw new ApiError(422, 'delivery_scope_change_not_supported', 'changing delivery scope by amendment is not available in this release');
        if ((spec.priorityClass ?? 'normal') !== (was.priorityClass ?? 'normal')) throw new ApiError(422, 'priority_change_not_supported', 'changing priority by amendment is not available in this release');
        if (canonicalHash(spec.budget) !== canonicalHash(was.budget)) throw new ApiError(422, 'budget_change_requires_change_budget', 'budgets change only through change_budget');
        const linked = await tx.query('SELECT 1 FROM factory.artifact_link WHERE artifact_id = $1 AND task_id = $2 LIMIT 1', [env.specRef.artifactId, t.id]);
        if ((linked.rowCount ?? 0) === 0) throw new ApiError(422, 'invalid_spec', 'specRef is not a readable finalized artifact of this task');
        payload.specRef = env.specRef;
      }
      if (env.kind === 'change_budget') {
        if (!env.budget) throw new ApiError(422, 'invalid_command', 'change_budget requires budget');
        // Raising a limit is a budget-owner decision (chapter 03): the application owner or an
        // operator. A task controller may only lower it.
        const account = await tx.query<{ limit_micro_usd: string }>('SELECT limit_micro_usd FROM factory.budget_account WHERE task_id = $1', [t.id]);
        const limit = account.rows[0] ? Number(account.rows[0].limit_micro_usd) : undefined;
        const owners = Array.isArray(t.owner_ids) ? (t.owner_ids as unknown[]).filter((x): x is string => typeof x === 'string') : [];
        const budgetOwner = effectiveRoles(p, { applicationId: t.primary_application_id, applicationOwnerIds: owners }).some((g) => g.role === 'operator' || g.role === 'application_owner');
        if ((limit === undefined || env.budget.maxMicroUsd > limit) && !budgetOwner) throw new ApiError(403, 'budget_increase_not_authorized', 'raising a task budget requires the application owner or an operator');
        payload.budgetMicroUsd = env.budget.maxMicroUsd;
      }
      return this.insertCommand(tx, p, t, env, payload, canonicalHash(env));
    });
  }

  async get(p: Principal, commandId: string): Promise<CommandReceipt> {
    return this.tenant(p, async (tx) => {
      const r = await tx.query<{ task_id: string }>('SELECT task_id FROM factory.command WHERE id = $1', [commandId]);
      if (!r.rows[0]) throw new ApiError(404, 'not_found', 'unknown or inaccessible resource');
      await this.loadTask(tx, p, r.rows[0].task_id);
      return this.receipt(tx, commandId);
    });
  }

  private toDecisionView(r: { id: string; task_id: string; action: DecisionView['action']; subject_hash: string; subject_ref: DecisionView['subjectRef']; policy_ref: DecisionView['policyRef']; evidence_refs: DecisionView['evidenceRefs']; eligible_roles: string[]; state: DecisionView['state']; reason: string; expires_at: Date; required_principal_id: string | null; decider_id: string | null }): DecisionView {
    return { id: r.id, taskId: r.task_id, action: r.action, subjectHash: r.subject_hash, subjectRef: r.subject_ref, policyRef: r.policy_ref, evidenceRefs: r.evidence_refs, eligibleRoles: r.eligible_roles, state: r.state, reason: r.reason, expiresAt: r.expires_at.toISOString(),
      ...(r.required_principal_id ? { requiredPrincipalId: r.required_principal_id } : {}), ...(r.decider_id ? { deciderId: r.decider_id, actorKind: 'human' as const } : {}) };
  }

  private readonly decisionSql = 'SELECT r.id, r.task_id, r.action, r.subject_hash, r.subject_ref, r.policy_ref, r.evidence_refs, r.eligible_roles, r.state, r.reason, r.expires_at, r.required_principal_id, d.decider_id FROM factory.decision_request r LEFT JOIN factory.decision d ON d.org_id = r.org_id AND d.request_id = r.id';

  async getDecision(p: Principal, id: string): Promise<DecisionView> {
    return this.tenant(p, async (tx) => {
      const r = await tx.query<Parameters<CommandService['toDecisionView']>[0]>(`${this.decisionSql} WHERE r.id = $1`, [id]);
      const row = r.rows[0];
      if (!row) throw new ApiError(404, 'not_found', 'unknown or inaccessible resource');
      await this.loadTask(tx, p, row.task_id);
      return this.toDecisionView(row);
    });
  }

  async listDecisions(p: Principal, q: { taskId?: string; state?: string }): Promise<DecisionPage> {
    return this.tenant(p, async (tx) => {
      // Newest first; rows the caller may not read are skipped before the page limit, so they
      // never hide readable decisions.
      const items: DecisionView[] = [];
      let offset = 0;
      for (;;) {
        const r = await tx.query<Parameters<CommandService['toDecisionView']>[0]>(`${this.decisionSql} WHERE ($1::uuid IS NULL OR r.task_id = $1) AND ($2::text IS NULL OR r.state = $2) ORDER BY r.created_at DESC, r.id DESC LIMIT 200 OFFSET $3`, [q.taskId ?? null, q.state ?? null, offset]);
        for (const row of r.rows) {
          try { await this.loadTask(tx, p, row.task_id); items.push(this.toDecisionView(row)); } catch (e) { if (!(e instanceof ApiError)) throw e; }
          if (items.length === 100) return { items };
        }
        if (r.rows.length < 200) return { items };
        offset += 200;
      }
    });
  }

  // Exact-subject human decisions use this endpoint only. Authorization and staleness are
  // prechecked here and decided again by the workflow when the response is applied.
  async respond(p: Principal, decisionId: string, idempotencyKey: string | undefined, raw: unknown): Promise<CommandReceipt> {
    if (!idempotencyKey) throw new ApiError(400, 'idempotency_key_required', 'Idempotency-Key header is required');
    const v = validateContract('DecisionResponse', raw);
    if (!v.ok) throw new ApiError(422, 'invalid_decision_response', 'request does not match DecisionResponse', v.errors.slice(0, 10).map((e) => `${e.path || '/'} ${e.message}`));
    const resp = v.value;
    return this.tenant(p, async (tx) => {
      const r = await tx.query<{ task_id: string; state: string; subject_hash: string; required_principal_id: string | null; expired: boolean }>('SELECT task_id, state, subject_hash, required_principal_id, expires_at <= now() AS expired FROM factory.decision_request WHERE id = $1', [decisionId]);
      const d = r.rows[0];
      if (!d) throw new ApiError(404, 'not_found', 'unknown or inaccessible resource');
      const t = await this.loadTask(tx, p, d.task_id);
      const replayed = await this.replayIfKnown(tx, p, resp.commandId, t.id, canonicalHash({ decisionId, ...resp }));
      if (replayed) return replayed;
      if (d.required_principal_id !== p.principalId) throw new ApiError(403, 'not_the_required_peer', 'this decision is assigned to another principal');
      if (d.state !== 'pending') throw new ApiError(409, 'decision_closed', `decision is ${d.state}`);
      if (d.expired) throw new ApiError(409, 'decision_expired', 'the decision request has expired');
      if (resp.subjectHash !== d.subject_hash) throw new ApiError(409, 'stale_subject', 'the response names a different subject than the pending decision');
      const payload = { workflowId: workflowIdFor(p.orgId, t.id), commandId: resp.commandId, kind: 'respond_decision', expectedRevision: resp.expectedRevision, reason: resp.reason, decisionId, outcome: resp.outcome, subjectHash: resp.subjectHash, reviewedSectionIds: resp.reviewedSectionIds ?? [], deciderPrincipalId: p.principalId, channel: 'decision_response_endpoint' };
      return this.insertCommand(tx, p, t, { commandId: resp.commandId, kind: 'respond_decision', expectedRevision: resp.expectedRevision }, payload, canonicalHash({ decisionId, ...resp }));
    });
  }
}
