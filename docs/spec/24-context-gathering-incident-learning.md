# 24 — Context gathering and learning from past issues

Revision 1.8 makes context gathering explicit and turns past bugs into reusable evidence. The same failures tend to recur, so the factory should recognize them, check whether the same flaw exists elsewhere, and turn repeated causes into prevention rather than another point fix.

This chapter builds on existing parts:
- discovery and the plan packet (chapters 05 and 19)
- the deterministic context builder (chapter 07)
- DiagnosisManifest and knowledge records (chapter 08)
- rules and checks (chapters 21 and 22)
- recipes and campaigns (chapter 23)

A match with a past incident is a hypothesis, never proof. Reproduction, red/lock/green and independent verification remain mandatory for verified fixes (INV-05).

**Compatibility.** incident-learning/1.0 adds evidence and content obligations enforced at behavior-release admission, including the ContextManifest blocking-gap predicate on scope_accepted and regression-test retention or an owner exception at delivery. The policy and evaluator versions MUST be pinned before admitting affected tasks. Workflow template versions do not change; existing_feature/bug_fix 3.0.0 histories pinned before this profile is enabled retain their original gate semantics and are not retroactively blocked. Incident matches and variant analysis remain advisory evidence and never satisfy gates.

## At a glance

| Decision | Required behavior | Packages |
| --- | --- | --- |
| Discovery context manifest | Discovery records the sources it consulted and the gaps that remain; peer reviewers see them before approving a plan. | W-109 |
| Tracker and code-history evidence | Read-only access to tickets, linked tickets, comments and earlier PRs on the affected paths. Content is untrusted. | W-110 |
| Failure signatures | Every diagnosis carries a normalized, versioned failure signature. | W-111 |
| Prior-incident matching | New bugs are matched against past diagnoses; matches arrive as labelled hypotheses. | W-111 |
| Regression memory and root-cause categories | Verified fixes keep their regression test in the permanent suite. Diagnoses record a reviewed root-cause category. | W-112 |
| Variant analysis | After a verified fix, a read-only search looks for the same flaw elsewhere; confirmed variants become linked tasks or recipe proposals. | W-113 |
| Recurrence escalation and match usefulness | Recurring categories raise systemic proposals for owners. Match accuracy is measured, and misleading lessons expire. | W-114 |

## Discovery context gathering

Discovery is the factory's context-gathering stage. It investigates repositories, dependencies, telemetry, tickets, history and prior incidents. The deterministic context builder (chapter 07) then selects what each later role sees.

Discovery's output now includes a **ContextManifest** (produced by diagnose, impact, or greenfield brief/interview as mapped in chapter 05; greenfield confirm_intent reads it before scope_accepted):
- the sources it consulted, each with its revision or time range and why it was consulted
- prior-incident matches considered and how they were classified
- remaining gaps, each marked `blocking` or `nonblocking` with its expected impact
- assumptions, labelled as such

The manifest appears in the plan packet's current-state section (chapter 19), so peer reviewers can judge whether the plan rests on enough context before approving it. A blocking gap keeps `scope_accepted` unmet, consistent with the existing rule that uncertainty is recorded rather than assumed away (INV-11). The post-run `missingContext` report (chapter 23) checks the same question after execution. Comparing the two over time shows where discovery systematically misses context.

### Tracker and code-history sources

`get_evidence` gains read-only adapters for:
- **the issue tracker:** the ticket, linked tickets, comments and status history
- **code-host history:** earlier PRs and commits touching the affected paths, with their review comments
- **documentation and decision records:** design documents and ADR repositories; this adapter is optional in the pilot

Access follows chapter 22:
- scoped organization, task and application authorization (INV-14)
- bounded results and redaction
- a recorded access trail

All returned content is **untrusted** (INV-13). Instructions inside a ticket or comment cannot change tools, scope, gates or authority. Writing to the tracker (commenting, transitioning status) is not an evidence operation: it happens only through a controller-owned integration with its own capability grant. The pilot uses the issue tracker and code-host history for the pilot application (INT-13).

## Failure signatures

Every DiagnosisManifest carries a **FailureSignature**, computed by a versioned normalizer from:
- reproduction evidence (the intended baseline failure)
- error-tracking events
- CI failure output

A signature contains:
- failure kind: exception type, error code, assertion or contract violation
- normalized top frames: module and function, with line numbers, addresses, identifiers and timestamps removed
- the failing endpoint or contract reference
- the affected components, carried separately in componentIds
- the normalizer version

The same defect seen with different line numbers or request IDs yields the same signature. Different failure kinds yield different signatures. The generated FailureSignature is the canonical type used by IncidentMemory and KnowledgeProposal.failureSignature: {digest, keys: {failureKind, normalizedFrames, endpointOrContractRef?, normalizerVersion}}. When no endpoint/contract is known, omit endpointOrContractRef; never invent a placeholder or empty string. That omission is part of the versioned canonical digest input. componentIds is a separate non-empty array of affected component UUIDs on diagnosis writes/knowledge proposals, outside the digest keys; matches receive the same component scope separately. The trusted normalizer MUST verify the digest before persistence. knowledge_record stores signature_digest, signature_keys (failureKind, normalizedFrames, endpointOrContractRef, normalizerVersion) and component_ids. Exact matching uses the digest index; partial-key matching uses the signature_keys GIN index, with component-plus-symptom text as fallback.

## Prior-incident matching

At intake and during discovery, the factory looks for earlier incidents in this order:
1. exact signature keys
2. partial signature keys
3. component-plus-symptom text search

It returns ranked candidates. Each candidate links:
- the earlier DiagnosisManifest
- its root-cause category
- the fix PR and regression test
- the outcome

