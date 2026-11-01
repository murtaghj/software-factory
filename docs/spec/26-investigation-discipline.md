# 26 — Investigation discipline: stopping rabbit holes

Revision 1.9 enforces disciplined investigation during diagnosis, discovery and investigation work. Agents tend to pursue the first plausible explanation and keep spending on it. The spec already requires competing hypotheses, discriminating experiments and overall budgets (chapters 05 and 08). This chapter makes those rules **enforceable while the investigation runs**, rather than only bounding it after the budget is spent.

The approach:
1. The agent declares what it is testing and how it will know it is wrong.
2. The supervisor holds it to per-hypothesis budgets and watches for stalls.
3. Fresh reviewers and humans step in at defined points.

**Compatibility.** investigation-discipline/1.0 adds evidence and content obligations at behavior-release admission with pinned policy/evaluator versions; workflow template versions do not change, and existing_feature/bug_fix 3.0.0 histories pinned before enablement are not retroactively blocked. The ledger, checkpoints and probes remain advisory and never satisfy gates.

## At a glance

| Mechanism | Required behavior | Packages |
| --- | --- | --- |
| Hypothesis ledger tools | Hypotheses are opened, tested and closed through factory tools, with a prediction, a kill criterion and a timebox. | W-122 |
| Enforced timeboxes | An exhausted timebox stops the run until the hypothesis is closed, extended (capped) or switched. | W-122 |
| Stall detection | Repetition or no new evidence triggers reflection, then a handoff. | W-123 |
| Fresh-eyes checkpoint | A fresh reviewer judges the ledger and evidence without the investigator's transcript. | W-123 |
| Parallel probes and early escalation | Cheap bounded probes for the top hypotheses run before deep work; unresolved hypotheses escalate to a human question early. | W-124 |
| Dead-end memory | Ruled-out hypotheses are linked to failure signatures; reopening one needs new evidence. | W-124 |
| Rabbit-hole evaluation | Decoy bugs and process metrics are evaluated per behavior release. | W-125 |

## Hypothesis ledger tools

The discovery role, including stages of kind diagnose and investigate, receives ledger tools through the (role, stageKind, workType/recipe) profile from the factory tool server (chapter 07):
- **`open_hypothesis`:** the statement, its **prediction** (what result would support it), its **kill criterion** (what result would rule it out), the planned discriminating experiment and a **timebox** (tool calls and minutes). A hypothesis without a prediction, kill criterion or timebox is rejected by the tool.
- **`record_evidence`:** attaches evidence references to one or more hypotheses as supporting, contradicting or neutral. Confidence labels change only through recorded evidence (INV-13).
- **`close_hypothesis`:** `confirmed`, `ruled_out` or `inconclusive`, with the deciding evidence; confirmed/ruled_out require non-empty evidence.
- **`extend_hypothesis`:** hypothesis ID, reason, expected new evidence and a capped extension. The server initializes extensionsUsed to zero and increments it; after the first extension it requires a valid fresh-eyes checkpoint or human authorizationRef. Stage limits still apply.
- **`reopen_hypothesis`:** failedHypothesisRef, non-empty newEvidenceRefs, a new prediction, kill criterion, experiment and timebox. Evidence MUST be new to the prior ruling. Append a linked hypothesis and retain the original; open_hypothesis rejects a matching failed hypothesis without this path.

From W-033 pilot qualification onward, the ledger MUST be the authoritative investigation state. The diagnosis hypothesis table (chapter 08) and the DiagnosisManifest are produced from it, not from agent prose. W-107 alone MAY derive its DiagnosisManifest from the chapter 08 hypothesis table before ledger tools exist; all diagnosis evidence and human gates still apply. Ledger contents are agent-authored and remain labelled as such; they guide investigation and never satisfy a gate (INV-23).

## Enforced timeboxes

