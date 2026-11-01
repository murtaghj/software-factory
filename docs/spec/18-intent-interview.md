# 18 — Greenfield intent interview and human alignment

## Required behavior

Every new greenfield initiative begins with an adaptive interview whose goal is a shared, testable account of what the human wants. A ticket, generated requirements document or model confidence score cannot substitute for this conversation. Be persistent about ambiguity, contradictions and consequences; keep the interaction respectful, concise and easy to resume.

The intent_aligned gate is mandatory before foundation design, repository creation, scaffolding or implementation. Fast assurance and one-invocation modes do not waive it. Draft identity creation, read-only discovery and non-executable sketches may occur before alignment. Any experiment requiring execution or external writes needs its own explicitly authorized investigation scope; it cannot quietly become product implementation.

The objective is thorough alignment on the accepted scope. The system cannot prove complete knowledge of future needs. Unknowns must be visible and classified: unresolved questions that could materially change the product block progression; explicitly accepted, low-impact, reversible assumptions may remain with an owner and validation plan. Silence, exhaustion, an elapsed deadline and an agent saying that the user agrees are never approval.

## Interview loop

1. Read the initial request and permitted existing material. Extract candidate requirements with sources; label inference and unresolved points. Initial TaskRequest criteria are provisional for discovery and do not pass scope_accepted.
2. Establish the accountable human intent owner and relevant stakeholders. Ask about the problem, current workaround, intended users and observable outcome before asking the human to choose a technical stack.
3. Choose the most consequential unresolved topic. Ask one to three focused questions, usually one. Explain briefly what each answer changes. Offer concrete alternatives when useful, permit a free answer and preserve “I do not know yet” without inventing certainty.
4. Reflect the answer back as concrete behavior or a decision. Connect it to a user journey, scope boundary, constraint or acceptance example. Preserve the original human answer and the agent's interpretation separately. Never silently convert a suggestion into a confirmed requirement.
5. Probe the consequences. Explore failure behavior, abuse/misuse, conflicting goals, boundary cases and the cheapest slice that would deliver value. Ask which trade-off the human prefers; do not push them toward a preselected product idea.
6. Update the immutable brief and issue register. Show what changed and the next unresolved question. Reuse already confirmed information unless new evidence conflicts with it. Material contradictions return to the human who owns the decision.
7. Run a fresh skeptical intent review against the brief, answer evidence and source constraints. The reviewer searches for vague success criteria, omitted actors, incompatible promises and unacknowledged assumptions. This produces findings, not human approval. New questions return to the interview.
8. Present a compact read-back of the exact proposed scope, scenarios, non-goals, trade-offs, constraints and remaining accepted assumptions. Invite corrections; in human mode ask an authorized human to confirm this version, or in ai_only obtain D5 panel confirmation against the requester’s submitted answers. Only then may intent_aligned pass and foundation design start.

No fixed question count, round count or numerical alignment score establishes completion. Stop asking about resolved low-impact choices; probe further where answers change product behavior, scope, authority or acceptance. Existing supplied requirements can shorten the interview, but they still require contradiction review and an explicit version-bound confirmation under ReviewMode.

## Coverage and useful probes

| Topic | Required understanding | Example probe |
| --- | --- | --- |
| Problem and outcome | Why the product should exist, present workaround and valuable change. | What becomes possible that the user cannot do today? |
| Users and ownership | Primary/secondary actors, decision owner, conflicting stakeholder needs. | Who benefits, who operates it and who decides when their needs conflict? |
| Journeys and failures | Trigger, steps, visible result, failure/recovery behavior and concrete examples. | Walk through one real case; what should happen when the dependency is unavailable? |
| Scope and non-goals | First useful slice, later scope, explicit exclusions and priorities. | If we delivered only one journey, which would make this worthwhile? |
| Data and permissions | Data sources, ownership, access, retention and unacceptable exposure/loss. | Who may see or change this record, and who must never be able to? |
| Dependencies | Required existing systems, contracts, platform constraints and uncertain integration facts. | Which system owns this fact, and what happens when the two disagree? |
| Experience and accessibility | Interaction expectations, useful references, accessibility and interaction cost. | Show an experience you like; which behavior matters rather than just its appearance? |
| Operational constraints | Expected load, latency, reliability, support and recovery needs in meaningful units. | What delay or outage would make the product unusable? |
| Delivery and budget | Intended artifact/environment, deadlines, cost/effort limits and deployment authority. | Is success a reviewed PR, a usable preview or a production service? |
| Success measures | Observable acceptance examples and later product measures kept distinct. | What demo would convince you this meets your intent, and what would make you reject it? |

