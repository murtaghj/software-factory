# 17 — Greenfield, existing-project features and bug repairs

## Purpose and normative scope

These are three different execution journeys composed from the common stage contracts in chapter 05. They MUST differ in their prerequisites, ordered nodes, evidence, completion predicates and return paths. Changing a prompt, UI label or six-step progress bar does not implement this distinction.

Work intent remains one of eight WorkType values. Target context is a separate dimension: `new_application` or `existing_application`. A new service or independently owned application inside a monorepo can be greenfield. A repository move or a new repository containing existing behavior does not by itself make the work greenfield. Discovery verifies the boundary, ownership and existing obligations before accepting a plan.

| Entry journey | Normalized intent and target | Pinned template by ReviewMode |
| --- | --- | --- |
| Build something new | feature + new_application | greenfield: human 4.0.0; ai_only 5.0.0 (ai-review/1.0) |
| Add a feature | feature + existing_application | existing_feature: human 3.0.0; ai_only 4.0.0 (ai-review/1.0) |
| Fix a bug | bug + existing_application | bug_fix: human 3.0.0; ai_only 4.0.0 (ai-review/1.0) |
| Other work | Corresponding WorkType + existing_application | refactor, maintenance, performance, platform, documentation or investigation |
| Design something new | feature + new_application + design scope | greenfield_design: human 1.0.0; ai_only 2.0.0 (ai-review/1.0) |
| Design a feature | feature + existing_application + design scope | feature_design: human 1.0.0; ai_only 2.0.0 (ai-review/1.0) |
| Design a refactor | refactor + existing_application + design scope | refactor_design: human 1.0.0; ai_only 2.0.0 (ai-review/1.0) |
| Design a performance change | performance + existing_application + design scope | performance_design: human 1.0.0; ai_only 2.0.0 (ai-review/1.0) |
| Design a platform change | platform + existing_application + design scope | platform_design: human 1.0.0; ai_only 2.0.0 (ai-review/1.0) |

In v2 contracts, new_application is restricted to a feature initiative. Its foundation work runs as root stages; platform, documentation and feature child packages can target the registered experimental application after foundation acceptance. Work against an already registered dependency may be a separate existing-target child earlier. This restriction avoids inventing a passing baseline for a component that has not been built. A defect in a working experimental application is an existing-target bug even if its parent greenfield initiative is still open.

The task retains its origin context. A greenfield parent does not silently become an existing-feature task after registration. Its child tasks have their own explicit context, template and evidence.

## Intake and target identity

1. UI offers Build something new, Add a feature and Fix a bug, with the other work types available separately. The API receives WorkType and TargetContext, not an executable user-supplied workflow.
2. New work creates a draft application identity through `POST /application-drafts`. Supply name/key, accountable owners, purpose, constraints, intended interfaces, declared dependency IDs and minimum assurance. No repository, setup profile or deployed service is fabricated.
3. The response supplies applicationId, immutable draftRef and revision. TaskRequest includes that ID in applicationIds and in its new_application target, with optional provisional repository intent. Repository details may be resolved after the intent interview; accepted BootstrapPlan requires the explicit authorized choice. Existing targets reference a registered application with a usable definition.
4. Task creation validates tenancy, application ownership, draft revision, repository/provider namespace permissions and the same-organization dependency set. A draft application does not grant infrastructure or repository-creation authority.
5. Resolve and pin the allowed WorkflowTemplateRef through an Activity. Record ID, semantic version and immutable definitionRef. Discovery may propose a corrected context; applying it requires a new accepted TaskSpec/plan and dependency invalidation, never an in-place reinterpretation.

Application IDs identify applications, not repositories. Existing-project tasks may affect multiple applications and repositories; applicationIds contains the primary target plus affected applications. The primary target MUST be included. New-target tasks use a draft ID; normal existing-target admission requires a registered definition. Discovery can expand the affected set only through authorized scope revision.

Draft creation is idempotent and reserves an organization-unique application key. New-target task admission rejects already registered applications; subsequent work uses existing_application. Draft revisions are immutable and require If-Match for changes. Editing a draft does not update a running task's pinned snapshot. The specification includes separate draft read endpoints so an incomplete definition cannot masquerade as ApplicationDefinition.

