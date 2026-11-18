// The test configuration (`createTestConfig`, `sourceOf`, the plaintext flag) is reachable only from tests: no file under apps/*/src other than testing.ts imports
// `@factory/runner/testing`, and nothing in the runner's src imports `testing.ts` by a relative path. A planted import is the control.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const walk = (dir: string, out: string[] = []): string[] => {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
};
type Source = { path: string; text: string };
const IMPORTS_TESTING = /(?:from|import)\s*\(?\s*['"](?:@factory\/runner\/testing|(?:\.\.?\/)+(?:[\w-]+\/)*testing(?:\.ts)?)['"]/;
export function offenders(files: readonly Source[]): string[] {
  return files.filter((f) => /^apps\/[^/]+\/src\//.test(f.path) && !f.path.endsWith('apps/runner/src/testing.ts') && IMPORTS_TESTING.test(f.text)).map((f) => f.path);
}

describe('W-019 the testing boundary', () => {
  it('no file under apps/*/src other than testing.ts imports @factory/runner/testing, or testing.ts by a relative path', () => {
    const files = readdirSync(join(ROOT, 'apps')).flatMap((app) => { const src = join(ROOT, 'apps', app, 'src'); try { return walk(src); } catch { return []; } })
      .map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
    expect(files.length).toBeGreaterThan(20); // the walk saw the tree
    expect(offenders(files)).toEqual([]);
  });

  it('nothing under apps/*/src other than config.ts and testing.ts references buildConfig, the one function that can mint a test configuration; a planted reference is found', () => {
    const files = readdirSync(join(ROOT, 'apps')).flatMap((app) => { try { return walk(join(ROOT, 'apps', app, 'src')); } catch { return []; } })
      .map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
    const users = (fs: readonly Source[]): string[] => fs.filter((f) => !/apps\/runner\/src\/(config|testing)\.ts$/.test(f.path) && /\bbuildConfig\b/.test(f.text)).map((f) => f.path);
    expect(users(files)).toEqual([]);
    expect(users([{ path: 'apps/runner/src/main.ts', text: "import { buildConfig } from './config.ts';" }, { path: 'apps/runner/src/config.ts', text: 'export function buildConfig() {}' }])).toEqual(['apps/runner/src/main.ts']);
  });

  it('control: a planted import is found, in the runner and in another app, and an import from a test directory is not an offender', () => {
    const planted = [
      { path: 'apps/runner/src/main.ts', text: "import { createTestConfig } from '@factory/runner/testing';" },
      { path: 'apps/api/src/server.ts', text: "import { FakeKube } from '@factory/runner/testing'" },
      { path: 'apps/runner/src/start.ts', text: "import { createTestConfig } from './testing.ts';" },
      { path: 'apps/runner/test/harness.ts', text: "import { FakeKube } from '../src/testing.ts';" },
      { path: 'apps/runner/src/testing.ts', text: "export { x } from './kube/fake.ts';" },
    ];
    expect(offenders(planted)).toEqual(['apps/runner/src/main.ts', 'apps/api/src/server.ts', 'apps/runner/src/start.ts']);
  });

  it('`sourceOf` is not a field of the exported options: RunnerProcessOptions has no such key, and only the test configuration carries it', async () => {
    const main = readFileSync(join(ROOT, 'apps/runner/src/main.ts'), 'utf8');
    const options = /export type RunnerProcessOptions = \{[^}]*\}/s.exec(main)?.[0] ?? '';
    expect(options).toContain('config: RunnerConfig');
    expect(options).not.toMatch(/sourceOf|plaintext/);
    const { createConfig } = await import('../src/config.ts');
    expect(() => createConfig({ runnerIdentity: 'r', controlPlaneIdentities: ['c'], test: { sourceOf: () => 's' } })).toThrow(/test switches/);
  });
});
