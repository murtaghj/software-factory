// AC-54 · End-to-end audit (W-016 fake complete vertical slice). One investigation task runs the
// whole M1 stack: API intake → outbox dispatcher → TaskWorkflow (pinned investigation 0.2.0) →
// fake discovery and plan → independent human plan sign-off → fake investigation → independent
// evidence review → controller report delivery → OutcomeManifest → outcome_recorded. An operator
// then exports the outcome bundle, and every claim in it is traced back to the trusted record it
// came from. Afterwards the export is attacked: forged human authority, AI fields in human mode, a
// stored view that disagrees with the gate table, and corrupted bytes are all refused.
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { validateContract, type ArtifactRef, type DecisionView, type GatePage, type OutcomeManifest } from '@factory/contracts';
import { canonicalHash, canonicalJson } from '@factory/domain';
import type { OutcomeBundle } from '@factory/api';
import { createSystemHarness, type SystemHarness, type SystemUser } from '../src/index.ts';
import { ALL_SECTIONS, createTask, getTask, investigation, pendingDecision, respond, waitStatus } from './support.ts';

const NODES = ['scope', 'plan', 'plan_review', 'investigate', 'evidence_review', 'deliver', 'close'];
const RUNNER_NODES = ['scope', 'plan', 'investigate', 'evidence_review'];

