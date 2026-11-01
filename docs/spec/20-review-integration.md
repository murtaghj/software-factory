# 20 — Review integration and pilot decisions

Revision 1.4 incorporates the engineering review with the amendments agreed after assessment. This chapter records what was adopted, constrained or deferred; the numbered domain chapters and generated contracts specify the actual behavior. The review's original [proposal](../review/spec-improvements.md) is retained as input, not a second source of runtime policy.

## Decided release behavior

| Concern | Adopted decision |
| --- | --- |
| Pilot harness | Claude Code through the Claude Agent SDK, one runtime across all supported stages. Codex proves portability next; OpenCode follows. |
| Pilot scope | Existing-project feature, reproducible machine-reported bug and investigation; report/PR delivery. Greenfield remains outside the pilot. |
| Planning | Independent exact-packet peer sign-off remains before substantive implementation in every assurance/invocation mode; human by default or D5 panel when in force. Small work has concise complete coverage. |
| Risk tiers | Fast/standard/enhanced change depth and qualified evaluator selection, never required stage presence or nonwaivable gates. |
| Oracle | Pilot bug/feature checks require human oracle approval and enhanced retains it in human mode; D5 uses the qualified AI panel. Other qualified judgement modes need scoped evidence and policy decisions. |
| PR completion | Choose pr_created, review_completed or merged explicitly; default pr_created. Review/merge waits never gain implicit merge authority. |
| Failed reproduction | Investigation/evidence request by default. A later qualified owner-authorized proposal remains fix_proposed_unreproduced/incomplete and PR-only. |
| Tools | Shared verify, submit_result, request_decision and get_evidence contracts, with server-derived authority. Local feedback is separate from gate evidence. |
| Completion | Submission acknowledges a proposal; writer quiescence, exact snapshot and durable finalisation precede accepted completion. |
| Continuity | Required stage-boundary checkpoints and portable handoffs. Native resume and mid-stage compaction require explicit capability qualification. |
| Deployment | M0 spike proves actual effect identity/lookup/cleanup. A wrapper must reconcile real effects; a local dedupe table alone is insufficient. |
| Autonomy | Application/change/risk/behavior-release cohorts, mature measurements and authorized policy changes. Tightening may be preauthorized; relaxation is human. |

## Review disposition

| Original items | Disposition and implementation location |
| --- | --- |
| P0-1, P0-2 | Adopted: Claude-first and complete supported stage graphs. Chapters 01/05/07/13, W-035/W-076/W-077; Codex W-026 becomes M4. |
| P0-3 | Adopted with cohort scope, evidence maturity and human floors. Chapters 05/11, ADR-17, W-081/W-087. Line churn is a signal, never a sole autonomy score. |
| P0-4 | Amended: tiered scrutiny adopted; removing pre-implementation approval remains excluded; D5 replaces human peers only for opted-in applications. All 12 plan categories remain applicable/justified. Chapter 19 and INV-21 remain intact. |
| P0-5 | Adopted with explicit completion policy and honest close/handover outcomes. Chapters 03/04/10/12, W-080. |
| A1, A8 | Adopted: boundary checkpoints, fresh restore default and complete compatibility checks for native resume. Chapters 06/07, W-020/W-084. |
| A2, A3 | Adopted with evidence-class limits, human pilot oracle, process separation and preferred qualified family diversity. Chapters 05/09, W-082/W-083. |
| A4 | Adopted: framework failure-signature profiles and reviewed identical shims. Chapters 05/09, W-082. |
| A5 | Amended: dedicated reproduction stage and machine-reported pilot; unreproduced proposal is explicit incomplete, not verified bug completion. Research percentages are not forecasts. |
| A6, A7 | Adopted with qualification: remote mediation, hooks as guardrails, isolated code execution and gateway-only provider access. No blanket assumption about harness flags or container isolation. Chapters 06/07, W-077. |
| B1 | Adopted with corrected wrapper guarantees: W-078 qualifies the MCP spike when MCP is selected. M5 requires qualification of at least one real provider: MCP W-041/W-078 or Argo W-139/W-140, through W-042/W-045; each enabled provider must qualify. Chapter 10. |
| B2, B3 | Adopted: Claude feasibility M0; fault-injection framework M1, full recovery qualification M8. W-077/W-079/W-060. |
| H1 | Adopted with proposal/finalisation protocol, authenticated allocation scope, blocking/nonblocking decision semantics and bounded feedback. Chapters 06/07, generated factory-tool schemas, W-075/W-076. |
| H2, H3, H5, H6, H7 | Adopted: read-only factory settings, no interactive wait, optional qualified subagents, aggregate hard resource caps. Hooks/prompt labels are not security boundaries. |
| H4, H8, H9 | Amended: tune context occupancy/restart and prompt budgets with evaluations; preserve ticket symptoms/evidence while withholding suggested solutions where useful. No universal 60% or instruction-count cutoff. W-084. |
| V1, V2 | Adopted proportionately: private cases reflect visible criteria and are isolated from candidate code; targeted mutation is a measured strength signal with applicability/invalid-mutant handling. W-082/W-083. |
| V3, V4, V5 | Adopted with truthful classification: family diversity is preferred in human mode and mandatory for D5 panels, protected-path checks are deterministic, semantic scope judgement is heuristic/model/human. W-082/W-083. |
| V6, V7 | Adopted: impossible-task canaries, hostile context fixtures and privileged controllers accepting only validated manifests/authority. W-086/W-058. |
| V8 | Adopted: controlled placement and variability protocol are required for performance claims. W-047/AC-127. |
| E1, E2, E4 | Adopted: behavior releases, role-model qualification, reviewer-aware admission and bounded slice PRs. W-085/W-086. |
| E3 | Deferred optimization after measured cold-start cost; immutable prewarming and one-time allocation rules specified in chapter 11. No warm-pool service is required for the pilot. |
| F1, F2 | Reconciled: per-root active-child/depth limits, per-parent authoring limit, org resource caps, M2 admission. W-088. |
| F3 | Removed backup dependency on the knowledge workflow and security dependency on backup. Restore qualification still depends on backup and security; release cannot skip either. |
| F4 | Adopted: greenfield stays outside M3; new requirements reuse task/controller/operation records rather than inventing a workflow per tool call. |
| Review items D1, D2, D3 | Fixed authoring note, documented one polling pattern per resource class and listed all generators. |
| Review item D4 | Preserved honest qualification: historical SQL execution is not evidence for the current DDL. Header explicitly names current-revision engine/migration/privilege checks as outstanding. |
| Review item D5 | Renamed validation status to staticChecksPassed and productValidationExecuted false, with explicit notExecuted scope. |

