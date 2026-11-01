import { describe, expect, it } from 'vitest';
import { resolveAxes, type AxisInput } from '../src/index.ts';

const policy = { applicationMinimumAssurance: 'standard' as const, fastAllowedApplicationIds: [], discoveredRiskTriggers: [] };
const base: AxisInput = { workType: 'feature', targetKind: 'existing_application', requestedAssurance: 'standard', invocationMode: 'bounded', deliveryScope: 'pr', applicationId: 'app-1' };

describe('ADR-06 five independent task axes (W-013 truth table)', () => {
  it('changing any one axis input leaves every other resolved axis unchanged', () => {
    const variants: Array<[keyof AxisInput, AxisInput[keyof AxisInput]]> = [['invocationMode', 'one'], ['requestedAssurance', 'enhanced'], ['deliveryScope', 'patch'], ['workType', 'refactor']];
    const baseline = resolveAxes(base, policy).axes;
    for (const [axis, value] of variants) {
      const changed = resolveAxes({ ...base, [axis]: value }, policy).axes;
      const axisName = axis === 'requestedAssurance' ? 'assurance' : axis;
      for (const k of Object.keys(baseline) as Array<keyof typeof baseline>) {
        if (k === axisName) continue;
        expect(changed[k], `${axis} changed ${k}`).toBe(baseline[k]);
      }
    }
  });

  it.each([
    [{ workType: 'investigation', deliveryScope: 'pr' }, 'deliveryScope'],
    [{ workType: 'documentation', deliveryScope: 'preview' }, 'deliveryScope'],
    [{ workType: 'bug', targetKind: 'new_application' }, 'targetKind'],
    [{ workType: 'maintenance', deliveryScope: 'design' }, 'deliveryScope'],
  ] as const)('%o is rejected on axis %s', (over, axis) => {
    expect(resolveAxes({ ...base, ...over }, policy).rejections.map((r) => r.axis)).toEqual([axis]);
  });

  it('valid combinations resolve without rejection', () => {
    expect(resolveAxes({ ...base, workType: 'investigation', deliveryScope: 'report' }, policy).rejections).toEqual([]);
    expect(resolveAxes({ ...base, targetKind: 'new_application' }, policy).rejections).toEqual([]);
  });
});