## Greenfield path

The mandatory interview is specified in [chapter 18](18-intent-interview.md). A ticket alone cannot authorize foundation design: first establish shared, testable intent with the human, resolve material conflicts and confirm the exact brief. The later acceptance package traces to these agreed scenarios.

| Stage kind | Required output and gate | Return path |
| --- | --- | --- |
| product_brief | Provisional seed with known users, problem and questions; does not pass scope_accepted. | Missing intent → interview. |
| intent_interview | Adaptive human questions, concrete journey examples, coverage and issue register; preserve original answers and interpretations. | Ambiguity/contradiction → accountable human; unknown fact → authorized read-only discovery within this stage (chapter 19). |
| intent_challenge | Fresh independent review of the exact brief and proposed scope for gaps, incompatible expectations and unsupported assumptions. | Blocking finding → interview. |
| intent_confirmation | Exact version read-back, confirmation under ReviewMode and normalized TaskSpec; intent_aligned and scope_accepted. | Correction/stale subject → interview; silence/deadline never means approval. |
| foundation_design | Complete engineering packet: architecture, contracts/data, bootstrap/worktree strategy, implementation DAG, criteria/test scenarios, DoD, risks and delivery/recovery. | Unknown platform constraints → authorized read-only discovery within this stage (chapter 19); expanded product scope → interview. |
| plan_peer_review | Independent primary and required specialists approve the exact packet under ReviewMode; architecture_accepted, plan_peer_approved and plan_accepted. | Anchored findings → design/criteria; intent change → interview. |
| bootstrap_repository | Reconciled repository identity and real initial base commit, or pinned existing repository/subpath; bootstrap_ready. | Unknown creation result → reconcile; identity/ownership conflict → owner/operator. |
| scaffold | Source candidate implementing approved structure, locked tooling and owner-reviewed setup/verification/deployment recipes. | Invalid foundation approach → foundation_design. |
| verify_foundation | Independent clean-checkout setup/build/smoke evidence, appropriate startup or library/static-artifact checks, declared dependency checks and valid profiles; foundation_verified. | Tooling/code failure → scaffold; unsuitable architecture → foundation_design. |
| activate_application | Publish validated Git-backed application definition, repository mappings, owners and profiles; application_registered. | Invalid definitions/provenance → scaffold/profile review. |
| vertical_slice | Implement one accepted end-to-end user journey, reviewed acceptance package and independent outcome evidence; vertical_slice_verified. | Missing design/data flow → foundation_design; implementation defect → slice authoring. |
| compose_children | Instantiate bounded feature/platform/documentation packages for the remaining accepted scope, with dependency graph and shared reservations. | New requirements → brief/plan. |
| integrated_verify | Every mandatory child and accepted parent journey verified on the same source/dependency composition; parent_outcome_verified. | Integration mismatch → affected child/design; unknown outcome → inconclusive. |
| review, deliver, learn_close | Current scoped review, requested artifact/environment delivery and provenance/cleanup obligations. | Changed candidate → affected verification and review. |

The first scaffold is not a completed product. A passing build or health endpoint does not satisfy user acceptance. Conversely, greenfield does not require a deliberately broken predecessor: baseline_valid is not a greenfield gate. The reviewed TestPackage records expectedBaseline=not_applicable with a reason in the oracle package, and PlannedScenario records baselineExpectation=not_applicable; neither is shown as a passing baseline run. Build/tooling and dependency evidence remain mandatory. Existing dependencies retain their own compatibility obligations.

A small application can finish after a verified vertical slice when that slice covers every accepted parent criterion; compose_children then records an empty, justified expansion. integrated_verify remains required. A larger initiative creates typed children rather than one unlimited coding invocation. Default limits in chapter 05 still apply; greater scope requires explicit budget/time/capacity acceptance or separate linked initiatives.

For PR/patch delivery, foundation checks run in the isolated runner; no deployed preview is implied. The accepted deployment profile must validate, but actual provider provisioning and deployed behavioral verification are required when delivery is preview/production or an acceptance criterion demands them. When those checks require the Argo PR preview, the trusted controller first applies chapter 10 deterministic admission and creates/updates a labelled draft PR, then verifies the exact head SHA and image digests before ready-for-review. This preparation may precede foundation/product verification without completing deliver or any review gate; embargoed tasks never use it. A promised working preview cannot be downgraded to a profile document.

