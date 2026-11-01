# Build the software factory — first run: M0 foundations → M1 fake vertical slice

You are the lead engineer starting implementation of a service that is fully specified
but has no code yet. Work carefully and verify by execution. A smaller amount of
genuinely working, tested code beats a large amount of plausible scaffolding.

## Sources of truth
- Spec (read-only): ~/software-factory-guide/implementation/ (revision 1.13, 29 Oct 2026).
  First action: copy it into ./docs/spec/ and record its revision and
  MANIFEST.sha256 in docs/spec/SOURCE.md. Never edit docs/spec/.
- Read in this order before writing code: README.md, 01-scope-architecture.md
  (stack, package layout, all INV-01–INV-29 invariants), 02-domain-data.md,
  03-api-events.md, 04-temporal.md, 05-workflows-gates.md, 13-testing-release.md,
  14-build-backlog.md. Read other chapters when a package you are building cites them.
- Machine-readable files: backlog.json (packages, dependencies, acceptance IDs),
  acceptance.json (given/when/then), contracts/ (domain.schema.json,
  factory-tools*.schema.json, api.openapi.json, interfaces.ts, schema.sql) and examples/.
- Precedence on conflict: invariants > contracts > chapter prose > examples.
  If the spec is wrong, ambiguous or self-contradictory, do NOT silently pick an
  interpretation that changes behaviour. Log it in docs/spec-issues.md (location,
  problem, choice made, why) and continue with the most conservative reading.

## Scope of this run
Build these backlog packages in dependency order, one at a time:
W-002 → W-003 → W-004 → W-006 → W-007 → W-008 → W-009 → W-010 → W-011 →
W-012 → W-013 → W-014 → W-015 → W-016 (fake complete vertical slice, AC-54).

Out of scope: everything from M2 onward. That includes the Kubernetes runner, real harnesses,
Git providers, Argo previews, the ai_only review mode (W-141–W-143) and design-only delivery
(W-144). Do not build ahead; use the fakes the spec defines for those boundaries.
DO keep the M1 data model and gate engine compatible with them: carry the ReviewMode and
deliveryScope fields and the human/AI approval-field split from the contracts, but implement
only human mode and the non-design delivery scopes now.

Some packages depend on organisation-only work: W-001 inventory, W-005 architecture/access review
and W-097 adoption spikes. You cannot complete those. Where a package depends on them,
use local-development defaults (e.g. a local OIDC test issuer for W-008, the
spec's default policy-engine choice for W-013). Record each one in
docs/assumptions.md with the decision-register ID it stands in for, and never mark a
decision-register entry as closed.

## Fixed product decisions (do not revisit)
- D1: human PR review is a merge condition, except in applications opted in to D5.
- D2: an urgent hotfix requires the on-call generalist plus every required specialist (INV-21).
- D3: W-126 hotfix is M7.
- D4: embargoed work publishes only to an isolated private fork/repo, and fails closed (INT-15).
- D5: an opt-in, per-application ai_only review mode. It never covers production release, embargoed work or hotfixes,
  and merges only to dev. INV-29: an AI approval never counts as a human approval.
- ADR-34: `design` is a delivery scope, not a work type. A design task never implements or merges.

## Engineering rules
- Stack per 01-scope-architecture.md: TypeScript strict, Node.js 24 LTS, a pnpm workspace,
  a committed lockfile, exact pinned versions, and the packages/* layout listed there.
- Contracts: generate types from the spec's JSON Schema (W-003). Never hand-edit
  generated files. Generation must be reproducible (a re-run produces no diff).
  The spec's examples/ fixtures (positive AND negative) become contract tests:
  positives must validate, and negatives must be rejected for their stated reason.
- Database: real Postgres 18 for tests, never mocked. Turn contracts/schema.sql into
  ordered migrations, and keep FORCE RLS and the factory_migrator / factory_runtime role split.
  Test as the runtime role, including cross-organisation denial.
- Temporal: use the Temporal TypeScript SDK test environment. Workflows must be
  deterministic and pass replay tests.
- Every acceptance ID listed on a package must become an executable test named after
  it (e.g. `AC-260 toolchain and contract generation`). An AC is only "passing" if the
  test ran and passed in this session. No skipped tests, no assertions that
  trivially pass, and no stubs that return the expected answer.
- Respect the invariants even where no test covers them yet. If you must defer one, list it.
- Fail closed: unknown, missing or unreadable authority, policy or decision state blocks.
  It never defaults to allow.
- Environment: macOS, no sudo. The container runtime is podman at ~/.local/bin/podman
  (run `podman machine start` if it cannot connect). Run Postgres and Temporal via
  podman compose. If Node 24 is not installed locally, use a pinned version manager
  or container rather than a different major version.

## Workflow per package
1. Re-read the package in 14-build-backlog.md and its AC entries in acceptance.json.
2. Write the AC tests first and watch them fail.
3. Implement the minimum that satisfies the deliverable and the cited spec sections.
4. Run the full check: `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck
   && pnpm test`, plus the contract-generation diff check. Everything must be green before moving on.
5. Commit on main with the message `W-0XX: <title>` and list the ACs now passing.
   Do not push anywhere.
6. Append a line to docs/build-log.md: package, ACs passing, assumptions, spec issues.

If a package is blocked for a reason you cannot resolve with a documented assumption,
stop that branch of work, record why, and continue with packages that do not depend on it.

## Final self-review before reporting
Re-read your own diff for each package against its ACs and the invariants it touches.
Look specifically for tests that pass without exercising the rule, permissive defaults,
and tenant/RLS leaks. Fix what you find, and record what you could not fix.

## Final report
When finished or blocked, output:
- A table: package | status (done / partial / blocked) | ACs passing (with test names) | notes
- The exact commands to reproduce the green run from a clean checkout
- New entries in docs/assumptions.md and docs/spec-issues.md
- Anything you are unsure is correct, stated plainly
