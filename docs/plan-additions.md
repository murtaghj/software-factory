# Plan additions

Proposed work that is not in the rev 1.13 backlog (`docs/spec/14-build-backlog.md`, W-001 to W-144).
Agreed with the owner on 2026-11-12. The spec directory is not edited by the build, so these live
here until a spec revision assigns them work-package IDs, acceptance criteria and dependencies.

IDs use the prefix `P-` so they cannot collide with backlog IDs.

## Principle: structured coordination, not chat

Agents and people coordinate through typed, owned, recorded requests. Free-form agent-to-agent
chat is out of scope on purpose: it is unauditable, it is how channels become unreadable, and it
is a route for one agent to be talked into something it should not do. Every exchange has an
owner, an exact subject and a stored answer. Chat tools receive links and digests only.

## A. Agent and human coordination

| ID | Proposal | What it delivers | Builds on | Size |
| --- | --- | --- | --- | --- |
| P-01 | **Done (2026-11-12, `apps/mcp`).** Agent-facing interface (MCP server) | A developer's own agent (Claude Code, IDE) can submit a task, read status, runs, gates and evidence, and answer the factory's questions through the existing API. The server holds no authority of its own: it acts as the signed-in developer and every rule stays server-side. | Task, command, decision and event APIs (W-009, W-014, W-015) | Small |
| P-02 | **Done (2026-11-12): API filter, MCP inbox tool, dashboard model and component; it still needs the dashboard shell of P-08 to be reachable.** Decision inbox | One place listing only what waits on the signed-in person: plan approvals, questions, budget raises. A chat notification is a single link on assignment, nothing else. | `GET /v2/decisions`, dashboard components (W-014, W-015) | Small |
| P-03 | Cross-team typed requests | An agent or person working on application A files a typed request against application B: question, interface change or dependency. It is routed to B's owner or B's agent, answered once, stored and reusable. Replaces "quick question" threads. Needs a new record type, routing rules, authority checks and an expiry. | Decision requests (W-015), application ownership (W-008) | Medium, own package |
| P-04 | Shared knowledge read first | Answers, decisions and gotchas per application. An agent consults it before asking anyone; answered P-03 requests feed it. | The spec's knowledge records (schema exists, unused) | Medium |
| P-05 | Digests, not streams | A per-task or daily summary to a channel: what shipped, what is blocked, what needs a person. Detail stays in the factory. | Task events (W-014) | Small |
| P-06 | Linked tasks across teams | A task can depend on another team's task. The factory wakes the dependent task when the dependency lands, so nobody pings. | Parent/child tasks (planned, refused at intake today) | Medium |

Suggested order: P-01 and P-02 first (most relief, least work, API already exists), then P-03,
then P-04 to P-06.

## B. Clients

| ID | Proposal | What it delivers | Size |
| --- | --- | --- | --- |
| P-07 | **Done (2026-11-12, `apps/cli`; shared client in `packages/client`).** CLI | `factory submit`, `status`, `approve`, `cancel` over the existing API. Thin: no rule lives in the client. | Small |
| P-08 | Dashboard shell and sign-in | The app shell and OIDC sign-in around the already tested dashboard components (noted as not built in A-12). Hosts the P-02 inbox. | Medium |

## C. Attribution and budgets

| ID | Proposal | What it delivers | Size |
| --- | --- | --- | --- |
| P-09 | Per-developer (or per-team) budget accounts | A budget account per principal with a period limit. Each new task opens its account as a child, so reservations and charges roll up and a task is refused or stopped when the allowance runs out. Open choices: creator pays when ownership changes; one level first (developer or application), not both. | Small (the parent chain and ledger exist, W-013) |
| P-10 | Git attribution | When the Git integration arrives, the factory's bot opens the PR and names the requesting developer as co-author or in the description. | With the Git provider package |

## D. Scale

| ID | Proposal | What it delivers | Size |
| --- | --- | --- | --- |
| P-11 | Admission control | Per-organization and per-application limits on concurrent tasks, with queueing rather than failure, and the 429 quota response the spec describes. Uses the existing, unused capacity-reservation table. | Medium |
| P-12 | Fair reviewer assignment | Replace "first eligible reviewer" (A-13) with load-aware assignment and a visible review backlog. | Small |
| P-13 | Push-based event streams | Replace the 250 ms per-connection poll with database notifications. | Small |
| P-14 | Load test with the fake runner | Around 200 concurrent tasks, to replace guesses about limits with measurements. Cheap to do before real runners. | Small |

## E. Fixes carried over from the second review

These are defects or gaps in what is built, recorded in `docs/build-log.md`, to settle before real
runners are attached.

| ID | Item |
| --- | --- |
| P-15 | **Done (2026-11-12).** Project a control-revision change while a stage is in flight, so a second command does not wait for the stage to end. |
| P-16 | **Done (2026-11-12).** Settle a stage's budget reservation when its runner activity fails outright. Other activity failures (database writes exhausting retries) still fail the workflow. |
| P-17 | Wire the release-approval check (AC-44 release half) to a real caller when a release flow exists; until then it is tested but unused. |
| P-18 | Re-check authority when pause, resume, cancel and amend are applied, not only at ingress (A-13). |
| P-19 | Add dedicated tests for the five review fixes that have none: event-stream hang on disconnect, task-list paging precision, newest-first decision listing, expiry at decision application, human gate requires a cited decision. |
| P-20 | Split the two large worker files (workflow and activities) before M2 adds to them. |

## Decision recorded while building P-01

An agent acting through the MCP server cannot answer a decision. Plan approvals and other
decisions are human authority (INV-21, INV-29), so the server has an inbox tool that shows what is
waiting and where a person answers it, and no tool that responds. It also cannot amend a spec,
change a budget or reassign ownership; it can only submit, read, pause, resume and cancel.

## Not decided yet

- Deployment target: login provider, cluster for runners and Git provider (the spec leaves all
  three to the organization). No client is useful to developers until this is chosen.
- Whether P-01 to P-06 run before M2 (real runners) or alongside it.
- Sending SI-01 to SI-09 (`docs/spec-issues.md`) into a spec revision together with this file.
