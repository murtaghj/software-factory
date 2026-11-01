# 07 — Harness adapters, context and model portability

## Adapter boundary

The factory owns task state, role, workspace, tool capability grants, budgets, accepted artifacts and completion criteria. The harness owns its internal coding loop and native conversation. Do not rebuild file editing, repository search or conversational tooling that the harness already handles.

The internal HarnessAdapter is asynchronous: describeCapabilities, start, resume if supported, events(cursor), cancel and result. The runner wraps it with stable stageRunId reconciliation. Native resume/fork, detailed usage, structured output and checkpoint export are negotiated capabilities. Fresh execution, cancellation through process termination, scoped workspace use and an inspectable terminal result are mandatory for qualification.

| Normalized capability | Qualification requirement |
| --- | --- |
| fresh | Required; no prior conversation or undeclared native memory. |
| resume | Optional; requires adapter/version/workspace compatibility and restored native state. |
| fork | Optional; native conversational fork never implies a Git branch/worktree fork. |
| structuredOutput | Optional native support; factory validates final artifact against schema in all cases. |
| usage | Report exact/estimated/unavailable, source and measurement interval; never fabricate missing token counts. |
| tokenLimit | Optional exact control; wall time, concurrency, turn limits and tool budget remain enforced independently. |
| streaming | Optional provider stream; normalized progress can be synthesized from process state without invented text. |
| scopedTools | Required effective enforcement by sandbox/proxy if native settings alone are insufficient. |
| factoryTools | Required MCP or qualified CLI shim; rules-role-content/1.0 uses 1.1.0; investigation-discipline/1.0 requires 1.2.0. Pinned 1.0.0/1.1.0 manifests resolve only to FrozenToolsV1 definitions, copied transitively from revision 1.10 by tools/frozen_tool_contracts.py; their readers preserve the original stageRunId strings. Current logical-ID validation applies to tools 1.2.0. |
| toolHooks | Optional; guardrails/telemetry, never the isolation boundary. |
| cooperativeCheckpoint | Optional; independently proven whole-writer stop, otherwise terminate pod and snapshot retained source. |
| contextOccupancy | Exact/estimated/unavailable; never substitute cumulative usage. |
| subagents | Optional; inherited scopes and aggregate metering must pass qualification. |
| nativeStateExport | Optional and sensitive; portable handoff is always supported by factory artifacts. |

## Reference native mappings

