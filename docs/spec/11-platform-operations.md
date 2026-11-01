# 11 — Kubernetes platform, operations, scale and recovery

## Environments and deployment topology

Maintain development, staging and production factory deployments with separate credentials, artifact namespaces, databases and Temporal namespaces. Factory production controls user application preview/production only through scoped providers. Do not share the factory database with Temporal's internal persistence database.

Deploy API/dashboard, dispatcher, workflow workers, Activity workers, runner controllers and scheduled reconcilers as separate workloads. PostgreSQL, object storage, OIDC, secret manager, container registry, Temporal and the external model gateway (INT-08) are infrastructure dependencies. Use Helm charts with values schemas and environment-specific reviewed overlays. Helm templates cannot accept arbitrary ticket-provided manifests.

| Workload | Initial replicas/resources | Scaling signal |
| --- | --- | --- |
| API | 2; request 250m CPU/512 MiB, limit 1 CPU/1 GiB | Request latency, CPU and connection budget. |
| Dispatcher | 2; 250m/256 MiB, limit 1 CPU/512 MiB | Outbox age; row leases ensure safe parallel dispatch. |
| Workflow workers | 2 per active build; 500m/1 GiB, limit 2 CPU/2 GiB | Workflow task schedule-to-start and worker slot utilization. |
| Activity workers | 2; 500m/1 GiB, limit 2 CPU/2 GiB | Activity queue latency and slots; separate I/O/provider queues. |
| Runner controller | 2; 250m/512 MiB, limit 1 CPU/1 GiB | Reconcile delay and active allocations. |
| Authoring Job | 1 writer; request 1 CPU/2 GiB, limit 4 CPU/8 GiB | Task-specific profile; initial org cap 10 active authoring jobs. |
| Verification/build Job | request 1 CPU/2 GiB, limit 4 CPU/8 GiB | Profile requirements; initial org cap 10 active jobs. |

These are starting allocations for measurement, not sizing claims. Heavy builds/benchmarks get explicit profiles/node classes. Set ephemeral-storage requests/limits and per-workspace byte caps. Initial workspace cap 10 GiB, expandable through an app profile; enforce before disk exhaustion. Performance work MUST use a declared controlled benchmark profile with dedicated or pinned execution placement, bounded interference, fixed resources and measured variability; unavailable suitable placement yields inconclusive performance evidence.

## Kubernetes resources and controls

Charts include Deployments, Services, ingress/TLS, service accounts, narrowly scoped Roles/RoleBindings, default-deny NetworkPolicies, ResourceQuota, LimitRange, PodDisruptionBudget, topology spread and probes. No runtime component receives cluster-admin. The runner may create/read/delete approved Jobs/Pods/PVCs in designated execution namespaces; deployment tools use separate identities for application targets.

Use separate namespace or virtual environment per task where selected; independent persistent-data credentials are still required. For mutually untrusted workloads qualify a stronger runtime/node isolation profile. Mount short-lived projected identity only where needed. Code Jobs do not receive a Kubernetes API token by default.

Job TTL removes Kubernetes records only after result/checkpoint collection, with controller-owned finalization or a conservative retention window. TTL is not a substitute for persistent source/evidence. Use encrypted volumes where required; support RWO-Pod or equivalent single-writer storage when available, but preserve application-level fencing regardless of access mode.

## Admission and fairness

### Argo preview platform

W-139/W-140 MUST qualify access to the installed Argo CD/ApplicationSet controllers, a separate preview AppProject and reviewed ApplicationSet templates, scoped observation/deletion identities and an authenticated ApplicationSet webhook endpoint. Pin the actual versions under INT-17. Preview permissions MUST NOT modify the existing merge-to-dev Argo resources or production targets. Candidate code MUST NOT receive controller credentials; the factory adapter observes Argo and changes PR eligibility, while Argo applies manifests.

Platform provisioning MUST supply wildcard DNS/TLS (for example cert-manager) for the preview domain, reviewer authentication at ingress, enforced NetworkPolicy egress, namespace quotas/limits, external secrets and the selected per-preview data mechanism. A trusted admission boundary MUST validate head-repository identity, confidentiality and capacity before any generated Application sync, including human-labelled PRs. It MUST prevent candidate manifests from escaping their namespace, weakening isolation or altering ownership metadata. Do not rely on eventual label removal to prevent forbidden execution.

