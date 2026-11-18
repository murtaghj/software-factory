// The manifests are a pure function of stored rows and configuration (section 5). `renderJob` and
// `renderPvc` take the allocation row, the stage run row, the workspace row, the materialization request
// and the config, and nothing from the caller: the full StageInput is stored nowhere, and any controller can
// render the same manifest after another one has died.
import { createHash } from 'node:crypto';
import type { AllocationRow, RunnerStageRun, WorkspaceRow } from '@factory/database';
import { canonicalJson } from '@factory/domain';
import type { MaterializeRequest } from '@factory/workspace';
import { jobDeadlineSeconds, type ContainerResources, type RunnerConfig } from './config.ts';
import { RunnerError } from './errors.ts';
import type { ContainerSpec, JobManifest, KubeJob, KubePvc, PvcManifest } from './kube/api.ts';
import { annotationKeys, hashLabel, labelKeys, pvcName, tokenAudience } from './names.ts';

export type RenderInput = {
  allocation: AllocationRow; stage: RunnerStageRun; workspace: WorkspaceRow | undefined; request: MaterializeRequest | undefined; config: RunnerConfig;
};

const securityContext = (user: number): Record<string, unknown> => ({
  allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] }, runAsUser: user, runAsGroup: user,
});
const container = (name: string, image: string, args: string[], user: number, res: ContainerResources, mounts: ContainerSpec['volumeMounts']): ContainerSpec => ({
  name, image, args, securityContext: securityContext(user), resources: { requests: { ...res.requests }, limits: { ...res.limits } },
  ...(mounts ? { volumeMounts: mounts } : {}), terminationMessagePolicy: 'File',
});

export function labelsFor(i: RenderInput): Record<string, string> {
  const k = labelKeys(i.config.labelPrefix);
  const a = i.allocation;
  return {
    [k.org]: a.orgId, [k.task]: a.taskId, [k.allocation]: a.id, ...(a.workspaceId === null ? {} : { [k.workspace]: a.workspaceId }),
    [k.generation]: String(a.generation), [k.stageRun]: hashLabel(a.stageRunLogicalId), [k.specHash]: a.specHash.slice(0, 32),
  };
}
export function annotationsFor(i: RenderInput): Record<string, string> {
  const k = annotationKeys(i.config.labelPrefix);
  const a = i.allocation;
  return { [k.org]: a.orgId, [k.task]: a.taskId, [k.allocation]: a.id, [k.stageRunFull]: a.stageRunLogicalId, [k.specHashFull]: a.specHash, [k.ownerEpoch]: String(a.ownerEpoch) };
}

export function renderJob(i: RenderInput): JobManifest {
  const { allocation: a, stage, config: c, workspace } = i;
  const wall = Number(stage.limits['wallSeconds']);
  if (!Number.isSafeInteger(wall) || wall < 1 || wall > c.maxWallSeconds) throw new RunnerError('limits_exceed_cap', 'the stage run\'s wall cap is outside the configured bound');
  const labels = labelsFor(i);
  const annotations = annotationsFor(i);
  const audience = tokenAudience(a.orgId, a.id);
  const workspaceVolume = workspace ? { name: 'workspace', persistentVolumeClaim: { claimName: pvcName(a.orgId, workspace.id, a.generation) } } : { name: 'workspace', emptyDir: { sizeLimit: c.pvcSize } };
  const init: ContainerSpec[] = [];
  if (workspace) {
    if (!i.request) throw new RunnerError('invalid_request', 'a workspace allocation is rendered with its materialization request');
    // The request holds no secret: W-018 refuses clone URLs that carry credentials.
    // The root file system is read-only, and Git needs a private home and temporary files: an emptyDir at /tmp, this container's own.
    init.push(container('materialize', c.images.materializer, ['materialize', '--request', canonicalJson(i.request)], 10001, c.resources.materializer,
      [{ name: 'workspace', mountPath: '/workspace' }, { name: 'materialize-tmp', mountPath: '/tmp' }]));
  }
  const supervisor = container('supervisor', c.images.supervisor, ['serve', '--allocation', a.id], 10002, c.resources.supervisor,
    [{ name: 'workspace', mountPath: '/workspace', readOnly: true }, { name: 'supervisor-tmp', mountPath: '/tmp' }, { name: 'factory-identity', mountPath: '/var/run/factory-identity', readOnly: true }]);
  const harness = container('harness', c.images.harness, ['harness'], 10001, c.resources.harness, [{ name: 'workspace', mountPath: '/workspace' }, { name: 'harness-tmp', mountPath: '/tmp' }]);
  const manifest: JobManifest = {
    apiVersion: 'batch/v1', kind: 'Job',
    metadata: { name: a.jobName, namespace: a.namespace, labels, annotations },
    spec: {
      backoffLimit: 0, activeDeadlineSeconds: jobDeadlineSeconds(c, wall),
      template: {
        metadata: { labels: { ...labels }, annotations: { ...annotations } },
        spec: {
          restartPolicy: 'Never', terminationGracePeriodSeconds: c.graceSeconds, serviceAccountName: c.supervisorServiceAccount, automountServiceAccountToken: false,
          shareProcessNamespace: false, securityContext: { runAsNonRoot: true, fsGroup: 10001, seccompProfile: { type: 'RuntimeDefault' } }, enableServiceLinks: false,
          ...(init.length > 0 ? { initContainers: init } : {}), containers: [supervisor, harness],
          volumes: [workspaceVolume, ...(init.length > 0 ? [{ name: 'materialize-tmp', emptyDir: { sizeLimit: '256Mi' } }] : []), { name: 'supervisor-tmp', emptyDir: { sizeLimit: '256Mi' } }, { name: 'harness-tmp', emptyDir: { sizeLimit: '256Mi' } },
            { name: 'factory-identity', projected: { sources: [{ serviceAccountToken: { audience, expirationSeconds: 600, path: 'token' } }] } }],
        },
      },
    },
  };
  // The runner's own digest of what it rendered, for diagnosis only (nothing validates it).
  const digest = createHash('sha256').update(canonicalJson(manifest)).digest('hex');
  const k = annotationKeys(c.labelPrefix);
  manifest.metadata.annotations[k.manifestDigest] = digest;
  manifest.spec.template.metadata.annotations[k.manifestDigest] = digest;
  return manifest;
}

