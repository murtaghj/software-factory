# 23 — Registry sources, readiness, change recipes and campaigns

Revision 1.7 makes the registry's data sources pluggable, makes onboarding and readiness explicit, and adds a way to apply one well-defined change across many repositories. It draws on Spotify's published experience with Backstage, Soundcheck, Fleetshift and the Honk background agent. Those systems inspired the design; their published figures are not claims about this factory.

Nothing here weakens an invariant, gate, human floor, bug red/lock/green or delivery authority. Each target repository in a campaign is an ordinary task that uses the existing runner, fencing, evidence and gates.

## At a glance

| Decision | Required behavior | Packages |
| --- | --- | --- |
| Pluggable registry sources | Organizational facts come from sources that plug in at import time. Tasks read only pinned snapshots. Factory-specific data always lives in Git. | W-098 |
| Agent-assisted onboarding | The factory drafts application definitions, verifying build and test commands by running them. Owners confirm before anything is published. | W-099 |
| Ownership gate | No factory work on an application without human-confirmed owners. | W-099 |
| Readiness by change class | Each application/change-class pair is assessed as automated, assisted or preparation required, with source revision and expiry. | W-100 |
| Change recipes | A versioned contract for a repeatable change, with typed outcomes and a deterministic or agentic executor sharing one evidence standard. | W-101 |
| Campaigns | One approved recipe across a pinned target set: canary wave, bounded rollout, per-team review budgets and pause thresholds. | W-102, W-103 |
| Auto-merge | In human mode, an earned automatic merge action after current-head human PR approval, limited in v1 to deterministic change classes with mature evidence. D5 ai_only instead requires joint opt-in and a qualified unanimous AI panel for dev-only merge; it is never earned automatically. | W-104 |
| Role-scoped tools and missing-context reports | Tool profiles per role and recipe. Agents report missing context as untrusted proposals input. | W-105 |
| Interactive takeover | An engineer can take a factory task into an interactive session and hand it back through an epoch transfer. | W-106 |

## Registry sources

Registry data falls into three kinds:

| Kind | Examples | Source |
| --- | --- | --- |
| Organizational facts | Components, systems, owners, dependencies, provided and consumed APIs | Pluggable `RegistrySource` adapters |
| Factory-specific data | Setup/build/test/deploy profiles, recipes, readiness, change classes, rules, knowledge | Factory-owned Git definitions only |
| Observed data | Traces, deployment inventory | ObservabilityProvider (chapter 08) |

**Sources plug in at import time only.** A `RegistrySource` adapter (see `contracts/interfaces.ts`) returns an immutable, digest-addressed snapshot with per-field provenance. The existing import protocol (chapter 08) validates the snapshot and publishes it atomically. Tasks and stages read only pinned registry snapshots (INV-04, INV-16). The factory MUST NOT query a live catalog during a task.

**A field-level authority map** names which source is authoritative for each organizational field. Where sources disagree, the import records a finding with both provenances and keeps the last valid value. Conflicts are never merged silently. Owners resolve them through the existing decision path, following the conflict handling in chapter 21.

**The default source is `GitDescriptorSource`.** It reads descriptor files from application repositories:
- Each descriptor has a core compatible with the Backstage `catalog-info.yaml` shape (kind, name, system, owner, dependsOn, providesApis, consumesApis).
- A separate `factory` extension section holds the factory-specific data.

Compatibility costs nothing now and keeps adopting a catalog later a configuration change.

**Today there is no organizational service catalog** (INT-12). For applications onboarded to the factory, the registry is therefore the source of truth for ownership and dependencies. It is not a general-purpose service directory: no browsing product beyond the factory's own screens is in scope. Adding another source, such as Backstage, a CMDB or a commercial catalog, is an adoption decision with exit criteria, made the same way as in chapter 22.

## Agent-assisted onboarding and ownership

Applications are onboarded incrementally, only when the factory is about to work on them. Teams are not asked to hand-write definitions in advance.

