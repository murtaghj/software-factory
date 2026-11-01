# 25 — Data governance, security work and operational safeguards

Revision 1.9 closes gaps that would otherwise block or endanger the pilot:
- what content may reach which model provider
- how security vulnerabilities enter the factory and are kept confidential
- scanning candidate changes for secrets and disallowed licences
- an organization-wide emergency stop
- reliable attribution of agent-authored commits
- making sure humans see the decisions waiting on them

Items marked as pilot prerequisites must exist before the factory touches a real repository.

**Compatibility.** operational-safeguards/1.0 introduces evidence, admission and content obligations qualified at behavior-release admission with pinned policy/evaluator versions. Workflow template versions do not change; existing_feature/bug_fix 3.0.0 histories pinned before this profile is enabled are not retroactively blocked by its gate refinements. Any mitigation-only hotfix outcome or automatic follow-up that changes the graph MUST have an explicitly versioned qualified path before enablement. Existing access, human-review and release invariants remain mandatory.

## At a glance

| Decision | Required behavior | Pilot prerequisite | Packages |
| --- | --- | --- | --- |
| Data classification and provider eligibility | Every repository and evidence source has a classification. Content reaches a provider only when the classification permits it, enforced at admission and at the model gateway (INV-28). | Yes | W-115 |
| Candidate secret scanning | Deterministic secret scan of every candidate diff before checkpoint publication and before push. | Yes | W-116 |
| Organization-wide emergency stop | One audited operator control halts agent execution, publication and delivery everywhere. | Yes | W-119 |
| Security vulnerability work | Scanner and advisory findings become tasks with severity deadlines; embargoed work is confidential. | No | W-117 |
| Licence policy | New dependencies and generated code are checked against a licence policy. | No | W-118 |
| Agent authorship trailers | Every factory commit records task, run and behavior-release identity. | No | W-120 |
| Decision notifications | Deciders are notified, reminded and measured against response targets. | No | W-121 |
| Urgent hotfix path | Incident tasks with on-call routing and compressed but complete gates; mitigation is distinct from a verified fix. | No | W-126 |
| Factory self-work | The factory works on its own repository, except its trusted components. | No | W-127 |

## Data classification and provider eligibility

Every repository, application and evidence source carries a **data classification** in its registry descriptor (chapter 23), for example `public`, `internal`, `restricted` and `regulated`. The organization defines the actual levels and their meaning. dataClassification on ApplicationDefinition/ApplicationRepository and EvidenceSourceDescriptor is distinct from artifact retention/access classification (ordinary/restricted/sensitive_session); the shared word restricted implies no mapping between these policies. Admission MUST resolve the most restrictive classification in scope under that policy; absent or incomparable classifications block real-content admission. StageInput.providerEligibility and its InputBinding.providerEligibilityRef pin the sources, effective classification, eligible model profiles and policy decision; the allocation persists that classification and reference. The runner controller supplies this binding to the external gateway (INT-08). Optional descriptor fields support historical readers, not an unclassified-content bypass.

A versioned **provider eligibility policy** maps each classification to the model providers, regions and contractual terms permitted for it:
- **Admission:** a task is admitted only if every repository and evidence source in its scope is eligible for the qualified model profile of each role it will run. Otherwise it is refused with a visible reason, or routed to an eligible profile where one is qualified.
- **Model gateway:** the gateway enforces the same policy on every request, using the classification attached to the run's allocation. A misconfigured adapter cannot bypass admission.
- **Evidence:** `get_evidence` and prior-incident matching withhold or redact content whose classification forbids the run's provider. Production payloads and personal data are excluded unless the classification and policy explicitly permit them.

Provider contractual terms (retention, use for training, processing region, sub-processors) are an organization integration fact (INT-14), confirmed by security or legal owners. The spec defines enforcement; the contracts define what is permitted. Until INT-14 is closed for a provider, that provider is eligible only for `public` content and fixtures.