## Repository bootstrap and workspace boundary

A draft application may opt into D5 before a repository exists through the chapter 05 pre_repository decision, jointly approved against an organization repository-intent policy. Intent and architecture/plan review therefore precede repository creation without a prerequisite cycle. Creation appends the concrete ReviewModeRepositoryBinding after receipt/protection checks. Pending or failed binding permits no AI PR review or merge; namespace/bootstrap writes still require the separately approved BootstrapPlan and scoped controller credentials.

RepositoryIntent is either new_repository or existing_repository. New repository intent names a qualified provider/installation, allowed namespace, requested name, visibility and default branch. Existing repository intent names a registered repository, pinned baseCommit and approved subpath for the new component, nonempty unless the intent adopts a retained bootstrap repository at its root. Root adoption uses the canonical empty string and rootAdoption.retainedBootstrapReceiptRef; the service MUST verify that receipt’s repository identity, retained disposition and real base, plus current owner approval and scope review. Cross-field authorization and safe-path validation are mandatory service checks.

The accepted BootstrapPlan adds a pinned initialization template, approved bootstrap setupProfileRef, proposed application snapshot, architecture reference, allowed paths and operation identities. In an existing repository the template is a reviewed scaffolding input only; no empty-repository initialization runs. For new repositories, the Git provider reconciles ensureRepository, then initializes an empty repository conditionally from a minimal approved template. The receipt records the real full Git object ID and source artifact. The base initialization may contain repository metadata/tooling skeleton agreed in the plan; business implementation belongs on the task branch. This explicit authorized bootstrap write is not an application merge or production release.

Only after a durable base receipt exists may WorkspaceManager allocate ordinary task worktrees using the approved bootstrap setup profile. Application-specific setup profiles are accepted during foundation verification. Do not weaken WorkspaceRecord.baseCommit to an empty string, zero hash or optional field. The bootstrap controller has its own durable operation record and scoped provider credentials; a coding pod never receives repository-creation credentials.

For an existing monorepo, skip remote repository creation and initial-commit writes. Resolve the accepted real base, create an isolated task branch/worktree and enforce the approved path boundary. Additional shared-file changes require explicit scope review. Bootstrap permission does not authorize overwriting existing files, force-pushing a default branch or replacing an existing application's definition.

All side effects use stable operation IDs and request hashes. A create timeout requires lookup by operation identity and immutable external repository ID; a same-name repository is not proof of ownership. Duplicate bootstrap requests attach to the same accepted receipt or return conflict. If the provider cannot establish an authoritative outcome, hold at needs_operator with no second create or initialize attempt.

Cancellation reconciles outstanding operations and preserves receipts/checkpoints. External repositories are retained with an owner and an explicit disposition requirement; they are never deleted automatically as temporary execution cleanup. Unknown bootstrap effects retain the application claim. Once reconciled cancellation releases the active claim, a new linked task can explicitly adopt the retained repository through existing_repository intent; it still requires scope/owner approval and a new plan. Adoption at the root requires subpath "" and the retained bootstrap receipt reference; bare empty paths, ".", "./" and "/" are rejected. Existing root files remain protected by the no-overwrite rule unless the new reviewed plan explicitly names the changes. Resume within a nonterminal task uses the same operation identities.

## Existing-project feature path

Discover the current architecture, repository state, owners, consumers and deployment composition. Build a FeatureImpact artifact listing changed behavior, invariants that must remain, affected contracts/data, migration or rollout requirements and uncertainty. Known failing baseline checks are recorded separately and cannot be attributed to the new candidate or silently quarantined.

Pin criteria and an independently reviewed acceptance package. A missing-feature assertion failing on the old version can strengthen evidence, but is not a universal requirement. A setup failure is not evidence of feature absence. Weak oracles return to criteria review; expectations cannot be weakened after seeing the candidate merely to obtain green.