1. An authorized requester nominates a repository with a retained, human-supplied provisional data classification. Before any onboarding allocation or repository content access, W-115 MUST resolve eligible providers under closed INT-14 for that classification. Unknown classification MUST be treated as most restrictive and block real-content admission until a human supplies a classification under the organization policy; it never defaults to public.
2. An onboarding stage scans it read-only in an isolated allocation:
   - It infers build and test commands, then **verifies them by running them** under a pinned setup profile.
   - It extracts dependencies from package manifests and configuration, and interfaces from contract files.
   - It collects owner *hints* from `CODEOWNERS` files and recent commit history.
3. W-099 produces a draft descriptor as a proposal. It reuses the draft-then-confirm pattern from chapter 17. Inferred content is labelled as observation or hypothesis (INV-13). Nothing is published automatically.
4. A human owner corrects and confirms the draft. The confirmed descriptor is committed to the application repository through the Git adapter and imported through `GitDescriptorSource`.

After confirmation and import, W-100 uses the descriptor and observed evidence to produce the change-class readiness assessment (see below) before task admission.

**Ownership is an onboarding gate.** An application is ineligible for any factory work until named owners have confirmed ownership. Ownership hints alone never qualify. Peer review, oracle approval, PR review routing, rule exceptions and autonomy decisions all route to these owners.

Pilot applications are onboarded through this path. Full import automation and the observed graph remain W-037 and W-038 in M4.

## Readiness by change class

Readiness is assessed per application **and per change class**: for example, `dependency_update`, `config_migration`, `api_consumer_migration`, `bug_fix`, `existing_feature`. A repository may be ready for one class and not another.

An assessment records:
- observed setup, build and test results
- the checks available for the class and what they cover
- confirmed ownership
- the context the class requires (for example field mappings or contract files)
- conformance to applicable standards (chapter 21)
- source commit, assessment time and expiry

Levels:
- **`automated`:** execution may proceed under the normal gates.
- **`assisted`:** execution may proceed, but the class's outcomes require human verification beyond the default, because automated checks cannot establish the outcome.
- **`preparation_required`:** no execution for that class. The assessment lists the missing prerequisites, and preparation work (adding tests, standardizing builds) can be requested as ordinary maintenance tasks.

Readiness determines **eligibility** at admission, never gate outcomes. It cannot waive a gate. An expired or source-mismatched assessment is reassessed before admission. Readiness changes invalidate dependent admissions under the existing invalidation rules (INV-04).

## Change recipes

A change recipe is a versioned, owner-reviewed contract for a repeatable change:
- recipe ID, version and owner
- **preconditions:** when the recipe applies, and when it must not act
- the intended end state, described as an outcome rather than steps
- explicit mappings, for example field or API renames
- a small set of concrete before/after examples
- allowed scope (paths and file kinds)
- the executor kind: `deterministic` or `agentic`
- the verification recipes that demonstrate the end state
- stop conditions

**Typed outcomes.** Every target produces exactly one of:
- `changed`: a candidate that proceeds through the normal gates
- `already_compliant`: no change needed, with evidence
- `not_applicable`: preconditions not met, with evidence
- `needs_judgement`: the executor leaves the uncertain part unchanged, records structured judgement markers (and in-code comments only where the recipe permits), and routes to a human

Only `changed` produces a PR. For an existing-application recipe target, `already_compliant` and `not_applicable` reach terminal `succeeded` with outcomeKind `no_change_compliant` or `no_change_not_applicable` and a `recipeOutcomeRef` naming an immutable RecipeOutcomeRecord. The record binds the task input, recipe and pinned target revision to independently checked evidence. Chapters 04 and 10 define reconciliation through `delivery_complete` without a candidate, branch or PR. This branch MUST be part of the accepted recipe plan; it cannot close a bug or replace greenfield completion requirements. `needs_judgement` still routes to a human. An executor MUST NOT force a change merely because it was given a target.

**Deterministic transforms are a stage kind.** A `deterministic` recipe runs a pinned codemod or script in the same isolated execution and produces a candidate with **the same evidence and the same gates** as an agentic run (INV-16, INV-23). Prefer deterministic executors wherever no judgement is needed. They are cheaper and their output is reproducible. The `deterministic_transform` stage kind is a W-101 contract deliverable; until it lands, recipes run through the existing implement stage.

