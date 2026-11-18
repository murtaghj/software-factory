// The shared conformance suite against a real cluster (k3s), through the runner's own HttpsKube and its Role. Rows 13 and
// 15 (RBAC) exist only here. Run with `pnpm test:k8s`; a missing cluster fails the run.
import { afterAll, expect, it } from 'vitest';
import { registerConformance } from './conformance/suite.ts';
import { AdminClient, k3sDriver, loadK3sEnv, runnerKube, sleep } from './k8s/cluster.ts';

const env = loadK3sEnv();
const admin = new AdminClient(env);
const runs: string[] = [];
const recorded: string[] = [];

registerConformance('k3s', () => {
  const kube = runnerKube(env);
  const driver = k3sDriver(env, admin, runs, recorded);
  // Every run's objects carry its `conf/run` label; the cleanup is exact and never touches anything else.
  return Promise.resolve({ kube, driver, close: async () => { for (const r of runs.splice(0)) await admin.clean(`conf/run=${r}`); } });
}, { cluster: true });

it('row 9 recorded the order it saw', () => { expect(recorded.some((r) => r.startsWith('row9.order='))).toBe(true); console.info(`k3s-record ${recorded.join(' ')}`); });

afterAll(async () => {
  // Nothing is left behind: wait for terminating pods and claims, then check the whole namespace.
  let left: string[] = [];
  for (let i = 0; i < 120; i += 1) { left = await admin.leftovers(); if (left.length === 0) break; await sleep(500); }
  expect(left).toEqual([]);
});
