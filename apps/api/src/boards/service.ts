// Project boards and the cross-project "my work" view (plan-additions P-21; A-18). Read-only
// projections of trusted task state: a board never changes a task. State changes go through the
// same commands and decisions as everywhere else, so the board cannot become a second source of
// truth. A project is an application.
import type { Database, Tx } from '@factory/database';
import { authorize, type Principal } from '../auth/rbac.ts';
import { ApiError } from '../tasks/service.ts';

export const BOARD_COLUMNS = ['queued', 'running', 'waiting', 'paused', 'done', 'stopped'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];
const COLUMN_OF: Record<string, BoardColumn> = { accepted: 'queued', queued: 'queued', running: 'running', cancelling: 'running', waiting_input: 'waiting', waiting_decision: 'waiting', paused: 'paused', succeeded: 'done', incomplete: 'stopped', failed: 'stopped', cancelled: 'stopped' };
// Finished work stays on a board for two weeks; active work always shows.
export const FINISHED_WINDOW_DAYS = 14;
const ACTIVE_CAP = 500;
const FINISHED_CAP = 100;

export type TaskCard = {
  taskId: string; applicationId: string; title: string; status: string; column: BoardColumn; workType: string;
  creatorId: string; ownerPrincipalId: string; currentNodeId?: string; waitingReason?: string;
  // The person a waiting task is waiting on, and the decision they have to answer.
  waitingOnPrincipalId?: string; decisionId?: string; decisionExpiresAt?: string;
  updatedAt: string;
};
export type Board = {
  applicationId: string; name: string; generatedAt: string;
  columns: Record<BoardColumn, TaskCard[]>;
  needsPerson: TaskCard[];
  spentThisMonthMicroUsd: number;
  people: Record<string, string>;
  // True when a cap cut the list; the board then says so instead of looking complete.
  truncated: boolean;
};
export type Me = { principalId: string; displayName: string; roles: string[]; projects: Array<{ applicationId: string; name: string }> };
export type MyWork = {
  principalId: string; generatedAt: string;
  // Ordered by what to do first. Others are blocked until you answer `needsYou`.
  needsYou: TaskCard[];
  stopped: TaskCard[];
  waitingOnOthers: TaskCard[];
  inProgress: TaskCard[];
  recentlyDone: TaskCard[];
  applications: Record<string, string>;
  people: Record<string, string>;
  truncated: boolean;
};

type Row = { id: string; primary_application_id: string; title: string | null; status: string; work_type: string; creator_id: string; owner_principal_id: string; current_node_id: string | null; waiting_reason: string | null; updated_at: Date; decision_id: string | null; required_principal_id: string | null; expires_at: Date | null };
const SELECT = `SELECT t.id, t.primary_application_id, s.spec->>'title' AS title, t.status, t.work_type, t.creator_id, t.owner_principal_id, t.current_node_id, t.waiting_reason, t.updated_at,
    d.id AS decision_id, d.required_principal_id, d.expires_at
  FROM factory.task t
  JOIN factory.task_spec_version s ON s.org_id = t.org_id AND s.task_id = t.id AND s.version = t.spec_version
  LEFT JOIN LATERAL (SELECT r.id, r.required_principal_id, r.expires_at FROM factory.decision_request r WHERE r.org_id = t.org_id AND r.task_id = t.id AND r.state = 'pending' ORDER BY r.created_at DESC LIMIT 1) d ON true`;
const FINISHED = "t.status IN ('succeeded','incomplete','failed','cancelled')";

