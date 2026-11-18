import { randomUUID } from 'node:crypto';
import { FakeKube, FakeKubelet } from '../src/testing.ts';
import { expect, it } from 'vitest';
import { registerConformance, type ConformanceDriver } from './conformance/suite.ts';

const recorded: string[] = [];
registerConformance('fake', () => {
  const kube = new FakeKube();
  const kubelet = new FakeKubelet(kube, { graceMs: 800 });
  const d = kube.driver;
  const driver: ConformanceDriver = {
    images: { exitOnTerm: 'factory-stub:local', ignoreTerm: 'factory-stub-ignore-term:local', message: 'factory-stub-message:local', stderrFail: 'factory-stub-stderr-fail:local', exitZero: 'factory-stub-exit0:local' },
    graceMs: 800, namespace: kube.namespace, uniqueSuffix: () => randomUUID().slice(0, 6),
    rawDeleteJob: (n) => { d.rawDeleteJob(n); return Promise.resolve(); },
    forceDeletePod: (n) => { d.forceDeletePod(n); return Promise.resolve(); },
    isProcessAlive: (uid, c) => kubelet.processOf(uid, c)?.alive(),
    async waitFor(what, cond, timeoutMs) {
      const t0 = Date.now();
      while (!(await cond())) { if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 25)); }
    },
    advanceReviewClock: (ms) => { d.advance(ms); return Promise.resolve(); },
    mintToken: (podName, audience) => Promise.resolve(kube.mintToken(d.pod(podName), audience)),
    record: (k, v) => { recorded.push(`${k}=${v}`); },
    expireDeadline: (n) => { d.expireDeadline(n); return Promise.resolve(); },
  };
  return Promise.resolve({ kube, driver, close: () => kubelet.close() });
});

it('row 9 recorded the order it saw', () => { expect(recorded.some((r) => r.startsWith('row9.order='))).toBe(true); });
