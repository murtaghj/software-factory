import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allocationId, cancelRecordId, checkpointJobName, jobName, pvcName, renderJob, renderPvc, RunnerError } from '../src/index.ts';
import { ORG, TASK, WS, LOGICAL, allocation, config, request, stage, workspace } from './fixed-rows.ts';

const doc = (n: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', n), 'utf8')) as unknown;
const fixed = { allocation, stage, workspace, request, config };
const RECEIPT = '00000000-0000-4000-8000-000000000004';

describe('W-017 names and manifests', () => {
  it('the three names match committed vectors, and 63 bytes is never exceeded at the largest generation', () => {
    expect(jobName(ORG, LOGICAL, 1)).toBe('factory-pivtiima6zxpahjnxf4d-g1');
    expect(pvcName(ORG, WS, 1)).toBe('factory-ws-b7oarlk2aytcod6z4d63-g1');
    expect(checkpointJobName(ORG, RECEIPT)).toBe('factory-64kpeahelturpa4g7eyu-c');
    expect(allocationId(ORG, LOGICAL, 1)).toBe('6d6363a2-a415-8491-9af4-367374fd9aac');
    expect(cancelRecordId(ORG, LOGICAL)).toBe('27d3d713-8944-8642-ad6e-60f71712af97');
    expect(jobName(ORG, LOGICAL, 2_147_483_647)).toBe('factory-pivtiima6zxpahjnxf4d-g2147483647');
    for (const n of [jobName(ORG, LOGICAL, 2_147_483_647), pvcName(ORG, WS, 2_147_483_647), checkpointJobName(ORG, RECEIPT)]) expect(Buffer.byteLength(n)).toBeLessThanOrEqual(63);
    // Different inputs differ; the generation is part of the name (control for the vectors above).
    expect(jobName(ORG, LOGICAL, 2)).not.toBe(jobName(ORG, LOGICAL, 1));
    expect(jobName(ORG, `${LOGICAL}x`, 1)).not.toBe(jobName(ORG, LOGICAL, 1));
    // Version-8 UUIDs.
    expect(allocationId(ORG, LOGICAL, 2)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('an over-long input is refused by its cap before it is hashed, and a bad generation is refused', () => {
    const long = 'x'.repeat(257);
    expect(() => jobName(ORG, long, 1)).toThrow(RunnerError);
    expect(() => pvcName(long, WS, 1)).toThrow(RunnerError);
    expect(() => checkpointJobName(ORG, long)).toThrow(RunnerError);
    expect(() => allocationId(ORG, LOGICAL, 0)).toThrow(RunnerError);
    expect(() => jobName(ORG, 'y'.repeat(256), 1)).not.toThrow(); // control: the cap is exactly 256 bytes
  });

  it('the builders take no StageInput, and their output for fixed rows equals the committed documents', () => {
    expect(renderJob.length).toBe(1); // one parameter: the rows and config
    expect(renderJob(fixed)).toEqual(doc('job.expected.json'));
    expect(renderPvc(fixed)).toEqual(doc('pvc.expected.json'));
    expect(renderJob(fixed)).toEqual(renderJob({ ...fixed })); // a pure function: any controller renders the same document
  });

  it('every container has limits, a read-only root, dropped capabilities, no automounted token and the File policy; grace 15, backoffLimit 0, deadline wall + 300', () => {
    const job = renderJob(fixed);
    const spec = job.spec.template.spec;
    const all = [...(spec.initContainers ?? []), ...spec.containers];
    expect(all.map((c) => c.name)).toEqual(['materialize', 'supervisor', 'harness']);
    for (const c of all) {
      expect(c.resources?.limits).toBeDefined();
      expect(c.securityContext).toMatchObject({ readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } });
      expect(c.terminationMessagePolicy).toBe('File');
    }
    expect(spec).toMatchObject({ automountServiceAccountToken: false, terminationGracePeriodSeconds: 15, restartPolicy: 'Never', shareProcessNamespace: false });
    expect(job.spec).toMatchObject({ backoffLimit: 0, activeDeadlineSeconds: stage.limits['wallSeconds'] as number + 300 });
    // The identity token is projected into the supervisor only, with the allocation's audience; the harness mounts no identity.
    expect(spec.containers.find((c) => c.name === 'harness')?.volumeMounts?.some((m) => m.name === 'factory-identity')).toBe(false);
    expect(spec.containers.find((c) => c.name === 'supervisor')?.volumeMounts?.some((m) => m.name === 'factory-identity')).toBe(true);
    expect(JSON.stringify(spec.volumes)).toContain(`factory-allocation:${ORG}:${allocation.id}`);
    // Control: an allocation with no workspace has no init step and no claim.
    const bare = renderJob({ ...fixed, allocation: { ...allocation, workspaceId: null }, workspace: undefined, request: undefined });
    expect(bare.spec.template.spec.initContainers).toBeUndefined();
    expect(() => renderPvc({ ...fixed, workspace: undefined })).toThrow(RunnerError);
  });

  it('the claim is ReadWriteOncePod with no owner reference; a wall cap above the bound is refused', () => {
    const pvc = renderPvc(fixed);
    expect(pvc.spec.accessModes).toEqual(['ReadWriteOncePod']);
    expect(pvc.metadata).not.toHaveProperty('ownerReferences');
    expect(() => renderJob({ ...fixed, stage: { ...stage, limits: { ...stage.limits, wallSeconds: 7201 } } })).toThrow(/wall cap/);
    expect(() => renderJob({ ...fixed, stage: { ...stage, limits: { ...stage.limits, wallSeconds: 7200 } } })).not.toThrow();
    expect(TASK).toBeDefined();
  });
});
