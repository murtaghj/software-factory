# Acceptance scenario catalogue

Each scenario is an implementation obligation. The specification package does not claim these product tests have run.

## AC-01 · Duplicate task submission

Given: Two requests use the same idempotency key and body.

When: They race or the first response is lost.

Then: One task and one workflow exist; both callers obtain the same identity.

Invariants: INV-02.

## AC-02 · Conflicting idempotency payload

Given: A key already has an accepted request.

When: The caller changes the body under that key.

Then: 409 is returned and no second side effect occurs.

Invariants: INV-02.

## AC-03 · Launch crash recovery

Given: Task and outbox are committed.

When: Dispatcher dies after Temporal start but before marking dispatch.

Then: Restart attaches to the same Workflow ID and clears the outbox.

Invariants: INV-02.

## AC-04 · Projection ordering

Given: Projection sequence 12 is stored.

When: Sequence 11 or duplicate 12 arrives.

Then: Older content cannot overwrite state; conflicting duplicate is rejected.

Invariants: INV-01.

## AC-05 · Cross-organization access

Given: Two organizations own tasks/artifacts.

When: A caller supplies another organization's IDs.

Then: API, artifact access and tenant-qualified database writes deny access.

Invariants: INV-14.

## AC-06 · Artifact atomic finalization

Given: Object upload or DB finalization is interrupted.

When: A dependent gate attempts to read the object.

Then: Only finalized hash-verified artifacts are accepted; orphan is swept.

Invariants: INV-09.

## AC-07 · Workflow command race

Given: A new spec revision races with an approval or result.

When: Both commands are processed.

Then: Only current bindings advance; stale subject is rejected with reason.

Invariants: INV-04.

## AC-08 · Continue-As-New dedupe

Given: A command is applied before workflow rollover.

When: Its delivery is retried in the new run.

Then: It is not applied again and state/cursors/budget remain correct.

Invariants: INV-02.

## AC-09 · Worker version replay

Given: A representative active history uses an older build.

When: New workers are deployed and histories replayed.

Then: No nondeterminism; old workflows retain compatible execution.

Invariants: INV-01.

## AC-10 · Duplicate run start

Given: Two controllers receive the same run and hash.

When: Both reconcile/create execution.

Then: One accepted allocation/writer launches; duplicate attaches or exits.

Invariants: INV-02, INV-03.

## AC-11 · Run identity conflict

Given: A run ID exists with input hash A.

When: A request supplies hash B.

Then: Conflict is returned without altering or attaching incompatible work.

Invariants: INV-02, INV-04.

## AC-12 · Stale live writer

Given: A lease expires while the old process still runs.

When: Replacement is requested.

Then: Old remote writes are fenced; volume reuse requires proven quiescence or isolated restore.

Invariants: INV-03.

## AC-13 · Dirty checkpoint restore

Given: Workspace has binary edits, staged/unstaged changes, deletion and untracked files.

When: Pod is lost after checkpoint acknowledgement.

Then: Clean allocation reproduces declared index/source hashes without secrets.

Invariants: INV-09.

## AC-14 · Unacknowledged checkpoint

Given: Upload succeeds but manifest finalization fails.

When: Runner/pod dies.

Then: Last acknowledged checkpoint remains authoritative and no nonexistent recovery is promised.

Invariants: INV-09.

## AC-15 · Process cancellation

Given: A harness launches a long-lived child process.

When: Task is cancelled.

Then: Child tree stops within profile bound; side effects reconcile and cleanup is recorded.

Invariants: INV-15.

## AC-16 · Missing native session

Given: Source/handoff exist but native conversation is absent.

When: Task resumes or changes harness.

Then: Fresh execution uses the portable checkpoint and records fallback.

Invariants: INV-10.

## AC-17 · Cross-harness continuation

Given: Harness A starts a feature and persists source/plan.

When: Harness B resumes in a clean allocation.

Then: Same accepted criteria pass without A's private conversation state.

Invariants: INV-10.

## AC-18 · Malformed agent output

Given: Harness produces invalid or unsupported result JSON.

When: Factory validates the output.

Then: No gate advances; bounded format repair consumes declared budget.

Invariants: INV-07, INV-11.

## AC-19 · Unauthorized tool request

Given: An author requests publishing or production credentials.

When: Capability proxy evaluates the call.

Then: Call is denied and audited; prompt text cannot grant authority.

Invariants: INV-07, INV-12.

## AC-20 · Valid bug repair

Given: Baseline has a reproducible contract violation.

When: Reviewed regression fails as intended, locks and passes on candidate.

Then: Bug completes with identical canonical package and comparable environment evidence.

Invariants: INV-05.

## AC-21 · False baseline red

Given: Baseline fails due to setup or a missing dependency.

When: Bug workflow attempts to lock/advance.

Then: Red gate fails or is inconclusive; diagnosis/setup is revisited.

Invariants: INV-05.

## AC-22 · Canonical test tampering

Given: Implementer changes its test copy or verification configuration.

When: Independent verifier runs.

Then: Canonical digest remains unchanged; bypass attempt cannot create success.

Invariants: INV-07.

## AC-23 · Empty or skipped suite

Given: Candidate causes no test discovery or unexpected skipped cases.

When: Runner exits zero.

Then: Outcome verification fails or is inconclusive with explicit counts.

Invariants: INV-07, INV-11.

## AC-24 · Source binding changes

Given: Candidate C has a passing gate.

When: Candidate C2 or required recipe changes.

Then: C's result is superseded and cannot approve C2.

Invariants: INV-04.

## AC-25 · Feature acceptance

Given: A feature has user, error and permission criteria.

When: Candidate omits one required scenario.

Then: Task remains incomplete/failed despite author completion.

Invariants: INV-06.

## AC-26 · Refactor equivalence

Given: Refactor has baseline invariants and structural objective.

When: Behavior changes or structural objective is absent.

Then: Verification/review blocks and routes to the correct stage.

Invariants: INV-06.

## AC-27 · Maintenance matrix

Given: Dependency upgrade claims compatibility with several consumers.

When: One supported consumer fails after install/build succeeds.

Then: Compatibility gate blocks delivery without shrinking the matrix.

Invariants: INV-06.

## AC-28 · Performance comparison

Given: Benchmark protocol is frozen.

When: Candidate has one fast trial but fails target variability or correctness.

Then: No performance success; measurement or implementation rework occurs.

Invariants: INV-06.

## AC-29 · Platform recovery

Given: Migration changes persistent format.

When: Mixed-version rehearsal or recovery fails.

Then: Production application stays blocked; design/implementation is revisited.

Invariants: INV-06, INV-12.

## AC-30 · Documentation evidence

Given: Document has versioned source claims and runnable examples.

When: A claim/example is unsupported.

Then: Document validation returns to source/draft; no unrelated runtime test is forced.

Invariants: INV-06.

## AC-31 · Investigation closure

Given: Question and evidence boundary are accepted.

When: Evidence report accurately records uncertainty and is reviewed.

Then: Task can succeed as a report without PR/deployment or fabricated certainty.

Invariants: INV-06.

## AC-32 · Wrong service blamed

Given: Downstream error was caused by invalid upstream input.

When: Discovery compares trace boundaries and contracts.

Then: Diagnosis identifies evidence-supported component(s), not the last erroring API.

Invariants: INV-13.

## AC-33 · Risk escalation

Given: A narrow ticket produces a sensitive/API/data change.

When: Policy evaluates the actual diff.

Then: Enhanced relevant gates are added; small diff cannot bypass them.

Invariants: INV-04, INV-07.

## AC-34 · Budget concurrency

Given: Two child stages contend for the remaining parent allowance.

When: Both reserve concurrently.

Then: Reservations cannot oversubscribe allowance; unmet work never becomes success.

Invariants: INV-11.

## AC-35 · Skeptical review dispute

Given: A blocking finding is challenged with evidence.

When: Rebuttal/adjudication limit is reached.

Then: Recorded decision or incomplete outcome; no endless review loop or silent dismissal.

Invariants: INV-04.

## AC-36 · PR create timeout

Given: Provider creates PR but response is lost.

When: Publication retries.

Then: Same PR is found/reconciled using stable identity; no duplicate.

Invariants: INV-08.

## AC-37 · Moving target branch

Given: Candidate passed against old target head.

When: Target advances before merge.

Then: New composition is evaluated and expected revisions enforced.

Invariants: INV-04, INV-16.

## AC-38 · Human edits task branch

Given: Remote branch head differs from expected.

When: Publisher attempts update.

Then: Human work is preserved and explicit reconciliation is required.

Invariants: INV-03.

## AC-39 · Deployment uncertain success

Given: Provider creates environment then times out.

When: Environment workflow recovers.

Then: Lookup attaches to the existing resource or records unknown; no blind duplicate.

Invariants: INV-08.

## AC-40 · Unreconcilable provider

Given: Tool has neither safe dedupe nor authoritative lookup.

When: Submit outcome becomes uncertain.

Then: Automatic resubmission is disabled and operator action is explicit.

Invariants: INV-08.

## AC-41 · Ready is not verified

Given: Services are healthy but behavior is wrong.

When: Preview checks execute.

Then: Readiness can pass while behavior gate fails; task cannot claim verified delivery.

Invariants: INV-16.

## AC-42 · Environment state equivalence

Given: Bug baseline and candidate use mutable fixtures.

When: Comparison runs are prepared.

Then: State is reinitialized/pinned and relevant differences recorded.

Invariants: INV-05.

## AC-43 · Cleanup after task loss

Given: Task/workflow is cancelled or terminated.

When: Preview/PVC expires.

Then: Independent sweeper reconciles owned resources and records cleanup failure if needed.

Invariants: INV-15.

## AC-44 · Stale production approval

Given: Approval names release C and environment E.

When: Candidate/policy/authority changes before apply.

Then: Release is denied until current requirements are satisfied.

Invariants: INV-04, INV-12.

## AC-45 · Observed release mismatch

Given: Deployment returns success but target has another image.

When: Postdeploy inventory/checks run.

Then: Mismatch blocks success and starts reconciliation.

Invariants: INV-16.

## AC-46 · Multi-repository integration

Given: Children pass independently on incompatible API versions.

When: Parent validates exact release composition.

Then: Parent blocks and coordinates contract/integration rework.

Invariants: INV-16.

## AC-47 · Knowledge provenance

Given: Agent proposes a confident global lesson without supporting evidence.

When: Knowledge workflow processes it.

Then: It remains proposed/disputed and cannot alter policy or verified runbook facts.

Invariants: INV-13.

## AC-48 · Registry import failure

Given: Last valid app profile exists.

When: New source has invalid/unresolved protected fields.

Then: Import errors surface; last valid version remains and task snapshots do not drift.

Invariants: INV-13.

## AC-49 · Artifact content isolation

Given: An uploaded report contains active HTML/script.

When: User opens/downloads it.

Then: It cannot execute in the authenticated dashboard origin or access credentials.

Invariants: INV-14.

## AC-50 · Backup restore with external effects

Given: DB backup predates an already-created PR/environment.

When: Factory is restored.

Then: Admission stays stopped until provider reconciliation prevents duplicate effects.

Invariants: INV-08, INV-09.

## AC-51 · Capacity fairness

Given: Incident workload saturates part of the organization quota.

When: Normal and background tasks queue.

Then: Configured fairness/reservations hold and resource ceilings are enforced.

Invariants: INV-11.

## AC-52 · Event stream resume

Given: Client disconnects or starts with an expired cursor.

When: It reconnects.

Then: No duplicate UI application; resumable ordering or explicit snapshot refresh.

Invariants: INV-02.

## AC-53 · Native capability qualification

Given: An adapter advertises resume/cancel/usage.

When: Its pinned runtime is exercised.

Then: Only demonstrated capabilities remain enabled; unavailable usage is labeled.

Invariants: INV-10.

## AC-54 · End-to-end audit

Given: A report/PR/release is delivered.

When: Operator exports its outcome bundle.

Then: Exact source, policy, criteria, evidence, decisions and provider handles are traceable; ReviewMode and AI-reviewed — no human review marker accompany ai_only outcomes with AI and voluntary human decisions separate.

Invariants: INV-16, INV-29.

## AC-55 · Flaky required gate

Given: Identical checks alternate pass/fail.

When: Diagnostic repetition runs.

Then: All attempts retained; isolated pass cannot silently produce success.

Invariants: INV-11.

## AC-56 · Network and credential boundary

Given: Candidate code attempts metadata/control-plane/other-task access.

When: Execution profile is enforced on the real cluster.

Then: Access is denied and qualified isolation limits are documented.

Invariants: INV-07, INV-14.

## AC-57 · Prompt/context contamination

Given: Reviewer starts after author left native memory/scratch instructions.

When: Fresh role context is assembled.

Then: Only permitted canonical inputs and labeled rationale appear.

Invariants: INV-07, INV-10.