Every topic records answered, accepted_assumption or not_applicable with evidence and a reason. Unknown stays unknown. “Fast”, “simple”, “secure” and “production-ready” require concrete meaning where they affect acceptance. Avoid asking the human technical questions the system can answer through authorized discovery; surface an unknown integration fact as research work rather than coercing a guess.

Example: “Users can return an order” is incomplete. Clarify who may return which items, time windows, partial returns, duplicate submissions, approval, refund ownership and visible status. If refund execution is excluded from the first slice, capture that explicitly. Walk through an eligible return, an expired item, another customer's order and a repeated request. The approved examples become inputs to later acceptance-package authoring; they are not a claim that tests already exist or pass.

## Artifacts and evidence

IntentBrief is immutable and versioned. It holds the problem, users, desired outcomes, concrete journeys, criteria with stable IDs, the first-slice journey IDs, non-goals, constraints, trade-offs, assumption/issue registers, topic coverage, human answer refs, authorized intent-owner IDs and proposedTaskSpecRef. Draft briefs may have empty unanswered sections; an aligned brief must satisfy the completion predicates below. The proposed TaskSpec has the normalized scope and criteria; contradictory seed criteria must not remain silently authoritative.

IntentQuestion records its ID, topic, question, why the answer matters, blocking status and source refs. Answers persist as immutable artifacts carrying authenticated actor identity and command ID; the actor is taken from trusted ingress, not a field supplied by a model. Keep human text, interpretation and review findings distinct. An answer does not itself approve the full brief. New questions receive new IDs and refer to prior questions when reopening an issue.

IntentInterviewView exposes the current revision, phase, stateRef, briefRef, up to three pending questions, blocker count and current decision IDs when they exist. The durable state artifact retains answer refs and links priorStateRef to immutable earlier questions, briefs, findings and superseded subjects. Retain the reachable chain for the task lifetime and compact it into a separately versioned history manifest when needed; no prior issue or answer may disappear during compaction. Postgres stores the current projection; object storage stores the immutable artifacts; Temporal owns progression and durable waiting. Conversation/session memory is optional continuity, never the authoritative requirements store.

IntentConfirmationSubject binds task ID, interview revision, base TaskSpec version, exact briefRef and independent reviewRef. The proposed TaskSpec is reached through briefRef. In human mode, the existing decision mechanism records authenticated human responses against this subject hash. Create a distinct DecisionRequest for each required human owner; requiredPrincipalId binds that request in addition to role checks, and each accepts only that owner, has its own immutable decision and refers to the same subject. IntentInterviewView.alignmentDecisionIds and state.pendingDecisionIds expose pending requests. The trusted coordinator assembles IntentApprovalSet from the complete required-owner set and decisions; InputBinding.intentDecisionRef points to that immutable set. The evaluator resolves and checks each real decision, owner and subject, rather than trusting the set's claims. Adding/removing a required owner is an authorized scope/policy change, not an interviewer choice. Caller authorization must permit both ownership of intent and any proposed scope/limit changes; confirming product intent does not create repository/deployment grants.

