import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';
import { historyFromJSON } from '@temporalio/common/lib/proto-utils';
import { bundleWorkflows, createWorker } from '../src/index.ts';
import type { WorkflowView } from '../src/index.ts';
import { createWorkerHarness, type WorkerHarness } from './harness.ts';

const dir = join(import.meta.dirname, 'histories');
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, { workflowId: string; capturedWithWorkflowCodeDigest: string }>;
const fixtures = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'manifest.json').sort().map((f) => {
  const name = f.replace(/\.json$/, '');
  const meta = manifest[name];
  if (!meta) throw new Error(`history ${name} is not in the manifest`);
  return { name, workflowId: meta.workflowId, history: historyFromJSON(JSON.parse(readFileSync(join(dir, f), 'utf8'))) };
});

async function replay(bundle: Awaited<ReturnType<typeof bundleWorkflows>>): Promise<Array<{ name: string; error: string | undefined }>> {
  const out: Array<{ name: string; error: string | undefined }> = [];
  const byId = new Map(fixtures.map((f) => [f.workflowId, f.name]));
  for await (const r of Worker.runReplayHistories({ workflowBundle: bundle }, fixtures.map((f) => ({ workflowId: f.workflowId, history: f.history })))) {
    out.push({ name: byId.get(r.workflowId) ?? r.workflowId, error: r.error ? `${r.error.name}: ${r.error.message}` : undefined });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

describe('AC-09 worker version replay', () => {
  it('replays every stored representative history (completed, failed, open mid-stage, amended, continued-as-new) without nondeterminism', async () => {
    const names = fixtures.map((f) => f.name);
    // Histories from every accepted build: W-011 (no gate engine), gate-engine-v1 (W-012),
    // budget-v1 (W-013), commands-v1 (W-015) and outcome-v1 (W-016: controller delivery + manifest).
    for (const base of ['active-mid-stage', 'amended', 'completed', 'continued-as-new', 'failed']) {
      expect(names).toContain(base);
      for (const build of ['gate-engine-v1', 'budget-v1', 'commands-v1', 'outcome-v1']) expect(names).toContain(`${base}-${build}`);
    }
    for (const base of ['plan-review-approved', 'paused-resumed', 'cancelled-in-flight']) for (const build of ['commands-v1', 'outcome-v1']) expect(names).toContain(`${base}-${build}`);
    const results = await replay(await bundleWorkflows());
    expect(results).toEqual(fixtures.map((f) => ({ name: f.name, error: undefined })).sort((a, b) => a.name.localeCompare(b.name)));
  });

  it('an incompatible build is detected: replay fails with a determinism violation for every history', async () => {
    const bad = await bundleWorkflowCode({ workflowsPath: join(import.meta.dirname, 'nondeterministic', 'index.ts') });
    const results = await replay(bad);
    expect(results).toHaveLength(fixtures.length);
    for (const r of results) expect(r.error, r.name).toMatch(/DeterminismViolation|Nondeterminism|nondeterminism/i);
  });

  describe('an active workflow survives redeployment onto a new worker build', () => {
    let h: WorkerHarness;
    beforeAll(async () => { h = await createWorkerHarness('ac09'); }, 300_000);
    afterAll(async () => { await h.close(); });

    it('a task mid-stage on the old worker completes on a freshly deployed worker', async () => {
      const { launch } = await h.newTask();
      const taskQueue = `tq-redeploy-${launch.taskId}`;
      const namespace = h.env.namespace ?? 'default';
      const old = await createWorker({ connection: h.env.nativeConnection, namespace, taskQueue, workflowBundle: h.bundle, db: h.db, artifacts: h.artifacts, templateOverrides: { investigation: 'investigation-0.1.0.json' }, fakeStage: { delayMs: (n) => (n === 'investigate' ? 1500 : 0) } });
      const handle = await h.env.client.workflow.start('TaskWorkflow', { taskQueue, workflowId: launch.workflowId, args: [launch] });
      await old.runUntil(async () => {
        for (let i = 0; i < 200; i += 1) {
          if ((await handle.query<WorkflowView>('state')).nodes.investigate?.status === 'running') return;
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error('stage never started');
      });
      // The old worker is gone. A new deployment (newly bundled code) picks the workflow up.
      const fresh = await createWorker({ connection: h.env.nativeConnection, namespace, taskQueue, workflowBundle: await bundleWorkflows(), db: h.db, artifacts: h.artifacts, templateOverrides: { investigation: 'investigation-0.1.0.json' } });
      const view = await fresh.runUntil(handle.result()) as WorkflowView;
      expect(view.status).toBe('succeeded');
      expect(view.nodes.investigate?.status).toBe('passed');
    });
  });
});
