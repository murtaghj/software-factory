// The pod executor's logic (W-017, 17b): what the `materialize` init container does with its arguments. The
// production entry (`materialize-entry.ts`) and the test image's entry (A-31, `test/pod/materialize-test-entry.ts`)
// both call this; they differ in one argument, `allowFileRemote`, so the `file` transport is a property of
// which entry file an image contains. No argument or environment variable of a Job switches it on.
//
// It runs in a trusted init container, alone on the empty volume, with no database, no identity token and no
// factory credential. Everything it reads is untrusted: the request is capped, parsed once, compared to its
// canonical text and validated field by field before any Git runs. Every check is a length test or an anchored
// pattern with no nested quantifier.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '@factory/domain';
import { GitRunner, WorkspaceError, createPodMaterializer, type MaterializeRequest, type WorkspaceErrorCode } from '@factory/workspace/pod';
import { encodeReceiptMessage, encodeRefusalMessage } from './receipt.ts';

export const MAX_REQUEST_BYTES = 8192;
export const MAX_CLONE_URL_BYTES = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
// https only: a host (no userinfo, so no credential can ride in the URL), an optional port, an optional path.
const HTTPS_URL = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,1800})?$/;
// The test image's fixture: a bare repository on the image's own file system.
const FILE_URL = /^file:\/\/\/[A-Za-z0-9._/-]{1,512}$/;
const KEYS = ['cloneUrl', 'commit', 'kind', 'subpath', 'target', 'taskId'];
const KEYS_WITH_BRANCH = [...KEYS, 'branch'].sort();
const TARGET_KEYS = ['generation', 'orgId', 'workspaceId'];

export class EntryRefusal extends Error {
  readonly code: WorkspaceErrorCode;
  constructor(code: WorkspaceErrorCode, message: string) { super(message); this.name = 'EntryRefusal'; this.code = code; }
}
const refuse = (code: WorkspaceErrorCode, message: string): never => { throw new EntryRefusal(code, message); };

// Exactly the clone sources a pod may use. Production: https only. The test image: https and the fixture over file://.
export function assertRemoteAllowed(url: string, allowFileRemote: boolean): void {
  if (Buffer.byteLength(url) > MAX_CLONE_URL_BYTES) refuse('invalid_clone_url', 'the clone URL is longer than 2,048 bytes');
  if (HTTPS_URL.test(url)) return;
  if (allowFileRemote && FILE_URL.test(url) && !url.includes('..')) return;
  refuse('invalid_clone_url', 'this pod clones over https only');
}

// The request is the exact canonical text the runner rendered: parsed, compared, then validated. A bundle request is
// refused as not_supported (D13: no scoped artifact read from a pod yet).
export function parseRequest(text: string, allowFileRemote: boolean): Extract<MaterializeRequest, { kind: 'remote' }> {
  if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) refuse('invalid_request', 'the request is longer than 8 KiB');
  let v: unknown;
  try { v = JSON.parse(text); } catch { return refuse('invalid_request', 'the request is not JSON'); }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return refuse('invalid_request', 'the request is not an object');
  const o = v as Record<string, unknown>;
  if (o['kind'] === 'bundle') return refuse('not_supported', 'bundle sources are not served to pods (D13)');
  if (canonicalJson(o) !== text) refuse('invalid_request', 'the request is not in canonical form');
  const keys = Object.keys(o).sort();
  if (keys.join(',') !== KEYS.join(',') && keys.join(',') !== KEYS_WITH_BRANCH.join(',')) refuse('invalid_request', 'the request has unexpected or missing fields');
  const t = o['target'];
  if (o['kind'] !== 'remote' || typeof t !== 'object' || t === null || Array.isArray(t)) return refuse('invalid_request', 'the request is not a remote request');
  const target = t as Record<string, unknown>;
  if (Object.keys(target).sort().join(',') !== TARGET_KEYS.join(',')) refuse('invalid_request', 'the target has unexpected or missing fields');
  const { orgId, workspaceId, generation } = target;
  if (typeof orgId !== 'string' || !UUID.test(orgId) || typeof workspaceId !== 'string' || !UUID.test(workspaceId)) return refuse('invalid_request', 'the target ids are not UUIDs');
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1 || generation > 2_147_483_647) return refuse('invalid_request', 'the generation is not a positive integer');
  const { taskId, cloneUrl, commit, subpath, branch } = o;
  if (typeof taskId !== 'string' || !UUID.test(taskId)) return refuse('invalid_request', 'the task id is not a UUID');
  if (typeof cloneUrl !== 'string') return refuse('invalid_request', 'the clone URL is not a string');
  assertRemoteAllowed(cloneUrl, allowFileRemote);
  if (typeof commit !== 'string' || !COMMIT.test(commit)) return refuse('invalid_request', 'the commit is not a full object id');
  if (typeof subpath !== 'string' || Buffer.byteLength(subpath) > 1024) return refuse('invalid_request', 'the subpath is not a string of at most 1,024 bytes');
  if (branch !== undefined && (typeof branch !== 'string' || !BRANCH.test(branch))) return refuse('invalid_request', 'the branch name is not acceptable');
  return { kind: 'remote', target: { orgId, workspaceId, generation }, taskId, cloneUrl, commit, ...(branch === undefined ? {} : { branch }), subpath };
}