A classification change re-evaluates affected admissions and invalidates dependent runs under the existing rules (INV-04).

INV-28 also applies to fixtures, seed data and any data loaded into branch previews, including derived logs/evidence. Preview admission MUST record their classifications/provenance and permit only data qualified for the target and its reviewers. Each preview has its own database and credentials, even on a shared non-production database server; provisioning failure MUST NOT fall back to shared dev or production data. External secrets MUST expose only preview-scoped credentials. Record the PR-generator GitHub token and CI image-build credential scopes, secret references and owners separately (INT-17); no production credentials may enter previews.

Before the descriptor exists, onboarding MUST use the retained human-supplied provisional classification on the nomination (chapter 23). Unknown classification is most restrictive and blocks real-content admission until classified. W-115 pins that classification and provider eligibility on the onboarding allocation and gateway requests; W-119 can stop onboarding, and W-116 scans the confirmed descriptor before publication.

## Candidate secret scanning

A deterministic secret scanner checks every candidate diff, including new files, generated files and binary-safe text extraction:
- before a checkpoint artifact is finalized for publication beyond the allocation
- before any push to a remote
- before patch or report delivery

A hit blocks publication, records a protected finding with the secret redacted, and returns the run to the author with the location. False positives are cleared by an owner through an exact-scope rule exception (chapter 21), never by the agent.

Secrets found in agent output that reached logs are handled by the existing redaction and incident procedures (chapter 09). The scanner, its rules and its version are part of the trusted verification configuration.

## Organization-wide emergency stop

Operators have one explicit **emergency stop** control, in addition to cohort-scoped stop-the-line (chapter 22):
- It immediately suspends admission of all authoring and verification stages.
- It blocks publication, PR updates and delivery.
- It sends cancellation to running allocations under the existing cancellation protocol, preserving checkpoints and reconciling in-flight external operations (INV-08, INV-15).

The control is restricted to an operator role and uses the internal OperatorControlPlane contract in chapter 03, with durable organization state and an exact-state human clearance decision. Every activation and clearance is audited with a reason, and clearing requires an authorized human decision. The stop is drilled before the pilot and as part of recovery qualification (chapter 13). It is the operational form of the "disable admission and publishing" step already in the recovery procedure (chapter 11).

## Security vulnerability work

Findings from dependency scanners, static analysis and security advisories enter as **security tasks**: bug or maintenance work types with TaskRequest.security (its presence is the security flag). Security metadata is also accepted on an eligible design-scope task (feature, refactor, performance or platform) and, embargoed only, on a build that names an embargoed design and inherits its group (chapters 05 and 19); it is rejected on all other work. An embargoed design (TaskRequest.security.embargoed=true) follows D4: human review only and delivery only to the task's private_fork/separate_repo PublicationTarget for its security group, with provider-enforced reader checks before every push (INT-15), or a restricted confidential_report. A security-flagged design that is not embargoed follows ordinary delivery but stays in human review mode, never ai_only. Security fields are: severity, sourceRef, optional responseTargetAt, embargoed and securityGroupId when embargoed. TaskRequest also accepts priorityClass (default normal) and incidentRef. Incident priority requires caller authorization; refusal is HTTP 403. TaskView reports these fields and the admission-derived changeClass, never a caller-selected readiness class.
- **Deadlines and priority:** severity maps to a configurable response target, which sets admission priority (chapter 11) and is shown on the task. Missing a target escalates to the owner; it never relaxes gates.
- **Repeatable fixes:** fixes that are mechanical, such as dependency bumps, use change recipes and campaigns (chapter 23) like any other repeatable change.
- **Confidential handling:** a task marked **embargoed** (an undisclosed vulnerability) is visible only to its authorized security group:
  - publication only to an isolated confidential target: a GitHub temporary private fork or a separate private security repository. Before every push, the Git adapter MUST verify that the target's read principals are a subset of the authorized security group; embargoed publication fails closed if the provider cannot enforce this
  - restricted logs and transcripts
  - no prior-incident matches, variant findings or knowledge records exposed outside that group until the embargo is lifted
  - provider eligibility at least as strict as the affected repository's classification

  Lifting the embargo uses the task-bound lift_embargo action on the existing decision response endpoint, restricted to authorized human security deciders. EmbargoLiftSubject binds task/spec version, group, publication targets, disclosure scope and policy. The controller rechecks authority and subject before updating the task; only the approved scope may be disclosed. Original restricted artifacts retain their labels; authorized disclosure creates separately audited copies.

