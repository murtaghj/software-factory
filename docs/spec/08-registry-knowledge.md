# 08 — Application registry, diagnosis and learned facts

## Registry entities

Model systems, applications, deployable services, APIs/events, repositories, data stores, environment profiles, recipes, owners and releases. A user-facing application may map to several services; a monorepo may own several deployables. Stable IDs are independent of display names and repository paths.

An application definition includes ID/name/owner/lifecycle, repository+subpath mappings, provided/consumed interfaces, dependencies, telemetry selectors, setup/build/test/deploy profiles, risk minimums, secrets by reference and runbook paths. Interface records include protocol, contract source+digest, versioning/compatibility expectations, authentication mechanism and known consumers. They are versioned definition_version documents with entity_kind interface conforming to InterfaceDefinition; ApplicationDefinition provided/consumed IDs refer to interfaceId. resolveSnapshot MUST resolve those IDs and pin interfaceDefinitionRefs and their contract digests for diagnosis and verification; unresolved IDs block snapshot acceptance. The optional snapshot field preserves older snapshot payloads; new resolved snapshots MUST include every referenced interface.

Profiles are versioned Git documents. Setup/build recipes belong with the application or platform owner; platform profiles own shared cluster/environment capabilities. The registry resolves them into an immutable task snapshot rather than copying loosely maintained commands into prompts.

Registry descriptors carry a data classification for each repository, application and evidence source; classification drives provider eligibility and evidence redaction. See [chapter 25](25-data-security-operational-safeguards.md).

## Draft application lifecycle

A draft identity records intended purpose, ownership, interfaces, constraints and dependencies before Git exists. It has its own versioned API/artifact format and cannot be selected as an existing application. Bootstrap claims and immutable draft revisions live in Postgres; accepted intent/evidence live in object storage.

After independent foundation verification, ActivateApplication validates and imports a complete ApplicationDefinition from the exact accepted Git candidate commit, publishes repository/subpath mappings and profiles transactionally, then marks lifecycle experimental. The commit may be on the task branch; registration does not imply merge, deployment or production readiness. Registry readers must be able to retrieve that pinned commit through the authorized source/checkpoint store. Failed validation leaves the draft/onboarding state and exposes findings. The parent retains its new_application origin, while children use the registered target and a new immutable snapshot. Promotion to production follows release policy. No runbook may report intended dependencies or an unexecuted deployment as observed facts.

## Import protocol

1. Receive an allowlisted repository ID and exact commit/path, normally from a signed provider event or maintainer request.
2. Fetch through a read-only Git adapter; validate schema, ownership, referenced resources, recipe paths and supported capabilities. Reject unknown permission-grant fields.
3. Resolve stable IDs and detect destructive renames/deletions. Validate relationship targets; unresolved external entities are explicit stubs with limited applicability.
4. Store definition artifacts and a candidate import revision. Run dependency-cycle analysis: cycles may be legitimate runtime topology but deployment order must specify how they are handled.
5. Atomically publish the import pointer after validation. Readers use a coherent revision; in-flight tasks keep their pinned snapshot.
6. Mark replaced definitions superseded. A deletion removes the current declaration but preserves historical identity/evidence.

Import errors are visible on application pages and do not overwrite a last-known valid profile. Staleness is not concealed: display last successful import, current source revision, last profile rehearsal and observed runtime mismatch.

Definitions reach the import protocol through `RegistrySource` adapters that plug in at import time, with a field-level authority map and per-field provenance; tasks read only pinned snapshots. The default `GitDescriptorSource` reads Backstage-compatible descriptors with a factory extension section. Applications are onboarded incrementally through agent-assisted drafts confirmed by human owners, and confirmed ownership plus a per-change-class readiness assessment are eligibility requirements. See [chapter 23](23-readiness-recipes-campaigns.md).

## Declared versus observed graph

Declared: owner-maintained app→API→dependency relationships and intended release/configuration. Observed: traces, runtime inventory, image digests, endpoints and interactions during a stated time/environment. Observations carry confidence/source/expiry and never silently change declared ownership.

Default observation TTL: runtime deployment inventory 15 minutes, trace-derived relation 24 hours, performance/incident extract explicit interval. These are initial retrieval policies, not claims that an API changes on that cadence. Refresh on demand before high-impact decisions.

## Finding which API is responsible

Begin with affected user journey, environment, timestamp range, request/correlation IDs, symptoms and expected behavior. If the ticket supplies only “application broken”, discovery must gather this information or run a safe reproduction.

