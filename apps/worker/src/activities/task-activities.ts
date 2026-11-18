// TaskWorkflow Activities (W-011). Every Activity is idempotent on a stable key, so Temporal
// infrastructure retries never duplicate effects (INV-02): plans by (task, version), stage runs by
// logical ID, projections by sequence + hash. The Activities are grouped by concern in sibling
// modules; this file composes them under the same names the worker registers.
import type { TaskActivities } from '../workflows/types.ts';
import { budgetActivities } from './budget.ts';
import { commandAuthorityActivities } from './command-authority.ts';
import { decisionActivities } from './decisions.ts';
import { fakeStageActivities } from './fake-stage.ts';
import { gateActivities } from './gates.ts';
import { outcomeActivities } from './outcome.ts';
import { persistenceActivities } from './persistence.ts';
import { planResolutionActivities } from './plan-resolution.ts';
import { createActivityKit, type ActivityDeps } from './shared.ts';

export { TEMPLATES_DIR } from './plan-resolution.ts';
export { DEFAULT_DECISION_TTL_MS, M1_POLICY, PLAN_SECTIONS, type ActivityDeps, type FakeStageBehavior } from './shared.ts';

export function createTaskActivities(deps: ActivityDeps): TaskActivities {
  const kit = createActivityKit(deps);
  return {
    ...persistenceActivities(kit),
    ...planResolutionActivities(kit),
    ...fakeStageActivities(kit),
    ...gateActivities(kit),
    ...budgetActivities(kit),
    ...decisionActivities(kit),
    ...outcomeActivities(kit),
    ...commandAuthorityActivities(kit),
  };
}
