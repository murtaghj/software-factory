# 09 — Independent verification, adversarial review and execution security

## Trust model

Treat tickets, repository files, candidate code, dependency scripts, tool responses and agent-generated reports as untrusted inputs. They may propose work but cannot authorize a capability, alter canonical policy or attest their own success. Trusted control-plane services select inputs, issue bounded capabilities, collect evidence and evaluate gates.

The verifier runs candidate code because testing requires it. A Kubernetes namespace or a fresh conversation does not make that execution hermetic or prove all tests honest. Isolation, fixed inputs, externally collected outcomes and independent review reduce specific risks; record what each verification method can establish.

## Verification pipeline

1. Validate the requested gate, active candidate and input binding. Resolve the canonical package and recipe only from accepted immutable references.
2. Materialize source in a separate allocation without access to author Git metadata, native state or publishing credentials. Mount canonical package read-only; use separate writable scratch where tools support it.
3. Resolve toolchain, dependencies, fixtures, environment/network mode and approved command arguments. Persist the resolved execution plan before launch.
4. Verify initial source/package hashes, enumerate expected tests/scenarios and launch the approved runner under CPU/memory/time/output limits.
5. Collect stdout/stderr, process status, discovery/execution counts, per-test results and environment observations through a trusted supervisor boundary. Do not accept a candidate-supplied JSON verdict file without validating its provenance and actual execution.
6. Verify canonical/source integrity after execution, accounting for explicitly declared generated files. Reconcile run identity and current candidate binding.
7. Finalize a VerificationReport and authenticated producer envelope; evaluate gate rules outside the candidate process. Emit passed, failed or inconclusive with exact reason codes.

The signing credential/result-finalization capability resides outside the untrusted candidate process. A container containing arbitrary candidate code must not also expose a general signing key or verifier administration API. Use an external supervisor/controller for attestation and narrowly scoped log/result transport.

## Test integrity and limitations

For each required suite, specify expected discovery rule, minimum count or enumerated scenario IDs, allowed skips and acceptable runner exit semantics. Zero discovered tests, unexpected skips, filtered tests, timeout, missing report, failed integrity check and setup error cannot pass. A trusted wrapper validates these before gate evaluation.

Read-only test files alone do not prevent candidate code from monkey-patching a language runtime, replacing a test framework dependency or fabricating output inside the same process. For higher-risk behavior, add external contract/integration tests against a separately running application, dependency/config review, mutation checks and direct observation of side effects. Do not claim cryptographic attestation proves application correctness; it proves who ran and recorded the declared procedure.

Candidate changes to CI, test configuration, lockfiles, build hooks, dependency sources or verification helpers trigger review of the verification boundary. Canonical verification configuration comes from an accepted package/profile version, with deliberate reviewed updates when the task needs to change it.

Removing, skipping or weakening a regression test linked to a past incident is a protected-path finding requiring an owner decision. See [chapter 24](24-context-gathering-incident-learning.md).

## Evidence by project journey

Greenfield independently verifies the foundation and then accepted user journeys on an integrated candidate. A scaffold/build/health endpoint alone cannot establish product completion. Nonexistent predecessor behavior can make baseline_valid not applicable with a recorded reason; dependencies still need compatibility evidence. Existing-project features prove new behavior plus preserved contracts/regressions; baseline red is optional when meaningful. Bug repair always requires intended red, a locked reviewed regression package and candidate green. These predicates remain distinct at every assurance level; [chapter 17](17-project-journeys.md) defines their required return paths.

## Bug red/lock/green enforcement

The baseline report and candidate report must name the same canonical test-package digest, intended failing assertion/scenario, relevant dependency/fixture configuration and declared comparison protocol. If environment instances differ, record equivalence inputs and reinitialize state. Infrastructure failure is a separate verdict and cannot satisfy baseline red.

After locking, author changes to a copied test file do not change the verifier's canonical package. A valid package revision requires independent oracle review and new baseline/candidate runs. Keep previous evidence and reason for revision. Include broader regression checks to detect a repair that narrowly satisfies the new test while breaking existing behavior.

## Engineering plan sign-off

Independent engineering review approves the complete design, acceptance/scenario matrix and DoD before implementation: human peers in human mode, or the qualified D5 panel in ai_only. Plan authors and service/model identities cannot provide human sign-off. In human mode agent critique is advisory evidence; the trusted evaluator checks required identities, assigned scope, blockers and exact-subject decisions. Planned scenarios remain planned until independent execution produces bound evidence. Do not reuse a peer-approved design as a test verdict or release authorization. [Chapter 19](19-peer-plan-review.md) defines the full packet and review protocol.

## Skeptical review

Reviewer input: accepted intent, criteria, candidate diff/artifacts, affected contracts and trusted evidence. Author rationale is labeled supplemental; full author conversation is excluded by default. Reviewer reports coverage, concrete findings and uncertainty.

