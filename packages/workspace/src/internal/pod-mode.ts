// The pod mode of the materializer (W-019, C1). Inside a pod the supervisor (uid 10002, group 10001 through fsGroup) must be able to list the checkout the
// trusted init step made, so every level the materializer makes is 0750 there. On a host the same 0750 would open every checkout to the user's group, so
// nothing here is reachable from the package index: no exported signature carries a mode, and a `PodMode` can be minted only in this module.
import { mkdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceError } from '../errors.ts';
import type { GitRunner } from '../git.ts';
import { LocalMaterializer } from '../materializer.ts';

// The key under which a materializer is handed its mode: a symbol only this module and the materializer know, not a field of any exported options type.
export const POD_MODE_KEY: unique symbol = Symbol('factory.workspace.pod-mode');
const minted = new WeakSet<object>();
export type PodMode = Readonly<{ dirMode: 0o750 }>;
function mintPodMode(): PodMode { const m: PodMode = Object.freeze({ dirMode: 0o750 as const }); minted.add(m); return m; }
const ownedBySelf = (uid: number): boolean => { const me = process.getuid?.(); return me === undefined || uid === me; };
export const isPodMode = (v: unknown): v is PodMode => typeof v === 'object' && v !== null && minted.has(v);

// Like `ensureSafeChild`, at the pod's mode: created if absent, and refused if it is a symlink, not ours, or writable by the group or others.
export function ensurePodChild(parent: string, name: string, mode: PodMode): string {
  if (!isPodMode(mode)) throw new WorkspaceError('invalid_request', 'not a pod mode');
  const dir = join(parent, name);
  try { mkdirSync(dir, { mode: mode.dirMode }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  const s = lstatSync(dir);
  if (s.isSymbolicLink() || !s.isDirectory() || !ownedBySelf(s.uid) || (s.mode & 0o022) !== 0) throw new WorkspaceError('unsafe_root', `${dir} must be a real directory owned by this user and not group- or world-writable`);
  return dir;
}

export function createPodMaterializer(o: { root: string; git?: GitRunner }): LocalMaterializer {
  return new LocalMaterializer({ root: o.root, ...(o.git ? { git: o.git } : {}), [POD_MODE_KEY]: mintPodMode() } as ConstructorParameters<typeof LocalMaterializer>[0]);
}
