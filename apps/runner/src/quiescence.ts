// The quiescence proof: a pure function over what was observed (section 5, rule 3). What it proves is
// that no pod of the allocation was running when it was read. "No pod" counts only because no code path
// force-deletes. It never reads Job conditions, a Job's exit status, or a phase of Unknown.
import type { ContainerStatus, KubePod } from './kube/api.ts';

export const MAX_CONTAINERS_PER_POD = 64;

export type ContainerObservation = { name: string; kind: 'init' | 'app'; state: 'waiting' | 'running' | 'terminated' | 'unknown'; exitCode?: number; finishedAt?: string };
// What W-019 turns into the durable QuiescenceProof. No message or reason text: the harness writes its own.
export type PodObservation = { podUid: string; phase: string; containers: ContainerObservation[] };

export type QuiescenceInput = {
  jobAbsent: boolean;
  pods: readonly KubePod[];       // every pod carrying the allocation's label, whoever owns it
  podsTruncated: boolean;         // the list stopped at its page cap
  jobUidRecorded: boolean;
  stoppingForMs: number;          // measured in SQL from updated_at, which the transition stamped
  requestDeadlineMs: number;
};
export type NotProvedReason = 'job_present' | 'pods_truncated' | 'pod_not_finished' | 'pod_container_running' | 'too_many_containers' | 'create_may_be_in_flight';
export type Quiescence = { proved: true; observation: PodObservation[] } | { proved: false; reason: NotProvedReason; observation: PodObservation[] };

function observeContainers(statuses: readonly ContainerStatus[] | undefined, kind: 'init' | 'app', out: ContainerObservation[]): void {
  for (const s of statuses ?? []) {
    const t = s.state.terminated;
    const state = t ? 'terminated' : s.state.running ? 'running' : s.state.waiting ? 'waiting' : 'unknown';
    out.push({ name: s.name, kind, state, ...(t ? { exitCode: t.exitCode, ...(t.finishedAt === undefined ? {} : { finishedAt: t.finishedAt }) } : {}) });
  }
}

export function evaluateQuiescence(i: QuiescenceInput): Quiescence {
  const observation: PodObservation[] = [];
  let notProved: NotProvedReason | undefined;
  const fail = (r: NotProvedReason): void => { notProved ??= r; };
  if (!i.jobAbsent) fail('job_present');
  if (i.podsTruncated) fail('pods_truncated');
  if (!i.jobUidRecorded && i.stoppingForMs < i.requestDeadlineMs) fail('create_may_be_in_flight');
  for (const p of i.pods) {
    const init = p.status.initContainerStatuses ?? [];
    const app = p.status.containerStatuses ?? [];
    if (init.length > MAX_CONTAINERS_PER_POD || app.length > MAX_CONTAINERS_PER_POD) { fail('too_many_containers'); continue; }
    const containers: ContainerObservation[] = [];
    observeContainers(init, 'init', containers);
    observeContainers(app, 'app', containers);
    observation.push({ podUid: p.metadata.uid, phase: p.status.phase, containers });
    if (p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed') { fail('pod_not_finished'); continue; }
    if (containers.some((c) => c.state === 'running')) fail('pod_container_running');
  }
  return notProved === undefined ? { proved: true, observation } : { proved: false, reason: notProved, observation };
}
