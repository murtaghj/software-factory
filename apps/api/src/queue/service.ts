// The "what needs you next" queue (plan-additions P-24; A-21). One tenant transaction per request.
// Each source runs in its own SAVEPOINT, so a failing source marks itself degraded and the others
// still answer. Ranking is `rank.ts`; this file only gathers, checks and names.
import type { Database, Tx } from '@factory/database';
import type { Principal } from '../auth/rbac.ts';
import { readableApplications } from '../boards/service.ts';
import { ApiError } from '../tasks/service.ts';
import { resolveStages, stageRows, type PlanReader, type StageRow } from '../tasks/stations.ts';
import { factoryAdapters } from './adapters/index.ts';
import { KEY_FORMAT, PER_SOURCE_CAP, QUEUE_RULES, rankQueue, validateCandidate, keyOf, type Ranked } from './rank.ts';
import { QUEUE_SCHEMA, type Queue, type QueueAdapter, type QueueCandidate, type QueueContext, type QueueSourceStatus } from './types.ts';

export type QueueServiceOptions = { db: Database; adapters?: QueueAdapter[]; now?: () => Date; adapterTimeoutMs?: number; perSourceCap?: number; log?: (event: { requestId?: string; sourceId: string; error: unknown }) => void };

// An adapter is untrusted code: what it resolves to is checked before it is read.
const isResult = (v: unknown): v is { items: unknown[]; truncated: boolean } => typeof v === 'object' && v !== null && Array.isArray((v as { items?: unknown }).items) && typeof (v as { truncated?: unknown }).truncated === 'boolean';

type Gathered = { now: Date; apps: Map<string, string>; candidates: Ranked[]; sources: QueueSourceStatus[]; truncated: boolean };

export class QueueService {
  private readonly db: Database;
  private readonly adapters: QueueAdapter[];
  private readonly clock: (() => Date) | undefined;
  private readonly timeoutMs: number;
  private readonly cap: number;
  private readonly log: NonNullable<QueueServiceOptions['log']>;
  constructor(o: QueueServiceOptions) {
    this.db = o.db; this.adapters = o.adapters ?? factoryAdapters(); this.clock = o.now; this.timeoutMs = o.adapterTimeoutMs ?? 2000; this.cap = o.perSourceCap ?? PER_SOURCE_CAP;
    this.log = o.log ?? ((e) => { console.error(JSON.stringify({ queue: 'source_failed', sourceId: e.sourceId, requestId: e.requestId, error: e.error instanceof Error ? e.error.message : 'unknown' })); });
  }

  // Runs `fn` in a SAVEPOINT. A failed statement aborts a Postgres transaction; rolling back to the
  // savepoint is what lets the next source run.
  private async guarded<T>(tx: Tx, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    await tx.query('SAVEPOINT queue_source');
    try {
      const value = await fn();
      await tx.query('RELEASE SAVEPOINT queue_source');
      return { ok: true, value };
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT queue_source');
      return { ok: false, error };
    }
  }