Use a reserved ownership-label prefix, such as `factory.example/`, consistently on Applications, namespaces and owned resources: managed-by, task, operation, repository, pr, head-sha, expiry, application and team. Encode/hash values that exceed Kubernetes label syntax/length and retain their complete values in annotations and the operation ledger; encode expiry as epoch seconds. Multiple owner teams count against every team cap. Human previews MUST have a durable preview tracking identity and owner; an agent run is not required. The generator template/admission supplies these fields, not untrusted chart inputs. Cleanup MUST verify label ownership against the ledger before deletion and MUST never select ordinary dev namespaces.

Extend the existing sweeper to reconcile PR eligibility, maximum/idle expiry, Applications, namespaces, hook Jobs, volumes and external data allocations. It MUST fence recreation, inventory and retry partial deletion through scoped APIs, and report overdue finalizers/data cleanup without declaring retirement. `CreateNamespace=true` alone is insufficient: require an owned Namespace manifest or explicitly qualified label-scoped sweeper deletion. Set the Application resources-finalizer and qualify cascading cleanup. Measure webhook/poll lag separately from sync/prune latency against the existing cleanup objective; controller/API outages remain visible failures.

### Shared admission policy

A CapacityManager in the runner control layer reserves organization/task/provider slots transactionally. Initial limits: 10 authoring, 10 verifier, 5 concurrent previews per organization; 2 concurrently authoring children per parent task; at most 8 active child workflows across each root task tree, depth at most 2 below the root; provider RPM/TPM/concurrency from configured account limits. Reserve before scheduling expensive execution; release on terminal or reconciled lost allocation.

Preview admission MUST additionally enforce per-application and per-team caps (INT-17) across factory and human PRs; reservations include provisioning, retained and retiring/unknown previews until absence is confirmed. The ApplicationSet PR generator does not enforce these caps. Requests over a cap MUST remain queued with a visible reason and no deployed workload; recheck current head, policy and capacity before admitting them. This M5 control is required before preview enablement and does not wait for M7 fairness work.

Use FIFO with aging within priority classes incident, normal and background. Limit incident priority to authorized callers; reserve at least 20% of capacity for normal tasks to avoid starvation. Queue state is visible. A workflow waits with durable timers/events, not a busy-loop Activity. Provider 429 backs off globally for that provider/account and does not launch alternate duplicate work.

## Cost accounting

Reserve estimated stage cost before start using a versioned pricing/profile estimate and declared maximum duration/invocations. Ledger entries: reservation, observed_usage, estimated_usage, adjustment, release and unknown_charge. Unique provider request/usage ID prevents duplicate charge ingestion. Reconcile actual usage asynchronously; retain currency/rate source/time and uncertainty.

Parallel child reservations consume parent allowance atomically. Do not admit a new child because another child has merely stopped emitting tokens. If exact token enforcement is unavailable, expose the monetary limit as an admission estimate, enforce hard wall/turn/call limits and optionally configure provider account spending controls. Never report an exact hard dollar ceiling when delayed metering prevents one.

## Service objectives and telemetry

Proposed launch objectives, measured in staging before acceptance: API availability 99.9% monthly excluding planned maintenance; task admission p95 < 2 seconds under declared load; projection lag p95 < 5 seconds; runnable-stage queue wait p95 < 30 seconds when capacity is available; cancel-to-process-stop p95 < 60 seconds for ordinary Jobs; expired preview cleanup p95 < 15 minutes.

Model execution speed and provider outages are separate metrics, not hidden inside API availability. Record task throughput, semantic attempts, gate failure categories, escaped defects, invalid review findings, cost per successful outcome, artifact bytes, checkpoint duration, stale-result rejections, lease conflicts, pending unknown operations and cleanup backlog.

Use OpenTelemetry trace propagation across API, dispatch, Activity, runner and provider calls. Correlate workflowId/taskId/runId in logs and spans; metric labels use bounded stage/provider/type categories. Logs include event IDs and redacted error classifications. Dashboards distinguish author completion, verification and delivered outcome.

Alerts: outbox oldest > 60 seconds; projection lag > 30 seconds; no healthy workflow workers; growing queue with available capacity; suspect writer > 2 minutes; unknown external operation > 5 minutes; artifact finalization failures; cleanup overdue > 15 minutes; budget ledger mismatch; verification tamper event; backup or restore-test failure. Each alert links a runbook and owner.

## Backup and disaster recovery

Proposed objectives: application DB RPO <= 5 minutes/RTO <= 2 hours; finalized artifacts retained with durability/versioning appropriate to the provider; acknowledged source checkpoint recoverable independently of a pod/PVC. Native conversation state may be lost when not supported, with portable handoff fallback. Temporal service recovery objectives depend on managed/self-hosted selection and are documented separately.

