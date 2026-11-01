# 04 — Temporal execution model and recovery

## Workflow inventory

| Workflow | Stable identity | Responsibilities |
| --- | --- | --- |
| TaskWorkflow | `factory/{orgId}/{taskId}` | Intake, immutable snapshots, plan, stage scheduling, decisions, budget, outcome and child coordination. |
| WorkPackageWorkflow | `package/{orgId}/{taskId}/{packageId}` | A typed child path for mixed work; shares a parent budget reservation and release manifest. |
| EnvironmentWorkflow | `env/{orgId}/{environmentId}` | Provision, reconcile, readiness, lease/expiry, verification triggers and retirement. |
| DeliveryWorkflow | `delivery/{orgId}/{taskId}/{deliveryVersion}` | PR publication, integration candidate, merge/release gates, deployment and observation. |
| KnowledgeWorkflow | `knowledge/{orgId}/{proposalId}` | Provenance validation, scoped review, Git proposal and reindex after merge. |
| MaintenanceWorkflow | Stable schedule identity per organization | Orphan cleanup, expiry reconciliation, stale imports and artifact-retention jobs; bounded batches. |

Keep StageRun as a domain record managed by Activities instead of a new Workflow per tool call. Use child workflows for independently meaningful lifecycles, not individual model messages. A deployment environment may outlive its task: use explicit child parent-close behavior and a durable owner/expiry reconciler. Do not rely on an abandoned child alone for cleanup.

## Journey resolution and common execution

ResolveWorkflowTemplate Activity selects trusted configuration using accepted WorkType and TargetContext. Greenfield, existing_feature and bug_fix have distinct ordered nodes and mandatory completion predicates; their example templates are in [chapter 17](17-project-journeys.md). Persist the exact template definitionRef and version in the accepted ExecutionPlan and every derived input binding. Worker build pinning and template pinning are separate. Continue-As-New carries the immutable plan reference, child identities, bootstrap operations and outstanding claims; it never reselects the latest template implicitly.

PlanNode.requiredGateIds are completion gates for that node. A node is runnable only when every dependsOn node has a current (non-superseded) StageRun in status passed whose input binding matches the current plan/input generation, every requiredGateId of those dependencies has a current passing evaluation, and required input/capability/budget checks pass. A node with no requiredGateIds reaches passed only through a typed StageOutcome of completed whose provenance and input binding the evaluator has validated. Skipped, failed, inconclusive, cancelled and superseded runs never satisfy a dependency. The node role produces outputs, not its own gate verdict. Oracle acceptance is supplied by a separate reviewer; trusted verification gates require verifier evidence. The plan compiler expands policy-selected skeptical/adversarial checks and delivery/integration nodes before plan acceptance. Template examples show minimum journey structure, not permission to omit scoped release gates.

BootstrapRepository and ActivateApplication run as controller/provider Activities with stable operation records, not harness tool calls. Bootstrap awaits a real base receipt before allocating a worktree. Scaffolding uses a pinned owner-reviewed initialization setup recipe; it later produces the application-specific profiles accepted at foundation verification. Registered dependencies may be used during foundation work. Child work against the new application starts only after registration and consumes the accepted foundation composition, not a fabricated baseline. Each child uses the same scheduler and shared parent reservations. Reconcile/cancel follows both parent and provider ownership obligations.

## Task state machine

| State | Allowed transitions and guard |
| --- | --- |
| accepted | queued after workflow binding; cancelling by valid command; failed on permanent invalid onboarding. |
| queued | running when admitted; paused/cancelling by valid command. |
| running | waiting_input for unresolved required facts; waiting_decision for a configured decision; paused; cancelling; succeeded if completion predicate holds; incomplete on exhausted bounded work; failed on permanent execution/configuration failure. |
| waiting_input | running after accepted spec/evidence revision; paused/cancelling; incomplete on expiry. |
| waiting_decision | running after a valid bound decision; paused/cancelling by valid command; incomplete on expiry/rejection where no permitted alternative remains. |
| paused | queued/running, or the recorded waiting_input/waiting_decision state, after resume and revalidation; cancelling. |
| cancelling | cancelled after active work is quiesced/reconciled and cleanup obligations are durably recorded. |
| succeeded / incomplete / failed / cancelled | Terminal. New work uses a linked task. No status PATCH reopens an old task. |