Implement in isolated worktrees from recorded real bases. Independently execute new acceptance scenarios and the applicable existing contract/regression matrix. Compatibility failures may require API/design revision, consumer coordination or a platform/migration child. Make only the exact integrated candidate that passed the required gates reviewable; an admitted draft preview may precede the environment-dependent verification.

## Bug-fix path

Use the causal diagnosis procedure in chapter 08. Construct and review a regression oracle from accepted expected behavior. Execute it on pinned baseline B and require the intended assertion failure. Freeze the complete package, fixtures and recipe outside authoring authority. Repair candidate C, then independently run the same package and affected regressions under comparable inputs. For verified-fix delivery, C MUST contain the permanent-suite test copied from the locked package or a declared equivalent; verify its equality or equivalent intended red on B and green on C before accepting green, with only a recorded owner retention exception as described in chapters 05 and 24.

No assurance or invocation mode can skip intended red, package locking or candidate green for a verified bug closure. A wrong baseline, unavailable reproduction, infrastructure error, changed oracle or nondeterministic result cannot be relabeled repaired. Return to diagnosis/oracle review, preserve every attempt, and repeat baseline red for a revised canonical package. A linked investigation can deliver findings without claiming the bug is fixed.

## Shared engine and template contract

TaskWorkflow executes a validated versioned plan. WorkflowTemplateDefinition reuses registered PlanNode kinds and common Activities/providers. Templates are trusted, versioned factory configuration, not agent-authored executable code. The three template examples are in `examples/templates/`; their artifact refs are fictitious placeholders, while dependency and gate structure are validation fixtures.

Shared components include context selection, artifact storage, workspace allocation, harness execution, oracle authoring, trusted verification, skeptical review, decisions, delivery and learning. Templates specialize their inputs, gates, capabilities, ordering and legal returnTargets. Guarding progression remains the gate evaluator's responsibility.

ExecutionPlan contains the complete WorkflowTemplateRef. InputBinding contains the immutable workflowTemplateRef artifact, bootstrapPlanRef/foundationRef where used, and intentBriefRef/intentDecisionRef required for aligned greenfield work. WorkflowCheckpoint.intentStateRef preserves interview continuity. WorkflowCheckpoint preserves the plan reference and, for an active greenfield task, bootstrapStateRef linking its durable operation/claim/receipt state. A template upgrade does not change a running task's stage graph or replay behavior. Adopting a new version requires explicit plan migration and reevaluation; old histories remain pinned.

Before registration, applicationSnapshotRef may reference an ApplicationSnapshot containing the accepted draftRef and registered dependency definitions. Such a snapshot is permitted only for greenfield foundation stages. Following registration, publish a new snapshot and plan binding for the slice/children. Reevaluate gates affected by the change; original draft/design receipts remain immutable supporting evidence. Registration alone cannot manufacture a valid outcome gate.

## Completion and rework rules

| Journey | Non-negotiable completion evidence | Characteristic return |
| --- | --- | --- |
| Greenfield | Current intent confirmed under ReviewMode, real source identity, verified foundation, validated application definition/profiles, accepted journeys and mandatory children verified as a composition, scoped delivery. | Foundation failure → architecture/scaffold; child conflict → design/integration. |
| Existing feature | Accepted added behavior plus applicable preserved behavior, contract/migration evidence and current delivery candidate. | Consumer regression → contract design or implementation. |
| Bug fix | Intended baseline red, locked reviewed package, independent candidate green and broader regression evidence. | Weak/wrong reproduction → diagnosis or oracle review. |

These predicates are additional to access, current binding, budget, review and delivery invariants. Passing a common verifier step does not erase the journey-specific obligations. Changed scope, test oracle, profile, source, dependency composition or relevant template invalidates dependent evidence and produces a new attempt/plan as appropriate. A new PR commit returns the revision to draft/preview_only; rework repeats admission, advances the current environment generation and verifies its exact head/digests before ready-for-review. A draft never satisfies pr_created or review gates.

## UI and implementation traceability

Show the selected journey and current meaningful milestone, not a universal Build label. Greenfield intake starts a draft and mandatory human interview; existing feature and bug intake select a registered target. Keep assurance, invocation count and delivery separate. Show a concise reason for any reclassification and the stage/evidence it invalidates.