A finding contains ID, category, severity, affected criterion/resource/location, reproduction/evidence ref and recommended correction; consequence and qualitative confidence (low, medium or high) MAY be included when supported. Categories route rework: implementation defect → execution; invalid approach → plan; wrong intended behavior → scope; invalid oracle → criteria review; environment fault → environment reconciliation; missing evidence → verification/investigation.

Persistence MUST round-trip Finding.consequence/confidence through the nullable finding.consequence/confidence columns. Readers omit null values for older findings; they MUST NOT invent a confidence label or consequence.

Allow rebuttal with evidence. A second independent reviewer or designated owner resolves contested blocking findings under policy; ai_only requires a separately qualified AI adjudicator configuration independent of author and panel before any AI finding is rejected; reviewers do not generate endless unbounded debate. Default one rebuttal cycle and one adjudication, then wait for owner decision or finish incomplete. Store reviewer/model/template versions for evaluation.

Architecture checks cite rule and check revisions. Check/rule disagreement is an owner-reviewed finding. New dependencies need reuse rationale and supply-chain review. unnecessary_code is a finding kind within implementation/design routing, with concrete suggested deletions; structured local feedback is still not gate evidence. See [chapter 21](21-rules-role-content-skills.md) for the authoritative requirements and compatibility rules.

## Adversarial testing

Select cases from the actual change: duplicate requests, retries, timeout after side effect, partial dependency failure, out-of-order events, concurrent updates, authorization boundary, malformed/large inputs, clock boundaries, rollback incompatibility and migration with mixed app versions. The test author proposes expected behavior from contracts, then an independent executor runs it.

Adversarial cases supplement canonical packages. They may reveal the original oracle is incomplete, triggering a reviewed package revision; they cannot silently replace existing failing checks. For docs/research, adversarial review checks alternative explanations, unsupported claims, counterexamples and misleading scope, rather than forcing irrelevant runtime tests.

## Flakiness policy

Default diagnostic repetition: rerun the exact failing procedure twice in fresh equivalent state, preserving every attempt. This is diagnosis, not “retry until green”. Classify nondeterministic product behavior versus test/environment flakiness. A required flaky gate remains inconclusive until the cause is fixed or an authorized policy change establishes a justified alternate evidence method. A known quarantined suite must have owner, expiry and replacement coverage; quarantine cannot be created by the implementer to unblock its own change.

## Authentication and role boundaries