export function renderPvc(i: RenderInput): PvcManifest {
  const { allocation: a, workspace, config: c } = i;
  if (!workspace) throw new RunnerError('invalid_request', 'only a workspace allocation has a claim');
  const k = labelKeys(c.labelPrefix);
  return {
    apiVersion: 'v1', kind: 'PersistentVolumeClaim',
    // No owner reference to the Job: garbage collection would remove the claim before a checkpoint child mounts it.
    metadata: { name: pvcName(a.orgId, workspace.id, a.generation), namespace: a.namespace, labels: { [k.org]: a.orgId, [k.task]: a.taskId, [k.workspace]: workspace.id, [k.generation]: String(a.generation) }, annotations: annotationsFor(i) },
    spec: { accessModes: ['ReadWriteOncePod'], storageClassName: c.storageClass, resources: { requests: { storage: c.pvcSize } } },
  };
}

// An existing Job under our name is attached only when it is plainly this allocation's: the same
// organization, allocation, specHash and epoch (06-runner-workspaces.md:14: an error, not an attach).
export function jobIsOurs(job: Pick<KubeJob, 'metadata'>, a: AllocationRow, config: RunnerConfig): boolean {
  const k = annotationKeys(config.labelPrefix);
  const an = job.metadata.annotations;
  return job.metadata.name === a.jobName && job.metadata.namespace === a.namespace
    && an[k.org] === a.orgId && an[k.allocation] === a.id && an[k.specHashFull] === a.specHash && an[k.ownerEpoch] === String(a.ownerEpoch)
    && an[k.stageRunFull] === a.stageRunLogicalId && (a.jobUid === null || job.metadata.uid === a.jobUid);
}
// A PVC under our name is ours when its ownership labels name this workspace, generation and organization.
export function pvcIsOurs(pvc: Pick<KubePvc, 'metadata'>, a: Pick<AllocationRow, 'orgId' | 'taskId' | 'generation'>, workspaceId: string, config: RunnerConfig): boolean {
  const k = labelKeys(config.labelPrefix);
  const l = pvc.metadata.labels;
  return pvc.metadata.name === pvcName(a.orgId, workspaceId, a.generation) && l[k.org] === a.orgId && l[k.workspace] === workspaceId && l[k.generation] === String(a.generation) && l[k.task] === a.taskId;
}
// The allocation id a Job's annotations claim, when they validate as a factory Job at all (for the sweep).
export function claimedAllocation(job: Pick<KubeJob, 'metadata'>, config: RunnerConfig): { orgId: string; allocationId: string } | undefined {
  const k = annotationKeys(config.labelPrefix);
  const an = job.metadata.annotations;
  const orgId = an[k.org]; const allocationId = an[k.allocation];
  return typeof orgId === 'string' && typeof allocationId === 'string' ? { orgId, allocationId } : undefined;
}

// ---------------------------------------------------------------- attach: the whole Job, not only the annotations
// An annotation proves nothing about what a Job will run: someone with create rights can copy ours onto a Job whose pod
// has another command, a lifecycle hook, host ports or a runtime class. So an attach compares the whole live Job spec to
// the re-rendered one, EXACTLY. Both sides first get the API server's known defaults filled in where absent (and the
// keys the server generates stripped), so our own Job, as the cluster stores it, passes; any other key anywhere on the
// Job spec, the pod template's metadata, the pod spec, or a container or volume, is a difference.
//
// The defaults below are what this build expects of the API server. The k3s tier (17b) must confirm each against the
// pinned cluster: imagePullPolicy, terminationMessagePath, dnsPolicy, schedulerName, the deprecated `serviceAccount`
// alias, the projected volume's defaultMode, parallelism, completions, completionMode, suspend, podReplacementPolicy,
// the generated selector and the four generated template labels. A default the cluster adds that is not listed here
// quarantines every allocation, which is the safe failure and the one the tier will show.
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const GENERATED_LABELS = ['controller-uid', 'job-name', 'batch.kubernetes.io/controller-uid', 'batch.kubernetes.io/job-name'];

