# 22 — Reference practice and adoption decisions

Revision 1.6 distills lessons from published agent factories and commodity infrastructure into explicit requirements and M0 decisions. The guiding principle is to **build what is distinctive and adopt what is established**:
- The factory's distinctive value is its evidence chain: intent, plans, gates, provenance, independent verification and earned autonomy.
- Sandboxing, attestation formats, policy languages and handoff conventions already have proven implementations. Adopt one when it meets the requirements in this chapter.

Nothing here weakens an invariant, a gate, peer sign-off, bug red/lock/green or delivery authority. Practices drawn from reference systems are engineering hypotheses to qualify locally. Figures published by those systems are not adopted as claims about this factory.

## At a glance

| Decision | Required behavior | Owners |
| --- | --- | --- |
| Structured portable handoff | Ordered task status derived from receipts, an append-only progress log, and a local commit per completed task. | Chapters 06/07, W-092 |
| Executable architecture rules for pilot applications | Owners' essential layering and dependency rules run as checks before an application enters the pilot. A candidate cannot change the rules that check it. | Chapter 21, W-093 |
| Engineer-parity evidence | Read-only, scoped access to the diagnostic sources an engineer would use. No mutation through evidence tools. | Chapters 07/08, W-094 |
| Automatic stop-the-line | Integrity signals suspend admission for the affected cohort under a pre-authorized degradation policy. Clearing is human. | Chapter 11, W-095 |
| Baseline before the pilot | A pre-factory measurement baseline per pilot application, with definitions, windows, denominators and gaps. | Chapter 13, W-096 |
| M0 adoption decisions | Execution substrate, attestation format and policy engine are evaluated against exit criteria. The current specification is the fallback. | Chapters 14/15, W-097, ADR-21 |

## Structured portable handoff

The portable handoff required by chapter 07 becomes a versioned, structured `PortableHandoff` artifact. It retains the existing content (objective, accepted decisions, evidence refs, failed hypotheses, next actions) and adds:
- **Task list.** The ordered plan tasks from the accepted packet (chapter 21, plan tasks). Each task has a stable ID, its paths, its declared check, status (`not_started`, `in_progress`, `done_with_feedback`, `awaiting_evidence`, `done_with_evidence`, `blocked`) and supporting receipt references. For human_review or controller_evidence check strategies, receipts MUST satisfy the task's evidenceRequirementRefs; approval or controller evidence replaces a verify receipt.
- **Progress log.** Append-only entries: time, run and allocation identity, action, evidence references. Entries are never edited; corrections are new entries.
- **Per-task source points.** When a task reaches `done_with_feedback` or `done_with_evidence`, the supervisor requests a local task-branch commit; the trusted runner/checkpoint step creates it after proven writer quiescence, recording source and server-derived authorship trailers before freezing its ID (chapters 06 and 25). For a task without source changes, record the existing checkpoint/commit. These are checkpoint material, not publication; they are not pushed until delivery rules permit.

Rules:
- **Status is derived, not asserted.** The supervisor computes task status from plan identity and authenticated receipts: factory tool receipts (`verify`, `submit_result`) for executable checks, and approval/controller records satisfying evidenceRequirementRefs for non-executable checks. Completed author work awaiting those records is awaiting_evidence; satisfying all of them yields done_with_evidence. Neither status is an agent assertion. Narrative fields supplied by the agent are stored as labelled, untrusted text. An agent claim that a task is done, without a supporting receipt, leaves the status unchanged and is recorded as a finding.
- **Feedback is not evidence.** `done_with_feedback` reflects visible feedback only. It never satisfies a gate (INV-23); canonical verification still decides.
- **One task in progress per writer.** A writer works on one task at a time. The fresh-context-per-task option in chapter 21 uses the same task list.
- **Restore uses the handoff, not the transcript.** A fresh session in a new allocation receives the handoff in its task message and continues from the first writer-actionable incomplete task without access to the previous transcript (INV-10). It skips done_with_evidence tasks and does not redo authored work awaiting_evidence; such waits do not block unrelated writer work, but dependent tasks and completion still wait for the required evidence.

