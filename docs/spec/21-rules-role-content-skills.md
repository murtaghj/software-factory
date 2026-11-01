# 21 — Rules, role content and admitted skills

Revision 1.5 integrates the [rules review draft](../review/21-rules-role-content-skills.md) with the amendments below. ADR-31 records this decision. This chapter owns rule resolution, role-content delivery and skill admission. It adds implementation obligations; it does not claim these services already exist.

## At a glance

| Decision | Required behavior |
| --- | --- |
| One rule, one owner | Stable rule ID, revision, authoritative statement, owner, scope and enforcement reference. |
| Policy stays outside candidate control | Factory policy → organization standards → application profile → repository conventions. Lower layers cannot grant authority or waive higher rules. |
| Required content arrives reliably | Compile one canonical role package for each qualified harness; prove delivery using controlled conformance fixtures. |
| Completion claims carry provenance | Factory tools 1.1 require structured feedback claims and an explicit deferred-work list. Feedback never becomes a gate verdict. |
| Third-party content is admitted | Pin, inventory, review, adapt and evaluate a local copy before use. No live marketplace installation inside runs. |
| Improvement remains deliberate | Paired evaluations and human-reviewed proposals; no automatic policy or prompt rewriting. |

All workflow gates, peer sign-off, greenfield intent alignment, bug red/lock/green and delivery authority remain in force. Shorter plans are permitted; missing obligations are not. These requirements apply across work types, including report-only investigation and documentation.

## Rule ownership, resolution and exceptions

A RuleDefinition contains a stable ruleId, revision, ownerPrincipalId, layer, statement, authoritativeSourceRef, applicabilityRef, severity, waivable flag and enforcementRefs. Applicability is an immutable, declarative policy artifact covering organization, application, work type, paths and environments; it is not candidate-supplied executable code. Each enforcement reference identifies an approved policy predicate, executable check or required human review with its configuration and evaluation version.

| Layer | Authoritative source | Enforcement |
| --- | --- | --- |
| Factory policy | Reviewed policy package | Stage graph, policy evaluator, capability proxy, admission and factory tool server. |
| Organization standards | Versioned standards repository | Trusted recipes, architecture/dependency checks and named review obligations. |
| Application policy | Versioned registry definition referencing approved sources | Application-scoped recipes and applicable standards. |
| Repository conventions | Exact source revision of instruction/configuration files | Accepted conventions and pinned recipes, subject to higher layers. |

The canonical rule statement expresses intent; an executable check implements it. A checker is not automatically correct. Every diagnostic identifies the rule revision and check/configuration revision. A rule/check disagreement produces a finding and an owner decision; the agent may not change the check, silently waive the rule or claim the check's accidental behavior is the intended standard. Unresolved blocking disagreements stop the dependent gate.

The resolver MUST load exact immutable source revisions, verify their integrity and ownership, select applicable rules, and produce a ResolvedRules artifact. That artifact records the input scope, bundle references, selected rule references, accepted exception references and resolver version. It is pinned in the application snapshot, plan and StageInput.inputBinding; its digest participates in inputHash and checkpoint compatibility. Identical inputs and resolver version produce identical semantic output, excluding observation metadata.

A lower layer MAY add compatible constraints. It MUST NOT override a higher rule. Duplicate IDs with incompatible definitions, conflicting scope or incomparable constraints are unresolved conflicts, not opportunities to guess which rule is “stricter.” Admission blocks until the appropriate owner resolves them. Repository instructions trying to change tools, role, gates, budgets or completion produce findings and are excluded from effective instructions.

A RuleException is an immutable proposal bound to the exact rule revision, task, application, resources, requested relaxation, compensating controls and validity interval. A separate RuleExceptionGrant references this unchanged proposal and its decision records, avoiding a circular approval hash. ResolvedRules.exceptionRefs points to grants. It becomes usable only after independent authorized human decisions by the rule owner and any higher policy authority required by the exception policy. Existing exact-subject DecisionView/DecisionResponse records implement this; one requiredPrincipalId decision is created for each required approver. Models may request a decision, never approve or activate an exception.