## Build order and proof

M0 closes real Claude-in-pod/gateway feasibility and deployment idempotency/lookup facts. M1 builds task/command persistence and the fault-injection framework. M2 builds isolated execution, minimal admission, boundary snapshots, factory tools and independent verifier control. M3 connects Claude, human plan/oracle reviews, bug/feature/investigation templates, PR feedback/rework, reviewer admission and behavior-release evaluations. Application-health collection starts in M3 without allowing automatic policy relaxation. M4 qualifies Codex portable continuation before portability is advertised; OpenCode follows that proof. Later milestones add preview, greenfield, other work types and measured authorized gate-mode changes.

The new work is traced by W-075–W-088 and AC-95–AC-126, AC-128–AC-129. AC-127 is owned by W-047. A static package check demonstrates schema/link/example/backlog consistency only. Product acceptance still requires real databases, harnesses, Kubernetes isolation, Temporal replay/recovery, provider sandboxes and engineer review-comprehension evidence.

## Rules and role-content integration (1.5)

Revision 1.5 adds role-content and rule qualification to these decisions. Tool 1.0 remains the historical contract; new rules-role-content/1.0 runs require 1.1. The stage graph, gate floors, quiesced finalization and PR completion authority remain unchanged. See [chapter 21](21-rules-role-content-skills.md) for the authoritative requirements and compatibility rules.

## D5: AI panel review and dev merge

The 29 October 2026 decision amends D1 only for applications with an in-force joint human ai_only decision. The chapter 05 panel replaces every mandatory review gate at every assurance tier, including PR review as a merge condition; release_authorized remains human. Family diversity is mandatory in this mode, every required specialist is retained and approval is unanimous on the immutable subject. Panels and adjudicators require the chapter 11 reviewer-quality corpus qualification; their effectiveness is not yet proven.

PR reconciliation MUST keep provider human-review observations separate from AIReviewApprovalSet. AI approval must never set PRHeadObservation.reviewState=approved or fabricate a provider human approval; the evaluator uses the separate exact-head AI set. Every PR and export shows ReviewMode and “AI-reviewed — no human review”, with any voluntary human review separately attributed. Ready-for-review, required checks, qualified exact-head previews and tested integration remain prerequisites; chapter 10 permits only the configured dev branch through the factory identity. Expiry, revocation, stop or degradation fences pending merges and restores human review/manual merge. Post-merge human audits do not delay merge but feed mandatory threshold-based degradation.
