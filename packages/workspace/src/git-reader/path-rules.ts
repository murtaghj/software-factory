// Path rules (W-020a, 7.3), the same for tree entries, index entries and directory names. A name is
// checked as well-formed UTF-8 on its raw bytes before anything else uses it; a path is bytes, and is
// decoded only here and only to be judged.
import { ReaderError, limitError, refuse } from './errors.ts';
import type { ReaderLimits } from './limits.ts';

// ignoreBOM: a leading U+FEFF is part of the name (W-018's decoder).
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function decodeName(bytes: Uint8Array, file?: string): string {
  try { return decoder.decode(bytes); } catch { throw new ReaderError('non_utf8_path', { reason: 'a name is not well-formed UTF-8', content: bytes, ...(file === undefined ? {} : { file }) }); }
}

// The code points that HFS+ ignores when it compares names (Git's `is_hfs_dotgit`).
const HFS_IGNORED: ReadonlyArray<readonly [number, number]> = [[0x200c, 0x200f], [0x202a, 0x202e], [0x206a, 0x206f], [0xfeff, 0xfeff]];
function stripHfsIgnored(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (!HFS_IGNORED.some(([lo, hi]) => c >= lo && c <= hi)) out += ch;
  }
  return out;
}
const lowerAscii = (text: string): string => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

// Git's `is_ntfs_dotgit` and the other `is_ntfs_dotgit*` checks: the name, ASCII case-insensitive, is `base` or its short name, followed by nothing,
// or by dots and spaces only, optionally ending at a `:` (an alternate data stream). Linear: one pass, no backtracking. No code point is ignored.
function ntfsNames(name: string, bases: readonly string[]): boolean {
  const lower = lowerAscii(name);
  for (const base of bases) {
    if (!lower.startsWith(base)) continue;
    let i = base.length;
    while (i < lower.length && (lower[i] === ' ' || lower[i] === '.')) i += 1;
    if (i === lower.length || lower[i] === ':') return true;
  }
  return false;
}
// Git's `is_hfs_dotgit` and its siblings: HFS+ ignorable code points removed, ASCII case folded, and then exactly the name. No trailing dots.
const hfsNames = (name: string, bases: readonly string[]): boolean => bases.includes(lowerAscii(stripHfsIgnored(name)));

// `.git` as Git's verify_path reads it with core.protectHFS and core.protectNTFS. The two checks are independent, as they are in Git: the NTFS one
// has no ignorable code points and strips trailing dots and spaces and stops at `:`, the HFS one the reverse.
export const foldsToDotGit = (name: string): boolean => hfsNames(name, ['.git']) || ntfsNames(name, ['.git', 'git~1']);

// Git's `is_ntfs_dot_generic` (path.c), for `.gitmodules`, `.gitattributes`, `.gitignore` and `.mailmap`: the dotted name, ASCII case-insensitive; or its NTFS short
// name, the first six characters and `~1` to `~4`; or the fall-back short name that NTFS makes when those are taken, which is the fixed six-character prefix
// that Git lists for it (the hash of the long name), cut at a `~`, a digit 1 to 9 and digits to the eighth character. Each is followed by nothing, or by dots
// and spaces only, optionally ending at a `:`. Written as the C is, one pass and no backtracking.
function ntfsGeneric(name: string, base: string, fallbackPrefix: string): boolean {
  const tail = (from: number): boolean => {
    for (let i = from; ; i += 1) {
      if (i >= name.length) return true;
      const c = name.charAt(i);
      if (c === ':') return true;
      if (c !== ' ' && c !== '.') return false;
    }
  };
  if (name.startsWith('.') && lowerAscii(name.slice(1, 1 + base.length)) === base) return tail(base.length + 1);
  if (lowerAscii(name.slice(0, 6)) === base.slice(0, 6) && name.charAt(6) === '~' && name.charAt(7) >= '1' && name.charAt(7) <= '4') return tail(8);
  let sawTilde = false;
  for (let i = 0; i < 8; i += 1) {
    if (i >= name.length) return false;
    const c = name.charAt(i);
    if (sawTilde) { if (c < '0' || c > '9') return false; }
    else if (c === '~') { i += 1; const d = name.charAt(i); if (d < '1' || d > '9') return false; sawTilde = true; }
    else if (i >= 6) return false;
    else if (name.charCodeAt(i) >= 0x80) return false;
    else if (lowerAscii(c) !== fallbackPrefix.charAt(i)) return false;
  }
  return tail(8);
}

// Files that Git itself reads and so may not be symlinks, under the same two checks, with the fall-back prefixes Git lists.
const PROTECTED: ReadonlyArray<readonly [string, string]> = [['gitmodules', 'gi7eba'], ['gitattributes', 'gi7d29'], ['gitignore', 'gi250a'], ['mailmap', 'maba30']];
export const isProtectedGitFile = (name: string): boolean => PROTECTED.some(([base, prefix]) => hfsNames(name, [`.${base}`]) || ntfsGeneric(name, base, prefix));

// NAME_MAX on every file system a restore writes to: a longer component could never be checked out, and the cap keeps every per-name scan short.
export const MAX_COMPONENT_BYTES = 255;

// One component. `allowDotGit`: the working-tree walk lists a name that folds to `.git` as excluded instead of refusing it.
export function checkComponent(name: Uint8Array, file: string | undefined, allowDotGit = false): string {
  if (name.length === 0) throw refuse('invalid_path', 'an empty path component', file);
  if (name.length > MAX_COMPONENT_BYTES) throw refuse('invalid_path', 'a path component longer than 255 bytes', file);
  const text = decodeName(name, file);
  if (text === '.' || text === '..') throw refuse('invalid_path', 'a `.` or `..` component', file, name);
  if (name.includes(0)) throw refuse('invalid_path', 'a NUL in a name', file, name);
  if (name.includes(0x2f)) throw refuse('invalid_path', 'a slash inside a name', file, name);
  if (name.includes(0x5c)) throw refuse('invalid_path', 'a backslash in a name (D28)', file, name);
  if (!allowDotGit && foldsToDotGit(text)) throw refuse('invalid_path', 'a component that Git treats as .git', file, name);
  return text;
}

// A whole path made of `/`-separated components (an index entry, or a tree entry's full path). Counts its own limits.
export function checkPath(path: Uint8Array, limits: ReaderLimits, file?: string, symlink = false): void {
  if (path.length === 0) throw refuse('invalid_path', 'an empty path', file);
  if (path.length > limits.maxPathBytes) throw limitError('maxPathBytes', 'a path is longer than the limit', file);
  let start = 0;
  let components = 0;
  for (let i = 0; i <= path.length; i += 1) {
    if (i < path.length && path[i] !== 0x2f) continue;
    const comp = path.subarray(start, i);
    const text = checkComponent(comp, file);
    components += 1;
    if (components > limits.maxDepth) throw limitError('maxDepth', 'a path has more components than the limit', file);
    if (symlink && i === path.length && isProtectedGitFile(text)) throw refuse('invalid_path', 'a symlink named like a file Git reads', file, comp);
    start = i + 1;
  }
}

// Used for a name that comes from a tree: the same rules, with the symlink rule when the entry is one.
export function checkTreeName(name: Uint8Array, symlink: boolean, file?: string): void {
  const text = checkComponent(name, file);
  if (symlink && isProtectedGitFile(text)) throw refuse('invalid_path', 'a symlink named like a file Git reads', file, name);
}
