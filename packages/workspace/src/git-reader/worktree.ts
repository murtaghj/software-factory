// The working tree (W-020a, 7.3 "The working-tree manifest"). `work/main` is walked with `lstat` on every
// entry. A name is judged as UTF-8 and against the path rules before anything touches it. Regular files
// are read whole and hashed as raw bytes; their mode is the owner's execute bit alone (C9). Symlinks are
// read and never followed. FIFOs, sockets and devices are never opened. A name that folds to `.git` is not
// entered. D34's exclusions apply to untracked paths only: a tracked path is captured as it stands.
import { createHash } from 'node:crypto';
import { limitError, refuse } from './errors.ts';
import { DirTable } from './dir-table.ts';
import { join, type SafeFs } from './fs-safe.ts';
import type { Budget } from './limits.ts';
import { checkComponent, decodeName, foldsToDotGit, isProtectedGitFile } from './path-rules.ts';

export type ExcludedReason = 'special_file' | 'nested_git' | 'rebuildable_directory' | 'deny_list';
export type WorktreeFile = { pathBytes: Buffer; mode: '100644' | '100755' | '120000'; blob: Buffer; sha256: string; blobId: string };
export type WorktreeExcluded = { pathBytes: Buffer; reason: ExcludedReason };
export type WorktreeScan = { files: WorktreeFile[]; excluded: WorktreeExcluded[]; totalBytes: number; uniqueBytes: number };

// D34: rebuildable directories, by exact component name at any depth.
export const REBUILDABLE_DIRECTORIES: readonly string[] = ['node_modules', '.venv', '__pycache__', '.pytest_cache', '.gradle'];

// D34's interim deny list (A-38), matched after ASCII case folding, on the last component or, for the three directory forms, on the last two.
export function isDeniedName(path: string): boolean {
  const lower = path.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const parts = lower.split('/');
  const last = parts[parts.length - 1] ?? '';
  const parent = parts[parts.length - 2];
  if (last === '.env' || last.startsWith('.env.')) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(last)) return true;
  if (['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.npmrc', '.netrc', '.pypirc', '.git-credentials'].includes(last)) return true;
  return (parent === '.aws' && last === 'credentials') || (parent === '.docker' && last === 'config.json') || (parent === '.kube' && last === 'config');
}

export type TrackedPaths = { files: ReadonlySet<string>; dirs: ReadonlySet<string> };

const key = (b: Buffer): string => b.toString('latin1');

// `onHeld` is told how many bytes of distinct file content the scan holds, as it grows.
export function scanWorktree(fs: SafeFs, root: Buffer, tracked: TrackedPaths, budget: Budget, onHeld?: (bytes: number) => void): WorktreeScan {
  const limits = budget.limits;
  const files: WorktreeFile[] = [];
  const excluded: WorktreeExcluded[] = [];
  const shared = new Map<string, Buffer>(); // sha256 -> the one Buffer that every path with that content shares
  let totalBytes = 0;
  let uniqueBytes = 0;
  let pathBytes = 0;
  let listed = 0;
  const list = (): void => {
    listed += 1;
    if (listed > limits.maxEntries) throw limitError('maxEntries', 'the working tree has more entries than the limit');
  };
  // Directories are rows of a table, counted when they are first seen, with budgets of their own (dir-table.ts). Bit 1 of a row's flags: inside a rebuildable directory.
  const dirs = new DirTable(limits);
  const pending: number[] = [0];
  while (pending.length > 0) {
    const dir = pending.pop() ?? 0;
    const dirAbs = dir === 0 ? root : join(root, dirs.pathOf(dir));
    const insideRebuildable = (dirs.flagsOf(dir) & 1) !== 0;
    for (const name of fs.listDir(dirAbs, limits.maxEntries + 2, 'maxEntries')) {
      budget.tick();
      if (dir === 0 && name.equals(Buffer.from('.git'))) continue; // the root .git entry is never opened
      const abs = join(dirAbs, name);
      const shown = fs.show(abs);
      // The name is judged before any lstat of it.
      const text = decodeName(name, shown);
      checkComponent(name, shown, true);
      if (dirs.fileLength(dir, name.length) > limits.maxPathBytes) throw limitError('maxPathBytes', 'a path is longer than the limit', shown);
      if (dirs.depthOf(dir) + 1 > limits.maxDepth) throw limitError('maxDepth', 'a path has more components than the limit', shown);
      if (foldsToDotGit(text)) { const rel = dirs.pathOf(dir, name); pathBytes += rel.length; list(); excluded.push({ pathBytes: rel, reason: 'nested_git' }); continue; }
      const st = fs.lstat(abs);
      if (st === undefined) throw refuse('file_changed', 'an entry vanished while the tree was walked', shown);
      if (st.isDirectory()) {
        const rebuildableName = REBUILDABLE_DIRECTORIES.includes(text);
        const rel = dirs.pathOf(dir, name);
        const holdsTracked = tracked.dirs.has(key(rel));
        if ((rebuildableName || insideRebuildable) && !holdsTracked) { pathBytes += rel.length; list(); excluded.push({ pathBytes: rel, reason: 'rebuildable_directory' }); continue; }
        pending.push(dirs.add(dir, name, rebuildableName || insideRebuildable ? 1 : 0));
        continue;
      }
      const rel = dirs.pathOf(dir, name);
      pathBytes += rel.length; // files, symlinks and exclusions are the entries of the manifest; a directory's name is counted by the table
      if (pathBytes > limits.maxTotalPathBytes) throw limitError('maxTotalPathBytes', 'the paths together are larger than the limit');
      const isTracked = tracked.files.has(key(rel));
      if (!st.isFile() && !st.isSymbolicLink()) { list(); excluded.push({ pathBytes: rel, reason: 'special_file' }); continue; }
      if (!isTracked) {
        if (insideRebuildable) { list(); excluded.push({ pathBytes: rel, reason: 'rebuildable_directory' }); continue; }
        if (isDeniedName(rel.toString('utf8'))) { list(); excluded.push({ pathBytes: rel, reason: 'deny_list' }); continue; }
      }
      list();
      let data: Buffer;
      let mode: WorktreeFile['mode'];
      if (st.isSymbolicLink()) {
        if (isProtectedGitFile(text)) throw refuse('invalid_path', 'a symlink named like a file Git reads', shown, name);
        data = fs.readlink(abs);
        mode = '120000';
      } else {
        const read = fs.readSmall(abs, limits.maxObjectBytes, 'maxObjectBytes');
        data = read ?? Buffer.alloc(0);
        mode = (Number(st.mode) & 0o100) !== 0 ? '100755' : '100644';
      }
      totalBytes += data.length;
      if (totalBytes > limits.maxTotalBytes) throw limitError('maxTotalBytes', 'the working tree is larger than the limit');
      const sha256 = createHash('sha256').update(data).digest('hex');
      let blob = shared.get(sha256);
      if (blob === undefined) {
        uniqueBytes += data.length;
        if (uniqueBytes > limits.maxUniqueBytes) throw limitError('maxUniqueBytes', 'the distinct files of the working tree are larger than the limit');
        blob = data;
        shared.set(sha256, blob);
        onHeld?.(uniqueBytes);
      }
      const blobId = createHash('sha1').update(`blob ${String(data.length)}\0`).update(data).digest('hex');
      files.push({ pathBytes: rel, mode, blob, sha256, blobId });
    }
  }
  excluded.sort((a, b) => Buffer.compare(a.pathBytes, b.pathBytes));
  return { files, excluded, totalBytes, uniqueBytes };
}
