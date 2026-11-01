// Five independent task axes (ADR-06; chapter 05 "Assurance, invocation and delivery policy"):
// work type, target context, assurance, invocation budget and delivery scope. Each axis is resolved
// by its own rule; changing one input never changes the resolution of another axis.
import { effectiveAssurance, type Assurance } from '@factory/domain';

export type AxisInput = {
  workType: 'feature' | 'bug' | 'refactor' | 'maintenance' | 'performance' | 'platform' | 'documentation' | 'investigation';
  targetKind: 'new_application' | 'existing_application';
  requestedAssurance: Assurance;
  invocationMode: 'one' | 'bounded';
  deliveryScope: 'report' | 'patch' | 'pr' | 'preview' | 'production' | 'design';
  applicationId: string;
};
export type AxisPolicy = { applicationMinimumAssurance: Assurance; fastAllowedApplicationIds: string[]; discoveredRiskTriggers: string[] };
export type ResolvedAxes = { workType: AxisInput['workType']; targetKind: AxisInput['targetKind']; assurance: Assurance; invocationMode: AxisInput['invocationMode']; deliveryScope: AxisInput['deliveryScope'] };
export type AxisRejection = { axis: keyof ResolvedAxes; reason: string };

const DELIVERY_BY_TYPE: Record<AxisInput['workType'], readonly AxisInput['deliveryScope'][]> = {
  feature: ['patch', 'pr', 'preview', 'production', 'design'],
  bug: ['report', 'patch', 'pr', 'preview', 'production'],
  refactor: ['patch', 'pr', 'preview', 'production', 'design'],
  maintenance: ['patch', 'pr', 'preview', 'production'],
  performance: ['report', 'patch', 'pr', 'preview', 'production', 'design'],
  platform: ['patch', 'pr', 'preview', 'production', 'design'],
  documentation: ['report', 'patch', 'pr'],
  investigation: ['report'],
};

export function resolveAxes(input: AxisInput, policy: AxisPolicy): { axes: ResolvedAxes; rejections: AxisRejection[] } {
  const rejections: AxisRejection[] = [];
  // Target context: greenfield is new-target feature intent only.
  if (input.targetKind === 'new_application' && input.workType !== 'feature') rejections.push({ axis: 'targetKind', reason: 'new_application accepts feature intent only' });
  // Delivery scope: explicit and bounded per work type; production is never implied.
  if (!DELIVERY_BY_TYPE[input.workType].includes(input.deliveryScope)) rejections.push({ axis: 'deliveryScope', reason: `${input.workType} cannot deliver ${input.deliveryScope}` });
  // Assurance: max(requested, application minimum, discovered risk); fast needs an allowlist.
  let assurance = effectiveAssurance(input.requestedAssurance, policy.applicationMinimumAssurance, policy.discoveredRiskTriggers);
  if (assurance === 'fast' && !policy.fastAllowedApplicationIds.includes(input.applicationId)) assurance = 'standard';
  // Invocation budget: 'one' limits authoring invocations; it never removes independent checks.
  return { axes: { workType: input.workType, targetKind: input.targetKind, assurance, invocationMode: input.invocationMode, deliveryScope: input.deliveryScope }, rejections };
}