A requested task-state transition absent from this table is rejected with 409 and a typed reason. A pause or cancel received in cancelling is an idempotent no-op receipt. Pausing preserves a bound pending decision; resume returns to waiting_decision while it remains pending.

Cleanup state is tracked separately as pending/running/complete/needs_operator. Terminal task status can coexist with a recorded cleanup obligation, but success requires temporary resources to have a known owner and expiry. Unknown delivery outcomes prevent succeeded. Operator-visible cleanup failures cannot disappear behind a green task badge.

Stage states: pending → ready → running → evaluating → passed/failed/inconclusive; pending → ready requires every dependency to be passed for the current binding with current completion gates; running may end awaiting_input (needs_input after a checkpoint) or cancelled. passed, failed, inconclusive, skipped, cancelled and awaiting_input are terminal for the row. An answer starts a new semantic_attempt row. A plan revision appends superseded_at/superseded_by_plan_version and an optional superseded_by_stage_run_id to obsolete rows without changing their status. The replacement run MUST belong to the same task and superseding plan; RunView exposes its logical ID. A skipped stage includes a policy reason and cannot satisfy a required gate. Terminal outcomes and evidence remain immutable.

## Deterministic scheduler

The execution plan is a versioned DAG of nodes. Each node specifies stage kind, role, dependency IDs, input selectors, required gates, adapter capability requirements, timeout class, context policy and permitted return targets. The graph is validated for cycles, missing nodes, unsupported kinds and unbounded fan-out before acceptance.

```text
load accepted task/spec and pinned template through Activities
register command/signal handlers before waiting
while task not terminal:
  apply queued control changes serially; reject stale bindings
  if cancellation: reconcile active work; persist cleanup; finish
  if paused or waiting: wait on durable condition/deadline
  resolve ready nodes whose dependency StageRuns are passed for the current input binding and whose dependency completion gates are current
  reserve organization/task/provider capacity and budget through Activity
  derive logical stageRunId from task/plan/node/semanticAttempt
  persist run intent; dispatch registered handler (runner execution or provider/controller Activity)
  await durable result; runner work attaches through heartbeat Activity
  validate result provenance and input binding; ignore stale generation
  evaluate typed outcome and required gates through versioned evaluator
  record immutable results; project transition idempotently
  on semantic failure choose a permitted rework target and new plan/attempt
  on budget ceiling checkpoint, cancel active writers and finish incomplete
  at safe boundary, Continue-As-New if suggested or soft threshold reached
```

Activities resolve remote information and return recorded snapshots; replay uses the recorded result. Never call Date.now, random UUID creation, filesystem, database, fetch, process APIs or model clients from workflow code. Use Temporal's workflow-safe clocks/timers and deterministic IDs. Policy evaluation may be a pure bundled function pinned with the workflow, or an Activity whose immutable result is recorded; do not load changing rules invisibly during replay.

## Peer-reviewed engineering plans

Plan/design authoring produces a complete PlanReviewPacket before implementation. plan_peer_review is a controller stage that gathers completeness checks and persists required human peer decisions in human mode, or collects the D5 AI panel in ai_only; human waits are durable without a runner. Its gate set includes plan_peer_approved and plan_accepted; greenfield also establishes architecture_accepted. The initial authoring node cannot supply its own approval.

Compile the executable DAG against the signed packet and bind reviewPacketRef/planApprovalSetRef for dependent execution. Different plan artifacts, specialist assignment changes or material scenario/DoD changes invalidate the required packet approvals; mere runner retries and implementation details within the unchanged signed scope do not. Comments, resolutions and decision commands are serialized, and unresolved blocking findings across prior revisions must be carried forward until explicitly resolved. planReviewStateRef plus existing command/decision refs preserve continuation across history rollover. [Chapter 19](19-peer-plan-review.md) supplies the contract.

## Activity catalogue and initial limits

Defaults are proposed factory policy and must be configurable within operator caps. Activity attempts below are infrastructure attempts; they do not increment semantic stage attempts.

