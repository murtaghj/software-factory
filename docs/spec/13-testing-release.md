# 13 — Acceptance programme and release qualification

## Test strategy

Tests establish behavior at the boundaries where failures matter. Do not write only mocks that restate implementation branches. Use deterministic fake providers for fault timing, real PostgreSQL for transactions/leases, Temporal's test environment for replay/timers, real Git repositories for ref/worktree behavior, Kubernetes for allocation/isolation recovery and selected provider sandboxes for integration qualification.

The [acceptance catalogue](acceptance.json) supplies named Given/When/Then scenarios. Each backlog item names the relevant acceptance IDs. Passing unit tests does not substitute for provider conformance or operational restore evidence.

Trusted checkpoint qualification MUST plant malicious repository-local fsmonitor/filter configuration, attributes and hooks, then snapshot after whole-pod stop: no candidate-specified program may run and the digest MUST match raw object/file bytes (AC-230). Runner qualification also rejects authoring identities at StageFinalizer, checks Job ownership/spec bindings and proves admission plus runner-API authorization (AC-231–AC-233, AC-236). These are required qualification cases, not yet proven runtime results.

## Test layers

| Layer | Required coverage | Execution cadence |
| --- | --- | --- |
| Contract | Valid/invalid schemas, unknown fields/versions, provider normalization, API compatibility and event envelopes | Every PR. |
| Domain | Gate binding, invalidation graph, policy escalation, budgets, state transitions, finding routing and work-type completion | Every PR. |
| Persistence | Unique identities, tenant FKs/RLS, concurrent claims, outbox, command dedupe, budget reservations and migrations | Every PR with PostgreSQL. |
| Workflow | Timers, retries, cancellation, command races, child failure, Continue-As-New, versioned replay | Every worker/domain PR. |
| Runner/Git | Duplicate supervisor, stale epoch, checkpoints, binary/untracked restore, conflicts, moving base and uncertain PR push | Every runner/Git PR. |
| Isolation | Capability denial, token/credential scope, source/test integrity, artifact access and network enforcement | Each execution image/profile release. |
| Provider | Real selected harness/Git/deployment-provider behavior, authentication, status, declared cancellation and unknown outcome recovery | Staging qualification and adapter upgrade. |
| End to end | All work types and cross-vendor continuation against small fixture apps | Nightly and release candidate. |
| Recovery/load | Worker/pod/DB/provider outage, backup restore, event load, admission fairness and cleanup | Before launch and scheduled drills. |

## Fixture applications and golden tasks

Build a small but realistic fixture system: web client, orders API, inventory API, event worker and PostgreSQL, with trace propagation and controllable failure injection. Each fixture release pins source/images/contracts/seed data. Store hidden acceptance checks outside the author workspace.

| Work type | Positive task | Negative or adversarial task |
| --- | --- | --- |
| Existing-project feature | Add cancellation with audit history and API/UI scenarios. | Agent implements only happy path, omitting authorization and repeated cancellation. |
| Bug | Repair duplicate reservation after retry; baseline intended red and same package green. | Baseline only fails because the DB is unavailable, or candidate edits copied tests. |
| Refactor | Extract pricing logic while preserving outputs/errors/side effects. | Characterization passes but intended structural change is absent or a hidden contract changes. |
| Maintenance | Upgrade a dependency across the declared runtime/consumer matrix. | Install/build passes but one supported consumer fails. |
| Performance | Improve a predeclared workload target with correctness guardrails. | Best run looks faster but representative distribution/correctness regresses. |
| Platform | Expand/migrate/contract a schema with mixed-version compatibility and recovery. | Rollback code cannot read migrated data, or provider apply outcome is unknown. |
| Documentation | Update API examples and validate against the pinned contract/version. | Unsupported claim or nonexecuting example is presented as verified. |
| Investigation | Compare two causal hypotheses and deliver reviewed evidence with limitations. | Report confidently blames a downstream API despite invalid upstream input. |

Add greenfield fixtures for both a new remote repository and a new independently owned component in an existing monorepo. Each needs a positive accepted user journey and a negative case where only the scaffold/health endpoint works. Include bootstrap timeout/reconciliation, path escape, draft revision races, cancelled repository retention and mandatory-child integration failure. AC-61–AC-74 specify these obligations.

Use at least these 20 representative tasks before full v1 release (the original 16 plus positive/negative cases for both greenfield fixtures). Keep criteria independent of the model's preferred code style. Human raters evaluate outcome correctness, evidence quality, scope adherence and review usefulness using a written rubric; disagreement is adjudicated with evidence. Do not optimize only for whether a PR was produced.

