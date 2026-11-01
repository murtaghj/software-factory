# 14 — Implementation sequence and work packages

## Working model

Build vertical slices while maintaining the shared invariants. The first slice runs a deterministic fake task through API → Temporal → runner → artifact → gate → outcome. The next slice uses a real harness and Git. Add the second harness before the implementation develops an accidental dependency on one native session format.

The reference team has four engineering responsibilities: backend/control, execution/integrations, platform/reliability and product/full-stack. These are responsibilities, not a requirement to hire four people. A single engineer follows the dependency order serially; a team can work on ready independent packages. Assign one accountable owner per package and one reviewer for its boundary contracts.

## Milestones

| Milestone | Result | Exit evidence |
| --- | --- | --- |
| M0 — Integration and contract baseline | Prove Claude restricted-pod/gateway and, if selecting MCP, its effect-identity spike; decide agent-sandbox, attestation and policy-engine adoption against chapter 22 exit criteria; confirm app/Git/auth/storage; lock versions; approve exact contracts and nonwaivable invariants. | Provider inventory, working sandbox credentials, contract validation and architecture decisions. |
| M1 — Durable control plane | API/data/outbox/Temporal, policy, artifacts, early fault-injection framework and fake end-to-end path. | Duplicate/restart/command/history tests and visible exact gate bindings. |
| M2 — Isolated execution | Runner, workspaces, boundary checkpoints, verifier, factory tools and minimum admission. | Lost-pod, stale-writer and canonical-test integrity acceptance. |
| M3 — First useful workflows | Existing-target feature, machine-reported reproducible bug and investigation with Claude, human plan/oracle gates and PR follow-through. | Three real fixture outcomes plus their negative cases. |
| M4 — Portability and integrations | Codex portability then OpenCode, Git merge handling, registry/telemetry, draft registration/repository bootstrap and reviewed knowledge. | Cross-harness recovery, moving-base invalidation and causal diagnosis. |
| M5 — Preview environments | At least one qualified real provider: Argo PR previews or MCP; isolated data, readiness, verification and expiry. | Timeout-after-create reconciliation and no orphaned preview. |
| M6 — Complete journey and work-type coverage | Greenfield interview/confirmed intent/foundation/slice/children plus refactor, maintenance, performance, platform and documentation; mixed work; design-only delivery and build-from-design binding (W-144). | All eight types, all three journeys composed end to end and integrated composition (W-066 AC-66/AC-71); new-repository/monorepo positive/negative fixtures qualify in M8 (W-068). |
| M7 — Production and operations | App-qualified release/rollback, HA, capacity, security, backup and factory upgrade procedures. | Restore/isolation/load drills and qualified release provider. |
| M8 — Full v1 qualification | Representative evaluation, hardening, operator onboarding and controlled rollout. | Complete release evidence bundle and no unresolved launch-blocking defects. |

M1/M2 have independent work after their contract dependencies. M4/M5 can overlap where they do not share adapter assumptions. M6 can begin once its common stage/evidence contracts are stable. Production credentials and automatic release remain disabled until M7 qualification for the relevant application.

**First real task cut.** Inside M3, W-107 runs one reproducible machine-reported bug in one onboarded application end to end: current bug-fix readiness, an INT-14-cleared provider for its classification, Claude adapter, ContextManifest and incident evidence, plan packet with human peer sign-off, human oracle approval, red/lock/green, independent verification and a reviewed PR through W-080. Its DiagnosisManifest MAY derive from the chapter 08 hypothesis table without W-122 ledger tools. W-033 qualifies the full feature, bug and investigation graphs, including tracker evidence and the mandatory ledger. Recipes and campaigns (W-101–W-103) follow in M4, after W-033 qualifies the single-task path.

## Journey implementation dependencies

W-063 adds explicit routing/pinned contracts in M1. W-064/W-065 qualify draft onboarding and Git bootstrap in M4. W-066 composes greenfield foundation, independent slice verification and children in M6; W-067 exposes the distinct intake/progress in the dashboard. W-068 qualifies positive/negative greenfield fixtures and rework/recovery in M8, and is required by the full evaluation corpus. Existing W-027/W-028 retain feature/bug evidence obligations. W-069–W-071 add the mandatory adaptive interview, human confirmation and focused UI before greenfield qualification. W-072/W-073 supply complete engineering packets and layered peer review before the M3 implementation pilot; W-074 qualifies the full authority/revision/comprehension suite. The M3 pilot must label new-target creation unavailable until those capabilities are qualified. W-144 adds the design-only delivery scope and build-from-design binding in human mode in M6, after W-072/W-073 peer review, W-080 PR follow-through and W-069 greenfield confirmation; W-059 requires it before launch, and W-141 (AC-319) owns the ai-review design templates.

## Operational-review dependencies

W-059 requires the chapter 24 recurrence/look-alike scenarios and chapter 26 decoy/stall/escalation scenarios. Every required work package MUST precede W-062 controlled launch through the dependency graph; W-091 is optional forensics. W-041/W-078 (MCP) and W-139/W-140 (Argo) are individually optional provider branches, but W-042 and W-045 MUST complete at least one qualified branch. `dependsOn` lists mandatory prerequisites; every `dependsOnAny` group requires at least one completed alternative with conformance evidence. Selecting a branch requires all of its prerequisites; enabling both requires qualifying both. Static graph checks cover every possible branch, not runtime qualification. Enabling an earned capability still requires its own evidence and approvals. W-141–W-143 are optional for human-mode launch and all are required before ai_only enablement, which is a joint human decision and is never earned automatically.

W-077/W-078 are M0 feasibility spikes; W-079 starts failure injection in M1. W-025 moves to M2 so W-075 factory tools and W-088 admission precede the real runtime. W-035 is the Claude pilot adapter; W-076 qualifies its tools. W-080–W-086 supply PR feedback, health, verification, context and behavior evaluation before M3 acceptance. W-026 moves to M4 to prove Codex portability before OpenCode W-034. W-087 enables authorized evidence-backed gate modes in M7. Warm pools remain deferred. D5 replaces human review only through W-141–W-143; omission of plan approval remains excluded.

## Scope and estimation

The machine-readable backlog provides dependencies, accountable role, deliverables, acceptance IDs and an engineering-day range for each package. Estimates are planning assumptions for experienced engineers familiar with the stack, exclude unknown organization procurement/access delays and include focused tests/documentation. They are not commitments or generated sprint dates. Re-estimate after M0 and after the first three real tasks.

Use the generated total as effort, not elapsed duration. Team capacity, dependency paths, review, provider access and operational interruptions determine calendar duration. Limit simultaneous unfinished packages; complete a demonstrated slice before expanding workflow breadth. Each implementation PR should normally complete a reviewable subpart of one package rather than mixing unrelated adapters and state changes.

W-089/W-090 add M2 rule resolution and role compilation/admission; W-075 carries tool 1.1 and W-076 qualifies it before the M3 pilot. W-072/W-085/W-086 extend plan/review/evaluation duties. W-091 is optional M4 forensics and does not block the pilot. The aggregate estimate includes optional forensics, D5 packages and both provider alternatives; omit deferred forensics and the unselected provider branch when estimating implementation effort. See [chapter 21](21-rules-role-content-skills.md) for the authoritative requirements and compatibility rules.

## Definition of done for each package

- Named outputs exist in the intended modules with owner-facing documentation.
- Referenced acceptance scenarios pass at the appropriate test layer; provider behavior is exercised against its sandbox when required.
- Errors, retry/cancel behavior, audit and observability are implemented with the success path.
- Contracts and migration compatibility are checked; affected workflow histories replay.
- Security/capability scope and artifact retention are explicit.
- No placeholder success, silent fallback or unqualified capability is exposed as supported.
- A demo or reproducible command links to the resulting evidence.

## Detailed backlog

The generated appendix below is sourced from `backlog.json`; update the JSON through `tools/build_backlog.py` and rebuild the reader when changing package structure.

<!-- BACKLOG_START -->

144 work packages; estimated total 461–739 engineering-days before organization-specific access delays. At four full-time engineers and 70% effective delivery capacity, the arithmetic is roughly 33–53 weeks; dependency paths and integration findings may extend this. Re-estimate after M0.

### W-001 · Provider and access inventory

Milestone M0 · Owner: platform · Estimate: 2–4 engineering-days.

Dependencies: None. Modules: docs/integrations.

Deliverable: Close the M0 portions of INT-01 through INT-08 and INT-14 provider terms/classification levels with security/legal sign-off for pilot providers; inventory INT-11 bootstrap access facts; capture actual MCP schemas and sandbox operation examples if selecting that provider.

Acceptance: AC-40, AC-53.

### W-002 · Repository and pinned toolchain

Milestone M0 · Owner: backend · Estimate: 2–3 engineering-days.

Dependencies: None. Modules: workspace, CI.

Deliverable: Create strict TS/pnpm monorepo, package boundaries, lockfile, lint/typecheck and local service scripts.

Acceptance: AC-260.

### W-003 · Contract baseline and generation

Milestone M0 · Owner: backend · Estimate: 3–5 engineering-days.

Dependencies: W-002. Modules: packages/contracts.

Deliverable: Validate reference JSON Schema, generate TS/OpenAPI types, add positive/negative fixtures and compatibility checks.

Acceptance: AC-260, AC-18.

