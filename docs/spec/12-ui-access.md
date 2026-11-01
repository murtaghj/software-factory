# 12 — Dashboard, human control and access

## User journeys

The dashboard must explain what the factory is doing, why it is waiting, what evidence supports the result and what the user can safely do next. Internal implementation details appear in diagnostic drill-downs rather than ordinary task submission.

| Screen | Required content and actions |
| --- | --- |
| New task | Application/system, engineering intent, desired outcome, attachments/source links, work type suggestion, delivery scope (including design only where eligible) and budget. Explain automatic assurance escalation. |
| Task list | Type, application, current stage, state, elapsed/active time, spend estimate/actual distinction, owner and actionable wait. Filter and stable pagination. |
| Task detail | Accepted scope, selected path, current stage/attempt, plan changes, meaningful progress, findings, required gates, latest source/artifacts and delivery handles. |
| Evidence view | Input binding, actual executed checks, passed/failed/inconclusive/skipped status, provenance, baseline/candidate comparison and limitations. |
| Review inbox | Concrete decision subject, exact candidate/plan, requested action, consequences, evidence, eligible roles and expiry. Approve/reject/request changes with reason. |
| Application page | Purpose, owners, repository mapping, APIs/dependencies, profiles, runbooks, approved facts, observed runtime drift and import health. |
| Environment page | Purpose, deployed composition, readiness versus verification, endpoints, expiry, cost/resource owner and cleanup status. |
| Operations view | Capacity/queues, provider health, leases, unknown side effects, orphan cleanup, audit and recovery actions. |

A campaign view shows wave state, per-outcome counts, pauses and review backlog per owner group. Task detail offers explicit take-over and hand-back actions with ownerPrincipalId and any interactiveHolderPrincipalId shown separately. Owner reassignment uses an audited reassign_owner command. Application pages show onboarding status, confirmed owners and readiness per change class. See [chapter 23](23-readiness-recipes-campaigns.md).

## Three entry journeys and glanceable progress

Lead task creation with Build something new, Add a feature and Fix a bug. The first collects a draft application and starts the required intent interview; repository details may remain unresolved until foundation planning; the other two select registered targets. Other work types remain available. Keep assurance, invocation count and delivery as separate controls. Show a short reason and affected stages when discovery proposes reclassification.

The default task row shows journey, application, current meaningful milestone, blocker and next action. Greenfield progress distinguishes brief/foundation/first working slice/integration; feature progress distinguishes acceptance/compatibility; bug progress exposes red/locked/green. Avoid a universal progress bar that obscures these differences. Keep required failures and unresolved decisions visible in a compact attention queue; show one primary action per item. Expand detailed plans, gate manifests, costs and logs on request, preserving focus and scroll. Foundation readiness must not look like product completion.

Draft application views expose ownership, revision and onboarding task without fictitious endpoints/profiles. Creation permissions and stale revision conflicts are explicit. Repository provider details belong in configuration/advanced detail except when a missing permission requires a user decision.

## Focused intent interview

For greenfield, show one to three focused questions with why each matters, suggested answers when useful, free text and a way to record uncertainty. Keep current question and next action prominent; expand the full brief/history on request. A compact summary shows confirmed intent, open blockers and first slice. Save progress, preserve typed answers across conflicts and support leave/resume without repeating settled questions.

Before design begins, show a concise read-back of this exact brief, concrete success/failure examples, non-goals, consequential trade-offs and remaining low-impact assumptions. In human mode offer Edit and Confirm this version; never auto-submit a default approval. In ai_only show the separate panel confirmation against the requester’s submitted answers, retaining Edit and blocking questions. Blocking gaps disable confirmation and remain visible. Do not show a percentage claiming total alignment. Corrections reopen the affected questions and show invalidated work. [Chapter 18](18-intent-interview.md) defines the interview and human authority contract.

## Layered engineering plan review

Present one versioned plan through a short decision summary, structured engineering review and full specification. The first view keeps requested action, current revision, impact, consequential risks, open blockers and changed scope visible. The next view shows design/alternatives, criteria-to-scenario mapping, DoD and delivery/recovery. Full contracts, work packages, scenarios and sources expand in place with stable anchors and a clear return location.