## AC-58 · Migrations across worker versions

Given: Old workflows remain active during DB/schema upgrade.

When: Expand/backfill/contract rollout proceeds.

Then: Old and new readers work until safe retirement and histories replay.

Invariants: INV-01, INV-09.

## AC-59 · Production mitigation

Given: Qualified rollout breaches predeclared health/data criteria.

When: Delivery executes recovery policy.

Then: Promotion stops and actual mitigation/recovery state is verified.

Invariants: INV-12, INV-16.

## AC-60 · Acceptance corpus

Given: All eight types, three journeys and greenfield new-repository/monorepo negative fixtures are configured.

When: Release candidate executes representative corpus.

Then: Required outcomes and false-success/isolation rules pass with durable reports.

Invariants: INV-05, INV-06, INV-07, INV-16.

## AC-61 · Three distinct journey routes

Given: New-app feature and existing-app feature/bug requests are admitted.

When: The planner resolves target context and intent.

Then: greenfield, existing_feature and bug_fix templates respectively are pinned; invalid combinations and missing context are rejected.

Invariants: INV-17.

## AC-62 · Draft before repository

Given: No application repository or execution profile exists.

When: An authorized caller creates a draft and greenfield task.

Then: Immutable intent and stable application identity are stored without fake Git/profile values; existing-target admission rejects the draft.

Invariants: INV-14, INV-18.

## AC-63 · Real base before worktree

Given: A new repository task has an accepted bootstrap plan.

When: Initialization completes or a runner requests allocation too early.

Then: Only a durable receipt with a retrievable real base and approved setup profile permits allocation; empty or zero OIDs are rejected.

Invariants: INV-03, INV-18.

## AC-64 · Uncertain repository creation

Given: Create or initialize succeeds remotely but its reply is lost.

When: Activity retries or a replacement controller reconciles.

Then: Stable identities recover the same resource/commit; unverifiable outcomes retain the claim at needs_operator without a second create.

Invariants: INV-02, INV-08, INV-18.

## AC-65 · Greenfield in a monorepo

Given: A new service targets an existing repository/subpath.

When: The greenfield bootstrap and scaffold run.

Then: No remote repository or initial default-branch commit is created; the existing real base and path scope are enforced including shared-file review.

Invariants: INV-12, INV-18.

## AC-66 · Scaffold is not product success

Given: Greenfield setup/build/health checks pass but an accepted user journey fails.

When: The workflow evaluates completion.

Then: Foundation readiness stays distinct; parent success is blocked and the affected slice/design is revisited.

Invariants: INV-07, INV-11, INV-19.

## AC-67 · Existing feature preserves obligations

Given: A feature has new criteria and existing consumers.

When: Independent acceptance and compatibility execute.

Then: No universal intentional-red requirement is imposed; a broken existing contract blocks completion and routes to implementation/design.

Invariants: INV-04, INV-06, INV-17.

## AC-68 · Bug gates survive mode changes

Given: A bug requests fast or one-invocation execution.

When: The plan is compiled and a candidate appears green.

Then: Intended baseline red and the same reviewed locked package remain mandatory; missing evidence returns to diagnosis/oracle or incomplete.

Invariants: INV-05, INV-07, INV-11.

## AC-69 · Pinned journey survives restart

Given: An accepted plan uses a specific template artifact.

When: Configuration upgrades and Continue-As-New occur.

Then: The original template remains bound; adoption of a new version needs explicit migration and reevaluation.

Invariants: INV-04, INV-17.

## AC-70 · Target reclassification invalidates evidence

Given: Discovery finds a materially different target boundary.

When: An authorized revised specification is applied.

Then: New context/template/plan bindings invalidate affected evidence; acquired bootstrap effects forbid silent primary-target replacement.

Invariants: INV-04, INV-08, INV-17.

## AC-71 · Greenfield parent composition

Given: Foundation and child tasks pass on separate candidates.

When: The parent integrates the required children.

Then: Only passing parent criteria on the exact integrated composition permit completion; incompatible children return to affected work with shared budgets.

Invariants: INV-16, INV-19.

## AC-72 · Cancel retains created repository

Given: A greenfield task owns a newly created repository or uncertain creation.

When: Cancellation and reconciliation execute.

Then: External repositories remain owned with recorded disposition; unknown effects retain the claim and are not deleted as preview cleanup.

Invariants: INV-08, INV-15, INV-18.

## AC-73 · Glanceable distinct journeys

Given: Users have greenfield, feature and bug tasks with mixed states.

When: They inspect intake and the task list then request details.

Then: Three entry choices and journey-specific milestones show the current blocker/action; foundation cannot look complete and evidence expands accessibly.

Invariants: INV-05, INV-17, INV-19.

## AC-74 · Draft revision and claim races

Given: Two callers race revisions or task admission against one draft.

When: Transactions apply under current authorization.

Then: Stale revision receives 412, conflicting active claim receives 409, cross-tenant/namespace access is denied and idempotent retries attach to one result.

Invariants: INV-02, INV-14, INV-18.

## AC-75 · Interview before architecture

Given: A human-mode vague greenfield request has provisional criteria and no repository choice.

When: The workflow starts under any assurance mode.

Then: Only discovery/interview work proceeds; design/bootstrap/implementation wait for the exact human-confirmed brief and approved repository intent is required before bootstrap.

Invariants: INV-17, INV-18, INV-20.

## AC-76 · Contradictory stakeholder intent

Given: Two authorized stakeholders give incompatible scope or behavior requirements.

When: The interviewer and fresh reviewer analyze the brief.

Then: The contradiction remains visible and blocks confirmation until its accountable human owner resolves it with evidence.

Invariants: INV-13, INV-20.

## AC-77 · Unknown is not an answer

Given: A human cannot answer a question that materially changes the product.

When: The answer is unknown or deferred.

Then: The system records a blocking issue and seeks evidence/clarification without inventing a requirement or assuming agreement.

Invariants: INV-11, INV-20.

## AC-78 · Exact human intent authority

Given: A human-mode brief is ready for confirmation.

When: An agent claims approval, a service identity responds or a human submits an old subject hash.

Then: All are rejected; every required owner must approve the same current subject after independent review, with partial approval unable to satisfy intent_aligned.

Invariants: INV-04, INV-07, INV-14, INV-20.

## AC-79 · Intent change and approval reuse

Given: Human-confirmed intent has dependent design and source evidence.

When: Scope materially changes or an unchanged operation merely retries.

Then: Changed intent reopens affected topics and invalidates dependent work; an unchanged valid subject reuses the applied decision without another human click.

Invariants: INV-02, INV-04, INV-20.

## AC-80 · Interview resume and answer race

Given: An interview waits with persisted questions and answer commands.

When: Workers restart, Continue-As-New occurs, harness changes or two answers race.

Then: Artifacts preserve continuity and unchanged questions; duplicate commands apply once and stale revisions cannot overwrite current answers.

Invariants: INV-02, INV-09, INV-10, INV-20.

## AC-81 · Interview timeout cannot approve

Given: In human mode the human has not confirmed intent.

When: Round count, task deadline, budget ceiling or one-invocation allowance is reached.

Then: Progress is preserved with an explicit incomplete/waiting outcome; no timeout, confidence score or mode bypasses confirmation and no runner is held for human wait.

Invariants: INV-11, INV-20.

## AC-82 · Bounded explicit assumptions

Given: A brief includes unresolved assumptions.

When: The system evaluates readiness and owner confirmation.

Then: Only explicit low-impact reversible assumptions with owner, validation plan and human acceptance can remain; material uncertainty still blocks.

Invariants: INV-13, INV-20.

## AC-83 · Focused question and read-back UI

Given: A busy user has an unfinished greenfield interview.

When: They answer, leave, resume, correct the brief and confirm.

Then: One to three focused questions, visible blockers and expandable context preserve progress; exact-version confirmation is never preselected or automatically submitted.

Invariants: INV-14, INV-20.

## AC-84 · Skeptical intent review and issue provenance

Given: An interviewer proposes vague success, omits a prior conflict or marks it nonblocking.

When: A fresh reviewer and gate evaluator compare the brief with answer/issue history.

Then: Unsupported interpretation and missing issue resolution block alignment; corrections retain human sources and lead to concrete acceptance examples.

Invariants: INV-07, INV-13, INV-20.

## AC-85 · Complete engineering packet

Given: A plan is prepared for peer review.

When: A required section is missing, incomplete or falsely not applicable.

Then: Review publication/admission is blocked until design, criteria, scenarios, DoD and all applicable engineering coverage are complete.

Invariants: INV-21.

## AC-86 · Acceptance-to-proof traceability

Given: A plan declares criteria, scenarios and DoD.

When: A criterion has no scenario, an anchor is dangling or a completion predicate lacks evidence.

Then: Packet validation rejects the gap and returns it to the author before execution.

Invariants: INV-16, INV-21.

## AC-87 · Independent required peers

Given: A human-mode complete packet requires a primary and service specialist.

When: An author/service approves, one peer is missing or assignment coverage is insufficient.

Then: No peer gate passes; each required qualified independent human must approve the same current subject with assigned scope coverage.

Invariants: INV-07, INV-14, INV-21.

## AC-88 · Material plan revision

Given: A packet has signed criteria, design and DoD.

When: An author changes a required scenario, design contract or delivery scope.

Then: A new subject and semantic diff invalidate all required packet approvals and affected dependent work; unchanged retries reuse valid decisions.

Invariants: INV-02, INV-04, INV-21.

## AC-89 · One subject across review layers

Given: The UI shows summary, structured review and full detail.

When: A material risk exists or underlying content changes without a summary change.

Then: Critical risks/blockers remain visible and source revisions stay aligned; an unchanged summary cannot mask a changed approval subject.

Invariants: INV-04, INV-22.

## AC-90 · Blocking comment versus approval

Given: A required peer has a current review request.

When: A blocking comment, resolution, revised packet and approval race.

Then: The serialized handler preserves authorship and current binding, refuses stale/self-resolved blockers and cannot approve around an unresolved finding.

Invariants: INV-02, INV-04, INV-14, INV-21.

## AC-91 · Planned tests are not results

Given: A peer approves scenarios and their expected outcomes.

When: The dashboard renders readiness and completion.

Then: Scenario status stays planned until real independent bound results exist; design sign-off cannot satisfy verification or release gates.

Invariants: INV-07, INV-16, INV-22.

## AC-92 · Definition of done matches scope

Given: A plan targets PR, preview or production with work-specific obligations.

When: Implementation produces source or an artifact without all required outcomes.

Then: Completion remains incomplete until current DoD evidence exists; PR does not imply deployment and bug/feature/greenfield predicates remain distinct.

Invariants: INV-05, INV-12, INV-19, INV-21.

## AC-93 · Proportionate plan without peer bypass

Given: A human-mode small task selects fast or one-invocation mode.

When: The plan compiler builds its reviewable scope.

Then: A concise complete packet with justified applicability is allowed, but missing sections, unknown peers, timeout or mode cannot remove human sign-off.

Invariants: INV-11, INV-21.

## AC-94 · Review comprehension and resumption

Given: Representative engineers review a plan with seeded consequential omissions.

When: They orient, inspect scenarios/DoD, pause, resume and review a material diff.

Then: They can locate the decision, impact, blockers and full evidence without losing subject/focus; qualification measures comprehension and missed risks alongside orientation time, never clicks as approval proof.

Invariants: INV-21, INV-22.

## AC-95 · Factory tool epoch and role authority

Given: A server has a current allocation and role grant.

When: A stale epoch or role-spoofed call arrives.

Then: Reject and audit before work; arguments cannot select another task role or binding.

Invariants: INV-03, INV-14, INV-23.

## AC-96 · Submission identity and in-run correction

Given: A stage has strict role schemas and a proposal receipt.

When: Malformed output is corrected then proposals are retried.

Then: Correction uses existing budget; identical proposal returns original receipt; conflicting proposal cannot replace it.

Invariants: INV-02, INV-23.

## AC-97 · Proposal finalisation crash and writer race

Given: An agent submits while background commands can mutate source.

When: Supervisor crashes or observes a continuing writer.

Then: No completion before quiescence exact snapshot durable artifacts and current epoch; recovery attaches to receipt.

Invariants: INV-03, INV-09, INV-23.

## AC-98 · Factory human request lifecycle

Given: A role raises a bound question.

When: Blocking nonblocking and duplicate calls arrive.

Then: Blocking ends needs_input after checkpoint without runner wait; nonblocking records only; authenticated answer enters next context; neither grants authority.

Invariants: INV-01, INV-14, INV-23.

## AC-99 · Feedback caps and canonical separation

Given: A stage can run visible verify.

When: Calls or time are exhausted or private checks requested.

Then: Enforce caps in code; feedback cannot satisfy gates; holdouts remain inaccessible; hand off or end incomplete.