### W-004 · Representative fixture system

Milestone M0 · Owner: fullstack · Estimate: 3–5 engineering-days.

Dependencies: W-002. Modules: fixtures.

Deliverable: Build orders/inventory/web/event fixture with known-good and faulty releases, trace IDs and seeded data.

Acceptance: AC-20, AC-25, AC-32.

### W-005 · Architecture and access review

Milestone M0 · Owner: platform · Estimate: 2–3 engineering-days.

Dependencies: W-001, W-003. Modules: docs/adr.

Deliverable: Resolve deployment-specific defaults, roles, isolation and nonwaivable gate rules; document explicit unsupported capabilities.

Acceptance: AC-19, AC-40, AC-56.

### W-006 · Database migrations and repositories

Milestone M1 · Owner: backend · Estimate: 3–5 engineering-days.

Dependencies: W-003. Modules: packages/database.

Deliverable: Implement all core tables, tenant FKs/RLS, indexes, runtime roles and migration-forward tests including denied organization creation and immutable artifact/definition digests.

Acceptance: AC-05, AC-58, AC-203.

### W-007 · Artifact finalization and access

Milestone M1 · Owner: backend · Estimate: 3–5 engineering-days.

Dependencies: W-003, W-006. Modules: packages/artifacts.

Deliverable: Implement temporary upload, trusted digest/schema check, immutable registration, scoped access and orphan sweep.

Acceptance: AC-06, AC-49.

### W-008 · OIDC and application RBAC

Milestone M1 · Owner: fullstack · Estimate: 3–5 engineering-days.

Dependencies: W-005, W-006. Modules: apps/api.

Deliverable: Bind issuer/subject to scoped roles; enforce artifact/task/provider authorization and audit.

Acceptance: AC-05, AC-19, AC-44.

### W-009 · Task API and idempotency

Milestone M1 · Owner: backend · Estimate: 3–5 engineering-days.

Dependencies: W-006, W-008. Modules: apps/api.

Deliverable: Implement creation/list/detail with validated TaskRequest, stable idempotency records and launch outbox.

Acceptance: AC-01, AC-02, AC-03.

### W-010 · Outbox and command dispatcher

Milestone M1 · Owner: backend · Estimate: 3–5 engineering-days.

Dependencies: W-009. Modules: apps/dispatcher.

Deliverable: Implement leased dispatch, retry classification, stable Workflow IDs and uncertain-response reconciliation.

Acceptance: AC-03, AC-07, AC-08.

### W-011 · Temporal task skeleton

Milestone M1 · Owner: backend · Estimate: 3–5 engineering-days.

Dependencies: W-003, W-010. Modules: apps/worker.

Deliverable: Implement task states, handlers, projection sequencing and fake stage execution with deterministic replay.

Acceptance: AC-04, AC-07, AC-09.

### W-012 · Artifact bindings and gate engine

Milestone M1 · Owner: backend · Estimate: 3–5 engineering-days.

Dependencies: W-007, W-011. Modules: packages/domain.

Deliverable: Implement complete input binding hashes, gate evaluation and dependency invalidation across plan versions.

Acceptance: AC-24, AC-33, AC-44.

### W-013 · Policy and hierarchical budgets

Milestone M1 · Owner: backend · Estimate: 3–5 engineering-days.

Dependencies: W-012, W-097. Modules: packages/policy.

Deliverable: Implement five independent task axes, risk rules, reservations, ceilings and explicit incomplete outcomes.

Acceptance: AC-33, AC-34.

### W-014 · Events and initial task dashboard

Milestone M1 · Owner: fullstack · Estimate: 3–5 engineering-days.

Dependencies: W-009, W-011. Modules: apps/dashboard.

Deliverable: Implement ordered resumable SSE, task/stage/gate views and honest projection staleness.

Acceptance: AC-04, AC-52.

### W-015 · Command and decision workflow

Milestone M1 · Owner: backend · Estimate: 3–5 engineering-days.

Dependencies: W-011, W-012, W-008. Modules: apps/api, apps/worker.

Deliverable: Implement pause/resume/cancel/amend/budget and bound decision requests with dedupe and expiry.

Acceptance: AC-07, AC-08, AC-44.

### W-016 · Fake complete vertical slice

Milestone M1 · Owner: fullstack · Estimate: 2–3 engineering-days.

Dependencies: W-012, W-013, W-014, W-015. Modules: tests/system.

Deliverable: Demonstrate task intake through fake execution, independent result, report delivery and outcome manifest.

Acceptance: AC-54.

### W-017 · Kubernetes controller and Job protocol

Milestone M2 · Owner: platform · Estimate: 4–6 engineering-days.

Dependencies: W-005, W-006, W-011, W-077, W-097. Modules: apps/runner, deploy/helm.

Deliverable: Implement desired/observed reconciliation, deterministic Job naming, pod-specific permits and versioned allocations.

Acceptance: AC-10, AC-11.

### W-018 · Workspace manager and Git materialization

Milestone M2 · Owner: execution · Estimate: 4–6 engineering-days.

Dependencies: W-006, W-007. Modules: packages/workspace.

Deliverable: Implement private clones/worktrees, approved paths, setup profile, branch identity and independent evaluation source.

Acceptance: AC-12, AC-22, AC-38.

### W-019 · Lease fencing and process supervision

Milestone M2 · Owner: platform · Estimate: 4–6 engineering-days.

Dependencies: W-017, W-018. Modules: apps/supervisor.

Deliverable: Implement epochs, heartbeat, stale-writer rejection, process tree cancellation and isolated replacement rules.

Acceptance: AC-10, AC-12, AC-15.

### W-020 · Durable checkpoints and restore

Milestone M2 · Owner: execution · Estimate: 4–6 engineering-days.

Dependencies: W-007, W-018, W-019. Modules: packages/workspace.

Deliverable: Implement committed and dirty-state manifests, bundle transfer, finalization and clean-allocation restore.

Acceptance: AC-13, AC-14, AC-16.

### W-021 · Capability proxy and execution profiles

Milestone M2 · Owner: platform · Estimate: 4–6 engineering-days.

Dependencies: W-008, W-019. Modules: apps/runner, deploy/helm.

Deliverable: Implement scoped tool grants, per-role identities, egress controls and denied-operation audit.

Acceptance: AC-19, AC-56.

### W-022 · Canonical verifier supervisor

Milestone M2 · Owner: execution · Estimate: 4–6 engineering-days.

Dependencies: W-012, W-018, W-021, W-097. Modules: apps/verifier.

Deliverable: Implement exact source/package execution, external result collection, counts/integrity checks and trusted finalization.

Acceptance: AC-21, AC-22, AC-23, AC-24.

### W-023 · Runner Activity attachment and cancellation

Milestone M2 · Owner: backend · Estimate: 3–5 engineering-days.

Dependencies: W-019, W-020, W-011. Modules: apps/worker.

Deliverable: Implement startOrAttach/await heartbeat/cancel and typed infrastructure versus semantic outcomes.

Acceptance: AC-10, AC-14, AC-15.

### W-024 · Workspace/resource sweeper

Milestone M2 · Owner: platform · Estimate: 3–4 engineering-days.

Dependencies: W-019, W-020. Modules: apps/runner.

Deliverable: Implement UID-scoped cleanup, retention, orphan reconciliation and visible failed cleanup obligations.

Acceptance: AC-43.

### W-025 · Context builder and role prompts

Milestone M2 · Owner: execution · Estimate: 3–5 engineering-days.

Dependencies: W-007, W-012, W-021. Modules: packages/context.

Deliverable: Implement token allocation, fact selection, role context manifests, prompt packages and fresh/resume policy.

Acceptance: AC-18, AC-57.

### W-026 · Codex portability adapter

Milestone M4 · Owner: execution · Estimate: 3–5 engineering-days.

Dependencies: W-023, W-025, W-033, W-075. Modules: packages/harness/codex.

Deliverable: Implement pinned SDK/app-server mapping and prove fresh portable continuation from Claude with shared tool/lifecycle conformance.

Acceptance: AC-16, AC-18, AC-53.

### W-027 · Existing-project feature template

Milestone M3 · Owner: backend · Estimate: 3–5 engineering-days.

Dependencies: W-022, W-035, W-013, W-063, W-072, W-076, W-082, W-083. Modules: packages/domain, apps/worker.

Deliverable: Implement criteria/design/acceptance/execute/review path and exact candidate return routing.

Acceptance: AC-25, AC-24, AC-67.

### W-028 · Bug regression workflow

Milestone M3 · Owner: execution · Estimate: 4–6 engineering-days.

Dependencies: W-022, W-035, W-063, W-072, W-076, W-082, W-083. Modules: packages/verification.

Deliverable: Implement diagnosis/test review/baseline red/package lock/candidate green with tamper-resistant canonical source.

Acceptance: AC-20, AC-21, AC-22, AC-68.

### W-029 · Investigation template and report

Milestone M3 · Owner: backend · Estimate: 3–4 engineering-days.

Dependencies: W-025, W-035, W-013, W-072, W-076. Modules: packages/domain.

Deliverable: Implement bounded hypotheses/experiments/report/review with no forced code or deployment.

Acceptance: AC-31.

### W-030 · GitHub PR publishing adapter

Milestone M3 · Owner: execution · Estimate: 4–6 engineering-days.