function card(r: Row): TaskCard {
  const c: TaskCard = { taskId: r.id, applicationId: r.primary_application_id, title: r.title ?? '', status: r.status, column: COLUMN_OF[r.status] ?? 'stopped', workType: r.work_type, creatorId: r.creator_id, ownerPrincipalId: r.owner_principal_id, updatedAt: r.updated_at.toISOString() };
  if (r.current_node_id) c.currentNodeId = r.current_node_id;
  if (r.waiting_reason) c.waitingReason = r.waiting_reason;
  if (r.decision_id && r.required_principal_id && r.expires_at) { c.waitingOnPrincipalId = r.required_principal_id; c.decisionId = r.decision_id; c.decisionExpiresAt = r.expires_at.toISOString(); }
  return c;
}
const oldestFirst = (a: TaskCard, b: TaskCard): number => a.updatedAt.localeCompare(b.updatedAt) || a.taskId.localeCompare(b.taskId);
const newestFirst = (a: TaskCard, b: TaskCard): number => -oldestFirst(a, b);
const soonestExpiry = (a: TaskCard, b: TaskCard): number => (a.decisionExpiresAt ?? '').localeCompare(b.decisionExpiresAt ?? '') || oldestFirst(a, b);

export class BoardService {
  private readonly db: Database;
  constructor(o: { db: Database }) { this.db = o.db; }
  private tenant<T>(p: Principal, fn: (tx: Tx) => Promise<T>): Promise<T> { return this.db.withTenant({ orgId: p.orgId, principalId: p.principalId }, fn); }

  private async names(tx: Tx, cards: TaskCard[], extra: string[] = []): Promise<Record<string, string>> {
    const ids = [...new Set([...extra, ...cards.flatMap((c) => [c.creatorId, c.ownerPrincipalId, ...(c.waitingOnPrincipalId ? [c.waitingOnPrincipalId] : [])])])];
    if (ids.length === 0) return {};
    const r = await tx.query<{ id: string; display_name: string }>('SELECT id, display_name FROM factory.principal WHERE id = ANY($1::uuid[])', [ids]);
    return Object.fromEntries(r.rows.map((x) => [x.id, x.display_name]));
  }

  // Applications the caller may read, with their owners (for the RBAC decision).
  private async readableApplications(tx: Tx, p: Principal, only?: string): Promise<Map<string, string>> {
    const r = await tx.query<{ id: string; name: string; owner_ids: unknown }>('SELECT id, name, owner_ids FROM factory.application WHERE ($1::uuid IS NULL OR id = $1)', [only ?? null]);
    const out = new Map<string, string>();
    for (const a of r.rows) {
      const owners = Array.isArray(a.owner_ids) ? a.owner_ids.filter((x): x is string => typeof x === 'string') : [];
      if (authorize(p, 'task.read', { applicationId: a.id, applicationOwnerIds: owners }).allowed) out.set(a.id, a.name);
    }
    return out;
  }

  // Who the caller is and which projects they can open: what a client needs to draw its navigation.
  async me(p: Principal): Promise<Me> {
    return this.tenant(p, async (tx) => {
      const who = await tx.query<{ display_name: string }>('SELECT display_name FROM factory.principal WHERE id = $1', [p.principalId]);
      const apps = await this.readableApplications(tx, p);
      const roles = [...new Set(p.grants.map((g) => g.role))].sort();
      return { principalId: p.principalId, displayName: who.rows[0]?.display_name ?? '', roles, projects: [...apps.entries()].map(([applicationId, name]) => ({ applicationId, name })).sort((a, b) => a.name.localeCompare(b.name) || a.applicationId.localeCompare(b.applicationId)) };
    });
  }