The visible verify allowance is per stage: plans whose task count exceeds it MUST be split into bounded implementer stages at task boundaries using AC-146 handoff restore; exhaustion with tasks remaining ends the stage at a resumable handoff boundary, not the task as terminal incomplete unless its task budget is exhausted, and one verify receipt MAY support several tasks whose declared checks share a recipe.

The contract generator gains the `PortableHandoff` schema in W-092. Until then, this section is the normative description, and existing checkpoint manifests carry the handoff by reference.

## Executable architecture rules for pilot applications

Before an application is enabled for the M3 pilot, its owners MUST declare the layering, dependency-direction and module-boundary rules they consider essential, as executable checks resolved through chapter 21. The checks run in both visible `verify` feedback and trusted verification, and every diagnostic names its rule and check revision.

- **No self-amendment.** A candidate change cannot add, remove or alter a rule or check that applies to that candidate, whether in the standards repository, the application profile or repository configuration. Such edits are protected-path findings (INV-07). New or changed rules arrive only as separately reviewed changes to their owning source, including rules proposed by agents through the chapter 08 proposal path.
- **Health signal, not proof.** Violation and exception counts per cohort feed application health (chapter 11). They measure conformance to declared rules only. They do not establish maintainability on their own, and architectural review remains required: human by default, or the qualified D5 AI panel for eligible ai_only work.

## Engineer-parity evidence

`get_evidence` gives the role read-only, scoped access to the diagnostic sources an engineer would use for the same task: CI results and logs, error-tracking events, logs, traces and metrics, feature-flag state and deployment inventory. Access goes through ObservabilityProvider or equivalent adapters with:
- bounded time ranges and result sizes
- redaction
- organization, task and application authorization (INV-14)
- a recorded access trail

Tools 1.2.0 uses GetEvidenceToolInputV12 for agent-requested queries: a granted sourceId/sourceKind, queryTemplateId and typed template parameters, exactly one bounded timeRange or pinned repository/commit/pathScope, maxResults and maxBytes. The server checks the role/stage/work-type/recipe profile, source and template grants, classification, embargo membership and scope before contacting an adapter. It rejects free-form queries, ungranted sources, invalid windows and out-of-scope paths; parameters cannot widen the grant. Cursors are bound to the same query and identity. Adapters persist redacted excerpts with query and observation provenance as context-granted ArtifactRefs before returning them. Returned data is untrusted content (INV-13). The frozen 1.0.0/1.1.0 get_evidence input remains artifact-only.

Evidence tools never mutate anything. Toggling flags, acknowledging alerts, retrying deployments and similar actions remain capability-gated environment operations under chapter 10.

The pilot's minimal set is CI results and error-tracking events for the pilot application, because the pilot's machine-reported bugs depend on them. Broader telemetry and causal diagnosis remain W-038 (M4).

## Automatic stop-the-line

Trigger events:
- a false success on an impossible-task canary
- a protected-path or tamper violation detected by trusted verification
- an evidence-integrity failure (forged, stale or unprovable provenance)
- a failed role-delivery attestation
- an isolation-breach signal

On a trigger, within the pre-authorized degradation policy in chapter 11, the control plane MUST:
1. Immediately suspend admission of new authoring stages for the affected cohort: the behavior release, adapter and model profile, application and change class, as determined by the trigger.
2. Hold publication and delivery of in-flight results from that cohort until they are re-evaluated.
3. Record the triggering evidence and the automatic tightening decision.

Running work continues unless the policy classifies the event as an isolation or integrity breach, in which case the affected allocations are stopped and quarantined (chapter 09).

The halt is scoped to the cohort, so unrelated work continues. Clearing it requires a human decision by the policy owner, citing the evidence and the corrective change. Relaxation is never automatic (INV-25). The operations view shows active halts, their scope and the pending decision.

## Baseline before the pilot

Before the pilot is enabled for an application, record a pre-factory baseline for the work classes in pilot scope, over a declared window, from existing sources:
- lead time for changes
- revert or change-failure rate
- review rounds and review latency
- rework after merge
- escaped defects

Each measure records its definition, window, denominator and known data gaps. Factory outcomes use identical definitions.