Dependencies: W-018, W-008, W-012. Modules: packages/git.

Deliverable: Implement expected-head task refs, stable PR identity, webhook inbox and uncertain-create reconciliation.

Acceptance: AC-36, AC-38.

### W-031 · Review findings and adjudication

Milestone M3 · Owner: backend · Estimate: 3–5 engineering-days.

Dependencies: W-027, W-028, W-029. Modules: packages/verification.

Deliverable: Implement fresh reviewer schema, severity/routing, rebuttal limits and residual-risk decisions.

Acceptance: AC-35, AC-57.

### W-032 · Review and evidence UI

Milestone M3 · Owner: fullstack · Estimate: 3–5 engineering-days.

Dependencies: W-014, W-015, W-031. Modules: apps/dashboard.

Deliverable: Implement bound decisions, baseline/candidate evidence, stale-gate labels and safe artifact access.

Acceptance: AC-44, AC-49, AC-54.

### W-033 · First real pilot qualification

Milestone M3 · Owner: fullstack · Estimate: 3–5 engineering-days.

Dependencies: W-027, W-028, W-029, W-030, W-032, W-073, W-079, W-080, W-081, W-084, W-085, W-086, W-088, W-093, W-094, W-096, W-107, W-122, W-132, W-134, W-109, W-110, W-111, W-112. Modules: tests/system.

Deliverable: Qualify full feature machine-reported bug and investigation graphs with Claude human plan/oracle review independent checks PR follow-through and recovery; no greenfield/unreproduced claims; require closed INT-14 eligibility for the pilot application classification.

Acceptance: AC-20, AC-25, AC-31, AC-54, AC-67, AC-68.

### W-034 · OpenCode adapter and portable handoff

Milestone M4 · Owner: execution · Estimate: 4–6 engineering-days.

Dependencies: W-020, W-025, W-033, W-026. Modules: packages/harness/opencode.

Deliverable: Implement isolated server/session mapping and cross-vendor clean-pod continuation.

Acceptance: AC-17, AC-53.

### W-035 · Claude Agent SDK pilot adapter

Milestone M3 · Owner: execution · Estimate: 3–5 engineering-days.

Dependencies: W-023, W-025, W-077. Modules: packages/harness/claude.

Deliverable: Implement qualified Claude runtime gateway usage cancellation isolated settings and optional native persistence without vendor state in gates.

Acceptance: AC-16, AC-18, AC-53.

### W-036 · Git integration and merge queue

Milestone M4 · Owner: execution · Estimate: 4–6 engineering-days.

Dependencies: W-030, W-012. Modules: packages/git.

Deliverable: Implement target-head binding, integration candidates, conflict routing and merged-source provenance.

Acceptance: AC-37, AC-38, AC-46.

### W-037 · Registry imports and profile snapshots

Milestone M4 · Owner: backend · Estimate: 4–6 engineering-days.

Dependencies: W-006, W-007, W-005, W-098. Modules: packages/registry.

Deliverable: Implement schema-validated Git import, stable entities, declared graph and immutable resolved profiles.

Acceptance: AC-48.

### W-038 · Telemetry adapter and causal diagnosis

Milestone M4 · Owner: execution · Estimate: 4–6 engineering-days.

Dependencies: W-037, W-028, W-004, W-135. Modules: packages/telemetry.

Deliverable: Implement bounded traces/logs/release inventory and evidence-based multi-service hypothesis evaluation; close INT-09 telemetry and release-mapping facts.

Acceptance: AC-32.

### W-039 · Knowledge and runbook update workflow

Milestone M4 · Owner: backend · Estimate: 3–5 engineering-days.

Dependencies: W-037, W-031, W-030. Modules: packages/registry, apps/worker.

Deliverable: Implement scoped proposals, disputes/supersession, reviewed Git runbook changes and reindex.

Acceptance: AC-47, AC-48.

### W-040 · Application graph and knowledge UI

Milestone M4 · Owner: fullstack · Estimate: 3–5 engineering-days.

Dependencies: W-037, W-039, W-014. Modules: apps/dashboard.

Deliverable: Show source/observed distinctions, import health, profiles, owners and fact provenance.

Acceptance: AC-47, AC-48.

### W-041 · Actual MCP deployment mapping

Milestone M5 · Owner: execution · Estimate: 4–7 engineering-days.

Dependencies: W-001, W-005, W-007, W-037, W-078. Modules: packages/deployment.

Deliverable: Map observed tool schemas/auth/results as the MCP alternative; pass the common real-provider conformance suite for uncertain outcomes exact inventory readiness isolation and cleanup before declaring capabilities supported; fake tests alone do not qualify.

Acceptance: AC-39, AC-40, AC-41, AC-42, AC-43, AC-45, AC-56.

### W-042 · Environment workflow and operation ledger

Milestone M5 · Owner: backend · Estimate: 4–6 engineering-days.

Dependencies: W-011, W-013. At least one qualified provider: W-041 or W-139. Modules: apps/worker, packages/deployment.

Deliverable: Implement desired-state provisioning/reconcile/expiry with stable operation identity and unknown outcomes; require at least one qualified real provider from the alternative dependency group and bind its qualification evidence.

Acceptance: AC-39, AC-40, AC-43.

### W-043 · Fixtures, readiness and environment verification

Milestone M5 · Owner: execution · Estimate: 4–6 engineering-days.

Dependencies: W-042, W-022. Modules: packages/deployment, packages/verification.

Deliverable: Implement isolated data/migrations, dependency readiness and exact composition behavior checks.

Acceptance: AC-41, AC-42.

### W-044 · Preview cleanup and environment UI

Milestone M5 · Owner: fullstack · Estimate: 3–5 engineering-days.

Dependencies: W-042, W-024, W-014. Modules: apps/dashboard, apps/runner.

Deliverable: Implement lease extension, endpoint access, ownership/expiry and failed-cleanup visibility.

Acceptance: AC-43.

### W-045 · Preview qualification and environment-only bug

Milestone M5 · Owner: platform · Estimate: 3–5 engineering-days.

Dependencies: W-043, W-044, W-028. At least one qualified provider: W-041 or W-139. Modules: tests/system.

Deliverable: Require at least one qualified real provider from the alternative dependency group; prove timeout-after-create recovery exact inventory red/green comparable environments and no leaked resources; each enabled provider must pass and unsupported comparison profiles remain disabled.

Acceptance: AC-39, AC-41, AC-42, AC-43, AC-279.

### W-046 · Refactor and maintenance templates

Milestone M6 · Owner: backend · Estimate: 4–6 engineering-days.

Dependencies: W-027, W-031, W-037. Modules: packages/domain.

Deliverable: Implement preserved invariants/structural review and dependency compatibility matrices.

Acceptance: AC-26, AC-27.

### W-047 · Performance protocol and evaluator

Milestone M6 · Owner: execution · Estimate: 4–6 engineering-days.

Dependencies: W-022, W-037, W-043. Modules: packages/verification.

Deliverable: Implement frozen benchmark plans, repetition/variability reporting and correctness/resource guardrails; require controlled pinned/dedicated placement.

Acceptance: AC-28, AC-127.

### W-048 · Platform and migration template

Milestone M6 · Owner: backend · Estimate: 4–6 engineering-days.

Dependencies: W-043, W-031. Modules: packages/domain.

Deliverable: Implement desired-state plan, recovery requirements, mixed-version rehearsal and execution scope.

Acceptance: AC-29.

### W-049 · Documentation validation template

Milestone M6 · Owner: fullstack · Estimate: 3–5 engineering-days.

Dependencies: W-029, W-031, W-039. Modules: packages/domain.

Deliverable: Implement source-bound claims, links/rendering/examples and subject-review delivery.

Acceptance: AC-30.

### W-050 · Mixed tasks and multi-repository composition

Milestone M6 · Owner: backend · Estimate: 4–6 engineering-days.

Dependencies: W-036, W-046, W-048, W-049. Modules: apps/worker, packages/domain.

Deliverable: Implement child DAG validation, shared budget, release manifest and integrated parent completion.

Acceptance: AC-34, AC-46.

### W-051 · Adversarial testing and flake handling

Milestone M6 · Owner: execution · Estimate: 4–6 engineering-days.

Dependencies: W-031, W-022, W-043. Modules: packages/verification.

Deliverable: Implement risk-selected failure cases, oracle review and retained diagnostic repetition.

Acceptance: AC-35, AC-55.

### W-052 · Qualified production delivery

Milestone M7 · Owner: execution · Estimate: 4–7 engineering-days.

Dependencies: W-036, W-045, W-048, W-015. Modules: packages/deployment, apps/worker.

Deliverable: Implement application release profile, exact approval, rollout inventory, observation and mitigation; close INT-10 rollout metrics thresholds decision roles and recovery facts.

Acceptance: AC-44, AC-45, AC-59.

### W-053 · HA charts and execution hardening

Milestone M7 · Owner: platform · Estimate: 4–6 engineering-days.

Dependencies: W-021, W-042. Modules: deploy/helm.

Deliverable: Implement multi-replica control services, RBAC/network/storage profiles, probes/quotas and isolated pools.

Acceptance: AC-05, AC-56.

### W-054 · Capacity fairness and metering

Milestone M7 · Owner: backend · Estimate: 4–6 engineering-days.