Glanceable views keep required failures, unresolved questions, current subject and the next user action visible. Greenfield shows foundation readiness separately from product acceptance; existing features show acceptance and compatibility; bugs show red/lock/green. Detailed manifests and complete histories expand on request. A pending advisory choice cannot waive a required failed gate.

Implementation owners: W-063–W-074. Acceptance scenarios: AC-61–AC-94, including mandatory interview and default human confirmation; D5 adds the qualified AI confirmation alternative. Existing feature and bug work packages retain their original evidence obligations. Greenfield new-repository and monorepo fixtures are required for full v1, while the M3 pilot remains explicitly limited to existing targets until bootstrap qualification is complete.

## Design-only journeys

Delivery scope `design` selects one of the five design templates above under the design-delivery/1.0 profile. Each is a distinct pinned template ending after peer review, render_design, deliver, delivery_complete and learn_close (chapter 05). greenfield_design keeps the full interview, independent challenge and intent confirmation before foundation design; it never reserves a repository, bootstraps or registers the draft application, so a design-only greenfield draft stays a draft and, lacking a design-docs location, delivers its design as a report artifact. Templates are generated in `examples/design/templates/`, with ai-review variants in `ai_only/`.

A build from an approved design uses the ordinary journey template for its work type and target (for example existing_feature 3.0.0/4.0.0 or greenfield 4.0.0/5.0.0) with the same nodes. Under design-delivery/1.0, pinned in the behavior release and recorded as designProfile in InputBinding/ExecutionPlan, the plan and intent/plan review controllers may adopt a current packet and its exact approvals through a DesignBuildBinding (chapter 19); otherwise they replan. Histories admitted before profile enablement never receive a binding, and an unknown profile fails closed. Template, profile and binding changes require explicit qualification like other template versions.

## Revision and compatibility

Revision 1.4 advances greenfield to 4.0.0 and existing_feature/bug_fix to 3.0.0 for explicit delivery follow-through. Revision 1.3 added mandatory peer sign-off in greenfield 3.0.0 and existing_feature/bug_fix 2.0.0; [chapter 19](19-peer-plan-review.md) defines it. Spec revision 1.1 closes the missing greenfield path; revision 1.2 makes its intent interview and human confirmation mandatory in template 2.0.0 (see chapter 18). Domain wire contracts advance to 2.0 and REST contract to /v2 because target context and workflow bindings are newly required. The old reference draft is not silently accepted as an equivalent request. Regenerate clients and implement any necessary explicit legacy migration before importing data built from revision 1.0. Unchanged machine-readable backlog/acceptance formats retain their own 1.0 versions. Revision 1.13 adds the design templates at new IDs (human 1.0.0, ai-review 2.0.0); existing journey template versions are unchanged.

The accompanying SQL is a fresh reference schema, not an executed production migration. An implementation with existing data must add nullable target/binding fields, resolve and backfill provenance with an audit, then enforce constraints. Do not infer greenfield solely from an empty repository. Unknown legacy context requires review. Existing task histories must retain their original contracts/templates until their versioned workflow implementation is safely retired.

## Revision 1.4 shared completion behavior

The three journeys retain their distinct scope, prerequisite and evidence paths. All now use signed structure outlines, factory-tool feedback and independent evidence classes. Every compiled journey includes the applicable delivery_complete controller predicate after publication and before outcome recording, with pr_review handling explicit PR follow-through. Human review findings return to the appropriate discovery/design/criteria/implementation authoring node; they never bypass bug baseline/package rules or greenfield intent/foundation gates. After register, a greenfield scope or design return from pr_review MUST use a linked or child revision with renewed applicable intent and exact-packet peer approvals, then reverify the affected parent composition; it MUST NOT re-run bootstrap_repository or activate_application. Investigation and other qualified templates must adopt these same shared contracts before enabling the 1.4 behavior profile.

The pilot remains existing-project feature, reproducible machine-reported bug and investigation. Greenfield interview/bootstrap/foundation are specified for later qualification; the assisted unreproduced proposal graph itself remains a W-082 deliverable and is disabled until separately defined and qualified; choosing Claude as the sole pilot runtime does not shorten any supported journey graph. INV-05 and INV-21 remain nonwaivable in fast and one modes.
