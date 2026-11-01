// Outbox dispatcher and command deliverer (W-010; chapter 01 step 2, chapter 03 "Commands and safe
// application").
//
// - Claims due outbox rows per tenant with a bounded lease (FOR UPDATE SKIP LOCKED) and releases
//   the transaction before any network call.
// - task.launch starts `factory/{orgId}/{taskId}` exactly once. An already-started workflow, or a
//   start whose reply was lost, is reconciled by describing the stable Workflow ID and attaching to
//   it; a second task workflow is never started (AC-03).
// - task.command delivers a Temporal Update whose update ID is the commandId. A timeout or lost reply
//   leaves the command `delivered` (never `rejected`) and re-invokes the same Update until the
//   workflow's receipt answers accepted, applied or rejected.
// - Results are recorded only while this dispatcher still holds the lease.
import { randomUUID } from 'node:crypto';
import type { Database, Tx } from '@factory/database';
import { AlreadyStarted, UpdateRejected, type TemporalGateway, type UpdateResult } from './temporal.ts';

export type DispatcherOptions = {
  db: Database;
  temporal: TemporalGateway;
  taskQueue: string;
  owner?: string;
  leaseMs?: number;
  batchSize?: number;
  maxAttempts?: number;
  // Leases, due times and backoff use the database clock (one clock for every dispatcher). Tests
  // shift that clock forward with an offset instead of mixing in the host clock.
  clockOffsetMs?: () => number;
  workerBuildId?: string;
  // Upper bound for one Update round trip; a slower answer is treated as an unknown outcome.
  updateTimeoutMs?: number;
};

type OutboxRow = { id: string; org_id: string; kind: string; aggregate_id: string; payload: Record<string, unknown>; attempts: number };
export type DispatchOutcome = { outboxId: string; kind: string; result: 'delivered' | 'retry' | 'dead_letter' | 'lease_lost'; detail: string };

const PERMANENT = new Set([3, 5, 7, 9, 12, 16]); // INVALID_ARGUMENT, NOT_FOUND, PERMISSION_DENIED, FAILED_PRECONDITION, UNIMPLEMENTED, UNAUTHENTICATED

export function classifyError(e: unknown): 'permanent' | 'uncertain' {
  const code = (e as { code?: unknown }).code;
  return typeof code === 'number' && PERMANENT.has(code) ? 'permanent' : 'uncertain';
}

export function backoffMs(attempts: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempts - 1));
}

export class Dispatcher {
  private readonly o: Required<DispatcherOptions>;
  constructor(o: DispatcherOptions) {
    this.o = { owner: `dispatcher-${randomUUID()}`, leaseMs: 30_000, batchSize: 20, maxAttempts: 10, workerBuildId: 'unversioned', clockOffsetMs: () => 0, updateTimeoutMs: 30_000, ...o };
  }