| Activity class | Start-to-close | Schedule-to-close | Heartbeat | Attempts | Behavior |
| --- | --- | --- | --- | --- | --- |
| Registry/context/policy resolution | 120 s | 10 min | None unless streaming | 4 | Retry transient network/DB errors; schema/auth/config failures nonretryable. |
| Persist/project/reserve | 30 s | 5 min | None | 5 | Compare stable keys/hash and return prior value. |
| StartOrAttach execution | 120 s | 10 min | None | 5 | Reconcile run and allocation before create. |
| AwaitExecution | Stage wall cap + 5 min | Task remaining wall cap | 30 s; send every 10 s | 5 | Poll runner every 5 s; retry attaches to same run. Heartbeats carry only run/checkpoint IDs. |
| Git publish / deploy submission | 120 s | 15 min | None | 3 | Retry only after operation reconciliation; unknown outcome enters reconcile path. |
| Reconcile external operation | 60 s | 30 min | None | 8 | Backoff with bounded durable timers between rounds; preserve unknown state. |
| Cleanup | 120 s | 20 min | 30 s if long | 8 | Idempotent desired-state deletion; orphan sweeper persists after workflow closure. |

| timeoutClass | Default stage wallSeconds |
| --- | --- |
| resolve | 600 (10 min) |
| execute | 2700 (45 min) |
| verify | 1800 (30 min) |
| provider | 900 (15 min) |
| cleanup | 1200 (20 min) |
| human_wait | decisionTtlSeconds, bounded by the remaining calendar deadline; no runner cap |

PolicyProfile.stageWallSecondsByTimeoutClass MAY override the non-human defaults within operator caps. The resolved cap fills RunLimits.wallSeconds for runner work and bounds controller stage work; remaining task budgets can shorten it. Human-wait nodes use durable decision deadlines without occupying a runner; any bounded runner Activity within an interview resolves its own execute cap. Runner Jobs use the resolved runner cap plus 300 seconds of finalisation grace as activeDeadlineSeconds, with a separate 15-second terminationGracePeriodSeconds. The execute example therefore uses 2700 + 300 = 3000 seconds and MUST retain its independent supervisor deadline if workers disappear. These are proposed defaults, not yet proven in runtime qualification.

Use exponential retry 1 s initial, coefficient 2, 30 s maximum for ordinary Activities. Provider Retry-After and global backpressure take precedence. No broad retry of validation errors, denied capabilities, unsupported adapters, missing required inputs or failed assertions. Set network request deadlines below Activity deadlines. Do not multiply unbounded HTTP, Activity, Job and workflow retry loops.

Heartbeats enable liveness/cancellation signaling for long Activities; they do not save a process or filesystem. Configure the runner's independent wall-clock deadline and termination grace even if every worker disappears. [Temporal Activity documentation](https://docs.temporal.io/develop/typescript/activities)

## Retry and rework taxonomy

| Result | Workflow action |
| --- | --- |
| transport/storage transient | Activity retries same ID; attach/reconcile existing work. |
| pod loss | Runner fences old allocation; restore acknowledged checkpoint in a new generation of the same logical run when viable. |
| deterministic setup failure | Stop retry storm; return blocked configuration with diagnostic artifact, wait for corrected version. |
| product assertion failed | Record semantic failure; route to implementation or relevant earlier discovery stage. |
| invalid/misleading oracle | Return to criteria/test review, create a new package version and invalidate dependent runs. |
| review finding | Route by finding category to execution, design or scope; bound iteration count. |
| inconclusive/flaky result | Run the declared diagnostic/repetition protocol; never convert an isolated later pass into success silently. |
| provider outcome unknown | Reconcile by stable external identity; wait/operator path if provider cannot establish outcome. |
| corrupt/forged/stale result | Reject, audit, invalidate allocation as appropriate; never let the model repair trusted provenance. |

Workflow-level automatic retries are disabled for TaskWorkflow. Domain failures are represented explicitly; worker crashes replay the same execution. An operator may create a controlled recovery task from accepted snapshots after an unrecoverable workflow defect, preserving links and reconciliation before any resumed side effect.

## Backward transitions and invalidation

Every stage output declares its dependency binding: task-spec, criteria, application snapshot, policy, plan, candidate, canonical package, recipe, environment and adapter versions as applicable. Hash only the declared complete input projection; a missing dependency is a contract bug.