Scanner/advisory sources and provider enforcement of the confidential publication target are integration facts (INT-15).

Embargoed security tasks (D4) MUST NOT receive shared-cluster branch previews unless an isolated, qualified confidential preview target exists. A private PR or preview label is insufficient: cluster access, reviewer URL authentication/authorization, secrets, data, logs and evidence visibility MUST all enforce the security group. Refuse by default with a visible protected reason; INT-15 and INT-17 qualification is required before enablement. Ordinary fork PRs remain ineligible for this preview provider.

## Licence policy

The organization defines a versioned licence policy: allowed, review-required and disallowed licences. Two checks apply it:
- **New dependencies** are checked against the policy as part of plan approval and verification. A disallowed licence blocks unless an owner grants an exact-scope exception (chapter 21).
- **Generated code** is scanned for close reproduction of licensed code wherever the organization's legal owners require it. A match is a finding for owner review.

Licence checks are deterministic rules with owned revisions, like other standards.

## Agent authorship trailers

Every commit the factory creates carries structured trailers identifying:
- the task ID
- the stage run ID
- the behavior-release ID
- the recipe ID and version, where applicable

The trusted runner/checkpoint step MUST write trailers from server records when it creates each commit, before freezing its ID. The Git adapter MUST validate them against those records before publication and reject missing or mismatched trailers without rewriting the candidate. Trailers survive squash merges through the PR description and merge record. Application-health attribution (chapter 11) uses trailers first and falls back to recorded candidate manifests. This replaces heuristic attribution and reduces the "attribution uncertainty" in code-health measures.

## Decision notifications and response targets

In human mode, human decisions gate intent confirmation, plan sign-off, required oracle approval, rule exceptions, PR review and release authorization. In eligible ai_only work, D5 panels replace the intent, architecture, plan, specialist, oracle and PR reviews; rule exceptions and release authorization retain human authority. Hotfixes and embargoed work remain human. A required human decision nobody sees blocks the factory as surely as a defect.

- **Routing:** every decision request is routed to its eligible deciders through the organization's configured channels (email or chat) as well as in the product. Each message carries a link to the exact subject.
- **Response targets:** each decision type has a configured response target. Reminders follow a schedule before the target. Overdue decisions escalate to a configured backup decider or owner.
- **Measurement:** application health and the operations view show time waiting on humans by decision type and owner group from ApplicationDefinition.ownerIds (chapter 23); multi-owner targets count against each owner principal.
- **No auto-approval:** expiry semantics are unchanged (chapter 04). Silence, an overdue target or an expired request never becomes approval.

Notification content is minimal: a subject, the required action and a link. Restricted and embargoed details stay behind authorization.

## Urgent hotfix path

A production incident can open an **urgent bug task**: incident priority, restricted to authorized callers (chapter 11). The path is compressed, never skipped.

