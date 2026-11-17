// Where a task is on its line (dashboard design pass, direction B; docs/assumptions.md A-23). A
// station is a node of the task's pinned plan; the stage descriptor says which station a task has
// reached. Derived here, on the server, from the same plan artifact GET /v2/tasks/{id}/plan returns,
// so no client has to fetch a plan per task or decide what a stage is. Read-only.
import type { Tx } from '@factory/database';

export type Station = { nodeId: string; label: string; gate: boolean };
// `index` counts from 1, so "stage index of count" reads naturally.
export type StageDescriptor = { nodeId: string; label: string; index: number; count: number; gate: boolean };
export type PlanReader = (taskId: string, ref: never) => Promise<Buffer>;
export type StageInput = { taskId: string; status: string; currentNodeId?: string | undefined };
export type StageRow = { task_id: string; status: string; current_node_id: string | null; org_id: string; template_id: string | null; template_version: string | null; plan_ref: unknown };

// A gate is a stage where a person must decide. Today that is plan review: the stage kind that opens
// a decision request. Another human stage kind joins this list when one exists.
export const GATE_STAGE_KINDS: ReadonlySet<string> = new Set(['plan_peer_review']);
export const isGate = (stageKind: string): boolean => GATE_STAGE_KINDS.has(stageKind);
export const stageLabel = (nodeId: string): string => {
  const words = nodeId.replaceAll('_', ' ').replaceAll('-', ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

type PlanNode = { id: string; stageKind: string };
const stationOf = (n: PlanNode): Station => ({ nodeId: n.id, label: stageLabel(n.id), gate: isGate(n.stageKind) });

// The shared line for several plans. One list when every plan has the same stations. When plans
// differ, the order-preserving union (plans taken in template order, so the same tasks always give the same line): stations in first-seen order, and a station a later plan adds
// goes right after the station that precedes it in that plan. A station is a gate if any plan says so.
export function mergeStations(lists: Station[][]): Station[] {
  const out: Station[] = [];
  for (const list of lists) {
    let after = -1;
    for (const s of list) {
      const at = out.findIndex((o) => o.nodeId === s.nodeId);
      if (at >= 0) { if (s.gate) out[at] = { ...(out[at] as Station), gate: true }; after = at; continue; }
      out.splice(after + 1, 0, s);
      after += 1;
    }
  }
  return out;
}

// The descriptor of one task on its own plan's stations. A finished task with no current node has
// reached the last station; anything else without a known current node has no position.
export function stageOf(stations: Station[], status: string, currentNodeId: string | undefined): StageDescriptor | undefined {
  const at = currentNodeId === undefined ? (status === 'succeeded' ? stations.length - 1 : -1) : stations.findIndex((s) => s.nodeId === currentNodeId);
  const s = stations[at];
  return s ? { nodeId: s.nodeId, label: s.label, index: at + 1, count: stations.length, gate: s.gate } : undefined;
}

// The rows to place: each task's status, current node and pinned plan. Only tasks in applications the
// caller may read are looked at (`readable`), whatever ids are asked for. A paused task has no current
// node (the workflow projects it without one), so it takes the node of its latest stage run on the
// current plan.
export async function stageRows(tx: Tx, taskIds: string[], readable: Iterable<string>): Promise<StageRow[]> {
  if (taskIds.length === 0) return [];
  return (await tx.query<StageRow>(`SELECT t.id AS task_id, t.status, t.org_id, p.template_id, p.template_version, p.plan_ref,
      CASE WHEN t.status = 'paused' AND t.current_node_id IS NULL
        THEN (SELECT r.node_id FROM factory.stage_run r WHERE r.org_id = t.org_id AND r.task_id = t.id AND r.plan_version = t.plan_version ORDER BY r.created_at DESC, r.id DESC LIMIT 1)
        ELSE t.current_node_id END AS current_node_id
    FROM factory.task t LEFT JOIN factory.execution_plan p ON p.org_id = t.org_id AND p.task_id = t.id AND p.version = t.plan_version
    WHERE t.id = ANY($1::uuid[]) AND t.primary_application_id = ANY($2::uuid[]) ORDER BY p.template_id NULLS LAST, p.template_version, t.id`, [[...new Set(taskIds)], [...readable]])).rows;
}

// Plans pinned to one template version have the same nodes, so the node list is remembered per
// organization, template and version. The plan's digest is therefore verified once per template
// version per process, not once per task: a later task on that version is not read again. The memory is
// a bounded LRU, and only successful reads are remembered.
export const PLAN_MEMORY = 300;
const known = new Map<string, Station[]>();
const recall = (key: string): Station[] | undefined => {
  const hit = known.get(key);
  if (hit) { known.delete(key); known.set(key, hit); } // most recently used goes last
  return hit;
};
const remember = (key: string, list: Station[]): void => {
  known.delete(key);
  known.set(key, list);
  while (known.size > PLAN_MEMORY) known.delete(known.keys().next().value as string);
};
export const forgetPlans = (): void => { known.clear(); };
// Reads tried per template version in one request, so one broken plan cannot make every task pay for a read.
export const READ_ATTEMPTS = 3;

// Stations by task, and the merged line. A plan that cannot be read (not planned yet, missing or
// failing its digest check) leaves that task without a stage and is not remembered, so the next task
// on the same template version tries its own read (up to READ_ATTEMPTS per request). The answer is
// never refused for it.
export async function resolveStages(rows: StageRow[], read: PlanReader | undefined): Promise<{ stations: Station[]; stages: Map<string, StageDescriptor> }> {
  const attempts = new Map<string, number>();
  const stationsOf = async (r: StageRow): Promise<Station[] | undefined> => {
    if (!r.template_id || !r.template_version || !read) return undefined;
    const key = `${r.org_id}:${r.template_id}@${r.template_version}`;
    const hit = recall(key);
    if (hit) return hit;
    const tried = attempts.get(key) ?? 0;
    if (tried >= READ_ATTEMPTS) return undefined;
    attempts.set(key, tried + 1);
    try {
      const plan = JSON.parse((await read(r.task_id, r.plan_ref as never)).toString('utf8')) as { nodes?: PlanNode[] };
      if (Array.isArray(plan.nodes) && plan.nodes.length > 0) { const list = plan.nodes.map(stationOf); remember(key, list); return list; }
    } catch { /* leave this task without a stage */ }
    return undefined;
  };
  const stages = new Map<string, StageDescriptor>();
  const lists: Station[][] = [];
  const seen = new Set<Station[]>();
  for (const r of rows) {
    const list = await stationsOf(r);
    if (!list) continue;
    if (!seen.has(list)) { seen.add(list); lists.push(list); }
    const stage = stageOf(list, r.status, r.current_node_id ?? undefined);
    if (stage) stages.set(r.task_id, stage);
  }
  return { stations: mergeStations(lists), stages };
}