Dependencies: W-013, W-023, W-042, W-088, W-085. Modules: apps/runner, packages/domain.

Deliverable: Implement organization/provider admission, child reservations, actual/estimated usage and reconciliation.

Acceptance: AC-34, AC-51.

### W-055 · Observability and operator runbooks

Milestone M7 · Owner: platform · Estimate: 3–5 engineering-days.

Dependencies: W-023, W-042, W-054. Modules: packages/telemetry, docs/runbooks.

Deliverable: Add traces/metrics/alerts for queues, leases, unknown operations, cleanup, integrity and budget.

Acceptance: AC-43, AC-54.

### W-056 · Backup, retention and disaster restore

Milestone M7 · Owner: platform · Estimate: 4–6 engineering-days.

Dependencies: W-007, W-053. Modules: deploy, docs/runbooks.

Deliverable: Implement PITR/object retention, reachability GC and restore reconciliation with side effects disabled.

Acceptance: AC-06, AC-50.

### W-057 · Factory upgrade and replay pipeline

Milestone M7 · Owner: backend · Estimate: 3–5 engineering-days.

Dependencies: W-011, W-053. Modules: CI, apps/worker.

Deliverable: Implement worker build routing/drain, expanded schema compatibility and representative history replay.

Acceptance: AC-09, AC-58.

### W-058 · Security and authority qualification

Milestone M7 · Owner: platform · Estimate: 4–6 engineering-days.

Dependencies: W-032, W-053, W-083, W-086. Modules: tests/isolation.

Deliverable: Exercise cross-task access, prompt/tool escalation, artifact script isolation and verifier authority limits.

Acceptance: AC-05, AC-19, AC-22, AC-49, AC-56, AC-57.

### W-059 · All-type evaluation corpus

Milestone M8 · Owner: fullstack · Estimate: 4–6 engineering-days.

Dependencies: W-034, W-035, W-046, W-047, W-048, W-049, W-050, W-051, W-068, W-074, W-026, W-087, W-111, W-114, W-124, W-125, W-038, W-040, W-103, W-104, W-113, W-118, W-120, W-127, W-136, W-144. Modules: tests/evals.

Deliverable: Run all positive/negative fixtures with measured quality, review usefulness, cost and portability; include chapter 24 recurrence and look-alike cases and chapter 26 decoy stall and escalation cases.

Acceptance: AC-60.

### W-060 · Recovery and concurrency qualification

Milestone M8 · Owner: platform · Estimate: 4–6 engineering-days.

Dependencies: W-052, W-056, W-057, W-058, W-065, W-079, W-016, W-129, W-131, W-138. Modules: tests/recovery.

Deliverable: Inject crashes/races at operation boundaries and execute real restore/rollback drills.

Acceptance: AC-07, AC-08, AC-12, AC-39, AC-50, AC-59.

### W-061 · Load and SLO qualification

Milestone M8 · Owner: platform · Estimate: 3–5 engineering-days.

Dependencies: W-054, W-055. Modules: tests/load.

Deliverable: Measure declared API/queue/cancel/cleanup objectives under documented workload and provider limits.

Acceptance: AC-51, AC-52.

### W-062 · Operator onboarding and controlled launch

Milestone M8 · Owner: fullstack · Estimate: 3–5 engineering-days.

Dependencies: W-059, W-060, W-061. Modules: docs/release, apps/dashboard.

Deliverable: Assemble release evidence, train owners/operators, extend onboarding beyond pilot applications and enable qualified scopes including production progressively.

Acceptance: AC-54, AC-60.

### W-063 · Target context and pinned journey contracts

Milestone M1 · Owner: backend · Estimate: 3–5 engineering-days.

Dependencies: W-003, W-009, W-012. Modules: packages/contracts, packages/domain, apps/worker.

Deliverable: Implement v2 target union, route matrix, immutable template definitions/bindings, reclassification invalidation and explicit legacy migration.

Acceptance: AC-61, AC-69, AC-70.

### W-064 · Draft application registration

Milestone M4 · Owner: backend · Estimate: 3–5 engineering-days.

Dependencies: W-006, W-008, W-037, W-063. Modules: packages/registry, apps/api, packages/database.

Deliverable: Implement draft identities/revisions, organization grants, active bootstrap claims and atomic experimental registration with real definitions.

Acceptance: AC-62, AC-74.

### W-065 · Repository bootstrap and reconciliation

Milestone M4 · Owner: execution · Estimate: 4–7 engineering-days.

Dependencies: W-018, W-030, W-036, W-064. Modules: packages/git, packages/workspace, apps/worker.

Deliverable: Qualify repository creation/conditional initialization and receipt before worktrees; enforce monorepo paths, scoped setup, cancellation retention and unknown effects.

Acceptance: AC-63, AC-64, AC-65, AC-72.

### W-066 · Greenfield foundation and product workflow

Milestone M6 · Owner: backend · Estimate: 5–8 engineering-days.

Dependencies: W-065, W-027, W-028, W-043, W-050, W-069. Modules: packages/domain, packages/verification, apps/worker.

Deliverable: Compose reviewed design, independent foundation/slice checks, registration and bounded children; enforce integrated parent criteria with explicit rework.

Acceptance: AC-66, AC-71, AC-228.

### W-067 · Distinct intake and glanceable journey UI

Milestone M6 · Owner: fullstack · Estimate: 3–5 engineering-days.

Dependencies: W-014, W-032, W-063, W-064, W-066. Modules: apps/dashboard.

Deliverable: Implement new-app draft intake and existing feature/bug choices, journey-specific milestones, compact blockers/actions and expandable evidence.

Acceptance: AC-61, AC-73, AC-74.

### W-068 · Three-journey qualification fixtures

Milestone M8 · Owner: fullstack · Estimate: 4–6 engineering-days.

Dependencies: W-066, W-067, W-045, W-051, W-071, W-133. Modules: fixtures, tests/system, tests/recovery.

Deliverable: Run new-repository and monorepo greenfield positive/negative fixtures plus feature/bug route, rework, replay, bootstrap recovery and UI qualification.

Acceptance: AC-61, AC-62, AC-63, AC-64, AC-65, AC-66, AC-67, AC-68, AC-69, AC-70, AC-71, AC-72, AC-73, AC-74, AC-220.

### W-069 · Adaptive intent interview and human gate

Milestone M6 · Owner: backend · Estimate: 5–8 engineering-days.

Dependencies: W-015, W-025, W-031, W-063, W-064. Modules: packages/domain, packages/contracts, apps/api, apps/worker.

Deliverable: Implement immutable brief/question/answer state, coverage and contradiction handling, exact-human confirmation, normalized spec application and durable waiting/reopen behavior.

Acceptance: AC-75, AC-76, AC-77, AC-78, AC-79, AC-80, AC-81, AC-82, AC-84.

### W-070 · Focused interview and intent confirmation UI

Milestone M6 · Owner: fullstack · Estimate: 3–5 engineering-days.

Dependencies: W-069, W-067. Modules: apps/dashboard.

Deliverable: Implement small adaptive question batches, unknown/correction paths, save/resume, visible blockers and concise exact-version read-back with explicit human confirmation.

Acceptance: AC-76, AC-77, AC-79, AC-83.

### W-071 · Human alignment qualification

Milestone M8 · Owner: fullstack · Estimate: 3–5 engineering-days.

Dependencies: W-069, W-070, W-057. Modules: tests/system, tests/recovery, fixtures.

Deliverable: Qualify contradiction/unknown/assumption cases, forged/stale approval, changed intent, answer races, portable resumption and mode/deadline non-bypass with UI evidence.

Acceptance: AC-75, AC-76, AC-77, AC-78, AC-79, AC-80, AC-81, AC-82, AC-83, AC-84.

### W-072 · Complete plan packets and independent peer gate

Milestone M3 · Owner: backend · Estimate: 5–8 engineering-days.

Dependencies: W-015, W-025, W-063, W-089. Modules: packages/contracts, packages/domain, apps/api, apps/worker.

Deliverable: Implement complete engineering packets, criteria/scenario/DoD validation, independent required peer assignments, exact-subject decisions, durable comments and execution binding and signed component/interface/data/slice structure outline; include ordered task checks and component/dependency reuse rationale.

Acceptance: AC-85, AC-86, AC-87, AC-88, AC-90, AC-91, AC-92, AC-93, AC-110, AC-138.

### W-073 · Layered engineering review experience

Milestone M3 · Owner: fullstack · Estimate: 4–6 engineering-days.

Dependencies: W-072, W-014. Modules: apps/dashboard.

Deliverable: Implement decision summary, structured review, full anchored detail, visible risks, criteria/test/DoD matrix, peer scope, durable notes and semantic revision diff with resume.

Acceptance: AC-86, AC-89, AC-91, AC-94.

### W-074 · Peer authority and review comprehension qualification

Milestone M8 · Owner: fullstack · Estimate: 3–5 engineering-days.

Dependencies: W-073, W-068, W-058. Modules: tests/system, tests/isolation, fixtures.

Deliverable: Qualify complete coverage, self/missing-peer rejection, blocker/approval races, mode and DoD rules, revision rework and engineer comprehension of seeded omissions.

Acceptance: AC-85, AC-86, AC-87, AC-88, AC-89, AC-90, AC-91, AC-92, AC-93, AC-94.