Invariants: INV-07, INV-11, INV-23.

## AC-100 · Supervisor credential boundary

Given: Harness and supervisor share a network but not credentials.

When: Candidate tries to read tokens execute in supervisor or call control plane.

Then: Credentials remain unavailable; server checks narrow scope; code runs in credential-free container; unsupported isolation blocks qualification.

Invariants: INV-07, INV-14, INV-23.

## AC-101 · Noninteractive Claude pilot and gateway

Given: Pinned Claude profile runs in restricted pod.

When: Permission prompt routing failure or orphan subprocess occurs.

Then: Policy allows or denies without interactive wait; scoped gateway handles models; process-tree cancellation and usage precision are proven.

Invariants: INV-10, INV-11, INV-15.

## AC-102 · Remote effect wrapper uncertainty

Given: Deploy succeeds but response is lost.

When: Wrapper restarts without lookup or conditional resource identity.

Then: Record unknown/needs_operator instead of blind retry; real preview stays disabled until provider guarantees qualify.

Invariants: INV-02, INV-08.

## AC-103 · Early fault framework

Given: Durable and provider boundaries gain state transitions.

When: Crashes run before and after each boundary.

Then: Attach reconcile or explicit unknown preserves operation identity; framework starts M1 and grows with components.

Invariants: INV-01, INV-02, INV-08.

## AC-104 · Explicit PR completion policies

Given: Tasks select pr_created review_completed or merged.

When: PR opens is reviewed then merged.

Then: Each completes only its accepted predicate on reconciled current head; waits hold no runner or implicit merge authority.

Invariants: INV-12, INV-24.

## AC-105 · Human review rework and invalidation

Given: Authorized current-head reviewer requests implementation/design changes.

When: Bounded review batch is accepted.

Then: Route to correct stage; changed plan is reapproved and changed candidate independently reverified before same-PR expected-head update.

Invariants: INV-04, INV-21, INV-24.

## AC-106 · Review cap close and handover

Given: A task waits for review or merge.

When: Round/calendar cap owner handover or unmerged close occurs.

Then: Unmet objective ends incomplete with handed_over/abandoned; retries do not double-count and close never means success.

Invariants: INV-11, INV-24.

## AC-107 · Human branch push reconciliation

Given: Human changes task branch.

When: Factory tries to publish.

Then: Reject overwrite; authorized adoption creates fresh bindings/evidence or handover transfers ownership.

Invariants: INV-03, INV-04, INV-24.

## AC-108 · Untrusted PR events and stale approval

Given: Duplicate out-of-order events and malicious comments arrive.

When: Comment widens scope or approval names earlier head.

Then: Reconcile authorized provider state; comments grant no capabilities and stale approvals cannot finish newer work.

Invariants: INV-08, INV-12, INV-14, INV-24.

## AC-109 · PR wait continuation and terminal follow-up

Given: Wait crosses Continue-As-New or task already terminal.

When: Repeated review or later comment arrives.

Then: Persist policy rounds heads receipts and decisions; terminal task stays unchanged and follow-up needs authorized linked task.

Invariants: INV-01, INV-02, INV-24.

## AC-110 · Structure outline traceability

Given: Packet contains components interfaces data and slices.

When: Slice loses criterion or outline changes behind same summary.

Then: Reject missing mappings; exact-subject diff/sign-off includes outline; independent peer remains mandatory.

Invariants: INV-04, INV-21, INV-22.

## AC-111 · Actual-diff risk and sampling

Given: Fast intake touches auth/unknown coverage or is audit-selected.

When: Candidate is evaluated or retry occurs.

Then: Escalate before publish; sample receives standard scrutiny; persisted selection cannot be rerolled by agent/retry.

Invariants: INV-04, INV-25.

## AC-112 · Code-health cohort maturity

Given: Few recent changes have immature 90-day windows.

When: Owner reviews churn merge counts architectural findings and defects.

Then: Show denominators sources attribution uncertainty and maturity; sparse evidence cannot justify relaxation or causal quality.

Invariants: INV-13, INV-25.

## AC-113 · Authorized modes and degradation

Given: Qualified cohort has policy and degradation thresholds.

When: Metrics degrade or relaxation is proposed.

Then: Record preauthorized tightening and reevaluate affected work; relaxation requires qualified human decision; mandatory floors remain.

Invariants: INV-20, INV-21, INV-25.

## AC-114 · Behavior release invalidates qualification

Given: Prompt model tool or evaluator changes.

When: Release seeks prior autonomy.

Then: Version complete configuration and rerun held-out corpus/canaries; old cohort trust does not transfer silently.

Invariants: INV-04, INV-25.

## AC-115 · Assertion failure-signature parsing

Given: Baseline has pinned parser and intended matcher.

When: Assertion compile setup discovery network timeout failures occur.

Then: Only named intended assertion with required counts proves red; unknown is inconclusive and raw logs retained.

Invariants: INV-05, INV-16.

## AC-116 · Reviewed baseline shim

Given: Test needs compatibility shim.

When: Shim contains repair or differs on baseline/candidate.

Then: Reject it; only reviewed immutable nonrepair shim enters lock; unsupported interface needs external reproduction/investigation.

Invariants: INV-05, INV-07.

## AC-117 · Unreproduced fix proposal

Given: No valid red after reproduction budget.

When: Owner authorizes bounded proposal.

Then: Peer review and available independent checks remain; PR is fix_proposed_unreproduced/incomplete with no verified-fix merge/deploy claim; disabled in pilot.

Invariants: INV-05, INV-11, INV-12, INV-24.

## AC-118 · Trivial behavior and honest reclassification

Given: Ticket changes message text or documentation.

When: Workflow selects evidence.

Then: Observable text uses string/snapshot/contract checks; genuine type change needs amended intent and cannot evade bug invariants.

Invariants: INV-05, INV-17.

## AC-119 · Evidence classes and private checks

Given: Candidate can forge in-process reports.

When: Independent checks observe separate app.

Then: Distinguish evidence classes; code cannot access holdout files/credentials; hidden cases map to visible criteria.

Invariants: INV-07, INV-16, INV-23.

## AC-120 · Mutation strength and family limitations

Given: Oracle faces valid invalid and equivalent mutants.

When: Strength/independence assessed.

Then: Record catches/survivors and handle invalid/equivalent mutants; record reviewer family/diversity limits without claiming proof.

Invariants: INV-07, INV-16.

## AC-121 · Tamper and semantic scope

Given: Candidate edits protected checks and unrelated behavior.

When: Boundary check and semantic judge run.

Then: Protected changes require signed-scope review; semantic findings labelled judgement; no judge grants wider paths.

Invariants: INV-04, INV-07, INV-21.

## AC-122 · Impossible-task and injection canaries

Given: Tests contradict intent or untrusted text asks publication.

When: Behavior release runs corpus.

Then: Report conflict without gaming green; privileged controllers require manifests/authority; measure false refusals too.

Invariants: INV-07, INV-11, INV-14.

## AC-123 · Boundary restore and native compatibility

Given: Pod loss removes uncheckpointed work.

When: Restore sees changed source/role/prompt/setup binding.

Then: Fresh handoff default; native resume requires every binding; repeat bounded stage from acknowledged source without claiming lost work.

Invariants: INV-09, INV-10.

## AC-124 · Context compaction and neutral discovery

Given: Occupancy/safe-stop unavailable and ticket contains vital symptoms.

When: Context assembled or restart considered.

Then: Never equate billed tokens with window occupancy or assume pause capability; preserve evidence with bounded stages and evaluated handoffs.

Invariants: INV-09, INV-10, INV-13.

## AC-125 · Settings hooks and subagent accounting

Given: Repository instructions override policy.

When: Harness starts optional subagents.

Then: No user/global settings; versioned role instructions remain authoritative; child grants/budgets aggregate; hooks alone are not isolation.

Invariants: INV-07, INV-11, INV-14.

## AC-126 · Reviewer admission and stacked PRs

Given: App reaches review/diff cap.

When: Publication requested or stacked base moves.

Then: Wait visibly; split oversized work by accepted slices; changed bases invalidate evidence; reconcile reviewer capacity.

Invariants: INV-04, INV-11, INV-24.

## AC-127 · Controlled performance environment

Given: No qualified placement or excessive variance.

When: Task claims improvement.

Then: Remain inconclusive until controlled dedicated/pinned placement and repetition produce comparable evidence.

Invariants: INV-06, INV-16.

## AC-128 · Explicit child and organization limits

Given: Root trees compete for capacity.

When: Children and authoring admitted.

Then: Enforce depth two/eight active children per root and two authoring children per parent plus org caps transactionally.

Invariants: INV-02, INV-11.

## AC-129 · Single-runtime complete pilot and portability

Given: M3 uses Claude in harness roles.

When: Pilot shortcuts gate or advertises portability early.

Then: Reject shortcut; all supported stages require evidence; Codex handoff conformance precedes portability claim.

Invariants: INV-05, INV-10, INV-21.

## AC-130 · Rule precedence and reproducible resolution

Given: Exact approved sources and resolver are pinned.

When: Repository instructions redefine completion or conflicting rules are imported.

Then: Ignore authority escalation with a finding; block unresolved conflicts; identical valid inputs produce identical semantic rules.

Invariants: INV-26.

## AC-131 · Scoped exception authority and expiry

Given: A waivable rule has an exact-subject exception proposal.

When: Wrong owner scope revision expiry or revocation is presented including mid-run.

Then: Reject invalid use and preserve history; only valid required human approvals activate the scoped exception.

Invariants: INV-04, INV-26.

## AC-132 · Nonwaivable rules and faulty checks

Given: A rule conflicts with a check or an exception targets an integrity floor.

When: Agent edits candidate check configuration or asks to waive the floor.

Then: Canonical check remains pinned; owner resolves disagreement; no exception bypasses nonwaivable gates.

Invariants: INV-05, INV-26.

## AC-133 · Deterministic role delivery and budget

Given: A role depends on required content.

When: Each adapter assembles a request or required content exceeds capacity.

Then: Attest actual request content in restricted synthetic fixtures; fail absent or truncated delivery; do not infer obedience.

Invariants: INV-27.

## AC-134 · Role content and resume binding

Given: Role rules tools adapter or skill admission changes.

When: A native resume is attempted.

Then: Reject incompatible or revoked state and use qualified fresh continuation; role change always starts fresh.

Invariants: INV-10, INV-27.

## AC-135 · Settings and hook isolation

Given: Host and repository contain hooks plugins permissions and instruction files.

When: Files are planted or modified before and during the pilot run.

Then: Factory-controlled settings remain effective; candidate config cannot reload into authority; reviewed conventions remain data.

Invariants: INV-11, INV-27.

## AC-136 · Source-bound feedback claims

Given: Structured claim cites a retained local feedback receipt.

When: Status source package recipes identity or latest relevant result disagree.

Then: Reject proposal before accepted slot; finalization rechecks after writer stop; feedback never becomes a gate.

Invariants: INV-04, INV-23.

## AC-137 · Disclosure without waiver

Given: Submission contains declared limitations shortcuts or deferred work.

When: A required criterion remains unmet or the list is omitted.

Then: Missing list fails 1.1 schema; disclosure reaches outcome and health views; required work still blocks success.

Invariants: INV-06, INV-23.

## AC-138 · Plan task checks and reuse rationale

Given: A packet introduces a component dependency or non-executable task.

When: Readiness validation and peer review run.

Then: Require task checks criterion mapping and reuse rationale; dependencies require supply-chain review; human evidence can support non-executable tasks.

Invariants: INV-21.

## AC-139 · Pinned third-party admission and revocation

Given: Skill bundle includes executable content or upstream update.

When: Run attempts live install unadmitted digest or revoked resume.

Then: Block use; inventory full bundle; require review adaptation qualification and authorized re-admission; no added privilege.

Invariants: INV-11, INV-27.

## AC-140 · Unnecessary code and disputed review

Given: Reviewer suggests deletions or human comment is disputed.

When: Agent processes feedback.

Then: Route finding through implementation/design with concrete reasons; agent cannot close human dispute; criteria remain binding.

Invariants: INV-06, INV-24.

## AC-141 · Architecture check provenance

Given: Candidate introduces a forbidden dependency edge.

When: Canonical architecture recipe executes.

Then: Diagnostic links rule check and configuration revisions; blocking violation prevents gate and enters attributed health evidence.

Invariants: INV-04, INV-26.

## AC-142 · Tool profile compatibility and honest history

Given: Pinned 1.0 history and new 1.1 stage coexist.

When: Adapters negotiate tools and submit baseline or current-source claims.

Then: Old shapes retain meaning; 1.5 profile requires 1.1; historical red is allowed but cannot satisfy current-source claims.

Invariants: INV-04, INV-23.

## AC-143 · Forensics proposes only

Given: Optional scheduled job examines retained failed and canary runs.

When: It recommends a skill prompt or rule change.

