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

export async function stageRows(tx: Tx, taskIds: string[]): Promise<StageRow[]> {
  if (taskIds.length === 0) return [];
  return (await tx.query<StageRow>(`SELECT t.id AS task_id, t.status, t.current_node_id, t.org_id, p.template_id, p.template_version, p.plan_ref
    FROM factory.task t LEFT JOIN factory.execution_plan p ON p.org_id = t.org_id AND p.task_id = t.id AND p.version = t.plan_version
    WHERE t.id = ANY($1::uuid[]) ORDER BY p.template_id NULLS LAST, p.template_version, t.id`, [[...new Set(taskIds)]])).rows;
}

// Plans pinned to one template version have the same nodes, so one verified read per template
// version serves every task on it. Only successful reads are remembered.
const known = new Map<string, Station[]>();

// Stations by task, and the merged line. A plan that cannot be read (not planned yet, missing or
// failing its digest check) leaves that task without a stage; the answer is never refused for it.
export async function resolveStages(rows: StageRow[], read: PlanReader | undefined): Promise<{ stations: Station[]; stages: Map<string, StageDescriptor> }> {
  const byTemplate = new Map<string, Station[] | undefined>();
  const stationsOf = async (r: StageRow): Promise<Station[] | undefined> => {
    if (!r.template_id || !r.template_version || !read) return undefined;
    const key = `${r.org_id}:${r.template_id}@${r.template_version}`;
    if (byTemplate.has(key)) return byTemplate.get(key);
    let list = known.get(key);
    if (!list) {
      try {
        const plan = JSON.parse((await read(r.task_id, r.plan_ref as never)).toString('utf8')) as { nodes?: PlanNode[] };
        if (Array.isArray(plan.nodes) && plan.nodes.length > 0) { list = plan.nodes.map(stationOf); known.set(key, list); }
      } catch { /* leave this task without a stage */ }
    }
    byTemplate.set(key, list);
    return list;
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
