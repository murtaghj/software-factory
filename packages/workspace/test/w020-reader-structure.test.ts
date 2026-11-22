// The reader's structure (7.3, 7.8): no file under src/git-reader imports node:child_process, node:worker_threads, ../git.ts, or node:fs
// unless it is fs-safe.ts, and none reaches those modules by another door (require, createRequire, getBuiltinModule, a dynamic import).
// A planted import in a temporary copy is the control.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { importClosure } from './git-reader-closure.ts';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src', 'git-reader');
const walk = (dir: string, out: string[] = []): string[] => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else if (n.endsWith('.ts')) out.push(p);
  }
  return out;
};

const BANNED_EVERYWHERE = /(?:from|import|require)\s*\(?\s*['"](?:node:)?(?:child_process|worker_threads|cluster|vm|module)['"]|(?:from|import)\s*\(?\s*['"](?:\.\.\/)+git(?:\.ts)?['"]/;
const FS = /(?:from|import|require)\s*\(?\s*['"](?:node:)?fs(?:\/promises)?['"]/;
const SIDE_DOORS = /\bFunction\b|[{,]\s*constructor\s*:|\bgetOwnPropertyDescriptors?\b|\bgetPrototypeOf\b|\bglobal(This)?\b|\beval\b|\.constructor\b|\[['"]constructor['"]\]|\bFunction\s*\(|\bnew\s+Function\b|\bReflect\b|\bcreateRequire\b|\bgetBuiltinModule\b|\bprocess\.binding\b|(?<![\w.])require\s*\(|(?<![\w.])import\s*\(/;

export function offenders(files: ReadonlyArray<{ path: string; text: string }>): string[] {
  const found: string[] = [];
  for (const f of files) {
    const isFsSafe = f.path.endsWith('fs-safe.ts');
    if (BANNED_EVERYWHERE.test(f.text)) found.push(`${f.path}: child_process, worker_threads, vm, module or ../git.ts`);
    if (!isFsSafe && FS.test(f.text)) found.push(`${f.path}: node:fs`);
    if (SIDE_DOORS.test(f.text)) found.push(`${f.path}: a side door to a built-in module`);
  }
  return found;
}

const read = (dir: string): Array<{ path: string; text: string }> => walk(dir).map((p) => ({ path: relative(dir, p), text: readFileSync(p, 'utf8') }));

describe('src/git-reader', () => {
  it('no file imports child_process, worker_threads or ../git.ts, only fs-safe.ts imports node:fs, and no file has a side door', () => {
    const files = read(SRC);
    expect(files.map((f) => f.path).sort()).toEqual(['commit.ts', 'delta.ts', 'dir-table.ts', 'errors.ts', 'fs-safe.ts', 'index-file.ts', 'index.ts', 'inflate.ts', 'limits.ts', 'loose.ts', 'objects.ts', 'pack.ts', 'path-rules.ts', 'reader.ts', 'refs.ts', 'testing.ts', 'tree.ts', 'worktree.ts']);
    expect(offenders(files)).toEqual([]);
    expect(files.find((f) => f.path === 'fs-safe.ts')?.text).toMatch(FS); // control: the one allowed importer does import it
  });

  it('control: a planted import in a temporary copy is reported, each kind', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'w020-structure-'));
    try {
      const copy = join(tmp, 'git-reader');
      cpSync(SRC, copy, { recursive: true });
      expect(offenders(read(copy))).toEqual([]);
      const plant = (file: string, line: string): string[] => {
        const p = join(copy, file);
        const original = readFileSync(p, 'utf8');
        writeFileSync(p, `${line}\n${original}`);
        try { return offenders(read(copy)); } finally { writeFileSync(p, original); }
      };
      expect(plant('loose.ts', "import { readFileSync } from 'node:fs';")).toEqual([`loose.ts: node:fs`]);
      expect(plant('refs.ts', "import { open } from 'fs/promises';")).toEqual([`refs.ts: node:fs`]);
      expect(plant('pack.ts', "import { spawn } from 'node:child_process';")).toEqual([`pack.ts: child_process, worker_threads, vm, module or ../git.ts`]);
      expect(plant('tree.ts', "import { Worker } from 'node:worker_threads';")).toEqual([`tree.ts: child_process, worker_threads, vm, module or ../git.ts`]);
      expect(plant('reader.ts', "import { GitRunner } from '../git.ts';")).toEqual([`reader.ts: child_process, worker_threads, vm, module or ../git.ts`]);
      expect(plant('commit.ts', "const fs = process.getBuiltinModule('node:fs');")).toEqual([`commit.ts: a side door to a built-in module`]);
      expect(plant('delta.ts', "const m = await import('node:fs');")).toEqual(expect.arrayContaining([`delta.ts: a side door to a built-in module`]));
      expect(plant('inflate.ts', "const r = require('child_process');")).toEqual(expect.arrayContaining([`inflate.ts: a side door to a built-in module`]));
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------- the import closure (review, Furio L7)
// What the reader loads, not only what it names: every module that its files import, and theirs, through relative paths and through the workspace packages,
// stopping at node: modules and external packages, which are listed. A type-only import is erased and not followed.
const ROOT = join(import.meta.dirname, '..', '..', '..');
const FORBIDDEN = [/^node:child_process$/, /^node:worker_threads$/, /^node:cluster$/, /^node:vm$/, /^node:module$/, /^node:net$/, /^node:http/, /^pg$/, /^@factory\/(database|test-support|artifacts|runner|supervisor)/];

describe('the reader\'s import closure', () => {
  it('loads no node:fs outside fs-safe.ts, and no child_process, worker_threads, @factory/database, pg or other I/O module', () => {
    const entries = [join(SRC, 'index.ts'), join(SRC, 'testing.ts')];
    const { modules, external } = importClosure(entries);
    expect(modules.size).toBeGreaterThan(25);
    const outside = [...modules.keys()].filter((f) => !f.startsWith(join(ROOT, 'packages', 'workspace', 'src')) && !f.startsWith(join(ROOT, 'packages', 'domain')));
    expect(outside).toEqual([]); // the closure leaves the workspace package only into @factory/domain
    for (const [spec, importers] of external) {
      if (/^node:fs/.test(spec)) expect(importers.every((f) => f.endsWith('fs-safe.ts')), `${spec} imported by ${importers.join(', ')}`).toBe(true);
      expect(FORBIDDEN.some((re) => re.test(spec)), `${spec} imported by ${importers.join(', ')}`).toBe(false);
    }
    expect([...external.keys()].filter((s) => s.startsWith('node:')).sort()).toEqual(['node:crypto', 'node:fs', 'node:path', 'node:zlib']);
    expect([...external.keys()].filter((s) => !s.startsWith('node:')).sort()).toEqual(['@noble/hashes/sha2.js', '@noble/hashes/utils.js']); // @factory/domain's pure hashing
    expect(modules.has(join(ROOT, 'packages', 'workspace', 'src', 'paths.ts'))).toBe(false); // paths.ts is what pulled in node:fs and the database client
    expect(modules.has(join(ROOT, 'packages', 'workspace', 'src', 'git.ts'))).toBe(false);
  });

  it('control: the closure of paths.ts (which the reader used to import) does reach node:fs, pg and node:http (through @factory/database and @factory/test-support)', () => {
    const { external } = importClosure([join(ROOT, 'packages', 'workspace', 'src', 'paths.ts')]);
    expect([...external.keys()]).toEqual(expect.arrayContaining(['node:fs', 'pg', 'node:http']));
  });
});

// ---------------------------------------------------------------- the seams are not public (review, Livia 7 and Furio L8)
describe('the public entry', () => {
  it('openCandidate takes a mount root, a target and limits, and index.ts exports no hook, no seam and no testing module', () => {
    const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
    expect(index).not.toMatch(/Hooks|testing|skipTrailingDataCheck|extraDirEntries|afterLstat|beforeObject|onFs/);
    expect(readFileSync(join(SRC, 'reader.ts'), 'utf8')).toMatch(/export function openCandidate\(mountRoot: Buffer, target: CandidateTarget, limits\?: Partial<ReaderLimits>\): CandidateReader/);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'packages', 'workspace', 'package.json'), 'utf8')) as { exports: Record<string, string> };
    const boundaries = JSON.parse(readFileSync(join(ROOT, 'tools', 'boundaries.json'), 'utf8')) as { restrictedModules: Array<{ module: string; allowFromPaths?: string[] }> };
    expect(pkg.exports['./git-reader/testing']).toBe('./src/git-reader/testing.ts');
    expect(boundaries.restrictedModules.find((m) => m.module === '@factory/workspace/git-reader/testing')?.allowFromPaths).toEqual(['@factory/workspace/test/']);
  });
});

// ---------------------------------------------------------------- the lint guard bites (review, Furio L7)
describe('the lint guard', () => {
  const lint = (file: string, text: string): { status: number | null; out: string } => {
    const r = spawnSync(join(ROOT, 'node_modules', '.bin', 'eslint'), ['--stdin', '--stdin-filename', join(SRC, file), '--no-warn-ignored'], { input: text, encoding: 'utf8', cwd: ROOT, timeout: 120_000 });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  // Furio's two bypass files, as he gave them: the first reaches `git.ts` and node:fs by import and by a computed name; the second by an import of ../index.ts and a computed name on `process`.
  const BYPASS1 = [
    "import { GitRunner } from '../index.ts';", "import { materialize } from '../materializer.ts';", 'export const a = GitRunner;', 'export const b = materialize;', 'type Loader = (id: string) => unknown;',
    'const p = process as unknown as Record<string, Loader>;', "export const c = p['getBuiltin' + 'Module']?.('node:fs');", "export const d = process.binding('fs');",
    'const gbm = process.getBuiltinModule;', "export const e = gbm('node:child_process');", "export const f = Reflect.get(process, 'getBuiltinModule') as Loader;", '',
  ].join('\n');
  const BYPASS2 = ["import { GitRunner } from '../index.ts';", 'export const a = GitRunner;', 'type Loader = (id: string) => unknown;', 'const p = process as unknown as Record<string, Loader | undefined>;', "export const c = p['getBuiltin' + 'Module']?.('node:fs');", "export const d = p['bind' + 'ing']?.('fs');", ''].join('\n');

  const BYPASS3 = [
    'type Loader = (id: string) => unknown;', 'type Bag = Record<string, Loader | undefined>;',
    'const g1 = global as unknown as Record<string, Bag | undefined>;', "export const a = g1['proc' + 'ess']?.['getBuiltin' + 'Module']?.('node:fs');",
    'const F = ({}).constructor.constructor as unknown as (body: string) => () => Bag;', "export const b = F('return proc' + 'ess')()['getBuiltin' + 'Module']?.('node:child_process');",
    'const ev = eval;', "export const c = (ev as (s: string) => Bag)('proc' + 'ess')['bind' + 'ing']?.('fs');", '',
  ].join('\n');

  // Furio's third round: destructuring, a property descriptor, an alias of Function, and a tagged template that builds the name. The lint is a review aid (README): the boundary is
  // at runtime, where 20b's `read` entry runs under `node --permission` and `--disallow-code-generation-from-strings`.
  const BYPASS4 = [
    "const { constructor: C } = {} as { constructor: unknown };", 'export const a = C;',
    "const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => 1), 'cons' + 'tructor');", 'export const b = d;',
    'const G = Function;', "export const c = G('return 1')();",
    'const tag = (s: TemplateStringsArray): string => s.raw[0] ?? \'\';', 'export const t = tag`process`;', '',
  ].join('\n');

  it('Furio\'s fourth file (destructuring, a property descriptor, an alias of Function, a tagged template) fails lint, each for its own reason, and the structure regexes see them', () => {
    const r = lint('commit.ts', BYPASS4);
    expect(r.status).toBe(1);
    expect(r.out).toContain('no destructured `constructor`');
    expect(r.out).toContain('no property descriptors and no prototype walks');
    expect(r.out).toContain('no `Function`, aliased or not');
    expect(r.out).toContain('no template text naming');
    expect(offenders([{ path: 'commit.ts', text: BYPASS4 }])).toEqual(['commit.ts: a side door to a built-in module']); // by the destructuring, the descriptor and the alias; the tagged template is the lint's (the AST sees a template, a regex cannot tell it from a comment)
    for (const line of ['const { constructor: C } = o;', 'const G = Function;', 'Object.getOwnPropertyDescriptors(o);', 'Object.getPrototypeOf(o);']) {
      expect(offenders([{ path: 'x.ts', text: line }]), line).toEqual(['x.ts: a side door to a built-in module']);
    }
  }, 240_000);

  it('the three side doors of the second round (global, the Function constructor, an aliased eval) fail lint, each for its own reason', () => {
    const r = lint('commit.ts', BYPASS3);
    expect(r.status).toBe(1);
    expect(r.out).toContain('`global` is `globalThis` in Node');
    expect(r.out).toContain('no `.constructor`');
    expect(r.out).toContain('no eval, direct or aliased');
    expect(offenders([{ path: 'commit.ts', text: BYPASS3 }])).toEqual(['commit.ts: a side door to a built-in module']); // and the structure test's regexes see them too
    for (const line of ["const g = global;", "const f = ({}).constructor;", "const e = eval;", "const f = new Function('return 1');", "const x = Reflect.get(a, 'b');", "const c = o['constructor'];"]) {
      expect(offenders([{ path: 'x.ts', text: line }]), line).toEqual(['x.ts: a side door to a built-in module']);
    }
  }, 240_000);

  it('both of Furio\'s bypass files fail, in the reader\'s directory; a clean file passes (control)', () => {
    const clean = lint('commit.ts', readFileSync(join(SRC, 'commit.ts'), 'utf8'));
    expect(clean.status).toBe(0);
    for (const bypass of [BYPASS1, BYPASS2]) {
      const r = lint('commit.ts', bypass);
      expect(r.status).toBe(1);
      expect(r.out).toContain('the reader may import only');
      expect(r.out).toContain('does not touch `process`');
    }
    expect(lint('commit.ts', BYPASS1).out).toContain('no Reflect');
  }, 240_000);

  it('node:fs is allowed in fs-safe.ts and nowhere else of the reader; a re-export is an import', () => {
    expect(lint('fs-safe.ts', readFileSync(join(SRC, 'fs-safe.ts'), 'utf8')).status).toBe(0);
    expect(lint('loose.ts', "import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n").out).toContain('the reader may import only');
    expect(lint('loose.ts', "export * from '../git.ts';\n").out).toContain('the reader may import only');
    expect(lint('loose.ts', "export { materialize } from '../materializer.ts';\n").out).toContain('the reader may import only');
  }, 240_000);
});