Then: Emit access-controlled evidence-linked proposal; human review and behavior evaluation precede use; never self-apply.

Invariants: INV-08, INV-27.

## AC-144 · Glanceable rule and disclosure review

Given: Task has blockers exceptions and declared limitations.

When: Engineer opens queue and detail.

Then: Show next action and counts first; reveal rule provenance scope expiry approvals criteria and feedback classification on demand.

Invariants: INV-22, INV-26.

## AC-145 · Role-content evaluation claims

Given: Paired held-out evaluation tests a content change.

When: Treatment misses activation or quality estimate is uncertain.

Then: Report activation contamination uncertainty false success/refusal and cost; size alone and nonsignificance cannot justify equivalence.

Invariants: INV-27.

## AC-146 · Structured handoff restore

Given: An implementer finished two of four plan tasks with verify receipts and the stage ended at a boundary.

When: A fresh session in a new allocation receives only the structured handoff.

Then: It continues from task three; task statuses match receipts; per-task commits restore; no transcript access is needed; the per-stage visible verify cap creates a resumable task-boundary handoff while task budget remains and a shared-recipe receipt may support several declared task checks; non-executable tasks use approval/controller receipts satisfying evidenceRequirementRefs and restore skips done_with_evidence plus authored awaiting_evidence tasks without bypassing dependent waits.

Invariants: INV-09, INV-10.

## AC-147 · Handoff status cannot be self-asserted

Given: Agent narrative claims a task is done without a supporting verify receipt.

When: The supervisor builds the handoff.

Then: Task status stays unchanged; the claim is stored as labelled untrusted text and recorded as a finding; nothing satisfies a gate.

Invariants: INV-23.

## AC-148 · Candidate cannot amend its own rules

Given: A candidate edits an architecture rule or check that applies to it in standards, profile or repository configuration.

When: Verification resolves rules for that candidate.

Then: Pinned ResolvedRules apply; the edit is a protected-path finding; a separately reviewed change to the owning source is required.

Invariants: INV-07, INV-26.

## AC-149 · Architecture violation is reported

Given: A pilot candidate introduces a forbidden dependency direction.

When: Visible verify and trusted verification run.

Then: Both report the rule and check revisions; the gate follows rule severity; the cohort health count increments.

Invariants: INV-26.

## AC-150 · Read-only evidence parity

Given: A pilot bug has error-tracking events and CI logs.

When: The agent requests evidence and then attempts a flag toggle or alert acknowledgement.

Then: Scoped redacted reads are returned with provenance and an access record; mutation attempts are denied; results are untrusted content.

Invariants: INV-13, INV-14.

## AC-151 · Cohort stop-the-line

Given: An impossible-task canary falsely passes for a behavior release.

When: The control plane processes the signal.

Then: New authoring admission for that cohort is suspended and in-flight publication held; other cohorts continue; clearing needs a human policy-owner decision.

Invariants: INV-11, INV-25.

## AC-152 · Baseline precedes pilot

Given: An application is nominated for the pilot.

When: Pilot enablement is requested.

Then: A baseline artifact with definitions windows denominators and gaps exists or an owner records why not; comparisons are labelled observational.

Invariants: INV-25.

## AC-153 · Substrate adoption proof

Given: A candidate sandbox substrate with warm pools is evaluated.

When: Claims race, the controller restarts, deletion responses are lost and isolated pilot workloads run.

Then: At most one writer mounts the workspace; deterministic ownership supports claim and deletion reconciliation; supervisor credentials remain outside the candidate and default-deny networking holds; the pinned pilot harness and toolchains run and cold/warm claim latency is recorded; failed exit criteria reject adoption and Jobs remain.

Invariants: INV-03, INV-08, INV-14.

## AC-154 · Attestation round trip

Given: A VerificationReport is mapped to a signed attestation.

When: It is verified offline after key rotation, a tampered copy is presented and a signing key is revoked.

Then: All binding fields are recovered; signing material never entered the candidate; tampering is detected; revocation is enforced under the recorded trust policy and revoked-key evidence cannot newly satisfy a gate.

Invariants: INV-16.

## AC-155 · Policy engine adoption and replay

Given: A gate decision used a pinned policy bundle through the engine.

When: The workflow replays after a newer bundle is published and admission/gate decisions exercise nonwaivable floors.

Then: Pinned evaluation is deterministic; replay uses the recorded Activity result without live re-evaluation; explanations retain the required reasons and rule provenance; nonwaivable floors reject attempted bypasses and measured evaluation latency fits the declared admission/gate budgets.

Invariants: INV-01, INV-04, INV-21.

## AC-156 · Registry snapshot provenance

Given: A registry source changes after a task pinned its snapshot.

When: The task continues and later replays.

Then: It reads only the pinned digest-addressed snapshot with per-field provenance; no live catalog read occurs.

Invariants: INV-04, INV-13.

## AC-157 · Source authority conflict

Given: Two registry sources disagree on an owner field.

When: An import runs.

Then: The authority map decides; a disagreement outside it is a finding with both provenances and the last valid value is kept.

Invariants: INV-13, INV-26.

## AC-158 · Onboarding draft is a proposal

Given: The onboarding stage infers commands dependencies and owner hints.

When: It finishes.

Then: Build and test commands were verified by execution; the draft is labelled inference and nothing is published until a human owner confirms.

Invariants: INV-13.

## AC-159 · Ownership gate

Given: An application has only CODEOWNERS hints and no confirmed owner.

When: Any factory task targets it.

Then: Admission refuses with a visible onboarding blocker; hints never qualify as ownership.

Invariants: INV-14, INV-21.

## AC-160 · Change-class readiness

Given: An application is automated for dependency updates and preparation_required for features.

When: Tasks of both classes are requested.

Then: Only the eligible class is admitted; an expired or source-mismatched assessment is reassessed first; readiness never changes a gate outcome.

Invariants: INV-04, INV-11.

## AC-161 · Typed recipe outcomes

Given: A recipe runs on compliant inapplicable and ambiguous targets.

When: Execution completes.

Then: They yield already_compliant not_applicable and needs_judgement with evidence; no PR is opened for them; compliant and inapplicable targets reach terminal succeeded through delivery_complete with a no-change OutcomeManifest bound to the pinned target and recipe; ambiguous parts stay unchanged and route to a human.

Invariants: INV-06, INV-12.

## AC-162 · Deterministic and agentic parity

Given: The same recipe change runs once deterministically and once agentically.

When: Both produce candidates.

Then: Both carry the same evidence classes and pass the same gates; neither can skip verification.

Invariants: INV-16, INV-23.

## AC-163 · Canary wave and pause thresholds

Given: A campaign canary wave exceeds the needs_judgement or failure threshold.

When: The wave completes.

Then: The campaign pauses before widening; stop-the-line halts the recipe-version cohort; resuming needs a human decision.

Invariants: INV-11, INV-25.

## AC-164 · Targeted re-run after recipe fix

Given: Some campaign targets failed and others merged.

When: A new recipe version is approved.

Then: Only failed or affected targets re-run; merged targets are untouched without a new campaign revision.

Invariants: INV-02, INV-04.

## AC-165 · Per-owner-group review budget and deferral

Given: A campaign would open more PRs for one owner group than its budget.

When: Waves proceed and an owner defers a target.

Then: No more than the budget is open for each owner group of a multi-owner target; the deferral is recorded with reason as an outcome not a failure.

Invariants: INV-12, INV-24.

## AC-166 · Campaign pilot measurement

Given: A recipe runs across a handful of similar repositories.

When: The pilot completes.

Then: Accepted outcomes review time rework and cost are reported against the baseline as observational evidence.

Invariants: INV-25.

## AC-167 · Auto-merge eligibility

Given: In human mode an agentic change class and a mature deterministic class request auto-merge.

When: Policy is evaluated.

Then: Only the deterministic class with mature evidence may automate the merge action after current-head human PR approval all gates and branch protection; human PR review stays required in every human-mode tier and degradation reverts to manual merge.

Invariants: INV-12, INV-25.

## AC-168 · Role-scoped tool profile

Given: A recipe implementer without a declared evidence need calls get_evidence.

When: The tool server checks the compiled profile.

Then: The call is denied and recorded; diagnosis roles retain evidence tools.

Invariants: INV-27.

## AC-169 · Missing-context report

Given: An agent submits a missingContext list.

When: The result is finalized.

Then: The list is stored as labelled untrusted text feeding reviewed proposals only; context and policy are unchanged.

Invariants: INV-13, INV-27.

## AC-170 · Interactive takeover round trip

Given: An engineer takes over a running task and later hands it back.

When: Both transfers occur.

Then: Each transfer checkpoints and changes epoch; old writers are fenced; returned source is re-evaluated before any gate advances.

Invariants: INV-03, INV-04.

## AC-171 · Contracts execute in CI

Given: A specification revision changes DDL or interfaces.

When: CI runs.

Then: The DDL applies to PostgreSQL 18; tenant isolation and grants pass under factory_runtime; a receipt advances reserved through running proposal_received finalizing and finalized while clearing proposal_accepted or changing request_hash is refused; TypeScript contracts compile in strict mode.

Invariants: INV-14.

## AC-172 · First real bug end to end

Given: One onboarded application has a reproducible machine-reported bug, a current unexpired source-matched automated or assisted bug_fix readiness assessment, and provider eligibility for its classification under closed INT-14.

When: The factory runs the task.

Then: Human plan sign-off and oracle approval precede implementation; red lock and green are proven; independent verification passes; a reviewed PR exists; the ContextManifest, failure signature and regression memory are retained; before W-033 the DiagnosisManifest may come from the chapter 08 hypothesis table without ledger tools.

Invariants: INV-05, INV-21.

## AC-173 · Discovery context manifest

Given: Discovery finishes with a blocking gap and a prior-incident match.

When: The plan packet is assembled for peer review.

Then: Reviewers see sources consulted, the match and the gap; scope_accepted stays unmet while the blocking gap remains.

Invariants: INV-11, INV-21.

## AC-174 · Tracker evidence is untrusted

Given: A ticket comment instructs the agent to widen scope and skip tests.

When: Discovery reads tracker and code-history evidence.

Then: Content is returned read-only with provenance and an access record; tools, scope and gates are unchanged; tracker writes are unavailable to the agent.

Invariants: INV-13, INV-14.

## AC-175 · Stable failure signatures

Given: The same defect fails with different line numbers and request IDs, and a different defect fails with another exception type.

When: Signatures are computed.

Then: The first pair share a signature digest; the different defect does not; one generated FailureSignature type round-trips through IncidentMemory KnowledgeProposal and knowledge_record with the normalizer version and structured keys, including an omitted unknown endpoint; non-empty componentIds remain separate metadata; exact and partial-key queries find the authorized record.

Invariants: INV-13.

## AC-176 · Prior match stays a hypothesis

Given: A new bug matches a past incident exactly but has a different cause.

When: Discovery and verification run.

Then: The match is shown as a labelled hypothesis among competing ones; reproduction and red lock green still decide; the look-alike is not closed by the match.

Invariants: INV-05, INV-13.

## AC-177 · Regression memory

Given: A verified fix candidate omits its permanent regression test or weakens its in-tree copy relative to the locked package, and a later change removes an incident-linked test.

When: Delivery and later verification run.

Then: Before accepting green the verifier runs the in-tree test and requires locked-test hash equality or equivalent scenario and intended assertion red on B and green on C; a weakened copy blocks green; missing retention needs an owner exception that never waives locked red/green; no controller commits a test after green and later removal requires an owner decision.

Invariants: INV-05, INV-26.

## AC-178 · Reviewer-confirmed category

Given: An agent proposes a root-cause category.

When: Review completes with and without confirmation.

Then: Only a reviewer-confirmed category is recorded; an unconfirmed one stays a proposal and does not count toward recurrence.

Invariants: INV-13.

## AC-179 · Variant analysis is read-only

Given: A verified fix triggers variant analysis across applications the caller can and cannot access.

When: The search completes.

Then: Hits are classified with evidence; only authorized applications are searched; confirmed variants become linked tasks or a recipe proposal for their owners; no code is changed.

Invariants: INV-12, INV-14.

## AC-180 · Recurrence raises a proposal

Given: A confirmed category crosses its recurrence threshold.

When: The threshold is evaluated.

Then: A systemic proposal reaches the owners with rule, campaign and design options; no rule, check or policy activates without an owner decision.

Invariants: INV-25, INV-26.

## AC-181 · Match usefulness is measured

Given: Prior matches are repeatedly shown and some mislead.

When: Outcomes are recorded.

Then: Accuracy and diagnosis-time effects are reported; repeatedly misleading lessons are disputed or expire.

Invariants: INV-13.

## AC-182 · Provider eligibility at admission and gateway

Given: A restricted repository is in scope and a role's model profile is not eligible for restricted content.