1. Load declared possible paths and actual deployed release mapping for the incident window.
2. Query traces/logs/metrics through an ObservabilityProvider with bounded time/result limits. Persist sanitized evidence extracts when upstream retention is insufficient.
3. Construct the observed causal sequence: incoming request, service calls, events, side effects and response. Record gaps rather than inventing missing spans.
4. Compare boundary inputs/outputs against the pinned contracts. A downstream 500 alone does not establish blame: check whether the upstream request was invalid, downstream implementation violated its contract, a consumer misinterpreted a valid response, or infrastructure/configuration caused the fault.
5. Maintain a hypothesis table with supporting evidence, contradictions, next discriminating experiment, possible affected repositories and confidence label. Labels are qualitative unless calibrated probabilities are actually available.
6. Reproduce a minimal boundary failure with approved fixtures/dependencies. Compare a known-good release or request where useful. Avoid replaying production writes without an isolated approved environment.
7. Produce DiagnosisManifest: symptom, causal claim, evidence refs, affected components, baseline releases, repro recipe, competing explanations, unresolved gaps and scope recommendation.

Root-cause acceptance requires a causal explanation supported by a discriminating reproduction or comparably strong evidence. If several components violate contracts, create linked changes and verify the composition. If telemetry is insufficient, route to investigation/instrumentation; do not select a repository merely because its name appears in the ticket.

## Knowledge model and retrieval

Kinds: declared_fact, observed_fact, design_decision, incident_lesson, failed_hypothesis, operational_recipe_reference and unresolved_question. Scopes: global, system, application, API, environment and task. Each record has statement, evidence/source refs, authoring task, applicability (versions/environment), verifiedAt, expiresAt where applicable, review status and supersededBy.

Statuses: proposed, reviewed, verified, disputed, superseded, expired. “Verified” requires a declared verification basis; a model's confident wording is insufficient. Contradictory records coexist with KnowledgeView.disputes links to the other authorized knowledge-record IDs until reviewed. Persist each directed link as knowledge_dispute(record_id, disputing_record_id), with tenant-qualified foreign keys and visibility checks on both records. Readers MUST reconstruct disputes from those rows in stable ID order, omitting links the caller cannot read; review preserves the links and records the resolution separately. Retrieval favors applicable verified declarations/observations, but returns relevant disputes and caveats. Do not hide a conflicting fact by simply ranking it lower.

Global lessons require evidence that generalization is justified and a designated maintainer review. Application incidents normally stay application-scoped. A task summary can be written automatically as historical evidence; promotion into a maintained runbook is a reviewed change with ownership.

Diagnoses carry normalized failure signatures stored as structured keys and reviewer-confirmed root-cause categories. Prior-incident matching uses signature keys before text. Confirmed recurrence across applications is the evidence required before a lesson widens beyond application scope. See [chapter 24](24-context-gathering-incident-learning.md).

## Automated runbook refresh

At task close, create a knowledge proposal containing the previous runbook revision, exact supported findings, applicable versions and suggested patch. Runbook sections: application purpose, dependency interactions, supported environments, setup/build/test/deploy/recovery procedures, known failure signatures, diagnostic queries and reviewed lessons.

Validate links and executable examples with the matching profile. Open a Git change through the provider adapter when configured. Reindex after merged source is observed. If auto-merge is explicitly allowlisted for narrow factual updates, it still requires PR approval under ReviewMode, provenance and validation (D5 applies only to opted-in application scope, never global knowledge/policy promotion); arbitrary learned prose cannot alter protected execution recipes/policy. Stale runbooks generate a review item when source/runtime changes invalidate their stated applicability.

## Profile resolution

Merge organization platform defaults, application profile and task-selected purpose under explicit precedence. Protected fields (credential scope, network policy, production target, allowed deployment provider) may only be narrowed by application/task overrides. Resolve aliases into immutable commits/image digests, dependency versions, fixtures, templates and non-secret config hashes. Reject unresolved latest/floating references in verification/release plans.

Snapshot all effective definitions and relationships into an ApplicationSnapshot artifact. Record resolved parameters separately from secret values. Credentials are resolved at execution time but secret identity/version metadata is captured where policy allows reproducibility. Rotation that changes relevant behavior can invalidate environment evidence.

Engineering standards have owned rule IDs and immutable revisions. The registry snapshot pins resolved rules and approved exceptions; Git owns source, artifacts own immutable bundles, Postgres owns decisions/projections. Third-party skills are admitted artifacts, not automatically installed knowledge. See [chapter 21](21-rules-role-content-skills.md) for the authoritative requirements and compatibility rules.

## Registry extraction boundary

Implement `getApplication`, `resolveSnapshot`, `getRelationships`, `searchKnowledge`, `importDefinitions` and `proposeKnowledge` behind a package interface from day one. API/worker can call the same module initially. Extract into a service only when independent consumers, scale or ownership require it; preserve contracts and avoid making orchestration depend on catalog-specific vendor fields.