The supervisor tracks each open hypothesis against its timebox. When a timebox is exhausted without a `confirmed` or `ruled_out` close, the run pauses at the next tool boundary. The agent must then do one of:
- close the hypothesis as `inconclusive`
- **extend** it once, with a stated reason and new expected evidence, within a capped extension
- switch to another hypothesis

Further extensions require a fresh-eyes checkpoint or a human decision. Timebox defaults are role and profile configuration within stage limits.

## Stall detection

The supervisor watches for stall signals:
- repeated near-identical commands, searches or file reads
- a configured number of tool calls with no evidence recorded against any hypothesis
- the same failing check or error repeated without a change in approach
- a confidence increase without new evidence

The first stall signal returns a structured reflection prompt: current hypotheses, evidence so far, and what would discriminate between them. A repeated stall ends the run with a portable handoff (chapter 22) and routes to a fresh-eyes checkpoint. Stall detection is deterministic supervisor logic, not a model judgement.

## Fresh-eyes checkpoints

At each timebox boundary that requests an extension, at repeated stalls, and before a diagnosis is submitted, a **fresh reviewer session** receives only:
- the ledger
- the evidence references
- the task criteria

It does not receive the investigator's transcript. It answers:
- whether the evidence supports continuing the current line
- which hypothesis is neglected
- which experiment would best discriminate

Its result is advisory input recorded in the ledger. It cannot close hypotheses or satisfy gates. Where qualified, the fresh reviewer uses a different model family from the investigator (chapter 20).

## Parallel probes and early escalation

**Breadth before depth.** After the ledger has two or more open hypotheses, the investigation SHOULD run cheap, bounded probes for the top two or three before committing to deep work on any single one. Probes are independent subagents or bounded runs, each tied to one hypothesis and charged to the stage budget. Prefer the experiment that best separates the hypotheses.

**Early human escalation.** When two or more hypotheses remain unresolved after their timeboxes, the agent asks a specific structured question through `request_decision`, for example "is this endpoint expected to call inventory twice on retry?", before spending further budget. A useful escalation is recorded as a good outcome, not a failure. Escalations count toward measured human-waiting time (chapter 25).

## Dead-end memory

Hypotheses closed as `ruled_out` become `failed_hypothesis` knowledge records linked to the task's failure signature and component (chapter 24). A later investigation with a matching signature sees them as "previously ruled out, with this evidence". Reopening one requires citing new evidence that the earlier ruling did not consider; the tool rejects a bare reopen. This uses the existing knowledge expiry and dispute rules.

## Rabbit-hole evaluation

The evaluation corpus (chapter 13) includes **decoy bugs**: bugs with a tempting but wrong explanation, and look-alike incidents (chapter 24). For each behavior release, report:
- how often the final root cause matched the first hypothesis opened, and how often it was a later one
- the share of budget spent on hypotheses later ruled out
- stall, extension and escalation rates
- diagnosis time and cost

Changes to prompts, models, ledger tools or timebox defaults are judged on these process measures as well as on final success (W-086).

## Traceability

- W-122–W-125 implement this chapter, and AC-192–AC-198 define its acceptance obligations.
- W-122/W-124/W-136 implement the supplied open/record/close/extend/reopen schemas in factory tools 1.2.0; investigation-discipline/1.0 requires it at admission. The 1.1.0 and 1.0.0 manifests stay frozen. HypothesisLedger is the authenticated backend service; FactoryToolServerV12 uses supervisor-derived FactoryToolContextV12, never agent-supplied identity or epoch.
- W-033 (pilot qualification) depends on W-122. W-107 (first real task) does not, so the first real task stays thin.
- No ledger SQL table or public REST route is added. Ledger transitions are append-only factory_tool_call receipts and immutable artifacts; their ordered results reconstruct state. W-122 widens factory_tool_call.tool_name from the 1.2.0 manifest and qualifies capped extension/reopen behavior (AC-193, AC-197, AC-243).