Enable PostgreSQL PITR and daily backup verification; test restore monthly to an isolated environment. Back up definitions, provider mappings, policy versions, encryption-key references and object metadata. Object retention must exceed database backup recovery windows so restoring the database does not point to already deleted source/evidence.

Recovery procedure: disable admission and publishing/deployment capabilities; restore DB/artifacts and reconnect/restore Temporal according to provider procedure; reconcile workflow bindings and all nonterminal external operations against actual providers; fence old runner generations; mark missing artifacts explicitly; rebuild projections from accepted workflow/results; run integrity and sample restore checks; reenable reads, then execution, then delivery. Never bulk replay side effects from an old outbox without reconciliation.

## Operational runbooks

| Incident | Required operator sequence |
| --- | --- |
| Task appears stuck | Compare workflow, queue, run and provider state; inspect last heartbeat/checkpoint; attach/reconcile before replacing. |
| Duplicate writer suspected | Revoke old epoch/capabilities, confirm process/storage quiescence, isolate replacement volume, inspect conflicting artifacts. |
| Deployment outcome unknown | Read operation request/hash, query provider identity, inventory resources, record resolution; do not blindly resubmit. |
| Verification integrity failure | Quarantine allocation, preserve restricted evidence, revoke affected profile/image, rerun from trusted inputs after review. |
| Artifact unavailable | Suspend dependent stages, inspect storage/version/retention and restore from backup; do not regenerate under old digest. |
| Credential compromise | Revoke provider/workload credentials, stop affected allocations, rotate keys, audit operations and requalify access. |
| Worker release defect | Stop new assignment to build, keep compatible workers, replay histories, roll back routing; protect active workflow compatibility. |
| Orphaned preview/PVC | Verify ownership and task terminality, persist useful evidence, perform scoped cleanup, record provider confirmation. |

An audited organization-wide emergency stop suspends all authoring and verification admission, blocks publication and delivery, and cancels running allocations under the existing protocol; clearing requires an authorized human. Application health reports time waiting on humans by decision type and team. See [chapter 25](25-data-security-operational-safeguards.md).

## Delivery pipeline for the factory itself

PR checks: typecheck/lint, contract/schema tests, deterministic domain tests, database migrations, Temporal workflow/replay suite and adapter fake tests. Build signed/versioned images and SBOMs. Staging deploy runs real provider sandbox conformance and end-to-end fixtures. Production promotion uses immutable image/chart digests, expand-first database migrations and worker-version routing. Keep prior worker builds until their workflows are drained/migrated.

A factory upgrade cannot modify evidence for an already accepted task. New policies/templates apply to new work by default; explicit task migration creates a new version and reevaluates affected gates. Production activation of any behavior release requires the held-out representative corpus, reward-hacking canaries and cost/quality comparison with the current release. This includes harness/model profiles, role prompts, factory instructions/skills, factory-tool schemas, evaluators and tier rules; pin the complete behaviorReleaseRef on each stage.

W-086 behavior releases include canonical role packages, standards, compiler configuration and admitted skills. Required-content request captures use synthetic fixtures and restricted retention. Optional W-091 forensics emits reviewed proposals only; changes never self-apply. See [chapter 21](21-rules-role-content-skills.md) for the authoritative requirements and compatibility rules.

## Local development

Provide one documented command in the implementation repo to launch PostgreSQL, S3-compatible local storage, Temporal dev service, fake Git/deployer and API/UI. Use a local runner backend for fast tests and a kind/k3d profile for Kubernetes recovery/isolation tests. Fixtures contain no production credentials/data. Developers can execute a feature, bug and report task with fake deterministic harness responses before using paid providers.

The local profile may relax HA and use test identities; these differences are explicit in values and cannot be deployed to production. Keep production-like authentication, contract validation, gate logic and idempotency behavior in local tests.

## Application health, reviewer capacity and autonomy

Collect application-health cohorts by application, change class, risk tier and qualified behavior release, never a single opaque autonomy score. Record 30/90-day agent-authored-line rewrite/churn with attribution uncertainty, merge/abandon counts and reasons, architectural review findings, escaped defects/severity, reverts, time-to-review and outstanding reviewer load. Separate immature windows, generated code, planned refactors and human/agent coauthorship; show denominators and missing data. Churn or merge rate alone cannot establish maintainability. Use human architectural review and sampled missed-findings audits alongside these metrics.

