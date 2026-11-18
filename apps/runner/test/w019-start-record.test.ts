// The writer start record (W-019): written in the permit's last transaction with the reviewed pod and the node read from the port.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tokenAudience } from '../src/index.ts';
import { createEnv, hex, type Env, type Instance } from './harness.ts';

let e: Env;
beforeAll(async () => { e = await createEnv('w019_start'); });
afterAll(async () => { await e.close(); });

const req = (token: string, allocationId: string, extra: Record<string, unknown> = {}) => ({ token, orgId: e.a.orgId, allocationId, epoch: 1, ...extra });
async function started(inst: Instance) {
  const s = await e.newStage(e.a);
  await inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s), hex('e'));
  const a = (await e.allocations(e.a, s)).at(-1) as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
  const pod = inst.kube.driver.podsOf(a.jobName)[0] as NonNullable<ReturnType<typeof inst.kube.driver.podsOf>[number]>;
  inst.kube.driver.startPod(pod.metadata.name);
  return { s, a, pod, token: inst.kube.mintToken(pod, tokenAudience(e.a.orgId, a.id)) };
}
const records = (id: string) => e.q<{ details: Record<string, unknown> }>(e.a, "SELECT details_ref AS details FROM factory.audit_event WHERE action = 'runner.writer_start' AND resource_id = $1", [id]);

describe('W-019 the writer start record', () => {
  it('a grant writes the start record with the reviewed pod and the node read from the port; the report is stored as reported and capped; a retry by the same pod writes no second row', async () => {
    const inst = e.newRunner({ config: { nodeCheck: 'required' } });
    const x = await started(inst);
    expect(await inst.runner.acquireStartPermit(req(x.token, x.a.id, { report: 'r'.repeat(5000) }))).toMatchObject({ granted: true });
    const [r] = await records(x.a.id);
    expect(r?.details).toMatchObject({ podName: x.pod.metadata.name, podUid: x.pod.metadata.uid, nodeName: 'fake-node-1', nodeUid: 'fake-node-uid-1', reported: true });
    expect((r?.details['report'] as string).length).toBe(1024);
    expect(await inst.runner.acquireStartPermit(req(x.token, x.a.id))).toMatchObject({ granted: true });
    expect(await records(x.a.id)).toHaveLength(1);
  });

  it('a foreign row at the pinned id is a hard error', async () => {
    const inst = e.newRunner();
    const x = await started(inst);
    const { writerStartId } = await import('../src/names.ts');
    await e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query("INSERT INTO factory.audit_event (org_id, id, actor_id, action, resource_kind, resource_id, outcome, correlation_id, request_digest) VALUES ($1,$2,'x','something.else','execution_allocation',$3,'accepted','c',$4)", [e.a.orgId, writerStartId(e.a.orgId, x.a.id), x.a.id, hex('d')]));
    await expect(inst.runner.acquireStartPermit(req(x.token, x.a.id))).rejects.toMatchObject({ code: 'record_conflict' });
    expect((await e.allocation(e.a, x.a.id)).state).toBe('starting'); // the transaction rolled back
  });

  it('a request that fails the review causes no getNode; with the node unreadable and the check required the permit is not_ready; control: with the node readable it is granted', async () => {
    const inst = e.newRunner({ config: { nodeCheck: 'required' } });
    const x = await started(inst);
    const nodeCalls = () => inst.kube.calls.filter((c) => c.startsWith('getNode')).length;
    expect(await inst.runner.acquireStartPermit(req('junk.token.here', x.a.id))).toMatchObject({ code: 'unauthenticated' });
    expect(await inst.runner.acquireStartPermit(req(inst.kube.mintToken(x.pod, tokenAudience(e.a.orgId, x.a.id), { expiresInSeconds: -120 }), x.a.id))).toMatchObject({ reason: 'local_expired' });
    expect(nodeCalls()).toBe(0);
    const { KubeError } = await import('../src/index.ts');
    inst.kube.failNext('getNode', new KubeError(403, 'Forbidden', 'nodes is forbidden'));
    expect(await inst.runner.acquireStartPermit(req(x.token, x.a.id))).toMatchObject({ granted: false, code: 'not_ready', retryable: true });
    expect((await e.allocation(e.a, x.a.id)).state).toBe('starting');
    expect(await inst.runner.acquireStartPermit(req(x.token, x.a.id))).toMatchObject({ granted: true }); // control
    expect(nodeCalls()).toBe(2);
  });

  it('a renewal request that carries a harness field is refused as an unknown key; the same request without it is granted, and its answer\'s harness follows the fake\'s container status', async () => {
    const { parseRenewRequest } = await import('@factory/runner-protocol');
    const body = { orgId: e.a.orgId, allocationId: 'a'.repeat(8) + '-aaaa-4aaa-8aaa-' + 'a'.repeat(12), epoch: 1 };
    expect(parseRenewRequest({ ...body, harness: { state: 'terminated' } }).ok).toBe(false);
    expect(parseRenewRequest(body).ok).toBe(true);
    const inst = e.newRunner();
    const x = await started(inst);
    expect(await inst.runner.acquireStartPermit(req(x.token, x.a.id))).toMatchObject({ granted: true, harness: { state: 'running' } });
    inst.kube.driver.finishApp(x.pod.metadata.name, 'harness', 3);
    expect(await inst.runner.renewPermit(req(x.token, x.a.id))).toMatchObject({ granted: true, harness: { state: 'terminated', exitCode: 3 } });
  });
});