// 0.5 and 500m are the same quantity; 1Gi and 1024Mi too. Compared as numbers.
export function quantityValue(q: string): number | undefined {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|M|G|T|P|E)?$/.exec(q);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
  return n * (m[2] === undefined ? 1 : (unit[m[2]] ?? Number.NaN));
}
const resources = (r: unknown): unknown => {
  if (!isObj(r)) return r;
  const out: Json = {};
  for (const [k, v] of Object.entries(r)) out[k] = isObj(v) ? Object.fromEntries(Object.entries(v).map(([n, q]) => [n, typeof q === 'string' ? (quantityValue(q) ?? q) : q])) : v;
  return out;
};
// The server's rule: a digest pins the image (IfNotPresent); no tag or the tag `latest` is Always; any other tag IfNotPresent.
const pullPolicy = (image: string): string => {
  if (image.includes('@')) return 'IfNotPresent';
  const last = image.split('/').pop() ?? image;
  const tag = last.includes(':') ? last.split(':').pop() : undefined;
  return tag === undefined || tag === 'latest' ? 'Always' : 'IfNotPresent';
};
function normContainer(c: unknown): unknown {
  if (!isObj(c)) return c;
  const out: Json = { ...c };
  out['imagePullPolicy'] ??= typeof c['image'] === 'string' ? pullPolicy(c['image']) : 'IfNotPresent';
  out['terminationMessagePath'] ??= '/dev/termination-log';
  out['terminationMessagePolicy'] ??= 'File';
  if (c['resources'] !== undefined) out['resources'] = resources(c['resources']);
  return out;
}
function volume(v: unknown): unknown {
  if (!isObj(v)) return v;
  const out: Json = { ...v };
  const p = v['projected'];
  if (isObj(p)) out['projected'] = { ...p, defaultMode: p['defaultMode'] ?? 420 };
  return out;
}
function podSpec(p: unknown): unknown {
  if (!isObj(p)) return p;
  const out: Json = { ...p };
  out['dnsPolicy'] ??= 'ClusterFirst';
  out['schedulerName'] ??= 'default-scheduler';
  if (typeof p['serviceAccountName'] === 'string') out['serviceAccount'] ??= p['serviceAccountName']; // the deprecated alias the server fills in
  if (Array.isArray(p['initContainers'])) out['initContainers'] = p['initContainers'].map(normContainer);
  if (Array.isArray(p['containers'])) out['containers'] = p['containers'].map(normContainer);
  if (Array.isArray(p['volumes'])) out['volumes'] = p['volumes'].map(volume);
  return out;
}
function normalizeJob(job: { spec: unknown }): Json {
  const spec = isObj(job.spec) ? { ...job.spec } : {};
  const tpl = isObj(spec['template']) ? { ...spec['template'] } : {};
  const meta = isObj(tpl['metadata']) ? { ...tpl['metadata'] } : {};
  const kept = isObj(meta['labels']) ? Object.entries(meta['labels']) : [];
  const manual = spec['manualSelector'] === true;
  const labels = Object.fromEntries(manual ? kept : kept.filter(([k]) => !GENERATED_LABELS.includes(k))); // generated by the server, not by us
  if (!manual) delete spec['selector'];
  meta['labels'] = labels;
  tpl['metadata'] = meta;
  tpl['spec'] = podSpec(tpl['spec']);
  spec['template'] = tpl;
  spec['parallelism'] ??= 1;
  spec['completions'] ??= 1;
  spec['completionMode'] ??= 'NonIndexed';
  spec['suspend'] ??= false;
  spec['manualSelector'] ??= false; // k3s 1.36.6 writes it (false) on a Job that sets none; a live `true` still differs from the rendered one
  spec['podReplacementPolicy'] ??= 'TerminatingOrFailed';
  return spec;
}
function diffPaths(a: unknown, b: unknown, path: string, out: string[]): void {
  if (out.length >= 20) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { out.push(`${path} (length)`); return; }
    a.forEach((x, i) => { diffPaths(x, b[i], `${path}[${String(i)}]`, out); });
    return;
  }
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], `${path}.${k}`, out);
    return;
  }
  if (canonicalJson(a ?? null) !== canonicalJson(b ?? null)) out.push(path);
}

// The differences, as paths, between the live Job's spec and the rendered one after defaults. Empty means the same Job.
export function templateDifferences(live: Pick<KubeJob, 'spec'>, rendered: JobManifest): string[] {
  const out: string[] = [];
  diffPaths(normalizeJob(rendered), normalizeJob(live), 'spec', out);
  return out;
}