Policy owners and application owners jointly authorize a gate-mode revision with exact ledger/evaluation refs, scope, sample floor, observation window, expiry and rollback threshold. Sparse/immature evidence cannot justify relaxation. Control-plane rules may automatically tighten within a previously authorized degradation policy. They MUST record an autonomy_policy_decision and audit_event, emit policy.tightened task events with the decision ref for matching nonterminal tasks whose admission or publication is held, and re-evaluate affected work before publication. Relaxation always requires a fresh joint human decision; plan/intent floors remain human except under D5, while release authority and integrity floors stay intact. A changed model/prompt/tool/evaluator release creates a new qualification cohort; do not inherit earned autonomy automatically. M3 collects baseline evidence and retains human gates; later qualified M7 gate-mode changes retain this record; D5 establishment additionally uses the separate ReviewModeDecision journal, without a new workflow system.

Minimal transactional organization/provider/task admission ships in M2; M7 adds fairness, metering and production scale. Reviewer capacity is also a finite application resource: organization policy sets maxOpenPRsPerApplication and maxDiffLinesPerPR; an application owner MAY only lower them through ApplicationDefinition.reviewerCapacity (maxOpenPRs/maxDiffLines), validated against current policy; reserve before opening, release/reconcile on review completion, close or handover, and show backlog/latency. Calendar waits consume no runner slot. Sampling seed/decision is persisted before execution and cannot be rerolled on retry.

Pre-warmed execution is optional after cold-start measurements justify it. Prefer immutable prepared images/read-only content-addressed caches; a warm allocation can be claimed once, has no tenant secrets or previous task state, refreshes to the exact pinned base, and is destroyed after use. Never recycle an author-writable workspace across tasks or tenants. Warming does not replace allocation epochs, claims or isolation qualification.

Canary false success, protected-path or tamper violations, evidence-integrity failures, role-delivery attestation failures and isolation-breach signals suspend admission for the affected cohort, and hold its in-flight publication, under the pre-authorized degradation policy above. Clearing requires a human policy-owner decision. Active halts are visible in the operations view. See [chapter 22](22-reference-practice-adoption.md).

Campaign review budgets apply per owning team as well as per application. An owning team is an owner group in ApplicationDefinition.ownerIds, resolved by OIDC membership; a user-only owner is its own grouping key. Multi-owner targets count against every owner principal, both for budgets and human-wait measures (chapter 23). In human mode, earned auto-merge automates only the merge action after current-head human PR approval in every tier, limited in v1 to deterministic change classes with mature evidence. D5 separately permits qualified AI-reviewed dev merges for opted-in applications at any tier/change class within the recorded scope. Degradation reverts to human mode and manual human merge. See [chapter 23](23-readiness-recipes-campaigns.md).

Application health also reports root-cause category recurrence, regressions of earlier fixes, variant-analysis yield and prior-match accuracy. See [chapter 24](24-context-gathering-incident-learning.md).

## AI review authority and post-merge audit

ReviewModeDecision and append-only ReviewModeTransition records are application policy authority, written only by the trusted control plane after authentication of both human owners. Establishment requires current per-configuration ReviewerQualification evidence and both owner approvals effective no later than validFrom; pre_repository authority binds the draft application/organization repository-intent policy and the bootstrap controller adds the concrete repository binding at creation before any AI PR review or merge; rules can revoke/tighten, never establish or renew. The resolver checks scope, expiry, latest transition and exact model/prompt/tool/evaluator releases at admission, each gate, publication and merge. Emergency stop, revocation, expiry, configured degradation thresholds or configuration change atomically fence pending effects and return affected applications to human mode; notify and re-evaluate every affected nonterminal task before publication/merge. Clearance requires a new joint decision and qualification cohort when configuration changed.

Before any ai_only execution, the control plane MUST select and persist a configured share of outcomes for later human audit, using sampleBasisPoints in 1..10000 exactly equal to the referenced decision’s auditSampleBasisPoints, bound to task and decision/cohort, hidden from all agents and preserved across retries, continuations and rework. Audit assignment does not block merge. Auditors examine exact outcomes and evidence after merge; results, escaped defects, reverts of AI-merged changes and reviewer disagreements enter the application health ledger with denominators, severity, attribution and maturity. The jointly authorized policy MUST declare sample rate, audit deadline/backlog limits, observation windows/minimum samples and degradation thresholds for these signals. Threshold crossings automatically tighten to human mode and manual merge; missing/overdue audit evidence is handled by its declared fail-closed threshold, never taken as success. UI reports status, expiry, outstanding/overdue audits and the decision that tightened mode. INT-18 supplies these organization values; they are not presumed safe defaults.
