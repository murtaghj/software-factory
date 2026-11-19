// A harness that posts the exit hint in a tight loop must not cost anyone else their renewals: the supervisor coalesces the hints (at most one early renewal per beat),
// and the runner's per-pod bucket bounds even that. Pod A runs `hint-flood`, pod B runs `idle`.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { rig, until, type Rig } from './kit.ts';

let r: Rig | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
const BEATS = 10;

async function twoPods(o: { noCoalesceA: boolean }) {
  let n = 0;
  let a: string | undefined;
  r = await rig('w019_flood', { config: { podRate: { burst: 5, intervalMs: 250 } }, noCoalesce: (pod) => o.noCoalesceA && pod.metadata.name === a });
  r.setScript((pod) => { n += 1; if (n === 1) a = pod.metadata.name; return n === 1 ? 'hint-flood' : 'idle'; });
  const runA = await r.startRun();
  const podA = r.podsOf(runA.jobName)[0] as NonNullable<ReturnType<Rig['podsOf']>[number]>;
  a = podA.metadata.name;
  const runB = await r.startRun();
  const podB = r.podsOf(runB.jobName)[0] as NonNullable<ReturnType<Rig['podsOf']>[number]>;
  for (const [run, pod] of [[runA, podA], [runB, podB]] as const) {
    await until(`${pod.metadata.name} is running`, async () => (await r?.e.allocation(r.e.a, run.allocationId))?.state === 'running', 40_000);
  }
  await until('the flood has begun', () => r?.events(podA.metadata.name, 'launcher').some((x) => x['event'] === 'started') === true, 20_000);
  return { x: r, runA, runB, podA, podB };
}
const tokenOf = (x: Rig, uid: string): string => readFileSync(x.kubelet.tokenFile(uid) as string, 'utf8');

describe('W-019 the exit-hint flood', () => {
  it('over ten beats at most two renewals a beat reach the runner from A, every one of B\'s is granted, and both allocations are running at the end', async () => {
    const { x, runA, runB, podA, podB } = await twoPods({ noCoalesceA: false });
    const t0 = performance.now();
    const aTok = tokenOf(x, podA.metadata.uid); const bTok = tokenOf(x, podB.metadata.uid);
    const mark = x.calls.length;
    await new Promise((res) => setTimeout(res, BEATS * 1000));
    const secs = (performance.now() - t0) / 1000;
    const window = x.calls.slice(mark);
    const fromA = window.filter((c) => c.route === 'renew' && c.token === aTok);
    const fromB = window.filter((c) => c.route === 'renew' && c.token === bTok);
    expect(fromA.length).toBeLessThanOrEqual(Math.ceil(secs) * 2 + 2); // one regular and at most one early renewal a beat
    expect(fromA.length).toBeGreaterThanOrEqual(BEATS - 1); // control: A did renew: it is not simply silent
    expect(fromB.length).toBeGreaterThanOrEqual(BEATS - 2);
    expect(fromB.every((c) => c.granted)).toBe(true);
    expect(fromA.every((c) => c.granted)).toBe(true); // coalesced: never throttled either
    expect((await x.e.allocation(x.e.a, runA.allocationId)).state).toBe('running');
    expect((await x.e.allocation(x.e.a, runB.allocationId)).state).toBe('running');
  }, 120_000);

  it('control: with a supervisor that does not coalesce most of A\'s renewals are answered throttled by the per-pod bucket, the fake\'s review count stays under the shared budget, and B is still granted every time', async () => {
    const { x, runA, runB, podA, podB } = await twoPods({ noCoalesceA: true });
    const aTok = tokenOf(x, podA.metadata.uid); const bTok = tokenOf(x, podB.metadata.uid);
    const mark = x.calls.length;
    const reviewsBefore = x.kube.calls.filter((c) => c.startsWith('reviewToken')).length;
    await new Promise((res) => setTimeout(res, BEATS * 1000));
    const window = x.calls.slice(mark);
    const fromA = window.filter((c) => c.route === 'renew' && c.token === aTok);
    const fromB = window.filter((c) => c.route === 'renew' && c.token === bTok);
    const throttled = fromA.filter((c) => !c.granted && c.code === 'throttled');
    expect(fromA.length).toBeGreaterThan(40); // the flood reached the runner
    expect(throttled.length).toBeGreaterThan(fromA.length / 2); // and the per-pod bucket answered most of it
    const reviews = x.kube.calls.filter((c) => c.startsWith('reviewToken')).length - reviewsBefore;
    expect(reviews).toBeLessThan(20 * BEATS + 40); // well inside the shared budget (20 a second, burst 40, over the window)
    expect(fromB.length).toBeGreaterThanOrEqual(BEATS - 2);
    expect(fromB.every((c) => c.granted)).toBe(true);
    expect((await x.e.allocation(x.e.a, runB.allocationId)).state).toBe('running');
    expect(['running', 'suspect']).toContain((await x.e.allocation(x.e.a, runA.allocationId)).state);
  }, 120_000);
});
