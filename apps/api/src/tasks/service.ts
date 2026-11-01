// Task intake, detail and list (W-009). Business logic lives here, not in route handlers.
//
// Creation is one transaction: idempotency record, task, TaskSpec v1, task.accepted event, launch
// outbox row and audit. The idempotency record is inserted first with ON CONFLICT DO NOTHING, so a
// racing duplicate waits for the first transaction and then replays its stored response (same body)
// or receives 409 (different body) with no second side effect (AC-01, AC-02).
import { randomUUID } from 'node:crypto';
import { validateContract, type TaskAccepted, type TaskPage, type TaskRequest, type TaskView } from '@factory/contracts';
import { canonicalHash, canonicalJson } from '@factory/domain';
import type { Database, Tx } from '@factory/database';
import type { ArtifactService } from '@factory/artifacts';
import { authorize, effectiveRoles, type Principal } from '../auth/rbac.ts';

export const CREATE_TASK_ROUTE = 'POST /v2/tasks';
export const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const workflowIdFor = (orgId: string, taskId: string): string => `factory/${orgId}/${taskId}`;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors: string[];
  constructor(status: number, code: string, message: string, fieldErrors: string[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

export type CreateTaskOutcome = { status: number; body: TaskAccepted; replayed: boolean };
export type TaskServiceOptions = {
  db: Database;
  artifacts: ArtifactService;
  now?: () => number;
  // Fault injection for recovery tests: runs after the task row is inserted, before the outbox.
  hooks?: { beforeOutbox?: () => Promise<void> };
};

type TaskRow = {
  id: string; org_id: string; creator_id: string; owner_principal_id: string; interactive_holder_principal_id: string | null; primary_application_id: string;
  status: TaskView['status']; control_revision: string; plan_version: number; current_node_id: string | null; projection_sequence: string; projected_at: Date | null;
  created_at: Date; updated_at: Date; outcome_ref: TaskView['outcomeRef'] | null; cleanup_state: TaskView['cleanupState']; waiting_reason: string | null;
  last_event_sequence: string; priority_class: TaskView['priorityClass']; change_class: string; spec: TaskRequest;
};

const KEY = /^[\x21-\x7e]{1,200}$/;

export class TaskService {
  private readonly o: TaskServiceOptions;
  private readonly now: () => number;
  constructor(o: TaskServiceOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  private tenant<T>(p: Principal, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.o.db.withTenant({ orgId: p.orgId, principalId: p.principalId }, fn);
  }

  private async replay(tx: Tx, p: Principal, key: string, requestHash: string): Promise<CreateTaskOutcome | undefined> {
    const r = await tx.query<{ request_hash: string; response_status: number; response_body: TaskAccepted }>(
      'SELECT request_hash, response_status, response_body FROM factory.idempotency_record WHERE principal_id = $1 AND route = $2 AND request_key = $3', [p.principalId, CREATE_TASK_ROUTE, key]);
    const row = r.rows[0];
    if (!row) return undefined;
    if (row.request_hash !== requestHash) throw new ApiError(409, 'idempotency_conflict', 'this Idempotency-Key was already used with a different request');
    return { status: row.response_status, body: row.response_body, replayed: true };
  }

  // Admission checks that do not depend on the new task. Unsupported capabilities fail closed with
  // an explicit code rather than being silently accepted.
  private async admit(tx: Tx, p: Principal, req: TaskRequest): Promise<void> {
    if (req.targetContext.kind !== 'existing_application') throw new ApiError(422, 'new_application_not_supported', 'new-application (greenfield) intake is not available in this release');
    if (req.deliveryScope === 'design') throw new ApiError(422, 'design_scope_not_supported', 'design-only delivery is not available in this release');
    if (req.security !== undefined) throw new ApiError(422, 'security_tasks_not_supported', 'security/embargoed intake is not available in this release');
    if (req.parentTaskId !== undefined) throw new ApiError(422, 'child_tasks_not_supported', 'mixed parent/child tasks are not available in this release');
    if (req.designSource !== undefined) throw new ApiError(422, 'design_scope_not_supported', 'building from a design is not available in this release');
    if (!req.applicationIds.includes(req.targetContext.applicationId)) throw new ApiError(422, 'invalid_target', 'the primary application must be listed in applicationIds');
    const apps = await tx.query<{ id: string; lifecycle: string; owner_ids: unknown }>('SELECT id, lifecycle, owner_ids FROM factory.application WHERE id = ANY($1)', [req.applicationIds]);
    const byId = new Map(apps.rows.map((a) => [a.id, a]));
    for (const applicationId of new Set(req.applicationIds)) {
      const app = byId.get(applicationId);
      const owners = Array.isArray(app?.owner_ids) ? app.owner_ids.filter((x): x is string => typeof x === 'string') : [];
      // Unknown and unauthorized applications are indistinguishable (INV-14).
      if (!app || !authorize(p, 'task.create', { applicationId, applicationOwnerIds: owners }).allowed) throw new ApiError(403, 'application_not_authorized', 'not authorized to create tasks for one or more applications');
      if (app.lifecycle === 'draft') throw new ApiError(422, 'target_not_registered', 'existing-application work requires a registered application, not a draft');
    }
    if (req.priorityClass === 'incident') {
      const primary = byId.get(req.targetContext.applicationId);
      const owners = Array.isArray(primary?.owner_ids) ? primary.owner_ids.filter((x): x is string => typeof x === 'string') : [];
      const roles = effectiveRoles(p, { applicationId: req.targetContext.applicationId, applicationOwnerIds: owners }).map((g) => g.role);
      if (!roles.some((r) => r === 'operator' || r === 'application_owner')) throw new ApiError(403, 'incident_priority_unauthorized', 'incident priority requires authorized intake');
    }
  }

  private normalize(req: TaskRequest): TaskRequest {
    const spec: TaskRequest = { ...req, priorityClass: req.priorityClass ?? 'normal' };
    if (req.deliveryScope === 'pr' && req.prCompletion === undefined) spec.prCompletion = { mode: 'pr_created', maxReviewRounds: 3, maxWaitSeconds: 604800 };
    return spec;
  }

  async create(p: Principal, idempotencyKey: string | undefined, raw: unknown, correlationId: string): Promise<CreateTaskOutcome> {
    if (!idempotencyKey || !KEY.test(idempotencyKey)) throw new ApiError(400, 'idempotency_key_required', 'a printable Idempotency-Key header (1-200 characters) is required');
    const valid = validateContract('TaskRequest', raw);
    if (!valid.ok) throw new ApiError(422, 'invalid_task_request', 'request does not match TaskRequest', valid.errors.slice(0, 10).map((e) => `${e.path || '/'} ${e.message}`));
    const req = valid.value;
    const requestHash = canonicalHash(req);
    const prior = await this.tenant(p, (tx) => this.replay(tx, p, idempotencyKey, requestHash));
    if (prior) return prior;
    await this.tenant(p, (tx) => this.admit(tx, p, req));

    const taskId = randomUUID();
    const operationId = randomUUID();
    const spec = this.normalize(req);
    const specHash = canonicalHash(spec);
    const accepted: TaskAccepted = { taskId, operationId, statusUrl: `/v2/tasks/${taskId}`, status: 'accepted' };
    const payload = Buffer.from(canonicalJson({ schemaVersion: '2.0', eventType: 'task.accepted', taskId, specVersion: 1, specHash, workflowId: workflowIdFor(p.orgId, taskId) }));
    const object = await this.o.artifacts.putControllerObject(p.orgId, payload); // outside the transaction

    return this.tenant(p, async (tx) => {
      const claimed = await tx.query(`INSERT INTO factory.idempotency_record (org_id, id, principal_id, route, request_key, request_hash, response_status, response_body, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,202,$7,$8) ON CONFLICT (org_id, principal_id, route, request_key) DO NOTHING RETURNING id`,
        [p.orgId, randomUUID(), p.principalId, CREATE_TASK_ROUTE, idempotencyKey, requestHash, JSON.stringify(accepted), new Date(this.now() + IDEMPOTENCY_TTL_MS)]);
      if (claimed.rowCount !== 1) {
        const replayed = await this.replay(tx, p, idempotencyKey, requestHash);
        if (!replayed) throw new ApiError(409, 'idempotency_conflict', 'concurrent request with this Idempotency-Key is not visible');
        return replayed;
      }
      await this.admit(tx, p, req); // re-check inside the transaction that commits the side effects
      const target = req.targetContext;
      await tx.query(`INSERT INTO factory.task (org_id, id, creator_id, owner_principal_id, primary_application_id, target_kind, target_context, work_type, priority_class, change_class, incident_ref, delivery_scope, status, projected_at, last_event_sequence)
        VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,'accepted',now(),1)`,
        [p.orgId, taskId, p.principalId, target.applicationId, target.kind, JSON.stringify(target), spec.workType, spec.priorityClass ?? 'normal', spec.workType, spec.incidentRef === undefined ? null : JSON.stringify(spec.incidentRef), spec.deliveryScope]);
      await tx.query('INSERT INTO factory.task_spec_version (org_id, id, task_id, version, spec, spec_hash, actor_id) VALUES ($1,$2,$3,1,$4,$5,$6)', [p.orgId, randomUUID(), taskId, JSON.stringify(spec), specHash, p.principalId]);
      const payloadRef = await this.o.artifacts.registerControllerArtifact(tx, { orgId: p.orgId, taskId, producerId: 'control-plane:api', object, mediaType: 'application/json', schemaVersion: '2.0', classification: 'ordinary', purpose: 'task_event_payload' });
      await tx.query(`INSERT INTO factory.task_event (org_id, id, task_id, sequence, producer_event_id, event_type, occurred_at, source, schema_version, correlation_id, payload_ref)
        VALUES ($1,$2,$3,1,$4,'task.accepted',now(),'api','2.0',$5,$6)`, [p.orgId, randomUUID(), taskId, `api:${operationId}:task.accepted`, correlationId, JSON.stringify(payloadRef)]);
      await this.o.hooks?.beforeOutbox?.();
      await tx.query("INSERT INTO factory.outbox (org_id, id, kind, aggregate_id, dedupe_key, payload, state) VALUES ($1,$2,'task.launch',$3,$4,$5,'pending')",
        [p.orgId, randomUUID(), taskId, `launch:${taskId}`, JSON.stringify({ workflowId: workflowIdFor(p.orgId, taskId), taskId, orgId: p.orgId, specVersion: 1, specHash, operationId })]);
      await tx.query("INSERT INTO factory.audit_event (org_id, id, actor_id, action, resource_kind, resource_id, outcome, correlation_id, request_digest) VALUES ($1,$2,$3,'task.create','task',$4,'allowed',$5,$6)",
        [p.orgId, randomUUID(), p.principalId, taskId, correlationId, requestHash]);
      return { status: 202, body: accepted, replayed: false };
    });
  }

  private toView(row: TaskRow): TaskView {
    const view: TaskView = {
      id: row.id, orgId: row.org_id, creatorId: row.creator_id, ownerPrincipalId: row.owner_principal_id, spec: row.spec, status: row.status,
      revision: Number(row.control_revision), planVersion: row.plan_version, projectionSequence: Number(row.projection_sequence),
      projectedAt: (row.projected_at ?? row.created_at).toISOString(), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
      workflowId: workflowIdFor(row.org_id, row.id), cleanupState: row.cleanup_state, lastEventSequence: Number(row.last_event_sequence),
      priorityClass: row.priority_class, changeClass: row.change_class,
    };
    if (row.interactive_holder_principal_id) view.interactiveHolderPrincipalId = row.interactive_holder_principal_id;
    if (row.current_node_id) view.currentNodeId = row.current_node_id;
    if (row.outcome_ref) view.outcomeRef = row.outcome_ref;
    if (row.waiting_reason) view.waitingReason = row.waiting_reason;
    return view;
  }

  private readonly selectTask = `SELECT t.*, s.spec FROM factory.task t JOIN factory.task_spec_version s ON s.org_id = t.org_id AND s.task_id = t.id AND s.version = t.spec_version`;

  private async readable(tx: Tx, p: Principal, row: TaskRow): Promise<boolean> {
    const app = await tx.query<{ owner_ids: unknown }>('SELECT owner_ids FROM factory.application WHERE id = $1', [row.primary_application_id]);
    const owners = Array.isArray(app.rows[0]?.owner_ids) ? (app.rows[0].owner_ids as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    return authorize(p, 'task.read', { applicationId: row.primary_application_id, applicationOwnerIds: owners }).allowed;
  }

  async get(p: Principal, taskId: string): Promise<TaskView | undefined> {
    return this.tenant(p, async (tx) => {
      const r = await tx.query<TaskRow>(`${this.selectTask} WHERE t.id = $1`, [taskId]);
      const row = r.rows[0];
      return row && (await this.readable(tx, p, row)) ? this.toView(row) : undefined;
    });
  }

  async list(p: Principal, q: { cursor?: string; limit?: number; applicationId?: string; workType?: string; deliveryScope?: string; targetKind?: string; status?: string; creatorId?: string; ownerPrincipalId?: string; createdAfter?: string; createdBefore?: string; reviewMode?: string }): Promise<TaskPage> {
    const limit = q.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(422, 'invalid_limit', 'limit must be 1-100');
    if (q.reviewMode === 'ai_only') return { items: [] }; // ai_only review mode is not enabled in this release
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown): void => { params.push(v); where.push(sql.replace('?', `$${String(params.length)}`)); };
    if (q.cursor) {
      let c: { createdAt: string; id: string };
      try { c = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as { createdAt: string; id: string }; } catch { throw new ApiError(422, 'invalid_cursor', 'cursor is not valid'); }
      if (typeof c.createdAt !== 'string' || typeof c.id !== 'string' || Number.isNaN(Date.parse(c.createdAt))) throw new ApiError(422, 'invalid_cursor', 'cursor is not valid');
      params.push(c.createdAt, c.id);
      where.push(`(t.created_at, t.id) < ($${String(params.length - 1)}::timestamptz, $${String(params.length)}::uuid)`);
    }
    if (q.applicationId) add('t.primary_application_id = ?::uuid', q.applicationId);
    if (q.workType) add('t.work_type = ?', q.workType);
    if (q.deliveryScope) add('t.delivery_scope = ?', q.deliveryScope);
    if (q.targetKind) add('t.target_kind = ?', q.targetKind);
    if (q.status) add('t.status = ?', q.status);
    if (q.creatorId) add('t.creator_id = ?::uuid', q.creatorId);
    if (q.ownerPrincipalId) add('t.owner_principal_id = ?::uuid', q.ownerPrincipalId);
    if (q.createdAfter) add('t.created_at > ?::timestamptz', q.createdAfter);
    if (q.createdBefore) add('t.created_at < ?::timestamptz', q.createdBefore);
    return this.tenant(p, async (tx) => {
      const items: TaskView[] = [];
      let last: TaskRow | undefined;
      let exhausted = false;
      // Rows the caller may not read are skipped; keep fetching so a page is not cut short by them.
      while (items.length < limit && !exhausted) {
        const page = await tx.query<TaskRow>(`${this.selectTask}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}${last ? `${where.length ? ' AND' : ' WHERE'} (t.created_at, t.id) < ($${String(params.length + 1)}::timestamptz, $${String(params.length + 2)}::uuid)` : ''} ORDER BY t.created_at DESC, t.id DESC LIMIT ${String(limit + 1)}`,
          last ? [...params, last.created_at.toISOString(), last.id] : params);
        exhausted = page.rows.length <= limit;
        for (const row of page.rows.slice(0, limit)) {
          last = row;
          if (await this.readable(tx, p, row)) items.push(this.toView(row));
          if (items.length === limit) break;
        }
        if (page.rows.length === 0) exhausted = true;
      }
      const more = items.length === limit && last !== undefined && !exhausted;
      return more && last ? { items, nextCursor: Buffer.from(JSON.stringify({ createdAt: last.created_at.toISOString(), id: last.id })).toString('base64url') } : { items };
    });
  }
}