The corpus includes look-alike incidents (same signature, different root cause) to test that prior matches do not anchor diagnosis, and a recurring-category scenario that should raise a systemic proposal. See [chapter 24](24-context-gathering-incident-learning.md).

The corpus includes decoy bugs with a tempting wrong explanation; behavior releases report first-hypothesis accuracy, budget spent on ruled-out hypotheses, and stall, extension and escalation rates. The emergency stop is drilled before the pilot. See [chapter 26](26-investigation-discipline.md) and [chapter 25](25-data-security-operational-safeguards.md).

## Interview qualification

Greenfield fixtures must include vague initial requests, contradictory stakeholders, a changed answer during confirmation, a low-impact accepted assumption, a blocking unknown, fabricated approval and a resumed interview under another harness. Prove that neither a fixed round count, confident summary, fast/one mode nor an elapsed deadline unlocks architecture/bootstrap. Check that unchanged intent does not trigger repeated approval through routine retries, and changed intent invalidates affected design/evidence. AC-75–AC-84 and W-069–W-071 are full-v1 obligations; their human interaction fixtures are distinct from application test success.

## Peer plan and review-experience qualification

Require complete packet/section applicability, criteria-scenario-DoD traceability and exact approved scope before implementation. Negative fixtures omit a requirement/test, hide a high-risk side effect in detail, claim a planned test passed, assign an author as their own peer, miss a specialist, race a blocker against approval or change an approved threshold. Verify all modes preserve the gate and that source/subject changes cannot be concealed by an unchanged summary. AC-85–AC-94 cover these requirements.

Design-only qualification (W-144, AC-304–AC-318) adds fixtures that insert an implementation or verification stage into a design graph, drop a design gate in fast/one mode, claim implementation or verification in a design_approved outcome, reuse a design after source/rules/policy/intent/scope drift or expiry, move approvals to a changed packet, and deliver embargoed or higher-classified content to an ordinary target. Static fixtures in `examples/design/` do not prove rendering, Git delivery or currency resolution.

Run representative engineers through interrupted and resumed reviews. Measure whether they quickly identify the requested decision/impact/blockers and can locate tests, completion criteria and underlying evidence. Include seeded meaningful omissions to assess comprehension. Thirty-second orientation and a few minutes to locate the core reasoning are interface targets, not deadlines for signing a complex plan.

## Fault injection principles

Build the fault-injection framework in M1 alongside outbox/dispatcher/state progression, extending it at each new boundary; W-060 remains the full M8 operational qualification. Inject crashes before and after every external side-effect boundary: intent persisted, provider called, resource created, response received, DB updated, artifact finalized, Activity result returned and workflow projected. Verify that restart either attaches/reconciles or stops with an explicit unknown state. Exactly-once effects are established by provider-supported identity/preconditions and reconciliation, not inferred from single process execution.

Race tests run two controllers/supervisors/commands concurrently. Required races include duplicate task create, same-run/different-spec conflict, lease expiry with live old process, new requirements versus arriving result, approval versus new candidate, budget reservations by children, target branch movement versus merge and cancel versus completed deploy.

## Release gates

Pilot: contract/data/workflow/runner recovery suite; existing-target feature, reproducible machine-reported bug and investigation through report/PR with a single Claude runtime across every required stage; independent checks; real selected harness and Git qualification; scoped identities and audit. No production application release.

Portable pilot: second harness conformance and clean-pod handoff; native-resume claims tested separately; old worker build/history replay and source restore demonstrated.

Preview release: at least one real DeploymentProvider (W-041 MCP or W-139 Argo with W-140 data) passes the same applicable conformance suite; every enabled provider is independently qualified. Exercise unknown submission and cleanup failures, exact revision/image inventory, isolated fixtures and behavioral checks, preview expiry and capacity ownership. Argo additionally requires AC-262–AC-272 and INT-17 closure. Static checks or an unqualified alternative cannot enable previews; production qualification remains separate.

Full v1: all eight work types and all three project journeys, including qualified new-repository and monorepo greenfield bootstrap; integrated multi-repository candidate; selected production rollout/recovery qualified for the first onboarded app; disaster restore; load/SLO measurements; documented runbooks and owners. Unsupported production providers remain disabled even when the rest of the factory launches.