**Recipes are behavior releases.** A recipe or recipe version is evaluated before rollout (chapter 21) and changes only through a new version.

## Campaigns

A campaign applies one approved recipe version across many targets. It is a parent initiative whose children are ordinary target tasks.

**Approval and plan.** The campaign PlanReviewAssignment names one independent primary peer for the full packet (recipe version, targeting query, readiness requirements, rollout waves, thresholds and review budgets). Confirmed owners of every application in the pinned target snapshot are required specialist peers scoped to their targets (replaced by specialist-role AI slots only where every affected application has in-force D5 authority), alongside specialists required by chapter 19. An owner MAY delegate to a qualified independent reviewer under trusted policy. A target without every required owner/specialist approval is awaiting approval or deferred and MUST NOT execute. Target tasks execute only under that covered approval set. A `needs_judgement` outcome, or any deviation from recipe scope, returns to a human for that target and never widens the approved plan.

**Targets.**
- The target set comes from a registry query or a failing rule check, pinned as a snapshot when the campaign is approved.
- Admission derives changeClass from the pinned recipe, otherwise from the trusted work-type/path classifier with workType as fallback; callers cannot select a more permissive class. It is persisted on the task and matched to the pinned readiness snapshot.
- Only targets with readiness `automated` or `assisted` for the recipe's change class are eligible. Others are listed as `preparation_required`.
- Drift (new or changed repositories) is handled by explicit retargeting, which creates a new campaign revision and packet subject. All assigned peers MUST reconfirm, including owners of added or changed targets; chapter 19's no-automatic-carry-forward rule applies.

**Rollout.**
- A **canary wave** of a small configured number of targets runs first and must meet the campaign's thresholds before the rollout widens.
- Later waves run with bounded concurrency under existing admission (W-088). Campaign targets count against active-child limits. The total target count is bounded by the approved campaign rather than the default child limits in chapter 05.

**Review load.**
- Review budgets apply **per owner group** in ApplicationDefinition.ownerIds as well as per application; a user-only owner is its own grouping key. CampaignManifest.reviewBudgetsByOwner MUST name every target owner principal. A multi-owner target counts against each owner budget. Reserve all owner budgets atomically before opening a PR; a missing budget blocks admission. Application reviewerCapacity overrides MAY only lower organization maxOpenPRsPerApplication/maxDiffLinesPerPR.
- Owners may defer or opt out a target with a recorded reason. A deferral is an outcome, not a failure.

**Safety.**
- Pause thresholds are evaluated per recipe version: failure rate, `needs_judgement` rate, and review rejection or change-request rate. Crossing one pauses the campaign. Stop-the-line signals (chapter 22) halt it for the recipe-version cohort.
- A fixed recipe is a new version. Re-runs touch only failed or affected targets. Merged or otherwise completed targets are never re-run without an explicit new campaign revision.
- Open PRs whose base has moved are refreshed under existing expected-head rules or retired with a recorded reason. A campaign does not leave stale PRs for owners to clean up.
- A campaign's Git installation scope across many repositories is a reviewed security boundary.

**Visibility.** Aggregate progress (per-outcome counts, wave state, pauses, review backlog per owner group) is shown on a campaign view (chapter 12).

Orchestration uses Temporal child workflows with durable waits and timers. The parent task exposes CampaignState and the pinned CampaignManifest; reads, progress, pause/cancel, approve_plan and resume_campaign use the existing task and decision APIs in chapter 03. Onboarding owner confirmation and embargo lifting likewise use task-bound confirm_application_owners and lift_embargo decisions. No new execution path is introduced.

## Earned auto-merge in human mode

`merged` PR completion with **auto-merge** automates the merge action only after a human approves the current PR head. A change-class cohort can earn this through chapter 11's autonomy decisions (INV-25); human PR review remains a merge condition in every tier of human mode:
- In v1, eligibility is limited to change classes executed by **deterministic** recipes, with mature evidence: sample floor, observation window, low review rejection and revert rates.
- Agentic change classes are not eligible for this earned human-mode action in v1; D5 has separate opt-in authority.
- Auto-merge still requires current-head human PR approval, every required gate, current integration evidence and provider branch protection. It never bypasses human plan sign-off, which campaigns satisfy at campaign level.
- Degradation reverts automatically to manual merge under the pre-authorized policy; it does not change the human PR review requirement.