Show assigned reviewer scope, primary/specialist decisions and exact revision in an anchored header/footer. Use compact cards, diagrams, tables and semantic diffs; never hide a critical risk to satisfy a word budget. Preserve draft comments/focus across updates and warn when the subject is stale. Reading time, clicks and checkbox counts cannot establish approval quality. Measure comprehension and detected omissions alongside time to orient. [Chapter 19](19-peer-plan-review.md) and the [interactive review concept](../plan-review.html) define the experience.

## State presentation

Show requested versus resolved work type/profile and explain risk-triggered changes. Display “authoring finished” separately from “verified” and “delivered”. A failed earlier attempt remains visible when a later attempt passes. Superseded evidence is labeled and cannot look current.

When a user edits requirements, preview which stages/evidence will be invalidated before submitting the revision. The workflow validates actual state when applying it. A stale UI receives a conflict and reloads; it never overwrites newer work silently.

Pause/resume/cancel are asynchronous commands. Show command accepted versus applied and why a release may need reconciliation before stopping. Budget exhaustion shows unmet criteria and the last checkpoint. The user can increase an authorized budget, reduce scope through a new specification or close the task; no “mark tests passed” control exists.

Show rule blockers, required decisions and limitation counts at a glance; expose exact rule/check versions, exception scope/expiry, reuse rationale and source-bound feedback in details. A disclosed limitation cannot silently become an accepted criterion waiver. See [chapter 21](21-rules-role-content-skills.md) for the authoritative requirements and compatibility rules.

## Role matrix

| Role | Scope |
| --- | --- |
| viewer | Read permitted task/application metadata and nonrestricted evidence. |
| contributor | Create tasks for allowed applications; inspect their permitted outputs; request scope/budget changes within granted limits. |
| task_owner | Pause/resume/cancel and amend tasks where they are ownerPrincipalId (initially the creator) or the current interactive holder; cannot grant themselves production release authority. |
| application_owner | Accept application criteria, maintain profiles/catalog, resolve scoped design decisions and allowed residual risks. |
| policy_owner | Authorize gate-mode/autonomy policy revisions jointly with application_owner, clear cohort stop-the-line halts and set incident-learning thresholds; cannot relax policy for a cohort whose work they authored. |
| reviewer | Qualified independent peers sign assigned plan/design scope, review criteria/tests/DoD and adjudicate findings; authors cannot supply their own required peer sign-off. |
| release_manager | Authorize specific production release subjects/environments within assigned scope. |
| operator | Reconcile stuck resources and manage capacity/recovery; cannot invent product evidence. |
| organization_admin | Manage roles, provider installations and policy configuration; privileged changes audited. |

Roles can be combined by organization policy, but production separation of duties and self-approval rules are explicit. Reevaluate authorization at command application/delivery time. Service identities have operation-specific permissions rather than human roles. On-call owner/peer and embargo security-group membership are per-application scoped designations on top of these roles, not additional roles.

Use OIDC Authorization Code with PKCE for browser sign-in. Keep access tokens in memory or use a server-managed secure HttpOnly session through a backend-for-frontend; select and test one approach at M0. Do not persist bearer tokens in localStorage. If using cookies, enforce SameSite, CSRF protection and origin checks; if using bearer requests, restrict CORS to the dashboard origin. Session expiry/revocation produces an explicit reauthentication state while task execution continues under its separately authorized workflow identity.

## Decisions and approvals

Ask for decisions only when required by policy or missing intent/authority. A review request contains current artifact links and clear choices; it does not ask the user to approve an abstract workflow. Repeated identical approval requests deduplicate. Once a decision is applied, routine retries of the same unchanged operation reuse it; changed subject, policy, expiry or authority invalidates it.

Greenfield intent confirmation is mandatory before foundation design, and independent peer plan/design sign-off is mandatory before implementation in all paths: human in the default mode, or the qualified D5 panel when ai_only is in force. Other human review follows configured policy and is not a compulsory click after every Activity. Standard automated checks continue unattended. Production actions and high-impact exceptions follow the application's actual configured policy.

Deciders receive minimal notifications with a link to the exact subject, plus reminders before the response target. Operators have an emergency-stop control with reason capture through the internal OperatorControlPlane contract in chapter 03; activation and bound human clearance expose the committed organization revision. Investigation views show the hypothesis ledger, timeboxes, stalls and escalations. See [chapter 25](25-data-security-operational-safeguards.md) and [chapter 26](26-investigation-discipline.md).