Under ai-review/1.0, IntentConfirmationSubject and the same coverage/conflict predicates remain. The independent panel confirms fidelity to the requester’s authenticated submitted answers, never inventing an answer or settling a material stakeholder conflict. AIReviewSubject.contentRef names the unchanged IntentConfirmationSubject and binds the panel assignment/policy/InputBinding. Its AIReviewApprovalSet is bound through aiIntentApprovalSetRef, separately from IntentApprovalSet/intentDecisionRef and state.acceptedDecisionRef. The latter fields remain exclusively human. No human confirmation request is fabricated. Changed answers invalidate the AI set and all dependent evidence; unresolved material ambiguity blocks and asks the human requester. Normalized spec installation uses the same serialized expected-version check. This replaces the review gate only, not human input or scope/authority decisions.

## intent_aligned pass predicate

For genuinely new repositories, the chapter 05 pre_repository decision binds the draft application and organization repository-intent policy before this AI review. It does not require a fabricated repository or authorize merge; the bootstrap controller supplies the concrete binding only after creation.

- Required coverage is complete with evidence, not a percentage or a count of answered questions.
- The problem, users, outcomes and first slice are explicit. Every in-scope journey has observable success and failure examples and maps to accepted criteria. Criteria, journeys and scope references resolve without contradictions.
- No unresolved blocking issue or stakeholder contradiction remains. A deferred blocking answer stays blocking. High-impact uncertainty cannot be accepted through the reversible-assumption exception. Low-impact accepted assumptions have a named owner, validation plan and authenticated human acceptance evidence.
- A fresh independent review covers the exact brief and proposed TaskSpec; blocking findings are resolved. Documents or external stakeholder comments are evidence, not authority to settle a conflict.
- In human mode the required human intent owner and additional configured owners explicitly approve this exact subject; ai_only requires the chapter 05 unanimous AI panel against the requester’s own submitted answers. A generic “go ahead”, stale approval or fabricated human assent cannot satisfy either path.
- The normalized TaskSpec is installed through the authorized, serialized command path using its expected base version. Gate evaluation binds the resulting current spec, accepted brief and decision. No intermediate state can schedule implementation using unconfirmed scope.

The gate evaluator validates these conditions; the interview model cannot declare the gate passed. Question generation may propose risk/blocking classifications, but trusted policy and review enforce mandatory topics and high-impact categories. An agent cannot erase an unresolved issue by changing its blocking flag or removing it from a later snapshot: each prior open issue needs an auditable resolution or explicit scoped exclusion approved by the owner.

## Temporal, APIs and resumption

Greenfield templates 2.0.0 and later start product_brief → intent_interview → intent_challenge → intent_confirmation → foundation_design. The brief stage collects a seed; scope_accepted moves to confirmation alongside intent_aligned. The interview and challenge nodes may return to one another in bounded semantic attempts; waiting for human input is a durable condition, not an Activity polling the human.

Question-generation and review calls are bounded Activities. On presenting questions, persist their artifacts and the current interview revision, release execution resources and enter waiting_input. Keep transcript content out of Temporal history. WorkflowCheckpoint.intentStateRef retains the continuation state across Continue-As-New; another harness can continue from those artifacts without a native session. A pending final confirmation uses waiting_decision and the existing decision deadline behavior.

GET /tasks/{taskId}/intent returns IntentInterviewView. POST /tasks/{taskId}/intent/answers accepts IntentAnswerRequest with commandId, expected task-control revision, interview revision and one to three answers. The caller must be a permitted human task contributor or explicitly delegated stakeholder; final confirmation follows ReviewMode; human-mode confirmation requires the named intent owners. It requires Idempotency-Key and If-Match, persists a command/outbox entry and returns CommandReceipt. The workflow checks revisions, question IDs, authority and duplicate commands again before applying answers. The equivalent answer_intent CommandEnvelope uses the same handler. Stale answers are rejected with a visible reload/reconciliation path; preserve the user's unsent text. Never silently overwrite another stakeholder's answer.

