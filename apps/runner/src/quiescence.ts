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
  // ---- W-019. Absent in W-017's own calls of this function: then none of the three conditions below applies.
  writerPodUid?: string | null;
  // The node condition: with a start record, a writer pod that is absent from the list needs its node to still exist with the same UID.
  startRecord?: { nodeName: string | null; nodeUid: string | null } | undefined;
  nodeNow?: { name: string; uid: string } | 'absent' | 'unreadable' | undefined; // what getNode answered, when it was asked
  nodeCheck?: 'required' | 'off';
  // The claim condition: the namespace's pods listed WITHOUT a selector; none that is unfinished may name this generation's claim.
  claim?: { name: string; uid: string | null } | undefined;
  namespacePods?: readonly KubePod[];
  namespaceTruncated?: boolean;
};
export type NotProvedReason = 'job_present' | 'pods_truncated' | 'pod_not_finished' | 'pod_container_running' | 'too_many_containers' | 'create_may_be_in_flight' | 'writer_node_missing' | 'writer_node_unreadable' | 'claim_in_use' | 'claim_list_truncated';
export type Detachment = { method: 'no_consumer_pod'; claim: { name: string; uid: string } } | { method: 'no_claim' };
export type Facts = { writerPod: 'finished' | 'gone' | 'none'; nodeCheck: 'passed' | 'not_needed' | 'off'; detachment: Detachment };
export type Quiescence = ({ proved: true; observation: PodObservation[] } | { proved: false; reason: NotProvedReason; observation: PodObservation[] }) & { facts: Facts };

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
  // The node: a start record means a supervisor was granted, and a writer pod that the list no longer shows may have been garbage-collected with its node.
  // A claimed writer with no start record needs no node check: the record is written in the transaction that makes the allocation `running`.
  const writerListed = typeof i.writerPodUid === 'string' && i.pods.some((p) => p.metadata.uid === i.writerPodUid);
  let nodeCheck: Facts['nodeCheck'] = 'not_needed';
  if (i.nodeCheck === 'off') nodeCheck = 'off';
  else if (i.startRecord !== undefined && typeof i.writerPodUid === 'string' && !writerListed) {
    const n = i.nodeNow;
    // A writer WAS granted but its node is unknown (the start record was written with the node check off): the pod-GC hazard is unchecked, so say `off`
    // (the disposition then answers `unknown`), never `not_needed`, which means no grant at all.
    if (i.startRecord.nodeUid === null || i.startRecord.nodeName === null) nodeCheck = 'off';
    else if (typeof n === 'object' && n.name === i.startRecord.nodeName && n.uid === i.startRecord.nodeUid) nodeCheck = 'passed';
    // A node that cannot be read is "not yet", never "gone": only a 404 or a changed UID is.
    else if (n === 'unreadable' || n === undefined) { fail('writer_node_unreadable'); nodeCheck = 'not_needed'; }
    else { fail('writer_node_missing'); nodeCheck = 'not_needed'; }
  }
  // The claim: an unlabelled pod on the claim is exactly what the labelled lists miss.
  let detachment: Detachment = { method: 'no_claim' };
  if (i.claim !== undefined) {
    if (i.namespaceTruncated === true) fail('claim_list_truncated');
    for (const p of i.namespacePods ?? []) {
      const names = (p.spec.volumes ?? []).some((v) => v.persistentVolumeClaim?.claimName === i.claim?.name);
      if (names && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed') fail('claim_in_use');
    }
    if (i.claim.uid !== null) detachment = { method: 'no_consumer_pod', claim: { name: i.claim.name, uid: i.claim.uid } };
  }
  const writerPod: Facts['writerPod'] = typeof i.writerPodUid !== 'string' ? 'none' : writerListed ? 'finished' : 'gone';
  const facts: Facts = { writerPod, nodeCheck, detachment };
  return notProved === undefined ? { proved: true, observation, facts } : { proved: false, reason: notProved, observation, facts };
}
