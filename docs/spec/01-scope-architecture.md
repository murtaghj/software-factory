# 01 — Scope, architecture and invariants

## Product behavior

An authorized user submits engineering intent against an application, system or repository. The factory determines the work type, gathers applicable facts, plans a bounded approach, executes through a chosen harness, obtains independent evidence, delivers the selected artifact and records reviewed learning. A task may finish with a report, a patch, a PR, a preview, an observed production release or, for the `design` delivery scope, a delivered approved design that is not implemented.

Eight first-class types are feature, bug, refactor, maintenance, performance, platform, documentation and investigation. Intent is independent of target context: new_application versus existing_application. Feature intent can therefore select either greenfield or existing_feature; bug intent selects bug_fix for an existing target. [Chapter 17](17-project-journeys.md) defines these three journeys, their prerequisites and completion predicates. A mixed request becomes a parent with typed child work packages and explicit dependencies. “Single shot” is an invocation budget; it is not a work type or permission to bypass gates. Likewise “design only” is a delivery scope over feature, refactor, performance or platform intent, not a ninth work type (ADR-34).

## Reference decisions

| Decision | Implementation default |
| --- | --- |
| Language/runtime | TypeScript in strict mode, Node.js 24 LTS, pnpm workspace with a committed lockfile. Pin exact patches and container digests at M0. |
| HTTP/UI | Fastify API, React dashboard, server-sent events for task updates. Business logic remains outside route handlers. |
| Durable coordination | Temporal TypeScript workflows and Activities. Managed Temporal is the reference operating choice; self-hosting uses the same contracts with its own operations work package. |
| Application database | PostgreSQL 18; SQL migrations and parameterized queries through `pg`. Keep migration privileges separate from runtime privileges. |
| Artifact storage | S3-compatible object store behind ArtifactStore; immutable keys, integrity hashes, encryption and configurable retention. |
| Execution | Kubernetes Jobs managed by a runner controller; independent pools for authoring and trusted verification. |
| Harnesses | Claude Code via the Claude Agent SDK is the M3 pilot runtime; Codex is the M4 portability adapter, followed by OpenCode. Capability tests, not names, determine eligibility. |
| Git integration | GitHub reference adapter, replaceable through GitProvider. Branch/PR identity stays in factory records. |
| Deployment | DeploymentProvider with Argo CD ApplicationSet branch previews as the reference Kubernetes provider and the existing MCP adapter as an equal alternative; each requires conformance (chapter 10). |
| Knowledge | Git-maintained definitions indexed into Postgres; full-text retrieval initially. Object storage for evidence. |
| Initial tenancy | One organization per deployment, with organization IDs on all owned resources and tenant-qualified foreign keys. Wider multi-organization hosting requires the isolation qualification in chapter 11. |