Matches are presented to discovery and to reviewers as **hypotheses labelled "prior match"**, alongside the competing hypotheses the bug path already requires. A match:
- never shortcuts reproduction, red/lock/green or verification (INV-05)
- never closes a task on its own
- shows only incidents the caller is authorized to see (INV-14)

If the symptom matches an incident whose fix and regression test already exist, discovery classifies the new bug as either a **regression of the earlier fix** or a **new cause with a similar symptom**. A regression also triggers a check of why the earlier regression test did not catch it: the test may have been removed or skipped, or the failing path may be untested.

## Regression memory and root-cause categories

**The regression test stays in the permanent suite.** A verified bug fix delivered as a patch or PR MUST include its regression test, from the locked package or an equivalent derived from it, in the repository's permanent test suite. An owner may record an exception, for example for an environment-only bug that cannot be tested in the repository. A later candidate that removes, skips or weakens an incident-linked test is a protected-path finding requiring an owner decision (chapters 09 and 21).

The implementer commits that test in candidate C before green is accepted; no controller injects a test after verification. The verifier runs C's in-tree copy and checks content-hash equality with the locked test or, for a declared equivalent, the same scenario and intended assertion going red on B and green on C (chapter 05). Under scoped-failure-evidence policy, the implementer writes the equivalent from that evidence and it MUST pass the same equivalence check, or an owner retention exception is required. Exceptions never waive the locked oracle or exact-candidate verification.

**Root-cause categories.** Each diagnosis records one primary root-cause category, and optional secondary ones, from a versioned, owner-maintained taxonomy. The initial seed:

| Category | Category | Category |
| --- | --- | --- |
| `retry_idempotency` | `concurrency_race` | `null_or_missing_data` |
| `contract_mismatch` | `config_drift` | `dependency_upgrade` |
| `resource_exhaustion` | `timeout_handling` | `authorization_scope` |
| `data_migration` | `time_and_timezone` | `input_validation` |
| `other` (with a reason) | | |

An agent may propose a category. It becomes recorded only when the reviewer confirms it during review. Agent-only categories remain proposals.

## Variant analysis

After a verified fix, a **variant-analysis** step looks for the same flaw elsewhere:

1. Generalize the defect into a searchable pattern: a structural code query, a code pattern, or a precise description for an agentic read-only search.
2. Search outward, within the caller's authorization: the same application, then the same system, then other onboarded applications.
3. Classify each hit as `confirmed`, `likely` or `false_positive`, with evidence.
4. Route confirmed variants:
   - few variants become linked bug tasks for their owners
   - many variants, or a fix that is mechanically repeatable, become a **recipe proposal** that can drive a campaign (chapter 23)

Variant analysis is read-only and budget-capped. It never fixes code itself, and findings for other applications go to those applications' owners. It runs by default after verified bug fixes in standard and enhanced assurance, and is configurable per application.

## Recurrence escalation

The factory counts confirmed root-cause categories per application, per system and across onboarded applications, over a rolling window. Default thresholds, configurable by policy owners:
- three occurrences of one category in an application within 90 days
- two applications in the same system within 90 days

Crossing a threshold raises a **systemic proposal** to the relevant owners, offering:
- an executable rule or check that makes the class fail at verify time (chapters 21 and 22)
- a recipe and campaign to fix every instance (chapter 23)
- a design-change investigation

Proposals require an owner decision. No rule, check or policy activates automatically (INV-25, INV-26). Cross-application recurrence is the evidence chapter 08 requires before a lesson's scope widens beyond one application.

## Measuring usefulness

For every prior match shown, record:
- whether it was confirmed as the same cause
- whether it shortened diagnosis compared with similar unmatched bugs
- whether it misled

Lessons and matches that repeatedly mislead are marked disputed or expire. These measures appear in application health (chapter 11).

The evaluation corpus (chapter 13) includes **look-alike incidents**: the same signature with a different root cause. This tests whether matching anchors diagnosis on the wrong cause.

Ruled-out hypotheses from the ledger become failed_hypothesis records linked to signatures; reopening needs new evidence. See [chapter 26](26-investigation-discipline.md).

## Retention and privacy

Incident evidence follows existing retention and redaction rules (chapter 02). Signatures and categories are retained as long as the knowledge records they support. Raw production payloads are not needed for matching and are not retained for it.

Factory tools 1.2.0 reaches these sources through the bounded, grant-checked GetEvidenceToolInputV12 query contract in chapter 22. W-094/W-110 implement the adapters; 1.0.0/1.1.0 artifact-only inputs remain frozen. investigation-discipline/1.0 requires 1.2.0 at admission.

## Traceability

- W-109–W-114 implement this chapter, and AC-173–AC-181 define its acceptance obligations.
- W-033 pilot qualification depends on W-109–W-112, including W-110 tracker/code-history evidence. W-107 depends on W-109/W-111/W-112; W-110 joins at W-033.
- `contracts/interfaces.ts` adds the FailureSignature, PriorIncidentMatch and IncidentMemory types.
- Schema additions for ContextManifest, FailureSignature and the category taxonomy are W-109 and W-111 contract deliverables.
- Signature columns and indexes are added to knowledge_record; no new SQL table or public REST route is added. Signatures, matches and recurrence counts remain artifacts and knowledge records.

## Sources

Inspiration only; reported figures are not adopted.

- [Spotify Honk part 4](https://engineering.atspotify.com/2026/4/background-coding-agents-dataset-migrations-honk-part-4): planned agent-led context gathering from tickets and documentation before changes.
- [Fleetshift MCP actions](https://backstage.spotify.com/docs/portal/core-features-and-plugins/fleetshift/mcp-actions): a planning step before coding execution.
- [Google agentic bug reproduction](https://arxiv.org/abs/2502.01821): reproduction tests as input to repair.