RuleException cannot waive nonwaivable invariants, the applicable human gate floors, canonical test integrity or capability boundaries; the separately authorized D5 mode is not a rule exception. Expired, revoked, wrong-scope or wrong-revision exceptions have no effect. Revocation is a new append-only decision/event; history is preserved. The controller rechecks validity at stage admission, gate evaluation and publication/deployment. A mid-run revocation blocks dependent results and causes cancellation/replan as required by policy; it does not rewrite historical evidence. New rules or exceptions invalidate dependent approval bindings and require the existing replan/review path.

Store standards and role source in reviewed Git repositories; immutable resolved artifacts belong in the artifact store. Postgres holds existing artifact references, decisions, imports and audit/projection records. Temporal carries references and hashes, not full rule bundles or transcripts. M2 needs the minimal trusted importer/resolver; the richer registry UI/import automation remains M4. No additional public REST service or SQL table is required by this revision.

Pilot applications declare their essential layering, dependency-direction and module-boundary rules as executable checks through this chapter's resolution before pilot enablement. A candidate cannot amend a rule or check that applies to itself. See [chapter 22](22-reference-practice-adoption.md).

## Canonical role packages and deterministic delivery

A RolePackage specifies role, objective, completion contract, requiredContentRef, tool-set version, applicable standards and admitted optional skills. Task-specific criteria, source and evidence remain in StageContext. Tool descriptions come from the pinned factory tool manifest. Preserve the qualified harness base prompt; do not replace vendor tool/safety mechanics casually.

RoleContentCompiler emits a CompiledRole artifact bound to the role package, resolved rules, adapter profile, compiler version, factory-controlled configuration, delivered content and delivery mechanism. Required instructions MUST arrive through a qualified prompt append or deterministic injection mechanism. Required behavior MUST NOT depend on the model choosing to open a skill. Optional skills may be discoverable, with activation measured.

Conformance uses synthetic fixtures and captures the actual assembled model request at the adapter/gateway boundary. The delivery attestation binds observed content digest, compiled-role digest, adapter/model profile and fixture. It proves that content was delivered, not that the model obeyed it. A stream that omits injected context is insufficient. An adapter without a demonstrable required-content path cannot qualify for that role.

Captures are restricted artifacts with redaction and retention policy; ordinary production runs do not require retaining raw prompt bodies. Operational provenance records the hashes and profiles used. Required content must fit the context budget without silent truncation; otherwise fail admission with a visible reason. Optional material is removed first. Cache layout is an optimization and cannot remove required instructions.

Start fresh on every role change. Native resume requires exact compatibility of role, content, rules, tools, model/adapter profile, source and checkpoint as defined in [context handling](07-harness-context.md). A revoked skill or incompatible content release blocks resume. Do not rely on vendor-specific resume behavior to refresh policy; SDK prompt-snapshot behavior varies with version and options.

## Pilot adapter configuration

The Claude Agent SDK pilot MUST use explicitly qualified configuration:

- Use the claude_code preset with the compiled role layer in append. A replacement system prompt requires a separate behavior evaluation.
- Disable inherited settings sources by default with settingSources: []. Supply required settings through a factory-owned configuration outside candidate-writable paths. Import reviewed repository conventions separately as untrusted context.
- Do not treat project-only settings as isolation: project configuration can contain hooks, plugins, permissions and environment settings, and supported settings can reload during a session. Creating or modifying candidate settings files must not alter effective runtime configuration. If a loader needs a project source, qualify a separate factory-controlled read-only layer and demonstrate that candidate paths cannot be discovered or reloaded.
- Set includeGitInstructions and attribution inside the SDK settings object; disable built-in Git guidance and use explicitly selected factory attribution values. The controller owns branches, commits and PRs.
- Use approved API/cloud/gateway authentication. Consumer subscription credentials and developer host settings are excluded.
- Treat excludeDynamicSections and other cache optimizations as version-qualified options, measured before rollout.
- Use fresh role sessions and the existing bounded factory decision tool for human input.

Pin the SDK, harness and compiler versions in the adapter profile. Qualification plants host/user settings and candidate CLAUDE.md, AGENTS.md, hooks, plugins and settings changes, including modifications after session start; none may expand authority or change factory-owned configuration. Read-only configuration alone is insufficient if another writable search path is still active.