### W-075 · Factory tool server and durable proposals

Milestone M2 · Owner: execution · Estimate: 5–8 engineering-days.

Dependencies: W-019, W-020, W-021, W-022, W-025, W-090. Modules: apps/supervisor, packages/contracts.

Deliverable: Implement versioned factory tools with server-derived authority caps receipts and quiesced durable finalisation; retain 1.0 and add negotiated 1.1 source-bound feedback claims and required disclosure.

Acceptance: AC-95, AC-96, AC-97, AC-98, AC-99, AC-100, AC-136, AC-137, AC-142.

### W-076 · Claude factory-tool conformance

Milestone M3 · Owner: execution · Estimate: 3–5 engineering-days.

Dependencies: W-075, W-035, W-090. Modules: packages/harness/claude, tests/provider.

Deliverable: Register tools and hooks; prove role correction human requests feedback isolation and no interactive waits; qualify factory-owned settings required request content and both negotiated tool profiles.

Acceptance: AC-95, AC-96, AC-98, AC-99, AC-101, AC-129, AC-133, AC-135, AC-142.

### W-077 · Claude restricted-pod feasibility spike

Milestone M0 · Owner: platform · Estimate: 2–4 engineering-days.

Dependencies: W-001, W-002. Modules: spikes/claude, docs/integrations.

Deliverable: Pin Agent SDK and prove isolation gateway token placement process-tree stop usage settings session paths and tool transport.

Acceptance: AC-100, AC-101, AC-125.

### W-078 · Deployment effect-identity spike

Milestone M0 · Owner: execution · Estimate: 2–4 engineering-days.

Dependencies: W-001. Modules: spikes/deployment, docs/integrations.

Deliverable: Exercise actual MCP timeout-after-create lookup cleanup conditional identity and wrapper guarantees or keep that MCP provider disabled; Argo qualification is independent.

Acceptance: AC-102.

### W-079 · Crash-injection framework

Milestone M1 · Owner: platform · Estimate: 3–5 engineering-days.

Dependencies: W-007, W-010, W-011. Modules: tests/recovery, packages/test-support.

Deliverable: Build deterministic fault/concurrency hooks and extend each milestone; retain full M8 recovery drills.

Acceptance: AC-103.

### W-080 · PR completion and human review rework

Milestone M3 · Owner: backend · Estimate: 5–8 engineering-days.

Dependencies: W-030, W-031, W-015, W-076. Modules: packages/git, apps/worker, apps/api.

Deliverable: Implement completion policies reconciled Signals typed rework rounds human-head adoption handover abandonment and durable waits; preserve human adjudication for disputed review comments.

Acceptance: AC-104, AC-105, AC-106, AC-107, AC-108, AC-109, AC-140.

### W-081 · Application health evidence collection

Milestone M3 · Owner: backend · Estimate: 3–5 engineering-days.

Dependencies: W-008, W-013, W-030. Modules: packages/telemetry, packages/database, apps/api.

Deliverable: Collect cohort measurements with mature windows attribution denominators review outcomes and architecture findings; no automatic relaxation.

Acceptance: AC-112.

### W-082 · Oracle signatures shims and strength

Milestone M3 · Owner: execution · Estimate: 4–7 engineering-days.

Dependencies: W-022, W-072. Modules: packages/verification, packages/contracts.

Deliverable: Implement failure signatures human oracle binding reviewed shims mutation/family reporting and trivial-change rules; keep proposal path disabled in pilot; define the proposal graph/template and compiler rules as a postpilot deliverable and require separate conformance before enabling.

Acceptance: AC-115, AC-116, AC-117, AC-118, AC-120, AC-229.

### W-083 · Evidence classes tamper and scope

Milestone M3 · Owner: execution · Estimate: 4–7 engineering-days.

Dependencies: W-022, W-072. Modules: packages/verification, tests/isolation.

Deliverable: Separate feedback and evidence classes; isolate private checks; enforce protected paths and qualified semantic scope.

Acceptance: AC-119, AC-120, AC-121.

### W-084 · Portable handoff and context qualification

Milestone M3 · Owner: execution · Estimate: 3–5 engineering-days.

Dependencies: W-020, W-025, W-076, W-092. Modules: packages/context, packages/harness, tests/evals.

Deliverable: Qualify fresh restore native compatibility context experiments compaction neutral discovery and aggregate subagent budgets; bind fresh/resume to compiled role rules and skill admission.

Acceptance: AC-123, AC-124, AC-125, AC-134.

### W-085 · Reviewer admission and operational UI

Milestone M3 · Owner: fullstack · Estimate: 4–6 engineering-days.

Dependencies: W-088, W-030, W-073, W-080, W-081. Modules: apps/dashboard, packages/policy.

Deliverable: Show structure-first plans tiers PR targets rounds current-head approval evidence classes and health; reserve review capacity and bound slices; reveal rule blockers exception scope and disclosure counts with details on demand.

Acceptance: AC-110, AC-112, AC-126, AC-144.

### W-086 · Behavior release and canary evaluations

Milestone M3 · Owner: execution · Estimate: 4–6 engineering-days.

Dependencies: W-004, W-076, W-082, W-083, W-090. Modules: tests/evals, packages/policy, CI.

Deliverable: Version behavior configuration; compare held-out outcomes hacking false refusals review quality and cost before rollout; evaluate role delivery skill admission activation contamination and uncertainty.

Acceptance: AC-114, AC-122, AC-129, AC-145.

### W-087 · Evidence-backed gate mode policy

Milestone M7 · Owner: backend · Estimate: 4–6 engineering-days.

Dependencies: W-081, W-086, W-054. Modules: packages/policy, apps/dashboard.

Deliverable: Implement scoped human policy decisions samples degradation tightening and nonwaivable floors; no automatic relaxation.

Acceptance: AC-111, AC-112, AC-113, AC-114.

### W-088 · Minimum execution admission

Milestone M2 · Owner: backend · Estimate: 3–5 engineering-days.

Dependencies: W-013, W-019. Modules: packages/domain, apps/runner.

Deliverable: Reserve org provider task/child capacity transactionally with visible waits and explicit per-root/per-parent limits.

Acceptance: AC-128.

### W-089 · Standards resolution and scoped exceptions

Milestone M2 · Owner: backend · Estimate: 4–6 engineering-days.

Dependencies: W-007, W-012, W-021. Modules: packages/policy, packages/registry, packages/contracts.

Deliverable: Implement owned versioned rules deterministic resolution exact-scope human exceptions revocation and trusted check provenance using existing artifact and decision stores.

Acceptance: AC-130, AC-131, AC-132, AC-141.

### W-090 · Role compiler and third-party admission

Milestone M2 · Owner: execution · Estimate: 4–6 engineering-days.

Dependencies: W-025, W-021, W-089. Modules: packages/context, packages/harness, packages/policy.

Deliverable: Implement canonical role artifacts compiler profiles pinned content inventory admission revocation and synthetic delivery fixtures without candidate setting inheritance.

Acceptance: AC-133, AC-134, AC-135, AC-139.

### W-091 · Optional run forensics proposals

Milestone M4 · Owner: execution · Estimate: 2–4 engineering-days.

Dependencies: W-039, W-086. Modules: packages/knowledge, apps/worker.

Deliverable: Implement bounded retention-aware analysis of observable failed reworked and canary runs producing reviewed proposals only.

Acceptance: AC-143.

### W-092 · Structured portable handoff

Milestone M3 · Owner: execution · Estimate: 3–5 engineering-days.

Dependencies: W-020, W-075. Modules: packages/context, packages/contracts, packages/harness.

Deliverable: Add the versioned PortableHandoff schema to the contract generator; derive task status from tool receipts; append-only progress log; per-task local commits; fresh-session restore from the handoff alone; cover human_review/controller_evidence receipt-derived done_with_evidence and writer-nonblocking awaiting_evidence restore.

Acceptance: AC-146, AC-147, AC-245.

### W-093 · Pilot executable architecture rules

Milestone M3 · Owner: backend · Estimate: 3–5 engineering-days.

Dependencies: W-089, W-004. Modules: packages/policy, fixtures, CI.

Deliverable: Require owner-declared layering dependency and boundary checks before pilot enablement; reject candidate amendments to applicable rules; report violations to application health.

Acceptance: AC-148, AC-149.

### W-094 · Pilot engineer-parity evidence

Milestone M3 · Owner: execution · Estimate: 3–4 engineering-days.

Dependencies: W-075, W-021, W-008, W-115. Modules: packages/telemetry, packages/harness, packages/contracts.

Deliverable: Read-only scoped CI and error-tracking evidence adapters for get_evidence with redaction provenance and access records; deny mutations; implement GetEvidenceToolInputV12 bounded template queries in factory tools 1.2.0 with INT-16 grants.

Acceptance: AC-150, AC-241.

### W-095 · Cohort stop-the-line

Milestone M3 · Owner: backend · Estimate: 3–4 engineering-days.

Dependencies: W-088, W-086, W-083. Modules: packages/policy, apps/runner, apps/dashboard, packages/contracts, apps/api.

Deliverable: Suspend cohort admission and hold in-flight publication on integrity signals under the pre-authorized degradation policy; human clearing; operations view through reviewed policy/configuration releases with bound policy-owner authority.

Acceptance: AC-151.

### W-096 · Pre-pilot baseline measurement

