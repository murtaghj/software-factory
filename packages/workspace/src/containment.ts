// Dependency-free rules shared by the materializer (paths.ts re-exports them) and the untrusted-Git reader (W-020a): UUIDs, the strict symlink
// containment rule and the case-and-normalisation fold. This module imports nothing but errors.ts, so the reader can load it without
// loading node:fs, a database client or anything else (review, Livia and Furio L7).
import { WorkspaceError } from './errors.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (s: string): boolean => UUID.test(s);

// The strict rule (README, "Symlinks"). A tracked symlink is accepted only if its target is
// relative, contains no `..` component, and does not resolve through another symlink of the tree
// (nor is itself another symlink). A lexical check cannot be trusted once links can be chained:
// `a/b/up -> ../..` followed by `escape -> a/b/up/../../..` normalizes inside the root and climbs
// out on disk. The walk is linear: a target is capped in bytes and components before it is split,
// and prefixes are built incrementally.
export const MAX_SYMLINK_TARGET_BYTES = 1023;
export const MAX_SYMLINK_TARGET_COMPONENTS = 128;

export function assertSymlinksContained(entries: ReadonlyArray<{ path: string; kind: string; symlinkTarget?: string }>): void {
  // A trie of the symlinks' own paths, keyed by (parent id, name) so no key grows with depth. A target
  // can pass through a symlink only along a path that exists in this trie, so a walk stops at the first
  // missing node.
  const nodes = new Map<string, number>();
  const isLink = new Set<number>();
  let next = 1;
  const nodeOf = (parent: number, name: string, create: boolean): number | undefined => {
    const key = `${String(parent)}:${name}`;
    const found = nodes.get(key);
    if (found !== undefined || !create) return found;
    nodes.set(key, next);
    next += 1;
    return next - 1;
  };
  const dirOf = new Map<string, number>(); // the trie node of each symlink's directory, remembered while building
  for (const e of entries) {
    if (e.kind !== 'symlink') continue;
    let node = 0;
    const parts = e.path.split('/');
    for (let i = 0; i < parts.length; i += 1) {
      node = nodeOf(node, parts[i] ?? '', true) ?? 0;
      if (i === parts.length - 2) dirOf.set(e.path, node);
    }
    if (parts.length === 1) dirOf.set(e.path, 0);
    isLink.add(node);
  }
  for (const e of entries) {
    if (e.kind !== 'symlink' || e.symlinkTarget === undefined) continue;
    const target = e.symlinkTarget;
    const fail = (why: string): never => { throw new WorkspaceError('escaping_symlink', `symlink ${e.path.slice(0, 200)} is refused: ${why}`, { path: e.path.slice(0, 200), why }); };
    if (Buffer.byteLength(target) > MAX_SYMLINK_TARGET_BYTES) fail(`target longer than ${String(MAX_SYMLINK_TARGET_BYTES)} bytes`);
    if (target === '' || target.startsWith('/') || target.includes('\0')) fail('absolute or empty target');
    const parts = target.split('/', MAX_SYMLINK_TARGET_COMPONENTS + 2).filter((p) => p !== '' && p !== '.');
    if (parts.length > MAX_SYMLINK_TARGET_COMPONENTS) fail(`more than ${String(MAX_SYMLINK_TARGET_COMPONENTS)} components`);
    if (parts.includes('..')) fail('a `..` component');
    // Walk the target from the link's own directory. The directory's own prefixes are not links (a Git
    // tree has no path through a symlink), so the walk starts at that directory's node, if it has one.
    let node: number | undefined = dirOf.get(e.path);
    for (const part of parts) {
      if (node === undefined) break;
      node = nodeOf(node, part, false);
      if (node !== undefined && isLink.has(node)) fail('it resolves through another symlink');
    }
  }
}

// Case folding for the collision check: NFC, Unicode lowercase, and final sigma folded to sigma
// (APFS treats them as one). Not exact Unicode case folding; verifyCheckout's re-hash is the backstop
// for anything this misses, since a collision shows up there as a file that is not the digested one.
export const foldName = (name: string): string => name.normalize('NFC').toLocaleLowerCase('und').replace(/\u03C2/g, '\u03C3');

// How many names in `paths` collide with an earlier name of the same directory once folded, and why. `caseOnly` counts names that differ from the
// first name of their group only by case (or by anything else the fold removes, other than normalisation); `normalization` counts names that are the
// same text in another Unicode normalisation form. Both are legal on Linux; the manifest counts them so that a restore on a folding host can decide.
export function countFoldedCollisions(paths: readonly string[]): { caseOnly: number; normalization: number } {
  const groups = new Map<string, string[]>();
  const nodes = new Map<string, number>();
  let next = 1;
  const folded = new Map<string, string>();
  for (const p of paths) {
    let parent = 0;
    for (const part of p.split('/')) {
      let f = folded.get(part);
      if (f === undefined) { f = foldName(part); folded.set(part, f); }
      const key = `${String(parent)}:${f}`;
      let node = nodes.get(key);
      if (node === undefined) { node = next; next += 1; nodes.set(key, node); groups.set(key, [part]); }
      else { const g = groups.get(key) ?? []; if (!g.includes(part)) g.push(part); groups.set(key, g); }
      parent = node;
    }
  }
  let caseOnly = 0;
  let normalization = 0;
  for (const names of groups.values()) {
    const first = names[0] ?? '';
    for (const other of names.slice(1)) { if (other.normalize('NFC') === first.normalize('NFC')) normalization += 1; else caseOnly += 1; }
  }
  return { caseOnly, normalization };
}
