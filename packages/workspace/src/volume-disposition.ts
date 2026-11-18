// What may be done with an old generation's volume (D19, W-019). Pure. No answer permits a second writer (rule 7): the answers say only who
// may act on the old volume. `quiescent` is a statement about the moment of the observation.
export type DispositionAnswer = 'in_use' | 'quiescent' | 'quarantined' | 'unknown';
export type DispositionInput = {
  state: 'desired' | 'starting' | 'running' | 'suspect' | 'stopping' | 'finalizing' | 'terminated' | 'completed' | 'quarantined';
  proof: { detachment: { method: string }; nodeCheck: string } | undefined;
  quarantineRecord: boolean;
  // Anything but `pod_scoped_local` is `unknown`: a CSI class cannot be called quiescent before D4 defines its observation (SI-30).
  storage: string;
};
export type Disposition = { answer: DispositionAnswer; mayAct: string };

export function volumeDisposition(i: DispositionInput): Disposition {
  if (i.storage !== 'pod_scoped_local') return { answer: 'unknown', mayAct: 'nobody' };
  if (i.state === 'quarantined') return i.quarantineRecord ? { answer: 'quarantined', mayAct: 'an operator, then W-024 after preserveUntil' } : { answer: 'unknown', mayAct: 'nobody' };
  if (i.state === 'desired' || i.state === 'starting' || i.state === 'running' || i.state === 'suspect' || i.state === 'finalizing') {
    return i.proof === undefined ? { answer: 'in_use', mayAct: 'nobody' } : { answer: 'unknown', mayAct: 'nobody' }; // a proof on a live row is not something this function trusts
  }
  const ok = i.proof !== undefined && i.proof.detachment.method === 'no_consumer_pod' && (i.proof.nodeCheck === 'passed' || i.proof.nodeCheck === 'not_needed');
  if (i.state === 'stopping' || i.state === 'terminated') return ok ? { answer: 'quiescent', mayAct: "W-020's checkpoint child, read-only; W-024 once the generation is replaced or released" } : { answer: 'unknown', mayAct: 'nobody' };
  return { answer: 'unknown', mayAct: 'nobody' }; // completed: W-020's
}