These requirements follow the SDK's [system prompt documentation](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts) and [settings model](https://code.claude.com/docs/en/settings). Exact API support is a conformance obligation, not a cross-vendor assumption.

## Plan tasks, reuse and review

The plan packet's implementation section contains ordered ImplementationTask records. Each names outcome, dependencies, scoped paths/resources, criterion IDs and a check strategy. Executable tasks cite approved recipe references; non-executable work cites the required human/controller evidence and rationale. A task is small enough to verify independently, but task splitting cannot omit integration tests or review of the complete candidate.

New components and dependencies require a ReuseJustification: whether the addition is needed, existing code, standard library, platform and existing dependency alternatives, the choice and its tradeoffs. A new dependency also requires a supply-chain review reference before packet approval. The reviewer verifies license, provenance, maintenance, compatibility and vulnerability obligations from [verification and security](09-verification-security.md). “Less code” never excuses missing validation, accessibility, data integrity or recovery handling.

An unnecessary_code finding uses the existing implementation or design routing category and supplies concrete suggested deletions with reasons. The reviewer checks behavior and criteria before proposing removal. Advice alone is nonblocking; a cited criterion/standard violation follows ordinary severity and gate policy. New interfaces, data or dependencies that change the signed plan return to design and peer approval.

During PR rework, the agent addresses every applicable comment with a fix or evidence-based response. Disputed human comments remain open until the authorized reviewer/owner adjudicates them. The agent cannot mark itself correct or silently close review obligations.

Fresh native subagents per plan task are optional, separately qualified and charged to the parent stage budget. They retain the existing single-writer/worktree rules, authority limits and final independent verification. Native subagents never acquire control of the Temporal stage graph. The factory does not adopt external brainstorming, branch-finishing, merge or blanket test-rewriting workflows.

## Factory tools 1.1: claims and disclosure

The current manifest is [factory-tools.schema.json](contracts/factory-tools.schema.json), version 1.2.0. [factory-tools.v1.1.schema.json](contracts/factory-tools.v1.1.schema.json) and [factory-tools.v1.0.schema.json](contracts/factory-tools.v1.0.schema.json) preserve earlier contracts for pinned histories. Version negotiation is explicit at stage admission: rules-role-content/1.0 requires at least 1.1.0; investigation-discipline/1.0 requires 1.2.0. Later additive tool or field changes MUST use a new tool-set version and named qualification profile; 1.1.0 is never changed in place. Tools 1.2.0 adds SubmitResultToolInputV12 with optional untrusted missingContext, bounded GetEvidenceToolInputV12 queries and the five ledger tools. These are reference contracts, not proof of runtime qualification.

VerifyToolOutputV11 adds server-derived verificationRunId, stageRunId, inputHash, workspaceSourceDigest, visiblePackageRef, recipeRefs and completedAt. The supervisor binds these to its retained snapshot and receipt ledger. The digest uses the same complete source/configuration manifest as finalization; a working-tree patch alone is insufficient. Feedback status describes the selected recipe set only.

SubmitResultToolInputV11 requires feedbackClaims and deferredWork arrays, which may be empty. Claims cite the retained receipt, run ID, source digest, package, recipes and observed result; scope is current_source or historical. Historical baseline failures are legitimate evidence when labelled accurately. Current-source claims MUST match the final checkpoint source and pinned applicable package/recipes.

At proposal validation the supervisor MUST resolve cited receipts within the authorized task, compare all provenance fields and the structured status, and reject invented or contradictory claims. For each claimed recipe, check the latest completed relevant run for the same source, input binding, package and recipe revision; a later failure, inconclusive result or infrastructure error cannot be hidden by citing an older pass. Recipes split across runs still count individually. An aggregate non-passing receipt conservatively invalidates older passing claims for every overlapping recipe unless qualified per-recipe results prove otherwise. Pending relevant runs must settle or be explicitly cancelled and recorded before finalization. Historical claims cannot satisfy current-source completion requirements.