- **Routing:** decisions go to the application's on-call owner, one qualified on-call generalist peer and every required specialist peer (security, data and others per chapter 19), with urgent response targets and escalation to backups (decision notifications above). Incident tasks use chapter 11's incident priority class while preserving the reservation of at least 20% of capacity for normal tasks.
- **Plan:** the plan packet covers every section concisely with applicability statements (chapter 19), and one qualified on-call generalist peer plus every required specialist peer signs it off. A single sign-off suffices only when the resolved PlanReviewAssignment requires no specialist; a missing specialist blocks approval and escalates to a qualified backup, never a waiver. The normal scrutiny-tier rules, including Enhanced when triggered, still apply. INV-21 and chapter 19 apply without a carve-out.
- **Evidence:** red/lock/green still applies to any verified fix (INV-05). Where reproduction is not yet possible, the task may deliver only a **mitigation**: an authorized, reversible environment operation such as a feature-flag change or a rollback through the deployment provider (chapter 10). It is recorded as mitigation, never as a verified fix (INV-11). Under W-126's urgent-mitigation/1.0 controller profile, this operation runs outside the bug_fix 3.0.0 template: diagnose, complete plan/peer approval, authorize the environment operation, apply it through EnvironmentWorkflow/DeploymentProvider, independently verify recovery, then record outcomeKind mitigated with status incomplete, mitigationOperationRef, recoveryEvidenceRef and a required followUpTaskId. The original bug remains unverified; the normal bug_fix graph is not completed or relabelled. Unknown operation results stay reconciling and cannot close. This M7 path is disabled until W-042, W-052 and W-126 qualify it; a flag operation needs its own qualified provider capability, otherwise only qualified rollback is available.
- **Follow-through:** closing an urgent task automatically creates a linked follow-up bug task on the normal path, for the full fix and its regression test, and an incident-learning entry (chapter 24).
- **Production:** release policy and authorization are unchanged. A hotfix is never deployed outside the configured production release rules.

## The factory working on its own repository

Once the first real task (W-107) and pilot qualification are complete, the factory's own repository is onboarded as an application. Its builders then experience the factory's friction first.

Self-work is scoped to protect the factory's integrity (INV-07):
- **Allowed change classes:** dashboard and UI, documentation, fixtures and tests outside canonical verification, and non-trusted packages.
- **Protected paths:** the factory cannot change its own trusted components through itself. These are the policy evaluator and policy packages, gate evaluation, the verifier and supervisor, the factory tool server, the runner and fencing logic, the model gateway configuration, contracts and security-relevant deployment configuration. Changes to them follow a human-authored change path. Agent edits there are protected-path findings.
- **Deployment:** factory changes deploy through the factory's own release pipeline (chapter 11), never through a factory task's delivery stage.

## Traceability

- W-139/W-140 and AC-262–AC-272 apply these confidentiality, credential and data-isolation requirements to the Argo branch-preview provider; runtime enforcement remains not yet proven.

- W-115–W-121, W-126 and W-127 implement this chapter. AC-182–AC-191, AC-199–AC-202 and AC-251 define its acceptance obligations.
- INV-28 is added in chapter 01. W-099 onboarding and W-107 first real task depend on W-115, W-116 and W-119. W-094 evidence access depends on W-115; W-110 inherits that prerequisite. AC-261 covers classification before onboarding.
- W-136–W-138 and AC-240–AC-249 connect chapters 21–26 to the supplied contracts. W-115 owns descriptor/ApplicationDefinition/StageInput classification and runner-to-gateway scope; W-117 owns security metadata and confidential targets.
- Revision 1.11 adds task/admission/allocation fields, security-group membership tables and restrictive embargo policies for tasks and derived records, including artifacts, logs and knowledge matches. No public REST route is added. Domain envelopes use the revision's 2.0 schema and API description 2.4.0. Runtime SQL, gateway and confidential-provider enforcement are not yet proven; W-137/W-138 qualify them.

## D5 exclusions and stop behavior

Embargoed security work under D4/INT-15 and the urgent hotfix path under D2 MUST remain in human review mode even when the application has ai_only enabled. Admission and every gate/publication/merge recheck these flags; a newly embargoed or hotfix-classified nonterminal task loses AI review authority and re-evaluates all affected gates before further effects. The emergency stop automatically returns affected applications to human mode and manual merge; human clearance does not restore ai_only. Production release_authorized, disclosure/lift authority, INV-28 classification, secret scanning and protected-path controls remain unchanged.