On changed requirements, diagnosis, source, tests or environment plan: create a new immutable revision, walk the downstream dependency graph, mark those evaluations superseded, and schedule fresh nodes. Preserve unaffected evidence only when its declared inputs remain identical and reuse policy permits it. A task returning to “plan” is new history, not a Temporal history reset.

## Durable greenfield interviews

Greenfield templates 2.0.0 and later insert intent_interview, intent_challenge and intent_confirmation before foundation_design. Initial task criteria are provisional for discovery. Generate a bounded question batch, persist state/answer artifacts, release the runner and wait in waiting_input using a durable condition. Continue-As-New retains intentStateRef, question IDs and command dedupe; no native session is required to resume. Waiting consumes calendar lifetime but no active runner time. Deadlines/budget exhaustion preserve progress and produce an explicit incomplete/waiting outcome, never assumed assent.

A fresh reviewer checks the brief and proposed TaskSpec, then the workflow obtains exact-subject confirmation under ReviewMode. Approval applies the normalized spec through a serialized, idempotent version check and binds intentBriefRef with intentDecisionRef in human mode or aiIntentApprovalSetRef in ai_only. The gate evaluator enforces coverage, resolved conflicts, allowable assumptions and the applicable human or D5 panel authority. Answers arriving against stale questions/revisions cannot overwrite current intent. Changed intent supersedes pending confirmation and dependent evidence; unchanged approved intent can be reused through routine retries and unrelated plan changes. See [chapter 18](18-intent-interview.md).

## Human decisions and deadlines

Create a decision request bound to action+candidate/plan+policy hash, authorized roles, reason and expiry. Default wait is 72 hours; production release decision expires after 24 hours or any bound-input change, whichever comes first. Use timers/conditions, not a sleeping Activity. Reminders are in-product notifications by default; external messaging requires a configured integration and explicit organization policy.

An applied decision only resolves its own gate. New critical evidence, permission revocation or a changed release candidate requires reevaluation. Rejection may select an allowed alternative; it cannot be treated as missing input that loops forever.

Decision requests are routed to eligible deciders through configured channels with reminders, response targets and escalation to a backup decider. Overdue or expired requests never become approval. See [chapter 25](25-data-security-operational-safeguards.md).

## History, payloads and versioning

Factory handoff cap: 16 KiB serialized arguments/results. Stream tokens/logs to artifacts outside history. Soft history targets: 5,000 events or 5 MiB, or the SDK's Continue-As-New suggestion, whichever occurs first. Continue only at a safe boundary with no unfinished handlers and with active child/resource identities preserved. Store the full checkpoint artifact and pass its small reference plus dedupe/cursor identity. [Continue-As-New](https://docs.temporal.io/develop/typescript/workflows/continue-as-new)