## Design-only tasks and building from a design

New task offers “Design only” as a delivery choice for eligible feature, refactor, performance and platform intent, with a one-line explanation that the result is an approved design and nothing is implemented. The design task view shows the journey, interview and review state, required primary/specialist approvals under ReviewMode, the rendered packet with deep links to section/criterion/scenario anchors, the delivery target (design PR link or report artifact), classification/embargo state and approval expiry. Its success badge reads “Design approved” or “Design PR created”, with the design-only limitation visible. It never shows implemented, verified, deployed or merged, and planned scenarios stay labelled planned. ai_only designs carry “AI-reviewed — no human review”.

An approved design offers Build from this design to authorized contributors. Before submission it shows the current DesignCurrency: current, stale, expired or unknown, each drift kind, the sections it would reopen and the approval gates it would request again, plus the new task's own delivery scope and budget. The action creates a new linked implementation task; it never edits the design task, hides drift or presents reused approvals as fresh. Application pages list approved designs with currency and linked builds. Embargoed designs and their build action are visible only to the security group; only a task in the same security group may bind, and the new build inherits that embargo.

## Accessibility and failure states

Keyboard navigation, visible focus, labeled controls, text plus color statuses and accessible tables are required. Live updates announce meaningful state changes rather than every token. Preserve scroll/focus while refreshing. Provide empty, loading, permission-denied, provider-unavailable, stale-data and disconnected states. Task detail remains readable from its last projection while indicating staleness.

Download raw logs/artifacts with appropriate access and safe content disposition. Never insert untrusted report HTML into the authenticated page. Show timestamps in user timezone with UTC in diagnostic details. Distinguish active execution from human wait time in duration/cost views.

## Audit interaction

Every command and decision links to actor, time, subject version and outcome. Users can inspect why a gate is required and which evidence satisfied it. Operators can export a task outcome bundle containing manifests/reports without secrets or unauthorized transcripts. Audit retention follows organization policy and resource access checks.

## Structure-first plans, PR progress and health

The first engineering review layer includes the signed structure outline: changed components and paths, signatures/types/interfaces, data changes and vertical slices. Show what changes, who is affected, how acceptance will be proved and the requested decision before prose detail. Keep the complete packet available in place; show applicability concisely. A changed outline must be included in the semantic diff and full approval hash.

Task cards show one current action, assurance tier/reason, PR completion target and exact waiting owner. Distinguish PR created, awaiting human review, rework round n/3, approved current head, merged, abandoned, handed over and unreproduced proposal. A pr_created success badge must not imply merged/deployed/fixed. Surface actual-diff escalation and stale-head approvals immediately. Agent feedback is labelled local feedback, separate from independently collected gate evidence; planned tests remain planned.

Application pages show ReviewMode and current human/automated/ai_panel gate modes, cohort qualification, a small code-health trend with sample size/maturity and any automatic tightening. Expand for 30/90-day churn attribution, architectural findings, escapes and evidence. Reviewer load and oldest wait should explain blocked admission without exposing a wall of metrics. No individual engineer ranking or opaque quality score is required. New modes never become available because a user clicks through all details; decisions remain exact-subject authenticated actions.

Plan review shows the discovery ContextManifest and any prior-incident matches with their outcome. Bug detail shows the failure signature, linked earlier incidents, variant findings and systemic proposals. See [chapter 24](24-context-gathering-incident-learning.md).

## Review mode visibility and access

Task, PR, plan/gate and outcome views MUST show ReviewMode and support task/application filtering by human or ai_only. Application detail shows effective ai_only status (active, suspended, expired, revoked or human), both establishing human owners, scope, qualification cohort, expiry, degradation reason and audit backlog/overdue count. ai_only PRs, outcomes and UI carry “AI-reviewed — no human review”; voluntary human reviews appear separately. Human approval controls never display an AI decision as a human approval. Show each panel role/configuration/family, exact subject, unanimity and unresolved findings, without exposing verdicts to other reviewers before submission. Pending audit selection is hidden from agents and agent-accessible projections, logs and tools. Only authorized humans may audit; policy/application owners jointly establish or renew mode through reviewed policy releases, never agent-writable endpoints.
