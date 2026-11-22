// Path and source rules (chapter 06, "Workspace topology"): repository roots and subpaths come from
// approved registry rows only; traversal, escaping symlinks, arbitrary clone URLs and a workspace
// root inside any existing checkout are each refused with their own code.
import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import type { Tx } from '@factory/database';
import { resolveRepositorySource } from '@factory/database';
import { WorkspaceError } from './errors.ts';

export { isUuid, MAX_SYMLINK_TARGET_BYTES, MAX_SYMLINK_TARGET_COMPONENTS, assertSymlinksContained, foldName } from './containment.ts';
import { foldName } from './containment.ts';

// A request that tries to name its own source. The allocate spec has no such field; if one arrives
// anyway it is an attack or a bug, never something to ignore quietly.
const URL_FIELDS = ['cloneUrl', 'cloneURL', 'url', 'remote', 'remoteUrl', 'repositoryUrl', 'source'];
export function assertNoCallerSuppliedSource(spec: object): void {
  for (const f of URL_FIELDS) {
    if (Object.hasOwn(spec, f)) throw new WorkspaceError('caller_supplied_url', `the request may not name a clone source (${f}); it comes from the repository registry`);
  }
}

// The registry's URL, checked once more here: no option-like value or host, no `::` remote-helper
// syntax, no control characters, and no credentials. The one userinfo allowed is a bare username (no
// password) on an ssh URL or an scp-style address (`git@host:org/repo`), which carries no secret; a
// username in an https URL is usually a token and is refused.
export function assertCloneUrl(url: string): void {
  const refuse = (): never => { throw new WorkspaceError('invalid_clone_url', 'the registered clone URL is not acceptable'); };
  if (url === '' || url.startsWith('-') || url.includes('::') || /[\0\n\r\s]/.test(url)) refuse();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)/i.exec(url);
  if (scheme) {
    const authority = scheme[2] ?? '';
    const at = authority.lastIndexOf('@');
    const host = at === -1 ? authority : authority.slice(at + 1);
    if (host.startsWith('-')) refuse();
    if (at !== -1) {
      const user = authority.slice(0, at);
      if (scheme[1]?.toLowerCase() !== 'ssh' || !/^[A-Za-z0-9._-]+$/.test(user)) refuse();
    }
    return;
  }
  const scp = /^([A-Za-z0-9._-]+)@([^:/]+):/.exec(url);
  if (scp) { if ((scp[2] ?? '').startsWith('-')) refuse(); return; }
  if (url.includes('@') && !url.startsWith('/') && !url.startsWith('.')) refuse(); // some other userinfo-looking form
}

export function validateSubpath(subpath: string): string {
  if (subpath === '') return '';
  if (subpath.startsWith('/') || subpath.includes('\\') || subpath.includes('\0')) throw new WorkspaceError('path_traversal', `subpath ${JSON.stringify(subpath)} must be relative`, { subpath });
  const parts = subpath.split('/');
  if (parts.some((p) => p === '..' || p === '.' || p === '')) throw new WorkspaceError('path_traversal', `subpath ${JSON.stringify(subpath)} leaves the repository root`, { subpath });
  return subpath;
}

// Lexical check: does a symlink at `path` (from the repository root) with `target` point outside the root?
export function symlinkEscapes(path: string, target: string): boolean {
  if (target.startsWith('/') || target.includes('\0')) return true;
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  return resolved === '..' || resolved.startsWith('../');
}

// The old, lexical rule. It is kept only so a test can show that it passes the symlink chains that
// the strict rule below refuses; nothing uses it to decide anything.
export function assertSymlinkInside(path: string, target: string): void {
  if (symlinkEscapes(path, target)) throw new WorkspaceError('escaping_symlink', `symlink ${path} -> ${target} leaves the repository root`, { path, target });
}

// Paths that are different in Git but one on a case-insensitive or normalizing file system (macOS).
// Keyed by (parent node, folded name), so the work is linear in the total number of path components.
export function assertNoFoldedCollisions(paths: readonly string[]): void {
  const nodes = new Map<string, { id: number; original: string }>();
  const folded = new Map<string, string>(); // distinct names are few; fold each once
  let next = 1;
  for (const p of paths) {
    let parent = 0;
    for (const part of p.split('/')) {
      let f = folded.get(part);
      if (f === undefined) { f = foldName(part); folded.set(part, f); }
      const key = `${String(parent)}:${f}`;
      const node = nodes.get(key);
      if (node === undefined) { nodes.set(key, { id: next, original: part }); parent = next; next += 1; }
      else if (node.original !== part) throw new WorkspaceError('path_collision', `paths ${p.slice(0, 200)} and another name the same file on a case-insensitive file system (${node.original.slice(0, 100)} / ${part.slice(0, 100)})`, { a: node.original.slice(0, 100), b: part.slice(0, 100) });
      else parent = node.id;
    }
  }
}

const ownedBySelf = (uid: number): boolean => { const me = process.getuid?.(); return me === undefined || uid === me; };

// The workspace root must be a real directory owned by this user and not group- or world-writable.
// It is created 0700 if absent.
export function assertSafeRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const s = lstatSync(root);
  if (s.isSymbolicLink() || !s.isDirectory() || !ownedBySelf(s.uid) || (s.mode & 0o022) !== 0) {
    throw new WorkspaceError('unsafe_root', `workspace root ${root} must be a real directory owned by this user and not group- or world-writable`);
  }
}

// One directory below the root (organization, then workspace): created 0700 if absent, and refused if it
// is a symlink, not ours, or writable by others. Each component is lstat'ed; none is followed.
export function ensureSafeChild(parent: string, name: string, create: boolean): string {
  const dir = join(parent, name);
  if (create) { try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } }
  let s;
  try { s = lstatSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !create) return dir; throw e; }
  if (s.isSymbolicLink() || !s.isDirectory() || !ownedBySelf(s.uid) || (s.mode & 0o022) !== 0) {
    throw new WorkspaceError('unsafe_root', `${dir} must be a real directory owned by this user and not group- or world-writable`);
  }
  return dir;
}

// A workspace root must not sit inside any existing checkout: a '.git' entry in the root or any
// ancestor means a candidate-writable repository could own the directory tree.
export function assertRootOutsideCheckouts(root: string): void {
  let dir = resolve(root);
  for (;;) {
    try { lstatSync(join(dir, '.git')); throw new WorkspaceError('root_inside_checkout', `workspace root ${root} is inside a checkout (${dir})`, { checkout: dir }); }
    catch (e) { if (e instanceof WorkspaceError) throw e; if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && (e as NodeJS.ErrnoException).code !== 'ENOTDIR') throw e; }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

export type RepositorySource = { cloneUrl: string; subpath: string; defaultBranch: string };

export async function resolveSource(tx: Tx, orgId: string, taskId: string, repositoryId: string): Promise<RepositorySource> {
  const found = await resolveRepositorySource(tx, orgId, taskId, repositoryId);
  if (!found) throw new WorkspaceError('repository_not_registered', 'the repository is not in the registry', { repositoryId });
  assertCloneUrl(found.cloneUrl);
  if (found.subpaths.length === 0) throw new WorkspaceError('repository_not_linked', 'the task\'s application has no approved link to this repository', { repositoryId });
  if (found.subpaths.length > 1) throw new WorkspaceError('ambiguous_subpath', 'the application links this repository with more than one subpath', { subpaths: found.subpaths });
  return { cloneUrl: found.cloneUrl, subpath: validateSubpath(found.subpaths[0] ?? ''), defaultBranch: found.defaultBranch };
}
