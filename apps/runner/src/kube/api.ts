// The KubeApi port: only the calls the controller uses (section 5). No watch, no namespace or
// service-account call, no delete-collection, no exec, no patch. A delete takes a name and a UID
// precondition and nothing else: propagation is always Background and the grace period is always
// 15 s, so the port has no parameter through which a force delete (grace 0) could be asked for.

export type OwnerReference = { apiVersion?: string; kind: string; name: string; uid: string };
export type ObjectMeta = {
  name: string; namespace: string; uid: string; labels: Record<string, string>; annotations: Record<string, string>;
  creationTimestamp?: string; deletionTimestamp?: string; ownerReferences?: OwnerReference[];
};

export type ContainerSpec = {
  name: string; image: string; args?: string[]; command?: string[];
  securityContext?: Record<string, unknown>; resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
  terminationMessagePolicy?: 'File' | 'FallbackToLogsOnError'; terminationMessagePath?: string;
};
export type VolumeSpec = { name: string; persistentVolumeClaim?: { claimName: string }; emptyDir?: { sizeLimit?: string }; projected?: Record<string, unknown> };
export type PodSpec = {
  restartPolicy: 'Never'; terminationGracePeriodSeconds: number; serviceAccountName: string; automountServiceAccountToken: boolean;
  enableServiceLinks?: boolean; shareProcessNamespace: boolean; securityContext: Record<string, unknown>;
  initContainers?: ContainerSpec[]; containers: ContainerSpec[]; volumes: VolumeSpec[];
};
export type JobManifest = {
  apiVersion: 'batch/v1'; kind: 'Job';
  metadata: { name: string; namespace: string; labels: Record<string, string>; annotations: Record<string, string> };
  spec: { backoffLimit: number; activeDeadlineSeconds: number; template: { metadata: { labels: Record<string, string>; annotations: Record<string, string> }; spec: PodSpec } };
};
export type KubeJob = Omit<JobManifest, 'metadata'> & { metadata: ObjectMeta; status: { conditions?: Array<{ type: string; status: string; reason?: string }> } };

export type ContainerState = {
  waiting?: { reason?: string };
  running?: { startedAt?: string };
  terminated?: { exitCode: number; message?: string; reason?: string; finishedAt?: string };
};
export type ContainerStatus = { name: string; state: ContainerState };
export type PodPhase = 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown';
export type KubePod = {
  metadata: ObjectMeta; spec: PodSpec;
  status: { phase: PodPhase; reason?: string; initContainerStatuses?: ContainerStatus[]; containerStatuses?: ContainerStatus[] };
};

export type PvcManifest = {
  apiVersion: 'v1'; kind: 'PersistentVolumeClaim';
  metadata: { name: string; namespace: string; labels: Record<string, string>; annotations: Record<string, string> };
  spec: { accessModes: string[]; storageClassName: string; resources: { requests: { storage: string } } };
};
export type KubePvc = Omit<PvcManifest, 'metadata'> & { metadata: ObjectMeta; status: { phase: 'Pending' | 'Bound' | 'Lost' } };

export type TokenReviewResult = {
  authenticated: boolean; error?: string;
  user?: { username?: string; uid?: string; extra?: Record<string, string[]> };
  audiences?: string[];
};
// The cluster's service-account signing keys (`/openid/v1/jwks`), for verifying a pod token locally before it is reviewed.
export type Jwk = { kty: string; kid?: string; alg?: string; use?: string; [k: string]: unknown };
export type Jwks = { keys: Jwk[] };
export type StorageClassInfo = { name: string; reclaimPolicy: string; volumeBindingMode: string };

// A list is paged at 50 and read for at most 10 pages. `truncated` says it stopped at the cap with more to read.
export const LIST_PAGE_SIZE = 50;
export const LIST_MAX_PAGES = 10;
export type ListResult<T> = { items: T[]; truncated: boolean };
// A list stops paging when its signal fires (the reconcile pass's deadline) and fails with an unknown-outcome error.
export type ListOptions = { signal?: AbortSignal | undefined };

export type KubeReason = 'AlreadyExists' | 'Conflict' | 'NotFound' | 'Invalid' | 'Timeout' | 'Forbidden' | 'InternalError' | 'Unauthorized' | 'Unknown';
// One error type with the HTTP status and the Kubernetes `reason`. Status 0 with reason Timeout is an
// unknown outcome: the request may or may not have been applied.
export class KubeError extends Error {
  readonly status: number;
  readonly reason: KubeReason;
  constructor(status: number, reason: KubeReason, message: string) {
    super(message);
    this.name = 'KubeError';
    this.status = status;
    this.reason = reason;
  }
  get isNotFound(): boolean { return this.status === 404; }
  get isAlreadyExists(): boolean { return this.status === 409 && this.reason === 'AlreadyExists'; }
  get isConflict(): boolean { return this.status === 409 && this.reason === 'Conflict'; }
  get isUnknownOutcome(): boolean { return this.status === 0; }
}

export interface KubeApi {
  createJob(job: JobManifest): Promise<KubeJob>;
  getJob(name: string): Promise<KubeJob>;
  listJobs(labelSelector: string, opts?: ListOptions): Promise<ListResult<KubeJob>>;
  deleteJob(name: string, uid: string): Promise<void>;
  listPods(labelSelector: string, opts?: ListOptions): Promise<ListResult<KubePod>>;
  getPod(name: string): Promise<KubePod>;
  deletePod(name: string, uid: string): Promise<void>;
  createPvc(pvc: PvcManifest): Promise<KubePvc>;
  getPvc(name: string): Promise<KubePvc>;
  listPvcs(labelSelector: string, opts?: ListOptions): Promise<ListResult<KubePvc>>;
  deletePvc(name: string, uid: string): Promise<void>;
  reviewToken(token: string, audiences: readonly string[]): Promise<TokenReviewResult>;
  getServiceAccountJwks(): Promise<Jwks>;
  getStorageClass(name: string): Promise<StorageClassInfo>;
}

export const GRACE_SECONDS = 15;
export const PROPAGATION = 'Background';
