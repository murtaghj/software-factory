# @factory/fixtures (W-004)

A small but real system for qualifying the factory. It runs a web storefront client, an orders
API, an inventory API and an event worker on PostgreSQL 18, with W3C `traceparent` propagated
across every hop and controllable failure injection.

| Release | Kind | Behaviour |
| --- | --- | --- |
| orders-1.0.0 | known_good | Idempotent reservations, no cancellation feature |
| orders-1.1.0 | faulty | Reservation lost idempotency. A retry after a dropped response reserves twice (`expected reservation count 1; observed 2`) |
| orders-1.1.1 | candidate_fix | Reservation deduplicates on its idempotency key again |
| orders-2.0.0 | feature_candidate | Cancellation with ownership check, idempotent repeat and audit history |
| orders-2.0.0-happy-path | faulty_feature_candidate | Cancellation without the ownership check; a repeat writes a second audit entry |
| orders-3.0.0 | faulty | Orders sends `qty` instead of `quantity`. Inventory fails with 500 on the invalid input |

Each release pins its exact variant source files, schema, seed data and service contracts.
`src/releases/releases.lock.json` stores the digests, and the suite fails if they drift. After a
deliberate change, run `node fixtures/scripts/pin-releases.ts`.

## Canonical test packages and runner

`src/packages/<id>/` contains `manifest.json` (criteria and required environment faults) and
`scenarios.ts`. A package receives its test kit by injection, so its directory digest is its
complete behaviour. `runPackage` (fixture-test-runner 1.0.0) classifies each scenario as
`passed`, `assertion_failed`, `infrastructure_error`, `timeout`, `setup_error` or `error`. A
health check before each scenario, and after each assertion failure, keeps a broken environment
from posing as a product assertion.

## Answer keys

- AC-20: `evaluateBugRedLockGreen` (packages/domain), using the spec's FailureSignatureProfile.
- AC-25: `evaluateCriteriaEvidence` (packages/domain).
- AC-32: `attributeBoundaryFault` validates every recorded boundary request against the callee's
  pinned contract in causal order. It is the fixture's answer key for qualifying the real
  diagnosis (W-038). It is not that diagnosis.

Requires `pnpm services:up`. Each environment uses its own throwaway database.