Codex: use the official TypeScript SDK for fresh threads and continuation; resume a known thread only when its state is available. Use app-server when direct lifecycle/event/approval integration is required. Pin the selected interface and generated schemas; do not mix SDK and raw-protocol state ownership in one adapter. [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), [app-server](https://learn.chatgpt.com/docs/app-server)

OpenCode: run a server inside the isolated execution allocation and use its SDK for session creation, prompt submission, events and abort. Persist the server's required state only within the adapter's qualified resume protocol. Disable public sharing; the server endpoint is internal to its allocation. [OpenCode SDK](https://opencode.ai/docs/sdk/)

Claude: use Agent SDK query/session APIs, explicitly capture the session ID and use resume for continuation. Cross-host native continuation requires the supported stored-session mechanism and compatibility checks. Fresh execution from the factory handoff remains the fallback. [Claude sessions](https://code.claude.com/docs/en/agent-sdk/sessions)

These observations support adapter selection; the exact pinned release must pass conformance before enabling a capability. None of these native conversation formats is the factory's cross-vendor interchange format.

## Run input and result

Run input includes stageRunId, role, workspace binding, StageContext ref, adapter/model profile, prompt-template revision, limits, capability grants and fresh/resume policy. It must not contain a general administrator token or user-supplied unrestricted MCP server URL.

Adapter start returns an opaque native handle and events cursor. HarnessRunResult includes normalized termination reason, output artifact refs, checkpoint ref, native-state ref if allowed, usage observations and provider diagnostics. Its producerKind is adapter and its echoed allocationEpoch is not authority; it has no accepted status. The supervisor maps diagnostics to a StageResult status only through trusted finalisation. Separate provider error from a model-authored unsuccessful task. Exit code zero is only process completion; it is never the gate verdict.

The supervisor collects only provider-exposed responses/events and allowed native transcripts. The factory does not require hidden model reasoning. User-visible progress is concise factual activity: file inspected, command started, test failed, artifact created, waiting for input.

## Context assembly pipeline

1. Accept stage role, immutable plan/input binding and maximum context allowance.
2. Fetch exact task criteria, policy/capability summary, relevant application definitions and candidate/source metadata.
3. Retrieve facts by application/API/dependency relevance, version/environment applicability and source authority. Apply organization/resource access before ranking or caching.
4. Include the stage-specific evidence package: failing traces for diagnosis, canonical criteria for authoring, exact diff/results for review, source references for documentation/research.
5. Deduplicate by canonical artifact/source identity. Keep contradictory facts visible and label stale/observed/hypothesis records.
6. Allocate model-token budget, truncate low-priority logs with pointers to originals, and store the final StageContext artifact; each exclusions entry names the excluded source and its retrieval/exclusion reason.
7. Materialize permitted files and register the scoped factory tool server; get_evidence provides bounded read-only retrieval. Record all tool accesses and pin the tool-set version.

Token allocation is adapter-profile-dependent. Start experiments with roughly 20–25% of the qualified window for initial context and evaluate deliberate restarts around 60% active context occupancy. These are tunable hypotheses, not universal caps; cumulative billed token usage is not context occupancy. Mandatory criteria/policy/plan evidence must fit, with headroom reserved for tool output and final artifacts. This is a starting policy, not a guarantee about a provider's internal compaction. If the provider does not expose a reliable window/estimator, use a conservative validated profile and record estimates. Reject a context that cannot fit mandatory criteria/policy; summarize source evidence explicitly rather than silently dropping requirements.

Discovery is the agentic context-gathering stage and records a ContextManifest; this pipeline remains the deterministic selector of what each later role sees. Tracker, code-history and documentation sources are read-only untrusted evidence. See [chapter 24](24-context-gathering-incident-learning.md).

## Session transition rules

| Transition | Context policy |
| --- | --- |
| Same implementer responds to local failure | Resume if compatible; add concrete latest findings and updated source binding. |
| Discovery continues the same hypothesis/experiment | Resume within its budget and scope. |
| Scope/design accepted → implementation | Fresh role context with accepted plan and canonical evidence. |
| Author → reviewer/adversarial author | Fresh; no automatic author transcript, private scratch or mutable author memory. |
| Candidate → verifier | Programmatic execution; no model session required. |
| Vendor/model profile replacement | Prefer fresh portable checkpoint unless native compatibility is explicitly qualified. |
| Major goal change or confused/contradictory history | Fresh from accepted state and a reviewed handoff; preserve prior transcript only as evidence. |

Native configuration directories are per task/role. Repository instruction files are imported as untrusted task material with provenance and authority limits. Fresh reviewer workspaces exclude author-only notes and unexpected global memory; the reviewer may inspect factual rationale as a labeled supplemental artifact.

## Prompt package contracts

Each role template is a versioned file with: role objective, accepted input refs, allowed actions, expected output schema, evidence requirements, stopping rules and return categories. Role instructions cannot grant credentials absent from the capability proxy.

| Role | Required output |
| --- | --- |
| Discovery | Affected components, hypotheses/evidence, unresolved decisions and suggested work type. |
| Planner | Candidate approach, scope/diff intent, stage graph, criteria mapping, risks and return paths. |
| Criteria author | Test/report/benchmark package mapped to criteria; expected results and limits. |
| Implementer | Workspace source digest, change summary ref, local results (feedbackClaims), remaining work (deferredWork) and claimed limitations; candidate commits are created by trusted finalization from the snapshot. |
| Reviewer | Findings with location/behavior/evidence/severity and required disposition; coverage statement. |
| Adversarial tester | Relevant failure hypotheses, additional package and execution request; preserves canonical package. |
| Knowledge curator | Proposed facts/runbook changes with source evidence, applicability and confidence label. |

submit_result validates the role output in the same run; schema errors return bounded feedback and permit correction within existing turn/tool/time budgets. Native final output is diagnostic, not a privileged command or completed stage. An adapter that cannot use MCP must qualify a CLI shim with the same tool contract; prose parsing is not a fallback. Malformed output cannot advance a gate.

Required role guidance is compiled deterministically from canonical packages. Factory configuration excludes candidate-writable settings and hooks; repository conventions are imported as untrusted context. Resume additionally binds compiled role, rules and skill admission. The 1.5 profile negotiates factory tools 1.1; pinned older runs retain 1.0. See [chapter 21](21-rules-role-content-skills.md) for the authoritative requirements and compatibility rules.

## Tools and credentials

Tool grants name operation, resource scope, environment, lifetime, maximum calls and side-effect class. The proxy checks each call against task state, allocation epoch and current capability. Read-only telemetry and source tools differ from environment mutation. A request to deploy is translated into an EnvironmentWorkflow operation; it does not give the harness a general Kubernetes credential.

Network access is role/profile-specific. During dependency installation, permit approved package mirrors; during hermetic qualification it may be disabled after preparation. Prevent metadata service access and unsolicited outbound destinations through platform policy. Secrets are resolved as scoped runtime inputs and removed from prompts/logs/checkpoints; request-bound credential references are preferable to long-lived environment variables.

Factory tool profiles are keyed on (role, stageKind, workType/recipe). The discovery role at diagnose/investigate stages and authorized bug stages receive scoped evidence tools; implementers of fully specified recipes receive a minimal profile. `submit_result` accepts an untrusted `missingContext` list that feeds reviewed proposals only. See [chapter 23](23-readiness-recipes-campaigns.md).

Ledger tools (`open_hypothesis`, `record_evidence`, `close_hypothesis`, `extend_hypothesis`, `reopen_hypothesis`) are available to the discovery role, including diagnose/investigate stages, under investigation-discipline/1.0 and tools 1.2.0. The model gateway enforces provider eligibility for the run's data classification on every request. See [chapter 26](26-investigation-discipline.md) and [chapter 25](25-data-security-operational-safeguards.md).

## Adapter lifecycle and conformance

Publish each adapter image with version, native runtime version, protocol/schema revision, model-profile compatibility and a capability report. An upgrade runs fresh execution, cancellation, resume if claimed, structured failure, usage accounting, native state recovery and cross-vendor handoff tests. Route new tasks to qualified versions; retain old images for active runs or migrate through a recorded fresh checkpoint.

Portability acceptance: implement the first half of a feature using harness A, stop after durable checkpoint, restore in a clean pod with harness B and complete against unchanged criteria. Repeat after a failed test and for an investigation report. The output need not be byte-identical; the same contract/gates must pass and no dependency on A's private conversation may remain.

## Factory tool server v1

The supervisor exposes exactly the tools granted for the role; other MCP servers require separate explicit grants. FactoryToolServer, FactoryToolServerV11 and FactoryToolServerV12 are vendor-neutral. The current contracts/factory-tools.schema.json manifest pins 1.2.0; contracts/factory-tools.v1.1.schema.json and contracts/factory-tools.v1.0.schema.json preserve existing histories. Admission negotiates the exact profile and contract. The server binds authenticated allocation, stageRunId, epoch, role, stageKind, workType/recipe and inputHash itself; agent arguments cannot impersonate another run. Requests are size-bounded, canonically hashed, sequenced and durably recorded. Check epoch, grant, budget and current state at admission and finalisation. The semantic submission digest excludes transport callId and binds the entire semantic submission, including role output, feedbackClaims and deferredWork when present, plus the input subject; identical resubmission under another callId attaches to the same stage receipt. Duplicate identical call IDs return their receipt; conflicting payloads are rejected. Revoked allocations cannot act. Tool availability failure is infrastructure_error, not product failure.

| Tool | Allowed caller | Contract |
| --- | --- | --- |
| verify | Implementer, criteria author, adversarial tester | Select an authorized visible package/recipe by ID; no arbitrary command. Run in credential-free code container, serialize workspace mutation or capture an immutable feedback snapshot, and return bounded counts/failures/log refs with feedback_only. Never satisfy a gate or expose holdouts. |
| submit_result | Authoring roles, reviewer, knowledge curator | Validate role-discriminated output; persist a proposal receipt. Identical resubmission per stageRunId returns that receipt; a conflicting second proposal is rejected. Only the trusted finalisation protocol creates an accepted StageResult. submit_result is asynchronous with respect to finalisation; the MCP response never waits for a terminated pod to answer. |
| request_decision | Harness roles | Record question, options, why, source refs and blocking flag; dedupe by task/node/input/question digest. Blocking requests return state `pending_pause` and end needs_input after checkpoint; nonblocking questions return state `recorded_nonblocking` without pausing. Human answers arrive in the next context. |
| get_evidence | Granted role/stage/work-type/recipe profile | 1.0/1.1 read context-granted artifact refs. 1.2 also queries granted sources through approved templates with bounded time/path scope, result/byte caps and auditable access (chapter 22). Enforce classification and embargo before adapter access; returned content is untrusted and grants no authority. |
| open_hypothesis / record_evidence / close_hypothesis / extend_hypothesis / reopen_hypothesis | Discovery profile including diagnose/investigate stages, tools 1.2.0 | Persist advisory ledger receipts; server owns counters, scope and timeboxes. Reopen requires new evidence and further extensions require fresh-eyes/human authorization (chapter 26). |

submit_result sequence: validate and persist proposal → acknowledge receipt → close mutating tools → runner-confirmed whole-pod stop → retained-volume snapshot in trusted checkpoint allocation → finalize checkpoint/output artifacts → compare epoch/input hash → accept the one terminal StageResult. Chapter 06 defines this baseline without relying on a sidecar being able to kill another container. The proposal's workspaceSourceDigest (and any current_source feedbackClaims) is checked against the source digest of the finalized snapshot; a mismatch rejects the proposal rather than accepting a StageResult. Reply loss attaches to the existing receipt; crashes during finalisation resume the protocol, never infer completion. A background writer prevents finalisation until stopped. Pending tool receipts and checkpoints survive pod loss; a conflicting recovered source does not silently reuse a submitted result.

RunLimits bounds verify calls, cumulative verification wall time, turns, all tool calls, output bytes and stage wall time. Initial visible verify allowance is three calls/ten cumulative minutes within the stage cap, configurable by qualified setup profile. Control-plane leases account for concurrent calls; repeated receipt reads do not consume a new execution. Verify-cap exhaustion with incomplete plan tasks ends the stage at a resumable handoff boundary; only task-budget exhaustion makes the task incomplete, as described in [chapter 22](22-reference-practice-adoption.md). Canonical verification uses its own bounded independent allocation. Local shell checks cannot be mistaken for canonical evidence or escape the overall resource limits.

## Qualified harness configuration and continuity

Claude Agent SDK is the pilot mapping; Codex qualifies portability in M4 and OpenCode follows. Pin SDK/image versions and prove fresh start, tool registration, no interactive waits, process-tree cancellation, session paths, gateway routing and usage quality in M0. Native tool callbacks/pre-tool hooks block disallowed protected-path edits, push and credential/network access and emit telemetry where supported. Hook/settings files come from read-only factory configuration outside the workspace. Do not claim hook coverage as isolation.

Load no user/global settings. The factory owns a concise versioned role prompt/instruction/skill package rendered to the adapter's supported format; CLAUDE.md is only a Claude-specific rendering. Repository CLAUDE.md/AGENTS.md remains labelled contextual material and cannot relax authority. Lint template length/instruction count with a profile budget; required sequence and invariants live in the workflow, not a brittle magic instruction-count limit. Optional search/research subagents inherit grants, filesystem scope and aggregate budgets; disable them unless accounting/enforcement conformance passes.

After any restore, default to fresh context from the portable handoff. Native resume requires the exact recorded source digest plus compatible adapter/model, role, prompt/tool/policy/setup profiles, workspace binding and available session state; equal source alone is insufficient. Compaction restarts use a negotiated stop/handoff capability and proven quiescence. If live occupancy or safe interruption is unavailable, use qualified bounded stages and boundary handoffs instead of guessed mid-stage restarts. Store objective, accepted decisions, evidence refs, failed hypotheses and next actions in the portable handoff; test recovery without private transcript access.

Discovery may receive neutral questions with the ticket's proposed solution withheld, but MUST preserve symptoms, reproduction steps, constraints and relevant raw evidence. The planner receives the full ticket and discovery sources. Keep a qualified model per role; a different model family for judgement SHOULD be used where qualified, with family and any unavailable-diversity limitation recorded. A second reviewer model is not a second harness runtime and alone grants no review authority. Human-mode approval remains human; ai_only requires the full D5 qualified panel, including mandatory family diversity.

The portable handoff is a structured artifact. Task status is derived from tool receipts, the progress log is append-only, and each completed task gets a local commit; agent narrative stays labelled and untrusted. `get_evidence` provides read-only, scoped engineer-parity diagnostic sources and never mutates. See [chapter 22](22-reference-practice-adoption.md).
