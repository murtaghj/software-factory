// The network start gate on this CNI (k3s only): under the standing egress policy, with this machine's four deny targets, the writer's start record lists every target as denied,
// and the harness started after the gate's last round. A probe pod cannot connect to the gateway's Postgres and Temporal ports and can complete a handshake with the listener.
// The control: a run whose deny list also names the listener never passes the gate (exit 68, no permit requested, the workspace still allocated).
// This shows those rules active on this CNI, as D11 says, and nothing about any other rule.
import { afterAll, describe, expect, it } from 'vitest';
import { getWorkspace } from '@factory/database';
import { hex, until } from './harness.ts';
import net from 'node:net';
import { sleep } from './k8s/cluster.ts';
import { supervisedRig, standingDenyTargets, type Supervised } from './k8s/supervised.ts';
import type { KubePod } from '../src/index.ts';

const rigs: Supervised[] = [];
afterAll(async () => {
  for (const x of rigs.splice(0)) {
    try {
      await x.admin.clean('factory.local/org'); await x.admin.clean('factory-test=w019-gate');
      let left: string[] = [];
      for (let i = 0; i < 240; i += 1) { left = await x.admin.leftovers(); if (left.length === 0) break; await sleep(500); }
      expect(left).toEqual([]);
    } finally { await x.close(); }
  }
});
const podOf = async (x: Supervised, jobName: string): Promise<KubePod> => (await x.admin.items(x.admin.ns('pods'))).map((p) => p as unknown as KubePod).find((p) => p.metadata.ownerReferences?.some((o) => o.name === jobName)) as KubePod;

// From the host, where no policy applies: does something answer on this loopback port?
const hostAccepts = (port: number): Promise<boolean> => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port });
  s.setTimeout(2000, () => { s.destroy(); resolve(false); });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => { resolve(false); });
});