  private tenant<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.o.db.withTenant({ orgId }, fn);
  }

  async organizations(): Promise<string[]> {
    return this.o.db.withoutTenant(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM factory.organization WHERE status = 'active' ORDER BY id")).rows.map((r) => r.id));
  }

  async claim(orgId: string): Promise<OutboxRow[]> {
    return this.tenant(orgId, async (tx) => (await tx.query<OutboxRow>(
      `UPDATE factory.outbox SET state = 'leased', lease_owner = $1, lease_until = now() + make_interval(secs => ($2::bigint + $3::bigint) / 1000.0), attempts = attempts + 1, updated_at = now()
       WHERE id IN (SELECT id FROM factory.outbox
                    WHERE (state = 'pending' AND available_at <= now() + make_interval(secs => $3::bigint / 1000.0))
                       OR (state = 'leased' AND lease_until <= now() + make_interval(secs => $3::bigint / 1000.0))
                    ORDER BY available_at, id LIMIT $4 FOR UPDATE SKIP LOCKED)
       RETURNING id, org_id, kind, aggregate_id, payload, attempts`,
      [this.o.owner, this.o.leaseMs, this.o.clockOffsetMs(), this.o.batchSize])).rows);
  }

  // Finish an outbox row only if this dispatcher still holds its lease.
  private async finish(tx: Tx, row: OutboxRow, state: 'delivered' | 'pending' | 'dead_letter', error?: string): Promise<boolean> {
    const r = await tx.query(`UPDATE factory.outbox SET state = $3, lease_owner = NULL, lease_until = NULL, last_error = $4,
        available_at = now() + make_interval(secs => ($5::bigint + $6::bigint) / 1000.0), updated_at = now()
      WHERE id = $1 AND state = 'leased' AND lease_owner = $2`,
      [row.id, this.o.owner, state, error ?? null, state === 'pending' ? backoffMs(row.attempts) : 0, this.o.clockOffsetMs()]);
    return r.rowCount === 1;
  }

  private async retryOrDeadLetter(row: OutboxRow, detail: string): Promise<DispatchOutcome> {
    const dead = row.attempts >= this.o.maxAttempts;
    const ok = await this.tenant(row.org_id, (tx) => this.finish(tx, row, dead ? 'dead_letter' : 'pending', detail.slice(0, 500)));
    return { outboxId: row.id, kind: row.kind, result: ok ? (dead ? 'dead_letter' : 'retry') : 'lease_lost', detail };
  }

  private async recordBinding(row: OutboxRow, workflowId: string, runId: string, observed: string): Promise<DispatchOutcome> {
    const ok = await this.tenant(row.org_id, async (tx) => {
      await tx.query(`INSERT INTO factory.workflow_binding (org_id, id, task_id, workflow_id, current_run_id, worker_build_id, last_observed_state)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (org_id, task_id) DO UPDATE SET current_run_id = EXCLUDED.current_run_id, last_observed_state = EXCLUDED.last_observed_state, updated_at = now()
        WHERE factory.workflow_binding.workflow_id = EXCLUDED.workflow_id`,
        [row.org_id, randomUUID(), row.aggregate_id, workflowId, runId, this.o.workerBuildId, observed]);
      return this.finish(tx, row, 'delivered');
    });
    return { outboxId: row.id, kind: row.kind, result: ok ? 'delivered' : 'lease_lost', detail: `${workflowId} ${runId}` };
  }

  private async launch(row: OutboxRow): Promise<DispatchOutcome> {
    const workflowId = row.payload.workflowId;
    if (typeof workflowId !== 'string' || workflowId !== `factory/${row.org_id}/${row.aggregate_id}`) {
      const ok = await this.tenant(row.org_id, (tx) => this.finish(tx, row, 'dead_letter', 'launch payload does not name the stable task workflow ID'));
      return { outboxId: row.id, kind: row.kind, result: ok ? 'dead_letter' : 'lease_lost', detail: 'invalid workflow id' };
    }
    try {
      const { runId } = await this.o.temporal.start({ workflowId, taskQueue: this.o.taskQueue, args: [row.payload] });
      return await this.recordBinding(row, workflowId, runId, 'started');
    } catch (e) {
      if (!(e instanceof AlreadyStarted) && classifyError(e) === 'permanent') return this.retryOrDeadLetter({ ...row, attempts: this.o.maxAttempts }, `permanent start failure: ${String(e)}`);
      // Already started, or the outcome is unknown: reconcile against the stable Workflow ID.
      let found;
      try {
        found = await this.o.temporal.describe(workflowId);
      } catch (d) {
        return this.retryOrDeadLetter(row, `start outcome unknown and describe failed: ${String(d)}`);
      }
      if (found) return this.recordBinding(row, workflowId, found.runId, `attached:${found.status}`);
      return this.retryOrDeadLetter(row, `start failed before the workflow existed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async deliverCommand(row: OutboxRow): Promise<DispatchOutcome> {
    const { workflowId, commandId } = row.payload as { workflowId?: unknown; commandId?: unknown };
    if (typeof workflowId !== 'string' || typeof commandId !== 'string') {
      const ok = await this.tenant(row.org_id, (tx) => this.finish(tx, row, 'dead_letter', 'command payload lacks workflowId/commandId'));
      return { outboxId: row.id, kind: row.kind, result: ok ? 'dead_letter' : 'lease_lost', detail: 'invalid command payload' };
    }
    // A closed task workflow can never apply a command: record that, without calling Update.
    let described;
    try { described = await this.o.temporal.describe(workflowId); } catch (e) { return this.retryOrDeadLetter(row, `describe failed before command delivery: ${String(e)}`); }
    if (!described) return this.retryOrDeadLetter(row, 'task workflow not started yet');
    if (described.status !== 'RUNNING') {
      const ok = await this.tenant(row.org_id, async (tx) => {
        await tx.query("UPDATE factory.command SET state = 'rejected', rejection_reason = $2, updated_at = now() WHERE id = $1 AND state IN ('queued','delivered')", [commandId, `task workflow is ${described.status.toLowerCase()}`]);
        return this.finish(tx, row, 'delivered');
      });
      return { outboxId: row.id, kind: row.kind, result: ok ? 'delivered' : 'lease_lost', detail: 'workflow closed' };
    }
    // Mark the attempt before the call: a lost reply must leave `delivered`, never `rejected`.
    await this.tenant(row.org_id, (tx) => tx.query("UPDATE factory.command SET state = 'delivered', updated_at = now() WHERE id = $1 AND state = 'queued'", [commandId]));
    let result: UpdateResult;
    try {
      let timer: NodeJS.Timeout | undefined;
      try {
        result = await Promise.race([
          this.o.temporal.update(workflowId, commandId, [row.payload]),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(Object.assign(new Error('update deadline exceeded'), { code: 4 })); }, this.o.updateTimeoutMs); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (e) {
      if (e instanceof UpdateRejected) {
        result = { state: 'rejected', reason: e.message };
      } else if (classifyError(e) === 'permanent' && row.attempts >= this.o.maxAttempts) {
        return this.retryOrDeadLetter(row, `command delivery failed permanently: ${String(e)}`);
      } else {
        return this.retryOrDeadLetter(row, `command outcome unknown; will re-invoke the same update: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const ok = await this.tenant(row.org_id, async (tx) => {
      await tx.query("UPDATE factory.command SET state = $2, workflow_result = $3, rejection_reason = $4, updated_at = now() WHERE id = $1 AND state IN ('queued','delivered','accepted')",
        [commandId, result.state, JSON.stringify(result), result.state === 'rejected' ? (result.reason ?? 'rejected') : null]);
      return this.finish(tx, row, 'delivered');
    });
    return { outboxId: row.id, kind: row.kind, result: ok ? 'delivered' : 'lease_lost', detail: result.state };
  }

  async dispatch(row: OutboxRow): Promise<DispatchOutcome> {
    switch (row.kind) {
      case 'task.launch': return this.launch(row);
      case 'task.command': return this.deliverCommand(row);
      default: {
        const ok = await this.tenant(row.org_id, (tx) => this.finish(tx, row, 'dead_letter', `unknown outbox kind ${row.kind}`));
        return { outboxId: row.id, kind: row.kind, result: ok ? 'dead_letter' : 'lease_lost', detail: 'unknown kind' };
      }
    }
  }

  // Long-running loop for the dispatcher process: poll, back off when idle, stop on abort.
  async runLoop(signal: AbortSignal, idleMs = 1000, onError: (e: unknown) => void = () => undefined): Promise<void> {
    while (!signal.aborted) {
      let worked = false;
      try {
        worked = (await this.runOnce()).length > 0;
      } catch (e) {
        onError(e);
      }
      if (!worked) await new Promise<void>((resolve) => { const t = setTimeout(resolve, idleMs); signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); });
    }
  }

  // One pass over every active organization; each tenant is processed in its own transactions.
  async runOnce(): Promise<DispatchOutcome[]> {
    const outcomes: DispatchOutcome[] = [];
    for (const orgId of await this.organizations()) {
      for (const row of await this.claim(orgId)) outcomes.push(await this.dispatch(row));
    }
    return outcomes;
  }
}
