# Implementation and worktrees

Create isolated task worktrees at the pinned real base. Scope changes to services/orders, workers/inventory-events, the additive migration and relevant test/docs paths. Shared-file changes require review.

Prerequisite: the criteria-author stage has already produced the independently reviewed canonical acceptance package before implementation starts.

1. Add transaction/schema constraints and cancellation handler.
2. Bind the existing inventory release worker to the stable event identity.
3. Run the accepted canonical package in independent verification.
4. Integrate the exact candidate, review and publish the PR.

Do not overwrite the default branch. Reverify if the integration base moves. Reserve the accepted task budget before each unit; an exhausted allowance produces incomplete, not an unchecked PR.

Checks by step: T1 runs the transaction/ownership/audit recipe for C1-C4; T2 runs inventory replay/recovery for C1/C2; T3 runs independent acceptance and integration for C1-C4; T4 requires exact-head human review and reconciled PR evidence. The structured packet pins each recipe/evidence requirement. All checks remain planned.

Reuse: extend the existing Orders handler and inventory consumer. Existing database transactions, outbox and dedupe components supply the platform behavior. A standard-library helper cannot replace durable transactions; existing database/event dependencies suffice. Add no third-party dependency. The minimal additions are the cancellation transaction/schema and consumer binding; the tradeoff is explicit outbox retry/operations work.

No implementation-stage deferred-work declaration exists yet. Tool 1.1 submissions must include one; disclosure cannot waive C1-C4.