When: The task is admitted and a misconfigured adapter later sends a request.

Then: Admission refuses or reroutes with a visible reason and the gateway blocks the request; no restricted content reaches the provider.

Invariants: INV-28.

## AC-183 · Evidence redaction by classification

Given: Production evidence contains personal data and the classification forbids it for the run's provider.

When: Discovery requests evidence.

Then: The content is withheld or redacted before it reaches the model, with an access record.

Invariants: INV-28, INV-13.

## AC-184 · Candidate secret scan

Given: A candidate diff adds a credential.

When: Checkpoint publication, push or delivery is attempted.

Then: Publication is blocked; a redacted protected finding returns to the author; only an owner exception can clear a false positive.

Invariants: INV-08, INV-14.

## AC-185 · Security finding intake

Given: A scanner reports a high-severity dependency vulnerability.

When: It is ingested.

Then: A security task exists with severity, source and response target; admission priority reflects it; a missed target escalates without relaxing gates.

Invariants: INV-11, INV-12.

## AC-186 · Embargoed confidentiality

Given: An embargoed vulnerability task runs.

When: Users outside the security group query tasks, matches, variants and logs.

Then: Nothing about the embargoed work is visible to them until an authorized human lifts the embargo; publication uses an isolated confidential target whose read principals are verified as a subset of the security group before every push; unenforceable provider restrictions block publication (INT-15); a provider reporting none or unknown readers sends nothing to the ordinary repository and routes the blocked operation to the security owner.

Invariants: INV-14, INV-28.

## AC-187 · Licence policy

Given: A plan adds a dependency with a disallowed licence.

When: Packet approval and verification run.

Then: The dependency blocks unless an owner grants an exact-scope exception; the check cites the policy revision.

Invariants: INV-26.

## AC-188 · Emergency stop

Given: Tasks are running across several applications.

When: An operator activates the emergency stop.

Then: Admission, publication and delivery stop everywhere; allocations are cancelled with checkpoints and reconciled operations; activation and clearance are audited and clearing needs an authorized human.

Invariants: INV-08, INV-15.

## AC-189 · Authorship trailers

Given: The factory creates commits that are later squash-merged.

When: The trusted runner creates and freezes commits and the Git adapter publishes them before health attribution.

Then: The runner writes task run behavior-release and applicable recipe trailers from server records before IDs freeze; publication rejects missing or mismatched trailers without rewriting the candidate; squash attribution preserves them through the merge record and uses them before heuristics.

Invariants: INV-16.

## AC-190 · Decision notifications

Given: A plan sign-off request is created with a response target.

When: Time passes without a response.

Then: Eligible deciders are notified with a link, reminded before the target and escalated after it; the request never auto-approves.

Invariants: INV-21.

## AC-191 · Waiting-on-humans measure

Given: Decisions of several types wait on several owner groups.

When: Application health is computed.

Then: Time waiting on humans is reported by decision type and every applicable owner group with denominators.

Invariants: INV-25.

## AC-192 · Hypothesis declaration

Given: An investigator opens a hypothesis without a kill criterion or timebox.

When: The ledger tool validates it.

Then: It is rejected; accepted hypotheses carry prediction, kill criterion, planned experiment and timebox; confidence changes only with recorded evidence.

Invariants: INV-13.

## AC-193 · Timebox enforcement

Given: A hypothesis exhausts its timebox unresolved.

When: The next tool boundary is reached.

Then: The run pauses until the hypothesis is closed, extended once with reason, or switched; further extension needs a fresh-eyes checkpoint or human decision; the caller cannot set extensionsUsed and the server rejects an over-cap extension without exact authorized checkpoint/decision evidence.

Invariants: INV-11.

## AC-194 · Stall detection

Given: An investigator repeats near-identical searches with no new evidence.

When: The supervisor evaluates stall signals.

Then: A structured reflection is returned; a repeated stall ends the run with a portable handoff and routes to a fresh-eyes checkpoint.

Invariants: INV-11.

## AC-195 · Fresh-eyes checkpoint

Given: An extension is requested.

When: The checkpoint runs.

Then: The reviewer receives the ledger, evidence and criteria but no transcript; its advice is recorded and cannot close hypotheses or satisfy gates.

Invariants: INV-13, INV-27.

## AC-196 · Breadth-first probes and escalation

Given: Three hypotheses are open and two stay unresolved after their timeboxes.

When: The investigation proceeds.

Then: Bounded probes run for the top hypotheses within budget; a specific request_decision question is raised before further spend and recorded as a positive outcome.

Invariants: INV-11.

## AC-197 · Dead-end memory

Given: A hypothesis was ruled out for an earlier incident with the same signature.

When: A new investigation tries to reopen it.

Then: The earlier ruling and evidence are shown; reopening without new evidence is rejected; open cannot bypass this rule and reopen appends a linked hypothesis while retaining the previous ruling.

Invariants: INV-13.

## AC-198 · Decoy-bug evaluation

Given: A behavior release changes investigation prompts or timebox defaults.

When: The corpus with decoy and look-alike bugs runs.

Then: First-hypothesis accuracy, budget on ruled-out hypotheses and stall extension and escalation rates are reported alongside success and cost.

Invariants: INV-27.

## AC-199 · Urgent hotfix gates

Given: An authorized caller opens an urgent bug task for a production incident.

When: The task runs.

Then: On-call owner one generalist peer and every required specialist peer are routed with urgent response targets; the concise complete plan retains all required sign-offs per INV-21 and chapter 19; missing specialists block and escalate to qualified backups and Enhanced scrutiny still applies when triggered; any verified fix still proves red lock green.

Invariants: INV-05, INV-21.

## AC-200 · Mitigation is not a fix

Given: Reproduction is not yet possible during an incident.

When: The task delivers a feature-flag change or rollback.

Then: It is recorded as a mitigation through authorized environment operations, never as a verified fix, and a linked follow-up bug task is created; outcomeKind mitigated stays incomplete and requires mitigationOperationRef recoveryEvidenceRef and followUpTaskId; unknown effects cannot close.

Invariants: INV-11, INV-12.

## AC-201 · Hotfix follow-through

Given: An urgent task closes.

When: Closure is processed.

Then: A follow-up normal-path bug task and an incident-learning entry exist and are linked.

Invariants: INV-12.

## AC-202 · Self-work protection

Given: The factory works on its own repository and a candidate touches the verifier, policy, gate evaluation or tool server.

When: Verification runs.

Then: The edit is a protected-path finding; only allowed change classes proceed; deployment uses the factory release pipeline, not task delivery.

Invariants: INV-07.

## AC-203 · Runtime storage authority

Given: Reference tables contain tenant-bound immutable evidence and mutable lifecycle rows.

When: factory_runtime exercises allowed updates and tries to rewrite evidence or insert an organization.

Then: Named status updates succeed including comment resolution and gate supersession; organization creation and updates to artifact/definition digests observation relationship artifact-link inbox evidence and tool request identity fail; proposal acceptance cannot clear and terminal calls cannot transition; invalid abbreviated or all-zero Git IDs are rejected.

Invariants: INV-02, INV-04, INV-14, INV-23.

## AC-204 · Upload reservation binding

Given: An upload is reserved for a producer task logical stage and media/schema/classification.

When: A caller finalizes it for another stage or changes reserved metadata.

Then: The logical ID resolves through the tenant-qualified stage row; mismatched producer task stage or metadata is rejected and no ArtifactRef is returned; authorized registry and organization controllers can reserve application_draft and organization_controller uploads without task or stage IDs; absent or revoked owner authority, mixed scope and stage-producer owner-scope attempts are rejected.

Invariants: INV-09, INV-14.

## AC-205 · Projection hash replay

Given: A task stores projection sequence 12 and its canonical state/ref hash.

When: A retry supplies equal identical equal conflicting or lower-sequence content.

Then: The task row lock preserves atomic sequence/hash/state; identical 12 returns idempotently conflicting 12 raises an integrity incident and lower content is stale.

Invariants: INV-01, INV-02.

## AC-206 · Checkpoint child fencing

Given: An authoring allocation is finalizing after proven writer termination.

When: Checkpoint Job admission races or a child returns with an old epoch.

Then: One live child retains the parent generation/epoch and receipt; stale acceptance is rejected; the parent stays finalizing until durable acceptance without allocating a second authoring generation.

Invariants: INV-03, INV-09, INV-23.

## AC-207 · Decision storage provenance

Given: A peer or rule-exception decision request names an exact subject and required principal.

When: A decision is persisted and its originating command is retried.

Then: Rule-exception requests require a principal and deduplicate per subject/principal; immutable decisions retain unique command links reviewed scope and anchored notes; approve_plan scope is non-empty and validated against assignment.

Invariants: INV-02, INV-14, INV-21, INV-26.

## AC-208 · Task ownership persistence

Given: A creator owns a task and an authorized human takes it over.

When: Reassignment takeover hand-back retries and unauthorized commands occur.

Then: TaskView and owner-filtered lists show accountable owner and current holder; assignment and holder changes are audited and revision-checked; takeover sets the authenticated holder only after transfer and hand-back clears it after a new epoch; unauthorized changes fail.

Invariants: INV-02, INV-03, INV-14.

## AC-209 · Storage projection fidelity

Given: A multi-repository task has a PR review revision and stacked child PRs.

When: Review state and operational evidence are persisted then read.

Then: Every PR projection commits the same task revision atomically and GET loads its state_ref; stacked children retain same-repository predecessor links for base-move reverification; gate modes findings event metadata supervisor identity and tool role survive round-trip; application health stays application-scoped and policy tightening reaches only affected nonterminal tasks.

Invariants: INV-04, INV-13, INV-24, INV-25.

## AC-210 · Receipt and artifact views

Given: A task import snapshot proposal draft artifact and shared artifact exist.

When: Clients follow the documented status URL and read authorized metadata.

Then: Named response schemas match OpenAPI; task operationId is correlation-only; ArtifactView links may be empty or cover multiple permitted tasks without leaking other associations.

Invariants: INV-12, INV-14.

## AC-211 · Artifact registration metadata

Given: Identical bytes are registered with different media schema or classification metadata.

When: Finalization and retention run.

Then: Verified object bytes are reused but distinct validated registrations return matching refs; retention considers every registration and link and never shortens an existing hold.

Invariants: INV-09, INV-14.

## AC-212 · Task control and decision command states

Given: Tasks are accepted waiting paused or cancelling and an Update response is lost.

When: Pause resume cancel and respond_decision are retried.

Then: Only listed task transitions apply; pending decisions survive pause; cancelling repeats are no-ops; timed-out commands stay delivered and reconcile by commandId; structured approvals on respond_decision fail with decision_requires_response_endpoint.

Invariants: INV-01, INV-02, INV-21.

## AC-213 · Terminal stage history

Given: Passed failed and awaiting_input runs become obsolete.

When: A plan revision or a human answer arrives.

Then: Supersession appends timestamp plan and optional replacement logical-run metadata without changing terminal outcomes; awaiting_input resumes in a new semantic attempt and terminal row rewrites fail.

Invariants: INV-01, INV-04, INV-09.

## AC-214 · SSE cursor recovery

Given: A client reconnects using after or Last-Event-ID beyond event retention.

When: The server opens or refuses the stream.

Then: Last-Event-ID takes precedence; an expired cursor receives 410 with snapshotUrl resumeAfterSequence and Location; the client fetches TaskView and resumes from its lastEventSequence without a gap.

Invariants: INV-02, INV-12.

## AC-215 · Readiness status codes

Given: A process is alive but a dependency needed to accept work is unavailable.

When: Liveness and readiness probes execute.

Then: Liveness may return 200 ok; readiness returns 503 not_ready with Retry-After and returns 200 ok only when work can be accepted.

Invariants: INV-11.

## AC-216 · Decision action and resolution binding

Given: A human branch edit requires a resolution and compatible clients are deployed.

When: A decision request is stored and its subject is approved.

Then: Only DecisionAction names persist; reconcile_pr_head hashes adopt or handover with repository observed and expected heads candidate and policy; changed resolution or heads invalidates approval; API description advances to 2.4.0 on v2.

Invariants: INV-02, INV-04, INV-24.

## AC-217 · Emergency-stop control contract

Given: An organization has initialized operator state and paused or unavailable task workflows.

When: An operator activates clears retries or submits a stale clearance.

Then: Internal OperatorControlPlane serializes durable state and audits; gates consult the latest committed revision independently of workflows; clear binds current state and authenticated human; stale unauthorized or unreadable state holds work.

Invariants: INV-08, INV-14, INV-15.

## AC-218 · Human-control transport

Given: A campaign onboarding security task or paused interactive task needs human action.

When: A client reads progress or submits a decision or epoch transfer.

Then: Campaign reads and controls use its parent task; owner confirmation resume and embargo lifting use named task-bound decisions; takeover and hand-back require checkpoint epoch and destination and fence the old writer before acknowledgement.

