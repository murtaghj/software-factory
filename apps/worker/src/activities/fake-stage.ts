// The M1 fake runner: deterministic output, no harness.
import { Context, ApplicationFailure, CancelledFailure } from '@temporalio/activity';
import { validateContract } from '@factory/contracts';
import type { FakeStageResult, TaskActivities } from '../workflows/types.ts';
import { AUTHOR_PRODUCER, PLAN_SECTIONS, REVIEWER_PRODUCER, type ActivityKit } from './shared.ts';

type FakeStage = Pick<TaskActivities, 'executeFakeStage'>;

export function fakeStageActivities({ deps, tenant, store }: ActivityKit): FakeStage {
  return {
    // The M1 fake runner: deterministic output, no harness. It still produces real finalized
    // artifacts and a schema-valid StageResult bound to the issued stage.
    async executeFakeStage({ orgId, taskId, logicalId, nodeId, stageKind, attempt, inputHash, planVersion }) {
      const delay = deps.fakeStage?.delayMs?.(nodeId, attempt, planVersion) ?? 0;
      if (delay > 0) {
        // Heartbeat while working so cancellation reaches the stage promptly.
        const ctx = Context.current();
        const until = Date.now() + delay;
        while (Date.now() < until) {
          ctx.heartbeat();
          await Promise.race([new Promise((r) => setTimeout(r, 50)), ctx.cancelled.catch(() => undefined)]);
          if (ctx.cancellationSignal.aborted) throw new CancelledFailure('stage cancelled');
        }
      }
      const hold = deps.fakeStage?.hold?.(nodeId, attempt, planVersion);
      if (hold) {
        const ctx = Context.current();
        const latch = { released: false };
        void hold.then(() => { latch.released = true; });
        while (!latch.released) {
          ctx.heartbeat();
          await Promise.race([hold, new Promise((r) => setTimeout(r, 50)), ctx.cancelled.catch(() => undefined)]);
          if (ctx.cancellationSignal.aborted) throw new CancelledFailure('stage cancelled');
        }
      }
      if (deps.fakeStage?.crash?.(nodeId, attempt)) throw ApplicationFailure.nonRetryable('fake runner crashed', 'runner_crashed');
      const status = deps.fakeStage?.outcome?.(nodeId, attempt, planVersion) ?? 'completed';
      const criteria = await tenant(orgId, (tx) => tx.query<{ spec: { acceptanceCriteria?: string[] } }>('SELECT s.spec FROM factory.task_spec_version s JOIN factory.execution_plan p ON p.org_id = s.org_id AND p.task_id = s.task_id AND p.spec_version = s.version WHERE p.task_id = $1 AND p.version = $2', [taskId, planVersion]));
      const criteriaIds = (criteria.rows[0]?.spec.acceptanceCriteria ?? []).map((_t, i) => `C${String(i + 1)}`);
      const defaults: Record<string, Record<string, unknown>> = {
        discover: { criteriaIds, mappedCriteriaIds: criteriaIds, blockingGaps: [] },
        review: { findings: [], reviewerProducerId: REVIEWER_PRODUCER, authorProducerIds: [AUTHOR_PRODUCER], scopeReviewed: true },
        plan: { sections: PLAN_SECTIONS.map((id) => ({ id, applicable: true, summary: `fake ${id} section` })), criteriaIds },
      };
      const evidence = deps.fakeStage?.evidence?.(nodeId, defaults[stageKind] ?? {}) ?? defaults[stageKind] ?? {};
      const output = await store(orgId, taskId, { schemaVersion: '2.0', kind: 'fake_stage_output', stageKind, nodeId, stageRunId: logicalId, inputHash, summary: `fake ${stageKind} output for ${nodeId}`, ...evidence }, 'stage_output');
      const result: FakeStageResult = { schemaVersion: '2.0', orgId, taskId, stageRunId: logicalId, inputHash, allocationEpoch: 1, status, outputRefs: [output], usage: [], producerId: deps.fakeStage?.producerId?.(nodeId) ?? (stageKind === 'review' ? REVIEWER_PRODUCER : AUTHOR_PRODUCER), completedAt: new Date().toISOString(), producerKind: 'runner' };
      const valid = validateContract('StageResult', result);
      if (!valid.ok) throw ApplicationFailure.nonRetryable('fake runner produced an invalid StageResult', 'invalid_result');
      return result;
    },
  };
}
