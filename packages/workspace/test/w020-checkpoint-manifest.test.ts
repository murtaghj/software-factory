import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHECKPOINT_PARTS, CHECKPOINT_PART_CAPS, acceptedCheckpointPurpose, checkpointPartPurpose, computeIndexDigest, isCheckpointPart,
  parseHandoff, parseIndexManifest, parseWorktreeManifest, type PortableHandoff,
} from '../src/checkpoint-manifest.ts';
import { openCandidate } from '../src/git-reader/index.ts';
import { makeKit, type Kit } from './git-reader-kit.ts';
import { expectCode, refusal } from './git-reader-helpers.ts';

// The documents of 7.7's checkpoint-manifest.ts: what the reader produces round-trips through JSON and the validators, and each validator refuses what it should.
let kit: Kit;
beforeAll(() => { kit = makeKit(); });
afterAll(() => { kit.cleanup(); });

const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
const without = (o: object, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
const HANDOFF: PortableHandoff = {
  schema: 'factory-portable-handoff/1', taskId: 'task-1', stageRunId: 'run-1', allocationId: 'alloc-1', generation: 2, epoch: 3, reason: 'harness_exited', harnessExitCode: 0,
  headCommit: 'a'.repeat(40), indexCommit: 'b'.repeat(40), worktreeCommit: 'c'.repeat(40), gitVersion: 'git version 2.50.1', readerVersion: 'factory-git-reader/1', nativeState: 'absent', narrative: null,
};

describe('the index and working-tree manifests', () => {
  it('what the reader produces from a dirty checkout parses, through JSON, and comes back equal', async () => {
    const c = kit.makeCandidate({ 'a.txt': 'a\n', 'dir/b.txt': 'b\n', link: { symlink: 'a.txt' } });
    kit.writeFiles(c.work, { 'new.txt': 'new\n', 'a.txt': 'edited\n' });
    c.inWork(['add', '-N', 'new.txt']);
    c.inWork(['update-index', '--skip-worktree', 'dir/b.txt']);
    kit.writeFiles(c.work, { '.env': 'S=1\n' });
    const r = openCandidate(c.mountRoot, c.target);
    try {
      const s = await r.snapshot();
      expect(parseIndexManifest(json(s.index))).toEqual(s.index);
      expect(parseWorktreeManifest(json(s.worktree))).toEqual(s.worktree);
      expect(s.worktree.excluded).toEqual([{ path: '.env', reason: 'deny_list' }]);
      expect(s.index.indexDigest).toBe(computeIndexDigest(s.index.entries));
    } finally { r.close(); }
  });

  it('an index manifest with an unknown key, __proto__, a wrong digest, unsorted entries, a bad id or a path the rules refuse is refused; the builder ids are optional and validated', async () => {
    const c = kit.makeCandidate({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    const r = openCandidate(c.mountRoot, c.target);
    let good: unknown;
    try { good = json((await r.snapshot()).index); } finally { r.close(); }
    const m = good as Record<string, unknown> & { entries: Array<Record<string, unknown>> };
    expect(() => parseIndexManifest(good)).not.toThrow(); // control
    expectCode(refusal(() => parseIndexManifest({ ...m, extra: 1 })), 'invalid_request');
    expectCode(refusal(() => parseIndexManifest(JSON.parse('{"schema":"factory-checkpoint-index/1","__proto__":{}}'))), 'invalid_request');
    expectCode(refusal(() => parseIndexManifest({ ...m, indexDigest: '0'.repeat(64) })), 'invalid_request', 'indexDigest');
    expectCode(refusal(() => parseIndexManifest({ ...m, entries: [...m.entries].reverse() })), 'invalid_request', 'ascending');
    expectCode(refusal(() => parseIndexManifest({ ...m, headCommit: 'nothex' })), 'invalid_request');
    expectCode(refusal(() => parseIndexManifest({ ...m, indexVersion: 5 })), 'invalid_request');
    const dotGit = [{ ...(m.entries[0] ?? {}), path: '.git/config' }];
    expectCode(refusal(() => parseIndexManifest({ ...m, entries: dotGit, indexDigest: computeIndexDigest(dotGit as never) })), 'invalid_request', 'path rules');
    const withBuilder = { ...m, builder: { indexTree: '1'.repeat(40), worktreeTree: '2'.repeat(40), indexCommit: '3'.repeat(40), worktreeCommit: '4'.repeat(40) } };
    expect(parseIndexManifest(withBuilder).builder?.indexCommit).toBe('3'.repeat(40));
    expectCode(refusal(() => parseIndexManifest({ ...m, builder: { indexTree: '1'.repeat(40) } })), 'invalid_request');
  });

  it('a working-tree manifest: a symlink without its target, blob ids that do not match the present files, a duplicate path and an unknown reason are refused', async () => {
    const c = kit.makeCandidate({ 'a.txt': 'a\n', link: { symlink: 'a.txt' } });
    const r = openCandidate(c.mountRoot, c.target);
    let good: Record<string, unknown> & { files: Array<Record<string, unknown>>; blobIds: unknown[]; excluded: unknown[] };
    try { good = json((await r.snapshot()).worktree) as typeof good; } finally { r.close(); }
    expect(() => parseWorktreeManifest(good)).not.toThrow(); // control
    expectCode(refusal(() => parseWorktreeManifest(without(good, 'collisions'))), 'invalid_request');
    expectCode(refusal(() => parseWorktreeManifest({ ...good, collisions: { caseOnly: -1, normalization: 0 } })), 'invalid_request');
    const noTarget = good.files.map((f) => (f['kind'] === 'symlink' ? without(f, 'symlinkTarget') : f));
    expectCode(refusal(() => parseWorktreeManifest({ ...good, files: noTarget })), 'invalid_request', 'without its target');
    expectCode(refusal(() => parseWorktreeManifest({ ...good, blobIds: good.blobIds.slice(1) })), 'invalid_request', 'blobIds');
    expectCode(refusal(() => parseWorktreeManifest({ ...good, files: [...good.files, good.files[0]] })), 'invalid_request', 'twice');
    expectCode(refusal(() => parseWorktreeManifest({ ...good, excluded: [{ path: 'x', reason: 'because' }] })), 'invalid_request');
    expect(parseWorktreeManifest({ ...good, excluded: [{ path: '.GIT', reason: 'nested_git' }] }).excluded).toHaveLength(1); // an excluded name may fold to .git
  });
});

describe('the handoff, the parts and their purposes', () => {
  it('the handoff validates exactly its shape: nativeState absent, narrative null, reason harness_exited, no other key', () => {
    expect(parseHandoff(json(HANDOFF))).toEqual(HANDOFF);
    expect(parseHandoff(json({ ...HANDOFF, harnessExitCode: null })).harnessExitCode).toBeNull();
    for (const bad of [{ ...HANDOFF, extra: 1 }, { ...HANDOFF, narrative: 'the agent says it is done' }, { ...HANDOFF, nativeState: 'present' }, { ...HANDOFF, reason: 'cancelled' }, { ...HANDOFF, headCommit: 'x' }, { ...HANDOFF, generation: 0 }, { ...HANDOFF, harnessExitCode: 1.5 }]) {
      expectCode(refusal(() => parseHandoff(json(bad))), 'invalid_request');
    }
    expectCode(refusal(() => parseHandoff(without(HANDOFF, 'epoch'))), 'invalid_request');
  });

  it('the six parts, their caps (bundle 256 MiB, each patch 128 MiB, index 64 MiB, manifest 32 MiB, handoff 64 KiB) and the two purposes', () => {
    expect([...CHECKPOINT_PARTS]).toEqual(['index', 'handoff', 'bundle', 'staged', 'unstaged', 'manifest']);
    expect(CHECKPOINT_PART_CAPS).toEqual({ index: 64 * 1048576, handoff: 65536, bundle: 256 * 1048576, staged: 128 * 1048576, unstaged: 128 * 1048576, manifest: 32 * 1048576 });
    expect(CHECKPOINT_PARTS.every(isCheckpointPart)).toBe(true);
    expect(isCheckpointPart('objects')).toBe(false);
    expect(isCheckpointPart('__proto__')).toBe(false);
    expect(checkpointPartPurpose('child-1', 'bundle')).toBe('checkpoint_part/child-1/bundle');
    expect(acceptedCheckpointPurpose('ws-1', 4, 'manifest')).toBe('checkpoint/ws-1/g4/manifest');
  });
});
