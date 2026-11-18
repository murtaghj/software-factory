// treeDigest (SI-16). W-020's reader must reproduce this byte for byte, so it is exact:
//   input   one commit; its tree walked recursively; one entry per blob, shaped as a FileSnapshot
//   path    from the repository root, '/'-separated, well-formed UTF-8 (else non_utf8_path)
//   mode    Git's six-digit octal string: exactly 100644, 100755 or 120000 (anything else, a submodule
//           160000 included, is refused as unsupported_tree_entry)
//   kind    'file' or 'symlink'; sha256 is lowercase hex of the raw blob bytes (for a symlink the blob
//           is its target); symlinkTarget is present on symlinks only, as UTF-8 (else refused)
//   order   ascending by the path's UTF-8 bytes, compared as unsigned bytes
//   digest  canonicalHash({ algorithm: 'factory-tree-digest/1', entries }) from @factory/domain
import { createHash } from 'node:crypto';
import type { FileSnapshot } from '@factory/contracts';
import { canonicalHash } from '@factory/domain';
import { WorkspaceError } from './errors.ts';

export const TREE_DIGEST_ALGORITHM = 'factory-tree-digest/1';

export type TreeBlob = { pathBytes: Buffer; mode: string; blob: Buffer };

// ignoreBOM: a leading U+FEFF is part of the path, not a mark to strip (else "\uFEFFa.txt" would collide with "a.txt").
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function utf8(bytes: Buffer, code: 'non_utf8_path' | 'non_utf8_symlink_target', what: string): string {
  try { return decoder.decode(bytes); } catch { throw new WorkspaceError(code, `${what} is not well-formed UTF-8`, { hex: bytes.toString('hex') }); }
}

export function treeEntries(items: readonly TreeBlob[]): FileSnapshot[] {
  const sorted = [...items].sort((a, b) => Buffer.compare(a.pathBytes, b.pathBytes));
  const hashes = new Map<Buffer, string>(); // paths that share a blob share its Buffer: hash it once
  const result = sorted.map((item): FileSnapshot => {
    const path = utf8(item.pathBytes, 'non_utf8_path', 'a path');
    let sha256 = hashes.get(item.blob);
    if (sha256 === undefined) { sha256 = createHash('sha256').update(item.blob).digest('hex'); hashes.set(item.blob, sha256); }
    if (item.mode === '120000') return { path, sha256, mode: item.mode, kind: 'symlink', symlinkTarget: utf8(item.blob, 'non_utf8_symlink_target', `the target of ${path}`) };
    if (item.mode === '100644' || item.mode === '100755') return { path, sha256, mode: item.mode, kind: 'file' };
    throw new WorkspaceError('unsupported_tree_entry', `entry ${path} has unsupported mode ${item.mode}`, { path, mode: item.mode });
  });
  for (let i = 1; i < result.length; i += 1) {
    if (result[i]?.path === result[i - 1]?.path) throw new WorkspaceError('duplicate_path', `path ${result[i]?.path ?? ''} appears twice`, { path: result[i]?.path });
  }
  return result;
}

export function computeTreeDigest(items: readonly TreeBlob[]): string {
  return canonicalHash({ algorithm: TREE_DIGEST_ALGORITHM, entries: treeEntries(items) });
}

const blob = (path: string, mode: string, text: string): TreeBlob => ({ pathBytes: Buffer.from(path, 'utf8'), mode, blob: Buffer.from(text, 'utf8') });

// The committed vector: a regular file, an executable, a symlink, a nested directory and an empty
// file. The same tree committed to Git must give this digest (see w018-tree-digest.test.ts).
export const TREE_DIGEST_TEST_VECTOR = {
  items: [
    blob('a.txt', '100644', 'hello\n'),
    blob('bin/run.sh', '100755', '#!/bin/sh\necho hi\n'),
    blob('link', '120000', 'a.txt'),
    blob('dir/sub/deep.txt', '100644', 'deep\n'),
    blob('empty', '100644', ''),
  ] as readonly TreeBlob[],
  // Also computed independently with Python's hashlib over the same canonical JSON.
  digest: '8b2c1f5a222b30d83283009118ead7519fa5be095884acf36ac2d5787253c58c',
};