Finalization repeats the source/binding checks after the authoring pod is stopped and the retained PVC is mounted read-only, as specified in chapter 20. If source changed after feedback, rerun feedback or omit the current-source claim and report the limitation. Do not grant a passed gate from either option. An accepted proposal that later fails finalization follows the normal failed-result/retry path; it cannot be rewritten under the same receipt.

Invalid proposals return a bounded field/provenance error before consuming the accepted-proposal slot, allowing correction with a new callId. Identical retries retain idempotent receipt behavior. Schema validation checks structured claims; it does not prove every sentence of free text honest or every undisclosed shortcut absent. Reviewers compare prose to receipts and code; contradiction is a finding.

DeferredWork entries classify deferred work, shortcuts and limitations with affected criterion/rule IDs, impact and evidence references. Empty means “none declared,” not “proved none.” Entries flow to the OutcomeManifest artifact and health projections with attribution to the submitting role. Disclosure never waives an unmet acceptance criterion, required gate or safety rule; an authorized scope change must be reflected in a newly approved plan. Existing implementer limitations must agree with this list.

## Third-party admission and revocation

Treat third-party content and executable extensions as untrusted until admitted:

1. Vendor an exact source commit; record source URL, license, source-tree digest and adapted-content digest.
2. Inventory the complete bundle: instruction files, scripts, hooks, tool/MCP declarations, settings and transitive downloads. Review the content that will actually be loaded.
3. Remove conflicting control-flow, interactive, Git/delivery, network, test-mutation and authority instructions. Adapt selected techniques into the canonical role form; record the review and allowed roles.
4. Prefer instruction-only content. Any admitted executable hook/script is code requiring code review, sandbox/egress policy and capability qualification. Admission grants no additional privileges.
5. Evaluate the adapted local artifact as a BehaviorRelease and record a SkillAdmission binding content, roles, review and qualification evidence.
6. Load only the admitted digest from controlled storage. Re-review and re-evaluate every update; never follow an upstream branch or fetch a marketplace package from inside a run.

Revocation appends an authoritative admission-state record, blocks new runs and resumes, and triggers policy-directed cancellation/requalification for affected active runs. Immutable old records stay available for audit. Record delivery and actual activation separately. A source license change also requires re-admission.

