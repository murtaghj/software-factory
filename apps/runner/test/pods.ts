// Test helpers for building pods in the fake without a Job controller.
import type { FakeKube } from '../src/testing.ts';
import type { KubePod } from '../src/index.ts';

// A Job with one pod whose init container `materialize` has the given termination message policy.
export function receiptStatusFor(kube: FakeKube, policy: 'File' | 'FallbackToLogsOnError' = 'File'): { pod: KubePod; driver: FakeKube['driver'] } {
  const name = `j${String(kube.jobs.size + 1)}`;
  const container = (n: string): never => ({ name: n, image: 'x', terminationMessagePolicy: policy } as never);
  kube.jobs.set(name, { apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace: kube.namespace, uid: `uid-${name}`, labels: {}, annotations: {} }, status: {},
    spec: { backoffLimit: 0, activeDeadlineSeconds: 1, template: { metadata: { labels: {}, annotations: {} }, spec: { restartPolicy: 'Never', terminationGracePeriodSeconds: 15, serviceAccountName: 'sa', automountServiceAccountToken: false,
      shareProcessNamespace: false, securityContext: {}, initContainers: [container('materialize')], containers: [container('harness')], volumes: [] } } } });
  return { pod: kube.driver.spawnPod(name), driver: kube.driver };
}

// A pod that carries an allocation's label but belongs to someone else's Job (or to none).
export function foreignPod(kube: FakeKube, allocationId: string, o: { name: string; owner?: { kind: string; name: string; uid: string }; phase?: 'Running' | 'Succeeded' }): KubePod {
  const pod: KubePod = {
    metadata: { name: o.name, namespace: kube.namespace, uid: `foreign-${o.name}`, labels: { 'factory.local/allocation': allocationId }, annotations: {}, ...(o.owner ? { ownerReferences: [o.owner] } : {}) },
    spec: { restartPolicy: 'Never', terminationGracePeriodSeconds: 15, serviceAccountName: 'x', automountServiceAccountToken: false, shareProcessNamespace: false, securityContext: {}, containers: [{ name: 'c', image: 'x' }], volumes: [] },
    status: { phase: o.phase ?? 'Running', containerStatuses: [{ name: 'c', state: o.phase === 'Succeeded' ? { terminated: { exitCode: 0 } } : { running: {} } }] },
  };
  kube.pods.set(o.name, pod);
  return pod;
}
export const uniqueViolation = (): Error => Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