Comparisons with the baseline are observational and confounded by task selection. Report them as such, never as causal productivity claims, and never substitute self-reported speed for measurement. Pilot enablement is blocked until the baseline artifact exists or an owner records why it cannot be produced.

## M0 adoption decisions

Each candidate is evaluated in W-097. The outcome is recorded under ADR-21. A rejected or undecided candidate leaves the existing specification in force as the fallback.

### Execution substrate: Kubernetes agent-sandbox

**Candidate:** the kubernetes-sigs `agent-sandbox` project (Sandbox, SandboxTemplate, SandboxWarmPool and SandboxClaim resources, with gVisor or Kata runtimes).

**Would replace:** the Job lifecycle and warm-pool portions of W-017 and chapter 11's optional pre-warmed execution. The runner controller keeps allocation generations, epochs, fencing and result acceptance.

**Exit criteria:**
- Under concurrent claims and a controller restart, at most one writer mounts a workspace for an allocation generation (INV-03).
- Claimed sandboxes carry deterministic ownership identity, so reconciliation can find them after a crash.
- Deletion is reconcilable.
- The supervisor/candidate credential split and default-deny networking (chapter 06) are achievable.
- The selected runtime runs the pilot harness and pilot build toolchains.
- Cold and warm claim latency are measured.
- Version pinning and the project's maturity are acceptable to the platform owner.

### Attestation format: in-toto / SLSA with Sigstore or organization KMS

**Would replace:** the custom signing envelope for VerificationReport and release provenance. The factory still defines the predicate content.

**Exit criteria:**
- Every binding field (input binding, evidence class, supervisor identity, source composition, artifact digests) maps without loss, using a factory predicate type where standard predicates are insufficient.
- Signing material stays outside candidate processes.
- Attestations verify offline for audit.
- Key rotation and revocation work (INV-16).

### Policy engine: OPA/Rego or Cedar

**Would replace:** hand-written policy predicates in `packages/policy`.

**Exit criteria:**
- Deterministic evaluation of pinned, versioned bundles integrated with ResolvedRules (chapter 21).
- Results recorded as Activity outputs, so workflow replay never re-evaluates live policy (INV-01, INV-04).
- Decision explanations satisfy the reason requirements.
- Nonwaivable floors are expressed and tested.
- Evaluation latency fits admission and gate paths.

Gate authority does not move into any candidate-visible location.

## Reference inputs for later work

These inform design and UX research. They are not requirements.
- **Background-agent products** (for example the Copilot coding agent, Codex cloud, Devin and Jules): task assignment from issues, clarification and comment-driven rework flows, for chapter 12 and W-080.
- **Spec-driven tools** (GitHub Spec Kit, Kiro steering files): a comparison for plan-packet and rule-layer formats.
- **Google's large-scale change practice:** splitting changes, routing to owners and bounding reviewer load, for the maintenance and migration work type in M6.

## Traceability

- W-092–W-097 implement this chapter.
- AC-146–AC-155 define its acceptance obligations.
- W-084 now depends on W-092. W-013, W-017 and W-022 depend on the W-097 decisions.
- No SQL table or public REST route is added in this revision. The `PortableHandoff` schema is a W-092 contract deliverable.

## Sources

Inspiration only. Practices are qualified locally, and reported figures are not adopted.

- [Anthropic: Effective harnesses for long-running agents](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents): structured feature list, progress log and incremental commits across context windows.
- [InfoQ: OpenAI harness engineering](https://www.infoq.com/news/2026/02/openai-harness-engineering-codex): mechanically enforced layered architecture with custom linters and structural tests.
- [Ramp: Why we built our own background agent](https://builders.ramp.com/post/why-we-built-our-background-agent): agents closing the loop with the same verification and telemetry sources engineers use.
- [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox): sandbox, template, warm-pool and claim resources with gVisor/Kata runtimes.
- [in-toto attestation framework](https://github.com/in-toto/attestation), [SLSA](https://slsa.dev/) and [Sigstore](https://www.sigstore.dev/): provenance formats and signing.
- [Open Policy Agent](https://www.openpolicyagent.org/) and [Cedar](https://www.cedarpolicy.com/): policy languages and engines.
- [DORA research](https://dora.dev/research/): delivery-performance measure definitions used for the baseline.