export type RunOptions = {
  argv: readonly string[];          // what follows the entry file: ['materialize', '--request', <canonical JSON>]
  volume: string;                   // the mount point of the workspace volume
  allowFileRemote: boolean;
  allowFileTransport?: boolean;     // the test image only; the transport is off in Git itself unless this is set
  git?: GitRunner;
  signal: AbortSignal;              // aborts on TERM
  writeMessage: (text: string) => void;
};

// Returns the exit code. A receipt is exit 0; every refusal is non-zero; TERM is 143.
export async function runMaterialize(o: RunOptions): Promise<number> {
  const refusal = (code: WorkspaceErrorCode, message: string, exit: number): number => { o.writeMessage(`${encodeRefusalMessage(code, message)}\n`); return exit; };
  try {
    if (o.argv.length !== 3 || o.argv[0] !== 'materialize' || o.argv[1] !== '--request') return refusal('invalid_request', 'usage: materialize --request <canonical JSON>', 2);
    const request = parseRequest(o.argv[2] ?? '', o.allowFileRemote);
    // The root is a subdirectory this process creates itself, mode 0750 (W-019: the supervisor, in group 10001 through fsGroup, lists the checkout): the mount
    // point of a provisioned volume is usually group- or world-writable, and the workspace package refuses a root like that.
    const root = join(o.volume, 'factory');
    try { mkdirSync(root, { mode: 0o750 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const git = o.git ?? new GitRunner(o.allowFileTransport === true ? { allowFileTransport: true } : {});
    const result = await createPodMaterializer({ root, git }).materialize(request, { signal: o.signal });
    if (o.signal.aborted) return refusal(result.ok ? 'git_failed' : result.code, 'terminated before the receipt was written', 143);
    if (result.ok) { o.writeMessage(`${encodeReceiptMessage(result.receipt)}\n`); return 0; }
    return refusal(result.code, result.message, 1);
  } catch (e) {
    if (e instanceof EntryRefusal || e instanceof WorkspaceError) return refusal(e.code, e.message, 2);
    return refusal('git_failed', `the materializer failed: ${e instanceof Error ? e.message : 'unknown error'}`, 1);
  }
}

// The process wrapper both entry files call: TERM aborts (Git's process group is killed and awaited by the runner of
// Git, the staging path is removed), the message goes to the termination-message file, and the exit code is the answer.
// `messagePath` defaults to the kubelet's fixed path. Only the test entry passes another (the fake kubelet's file); the
// production entry reads no environment variable for it.
export async function runProcess(o: { volume: string; allowFileRemote: boolean; allowFileTransport?: boolean; git?: GitRunner; messagePath?: string }): Promise<void> {
  // 027 before any Git runs: `git/` and `work/main` are made by Git under the process umask, so they come out 0750 and their files 0640.
  process.umask(0o027);
  const controller = new AbortController();
  const stop = (): void => { controller.abort(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const { messagePath = '/dev/termination-log', ...rest } = o;
  // A message that cannot be written must not change the exit code: the runner reads a missing message as a failed step.
  const write = (t: string): void => { try { writeFileSync(messagePath, t); } catch (e) { process.stderr.write(`could not write the termination message: ${e instanceof Error ? e.message : 'error'}\n`); } };
  const code = await runMaterialize({ argv: process.argv.slice(2), signal: controller.signal, writeMessage: write, ...rest });
  process.exit(code);
}
