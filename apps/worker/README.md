# @factory/worker (W-011)

Registers `TaskWorkflow` (`factory/{orgId}/{taskId}`) and its Activities.

- **Deterministic coordination** (INV-01). `src/workflows/` imports only `@temporalio/workflow`,
  `@factory/domain` and local types. The boundary checker and ESLint enforce this (no Date,
  Math.random, setTimeout, fetch or process).
- **Plan.** `resolvePlan` pins the template (`src/templates/investigation-0.1.0.json`, the M1 fake
  plan; A-10) and the policy snapshot as finalized artifacts, then upserts `execution_plan` by
  (task, version). The workflow schedules nodes whose dependencies passed for the current plan.
- **Stages.** Each node gets a logical stage ID
  `task-{taskId}/plan-{n}/{nodeId}/attempt-{k}` and an input hash: the canonical hash of its
  complete binding. A result advances the plan only if it names exactly the issued stage and
  binding, and the plan is still current. Otherwise it is recorded `inconclusive`
  (`superseded_binding`) and kept as history.
- **Projection** (AC-04). Every transition calls `projectTransition`
  (packages/database/src/projection.ts): higher sequence applies; equal sequence with the same
  hash is idempotent; a conflicting equal sequence is an integrity incident; a lower sequence is
  stale. Runner progress uses `appendTaskEvent` and never advances the projection sequence.
- **Commands.** The `applyCommand` Update is registered before the first await and is serialized:
  - it answers redeliveries from receipts carried across Continue-As-New (AC-08);
  - it rejects stale `expectedRevision` with a reason (AC-07);
  - it applies `amend_spec` by superseding the current plan;
  - any other kind is rejected as `unsupported_command` until W-015.
- **Continue-As-New** happens only at a safe boundary (no stage in flight, all handlers finished):
  on the SDK suggestion, after 5,000 events, or after `continueAsNewAfterStages`.
- **Replay** (AC-09). `test/histories/` holds representative histories captured by
  `scripts/capture-histories.ts` (completed, failed, open mid-stage, amended, continued-as-new).
  Every later build must replay them. Never overwrite a fixture; capture new ones when a build
  changes behaviour, behind `patched()`.
