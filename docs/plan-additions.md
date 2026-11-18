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
| P-08 | **Done (2026-11-13), provider-neutral: the single pane. Runs locally with `pnpm dev`. A real login provider and hosting are still to choose.** Dashboard shell and sign-in | The app shell and OIDC sign-in around the already tested dashboard components (noted as not built in A-12). Hosts the P-02 inbox. | Medium |

## B2. Keeping developers on task

| ID | Proposal | What it delivers | Size |
| --- | --- | --- | --- |
| P-21 | **Done (2026-11-13) for the API, CLI, MCP tool and dashboard views; reachable in a browser once P-08 exists.** Project boards and "my work" | One board per project (a project is an application): tasks grouped by state, who each waiting task waits on, this month's spend. A cross-project "my work" view for developers on several projects, ordered by what to do first: decisions others are blocked on, then your own stopped tasks, then what is waiting on others and what is running. Both are read-only; state changes only through commands and decisions. | Medium |
| P-24 | **Done (2026-11-16) for the API, CLI, MCP tool and dashboard home; sources are the factory's own only. No Git provider source yet.** One ranked "what needs you next" queue | One list, ranked by the server and shown in the same order by the dashboard, `factory work` and `factory_my_work`. Tiers: someone is blocked on you; something of yours is about to run out (a review request within 24 hours of expiring, or an allowance within 10 percent of its limit); something of yours stopped; something of yours finished. Inside a tier: incident-priority first, then the soonest deadline, then the longest waiting. Running, queued, paused, cancelled and waiting-on-others work is never listed (it stays on boards and in "Your other work"). Each source is an adapter that reads inside the caller's tenant transaction in its own SAVEPOINT; one that fails is reported as not checked and never shown as "Nothing needs you". "Mark as seen" (one new table, A-21) is the only way out of the stopped and finished tiers before 14 days; it needs a person at a terminal or the dashboard, never an agent. Open owner questions are under "Not decided yet". | Medium |
| P-22 | Projects that span applications | A named group of applications and people with its own board, for work that crosses services. New record with its own membership rules; overlaps with parent tasks (P-06). | Medium |
| P-23 | Nudges | Tell a person when something has waited on them too long, or a decision is about to expire, through the digest (P-05), not a stream of messages. | Small |

## C. Attribution and budgets

| ID | Proposal | What it delivers | Size |
| --- | --- | --- | --- |
| P-09 | **Done (2026-11-13) for developers: creator pays, monthly, one level. Per-team and per-application levels are not built.** Per-developer (or per-team) budget accounts | A budget account per principal with a period limit. Each new task opens its account as a child, so reservations and charges roll up and a task is refused or stopped when the allowance runs out. Open choices: creator pays when ownership changes; one level first (developer or application), not both. | Small (the parent chain and ledger exist, W-013) |
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
| P-18 | **Done (2026-11-18).** Re-check authority when pause, resume, cancel and amend are applied, not only at ingress (A-13, A-24). |
| P-19 | **Done (2026-11-18).** Add dedicated tests for the five review fixes that have none: event-stream hang on disconnect, task-list paging precision, newest-first decision listing, expiry at decision application, human gate requires a cited decision. |
| P-20 | **Done (2026-11-18).** Split the two large worker files (workflow and activities) before M2 adds to them. |
| P-25 | Close the short gap before a stage is marked in flight: a command applied there has its revision projected only after the stage ends (found while testing P-18; the P-15 behaviour covers only stages already in flight). |

## Decision recorded while building P-01

An agent acting through the MCP server cannot answer a decision. Plan approvals and other
decisions are human authority (INV-21, INV-29), so the server has an inbox tool that shows what is
waiting and where a person answers it, and no tool that responds. It also cannot amend a spec,
change a budget or reassign ownership; it can only submit, read, pause, resume and cancel.

## Principle recorded 2026-11-13: single pane of glass

The dashboard is the one place a person works with the factory: my work, inbox and approvals,
project boards, task detail and actions, and budget. Nothing a person needs for factory state
should require another tool. The CLI and the MCP server are other doors to the same API, not
separate sources of truth. New features (cross-team requests, digests, admission queues) get a
place in this pane when they are built.

## Dashboard design pass, direction B (2026-11-16)

The owner chose direction B, "Control room" (docs/design/directions/direction.md), over the recommended A. Every dashboard screen was rebuilt to the specimen: a top bar instead of the sidebar (projects moved to the Projects page), the line and its lamps as the signature, full-width tables with 46px rows, one green-grey hue at three lightness steps with no shadows, Atkinson Hyperlegible Next self-hosted (no external requests; the font is the single `--font` token), and a phone layout where the line simplifies and tables stack. Plan sections read "Read" / "N of 12 read". Shared wording became plain sentences (`packages/client/src/wording.ts`, `queue.ts`); the CLI and MCP output follow. One read-only API addition (A-23): stage descriptors on queue items, board cards and my-work cards, `stations` on the queue and boards, and `label` and `gate` on plan nodes. Light and dark still follow the system setting; there is no toggle.

## Not decided yet

- Deployment target: login provider, cluster for runners and Git provider (the spec leaves all
  three to the organization). No client is useful to developers until this is chosen.
- Whether P-01 to P-06 run before M2 (real runners) or alongside it.
- Sending SI-01 to SI-09 (`docs/spec-issues.md`) into a spec revision together with this file.
- P-24 queue, open owner questions (the build used the default shown):
  - Q1. Which outside source comes first (likely Git pull requests), which Git provider, and how a person's Git account is proven to be theirs (OAuth link, or a claim from the login provider). Nothing built depends on the answer.
  - Q2. "Mark as seen" needs one new table (`queue_ack`, built). The alternative is time windows only: stopped items for 14 days, finished items for 3.
  - Q3. Incident-priority tasks sort first inside a tier (built). Say no and that one comparator line is removed.
  - Q4. Thresholds: 24 hours for "about to expire", 10 percent for "allowance nearly used up", 14 days before a stopped or finished item drops off by itself (built as proposed).
  - Q5. Paused and cancelled tasks are not in the queue, even when someone else paused or cancelled your task. "Paused too long" belongs with P-23.
  - Q6. The Inbox page and its count stay as they are; tier 1 duplicates the inbox list by design. Folding the inbox into the queue is a later choice.
  - Q7. The author's "about to run out" item has no remedy inside the factory (no remind or reassign; P-12 and P-23 are not built). Is a "remind the reviewer" action the next step?
  - Q8. Budget raises are not a request record, so an organization admin never sees "Sam is blocked on you" for an allowance. That needs a typed request (the P-03 shape).
  - Q9. Decisions with no required principal (role pools such as `authorize_release`) are in nobody's queue. None is created today; they need a rule before the release flow arrives.
  - Open item (A-22): a separate agent token that the API refuses on `POST /v2/me/queue/acks` and `POST /v2/decisions/{id}/responses`. Until then "only a person marks seen" and "only a person answers" are client conventions, since the CLI and the MCP server share `FACTORY_TOKEN`.