Milestone M1 · Owner: platform · Estimate: 2–3 engineering-days.

Dependencies: W-001. Modules: docs/measurement, tests/evals.

Deliverable: Record per-application pre-factory delivery baselines with definitions windows denominators and gaps; block pilot enablement without one.

Acceptance: AC-152.

### W-097 · Commodity adoption spikes

Milestone M0 · Owner: platform · Estimate: 4–6 engineering-days.

Dependencies: W-001, W-005. Modules: docs/adr, deploy.

Deliverable: Evaluate agent-sandbox, in-toto/SLSA attestation and OPA or Cedar against chapter 22 exit criteria; record ADR-21 outcomes with fallbacks and platform-owner sign-off on version pinning and maturity.

Acceptance: AC-153, AC-154, AC-155.

### W-098 · Registry sources and Git descriptors

Milestone M2 · Owner: backend · Estimate: 3–5 engineering-days.

Dependencies: W-006, W-007, W-089. Modules: packages/registry, packages/contracts.

Deliverable: Implement import-time RegistrySource snapshots with per-field provenance, a field-level authority map with conflict findings and the Backstage-compatible GitDescriptorSource with factory extension section.

Acceptance: AC-156, AC-157.

### W-099 · Agent-assisted onboarding and ownership gate

Milestone M3 · Owner: execution · Estimate: 4–6 engineering-days.

Dependencies: W-098, W-018, W-075, W-115, W-116, W-119. Modules: packages/registry, apps/worker, apps/dashboard.

Deliverable: Draft definitions with execution-verified build and test commands, manifest dependencies and owner hints; owner confirmation before commit and import; confirmed ownership as eligibility gate; require a human-supplied provisional nomination classification before allocation and eligible providers under closed INT-14.

Acceptance: AC-158, AC-159, AC-261.

### W-100 · Change-class readiness assessment

Milestone M3 · Owner: backend · Estimate: 3–5 engineering-days.

Dependencies: W-099, W-089. Modules: packages/registry, packages/policy.

Deliverable: Assess readiness per application and change class with source commit expiry and evidence; enforce eligibility at admission; request preparation work as maintenance tasks.

Acceptance: AC-160.

### W-101 · Change recipes and deterministic executor

Milestone M4 · Owner: execution · Estimate: 4–6 engineering-days.

Dependencies: W-075, W-022, W-086, W-100, W-080, W-033. Modules: packages/recipes, packages/harness, packages/contracts.

Deliverable: Versioned recipe contract with preconditions mappings examples scope verification and typed outcomes; deterministic_transform stage kind with evidence parity; evidence-bound no-change delivery_complete and terminal succeeded without publication; recipe behavior-release evaluation.

Acceptance: AC-161, AC-162, AC-250.

### W-102 · Campaign initiatives

Milestone M4 · Owner: backend · Estimate: 5–8 engineering-days.

Dependencies: W-101, W-088, W-095, W-080, W-085. Modules: apps/worker, packages/domain, apps/dashboard, packages/contracts, apps/api.

Deliverable: Pinned target sets, campaign-level peer sign-off, canary and bounded waves, per-owner-group review budgets and deferral, pause thresholds, targeted re-runs, PR refresh and campaign view; CampaignManifest reviewBudgetsByOwner and TaskView campaign state use parent-task controls and decisions; require primary peer plus every target owner/specialist and reconfirm all peers on retargeting.

Acceptance: AC-163, AC-164, AC-165, AC-244.

### W-103 · Campaign pilot

Milestone M4 · Owner: platform · Estimate: 3–4 engineering-days.

Dependencies: W-102, W-096. Modules: tests/system.

Deliverable: Run one recipe across a handful of similar repositories and report accepted outcomes review time rework and cost against the baseline.

Acceptance: AC-166.

### W-104 · Earned automatic merge action

Milestone M7 · Owner: backend · Estimate: 2–4 engineering-days.

Dependencies: W-087, W-102. Modules: packages/policy.

Deliverable: In human mode automate the merge action only after current-head human PR approval and all gates for mature deterministic change classes; degradation reverts to manual merge.

Acceptance: AC-167.

### W-105 · Role-scoped tool profiles and missing-context

Milestone M3 · Owner: execution · Estimate: 2–4 engineering-days.

Dependencies: W-075, W-090. Modules: packages/harness, packages/contracts.

Deliverable: Compile profiles keyed on role stageKind and workType/recipe; implement SubmitResultToolInputV12 with untrusted missingContext in factory tools 1.2.0; retain 1.1.0/1.0.0 manifests and negotiate explicitly at admission.

Acceptance: AC-168, AC-169, AC-240.

### W-106 · Interactive takeover journey

Milestone M4 · Owner: fullstack · Estimate: 3–4 engineering-days.

Dependencies: W-019, W-020, W-014. Modules: apps/dashboard, apps/runner, packages/contracts, apps/api.

Deliverable: Explicit take-over and hand-back actions with checkpoint, epoch transfer and re-evaluation of returned source through required EpochTransfer command payloads.

Acceptance: AC-170.

### W-107 · First real task: reproducible bug

Milestone M3 · Owner: fullstack · Estimate: 2–4 engineering-days.

Dependencies: W-028, W-030, W-099, W-093, W-094, W-096, W-115, W-116, W-119, W-080, W-100, W-109, W-111, W-112. Modules: tests/system.

Deliverable: Run one reproducible machine-reported bug in one onboarded application end to end with human plan and oracle review, red lock green, independent verification and a reviewed PR; require current bug_fix readiness and provider eligibility under closed INT-14; derive DiagnosisManifest from the chapter 08 hypothesis table until W-033 adds the ledger.

Acceptance: AC-172.

### W-108 · Executed contract checks in CI

Milestone M1 · Owner: platform · Estimate: 1–2 engineering-days.

Dependencies: W-003, W-006. Modules: CI, packages/database, packages/contracts.

Deliverable: Apply the reference DDL to PostgreSQL 18 with tenant-isolation and column-grant smoke tests under factory_runtime including the complete tool receipt lifecycle and rejected identity/acceptance mutations; compile TypeScript contracts in strict mode on every revision.

Acceptance: AC-171.

### W-109 · Discovery context manifest

Milestone M3 · Owner: execution · Estimate: 2–4 engineering-days.

Dependencies: W-025, W-072. Modules: packages/context, apps/worker.

Deliverable: Record sources consulted, prior matches, blocking and nonblocking gaps and assumptions in discovery output; show it in the plan packet current_state; keep scope_accepted unmet on blocking gaps.

Acceptance: AC-173, AC-227.

### W-110 · Tracker and code-history evidence

Milestone M3 · Owner: execution · Estimate: 3–4 engineering-days.

Dependencies: W-094, W-030. Modules: packages/telemetry, packages/harness, packages/contracts.

Deliverable: Read-only scoped issue-tracker and code-host history adapters for get_evidence with redaction provenance and access records; optional documentation adapter; no tracker writes through evidence tools; implement GetEvidenceToolInputV12 bounded template queries in factory tools 1.2.0 with INT-16 grants; close INT-13 pilot tracker and code-history access facts.

Acceptance: AC-174, AC-241.

### W-111 · Failure signatures and prior-incident matching

Milestone M3 · Owner: backend · Estimate: 4–6 engineering-days.

Dependencies: W-028, W-094. Modules: packages/registry, packages/context, packages/contracts.

Deliverable: Versioned signature normalizer from reproduction, error-tracking and CI evidence; structured-key then text matching with authorization; labelled hypotheses in discovery; regression-of-prior-fix classification.

Acceptance: AC-175, AC-176.

### W-112 · Regression memory and root-cause categories

Milestone M3 · Owner: backend · Estimate: 2–4 engineering-days.

Dependencies: W-028, W-083. Modules: packages/verification, packages/policy.

Deliverable: Require permanent regression tests for verified fixes with owner exceptions; protect incident-linked tests; versioned category taxonomy with reviewer confirmation.

Acceptance: AC-177, AC-178, AC-227.

### W-113 · Variant analysis

Milestone M4 · Owner: execution · Estimate: 3–5 engineering-days.

Dependencies: W-111, W-101. Modules: packages/verification, apps/worker.

Deliverable: Budget-capped read-only pattern search across authorized scopes with classified evidence; route confirmed variants to linked tasks or recipe proposals.

Acceptance: AC-179.

### W-114 · Recurrence escalation and match usefulness

Milestone M4 · Owner: backend · Estimate: 3–4 engineering-days.

Dependencies: W-111, W-112, W-081, W-089. Modules: packages/policy, apps/dashboard.

Deliverable: Count confirmed categories per scope and window; raise owner-decided systemic proposals; measure prior-match accuracy and expire misleading lessons.

Acceptance: AC-180, AC-181.

### W-115 · Data classification and provider eligibility

Milestone M2 · Owner: platform · Estimate: 3–5 engineering-days.

Dependencies: W-098, W-021. Modules: packages/policy, packages/registry, deploy, packages/contracts, apps/runner.

Deliverable: Classification fields on descriptors ApplicationDefinition/ApplicationRepository and StageInput in domain 2.0; effective classification and eligibility decision pinned in InputBinding/allocation; runner mints scoped credentials from that decision for the external INT-08 gateway; enforce at admission and every request; populate provider eligibility entries from closed INT-14.

