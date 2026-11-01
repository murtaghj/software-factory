# @factory/policy (W-013)

Bundled, pinned, pure policy predicates. There is no OPA/Cedar adoption decision yet (W-097), so the
spec's fallback applies (A-11). Workflows call these functions directly, and their inputs and
results are recorded through Activities, so replay never re-evaluates live policy.

- `resolveAxes` resolves the five independent task axes (ADR-06): work type, target context,
  assurance, invocation budget and delivery scope. Assurance is the maximum of the requested tier,
  the application minimum and discovered risk. Fast requires the allowlist.
- `assessRisk` evaluates the actual change (paths, contract, migrations, services, coverage and
  blast radius) against the pinned policy profile's triggers and path rules. Size never lowers
  risk. Unknown trigger names fail closed.
- `checkCeilings` covers the authoring-invocation, semantic-attempt, money, active-time and
  calendar ceilings. Exhausting any of them yields an explicit `incomplete` outcome (INV-11).

Hierarchical money reservations live in `@factory/database` (`reserveBudget`/`chargeBudget`). They
lock root to leaf, reconcile operation keys, check every limit in the chain and record overruns
truthfully.