Deploy workers with tested Worker Deployment versions and pinned workflow behavior. Keep old worker builds available until their pinned workflows finish or are deliberately migrated; Continue-As-New is not assumed to upgrade them. Replay representative stored histories before rollout. Schema readers and Activities must retain compatibility with still-running plans. [Worker versioning](https://docs.temporal.io/worker-versioning)

Do not design around maximum service limits: they differ by service/settings and can change. Verify configured payload, history, rate and pending-operation limits during M0 and load qualification. [Temporal limits](https://docs.temporal.io/evaluate/cloud/limits)

## Cancellation and disaster recovery

Cancel command sets a workflow-owned flag immediately. Stop admission; request runner cancellation; cancel/await active Activities; use bounded non-cancellable cleanup Activities to checkpoint, reconcile provider operations and persist cleanup obligations. The runner revokes the allocation epoch before a replacement can write. Force-termination of a Workflow is an operator incident procedure because it skips workflow cleanup; sweepers must still find all resources through durable ownership records.

Recovery reconciles Temporal task identity, DB operation ledger and actual provider resources before dispatch resumes. Restoring an old DB snapshot must not cause an already-created PR or environment to be recreated. Recovery procedures are specified in chapter 11 and tested in chapter 13.

## Agent requests and PR-review continuation

The factory tool server is part of a runner allocation, not a workflow per tool call. It persists sequenced receipts/events through the control plane. request_decision creates a deduplicated pending request scoped to task, node, input subject and question digest, then ends the run with needs_input after safe checkpointing. Human latency uses a durable workflow condition with no occupied runner. A nonblocking question may be recorded for later attention without pausing; it cannot stand in for a required policy decision. On the next semantic run, StageContext includes the authoritative answer refs and source binding. Human-only approval actions cannot be supplied by an agent request.

Templates greenfield 4.0.0 and existing_feature/bug_fix 3.0.0 contain a mandatory pr_review controller node after deliver and before close. For pr_created it reconciles the reviewable PR (current head, draft=false) and current evidence and finishes immediately. The qualified draft-preview preparation in chapter 10 runs under the trusted environment/verification controller before preview-dependent checks, records phase preview_only and never completes deliver or pr_review. Only passing current candidate gates authorize ready-for-review. For review_completed it waits for required authorized approvals on the current head and no unresolved changes requested. For merged it waits for reconciled merge and required integration evidence. Non-PR delivery resolves the same delivery_complete predicate through its scoped artifact/release outcome without inventing a PR. None of these paths marks a skipped node as a passed gate. Design templates (design-delivery/1.0) use the same controller with a fixed objective: it finishes when the design PR is reviewable at the reconciled head or the report artifact is finalized, and never waits for review or merge.

For the accepted no-change recipe branch (chapter 23), deliver reconciles the absence of a candidate, task branch, PR and pending publication operation and records publication as `not_required`, never as a passed publication gate. The controller still completes this reconciliation; it does not skip a required node. For an evidence-backed RecipeOutcomeRecord of `already_compliant` or `not_applicable`, pr_review checks the exact pinned task input, recipe and target revision and finishes immediately with phase `completed_no_change`, empty pullRequests and no lastCandidateRef. It records the recipeOutcomeRef and current gateEvaluationRefs; the trusted delivery_complete evaluation covers this no-change predicate. Missing, stale or inconclusive evidence cannot complete it. Other required gates and human floors remain unchanged; no PR is created and no human-review wait is entered.

In human mode the task remains running at the durable human-wait node with waitingReason pr_review; no authoring capacity is held. Review events are hints, followed by provider read-back. A changes-requested batch becomes one bounded review round and typed findings; route implementation findings to the execution node, design to the plan/design authoring node (which then reacquires exact-packet peer approval), scope to the discovery/intent node, and oracle to criteria. Environment and missing_evidence findings use controller reconciliation/evidence re-collection and are not return targets. Each changed candidate invalidates dependent results and returns its PR to draft/preview_only. For preview-dependent checks, run the deterministic pre-publication admission checks, reconcile draft=true before the expected-head push to the same PR, advance the environment generation, then independently verify exact head/digests and pass current gates before marking ready for review. Other revisions retain independent verification before reviewable publication. Embargoed tasks never use preliminary draft publication. A material plan change also reacquires all required exact-packet peer approvals. Repeated delivery of the same review cannot create a new round.

Default maximum is three semantic review rounds and the task's remaining calendar deadline; unchanged observations and infrastructure retries consume neither rounds nor semantic attempts. User-approved extensions revise the budget. On cap, deadline or explicit handover, record incomplete with handed_over and the outstanding findings. An unmerged close records incomplete/abandoned, not success. Terminal tasks do not reopen: later comments may create a linked follow-up only under configured owner-authorized policy. prReviewStateRef, expected heads, processed review identities, budgets and pending decisions survive Continue-As-New. A forged, stale-head or superseded approval cannot finish a newer candidate.

ai-review/1.0 uses newly pinned greenfield 5.0.0 and existing_feature/bug_fix 4.0.0 templates because review authority prerequisites change. The DAG/gate IDs remain mandatory. Controller review nodes dispatch bounded independent panel Activities using reviewer execution limits, not the human_wait calendar allowance as a runner cap; only actual human escalation waits occupy no runner. Checkpoints retain ReviewMode, decision, assignment, immutable AI approval refs and pending rounds; hidden audit assignment stays in control-plane storage. A mode loss invalidates affected approvals and routes the same nonterminal graph through human review before effects. Prior histories/templates retain human semantics until an explicit compatible migration; other work types require equivalently versioned, qualified templates before ai_only enablement.