  async board(p: Principal, applicationId: string): Promise<Board> {
    return this.tenant(p, async (tx) => {
      const name = (await this.readableApplications(tx, p, applicationId)).get(applicationId);
      if (name === undefined) throw new ApiError(404, 'not_found', 'unknown or inaccessible resource');
      const active = await tx.query<Row>(`${SELECT} WHERE t.primary_application_id = $1 AND NOT ${FINISHED} ORDER BY t.updated_at, t.id LIMIT ${String(ACTIVE_CAP + 1)}`, [applicationId]);
      const finished = await tx.query<Row>(`${SELECT} WHERE t.primary_application_id = $1 AND ${FINISHED} AND t.updated_at > now() - make_interval(days => ${String(FINISHED_WINDOW_DAYS)}) ORDER BY t.updated_at DESC, t.id LIMIT ${String(FINISHED_CAP + 1)}`, [applicationId]);
      const cards = [...active.rows.slice(0, ACTIVE_CAP), ...finished.rows.slice(0, FINISHED_CAP)].map(card);
      const columns = Object.fromEntries(BOARD_COLUMNS.map((c) => [c, [] as TaskCard[]])) as Record<BoardColumn, TaskCard[]>;
      for (const c of cards) columns[c.column].push(c);
      for (const c of ['queued', 'running', 'waiting', 'paused'] as const) columns[c].sort(oldestFirst); // longest-untouched first
      columns.done.sort(newestFirst);
      columns.stopped.sort(newestFirst);
      const spent = await tx.query<{ total: string | null }>(`SELECT sum(l.amount_micro_usd) AS total FROM factory.budget_ledger l JOIN factory.budget_account a ON a.org_id = l.org_id AND a.id = l.account_id JOIN factory.task t ON t.org_id = a.org_id AND t.id = a.task_id
        WHERE t.primary_application_id = $1 AND l.kind = 'observed_usage' AND l.created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [applicationId]);
      return {
        applicationId, name, generatedAt: new Date().toISOString(), columns,
        needsPerson: cards.filter((c) => c.decisionId !== undefined).sort(soonestExpiry),
        spentThisMonthMicroUsd: Number(spent.rows[0]?.total ?? 0), people: await this.names(tx, cards),
        truncated: active.rows.length > ACTIVE_CAP || finished.rows.length > FINISHED_CAP,
      };
    });
  }

  async myWork(p: Principal): Promise<MyWork> {
    return this.tenant(p, async (tx) => {
      const apps = await this.readableApplications(tx, p);
      const readable = [...apps.keys()];
      const mine = await tx.query<Row>(`${SELECT} WHERE t.primary_application_id = ANY($2::uuid[]) AND (t.creator_id = $1 OR t.owner_principal_id = $1) AND (NOT ${FINISHED} OR t.updated_at > now() - make_interval(days => ${String(FINISHED_WINDOW_DAYS)})) ORDER BY t.updated_at DESC, t.id LIMIT ${String(ACTIVE_CAP + 1)}`, [p.principalId, readable]);
      // Decisions assigned to me, on any task I can read (usually someone else's task).
      const asked = await tx.query<Row>(`${SELECT} WHERE t.primary_application_id = ANY($2::uuid[]) AND d.required_principal_id = $1 ORDER BY d.expires_at, t.id LIMIT ${String(ACTIVE_CAP + 1)}`, [p.principalId, readable]);
      const own = mine.rows.slice(0, ACTIVE_CAP).map(card);
      const needsYou = asked.rows.slice(0, ACTIVE_CAP).map(card).sort(soonestExpiry);
      const all = [...own, ...needsYou];
      return {
        principalId: p.principalId, generatedAt: new Date().toISOString(), needsYou,
        stopped: own.filter((c) => c.status === 'failed' || c.status === 'incomplete').sort(newestFirst),
        waitingOnOthers: own.filter((c) => (c.column === 'waiting' || c.column === 'paused') && c.waitingOnPrincipalId !== p.principalId).sort(oldestFirst),
        inProgress: own.filter((c) => c.column === 'queued' || c.column === 'running').sort(oldestFirst),
        recentlyDone: own.filter((c) => c.status === 'succeeded' || c.status === 'cancelled').sort(newestFirst),
        applications: Object.fromEntries([...new Set(all.map((c) => c.applicationId))].map((id) => [id, apps.get(id) ?? ''])),
        people: await this.names(tx, all, [p.principalId]),
        truncated: mine.rows.length > ACTIVE_CAP || asked.rows.length > ACTIVE_CAP,
      };
    });
  }
}
