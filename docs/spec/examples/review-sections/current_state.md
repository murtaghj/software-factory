# Current state

The fictional fixture has an Orders API, an order database and an inventory-event worker. Identity already supplies the customer subject; inventory accepts an idempotent release event. Pin the repository base to aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, the v1 order contract and fixture data version before execution.

The baseline suite must pass except a separately recorded preexisting defect. An unavailable dependency is infrastructure failure, not evidence of a missing feature.

### ContextManifest (fictional discovery record)

Sources consulted:
- Orders API, identity checks and transaction code at repository base aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: establish the existing ownership and atomic-write boundaries.
- Order and inventory-event contracts v1, fixture data v1: confirm request/event shapes and the existing consumer dedupe contract.
- Synthetic incident corpus v1, covering 1–30 September 2026: check prior cancellation/retry failures. No match above the fixture threshold; no past diagnosis is adopted as evidence.

Remaining gaps:
- Nonblocking: production rollout thresholds are not supplied; this PR-only slice grants no deployment authority and a future release must qualify them.
- Nonblocking: fixture timing does not establish production latency; preserve existing guardrails and attach before/after fixture measurements.

Assumptions: the fixture database supports the proposed transaction/uniqueness constraints, and the inventory consumer honors stable event identities. S2/S6/S7 must prove these behaviors; a failed assumption reopens design review. There are no blocking discovery gaps in this fictional plan.

This prose illustrates the ContextManifest content; its structured schema and runtime validation remain W-109 deliverables, not yet proven.