Acceptance: AC-182, AC-183, AC-247.

### W-116 · Candidate secret scanning

Milestone M2 · Owner: execution · Estimate: 2–3 engineering-days.

Dependencies: W-020, W-022. Modules: packages/verification, packages/workspace.

Deliverable: Deterministic secret scan of candidate diffs before checkpoint publication push and delivery; redacted protected findings; owner exceptions only.

Acceptance: AC-184.

### W-117 · Security work intake and embargo

Milestone M3 · Owner: backend · Estimate: 3–5 engineering-days.

Dependencies: W-008, W-028, W-111. Modules: apps/api, packages/policy, apps/dashboard, packages/contracts, packages/database, packages/git.

Deliverable: Security task severity source deadlines priority and incident fields; group membership and restrictive task/derived-record embargo visibility; policy-assigned isolated confidential publication target with provider-enforced reader subset checked before every push; exact-subject human embargo lift and no ordinary-repository fallback (INT-15); close INT-15 source severity and confidential-target enforcement facts before enablement.

Acceptance: AC-185, AC-186, AC-242, AC-246, AC-248.

### W-118 · Licence policy checks

Milestone M3 · Owner: execution · Estimate: 2–3 engineering-days.

Dependencies: W-089, W-083. Modules: packages/verification, packages/policy.

Deliverable: Versioned licence policy for new dependencies at plan approval and verification; optional reproduction scanning for generated code.

Acceptance: AC-187.

### W-119 · Organization-wide emergency stop

Milestone M2 · Owner: platform · Estimate: 2–3 engineering-days.

Dependencies: W-088, W-021, W-023. Modules: apps/runner, packages/policy, apps/dashboard, packages/contracts, apps/api.

Deliverable: Audited operator control halting admission publication and delivery with cancellation and reconciliation; human clearing; drill through the internal OperatorControlPlane with durable revision-bound EmergencyStopDecision artifacts.

Acceptance: AC-188, AC-217.

### W-120 · Authorship trailers

Milestone M3 · Owner: execution · Estimate: 1–2 engineering-days.

Dependencies: W-030, W-081. Modules: apps/runner, packages/workspace, packages/git.

Deliverable: Trusted runner/checkpoint authorship trailers from server records before commit IDs freeze; Git adapter validates without rewriting; squash-safe attribution used by application health.

Acceptance: AC-189.

### W-121 · Decision notifications and response targets

Milestone M3 · Owner: fullstack · Estimate: 3–4 engineering-days.

Dependencies: W-015, W-014. Modules: apps/api, apps/dashboard, packages/policy.

Deliverable: Channel routing reminders response targets escalation to backup deciders and waiting-on-humans measures without auto-approval.

Acceptance: AC-190, AC-191.

### W-122 · Hypothesis ledger and timeboxes

Milestone M3 · Owner: execution · Estimate: 3–5 engineering-days.

Dependencies: W-075, W-105. Modules: packages/harness, packages/contracts, apps/runner.

Deliverable: Implement factory tools 1.2.0 ledger open record close extend and reopen schemas; retain factory-tools.v1.1.schema.json and v1.0; StageInput/RolePackage negotiate explicitly and investigation-discipline/1.0 requires 1.2.0; derive SQL tool_name CHECK from manifest; ledger state is ordered receipts/artifacts with server-owned counters and capped extensions.

Acceptance: AC-192, AC-193, AC-243.

### W-123 · Stall detection and fresh-eyes checkpoints

Milestone M3 · Owner: execution · Estimate: 3–4 engineering-days.

Dependencies: W-122, W-086. Modules: apps/runner, packages/context.

Deliverable: Deterministic stall signals with reflection then handoff; transcript-free fresh reviewer at extension stall and pre-submission points.

Acceptance: AC-194, AC-195.

### W-124 · Breadth-first probes escalation and dead ends

Milestone M3 · Owner: execution · Estimate: 3–4 engineering-days.

Dependencies: W-122, W-111. Modules: packages/harness, packages/registry.

Deliverable: Bounded parallel probes for top hypotheses, early request_decision escalation, failed-hypothesis records linked to signatures with evidence-gated reopening; implement ReopenHypothesisToolInput with non-empty evidence new to the prior ruling and append-only history.

Acceptance: AC-196, AC-197, AC-243.

### W-125 · Rabbit-hole evaluation

Milestone M3 · Owner: execution · Estimate: 2–4 engineering-days.

Dependencies: W-123, W-086, W-004, W-111. Modules: tests/evals.

Deliverable: Decoy and look-alike bug corpus with first-hypothesis accuracy wasted budget and stall extension and escalation metrics per behavior release.

Acceptance: AC-198.

### W-126 · Urgent hotfix path

Milestone M7 · Owner: backend · Estimate: 3–4 engineering-days.

Dependencies: W-107, W-121, W-117, W-042, W-052, W-054. Modules: packages/policy, apps/worker, apps/dashboard, packages/contracts.

Deliverable: Incident tasks with on-call routing, concise complete plan and one on-call generalist plus every required specialist peer sign-off with urgent response targets, recorded mitigations through authorized environment operations, automatic follow-up tasks and incident learning; qualify urgent-mitigation/1.0 outside bug_fix 3.0.0 with reconciled operation recovery evidence and incomplete mitigated outcome linked to the required follow-up.

Acceptance: AC-199, AC-200, AC-201, AC-249, AC-251.

### W-127 · Factory self-work onboarding

Milestone M4 · Owner: platform · Estimate: 2–3 engineering-days.

Dependencies: W-033, W-099, W-083. Modules: packages/policy, deploy.

Deliverable: Onboard the factory repository with allowed change classes and protected trusted components; keep deployment in the factory release pipeline.

Acceptance: AC-202.

### W-128 · Storage constraints and runtime grant qualification

Milestone M1 · Owner: backend · Estimate: 2–3 engineering-days.

Dependencies: W-006, W-007, W-108. Modules: packages/database, packages/artifacts, tests/system.

Deliverable: Implement and execute column-limited grants immutable tool-call guards commit-ID constraints upload bindings projection hashes and decision provenance with forward-migration coverage.

Acceptance: AC-203, AC-204, AC-205, AC-207.

### W-129 · Operational storage and ownership projections

Milestone M4 · Owner: backend · Estimate: 2–4 engineering-days.

Dependencies: W-017, W-106, W-111, W-128. Modules: packages/database, apps/api, apps/runner, packages/registry.

Deliverable: Persist fenced checkpoint child Jobs audited task owner/holder commands structured failure signatures atomic PR review projections stack predecessors and complete operational fields.

Acceptance: AC-175, AC-206, AC-208, AC-209.

### W-130 · API state and metadata contract consistency

Milestone M1 · Owner: backend · Estimate: 2–4 engineering-days.

Dependencies: W-005, W-007, W-015, W-108. Modules: packages/contracts, packages/database, apps/api, tests/system.

Deliverable: Implement typed receipts artifact links registration metadata stage supersession command-state guards decision actions SSE recovery and readiness status codes; retain historical readers and qualify API description 2.4.0.

Acceptance: AC-210, AC-211, AC-212, AC-213, AC-214, AC-215, AC-216.

### W-131 · Human controls and owner-group budgets

Milestone M4 · Owner: fullstack · Estimate: 2–4 engineering-days.

Dependencies: W-130, W-102, W-106, W-117, W-119. Modules: packages/contracts, packages/policy, apps/api, apps/dashboard, tests/system.

Deliverable: Qualify task-bound campaign owner-confirmation and embargo decisions epoch-transfer payloads policy-owner authority and multi-owner review budget accounting with application-only limit reductions.

Acceptance: AC-218, AC-219.

### W-132 · Workflow dependency and review conformance

Milestone M3 · Owner: backend · Estimate: 2–4 engineering-days.

Dependencies: W-022, W-063, W-076, W-079, W-013. Modules: packages/domain, packages/policy, apps/worker, tests/system.

Deliverable: Enforce current passed dependency runs oracle-before-implementation author return paths default human floors (D5 extension in W-141) complete risk triggers and resolved stage caps with negative fixtures.

Acceptance: AC-221, AC-222, AC-223, AC-224, AC-225, AC-226.

### W-133 · Retained bootstrap root adoption

Milestone M4 · Owner: execution · Estimate: 1–2 engineering-days.

Dependencies: W-065, W-132. Modules: packages/git, packages/workspace, packages/contracts, tests/recovery.

Deliverable: Support canonical empty-root adoption only with verified retained bootstrap provenance owner approval and scoped plan while preserving path and no-overwrite checks.

Acceptance: AC-220.

### W-134 · Runner trust-boundary conformance

Milestone M2 · Owner: execution · Estimate: 2–4 engineering-days.

Dependencies: W-020, W-021, W-024, W-075. Modules: apps/runner, packages/workspace, packages/harness, packages/contracts, tests/isolation.

Deliverable: Qualify config-inert trusted snapshots diagnostic adapter results checkpoint-only finalization input/spec binding quarantine outcomes Job ownership and 15-second termination plus additional admission and scoped runner-API authorization.

Acceptance: AC-230, AC-231, AC-232, AC-233, AC-236.

### W-135 · Interface snapshots and evidence metadata

Milestone M4 · Owner: execution · Estimate: 2–3 engineering-days.