Do not install the complete [Superpowers](https://github.com/obra/superpowers) workflow into the factory. Its small plan tasks, evidence-before-claims and review-feedback techniques inform factory-owned contracts. [Ponytail](https://github.com/DietrichGebert/ponytail) remains a candidate source for minimal-code guidance, not a pre-approved dependency.

## Evaluation and optional forensics

BehaviorRelease (W-086) pins prompt/instruction packages, role/standards packages, skill admissions, compiler/adapter configuration, tools, model, evaluator and tier policy. W-085 owns reviewer admission and UI; it is not the behavior-release implementation.

Use paired held-out tasks on the same base/model/harness, repeated enough for a predeclared analysis. Report outcome quality, false success, false refusal, review findings, required-content delivery, optional activation, cost and latency distributions. Include impossible-task canaries, rule/check conflicts, stale feedback, settings injection, dependency introduction and all supported work types. Check treatment activation and baseline contamination. Review security, accessibility and integration outcomes explicitly; smaller output alone is not an improvement.

The [JetBrains study](https://blog.jetbrains.com/ai/2026/07/ponytail-skill-claude-tested/) motivates measuring delivery and disclosure, not a universal performance promise. It observed no self-activation in ten sessions; its larger evaluation emulated ruleset injection rather than reproducing every hook. The reported code-size reduction was statistically uncertain, and no detected quality difference does not establish equivalence. Our own acceptance corpus decides admission.

An optional M4 scheduled forensics job samples failed, reworked and canary runs within retention/access limits. It examines observable tool actions, outputs, decisions and evidence; no hidden reasoning is required. It emits ordinary knowledge/change proposals linked to observations. An owner reviews each proposal, then the normal behavior-release evaluation applies. It never self-edits active rules, skills or prompts.

## Engineer-facing presentation

The task overview shows only blocking rule conflicts, required decisions and the count of disclosed limitations. A details panel shows the rule ID, intended requirement, observed violation, source/check revision and next action. The plan's implementation detail reveals ordered tasks, check strategy and reuse/dependency rationale. Reviewers see a compact deferred-work list linked to criteria; full artifacts remain available on request.

Policy exceptions display scope, approvers, expiry and compensating controls. A plain green status cannot hide a waived rule or an unmet criterion. Feedback is visibly labelled feedback; independent gate evidence has its own status. The main queue remains glanceable.

## Traceability and compatibility

| Work | Milestone | Acceptance |
| --- | --- | --- |
| W-089: rule ownership, resolution, exceptions and trusted checks | M2 | AC-130–AC-132, AC-141 |
| W-090: role compilation and third-party admission | M2 | AC-133–AC-135, AC-139 |
| Extend W-075/W-076: tool 1.1 contracts and pilot conformance | M2/M3 | AC-136, AC-137, AC-142 |
| Extend W-072/W-080/W-085: plan tasks, reuse, review and concise disclosure | M3 | AC-138, AC-140, AC-144 |
| Extend W-084/W-086: content/resume compatibility and release evaluation | M3 | AC-134, AC-145 |
| W-091: optional scheduled forensics proposals | M4 | AC-143 |

The rules-role-content/1.0 admission validator requires these fields beyond the historical wire schema:

| Artifact | Required for this profile |
| --- | --- |
| ApplicationDefinition / ApplicationSnapshot | standardsBundleRefs (possibly empty) / resolvedRulesRef. Global policy still applies without app-specific standards. |
| ExecutionPlan | contentQualificationProfile and resolvedRulesRef. |
| PlanReviewPacket | resolvedRulesRef, implementationTasks and reuseJustifications. Every planned work item has a check; a report-only plan uses report tasks. Empty reuseJustifications is valid only when no new component/dependency is proposed. |
| Harness StageInput / InputBinding | factoryToolSetVersion 1.1.0 or explicitly qualified 1.2.0; resolvedRulesRef, rolePackageRef and compiledRoleRef. Trusted verifier/publisher controller nodes do not pretend to be harness roles. |
| Harness StageContext | Matching resolvedRulesRef and rolePackageRef. |
| BehaviorRelease | contentQualificationProfile, rolePackageRefs, standardsBundleRefs, skillAdmissionRefs and compilerProfileRefs; arrays may be empty only when no corresponding optional content applies. |
| OutcomeManifest | deferredWorkRefs, including the finalized ledgers for submitted roles; an empty set means no relevant submission, not an inferred clean result. |

Cross-artifact digest equality, referenced ownership, exception/admission state and new-dependency completeness are service predicates, not properties JSON Schema alone can establish. A missing applicable field rejects admission rather than falling back to legacy semantics.

Domain envelopes remain 2.0 with additive optional fields so historical artifacts retain their meaning. The named rules-role-content/1.0 qualification profile requires the applicable new fields and the 1.1.0 contract at service boundaries; investigation-discipline/1.0 explicitly qualifies its 1.2.0 superset. Behavior-release admission enforces this profile; schema-only parsing is insufficient. This profile retains /v2; revision 1.13 advances the API description to 2.5.0, including the Finding extensions and chapter 03 contract corrections; workflow graphs/template versions do not change because these are content/admission/tool-contract obligations. Existing histories remain pinned until an explicit migration; no worker rewrites their rules or submissions. Static package checks are not provider or database qualification.

## Specialist AI reviewer content under D5

ai-review/1.0 MUST compile a qualified role package for every required primary, specialist/service-owner, adversarial and adjudicator slot. A specialist receives the chapter 19 assigned sections, domain obligations (including security, data, API, accessibility or operations where required), criteria, evidence and full packet context. No role or required sign-off may be dropped by switching ReviewMode. The adversarial role explicitly attempts to refute the plan/oracle; the adjudicator independently evaluates the existing finding/evidence/rebuttal record. Pin and attest exact model family/release, prompt/compiled content, tools and evaluator refs in each AIReviewDecision. Verdicts remain isolated until all members have submitted. Changing any of these suspends ai_only and requires a new qualified cohort plus joint human establishment. RuleException cannot establish or relax ai_only; D5 is a distinct human-owned policy decision. Human rule exceptions, privilege/scope decisions and human comment resolution keep their existing authority.