These are implementation choices, not vendor mandates. [Node release status](https://nodejs.org/en/about/previous-releases) confirms the selected runtime line is LTS; exact package versions belong in the implementation lockfile.

## Required invariants

| ID | Rule |
| --- | --- |
| INV-01 | Workflow code performs deterministic coordination; all external I/O, model calls, Git commands and deployments occur through Activities/providers. |
| INV-02 | Infrastructure retries retain logical operation identity. A new semantic attempt receives a new attempt ID and cannot overwrite old evidence. |
| INV-03 | A workspace has at most one accepted writer epoch; old writers cannot publish checkpoints, refs, results or environment changes. |
| INV-04 | Gates apply only to the exact versioned input set they evaluated. Any material input change invalidates dependent evidence. |
| INV-05 | A bug closure requires intended baseline failure, reviewed immutable regression package, and candidate success under comparable conditions. |
| INV-06 | Other work types use their declared evidence criteria; investigations and reports can complete without code or deployment. |
| INV-07 | Authoring agents cannot modify canonical checks, trusted runner configuration, policy or independent verdicts. |
| INV-08 | Every external side effect has an operation ID, reconciliation path and recorded outcome; unknown outcomes are not retried blindly. |
| INV-09 | Source, handoffs and evidence survive loss of an execution pod once the checkpoint is acknowledged. Unacknowledged work may be lost. |
| INV-10 | Harness/session state is optional continuity; portable source and explicit artifacts are sufficient to restart in another harness. |
| INV-11 | Budget exhaustion, timeout, missing checks and inconclusive results never become success. |
| INV-12 | Delivery scope is explicit and bounded. A PR request does not imply merge or production release. A design request delivers only the approved engineering packet; it never implies implementation, verification or merge. |
| INV-13 | Declared facts, observations and hypotheses retain distinct provenance, scope and validity. Learned prose cannot grant tool permissions. |
| INV-14 | IDs and artifact access are authorized for the owning organization and task; knowing an ID confers no access. |
| INV-15 | Cancellation stops new work, reconciles in-flight side effects and schedules cleanup; terminal state preserves the actual result. |
| INV-16 | Verification and release trace to exact source composition, test package, environment plan and produced artifact digest. |
| INV-17 | Accepted intent and target context select a pinned compatible workflow template; scope/template changes create new bindings and invalidate dependent evidence. |
| INV-18 | A draft application cannot pose as a registered service. Worktree allocation requires a reconciled repository identity and real base commit; unknown bootstrap effects retain their ownership claim. |
| INV-19 | Greenfield completion requires verified foundation and accepted product behavior on the integrated mandatory-child composition; a scaffold or health check alone is insufficient. |
| INV-20 | Greenfield design/bootstrap/implementation requires a current exact-brief intent confirmation after human interview and independent challenge: human owners in human mode, or the qualified AI panel under an in-force application ai_only decision (D5); unresolved material intent and stakeholder conflicts block, and changed intent reopens affected questions. |
| INV-21 | Planned implementation requires a complete engineering packet with criteria, test scenarios and DoD, approved on the exact subject by independent qualified human peers in human mode, or the qualified AI panel including every required specialist role under D5; required specialist decisions and affected reapprovals cannot be bypassed. |
| INV-22 | Summary, review and full-plan views share one immutable subject; material risks/blockers stay visible, and planned evidence or reading telemetry cannot masquerade as verification or approval. |
| INV-23 | Agent feedback and submitted results cannot satisfy verification gates; completion requires a fenced, immutable, durably finalized source/result binding. |
| INV-24 | PR completion follows its accepted policy and exact head; comments cannot grant authority, and abandoned or unreproduced work cannot become a verified success. |
| INV-25 | Autonomy is scoped to application, change class, risk and qualified execution configuration; only joint human policy-owner/application-owner decisions may establish ai_only at any assurance tier, after reviewer qualification; rules may only tighten it. Release authority stays human and integrity floors cannot be relaxed. Revocation, expiry, emergency stop, degradation or reviewer configuration changes fail closed to human mode before further publication/merge. |
| INV-26 | Rules have pinned ownership, scope and enforcement; lower sources and exceptions cannot waive nonwaivable authority or integrity requirements. Conflicts and exception revocation are explicit. |
| INV-27 | Required role content is deterministically delivered through a qualified configuration; only admitted content may load, and guidance never grants authority or replaces independent evidence. |
| INV-28 | Content reaches a model provider only when the data classification of every repository and evidence source in scope permits that provider; embargoed security work is visible only to its authorized group until the embargo is lifted. |
| INV-29 | AI review decisions MUST record AI identity, reviewer configuration, model family and exact immutable subject; they MUST NOT satisfy, populate or be displayed as human approvals. PRs, outcome bundles and UI MUST show ReviewMode and “AI-reviewed — no human review” for ai_only work; voluntary human review is separate. |

## Deployable components and ownership

| Component | Owns | May not own |
| --- | --- | --- |
| API/dashboard | Authorization, validation, command inbox, task queries, review interaction, audit requests | Advancing stages by editing a task row |
| Dispatcher/reconciler | Launch outbox and command delivery to stable Workflow IDs | Inventing successful workflow outcomes |
| Workflow workers | Task/child/environment progression, versioned plans, durable waits and rework decisions | Running shell processes inside workflow code |
| Activity workers | Registry snapshots, context creation, provider requests, persistence and runner attachment | Assuming a timed-out provider operation did not happen |
| Runner controller | Jobs, workspace leases/generations, result publication, cancellation and sweeps; mints allocation-scoped model-gateway credentials restricted to model profiles eligible for the allocation's data classification (INV-28) | Deciding product correctness from an author's claim; authoring provider eligibility policy |
| Execution supervisor | Coordinates one harness, serves scoped tools, enforces limits, streams events and requests runner-controlled checkpoints | Git merge/deploy credentials outside the assigned capability set |
| Verifier supervisor | Materializes exact inputs, executes canonical recipes and signs result provenance | Accepting candidate-authored final status files as trusted evidence |
| Git/delivery adapters | Reconciled refs, PRs, release operations and environment handles | Treating a PR comment as authorization to release |
| Registry/knowledge module | Git import, dependency graph, observation index, versioned fact retrieval | Silently rewriting source-of-truth declarations |

Run these as separate processes/images even if packages share a repository. Registry, policy and artifacts begin as modules exposed by the API; do not extract extra network services until justified. The runner is a separate deployment from the workflow worker so worker reconnection does not determine process survival.

## Repository structure

```text
apps/api             task API, OIDC, SSE, registry endpoints
apps/dashboard       task, review, environment and application views
apps/dispatcher      outbox and command delivery, reconciliation
apps/worker          workflow registration and Activity entry points
apps/runner          control-plane reconciler and workspace manager
apps/supervisor      per-job harness execution and checkpoint client
apps/verifier        trusted verification launcher and result collector
packages/contracts   JSON Schema, generated TS types, API definitions
packages/domain      deterministic state/gate/budget rules
packages/database    SQL migrations and repositories
packages/artifacts   manifests, integrity, storage and authorization
packages/registry    catalog import, graph, facts and observations
packages/context     retrieval, token allocation and handoffs
packages/policy      versioned rules, risk assessment and decisions
packages/workspace   Git worktrees/clones, checkpoints and restore
packages/harness     common adapter + codex/opencode/claude adapters
packages/git         Git provider, publish and merge reconciliation
packages/deployment  Argo/MCP adapters, provider mapping and environment plans
packages/telemetry   factory traces and external observability adapters
packages/verification canonical packages, oracle review and results
deploy/helm          component charts, RBAC, policies and values schemas
fixtures             small applications and deliberately faulty versions
tests                 contract, workflow, recovery, isolation and system suites
docs/spec             this specification and generated reader
```

## End-to-end transaction boundaries

1. API validates authorization, target context and pinned draft/registered identity, then inserts Task, TaskSpec version 1, idempotency record and launch outbox in one transaction. For a new target, claim the draft application for this bootstrap task transactionally. Return 202 with task and operation IDs; no remote repository creation occurs in the request transaction.
2. Dispatcher starts `factory/{orgId}/{taskId}`. A lost reply is reconciled against the same Workflow ID; never start a second task workflow.
3. Workflow resolves immutable application/policy/template snapshots through Activities. It selects the plan and persists stage records before execution.
4. Runner receives a stable stageRunId and input hash, allocates/attaches, then acknowledges its durable run record. Supervisor may outlive its Activity connection.
5. Results/artifacts persist first. The Activity returns references; workflow validates version/binding and computes the next stage. A separate idempotent projection Activity updates dashboard records.
6. Delivery verifies authorization and evidence immediately before its reconciled side effect. Cleanup and learning follow the selected outcome.

## Explicit release boundary

The M3 pilot covers existing-target feature, machine-reported reproducible bug and investigation with PR/report delivery, using one qualified Claude runtime across all required roles/stages. Pilot fixtures include human plan and oracle approval and bounded PR-review follow-through; a single runtime never removes workflow nodes or gates. The full v1 also covers greenfield new-repository and monorepo journeys, the other five types, preview deployment and qualified production delivery. Bootstrap and greenfield completion are qualified in M4/M6/M8; they are not silently claimed by the M3 feature pilot. All are specified now; the build sequence controls rollout rather than leaving behavior undefined. Hermetic environments, cross-region active-active operation, omission of plan approval and automatic policy relaxation are excluded from v1. Design-only delivery (W-144, M6) is part of full v1: it runs the complete planning and peer-review gates, renders and delivers the approved packet, and stops; a later linked build can reuse that packet only while it remains current. D5 permits explicitly opted-in applications to replace mandatory human reviews with qualified AI panels, including all specialist sign-offs, at any assurance tier; it never removes a gate or grants production authority. Joint recorded human decisions establish this mode; preauthorized degradation rules may only tighten it. No schedule should depend on implementing a new coding harness.