Dependencies: W-037, W-039, W-031, W-134. Modules: packages/registry, packages/contracts, packages/database, packages/context.

Deliverable: Import InterfaceDefinition documents and pin every provided/consumed contract; preserve finding consequence/confidence knowledge disputes usage provenance allocation leases and the documented locations of context checkpoint and operation metadata.

Acceptance: AC-234, AC-235.

### W-136 · Factory tools 1.2 and handoff conformance

Milestone M3 · Owner: execution · Estimate: 3–5 engineering-days.

Dependencies: W-092, W-105, W-110, W-122, W-124. Modules: packages/contracts, packages/harness, packages/context, apps/runner, tests/evals.

Deliverable: Qualify version negotiation with frozen 1.0/1.1 manifests bounded live queries supervisor-bound profiles missingContext ledger extension/reopen and receipt-derived non-executable handoffs.

Acceptance: AC-240, AC-241, AC-243, AC-245.

### W-137 · Classified admission and embargo storage

Milestone M3 · Owner: backend · Estimate: 3–5 engineering-days.

Dependencies: W-006, W-115, W-117. Modules: packages/contracts, packages/database, packages/policy, apps/api, apps/runner, tests/isolation.

Deliverable: Qualify incident/security admission metadata derived changeClass classification bindings gateway credentials and restrictive embargo visibility including derived artifacts logs knowledge and auxiliary envelopes; prove forward migrations and membership authority.

Acceptance: AC-242, AC-246, AC-247.

### W-138 · Confidential delivery and campaign approval conformance

Milestone M7 · Owner: backend · Estimate: 2–4 engineering-days.

Dependencies: W-102, W-126, W-137, W-052. Modules: packages/git, packages/policy, apps/worker, tests/system.

Deliverable: Qualify target-owner coverage and retargeting plus isolated confidential publication with every-push reader enforcement and the versioned incomplete mitigation closure path; preserve human floors for excluded paths and human-mode campaigns.

Acceptance: AC-244, AC-248, AC-249.

### W-139 · Argo CD branch-preview adapter and conformance

Milestone M5 · Owner: execution · Estimate: 5–8 engineering-days.

Dependencies: W-005, W-007, W-030, W-037, W-088, W-115, W-117, W-140. Modules: packages/deployment, packages/git, deploy/helm, tests/system.

Deliverable: Implement chapter 10 ApplicationSet PR previews: exact head/digests; scoped Git label/draft and repository identity admission; durable current-plan generations and public queued status; draft-first verification/rework; webhook/polling lookup supersession authenticated routing caps and full cleanup; close ADR-32 and INT-17 platform repo label DNS cert registry auth capacity and credential facts; qualify common real-provider conformance and Argo-specific scenarios before support; preserve merge-to-dev and production paths.

Acceptance: AC-39, AC-40, AC-41, AC-42, AC-43, AC-45, AC-56, AC-262, AC-263, AC-264, AC-265, AC-266, AC-267, AC-268, AC-270, AC-271, AC-272, AC-273, AC-274, AC-275, AC-276, AC-277, AC-278.

### W-140 · Preview namespace and data provisioning

Milestone M5 · Owner: platform · Estimate: 3–5 engineering-days.

Dependencies: W-005, W-007, W-017, W-037, W-115, W-117. Modules: packages/deployment, deploy/helm, tests/isolation.

Deliverable: Provide owned namespaces NetworkPolicy quotas LimitRange Pod Security external secrets and isolated per-preview database/credentials; order idempotent migration and seed sync-hook Jobs; qualify classification confidentiality and complete resource data volume cleanup including CreateNamespace-only namespaces; close INT-17 data mechanism and isolation facts.

Acceptance: AC-264, AC-265, AC-269, AC-270.

### W-141 · Application AI review authority and panels

Milestone M7 · Owner: backend · Estimate: 5–8 engineering-days.

Dependencies: W-087, W-080, W-072, W-069, W-142, W-137, W-144. Modules: packages/policy, packages/contracts, packages/database, apps/worker.

Deliverable: Implement D5 joint application decisions scoped live resolver immutable AI decisions independent diverse unanimous panels specialist and adversarial content exact bindings human fallback and versioned ai-review/1.0 templates including the 2.0.0 design templates; close ADR-33/INT-18 authority and model facts without efficacy claims; The runtime implementation MUST pass an adversarial negative corpus covering provenance laundering; scope and embargo/hotfix/production; identity and fork; chronology; nested outputs; empty refs; stale qualification; exported views overriding the trusted task snapshot; nested bundles reviving revoked or stopped authority; provider review observations presented as human approval; production mitigation without human release; release decisions without an identified decider, with every expected-reject case rejected and every expected-accept control passing. Static reference predicates do not prove runtime enforcement..

Acceptance: AC-224, AC-280, AC-282, AC-283, AC-284, AC-285, AC-286, AC-287, AC-288, AC-289, AC-290, AC-291, AC-292, AC-300, AC-301, AC-319. The runtime implementation MUST pass an adversarial negative corpus covering provenance laundering; scope and embargo/hotfix/production; identity and fork; chronology; nested outputs; empty refs; stale qualification; exported views overriding the trusted task snapshot; nested bundles reviving revoked or stopped authority; provider review observations presented as human approval; production mitigation without human release; release decisions without an identified decider, with every expected-reject case rejected and every expected-accept control passing. Static reference predicates do not prove runtime enforcement.

### W-142 · Reviewer-quality corpus qualification

Milestone M7 · Owner: execution · Estimate: 3–5 engineering-days.

Dependencies: W-087, W-086, W-090. Modules: tests/evals, packages/policy.

Deliverable: Define versioned clean and seeded-defect plans/PRs plus applicable intent oracle and specialist cases; qualify each reviewer and independent adjudicator configuration against predeclared catch and false-approval thresholds with denominators; close INT-18 corpus/family facts and require human establishment after changes.

Acceptance: AC-281, AC-282, AC-284, AC-286, AC-287, AC-289, AC-302.

### W-143 · AI-reviewed dev merge audit and visibility

Milestone M7 · Owner: fullstack · Estimate: 4–7 engineering-days.

Dependencies: W-141, W-087, W-080, W-030, W-042, W-045, W-085, W-119. Modules: packages/git, packages/policy, packages/database, apps/api, apps/dashboard, tests/system.

Deliverable: Qualify factory-identity dev-only merge after exact-head checks and previews; preserve human production authority; implement hidden pre-execution sample later human audits ledger thresholds automatic human/manual fallback and honest mode provenance UI/API/export; close ADR-33/INT-18 branch audit and degradation facts; The runtime implementation MUST pass an adversarial negative corpus covering provenance laundering; scope and embargo/hotfix/production; identity and fork; chronology; nested outputs; empty refs; stale qualification; exported views overriding the trusted task snapshot; nested bundles reviving revoked or stopped authority; provider review observations presented as human approval; production mitigation without human release; release decisions without an identified decider, with every expected-reject case rejected and every expected-accept control passing. Static reference predicates do not prove runtime enforcement..

Acceptance: AC-54, AC-293, AC-294, AC-295, AC-296, AC-297, AC-298, AC-299, AC-302, AC-303. The runtime implementation MUST pass an adversarial negative corpus covering provenance laundering; scope and embargo/hotfix/production; identity and fork; chronology; nested outputs; empty refs; stale qualification; exported views overriding the trusted task snapshot; nested bundles reviving revoked or stopped authority; provider review observations presented as human approval; production mitigation without human release; release decisions without an identified decider, with every expected-reject case rejected and every expected-accept control passing. Static reference predicates do not prove runtime enforcement.

### W-144 · Design-only delivery and build-from-design binding

Milestone M6 · Owner: fullstack · Estimate: 6–9 engineering-days.

Dependencies: W-013, W-030, W-063, W-069, W-072, W-073, W-080, W-089, W-117, W-137. Modules: packages/contracts, packages/domain, packages/database, packages/git, apps/api, apps/worker, apps/dashboard, tests/system.

Deliverable: Implement the design delivery scope and design-delivery/1.0 templates with complete peer-reviewed packets deterministic Markdown rendering design PR or report delivery honest design_approved outcomes design budget class confidential/classified targets and current-design build bindings that reuse exact approvals or replan affected sections in human mode; ai-review design templates are enabled only through W-141; close ADR-34 without claiming runtime qualification.

Acceptance: AC-304, AC-305, AC-306, AC-307, AC-308, AC-309, AC-310, AC-311, AC-312, AC-313, AC-314, AC-315, AC-316, AC-317, AC-318.

<!-- BACKLOG_END -->

## First implementation week

Target the W-001 provider/access inventory and W-002 monorepo/toolchain in the first week, start W-003 contracts as dependencies permit, and begin the deployment and harness feasibility spikes where staff and access permit. A reproducible local stack with a task accepted durably into Temporal is the end-of-M1 checkpoint (W-011), subject to the stated effort ranges and dependency chain. If access prevents a real-provider spike, preserve a precise blocked integration item and continue the deterministic control/runner work.

## Later roadmap

Hermetic profile qualification, broader mutation/fault-injection coverage, advanced cross-service release scheduling, registry extraction and measured adaptive harness routing follow v1. Their interfaces are already allowed for; do not advertise them until qualified. Avoid an open-ended generic workflow DSL, custom coding harness or vector database as prerequisites for the initial factory.