  // Runs one adapter with a time limit on the JS side as well as the statement timeout. The adapter
  // gets a connection that stops working when its turn is over: if it is abandoned (hung, or slow
  // past the limit) its late queries are refused instead of running inside a later source's
  // savepoint. A query already in flight on the shared connection finishes (the statement timeout
  // bounds it) before the savepoint rollback, because the connection runs one statement at a time.
  // That ordering relies on pg's per-client FIFO query queue (deprecated for pg 9; docs/assumptions.md A-22).
  private async within(adapter: QueueAdapter, ctx: QueueContext): Promise<Awaited<ReturnType<QueueAdapter['collect']>>> {
    let open = true;
    const tx = new Proxy(ctx.tx, { get: (target, prop) => {
      if (prop !== 'query') return (target as unknown as Record<string | symbol, unknown>)[prop];
      return (...args: unknown[]) => {
        if (open) return (target.query as (...a: unknown[]) => unknown)(...args);
        const refused = new Error('this source has finished');
        const callback = args.at(-1);
        if (typeof callback === 'function') { (callback as (e: Error) => void)(refused); return undefined; } // callback style
        const p = Promise.reject(refused);
        p.catch(() => undefined); // an abandoned adapter that never awaits this must not crash the process
        return p;
      };
    } });
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(Object.assign(new Error('source timed out'), { code: '57014' })); }, this.timeoutMs); });
    try { return await Promise.race([adapter.collect({ ...ctx, tx }), limit]); } finally { open = false; clearTimeout(timer); }
  }

  private async gather(tx: Tx, p: Principal, requestId: string | undefined): Promise<Gathered> {
    await tx.query(`SET LOCAL statement_timeout = ${String(Math.max(1, Math.floor(this.timeoutMs)))}`);
    const now = this.clock ? this.clock() : (await tx.query<{ now: Date }>('SELECT now() AS now')).rows[0]?.now ?? new Date();
    const apps = await readableApplications(tx, p);
    const ctx: QueueContext = { principal: p, tx, now, readableApplications: apps, rules: { ...QUEUE_RULES, perSourceCap: this.cap } };
    const candidates: Ranked[] = [];
    const sources: QueueSourceStatus[] = [];
    let truncated = false;
    for (const [sourceOrder, adapter] of this.adapters.entries()) {
      const status: QueueSourceStatus = { id: adapter.id, kind: adapter.kind, status: 'ok', items: 0, truncated: false };
      const r = await this.guarded(tx, () => this.within(adapter, ctx));
      if (!r.ok) {
        this.log({ ...(requestId ? { requestId } : {}), sourceId: adapter.id, error: r.error });
        status.status = 'degraded'; status.problem = typeof r.error === 'object' && r.error !== null && (r.error as { code?: unknown }).code === '57014' ? 'timed_out' : 'failed';
      } else if (!isResult(r.value)) {
        status.status = 'degraded'; status.problem = 'invalid_items'; // the source answered with something that is not a result
      } else {
        const valid: QueueCandidate[] = [];
        let dropped = false;
        for (const c of r.value.items) { if (validateCandidate(c, apps, adapter.id) === undefined) valid.push(c); else dropped = true; }
        candidates.push(...valid.map((candidate) => ({ candidate, sourceId: adapter.id, sourceOrder })));
        status.items = valid.length; status.truncated = r.value.truncated;
        if (dropped) { status.status = 'degraded'; status.problem = 'invalid_items'; }
        truncated ||= r.value.truncated;
      }
      sources.push(status);
    }
    return { now, apps, candidates, sources, truncated };
  }

  private tenant<T>(p: Principal, fn: (tx: Tx) => Promise<T>): Promise<T> { return this.db.withTenant({ orgId: p.orgId, principalId: p.principalId }, fn); }

  private async ackedKeys(tx: Tx, p: Principal, keys: string[]): Promise<{ keys: Set<string>; failed: boolean }> {
    if (keys.length === 0) return { keys: new Set(), failed: false };
    const r = await this.guarded(tx, () => tx.query<{ item_key: string }>('SELECT item_key FROM factory.queue_ack WHERE principal_id = $1 AND item_key = ANY($2::text[])', [p.principalId, keys]));
    return r.ok ? { keys: new Set(r.value.rows.map((x) => x.item_key)), failed: false } : { keys: new Set(), failed: true };
  }

  // The tasks that are items in the caller's queue right now, so another view can leave them out.
  async itemTaskIds(p: Principal, requestId?: string): Promise<Set<string>> {
    return this.tenant(p, async (tx) => {
      const g = await this.gather(tx, p, requestId);
      const acks = await this.ackedKeys(tx, p, g.candidates.filter((c) => c.candidate.dismissible).map((c) => keyOf(c.candidate)));
      return new Set(rankQueue(g.candidates, acks.keys).items.flatMap((i) => (i.subject.taskId ? [i.subject.taskId] : [])));
    });
  }

  async get(p: Principal, requestId?: string, read?: PlanReader): Promise<Queue> {
    const { queue, rows } = await this.tenant(p, async (tx): Promise<{ queue: Queue; rows: StageRow[] }> => {
      const g = await this.gather(tx, p, requestId);
      const acks = await this.ackedKeys(tx, p, g.candidates.filter((c) => c.candidate.dismissible).map((c) => keyOf(c.candidate)));
      const { items, truncated } = rankQueue(g.candidates, acks.keys);
      const ids = [...new Set([p.principalId, ...items.flatMap((i) => (i.reason.actorPrincipalId ? [i.reason.actorPrincipalId] : []))])];
      const names = await this.guarded(tx, () => tx.query<{ id: string; display_name: string }>('SELECT id, display_name FROM factory.principal WHERE id = ANY($1::uuid[])', [ids]));
      // Positions on the line: the items' tasks, plus the caller's own open tasks so the line can be drawn for them too.
      const own = await this.guarded(tx, () => tx.query<{ id: string }>("SELECT t.id FROM factory.task t WHERE (t.creator_id = $1 OR t.owner_principal_id = $1) AND t.primary_application_id = ANY($2::uuid[]) AND t.status NOT IN ('succeeded','incomplete','failed','cancelled') ORDER BY t.updated_at DESC LIMIT 200", [p.principalId, [...g.apps.keys()]]));
      const taskIds = [...items.flatMap((i) => (i.subject.taskId ? [i.subject.taskId] : [])), ...(own.ok ? own.value.rows.map((r) => r.id) : [])];
      const stageData = await this.guarded(tx, () => stageRows(tx, taskIds, g.apps.keys()));
      const queue: Queue = {
        schema: QUEUE_SCHEMA, principalId: p.principalId, generatedAt: g.now.toISOString(), items, sources: g.sources, stations: [],
        degraded: acks.failed || !names.ok || g.sources.some((s) => s.status !== 'ok'), truncated: truncated || g.truncated, rules: QUEUE_RULES,
        applications: Object.fromEntries([...new Set(items.flatMap((i) => (i.subject.applicationId ? [i.subject.applicationId] : [])))].map((id) => [id, g.apps.get(id) ?? ''])),
        people: names.ok ? Object.fromEntries(names.value.rows.map((x) => [x.id, x.display_name])) : {},
      };
      return { queue, rows: stageData.ok ? stageData.value : [] };
    });
    // Plans are read after the tenant transaction ends, so a read never holds two connections. A plan
    // that cannot be read only costs its tasks a position on the line; it does not degrade the queue.
    const { stations, stages } = await resolveStages(rows, read);
    const items = queue.items.map((i) => { const stage = i.subject.taskId ? stages.get(i.subject.taskId) : undefined; return stage ? { ...i, stage } : i; });
    return { ...queue, items, stations };
  }

  // "Mark as seen". The server recomputes the caller's own items, so a key that is not currently the
  // caller's item (including another person's) is 404. Idempotent. A blocking item is never dismissed.
  async ack(p: Principal, key: unknown, requestId?: string): Promise<void> {
    if (typeof key !== 'string' || key.length < 3 || key.length > 300 || !KEY_FORMAT.test(key)) throw new ApiError(422, 'invalid_key', 'key must be the key of a queue item');
    return this.tenant(p, async (tx) => {
      if ((await this.ackedKeys(tx, p, [key])).keys.has(key)) return;
      const g = await this.gather(tx, p, requestId);
      const hit = g.candidates.find((c) => keyOf(c.candidate) === key);
      if (!hit) {
        if (g.sources.some((s) => s.status !== 'ok' || s.truncated)) throw new ApiError(503, 'dependency_unavailable', 'the queue could not be fully checked; try again');
        throw new ApiError(404, 'not_found', 'unknown or inaccessible resource');
      }
      if (!hit.candidate.dismissible) throw new ApiError(409, 'not_dismissible', 'this item goes away when it is dealt with; it cannot be marked as seen');
      await tx.query('INSERT INTO factory.queue_ack (org_id, principal_id, item_key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [p.orgId, p.principalId, key]);
    });
  }
}