Human confirmation uses POST /decisions/{decisionId}/responses with the exact IntentConfirmationSubject hash. Prepare the proposed TaskSpec before requesting confirmation. Each owner response is recorded independently. Only when the complete required-owner set has approved the same current subject does the serialized workflow handler apply the normalized spec idempotently: compare the base version, persist the approval set and bind the new plan. Partial approval cannot unlock work. Changed answers or requirements supersede the outstanding confirmation before resubmission. A lost HTTP reply is reconciled using command identity rather than asking the human to confirm the same unchanged subject twice.

The existing seven-day task calendar default includes interview waiting; interview activity/model usage is charged, while human wait does not consume active execution time or hold a runner. No fixed interview-round limit means automatic approval. At a task deadline or exhausted discovery allowance, save progress and report incomplete/waiting with the required authorized extension or linked continuation. Pause/cancel preserve artifacts; cancellation releases a pre-bootstrap application claim only through normal reconciliation.

## Maintaining alignment during the build

Every downstream plan, child package and acceptance package traces to accepted intent criteria. For greenfield templates 2.0.0 and later, stages after confirmation require InputBinding.intentBriefRef and the applicable approval ref (intentDecisionRef in human mode; aiIntentApprovalSetRef under ai-review/1.0); interview/challenge stages bind the current draft brief/state and do not require a preexisting approval. WorkflowCheckpoint retains the interview state. The plan compiler and runner/controller admission reject required work without a current accepted intent binding.

A material change to users, behavior, scope, constraints, trade-offs, first slice or permitted assumptions reopens only the affected topics, supersedes confirmation and invalidates dependent design/code/evidence. Reconfirm the revised subject under ReviewMode before affected implementation continues; unresolved material changes/questions still go to the human requester. Preserve unaffected source and evidence with their provenance. New implementation details within unchanged intent do not require another product approval; a new gate evaluation may reuse the unchanged accepted decision when the policy and exact intent subject still permit it.

A first-slice demonstration revisits the same scenarios with the human where product acceptance policy requires it. Passing tests against an approved misunderstanding does not establish satisfaction of revised intent; new feedback is a scope/criteria revision, not permission to silently change canonical tests until they pass.

## Dashboard behavior and build ownership

Keep the default interview view small: current question, why it matters, suggested answers when useful, free response and one primary action. A compact side summary shows agreed intent, open blockers and the first slice. Expand the full brief, answer history and evidence on demand. Use a topic checklist rather than a misleading “93% aligned” score. Allow save/leave/resume, keyboard use, corrections and delegation to an authorized stakeholder.

Before confirmation, show a concise read-back with linked journey examples, explicit exclusions, consequential trade-offs and accepted assumptions. Give Edit and Confirm this version actions. Show unresolved blockers prominently and disable confirmation while mandatory conditions fail. Do not preselect or auto-submit approval. Busy-user ergonomics reduce presentation burden without reducing the depth of inquiry.

W-069 implements interview state, contracts and progression; W-070 implements the question/read-back UI; W-071 qualifies human authority, contradiction handling, revision races, history recovery and non-bypass behavior. AC-75–AC-84 define their acceptance obligations. These are required for new greenfield work in full v1. Existing-target workflows may reuse the interview components when ambiguity warrants them; they retain their own routing and evidence rules.

## Compatibility

Specification revision 1.2 adds this mandatory phase. Domain envelopes remain 2.0; API description advances to 2.1.0 on /v2 for the interview routes, fields and discovery-stage relaxation of RepositoryIntent. Greenfield template advances from 1.0.0 to 2.0.0 because its prerequisites change. Existing templates/history remain pinned; upgrades require an explicit plan migration or linked continuation. Revision 1.3 adds subsequent engineering peer sign-off; that revision used template 3.0.0; revision 1.4 used 4.0.0 with the same human gates as defined in [chapter 19](19-peer-plan-review.md). Deploy updated validators/workers before enabling it; old workers that do not understand these stage kinds must reject them.
