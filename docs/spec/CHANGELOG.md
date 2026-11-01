# Specification changelog

## 1.13 — 29 October 2026

Repair pass: close S1–S6 and C1–C6 with provenance, markers, bounded adjudication, coverage, temporal authority, pre-repository binding, aligned versions/audit rates and idempotent regeneration; second pass closes N1–N5 with output provenance/exact-subject binding, mandatory qualified panels, full vote/disposition/binding chronology and deterministic ZIP metadata/order; final pass closes N6–N13 through recursive provenance/scope/identity/chronology checks, adversarial fixtures and explicit runtime corpus obligations; retain revision 1.13 and existing IDs.

D5 amends D1 for opted-in applications only: joint human policy-owner/application-owner decisions may establish ai_only at any assurance tier, replacing mandatory intent, architecture, plan, specialist, oracle and PR human reviews with qualified unanimous AI panels. Production release_authorized always stays human; hotfixes and embargoed work remain in human mode. Outside this opt-in, existing human floors are unchanged.

Added INV-29, ADR-33, INT-18, W-141–W-143 and AC-280–AC-303; amended INV-20/INV-21/INV-25 and AC-224. Specify reviewer-quality qualification, family diversity, adversarial/specialist roles, bounded adjudication, honest AI provenance, dev-only factory-identity merges after exact-head checks/previews, hidden preselected post-merge human audits and automatic degradation to human/manual merge. Add policy/AI decision/audit persistence, API/UI mode/status visibility and positive/negative fixtures.

