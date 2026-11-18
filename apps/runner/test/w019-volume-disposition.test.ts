// What may be done with an old generation's volume (D19): the table of the brief row by row, and rule 7 (one generation, one claim, one writer).
import { describe, expect, it } from 'vitest';
import { volumeDisposition, type DispositionInput } from '@factory/workspace';
import { pvcName, renderJob } from '../src/index.ts';
import { allocation, config, request, stage, workspace } from './fixed-rows.ts';

const proof = { detachment: { method: 'no_consumer_pod' }, nodeCheck: 'passed' };
const base: DispositionInput = { state: 'stopping', proof, quarantineRecord: false, storage: 'pod_scoped_local' };

describe('W-019 volumeDisposition', () => {
  it('live, no proof: in_use', () => {
    for (const state of ['desired', 'starting', 'running', 'suspect', 'finalizing'] as const) expect(volumeDisposition({ ...base, state, proof: undefined }).answer).toBe('in_use');
  });
  it('stopping or terminated with a no_consumer_pod proof whose node check passed or was not needed: quiescent; control: any other proof is not', () => {
    for (const state of ['stopping', 'terminated'] as const) {
      expect(volumeDisposition({ ...base, state }).answer).toBe('quiescent');
      expect(volumeDisposition({ ...base, state, proof: { ...proof, nodeCheck: 'not_needed' } }).answer).toBe('quiescent');
      expect(volumeDisposition({ ...base, state, proof: { detachment: { method: 'no_claim' }, nodeCheck: 'passed' } }).answer).toBe('unknown');
      expect(volumeDisposition({ ...base, state, proof: { ...proof, nodeCheck: 'writer_node_missing' } }).answer).toBe('unknown');
    }
  });
  it('terminated with no proof (a row from before W-019): unknown, treated as quarantined', () => {
    expect(volumeDisposition({ ...base, state: 'terminated', proof: undefined }).answer).toBe('unknown');
  });
  it('quarantined with its record: quarantined, for an operator and then W-024; without the record: unknown', () => {
    expect(volumeDisposition({ ...base, state: 'quarantined', proof: undefined, quarantineRecord: true })).toMatchObject({ answer: 'quarantined' });
    expect(volumeDisposition({ ...base, state: 'quarantined', proof: undefined, quarantineRecord: false }).answer).toBe('unknown');
  });
  it('unknown for any storage kind but pod_scoped_local, whatever the proof says', () => {
    for (const storage of ['csi', 'nfs', '', 'POD_SCOPED_LOCAL']) expect(volumeDisposition({ ...base, storage }).answer).toBe('unknown');
    expect(volumeDisposition(base).answer).toBe('quiescent'); // control
  });
  it('no answer permits a second writer: for every allocation the rows can describe, renderJob names exactly pvcName(org, workspace, allocation.generation) or no claim', () => {
    for (const generation of [1, 2, 3]) {
      for (const state of ['desired', 'starting', 'running', 'stopping', 'terminated', 'quarantined'] as const) {
        const a = { ...allocation, generation, state };
        const w = { ...workspace, generation };
        const job = renderJob({ allocation: a, stage, workspace: w, request: { ...request, target: { ...request.target, generation } }, config });
        const claims = (job.spec.template.spec.volumes ?? []).flatMap((v) => (v.persistentVolumeClaim ? [v.persistentVolumeClaim.claimName] : []));
        expect(claims).toEqual([pvcName(a.orgId, w.id, generation)]);
        expect(claims).not.toContain(pvcName(a.orgId, w.id, generation + 1));
        expect(claims).not.toContain(pvcName(a.orgId, w.id, generation - 1 || 99));
      }
    }
    const bare = renderJob({ allocation: { ...allocation, workspaceId: null }, stage, workspace: undefined, request: undefined, config });
    expect((bare.spec.template.spec.volumes ?? []).some((v) => v.persistentVolumeClaim)).toBe(false);
  });
});