describe('W-019 the network gate on k3s', () => {
  it('before anything is claimed about the policy: from the HOST, where no policy applies, the compose Postgres (:55432) and Temporal (:57233) accept a connection, so a refusal seen by a pod later is the policy\'s and not an absent service', async () => {
    expect(await hostAccepts(55432)).toBe(true);
    expect(await hostAccepts(57233)).toBe(true);
    expect(await hostAccepts(1)).toBe(false); // control: a closed port is refused from the host too
  });

  it('under the standing policy: the start record lists every deny target as denied, the harness starts after the gate\'s last round, and a probe pod cannot reach the gateway\'s :55432 or :57233 but completes a handshake with the listener', async () => {
    const x = await supervisedRig('w019_k8s_gate', { script: 'idle' });
    rigs.push(x);
    const s = await x.e.newStage(x.e.a);
    const ws = await x.e.newWorkspace(x.e.a, s, x.inst, { baseCommit: x.env.fixtureCommit });
    await x.inst.runner.startOrAttach(x.e.ctx(x.e.a), x.e.input(x.e.a, s, { workspaceId: ws }), hex('e'));
    const a = (await x.e.allocations(x.e.a, s))[0] as NonNullable<Awaited<ReturnType<typeof x.e.allocations>>[number]>;
    await until('running', async () => { await x.inst.runner.reconcileOne(x.e.a.orgId, a.id, 5000); return (await x.e.allocation(x.e.a, a.id)).state === 'running'; }, 300_000);
    const record = (await x.e.q<{ details: { report: string } }>(x.e.a, "SELECT details_ref AS details FROM factory.audit_event WHERE action = 'runner.writer_start' AND resource_id = $1", [a.id]))[0];
    const report = JSON.parse(record?.details.report ?? '{}') as { passed?: boolean; targets?: Array<{ target: string; result: string }> };
    expect(report.passed).toBe(true);
    expect(report.targets?.map((t) => t.target).sort()).toEqual([...x.denyTargets].sort());
    expect(report.targets?.every((t) => t.result === 'denied')).toBe(true); // every target listed as failed
    const pod = await podOf(x, a.jobName);
    const log = (await x.admin.logs(pod.metadata.name, 'supervisor')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { event: string });
    expect(log.findIndex((l) => l.event === 'gate')).toBeLessThan(log.findIndex((l) => l.event === 'running')); // the harness's start is later than the gate's last round
    // a probe pod in the namespace, under the same policy
    const probe = `probe-${a.id.slice(0, 6)}`;
    const targets = x.denyTargets.filter((t) => t.endsWith(':55432') || t.endsWith(':57233'));
    const script = `const net=require('net'),tls=require('tls'),fs=require('fs');const out=[];let n=0;const done=()=>{if(++n===${String(targets.length + 1)})console.log(JSON.stringify(out))};`
      + `for(const t of ${JSON.stringify(targets)}){const [h,p]=t.split(':');const s=net.connect({host:h,port:+p});s.setTimeout(5000,()=>{out.push({t,r:'timeout'});s.destroy();done()});s.on('connect',()=>{out.push({t,r:'open'});s.destroy();done()});s.on('error',(e)=>{out.push({t,r:e.code});done()})}`
      + `const c=tls.connect({host:'${x.env.listenerAddress}',port:${String(x.env.listenerPort)},ca:fs.readFileSync('/ca/runner-ca.crt'),servername:''},()=>{out.push({t:'listener',r:c.authorized?'handshake':'unauthorized'});c.destroy();done()});c.on('error',(e)=>{out.push({t:'listener',r:e.code??e.message});done()})`;
    await x.admin.ok('POST', x.admin.ns('pods'), { apiVersion: 'v1', kind: 'Pod', metadata: { name: probe, labels: { 'factory-test': 'w019-gate' } }, spec: {
      restartPolicy: 'Never', serviceAccountName: 'factory-allocation-supervisor', automountServiceAccountToken: false, securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [{ name: 'c', image: 'factory-stub:local', command: ['node', '-e', script], securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, runAsUser: 10001 }, volumeMounts: [{ name: 'ca', mountPath: '/ca' }] }],
      volumes: [{ name: 'ca', configMap: { name: x.env.runnerCaConfigMap } }] } });
    await until('the probe finished', async () => ['Succeeded', 'Failed'].includes(((await x.admin.ok('GET', `${x.admin.ns('pods')}/${probe}`)) as { status: { phase: string } }).status.phase), 120_000);
    const out = JSON.parse((await x.admin.logs(probe, 'c')).trim().split('\n').at(-1) ?? '[]') as Array<{ t: string; r: string }>;
    for (const t of targets) expect(['ECONNREFUSED', 'timeout'], t).toContain(out.find((o) => o.t === t)?.r); // denied: refused or timed out, never open
    expect(out.find((o) => o.t === 'listener')?.r).toBe('handshake');
    await x.admin.call('DELETE', `${x.admin.ns('pods')}/${probe}`, { gracePeriodSeconds: 0 });
  }, 900_000);

  it('control: a run whose deny list also names the listener\'s own address and port never passes the gate: the supervisor exits 68, no permit was requested, and the workspace is still allocated', async () => {
    const probeEnv = (await import('./k8s/cluster.ts')).loadK3sEnv();
    const base = await standingDenyTargets(probeEnv, new (await import('./k8s/cluster.ts')).AdminClient(probeEnv));
    const x = await supervisedRig('w019_k8s_gate_ctl', { script: 'idle', denyTargets: [...base, `${probeEnv.listenerAddress}:${String(probeEnv.listenerPort)}`] });
    rigs.push(x);
    const s = await x.e.newStage(x.e.a);
    const ws = await x.e.newWorkspace(x.e.a, s, x.inst, { baseCommit: x.env.fixtureCommit });
    await x.inst.runner.startOrAttach(x.e.ctx(x.e.a), x.e.input(x.e.a, s, { workspaceId: ws }), hex('e'));
    const a = (await x.e.allocations(x.e.a, s))[0] as NonNullable<Awaited<ReturnType<typeof x.e.allocations>>[number]>;
    let pod: KubePod | undefined;
    await until('the supervisor exited', async () => {
      await x.inst.runner.reconcileOne(x.e.a.orgId, a.id, 5000).catch(() => undefined);
      pod = (await x.admin.items(x.admin.ns('pods'))).map((p) => p as unknown as KubePod).find((p) => p.metadata.ownerReferences?.some((o) => o.name === a.jobName));
      return pod?.status.containerStatuses?.find((c) => c.name === 'supervisor')?.state.terminated !== undefined;
    }, 300_000); // the gate's own bound is 120 s
    expect(pod?.status.containerStatuses?.find((c) => c.name === 'supervisor')?.state.terminated?.exitCode).toBe(68);
    expect(await x.e.auditCount(x.e.a, "action = 'runner.writer_start' AND resource_id = $1", [a.id])).toBe(0); // no permit was granted
    expect((await x.e.allocation(x.e.a, a.id)).podUid).toBeNull();
    const w = await x.e.db.withTenant({ orgId: x.e.a.orgId }, (tx) => getWorkspace(tx, x.e.a.orgId, ws));
    expect(w?.state).toBe('allocated'); // the workspace was never touched
  }, 900_000);
});
