// Start-up checks (W-019, "Start-up checks"): after the storage class and before the listener and the first pass.
import net from 'node:net';
import { RunnerError } from './errors.ts';
import type { RunnerConfig } from './config.ts';
import { KubeError, type KubeApi } from './kube/api.ts';

export const PROBE_NODE_NAME = 'factory-startup-probe-no-such-node';
export type ChecksOptions = {
  kube: KubeApi; config: RunnerConfig;
  // One connect to a deny target; true when it accepts. The default is a real TCP connect with a one-second limit.
  probe?: (target: string) => Promise<boolean>;
  onWarning?: (message: string) => void;
};

const tcpProbe = (target: string): Promise<boolean> => new Promise((resolve) => {
  const i = target.lastIndexOf(':');
  const host = target.slice(0, i).replace(/^\[|\]$/g, '');
  const s = net.connect({ host, port: Number(target.slice(i + 1)) });
  const finish = (ok: boolean): void => { s.destroy(); resolve(ok); };
  s.setTimeout(1000, () => { finish(false); });
  s.once('connect', () => { finish(true); });
  s.once('error', () => { finish(false); });
});

export async function runStartupChecks(o: ChecksOptions): Promise<void> {
  const { kube, config } = o;
  // With the gate required, the deny list must contain the API service's own cluster address and port: a mistyped one would otherwise pass every gate.
  if (config.networkGate.mode === 'required') {
    const svc = await kube.getApiService();
    if (!config.networkGate.denyTargets.includes(`${svc.address}:${String(svc.port)}`)) {
      throw new RunnerError('invalid_request', `networkGate: the deny list does not contain the API service's address ${svc.address}:${String(svc.port)}`);
    }
  }
  // With the node check required, a node that cannot exist must answer 404. A 403 would make every permit not_ready until its start deadline.
  if (config.nodeCheck === 'required') {
    try { await kube.getNode(PROBE_NODE_NAME); throw new RunnerError('invalid_request', 'nodeCheck: a node that cannot exist was found'); } catch (e) {
      if (e instanceof RunnerError) throw e;
      if (!(e instanceof KubeError && e.isNotFound)) throw new RunnerError('invalid_request', `nodeCheck: the node probe answered ${e instanceof KubeError ? String(e.status) : 'an error'}, not 404: the runner may not read nodes`);
    }
  }
  // A warning, never a refusal: a deny target that accepts nothing is "probably mistyped". It proves nothing where the runner is itself under a policy.
  const probe = o.probe ?? tcpProbe;
  const warn = o.onWarning ?? ((m: string): void => { console.warn(m); });
  for (const target of config.networkGate.denyTargets) if (!(await probe(target))) warn(`[runner] deny target ${target} accepts no connection: probably mistyped`);
}