describe('AC-54 end-to-end audit', () => {
  let h: SystemHarness;
  let creator: SystemUser;
  let reviewer: SystemUser;
  let operator: SystemUser;
  let viewer: SystemUser;
  let taskId: string;
  let bundle: OutcomeBundle;
  let decision: DecisionView;
  beforeAll(async () => {
    h = await createSystemHarness('ac54', { temporal: {} });
    creator = await h.user([{ role: 'contributor', scope: [h.applicationId] }]);
    reviewer = await h.user([{ role: 'reviewer', scope: [h.applicationId] }]);
    operator = await h.user([{ role: 'operator', scope: [h.applicationId] }]);
    viewer = await h.user([{ role: 'viewer', scope: [h.applicationId] }]);
  }, 300_000);
  afterAll(async () => { await h.close(); });

  const exportBundle = (user: SystemUser, id = taskId) => h.call(user, 'GET', `/v2/tasks/${id}/outcome-bundle`);
  const storeDoc = async (doc: unknown, purpose: string): Promise<ArtifactRef> => {
    const object = await h.artifacts.putControllerObject(h.orgId, Buffer.from(canonicalJson(doc)));
    return h.tx((t) => h.artifacts.registerControllerArtifact(t, { orgId: h.orgId, taskId, producerId: 'test:forger', object, mediaType: 'application/json', schemaVersion: '2.0', classification: 'ordinary', purpose }));
  };
  const pointOutcomeAt = (ref: ArtifactRef) => h.tx((t) => t.query('UPDATE factory.task SET outcome_ref = $2 WHERE id = $1', [taskId, JSON.stringify(ref)]));

  it('a delivered report: intake through fake execution, human sign-off, independent review, delivery and outcome manifest', async () => {
    taskId = await createTask(h, creator);
    decision = await pendingDecision(h, creator, taskId);
    expect(decision).toMatchObject({ action: 'approve_plan', requiredPrincipalId: reviewer.principalId });
    // Nothing is delivered yet: the export refuses rather than exporting a partial outcome.
    expect(await exportBundle(operator)).toMatchObject({ status: 409, body: { code: 'outcome_not_recorded' } });
    expect((await respond(h, reviewer, taskId, decision)).status).toBe(202);
    const done = await waitStatus(h, creator, taskId, ['succeeded', 'failed', 'incomplete', 'cancelled']);
    expect(done.status).toBe('succeeded');
    expect(done.outcomeRef).toBeDefined();
    expect(done.cleanupState).toBe('complete');
  }, 120_000);

  it('only an operator exports the outcome bundle', async () => {
    expect(await exportBundle(viewer)).toMatchObject({ status: 403, body: { code: 'outcome_export_not_authorized' } });
    expect(await exportBundle(creator)).toMatchObject({ status: 403, body: { code: 'outcome_export_not_authorized' } });
    const stranger = await h.user([{ role: 'operator', scope: [randomUUID()] }]); // operator of another application
    expect(await exportBundle(stranger)).toMatchObject({ status: 404 });
    const r = await exportBundle(operator);
    expect(r.status).toBe(200);
    bundle = r.body as OutcomeBundle;
    expect(bundle).toMatchObject({ schemaVersion: 'factory-outcome-bundle/1', orgId: h.orgId, taskId, exportedBy: operator.principalId });
  });

  it('the outcome manifest is the recorded one, valid, human-mode and complete', async () => {
    const task = await getTask(h, creator, taskId);
    expect(bundle.outcome.ref).toEqual(task.outcomeRef);
    const m: OutcomeManifest = bundle.outcome.value;
    expect(validateContract('OutcomeManifest', m).ok).toBe(true);
    expect(m).toMatchObject({ taskId, status: 'succeeded', deliveryScope: 'report', outcomeKind: 'delivered', reviewMode: 'human', cleanupObligationRefs: [], knowledgeProposalIds: [] });
    // Human mode: no AI fields, no marker, and AI / voluntary reviews are listed separately (empty).
    for (const f of ['reviewMarker', 'reviewModeDecisionRef', 'reviewSubjectRef', 'aiReviewApprovalSetRefs']) expect(m).not.toHaveProperty(f);
    expect(bundle.reviewMode).toBe('human');
    expect(bundle).not.toHaveProperty('reviewMarker');
    expect(bundle.aiReviewDecisions).toEqual([]);
    expect(bundle.voluntaryHumanReviews).toEqual([]);
    expect(m.limitations.join(' ')).toMatch(/fake runner/);
  });

  it('exact source: the accepted spec, its hash, the pinned application snapshot and criteria', () => {
    const submitted = investigation(h.applicationId);
    expect(bundle.source.currentSpecVersion).toBe(1);
    expect(bundle.source.specVersions).toHaveLength(1);
    const v1 = bundle.source.specVersions[0];
    expect(v1).toMatchObject({ version: 1, actorId: creator.principalId, spec: { title: submitted.title, workType: 'investigation', acceptanceCriteria: submitted.acceptanceCriteria } });
    expect(v1?.specHash).toBe(canonicalHash(v1?.spec));
    expect(bundle.source.applicationSnapshot.value).toMatchObject({ targetContext: { kind: 'existing_application', applicationId: h.applicationId } });
    expect(bundle.criteria.value).toEqual({ schemaVersion: '2.0', specVersion: 1, criteria: submitted.acceptanceCriteria.map((text, i) => ({ id: `C${String(i + 1)}`, text })) });
  });

  it('exact policy and plan: the policy snapshot, template and plan the gates were bound to', () => {
    expect(bundle.policy.value).toEqual({ id: 'm1-default-policy', revision: 1, defaultAssurance: 'standard' });
    expect(bundle.template.value).toMatchObject({ id: 'investigation', version: '0.2.0' });
    const plan = bundle.plan.value as { planHash: string; policyRef: ArtifactRef; templateRef: { definitionRef: ArtifactRef }; nodes: Array<{ id: string }> };
    expect(plan.planHash).toBe(bundle.plan.planHash);
    expect(plan.policyRef).toEqual(bundle.policy.ref);
    expect(plan.templateRef.definitionRef).toEqual(bundle.template.ref);
    expect(plan.nodes.map((n) => n.id)).toEqual(NODES);
    for (const g of bundle.gates) {
      expect(g.value.inputBinding.planVersion).toBe(bundle.plan.version);
      expect(g.value.inputBinding.policyRef).toEqual(bundle.policy.ref);
      expect(g.value.inputBinding.workflowTemplateRef).toEqual(bundle.template.ref);
      expect(g.value.inputBinding.applicationSnapshotRef).toEqual(bundle.source.applicationSnapshot.ref);
    }
  });

  it('evidence: every gate in the manifest is the stored evaluation, passed, with its evidence attached', async () => {
    expect(bundle.gates.map((g) => g.value.gateId).sort()).toEqual(['plan_peer_approved', 'review_passed', 'scope_accepted']);
    const listed = (await h.call(operator, 'GET', `/v2/tasks/${taskId}/gates`)).body as GatePage;
    for (const g of bundle.gates) {
      expect(g.value.verdict).toBe('passed');
      expect(g.evidence.length).toBeGreaterThan(0);
      expect(g.evidence.map((e) => e.ref)).toEqual(g.value.evidenceRefs);
      expect(listed.items.find((i) => i.id === g.value.id)).toEqual(g.value);
    }
    // outcome_recorded was evaluated on the manifest itself, after it was recorded.
    const recorded = listed.items.find((i) => i.gateId === 'outcome_recorded');
    expect(recorded).toMatchObject({ verdict: 'passed', evidenceRefs: [bundle.outcome.ref], reasonCodes: ['outcome_recorded'] });
  });

  it('independent result: delivery was gated by a passing review bound to exactly the investigation it delivers', () => {
    // Reviewer independence itself is decided from the recorded stage producers; its negative
    // (a reviewer that ran as the author) is apps/worker/test/w012-gates-in-workflow.test.ts.
    const review = bundle.gates.find((g) => g.value.gateId === 'review_passed');
    expect(review?.value).toMatchObject({ verdict: 'passed', reasonCodes: ['no_blocking_findings'] });
    const investigate = bundle.stageRuns.find((r) => r.nodeId === 'investigate');
    const evidenceReview = bundle.stageRuns.find((r) => r.nodeId === 'evidence_review');
    expect(review?.value.inputBinding.candidateRef).toEqual(investigate?.resultRef);
    expect(review?.value.evidenceRefs).toEqual([evidenceReview?.resultRef]);
    expect(evidenceReview?.role).toBe('reviewer');
    expect(investigate?.role).not.toBe('reviewer');
  });

  it('decisions: the human plan sign-off is traceable to the decider, the exact subject and the reviewed scope', () => {
    expect(bundle.humanDecisions).toHaveLength(1);
    const d = bundle.humanDecisions[0];
    expect(d?.value).toMatchObject({ id: decision.id, taskId, action: 'approve_plan', state: 'approved', actorKind: 'human', deciderId: reviewer.principalId, subjectHash: decision.subjectHash, subjectRef: decision.subjectRef });
    expect(d?.reviewedSectionIds).toEqual(ALL_SECTIONS);
    expect(bundle.outcome.value.decisionRefs).toEqual([d?.ref]);
    expect(bundle.verification.humanAuthorityResolved).toBe(1);
    // The plan packet the reviewer approved is the plan stage's output.
    const planRun = bundle.stageRuns.find((r) => r.nodeId === 'plan');
    expect(d?.value.subjectRef).toEqual(planRun?.resultRef);
    expect(Date.parse(d?.decidedAt ?? '')).toBeLessThanOrEqual(Date.parse(bundle.outcome.value.completedAt));
  });

  it('report delivery: the delivered report is the reviewed investigation, and downloads intact through the isolated origin', async () => {
    expect(bundle.delivered).toHaveLength(1);
    const report = bundle.delivered[0];
    const investigate = bundle.stageRuns.find((r) => r.nodeId === 'investigate');
    const review = bundle.stageRuns.find((r) => r.nodeId === 'evidence_review');
    const deliver = bundle.stageRuns.find((r) => r.nodeId === 'deliver');
    expect(report?.value).toMatchObject({ kind: 'investigation_report', taskId, specVersion: 1, planVersion: 1, reviewedCandidateRef: investigate?.resultRef, reviewRef: review?.resultRef });
    expect(deliver?.resultRef).toEqual(report?.ref);
    if (!report) throw new Error('no delivered report');
    const access = await h.call(operator, 'POST', `/v2/artifacts/${report.ref.artifactId}/access`, { purpose: 'outcome audit download' }, { 'idempotency-key': randomUUID() });
    expect(access.status).toBe(200);
    const { url, sha256 } = access.body as { url: string; sha256: string };
    expect(new URL(url).origin).toBe(new URL(h.origin.url).origin);
    expect(new URL(url).origin).not.toBe(new URL(h.apiUrl).origin);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(report.ref.sha256);
    expect(sha256).toBe(report.ref.sha256);
    expect(JSON.parse(bytes.toString('utf8'))).toEqual(report.value);
  });

  it('stage runs, budget and events account for everything that happened', () => {
    expect(bundle.stageRuns.map((r) => [r.nodeId, r.status])).toEqual(NODES.map((n) => [n, 'passed']));
    for (const r of bundle.stageRuns) {
      expect(r.input?.value).toMatchObject({ logicalId: r.id, inputHash: r.inputHash });
      expect(r.result?.ref).toEqual(r.resultRef);
    }
    // Four fake runner stages at the default 1 USD each; controller stages are charged zero, and
    // every reservation is settled.
    expect(bundle.budget).toMatchObject({ chargedMicroUsd: RUNNER_NODES.length * 1_000_000, reservedMicroUsd: 0 });
    const observed = bundle.budget.ledger.filter((l) => l.kind === 'observed_usage');
    expect(observed).toHaveLength(NODES.length);
    expect(bundle.outcome.value.usage.reduce((a, u) => a + (u.costMicroUsd ?? 0), 0)).toBe(bundle.budget.chargedMicroUsd);
    expect(bundle.outcome.value.usage.every((u) => u.quality === 'estimated')).toBe(true); // fake costs are not claimed as exact
    expect(bundle.events.map((e) => e.sequence)).toEqual(bundle.events.map((_e, i) => i + 1));
    const last = bundle.events.at(-1);
    expect(last?.eventType).toBe('task.completed');
    expect(last?.payload.value).toMatchObject({ state: { status: 'succeeded', outcomeRef: bundle.outcome.ref } });
    expect(bundle.verification.digestVerifiedArtifacts).toBeGreaterThan(bundle.events.length + bundle.stageRuns.length);
  });

  it('provider handles: workflow, runs, dispatch operation, fake runner stages and the artifact store', async () => {
    const task = await getTask(h, creator, taskId);
    const handles = bundle.providerHandles;
    expect(handles).toContain(`temporal:workflow:${task.workflowId}`);
    expect(handles.some((x) => /^temporal:run:[0-9a-f-]{36}$/.test(x))).toBe(true);
    const op = await h.tx(async (t) => (await t.query<{ op: string }>("SELECT payload->>'operationId' AS op FROM factory.outbox WHERE aggregate_id = $1 AND kind = 'task.launch'", [taskId])).rows[0]?.op);
    expect(op).toBeDefined();
    expect(handles).toContain(`dispatcher:operation:${String(op)}`);
    for (const r of bundle.stageRuns.filter((s) => RUNNER_NODES.includes(s.nodeId))) expect(handles).toContain(`fake-runner:${r.id}`);
    expect(handles).toContain(`artifact-store:${bundle.delivered[0]?.ref.artifactId ?? ''}`);
  });

  describe('the export refuses what it cannot prove', () => {
    const manifest = (): OutcomeManifest => structuredClone(bundle.outcome.value);
    const expectRefused = async (code: string, reason?: RegExp) => {
      const r = await exportBundle(operator);
      expect(r).toMatchObject({ status: 409, body: { code } });
      if (reason) expect((r.body as { detail: string }).detail).toMatch(reason);
    };
    afterAll(async () => { await pointOutcomeAt(bundle.outcome.ref); });

    it('forged human authority: a decision view that disagrees with the decision row', async () => {
      const real = bundle.humanDecisions[0]?.value;
      if (!real) throw new Error('no decision');
      const forged = await storeDoc({ ...real, deciderId: operator.principalId }, 'human_decision_record');
      await pointOutcomeAt(await storeDoc({ ...manifest(), decisionRefs: [forged] }, 'outcome_manifest'));
      await expectRefused('outcome_provenance_invalid', /unknown_human_reference/);
    });

    it('AI fields in a human-mode outcome are refused (by the OutcomeManifest schema; the provenance-level rule is in ac-54-outcome-provenance), while a legacy manifest still exports as human', async () => {
      await pointOutcomeAt(await storeDoc({ ...manifest(), aiReviewApprovalSetRefs: [] }, 'outcome_manifest'));
      await expectRefused('outcome_bundle_integrity_failure', /not a valid OutcomeManifest/); // schema already forbids it
      const legacy = manifest() as Partial<OutcomeManifest>;
      delete legacy.reviewMode;
      await pointOutcomeAt(await storeDoc({ ...legacy, voluntaryHumanReviewRefs: [] }, 'outcome_manifest'));
      // A legacy manifest (no mode, no AI fields) is a human outcome and still exports as one.
      const r = await exportBundle(operator);
      expect(r.status).toBe(200);
      expect((r.body as OutcomeBundle).reviewMode).toBe('human');
    });

    it('a stored gate view that overrides the gate table', async () => {
      const g = bundle.gates.find((x) => x.value.gateId === 'scope_accepted');
      if (!g) throw new Error('no gate');
      const altered = await storeDoc({ ...g.value, inputHash: 'a'.repeat(64) }, 'gate_evaluation_record');
      await pointOutcomeAt(await storeDoc({ ...manifest(), gateEvaluationRefs: [altered, ...manifest().gateEvaluationRefs.filter((r) => r.artifactId !== g.ref.artifactId)] }, 'outcome_manifest'));
      await expectRefused('outcome_bundle_integrity_failure', /does not match the stored evaluation/);
    });

    it('corrupted bytes in the artifact store', async () => {
      await pointOutcomeAt(bundle.outcome.ref);
      expect((await exportBundle(operator)).status).toBe(200);
      const report = bundle.delivered[0];
      if (!report) throw new Error('no report');
      const key = await h.tx(async (t) => (await t.query<{ storage_key: string }>('SELECT storage_key FROM factory.artifact WHERE id = $1', [report.ref.artifactId])).rows[0]?.storage_key);
      if (!key) throw new Error('no storage key');
      writeFileSync(join(h.storeRoot, ...key.split('/')), Buffer.from(canonicalJson({ ...(report.value as Record<string, unknown>), summary: 'tampered' }).padEnd(report.ref.sizeBytes, ' ').slice(0, report.ref.sizeBytes)));
      // The report is the deliver stage's result as well, so whichever read reaches it first refuses.
      await expectRefused('outcome_bundle_integrity_failure', /failed digest verification: stored bytes do not match the registered digest/);
    });
  });
});