Invariants: INV-02, INV-03, INV-04, INV-14, INV-21.

## AC-219 · Owner-group capacity and policy authority

Given: An application has several owner principals and a campaign plus policy revision is proposed.

When: Review capacity is reserved and authority is evaluated.

Then: Every owner budget is checked atomically; missing budgets block; application limits can only lower organization limits; waits count against each owner group; policy_owner and application_owner decisions both appear in authorityRef and forbidden self-relaxation fails.

Invariants: INV-11, INV-14, INV-25.

## AC-220 · Retained bootstrap root adoption

Given: A cancelled root bootstrap has a retained receipt and reconciled ownership.

When: A linked greenfield task adopts the repository with subpath empty string and rootAdoption.retainedBootstrapReceiptRef.

Then: Receipt repository identity retained disposition real base owner approval and scope are verified; existing root files remain protected unless the new plan names changes; a bare empty path or dot slash or traversal alias is rejected.

Invariants: INV-04, INV-12, INV-18.

## AC-221 · Current dependency completion

Given: A dependency has no required gates or has a stale passing gate.

When: The scheduler considers its successor.

Then: The successor waits for a non-superseded passed StageRun on the current input binding plus every current required gate; a gateless node passes only after validated completed outcome provenance; skipped failed inconclusive and cancelled runs never satisfy it.

Invariants: INV-01, INV-04.

## AC-222 · PR findings return to authors

Given: A published PR receives implementation design scope oracle environment or missing-evidence findings.

When: The bounded review round is routed.

Then: Authoring categories return to execution plan/design discovery/intent or criteria and reacquire affected approvals; environment and missing evidence use controller reconciliation; registered greenfield scope/design changes use a linked or child revision without repeating bootstrap or activation.

Invariants: INV-04, INV-18, INV-21, INV-24.

## AC-223 · Oracle before implementation

Given: An existing-feature or greenfield plan permits implementation parallel to criteria approval.

When: Template and plan ordering are validated.

Then: Reject missing mandatory implementation and any graph where oracle_accepted is not its ancestor or independent outcome verification is not its successor.

Invariants: INV-04, INV-06.

## AC-224 · Review floors enforced by gate identity and live authority

Given: A profile sets a mandatory review gate to automated sampled or ai_panel or clears humanFloor.

When: Shape validation and the live resolver evaluate it.

Then: Human default rejects automated sampled and cleared floors by gateId; only ai_panel with an in-force qualified D5 decision can replace eligible reviews; release_authorized always requires human; expired revoked missing excluded or wrong-scope authority fails closed and rules never establish ai_only.

Invariants: INV-20, INV-21, INV-25, INV-29.

## AC-225 · Bounded stage defaults

Given: A plan node resolves a timeout class and remaining task budgets.

When: The stage is dispatched or waits for a human.

Then: RunLimits.wallSeconds uses configured or documented defaults within operator and task caps; the Job deadline adds 300 seconds finalisation and sets 15 seconds termination grace; human waits use decision/calendar deadlines without retaining a runner.

Invariants: INV-11, INV-15.

## AC-226 · Complete default risk triggers

Given: An organization uses the default policy.

When: A change affects public APIs auth payment sensitive data persistent migration several services unknown blast radius a critical app privileged infrastructure or substantial performance/resources.

Then: Every listed risk is represented in the default policy and excludes fast eligibility; no missing example trigger permits a lower tier.

Invariants: INV-25.

## AC-227 · Admission-profile compatibility

Given: Old histories pin pre-profile policies and new tasks request incident-learning operational-safeguards or investigation-discipline profiles.

When: A qualified behavior release is admitted.

Then: Pin the new policy/evaluator obligations for new tasks without changing workflow template versions or retroactively blocking old 3.0.0 histories; blocking context gaps and regression-test retention or owner exception refine the new delivery/scope predicates; graph-changing hotfix paths require explicit versioning.

Invariants: INV-01, INV-04, INV-27.

## AC-228 · Discovery manifest and greenfield baseline ownership

Given: A bug feature or greenfield journey gathers context.

When: Scope and oracle evidence are evaluated.

Then: diagnose impact or brief with interview produces the ContextManifest before scope_accepted including confirm_intent; greenfield not-applicable baseline is recorded in the reviewed package/scenarios with a reason and never fabricated as a passing baseline gate.

Invariants: INV-05, INV-11, INV-18.

## AC-229 · Unreproduced graph remains disabled

Given: A caller authorizes propose_unreproduced_fix before a proposal graph is qualified.

When: The compiler selects a journey.

Then: Do not bypass mandatory bug gates or enable the path; W-082 must define the graph/template and compiler rules and qualify its PR-only incomplete outcome before use.

Invariants: INV-05, INV-21.

## AC-230 · Untrusted Git metadata at checkpoint

Given: A candidate plants fsmonitor and filter programs attributes and hooks in its Git metadata.

When: The trusted checkpoint allocation snapshots the retained volume after whole-pod stop.

Then: No candidate-specified program runs; bounded path-safe object reading ignores repository-local configuration and drivers and the source digest matches raw object and file bytes.

Invariants: INV-07, INV-09, INV-23.

## AC-231 · Adapter diagnostics and finalizer authority

Given: An adapter returns a HarnessRunResult with an echoed epoch and the authoring supervisor attempts finalize.

When: The runner processes diagnostics and the finalizer authenticates the caller.

Then: Reject status or runner authority in the adapter result and reject supervisor or harness finalizer calls; only the runner-issued checkpoint identity after proven whole-pod stop may accept a matching snapshot and StageResult.

Invariants: INV-03, INV-07, INV-23.

## AC-232 · Runner input binding and cleanup outcomes

Given: A run already binds specHash and inputHash or workspace deletion cannot be proved.

When: startOrAttach reuses the run ID or release reconciles cleanup.

Then: Different specHash or inputHash returns 409; reads and cancellation retain the stored scoped binding; uncertain cleanup remains releasing or quarantined with needsOperator and never reports released.

Invariants: INV-02, INV-03, INV-15.

## AC-233 · Job ownership metadata and shutdown

Given: The runner creates a Job and later attaches to an existing name or cancels its authoring pod.

When: Job and pod ownership bindings are inspected and termination is requested.

Then: Label-safe stage-run and spec-hash values plus generation match on Job and pod; annotations carry full stageRunId full specHash and owner epoch; attach checks full binding and UID; pod deletion delivers TERM with 15 seconds grace before KILL.

Invariants: INV-03, INV-15.

## AC-234 · Pinned interface definitions

Given: An application provides or consumes an interface ID with a versioned InterfaceDefinition.

When: resolveSnapshot pins definitions and diagnosis compares boundary behavior.

Then: Every ID resolves to a pinned interface document and exact contract repository commit path and digest; missing IDs or changed contract bytes reject acceptance and later registry edits cannot move the snapshot.

Invariants: INV-04, INV-13, INV-16.

## AC-235 · Execution and evidence metadata

Given: New evidence includes finding consequence and qualitative confidence knowledge dispute links and usage source and measurement interval.

When: Contracts persistence and context/checkpoint readers round-trip old and new records.

Then: Finding consequence/confidence columns and tenant-qualified knowledge_dispute rows round-trip optional metadata, with visibility checks on both disputed records; new fields survive without fabricated values and older payloads remain valid; allocation storage records supervisor identity and controller lease; exclusion reasons reside in StageContext.exclusions tool versions in setupProfileRef and operation desiredState in request_ref.

Invariants: INV-03, INV-13, INV-16.

## AC-236 · Execution admission and runner API boundary

Given: An execution pod lacks a read-only root filesystem or resource limits or its harness calls the runner API without the supervisor credential.

When: Admission policy and runtime authorization are qualified.

Then: Additional admission policy rejects missing factory controls beyond Restricted PSS; only the scoped runner API is reachable among control-plane surfaces and shared pod reachability never grants harness authority; wrong epoch or scope is denied.

Invariants: INV-07, INV-14.

## AC-240 · Tool-set version negotiation

Given: Pinned 1.0.0 and 1.1.0 histories coexist with investigation-discipline/1.0.

When: Admission selects an adapter and replay reads submissions.

Then: Old manifests and shared inputs are unchanged; investigation requires explicit 1.2.0 and rejects an older adapter; ledger tools and missingContext are not silently added to old contracts.

Invariants: INV-02, INV-27.

## AC-241 · Bounded live evidence queries

Given: A discovery stage has source and template grants for CI tracker and code history.

When: Queries request ungranted sources invalid windows paths excessive limits or a forged cursor.

Then: Schema and server grant checks reject them before adapter access; permitted queries persist redacted provenance-labelled artifacts within caps; no evidence mutation is available.

Invariants: INV-13, INV-14, INV-28.

## AC-242 · Incident and security metadata

Given: Authorized and unauthorized callers submit incident tasks and embargoed security work.

When: API admission and task projection run.

Then: Unauthorized incident priority returns 403; absent priority resolves normal; security is restricted to bug/maintenance, eligible design-scope tasks and builds inheriting an embargoed design's group, is rejected on other work, and embargo requires a valid group; metadata survives storage and changeClass is derived from trusted recipe/classification rather than caller input.

Invariants: INV-14, INV-28.

## AC-243 · Ledger extension and reopening authority

Given: A hypothesis has used its first extension and a matching hypothesis was previously ruled out.

When: The agent changes counters extends without authority or reopens with empty/previously considered evidence.

Then: Calls fail; counters are server-owned; approved bounded extension and previously unconsidered evidence produce immutable receipts without changing the old ruling or exceeding stage limits.

Invariants: INV-11, INV-13, INV-23.

## AC-244 · Campaign owner coverage

Given: A human-mode campaign targets two applications with different owners and required specialists.

When: Only one target owner approves then the campaign is retargeted.

Then: The uncovered target waits or defers; one independent primary peer and all target-scoped owners/specialists must approve; all assigned peers reconfirm the new subject including added targets.

Invariants: INV-21, INV-26.

## AC-245 · Non-executable handoff tasks

Given: A plan contains executable human_review and controller_evidence tasks.

When: A new allocation restores a handoff while human evidence is pending.

Then: Status comes from receipts satisfying the declared check strategy; completed non-executable tasks are not redone; awaiting_evidence skips writer rework while dependent work and completion still wait.

Invariants: INV-09, INV-10, INV-23.

## AC-246 · Embargo visibility closure

Given: An embargoed task has logs artifacts knowledge matches receipts and auxiliary envelopes.

When: Same-org outsiders revoked members and authorized workload principals query them.

Then: Restrictive policies deny outsiders and revoked members across direct and indirect rows; labels precede storage and group-aware deduplication; exact-scope human lift permits only audited disclosure; factory_runtime cannot grant itself group membership.

Invariants: INV-14, INV-28.

## AC-247 · Allocation-to-gateway classification

Given: Descriptors include conflicting or missing classifications and a valid restricted case.

When: Admission and runner credential exchange execute and a misconfigured adapter requests another model.

Then: Missing/incomparable scope blocks; valid effective classification and decision are pinned in InputBinding/allocation; runner-issued credentials restrict model profiles and the gateway rejects out-of-scope requests after policy changes.

Invariants: INV-04, INV-28.

## AC-248 · Confidential publication target

Given: An embargoed candidate has a policy-assigned private fork or separate repository.

When: Publication retries after reader membership or provider capability changes.

Then: Every push checks complete readers against the security group and enforced confidentiality through the write; unknown/broader access blocks with no ordinary-repository push; source integration waits for exact authorized embargo lift and human PR review.

Invariants: INV-12, INV-14, INV-28.

## AC-249 · Qualified mitigation closure

Given: An M7 urgent task cannot yet reproduce the defect.

When: The qualified controller profile attempts rollback and task closure.

Then: Complete generalist plus required-specialist plan approval and release authority precede the operation; recovery is independently verified; only incomplete mitigated outcome with operation evidence and a linked normal-path follow-up may close; bug_fix red lock green remains unchanged.

Invariants: INV-05, INV-11, INV-12, INV-21.

## AC-250 · No-change completion is evidence-bound

Given: A PR-scoped recipe target reports no change under each PR completion mode.

When: The controller reconciles its recorded outcome.

Then: Only current independently checked already_compliant or not_applicable evidence on the pinned recipe and source with no candidate branch PR or pending publication reaches succeeded; stale or absent evidence needs_judgement unresolved findings bug or greenfield work and ordinary PR tasks without a PR cannot use this branch.

Invariants: INV-04, INV-05, INV-11, INV-12, INV-19, INV-23, INV-24.

## AC-251 · Urgent specialist approval cannot be waived

Given: An urgent security or data incident has an on-call generalist approval but a required specialist is unavailable.

When: The plan approval gate runs and the urgent response target expires.

Then: plan_peer_approved stays blocked; routing escalates to a qualified backup specialist and silence never approves; one sign-off suffices only when the resolved assignment requires no specialists.