D5 separately permits ai_only dev merges, including agentic work within the recorded scope, at all tiers after unanimous panel approval and exact-head preview verification (chapters 05/10). It is not earned by cohort metrics. Mixed human/ai_only campaigns MUST split approval subjects by fully covered application scope or retain human approval for the shared subject; no target can inherit another application’s opt-in. Degradation restores human review and manual merge.

## Role-scoped tool profiles and missing-context reports

The factory tool-profile key is (role, stageKind, workType/recipe), resolved from the accepted plan:
- Stages of kind diagnose/investigate run as role discovery and receive evidence tools; bug work types receive the evidence subset allowed for their stage and role (chapter 22).
- Implementers of recipes whose task context is complete receive a minimal profile (`verify`, `submit_result`, `request_decision`, scoped repository reading). `get_evidence` is available only when the recipe declares a need.

Fewer tools reduce unpredictability for well-specified changes. Profiles are part of the compiled role package and the behavior release (INV-27).

`submit_result` accepts an optional `missingContext` list: what the agent needed but did not have. It is stored as labelled, untrusted text and feeds forensics proposals (W-091) and recipe revisions through human review. It never changes context or policy on its own.

## Interactive takeover

An authorized engineer can take a factory task into an interactive session, using an interactive agent environment or an IDE, and hand it back:
1. **Take over:** pause the workflow, stop the writer, checkpoint, and transfer the epoch to the engineer's branch or workspace (chapter 06).
2. **Hand back:** checkpoint and transfer to a new automation epoch. Dependent evidence is re-evaluated against the returned source (INV-03, INV-04).

The dashboard exposes take-over and hand-back as explicit commands with the current owner shown; both require the EpochTransfer payload and current task revision defined in chapter 03.

## Deferred decisions

- **Chat intake and multiplayer sessions:** deferred until the campaign workflow is proven useful. A future chat intake adapter treats thread content as untrusted input.
- **External catalog adapters:** only if the organization adopts a catalog, decided per chapter 22's adoption pattern.

## Traceability

- W-098–W-108 implement this chapter, the CI contract checks and the first-real-task cut.
- AC-156–AC-172 define its acceptance obligations.
- W-037 now depends on W-098, and W-033 depends on the first-real-task package W-107 (chapter 14).
- No public REST route is added. RecipeOutcomeRecord and no-change completion envelopes are supplied; recipe definitions, descriptor schemas and deterministic_transform remain package deliverables. W-101 and AC-250 qualify no-change completion; runtime behavior is not yet proven. W-105/W-122/W-136 implement the supplied factory tools 1.2.0 contract (missingContext, ledger tools and new get_evidence sources), required by investigation-discipline/1.0; admission negotiation is explicit and 1.1.0/1.0.0 histories stay pinned. contracts/interfaces.ts carries the provider interfaces.
- The reference SQL gains role and grant statements but no tables.

## Sources

Inspiration only. Figures reported by these sources are not adopted.

- [Spotify: Coding is no longer the constraint (June 2026)](https://engineering.atspotify.com/2026/6/code-with-claude-coding-is-no-longer-the-constraint)
- [Honk part 2: context engineering](https://engineering.atspotify.com/2025/11/context-engineering-background-coding-agents-part-2)
- [Honk part 4: dataset migrations](https://engineering.atspotify.com/2026/4/background-coding-agents-dataset-migrations-honk-part-4)
- [Fleetshift](https://backstage.spotify.com/fleetshift) and [Fleetshift MCP actions](https://backstage.spotify.com/docs/portal/core-features-and-plugins/fleetshift/mcp-actions)
- [Xirp](https://xirp.spotify.com/)
- [Backstage descriptor format](https://backstage.io/docs/features/software-catalog/descriptor-format)