Rules and role-content acceptance scenarios cover deterministic content delivery, mid-session settings isolation, source-bound claims, expired/revoked exceptions, skill intake and paired evaluation limits. Static schema fixtures do not substitute for live adapter, replay, policy or isolation tests. See [chapter 21](21-rules-role-content-skills.md) for the authoritative requirements and compatibility rules.

The first real task (W-107) is one reproducible machine-reported bug in an onboarded application with current bug-fix readiness and INT-14-cleared provider eligibility, taken end to end to a reviewed PR through W-080 with human plan and oracle review, before the rest of M3 qualifies. It retains discovery and incident evidence; its DiagnosisManifest MAY derive from the chapter 08 hypothesis table until W-033 qualifies the mandatory ledger and tracker evidence. W-027/W-028 and W-033 MUST prove existing-feature obligations and bug red/lock/green in fast/one modes (AC-67/AC-68). Every specification revision executes the reference DDL on PostgreSQL 18 with tenant-isolation and grant smoke tests, and compiles the TypeScript contracts in strict mode (W-108). A small campaign pilot (W-103), after W-033, applies one recipe to a handful of similar repositories and measures accepted outcomes, review time, rework and cost.

## Measurements and review

For each harness/model/profile report: successful required outcomes, false success rate, invalid or missed review findings, semantic attempts, elapsed/active time, cost with uncertainty, context reconstruction overhead and tool/capability errors. Keep a held-out task set for upgrade evaluation. Compare profiles under the same criteria and source baselines.

Initial launch requires zero known false-success cases in the acceptance corpus and zero unresolved critical/high isolation or evidence-integrity defects. This is a release rule, not a claim of zero real-world defects. Set observed quality/cost targets after the pilot baseline rather than inventing a universal model success percentage.

AC-146–AC-155 cover receipt-derived handoff status, protected architecture rules, read-only evidence parity, cohort stop-the-line and the M0 adoption exit criteria. A pre-factory baseline per pilot application is required before pilot enablement, and comparisons with it are reported as observational. See [chapter 22](22-reference-practice-adoption.md).

## Required evidence bundle for a factory release

Version-lock manifest; image/chart digests; migration report; schema/API compatibility report; Temporal replay report; adapter capability reports; acceptance run IDs; isolation and restore drill reports; load/SLO measurements; known limitations; approved rollout plan; on-call/runbook ownership. Store them as immutable release artifacts linked from the factory's own deployment change.

## Operational-review qualification

M0 must prove the pinned Claude Agent SDK can run in the chosen restricted isolation profile with gateway-only model access, factory MCP/CLI tool registration, no interactive prompts, isolated settings/session files, known usage precision and complete process-tree cancellation. No provider master key may reach candidate code. Qualify both denial and success paths; a tool-hook callback firing is insufficient evidence of isolation.

Tool conformance includes stale epoch, role spoofing, duplicate/conflicting result proposal, malformed role payload corrected in-run, writer mutation after submission, crash before artifact finalisation, unavailable server, verification caps, private-check access and blocking/nonblocking decisions. PR qualification includes signed but stale/out-of-order events, unauthorized or malicious comments, actual-head approval, review-round exhaustion, human pushes, abandoned PRs, calendar expiration and Continue-As-New during a review wait. Test all completion policies separately.

Add canaries where assertions conflict with approved intent, a shim contains the repair, a mutant is equivalent/does not compile, a candidate detects a test-only constant, or in-process reports are forged. Measure cheating/false-success rate, legitimate completion, false positive scope findings, review usefulness and cost together. Do not optimize the system simply to refuse every task. Out-of-process/private checks must prove candidate code cannot read their files or credentials.

Release evaluation covers prompt/instruction/skill/tool/evaluator/tier changes as well as adapters/models. Retain held-out fixtures and compare to the current qualified behavior release. Context-size/compaction and solution-blind discovery are experiments measured for outcome, lost facts, reconstruction overhead and budget, with qualified fallback. Native resume requires all compatibility bindings, not merely source hash. Application-autonomy tests cover sparse cohorts, immature 90-day windows, biased sampling, automatic tightening and attempted unauthorized relaxation of human floors. D5 additionally requires W-141–W-143 authority/panel/preview/audit qualification, including false-approval and catch-rate measurements; static package fixtures do not establish reviewer effectiveness.

Static package validation is explicitly staticChecksPassed; it does not execute these tests. PostgreSQL execution evidence for a historical schema does not validate this revision's added tables, grants or migrations. Attach actual database and runtime results during M0/M1 implementation qualification.
