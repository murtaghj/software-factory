# @factory/dispatcher (W-010)

Delivers outbox rows to Temporal. It is the only component that starts task workflows.

- **Leases.** Due rows are claimed per tenant with `FOR UPDATE SKIP LOCKED` and a bounded lease.
  The transaction is released before any network call. Results are recorded only while the lease
  is still held, so a resumed zombie dispatcher gets `lease_lost`. Due times, leases and backoff
  all use the database clock.
- **Launch** (`task.launch`) starts `factory/{orgId}/{taskId}` with `FAIL` conflict and
  `REJECT_DUPLICATE` reuse policies, and with workflow retries disabled. In three cases the
  dispatcher reconciles by describing the stable Workflow ID and attaching to it (AC-03), never
  starting a second workflow:
  - the workflow was already started (for example by a dispatcher that died before marking the row);
  - the start's reply was lost;
  - the start outcome is unknown.
- **Retry classification.** gRPC INVALID_ARGUMENT, NOT_FOUND, PERMISSION_DENIED,
  FAILED_PRECONDITION, UNIMPLEMENTED and UNAUTHENTICATED are permanent and go to `dead_letter`.
  Everything else is uncertain: reconcile, then back off exponentially (1 s doubling to 30 s) up to
  `maxAttempts`.
- **Commands** (`task.command`) are delivered as the `applyCommand` Update, with update ID = commandId.
  A timeout or lost reply leaves the command `delivered` (never `rejected`), and the same Update is
  re-invoked until the workflow's receipt answers.

Run with `node apps/dispatcher/src/main.ts`, passing `FACTORY_DATABASE_URL`, `TEMPORAL_ADDRESS`,
`TEMPORAL_NAMESPACE` and `FACTORY_TASK_QUEUE`.