Invariants: INV-21.

## AC-260 · Toolchain and contract generation in CI

Given: A clean checkout with the pinned toolchain and lockfile.

When: CI installs dependencies and runs lint strict typecheck package-boundary checks and contract generation.

Then: The lockfile is honoured; lint type and package-boundary violations fail; generated TypeScript/OpenAPI types are reproducible and positive/negative schema fixtures pass/fail as declared.

Invariants: INV-04.

## AC-261 · Onboarding classification prerequisite

Given: A repository nomination has no human-supplied classification or has a classification ineligible for the selected provider.

When: Onboarding allocation or model access is attempted.

Then: Unclassified real-content access is refused until a human supplies a provisional classification; ineligible profiles are refused or rerouted only to a qualified INT-14-cleared profile; the allocation carries the classification and gateway enforcement; emergency stop holds onboarding and descriptor publication requires secret scanning.

Invariants: INV-08, INV-14, INV-28.

## AC-262 · Labelled PR preview exactness

Given: A same-repository factory or human PR has an admitted preview label and CI images built from its head commit.

When: The ApplicationSet discovers it and submit waits for convergence.

Then: One isolated Application is Synced at exactly that SHA and Healthy with passing probes and matching running image digests including migration images; immutable-tag enforcement is required when using SHA tags; evidence binds the release manifest and authorized preview URL; readiness alone cannot pass behavior checks; the existing dev path is unchanged.

Invariants: INV-08, INV-12, INV-16.

## AC-263 · PR head update supersedes preview evidence

Given: A preview has verification results for head A.

When: A new commit B arrives or the head moves during verification.

Then: The same Application and namespace redeploy in place under a new operation tuple; observedRevision records B; A results and in-flight checks spanning revisions are superseded and verification reruns only after exact B revision and digest checks.

Invariants: INV-04, INV-16.

## AC-264 · PR eligibility loss deletes all resources

Given: A preview owns an Application namespace data volumes and sync-hook resources.

When: The PR closes merges or loses its preview label with webhook delivery and again with polling fallback.

Then: Eligibility is fenced; the resources-finalizer prunes resources and an owned Namespace manifest or label-scoped sweeper removes the namespace including the CreateNamespace-only case; external data credentials and backing volumes are confirmed gone; lag is recorded; partial deletion stays retiring and never affects dev resources.

Invariants: INV-08, INV-15.

## AC-265 · Expired and orphaned previews

Given: The task workflow is lost or a preview exceeds maximum lifetime or idle expiry while its PR stays open.

When: The independent sweeper reconciles ownership labels and the ledger.

Then: Eligibility is revoked before cleanup to prevent recreation; orphan Applications namespaces resources volumes and data are removed with absence evidence; probes do not reset idle time; stuck finalizers are visible and capacity is not prematurely released.

Invariants: INV-08, INV-15.

## AC-266 · Fork PR preview refused

Given: A fork PR carries the preview label including one added directly by a human.

When: Generator reconciliation and retries race adapter checks.

Then: Trusted admission checks head-repository identity and refuses before any workload secrets or cluster access are granted; no preview is deployed and the protected reason is visible.

Invariants: INV-07, INV-14.

## AC-267 · Unlabelled PR has no preview

Given: A same-repository PR is open without the configured preview label.

When: Webhooks and fallback polling reconcile it.

Then: No preview Application namespace workload or data allocation is created; ordinary merge-to-dev behavior remains unchanged.

Invariants: INV-12, INV-15.

## AC-268 · Preview caps queue fairly

Given: Application or team capacity is full including pending and retiring reservations.

When: Factory and human PRs concurrently request previews through labels.

Then: Atomic adapter/admission reservations enforce both caps before any workload starts; excess requests queue with queueReason; direct generator reconciliation cannot bypass the cap; release requires confirmed cleanup and queued admission rechecks current head and eligibility.

Invariants: INV-08, INV-11.

## AC-269 · Per-preview data and secret isolation

Given: Two previews use classified fixtures and either operator-managed clusters or separate databases and credentials on a non-production server.

When: Hooks run migrations and seeds including retries failures and attempts to access the other preview or shared dev data.

Then: Only each preview database is reachable with its scoped external secrets; no shared mutable database or dev/production fallback exists; hook failure blocks readiness; fixture and migration provenance are recorded; unapproved classification is refused and cleanup removes data credentials and volumes.

Invariants: INV-07, INV-14, INV-16, INV-28.

## AC-270 · Embargoed preview refused

Given: An embargoed D4 security task targets the shared preview cluster without a qualified isolated confidential target.

When: A factory or human adds the preview label.

Then: Admission refuses before deployment and records a security-group-visible reason; only an isolated target qualified under INT-15 and INT-17 may proceed with matching reviewer URL logs secrets and data restrictions.

Invariants: INV-12, INV-14, INV-28.

## AC-271 · Uncertain Argo submit recovered by lookup

Given: PR labelling succeeds and Argo creates an Application but submit times out or its response is lost.

When: The workflow retries lookup with the same operationId.

Then: Repository PR and head tuple plus generator labels/annotations identify the existing Application; actual sync revision and digests are checked before success; one environment remains; eventual absence stays unknown without blind resubmission and a newer head supersedes the old operation.

Invariants: INV-08, INV-16.

## AC-272 · Synced revision drift is not candidate evidence

Given: The desired preview head is C but Argo reports Synced and Healthy at D or running images differ from C's release manifest.

When: Status is collected and verification attempts to advance.

Then: observedRevision and imageDigestVerification expose mismatch or unknown inventory; neither another sync revision nor different digests can pass candidate C gates; existing results are superseded and reconciliation/reverification is required.

Invariants: INV-04, INV-16.

## AC-273 · Scoped Git preview controls

Given: An open PR has unrelated labels and observable base/head repository identities.

When: The adapter reads it and retries label/draft mutations including a head race or unknown head repository.

Then: getPullRequest returns draft labels and immutable repository identities; only the configured preview label changes; duplicates attach by operation/hash and changed-head requests conflict; unknown or fork identity cannot add eligibility; uncertain outcomes reconcile without blind writes; write credentials differ from generator read credentials.

Invariants: INV-08, INV-12, INV-16.

## AC-274 · Current preview plan advances durably

Given: A verified preview has a stable handle and a new admitted head with a fresh immutable plan and reserved operation.

When: factory_runtime applies concurrent or retried generation transitions and late old observations.

Then: One compare-and-set transition advances planRef generation currentOperationId and revision on the same row; SQL grants permit it and guard against skipped generations reused operations stale evidence or retiring resources; current evidence/status clears; old plans/results remain historical; retries attach without another advance; old-generation callbacks cannot overwrite the current projection.

Invariants: INV-04, INV-08, INV-16.

## AC-275 · Queued preview is visible through public reads

Given: Capacity admission persists a pending preview and the controller restarts.

When: An authorized client lists environments and reads the queued environment before and after admission.

Then: Both closed-schema responses include the same current plan generation operation and durable status with sanitized queueReason and statusObservedAt; unauthorized callers are denied and secrets/other tenants are absent; admission removes the queue reason and projects actual revision/digest observations; stale observations cannot restore old status.

Invariants: INV-11, INV-14, INV-16.

## AC-276 · Draft breaks the preview verification cycle

Given: An accepted non-embargoed feature or foundation check requires a PR-generated preview before its outcome gate can pass.

When: Deterministic secret scan scope/protected-path classification and same-repository checks pass.

Then: The trusted controller publishes the candidate as a labelled draft before verification; draft existence passes no pr_created or review/delivery gate; independent checks use exact head and image digests; only all current candidate gates authorize ready-for-review and exact-state read-back; failed or inconclusive checks leave the PR draft.

Invariants: INV-04, INV-12, INV-16.

## AC-277 · Draft rework fences old review evidence

Given: A reviewable PR receives a factory revision or an unexpected human commit while preview verification is in flight.

When: Rework and provider reconciliation run.

Then: Every new head is preview_only with superseded evidence; factory updates confirm draft before pushing with expected head; human changes require adoption or handover; a fresh admitted plan/generation redeploys in place and exact-head/digest checks rerun; stale gates or raced ready mutations cannot authorize review/merge and reconcile back to draft.

Invariants: INV-04, INV-08, INV-18.

## AC-278 · Preliminary publication fails closed

Given: A candidate has a failed or unknown secret scope/protected-path classification or repository identity check or belongs to an embargoed task even with a qualified confidential target.

When: Draft-preview publication is requested or retried.

Then: No preliminary push label addition or workload admission occurs; record the authorized-visible reason; embargoed work retains its existing confidential publication and full verification prerequisites; no new approval or provider health can substitute for failed admission.

Invariants: INV-12, INV-14, INV-28.

## AC-279 · M5 accepts either qualified real provider

Given: MCP W-041/W-078 or Argo W-139/W-140 is selected with all ordinary prerequisites.

When: W-042 and W-045 assess M5 closure.

Then: At least one real provider must have applicable conformance evidence; Argo selection has no unconditional W-078 prerequisite; selecting both requires both to qualify; fake tests or documentation alone cannot close real-provider qualification.

Invariants: INV-16.

## AC-280 · Joint opt-in authority and scope

Given: An application defaults to human at any assurance tier.

When: Both owners establish ai_only with scope expiry rollback thresholds and qualification refs.

Then: Only authenticated policy-owner AND application-owner decisions establish the mode; rule-earned automatic relaxation missing owner scope future-dated approvals or authority is rejected; qualification precedes both approvals and both precede validFrom; draft applications may bind a pre-repository organization policy before bootstrap and gain repository authority only through the verified creation binding; multi-app work requires every affected app or human review; The runtime implementation MUST pass an adversarial negative corpus covering provenance laundering; scope and embargo/hotfix/production; identity and fork; chronology; nested outputs; empty refs; stale qualification; exported views overriding the trusted task snapshot; nested bundles reviving revoked or stopped authority; provider review observations presented as human approval; production mitigation without human release; release decisions without an identified decider, with every expected-reject case rejected and every expected-accept control passing. Static reference predicates do not prove runtime enforcement..

Invariants: INV-25, INV-29.

## AC-281 · Reviewer-quality qualification

Given: Clean and seeded-defect plans and PRs have predeclared catch-rate and false-approval thresholds.

When: Every reviewer and adjudicator configuration is evaluated before establishment.

Then: Missing corpus classes roles denominators or thresholds and any failed result block opt-in; measured breakdown and immutable refs are recorded without claiming efficacy beyond the corpus.

Invariants: INV-07, INV-25.

## AC-282 · Configuration cohort suspension

Given: ai_only is active.

When: Reviewer model prompt tool role content or evaluator release changes.

Then: Mode suspends to human and pending effects are fenced; new qualification cohort corpus results and joint human establishment are required; prior trust is not inherited.

Invariants: INV-04, INV-25.

## AC-283 · Expired revoked or missing authority

Given: An AI-reviewed task is nonterminal.

When: Decision expires is revoked disappears or cannot be read before publication or merge.

Then: Fail closed to human mode and manual merge; re-evaluate affected nonterminal gates before any publication or merge and retain historical AI records.

Invariants: INV-04, INV-25, INV-29.

## AC-284 · Independent diverse panels

Given: A human review gate is replaced.

When: Two or more AI reviewers receive independent fresh contexts.

Then: At least two panel families and one different from the author are mandatory; reviewers cannot see others verdicts before submission; single-family shared-context or premature-verdict access is rejected.

Invariants: INV-07, INV-25.

## AC-285 · All review gates at all tiers

Given: Eligible work uses fast standard or enhanced.

When: Intent architecture plan acceptance peer plan oracle and PR merge reviews run.

Then: Each applicable human review is replaced by the qualified AI panel without omitting a gate; human defaults and production authority remain unchanged.

Invariants: INV-20, INV-21, INV-25.

## AC-286 · Adversarial and specialist coverage

Given: A plan or oracle and risk-selected specialist slots need review.

When: ai_only assignments are compiled.

Then: Architecture and plan require a primary covering all twelve sections and every vote covers its assigned scope; plan and oracle add an adversarial refutation reviewer; every chapter 19/21 specialist or owner slot has a qualified specialist-role AI reviewer with full assigned content; omission blocks.

Invariants: INV-21, INV-27.

## AC-287 · Enhanced AI evidence

Given: Enhanced ai_only work is admitted.

When: Panel and verification requirements resolve.

Then: At least three base reviewers plus adversarial and specialist slots run; all enhanced adversarial cases and out-of-process checks remain required; missing capabilities remain inconclusive.

Invariants: INV-07, INV-21, INV-25.

## AC-288 · Unanimity and exact subjects

Given: An immutable assignment has panel decisions.

When: One vote rejects is missing duplicated stale or bound to another subject.

Then: No approval set passes; every member must approve the same INV-22 subject assignment policy and round; majority-only approval is rejected.