Design-only delivery (design-delivery/1.0, ADR-34): a requester may select DeliveryScope `design` for feature (greenfield or existing), refactor, performance or platform intent; it is a delivery scope, not a ninth work type. Five pinned design templates run discovery, the greenfield interview and intent confirmation where applicable, complete plan authoring and full peer review (architecture_accepted, plan_peer_approved, plan_accepted with every specialist, in every tier and ReviewMode), then a deterministic render_design controller and delivery, with no implementation, code workspace, test execution, preview or merge node. The approved packet is delivered as a design PR to the configured design-docs/ADR location (objective met when the PR is created, mirroring pr_created; merge follows the docs repository's own rules) or as a classified report artifact. OutcomeManifest records design_approved with the exact subject and approvals and can never claim delivered, verified_fix, implemented, verified or outcome_verified. A later build may bind a delivered design through DesignBuildBinding and reuse its exact approvals only while source pins, rules, policy, intent, application snapshot, build scope, approval expiry and AI authority are current; drift reopens the affected sections and re-requests only the affected gates through the chapter 19 replan path (INV-22). Design tasks have a separate budget class; rules, D4 embargo and INV-28 classification apply. Amended INV-12 and AC-242; added ADR-34, W-144, AC-304–AC-318 and AC-319 (owned by W-141, which now depends on W-144 and alone enables the ai-review design templates); W-059 depends on W-144. Embargoed designs follow D4 and are buildable only by tasks inheriting their security group; security-flagged designs stay human; greenfield designs deliver as reports; the reuse basis derives from the build's own accepted intent, criteria and tier. Contracts add design records, two read routes inside API 2.5.0, design templates (human 1.0.0, ai-review 2.0.0), task.delivery_scope, budget_account.budget_class and append-only design_delivery/design_build_binding tables (59 reference tables) with positive/negative fixtures. Runtime rendering, Git delivery and currency resolution are **not yet proven**.

Domain stays 2.0 with profile-required additive fields; API description becomes 2.5.0 on /v2. ai-review/1.0 pins greenfield 5.0.0 and existing_feature/bug_fix 4.0.0, retaining prior human histories. Factory tools remain 1.2.0 with frozen historical manifests because no tool wire contract changes. Qualification and migrations precede enablement. The AI panel’s effectiveness and real-provider/storage behavior are **not yet proven**. Historical entries below describe their release; D5 is the current explicit exception to their human review floors.

Final integration: the design-only outcome and the D5 repairs are merged. Design gate approvals use separate human and AI approval fields, and AI design outcomes name their reviewed subject. Chapter 05 now states that authority is resolved once from trusted control-plane state, and that provider observations and production mitigations never substitute for human approval or release. The last static recheck found further reference-predicate gaps (exported task views, nested authority state, provider observations, production mitigation, decider identity). These are recorded as mandatory runtime corpus cases for W-141/W-143 rather than further static predicates. Design outputs now run the same ai-review predicates: AI design deliveries resolve each gate's panel, decision, qualification and chronology; human design approvals and outcome references pass human provenance; design outcomes pass output_ready; AI-approval reuse requires a decision in force for the build task itself (enforced in SQL too); delivery flags come from the trusted task snapshot; and each design negative asserts its intended rejection reason.

## 1.12 — 26 October 2026

Added the Argo CD ApplicationSet PR-generator branch-preview specification as the reference Kubernetes DeploymentProvider, with MCP retained as an equal alternative. Specifies exact head/image evidence, redeploy supersession, label/fork admission, isolated data and namespaces, authenticated routing, capacity queues, expiry and confirmed cleanup. Existing merge-to-dev Argo and production paths remain unchanged.

Added W-139–W-140, AC-262–AC-272, ADR-32 and INT-17. W-042/W-045 require at least one qualified real provider through explicit alternative dependencies. Provider-neutral bindings/status/capability additions retain domain 2.0, API 2.4.0, tools 1.2.0 and existing workflow versions; new profile requirements apply only after qualification with compatible readers. Organization facts and real-cluster conformance remain not yet proven.

Repaired C1–C5: scoped Git draft/label/identity operations, guarded current-plan generations and runtime grants, durable public queue/status projections, draft-first preview verification and exact-head rework, and provider-neutral M5 wording. Added AC-273–AC-279 and generated response fixtures; revision and contract/template versions remain unchanged.

## 1.11 — 9 October 2026

Corrected the contracts, authority boundaries and implementation sequence across the specification:
- SQL uses explicit runtime grants, immutable provenance and constrained transitions, with durable upload/projection/decision bindings, checkpoint jobs, structured failure signatures and security-group visibility.
- API and internal contracts align receipts, task controls, decision authority, artifact links/retention, SSE recovery, stage supersession and ownership. Runner contracts bind exact inputs, checkpoint authorship, diagnostic results and bounded deadlines; regression tests are committed and verified in the candidate before green.
- Workflow dependencies and rework routes preserve current evidence and mandatory human gates. Qualified recipes can complete independently verified no-change outcomes without a synthetic PR. Incident-learning profiles pin their scope/delivery predicates without retroactively changing histories.
- D1: Human PR approval remains required before any automatic merge action in human mode (D5, revision 1.13, adds the opted-in exception); degradation returns to manual merge. Urgent hotfixes retain the on-call generalist and every required specialist. W-126 moves to M7 behind environment, production-delivery and fairness prerequisites. Embargoed pushes require an isolated confidential target and provider-enforced reader checks on every push (INT-15).
- Factory tools add bounded evidence queries, missing-context submissions and hypothesis ledger operations. Classification, campaign approval, portable handoffs and the separately qualified urgent-mitigation/1.0 path now have explicit contracts. Backlog closure, pilot/full-path prerequisites, onboarding safeguards and qualification ownership are reconciled.
- Reader rendering and static checks cover document structure, references, revision metadata and milestone ordering; packaging validates current sources before refreshing the manifest and archive. README companion ownership and compatibility, historical ADR omissions and review fixtures are corrected.

Added W-128–W-138, AC-203–AC-236, AC-240–AC-251, AC-260–AC-261, ADR-28, ADR-31 and INT-16. ADR-31 retrospectively records the revision 1.5 rules/role-content decision.

Repair pass: froze the complete tools 1.0.0/1.1.0 definition graphs and original 1.10 compatibility fixtures; added authorized pre-task/controller upload scopes, durable finding metadata/dispute links and one generated FailureSignature type. Closure checks now verify ADR/INT acceptance ownership and all packaged review Markdown. The cancellation demo uses Enhanced assurance with planned oracle/adversarial evidence. No new IDs; AC-175, AC-204 and AC-235 clarify the existing obligations. These storage and service changes remain not yet proven at runtime.

API description advances to 2.4.0 on /v2; factory tools advance to 1.2.0 with pinned 1.0.0/1.1.0 manifests retained. Domain envelopes remain 2.0; greenfield remains 4.0.0 and existing_feature/bug_fix 3.0.0. Deploy compatible readers and migrate stored records/grants explicitly before enabling new profiles. INV-01–INV-28 are unchanged. Static package checks do not prove current SQL migrations/privileges, TypeScript compilation or provider/runtime behavior; these remain not yet proven.

## 1.10 — 5 October 2026

Promoted the two deferred items in chapter 25:
- **Urgent hotfix path:** incident priority, on-call routing, a concise but complete plan with one on-call generalist plus every required specialist peer sign-off, red/lock/green for any verified fix, recorded mitigation distinct from a fix, an automatic follow-up task and incident learning. Release policy is unchanged.
- **Factory self-work:** the factory's own repository is onboarded after pilot qualification, with its trusted components protected from self-modification and deployment kept in the factory's own release pipeline.

Added ADR-27, W-126, W-127 and AC-199–AC-202.

## 1.9 — 5 October 2026

Added chapter 25:
- Data classification with provider eligibility enforced at admission and at the model gateway (new INV-28; provider terms are INT-14).
- Deterministic secret scanning of candidate diffs before publication and push.
- An audited organization-wide emergency stop.
- Security vulnerability tasks with severity targets and confidential embargoed handling (INT-15).
- Licence policy checks.
- Git-adapter authorship trailers.
- Decision notifications with response targets, reminders, escalation and waiting-on-humans measures, with no auto-approval.

Added chapter 26: hypothesis ledger tools with prediction, kill criterion and timebox; enforced timeboxes; deterministic stall detection; transcript-free fresh-eyes checkpoints; breadth-first probes and early human escalation; dead-end memory linked to failure signatures; decoy-bug evaluation.

W-107 now depends on classification, secret scanning and the emergency stop. Added ADR-25, ADR-26, W-115–W-125 and AC-182–AC-198. No gate, SQL table or REST route changes; ledger and classification schemas are package deliverables.

## 1.8 — 5 October 2026

Added chapter 24:
- Discovery produces a ContextManifest (sources consulted, prior matches, blocking and nonblocking gaps) shown to plan reviewers.
- `get_evidence` gains read-only, untrusted issue-tracker and code-history sources, with documentation optional (INT-13).
- Diagnoses carry normalized, versioned failure signatures. New bugs are matched against past incidents as labelled hypotheses that never replace reproduction or gates.
- Verified fixes keep their regression test in the permanent suite, and removing an incident-linked test is a protected-path finding.
- Reviewer-confirmed root-cause categories.
- Read-only variant analysis routes confirmed variants to linked tasks or recipe proposals.
- Recurring categories raise systemic proposals that need owner decisions.
- Match usefulness is measured, and the evaluation corpus includes look-alike incidents.

Added ADR-24, W-109–W-114 and AC-173–AC-181. No invariant, SQL table or REST route changes; incident-learning/1.0 refines scope_accepted for blocking ContextManifest gaps and delivery for regression-test retention or an owner exception, with pinned policy/evaluator versions and unchanged prior histories. ContextManifest, FailureSignature and taxonomy schemas are package deliverables, and interfaces.ts adds the incident-memory types.

## 1.7 — 5 October 2026

Added chapter 23:
- Registry sources plug in at import time behind `RegistrySource`, with a field-level authority map and a Backstage-compatible Git descriptor as the default source. There is no organizational catalog today (INT-12).
- Agent-assisted application onboarding with verified build and test commands, and confirmed ownership as an eligibility gate.
- Readiness assessed per change class.
- Versioned change recipes with typed outcomes and deterministic or agentic executors sharing one evidence standard.
- Campaigns with a canary wave, per-team review budgets, pause thresholds and targeted re-runs.
- Auto-merge as an earned merge action after current-head human PR approval, limited to deterministic change classes in v1; degradation returns to manual merge.
- Role-scoped tool profiles, missing-context reports and interactive takeover.

Defined the first real task cut (one reproducible machine-reported bug, W-107) ahead of full M3 qualification. Added executed contract checks in CI (W-108). The reference SQL gains factory_migrator/factory_runtime roles and grants; it was applied to PostgreSQL 18 and smoke-tested for tenant isolation and grants.

Consolidated all revision-labelled sections into their chapter bodies; chapter 20 keeps the review history. Chapter 05 now states process separation plus preferred model-family diversity for judgement roles.

Added ADR-22, ADR-23, W-098–W-108 and AC-156–AC-172. No invariant, gate or REST route changes; descriptor, recipe, `deterministic_transform` and `missingContext` contract additions are package deliverables.

## 1.6 — 2 October 2026

Added chapter 22: reference practice and adoption decisions. A structured portable handoff derives task status from tool receipts and adds an append-only progress log and per-task local commits. Pilot applications must declare executable architecture rules that candidates cannot amend. Read-only engineer-parity evidence (CI and error tracking in the pilot). Integrity signals trigger an automatic, cohort-scoped stop-the-line with human clearing. A pre-factory baseline is required before the pilot. M0 adoption decisions with exit criteria cover agent-sandbox, in-toto/SLSA attestation and an OPA/Cedar policy engine, with the existing specification as fallback (ADR-21). Added W-092–W-097 and AC-146–AC-155. No invariant, gate, SQL table or REST route changes; the PortableHandoff schema is a W-092 contract deliverable.

## 1.5 — 2 October 2026

Integrated the rules/role-content review as chapter 21 with corrections: owned rules and scoped exceptions, rule intent distinct from check implementation, factory-controlled settings instead of candidate project settings, deterministic role delivery and pinned third-party admission. Added ordered plan-task checks, reuse/dependency rationale, source-bound structured feedback claims, explicit deferred-work disclosure and optional forensics proposals. Preserved all gates and existing finding routes; added INV-26–INV-27, W-089–W-091 and AC-130–AC-145. Factory tools 1.1.0 coexist with the retained 1.0.0 contract. Domain 2.0 additions are profile-required; API/template versions were unchanged at this release (the API description advances to 2.4.0 in revision 1.11). ADR-31 records this decision retrospectively in revision 1.11. Static checks cover package consistency, not implementation qualification.

## 1.4 — 2 October 2026

Integrated the engineering review with recorded amendments in chapter 20. Claude Agent SDK becomes the pilot runtime and Codex the first portability adapter. Added shared factory tools with proposed-versus-final result semantics, split supervisor/candidate credentials, boundary checkpoints, qualified context restarts, explicit PR completion/rework and application-health/cohort policy records. Preserved pre-implementation human peer sign-off, greenfield human intent, exact evidence binding and bug red/lock/green; no INV-01–INV-22 requirement is weakened. Added INV-23–INV-25 and ADR-17–ADR-20.

Moved Claude/deployment feasibility spikes to M0, recovery injection to M1 and minimal admission to M2. Added W-075–W-088 and AC-95–AC-129, structure-first review, evidence classes, holdout/mutation/tamper/scope qualification, reviewer capacity and behavior-release evaluations. Assisted unreproduced proposals remain explicitly incomplete and outside the pilot; automated human-plan exemptions and warm pools remain deferred.

Domain 2.0 additions are optional on the wire for historical compatibility and required where applicable by the new qualification/template semantics. API description 2.3.0 remains /v2; greenfield advances to 4.0.0 and existing_feature/bug_fix to 3.0.0. Deploy compatible validators/readers before accepting the new fields; preserve prior snapshots/templates/workers. Reference DDL adds four tables and still requires real PostgreSQL migration/privilege validation. Validation output now explicitly reports staticChecksPassed and productValidationExecuted false.


## 1.3 — 1 October 2026

Plans/designs now require independent qualified human peer sign-off before implementation. Added complete canonical review packets covering design, scenarios, acceptance, DoD and all applicable engineering concerns; primary/specialist assignments; exact-revision decisions and anchored discussion; and layered summary/structured/full views with comprehension qualification. Added a fictional interactive plan-review concept, W-072–W-074 and AC-85–AC-94.

Greenfield template advances to 3.0.0; existing_feature and bug_fix to 2.0.0. API description is 2.2.0 on /v2, with domain envelopes still 2.0. Deploy compatible readers/workers before enabling new templates and explicitly retain/migrate old histories. Plan approval does not imply test success or release authority.

## 1.2 — 30 September 2026

Greenfield now requires adaptive human interviewing, a versioned intent brief, fresh skeptical review and exact-subject human confirmation before foundation design/bootstrap/implementation. Added durable answer/revision handling, explicit assumptions/conflicts, focused question/read-back UI, and implementation obligations W-069–W-071 / AC-75–AC-84. Repository intent may be unresolved during interviewing; BootstrapPlan still requires an authorized resolved choice.

Greenfield template advances to 2.0.0; existing_feature and bug_fix remain 1.0.0. Domain envelopes remain 2.0 and API description is 2.1.0 on /v2. Regenerate validators/clients and deploy compatible workers before enabling the new template; old histories do not gain or skip gates implicitly.

## 1.1 — 30 September 2026

Greenfield, existing-project feature and bug-repair journeys now have explicit target context, pinned workflow templates, distinct prerequisites, evidence and return paths. Added draft-application registration, authorized repository bootstrap before worktrees, foundation/vertical-slice/parent gates, intake/progress requirements and implementation traceability W-063–W-068 / AC-61–AC-74.

Breaking reference-contract change: domain envelopes 2.0 and REST /v2 require TargetContext and template bindings. Regenerate clients; migrate persisted records explicitly and retain old workflow histories/contracts. Template versions start at 1.0.0; backlog and acceptance formats remain 1.0. SQL is a fresh reference schema, not an executed migration.

## 1.0 — 28 September 2026

Initial detailed implementation specification covering the shared factory engine and eight work types. Greenfield onboarding and its distinct completion path were not fully specified.