OIDC identities map to organization roles and application scopes. Workload identities are per component, with short-lived credentials. Application RBAC is enforced before database queries and artifact access. Tenant-qualified foreign keys and RLS provide defense in depth; use runtime roles without table ownership/superuser/BYPASSRLS, and set tenant context transaction-locally. [PostgreSQL row security](https://www.postgresql.org/docs/18/ddl-rowsecurity.html)

Separate service identities for authoring runner, verifier, artifact finalizer, Git publisher and deployer. Authoring can read approved source/context and write its workspace/uploads. It cannot update gate rows, finalize trusted verification, modify policies, merge target branches or access production secrets.

## Kubernetes and network boundary

Execution namespaces MUST use Pod Security Admission enforce=restricted: nonroot, no privilege escalation, capabilities drop ALL, seccomp RuntimeDefault/Localhost and restricted volume types (no hostPath); host networking/PID/IPC are already blocked at Baseline. Restricted does not require read-only root filesystems, resource requests/limits or disabled automatic service-account tokens. The factory MUST enforce readOnlyRootFilesystem=true, CPU/memory/ephemeral-storage requests and limits, automountServiceAccountToken=false (explicit audience-scoped projected tokens only), and no container-runtime socket mounts through additional admission policy (ValidatingAdmissionPolicy, Kyverno or Gatekeeper) plus a LimitRange. A selected sandbox runtime or isolated node pool is required for hostile multi-tenant execution; containers alone are not declared sufficient. [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)

Default deny ingress/egress with explicit DNS, artifact, Git mirror, package mirror, model gateway, task-dependency routes and the factory control-plane runner API authenticated with the supervisor's allocation-scoped identity. Validate actual enforcement by the installed CNI. Standard NetworkPolicy is not an arbitrary domain allowlist; use an egress proxy or compatible FQDN policy implementation when domain control is required. Deny cloud metadata, the Kubernetes API server, workflow-engine frontends, databases and admin endpoints; the runner API is the only control-plane surface an authoring pod may reach. That route is pod-wide, so the harness can reach it too; authorization MUST rely on the supervisor-only credential and epoch/input/scope validation, not network reachability (chapter 06).

## Branch-preview security

Branch-preview namespaces MUST meet the same Restricted Pod Security and additional admission controls above, with default-deny networking, explicit reviewer ingress/required egress, ResourceQuota and LimitRange. A trusted preview admission boundary MUST refuse fork PRs even when labelled, fix the AppProject/destination/allowed resource kinds, and prevent candidate charts from altering isolation, ownership labels or external-secret scope. Namespace separation alone does not qualify hostile workloads. CI build and PR-generator GitHub credentials MUST be separate, least-privilege, recorded by secret reference/grants/owner and unavailable to preview workloads. External secrets supply only preview-scoped credentials; production credentials are forbidden.

Preview URLs MUST require authenticated reviewers authorized for the application/security group. Embargoed D4 tasks MUST NOT deploy to shared-cluster previews unless an isolated confidential target passes qualification under INT-15/INT-17. INV-28 classification applies to fixtures, seed data, database contents and resulting evidence. See chapters 10 and 25; label opt-in never grants confidentiality or data-policy exceptions.

## Future hermetic profile

The EnvironmentProfile contract already declares networkMode, dependency digests, seed/time controls, fixture snapshot, architecture and toolchain. A future `hermetic` capability additionally requires all dependencies materialized, external network blocked, deterministic time/random inputs where applicable, isolated state and a reproducibility report. The provider may advertise it only after a qualification suite; ordinary preview environments remain explicitly nonhermetic.

## Supply chain and artifact handling

Pin runner/verifier images and record provenance; scan dependencies/images in CI; review newly introduced package sources and lifecycle scripts. Build release artifacts in a controlled build job from the verified candidate and record image digest/SBOM/provenance. Serve uploaded HTML/SVG reports from an isolated download origin or force attachment with restrictive headers; never render arbitrary artifact scripts inside the authenticated dashboard origin.

Logs and transcripts can contain secrets or personal data. Redact known secret values at source, minimize captured production payloads, restrict raw evidence by role and retain sanitized extracts where possible. Content scanners supplement scoped access and do not guarantee complete detection. Security incidents revoke capabilities, stop affected allocations, preserve restricted evidence and requalify compromised adapters/images.

Candidate diffs are secret-scanned before checkpoint publication, push and delivery; a hit blocks publication. New dependencies and, where legal owners require, generated code are checked against the licence policy. Embargoed security tasks restrict branches, logs, matches and variant findings to their authorized group. See [chapter 25](25-data-security-operational-safeguards.md).

## Evidence classes and oracle strength

VerificationReport and each suite declare evidenceClass, collection provenance and the exact candidate/package/environment binding. in_process establishes observed execution and integrity-checked results inside the candidate runtime; it does not establish that arbitrary candidate code could not influence assertions, exit status or reports. out_of_process means an independent controller observes behavior of a separately running app with no candidate access to verifier secrets or private checks. human_observed records the named observer, method, source and limits; it is not automatically stronger than a reproducible automated check. Trusted collection means authenticated provenance, not a guarantee of product correctness.

Holdout checks are authored/reviewed independently and map to visible accepted criteria. Hidden cases cannot introduce secret requirements. Holdout content never enters an authoring/feedback pod. When executed, private checks and evaluator credentials must remain outside the candidate process/filesystem; putting hidden tests beside hostile code in one verifier container is insufficient. Return criterion-level failure summaries with bounded feedback to limit repeated holdout probing; retain full evidence for authorized reviewers. Require private independently operated cases for enhanced executable outcomes and the evaluation corpus; standard profiles select them where useful. Missing required capability yields inconclusive, never silent fallback to weaker evidence.

Before oracle acceptance, standard/enhanced executable-code profiles run targeted mutation strength where meaningful: declare mutation operators/locations and expected detections, reject compile-invalid mutants, identify equivalent/surviving mutants, and require human adjudication of gaps in human mode, or the independent qualified D5 AI adjudicator in ai_only with human escalation after the bounded dispute path. A nonapplicable oracle (for example a document claim) records a reviewed alternative. Mutation strength is evidence about selected faults, not proof of completeness or independence from an author-selected mutation set. Different qualified model families are preferred for author/judgement roles in human mode and mandatory under the D5 panel rules; process separation and independent evidence remain required.

Every candidate runs deterministic protected-path/config tamper detection and an explicit scope assessment. Test/config/CI/lockfile/build-hook/helper changes require review against signed scope; an authorized dependency change is not automatically malicious. Path/size bounds are deterministic; suspicious constants and semantic scope need qualified heuristic/model/human judgement. Label those separately. Compare structure outline, interfaces, criteria and actual diff; a semantic judge cannot override a hard path boundary or authorize wider scope. Failures route to implementation or a new peer-approved plan.

Failure-signature parsers classify named assertions versus compile/setup/discovery/network/timeouts and preserve raw logs with parser/profile versions. Reviewed test shims must run identically on baseline and candidate without implementing the fix. Add impossible-task canaries: when requirements and tests conflict, the correct outcome is an evidenced conflict/incomplete response, never tampering to manufacture green.

## Prompt injection and privileged execution

Apply plan-then-execute, context minimisation and isolated review as concrete boundaries; names are not security proofs. Authoring/research nodes handling free-form ticket, repository or tool content have no publish/deploy/provider-secret authority. Privileged controllers accept only validated immutable manifests and explicit capabilities/decision subjects selected by trusted policy. They may transport an untrusted PR-description artifact as inert text, but never interpret it as commands or authorization. Labelled untrusted output is a prompting aid, not enforcement. Qualification must include malicious repository instructions, tool output, review comments and source paths that attempt to cross this boundary.