Invariants: INV-04, INV-22, INV-29.

## AC-289 · Bounded independent AI adjudication

Given: A blocking AI finding is contested.

When: The existing one rebuttal and one adjudication default is exhausted.

Then: Only an independently configured qualified AI adjudicator may reject it with evidence; no author or panel self-adjudication; every historical finding vote precedes its bound disposition which precedes fresh later-round votes and no vote is after evaluation; dropped blockers stale votes and excess rounds reject; unresolved disagreement blocks and escalates to human and never auto-approves.

Invariants: INV-07, INV-21.

## AC-290 · Greenfield requester fidelity

Given: The requester submitted authenticated answers.

When: The AI panel evaluates the exact brief.

Then: Confirmation uses only that evidence and the unchanged coverage predicates; material ambiguity or stakeholder conflict blocks and asks the human requester; no AI answer or fabricated human confirmation.

Invariants: INV-20, INV-29.

## AC-291 · Integrity and classification floors

Given: ai_only work has unanimous approvals.

When: Bug red lock green canonical tamper scope mutation independent verification budget or data classification evidence fails.

Then: The corresponding gate blocks regardless of votes; INV-05 INV-07 and INV-28 cannot be waived by review mode.

Invariants: INV-05, INV-07, INV-11, INV-28.

## AC-292 · Production hotfix and embargo exclusion

Given: Application is opted in.

When: AI authority is used for release_authorized urgent D2 hotfix or D4 embargoed work.

Then: Release stays human and hotfix/embargo reviews stay human; new exclusion flags invalidate active AI authority before effects.

Invariants: INV-12, INV-21, INV-25, INV-28.

## AC-293 · Honest AI provenance

Given: AI reviewers approved and a human optionally reviews later.

When: Human fields provider reviews PR UI and AC-54 outcome export are rendered or validated.

Then: AI records retain configuration family exact subject and ReviewMode; output validators resolve every human approval field and nested ref in either mode and reject AI provenance; AI-bearing outputs missing both mode and marker reject and outcome completion cannot predate authority; visible AI-reviewed — no human review marker remains and voluntary human review is separately attributed.

Invariants: INV-16, INV-29.

## AC-294 · Qualified exact-head dev merge

Given: Opted-in application has configured dev branch and scoped factory Git identity.

When: All AI approvals checks current integration and qualified exact-head preview verification pass.

Then: Outputs bind task repository PR head base branch and gate to the exact subject; all AI publications revalidate qualified panels even with empty refs and merges require pr_review approval; factory merges only that configured branch through provider-enforced branch-specific allowance; stale head base generation image digest or missing preview refuses merge.

Invariants: INV-04, INV-08, INV-12, INV-16.

## AC-295 · Other protected branches refused

Given: AI-reviewed work has dev authority.

When: A merge targets another protected branch or attempts production promotion or uses an overbroad identity allowance.

Then: Controller refuses without provider effect; missing branch protection facts or unsupported enforcement disable auto-merge; existing Argo dev and production configuration is untouched.

Invariants: INV-12, INV-25.

## AC-296 · Hidden stable human audit sample

Given: ai_only work has not executed.

When: Control plane samples the configured share and execution retries or continues.

Then: Selection uses 1..10000 basis points exactly matching its decision and persists before execution and across retries rework and continuation; agents cannot read or reroll it; later human audits do not block merge and backlog stays visible to authorized humans.

Invariants: INV-02, INV-25.

## AC-297 · Audit and degradation ledger

Given: AI outcomes have audits escapes reverts or reviewer disagreements.

When: Configured signal windows sample floors backlog or severity thresholds are crossed.

Then: All signals enter the ledger with denominators attribution and evidence; authorized rules automatically tighten to human and manual merge and re-evaluate in-flight work before effects.

Invariants: INV-04, INV-25.

## AC-298 · Emergency stop mode loss

Given: ai_only work is active or paused with a pending merge.

When: Organization emergency stop activates then is cleared.

Then: Admission publication and merge are fenced and application returns to human/manual merge; clearing does not restore ai_only; affected nonterminal work is re-evaluated before any effect.

Invariants: INV-12, INV-15, INV-25.

## AC-299 · Review mode UI and API

Given: Human and ai_only applications and tasks coexist.

When: Users list filter inspect review or export them.

Then: ReviewMode filters and markers agree with current authority; application shows status scope expiry and audit backlog; AI identity is never shown as human and hidden sample selection is unavailable to agents; The runtime implementation MUST pass an adversarial negative corpus covering provenance laundering; scope and embargo/hotfix/production; identity and fork; chronology; nested outputs; empty refs; stale qualification; exported views overriding the trusted task snapshot; nested bundles reviving revoked or stopped authority; provider review observations presented as human approval; production mitigation without human release; release decisions without an identified decider, with every expected-reject case rejected and every expected-accept control passing. Static reference predicates do not prove runtime enforcement..

Invariants: INV-14, INV-29.

## AC-300 · Review persistence and isolation

Given: Mode decisions transitions AI decisions and audit rows exist.

When: Cross-org requests writes retries and migrations run.

Then: Tenant-qualified references forced RLS append-only grants immutable identities and hidden audit-selection access hold; AI records cannot enter human approvals; old rows and histories retain meaning.

Invariants: INV-02, INV-09, INV-14, INV-29.

## AC-301 · Versioned review behavior

Given: Human template histories and frozen tools exist.

When: ai-review/1.0 is enabled or an old worker encounters it.

Then: Compatible readers and explicit migrations precede enablement; greenfield 5.0.0 and existing_feature/bug_fix 4.0.0 pin new semantics; old templates remain human and tools 1.2.0 plus frozen 1.0/1.1 are unchanged; unknown profile fails closed.

Invariants: INV-01, INV-17, INV-25.

## AC-302 · Organization facts close enablement

Given: INT-18 lacks opted apps dev identity branch protection families corpus audit or degradation values.

When: An operator tries to establish ai_only.

Then: Pre-repository review is blocked until draft application organization repository-intent policy intended dev branch scoped identity and all qualification/audit/degradation facts are recorded with both owners; AI PR review and merge additionally require the verified concrete repository binding after creation effective before every retained PR vote; real provider and panel effectiveness remain not yet proven by static fixtures.

Invariants: INV-12, INV-25.

## AC-303 · Mode transition merge race

Given: Approval and preview passed but mode loss races a provider merge.

When: Controller fences and reconciles the operation.

Then: A serialized current authority check prevents newly unauthorized effects; already committed provider effects are reconciled honestly and audited without retrying or inventing rollback; pending work requires human review and manual merge.

Invariants: INV-02, INV-04, INV-08, INV-25.

## AC-304 · Design scope selection

Given: A requester submits feature greenfield or existing refactor performance or platform intent with deliveryScope design.

When: Admission validates the request.

Then: The design template for that work type and target is pinned with the design budget class; bug maintenance investigation and documentation design requests, prCompletion, a non-design budget class and designSource on a design task are rejected; design remains a delivery scope and no ninth work type exists.

Invariants: INV-12, INV-17.

## AC-305 · Design graph without implementation

Given: A design template or compiled design plan is admitted.

When: The compiler checks its nodes capabilities and gates.

Then: Only intake discovery intent planning peer review render delivery and close stages exist; any execute criteria verify bootstrap scaffold preview merge workspace or environment write or outcome/verification gate is rejected; no runner coding workspace or harness coding stage is allocated.

Invariants: INV-06, INV-12, INV-17.

## AC-306 · Design review gates in every tier

Given: A fast one-invocation or single-runtime design task reaches plan review.

When: A shortened packet is produced.

Then: scope_accepted architecture_accepted plan_peer_approved and plan_accepted plus intent_aligned for greenfield are still required with every required specialist under ReviewMode; a template or plan omitting any of them is rejected.

Invariants: INV-20, INV-21.

## AC-307 · Complete packet for a future build

Given: A design packet is submitted for peer review.

When: Completeness checks run.

Then: All twelve sections are present; acceptance_tests holds the planned criterion-to-scenario matrix; definition_of_done names the future build evidence; plannedBuildDeliveryScope is explicit; planned scenarios never render as passed.

Invariants: INV-21, INV-22.

## AC-308 · Deterministic design rendering

Given: The packet subject is approved.

When: The render controller produces Markdown.

Then: The rendered digest is reproducible from the exact approved packet and renderer version and carries stable anchors for every section criterion and scenario; a mismatched packet missing anchor or later packet revision blocks delivery.

Invariants: INV-04, INV-16, INV-22.

## AC-309 · Design PR delivery

Given: An application has a configured design-docs/ADR location.

When: Delivery runs after approval.

Then: The publisher controller commits only rendered files under that subpath and creates one reviewable design PR; delivery_complete passes when that PR exists without waiting for review or merge; merge follows the docs repository rules and the task never merges or acquires merge authority.

Invariants: INV-08, INV-12, INV-24.

## AC-310 · Design report fallback and target eligibility

Given: No design-docs location is configured or the configured target is ineligible.

When: Delivery is attempted.

Then: Absent configuration produces a classified report artifact; an ineligible classification or confidentiality target blocks for an authorized owner decision and is never downgraded; a report is not used when an eligible location exists.

Invariants: INV-12, INV-28.

## AC-311 · Honest design outcome

Given: A design task completes or fails.

When: The outcome manifest and UI are produced.

Then: design_approved records the exact packet subject approvals delivery target and limitation that nothing is implemented or verified; it never claims delivered verified_fix implemented verified or outcome_verified evidence or a candidate; the record and outcome always carry ReviewMode.

Invariants: INV-11, INV-22, INV-29.

## AC-312 · Build from a current design

Given: An implementation task names an approved design with unchanged source pins rules policy intent application snapshot and build scope before approval expiry.

When: Admission and each later gate evaluate the binding.

Then: The packet and its existing approval sets are reused on the identical subject with no plan re-authoring invocation; the build retains oracle verification review and delivery gates.

Invariants: INV-04, INV-21, INV-22.

## AC-313 · Design drift reopens review

Given: A source pin rules bundle policy intent snapshot build scope review mode or approval expiry differs at binding or a later gate.

When: The binding is evaluated.

Then: The chapter 19 replan path reopens exactly the affected sections and re-requests only the affected approval gates on a new subject; stale reuse and approvals moved to a changed packet are rejected; every assigned peer of a changed packet reconfirms.

Invariants: INV-04, INV-21, INV-22.

## AC-314 · Confidential and classified design

Given: A design task is embargoed or its sources carry restricted classification.

When: Review rendering delivery binding and export run.

Then: Embargoed design stays human-reviewed and reaches only the task's private_fork/separate_repo publication target for its security group with provider-enforced reader checks, or a restricted report; a security-flagged unembargoed design stays human-reviewed under ordinary delivery; rendered content keeps the packet classification; only a task in the same security group may bind it, inheriting that embargo, and other-group or ungrouped builders are rejected.

Invariants: INV-14, INV-28.

## AC-315 · Design budget and rules

Given: A design task runs under its design budget class with resolved rules and exceptions.

When: Spend or rule state changes.

Then: Design spend is reserved and accounted separately from implementation budgets; exhaustion finishes incomplete without implementation; rules resolve before approval and exceptions keep their human approval.

Invariants: INV-11, INV-26.

## AC-316 · Design storage isolation

Given: Design delivery and build-binding rows exist across organizations and security groups.

When: Cross-tenant writes retries scope toggles and bindings are attempted.

Then: Forced tenant and task RLS append-only grants and tenant-qualified keys hold; a task cannot toggle into or out of design scope; a binding requires a visible design-scope source and a non-design builder with matching confidentiality.

Invariants: INV-02, INV-14.

## AC-317 · Versioned design templates

Given: Human design templates 1.0.0 and ai-review design templates 2.0.0 are introduced.

When: Old workers or histories encounter design-delivery/1.0.

Then: Compatible readers and explicit migrations precede enablement; existing journey templates and histories are unchanged; unknown profile or template fails closed; the ai-review design templates stay disabled until W-141 qualifies AI review.

Invariants: INV-01, INV-17, INV-25.

## AC-318 · Design task view and build action

Given: A user opens a design task or approved design.

When: The dashboard renders it.

Then: The view shows journey review state approvals mode marker delivery target and design-only limitation without implemented or verified badges; Build from this design shows currency drift and affected approvals before creating a new linked task.

Invariants: INV-12, INV-22, INV-29.

## AC-319 · AI-reviewed design delivery

Given: An application has an in-force ai_only decision covering a non-security design task.

When: Design review delivery and later build binding run.

Then: Unanimous qualified panels with every specialist supply intent architecture and plan gates on the exact subject; record outcome and design PR carry ReviewMode and the AI marker; embargoed or security-flagged designs stay human; lost AI authority makes a build re-request the affected approvals under human requirements.

Invariants: INV-21, INV-25, INV-29.
