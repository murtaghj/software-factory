import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, cpSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeSandbox, repoRoot, run, bin } from './workspace-sandbox.ts';
import { checkBoundaries } from '../check-boundaries.ts';

type Manifest = { packageManager?: string; engines?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed JSON read helper
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

function workspaceManifests(): Array<[string, Manifest]> {
  const out: Array<[string, Manifest]> = [[join(repoRoot, 'package.json'), readJson<Manifest>(join(repoRoot, 'package.json'))]];
  for (const group of ['packages', 'apps', 'tests']) {
    for (const entry of readdirSync(join(repoRoot, group))) {
      const p = join(repoRoot, group, entry, 'package.json');
      if (existsSync(p)) out.push([p, readJson<Manifest>(p)]);
    }
  }
  out.push([join(repoRoot, 'fixtures', 'package.json'), readJson<Manifest>(join(repoRoot, 'fixtures', 'package.json'))]);
  return out;
}

const cleanDomain = `export function add(a: number, b: number): number {\n  return a + b;\n}\n`;
const domainManifest = JSON.stringify({ name: '@factory/domain', version: '0.0.0', private: true, type: 'module', dependencies: { '@factory/contracts': 'workspace:*' } });
const contractsManifest = JSON.stringify({ name: '@factory/contracts', version: '0.0.0', private: true, type: 'module' });

describe('AC-260 toolchain and contract generation', () => {
  it('pins the Node 24 LTS runtime, pnpm and every dependency to an exact version', () => {
    const root = readJson<Manifest>(join(repoRoot, 'package.json'));
    const nodeVersion = readFileSync(join(repoRoot, '.node-version'), 'utf8').trim();
    expect(nodeVersion).toMatch(/^24\.\d+\.\d+$/);
    expect(root.engines?.node).toBe(nodeVersion);
    expect(process.version).toBe(`v${nodeVersion}`);
    expect(root.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    const ranged: string[] = [];
    for (const [path, m] of workspaceManifests()) {
      for (const [name, spec] of Object.entries({ ...m.dependencies, ...m.devDependencies })) {
        if (spec !== 'workspace:*' && !/^\d+\.\d+\.\d+$/.test(spec)) ranged.push(`${path}: ${name}@${spec}`);
      }
    }
    expect(ranged).toEqual([]);
  });

  it('pins local service images by digest', () => {
    const compose = readFileSync(join(repoRoot, 'compose.yaml'), 'utf8');
    const images = [...compose.matchAll(/image:\s*(\S+)/g)].map((m) => m[1] ?? '');
    expect(images.length).toBeGreaterThanOrEqual(2);
    for (const image of images) expect(image).toMatch(/:[\w.-]+@sha256:[0-9a-f]{64}$/);
    expect(compose).toMatch(/postgres:18\.\d+@/);
  });

  it('honours the committed lockfile: frozen install passes unchanged and fails when a manifest drifts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-lock-'));
    try {
      cpSync(repoRoot, dir, { recursive: true, filter: (src) => !src.includes('node_modules') && !src.includes(join(repoRoot, '.git')) && !src.includes(join(repoRoot, 'docs')) });
      const pnpm = ['--frozen-lockfile', '--offline', '--ignore-scripts', '--lockfile-only'];
      const ok = run('pnpm', ['install', ...pnpm], dir, { COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' });
      expect(ok.output).not.toContain('ERR_PNPM_OUTDATED_LOCKFILE');
      expect(ok.status).toBe(0);
      const manifestPath = join(dir, 'package.json');
      const manifest = readJson<Manifest & Record<string, unknown>>(manifestPath);
      manifest.devDependencies = { ...manifest.devDependencies, typescript: '6.0.2' };
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      const drift = run('pnpm', ['install', ...pnpm], dir, { COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' });
      expect(drift.status).not.toBe(0);
      expect(drift.output).toContain('ERR_PNPM_OUTDATED_LOCKFILE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails strict lint on a seeded violation and passes the clean control', () => {
    const sb = makeSandbox();
    try {
      sb.write('packages/domain/src/index.ts', cleanDomain);
      const clean = run(bin('eslint'), ['--max-warnings=0', 'packages'], sb.dir);
      expect(clean.output).toBe('');
      expect(clean.status).toBe(0);
      sb.write('packages/domain/src/index.ts', `export function parse(x: string): any {\n  const unused = 1;\n  return JSON.parse(x);\n}\n`);
      const bad = run(bin('eslint'), ['--max-warnings=0', 'packages'], sb.dir);
      expect(bad.status).not.toBe(0);
      expect(bad.output).toContain('@typescript-eslint/no-explicit-any');
      expect(bad.output).toContain('no-unused-vars');
    } finally { sb.dispose(); }
  });

  it('fails strict typecheck on a seeded type error and passes the clean control', () => {
    const sb = makeSandbox();
    try {
      sb.write('packages/domain/src/index.ts', cleanDomain);
      const clean = run(bin('tsc'), ['-p', 'tsconfig.json', '--noEmit'], sb.dir);
      expect(clean.output).toBe('');
      expect(clean.status).toBe(0);
      sb.write('packages/domain/src/index.ts', `export function first(xs: string[]): string {\n  return xs[0];\n}\n`);
      const bad = run(bin('tsc'), ['-p', 'tsconfig.json', '--noEmit'], sb.dir);
      expect(bad.status).not.toBe(0);
      expect(bad.output).toContain('TS2322');
    } finally { sb.dispose(); }
  });

  it('fails package-boundary checks on forbidden imports and passes the clean control', () => {
    const sb = makeSandbox();
    try {
      sb.write('packages/contracts/package.json', contractsManifest);
      sb.write('packages/contracts/src/index.ts', 'export const x = 1;\n');
      sb.write('packages/domain/package.json', domainManifest);
      sb.write('packages/domain/src/index.ts', `import { x } from '@factory/contracts';\nexport const y = x;\n`);
      sb.write('apps/worker/package.json', JSON.stringify({ name: '@factory/worker', private: true, dependencies: { '@factory/domain': 'workspace:*' } }));
      sb.write('apps/worker/src/workflows/task.ts', `import { proxyActivities } from '@temporalio/workflow';\nexport const p = proxyActivities;\n`);
      expect(checkBoundaries(sb.dir)).toEqual([]);
      sb.write('packages/domain/src/index.ts', [
        `import { Pool } from 'pg';`,
        `import { readFileSync } from 'fs';`,
        `import { worker } from '@factory/worker';`,
        `import { secret } from '../../contracts/src/index.ts';`,
        `export const y = [Pool, readFileSync, worker, secret];`,
      ].join('\n'));
      sb.write('apps/worker/src/workflows/task.ts', `import { Client } from 'pg';\nexport const p = Client;\n`);
      sb.write('apps/worker/src/workflows/sneaky.ts', [
        `import{Pool}from'pg';`,
        `/*c*/import fs from 'node:fs';`,
        `export * as cp from 'node:child_process';`,
        `export{x}from'fastify';`,
        `import a from './../activities/io.ts';`,
        `import b from './../../src/activities/io.ts';`,
        'const m = await import(`pg`);',
        `const name = 'pg'; const n = await import(name);`,
        `export const all = [Pool, fs, a, b, m, n];`,
      ].join('\n'));
      const violations = checkBoundaries(sb.dir);
      expect(violations).toEqual(expect.arrayContaining([
        expect.stringContaining('imports denied module pg'),
        expect.stringContaining('imports denied module fs'),
        expect.stringContaining('imports app @factory/worker'),
        expect.stringContaining('escapes the package root'),
        expect.stringContaining('outside the allow-list for src/workflows/'),
      ]));
      const sneaky = violations.filter((v) => v.includes('workflows/sneaky.ts'));
      for (const line of [1, 2, 3, 4, 5, 6, 7, 8]) expect(sneaky.some((v) => v.includes(`sneaky.ts:${String(line)}:`)), `line ${String(line)}: ${sneaky.join(' | ')}`).toBe(true);
      expect(sneaky.some((v) => v.includes('not a string literal'))).toBe(true);
      const cli = run('node', [join(repoRoot, 'tools', 'check-boundaries.ts'), sb.dir], sb.dir);
      expect(cli.status).toBe(1);
    } finally { sb.dispose(); }
  });

  it('CI runs the frozen install, lint, typecheck, tests and the contract-generation check on the pinned runtime', () => {
    const ci = readFileSync(join(repoRoot, 'scripts', 'ci.sh'), 'utf8');
    const steps = ci.split('\n').filter((l) => l.startsWith('pnpm '));
    expect(steps).toEqual(['pnpm install --frozen-lockfile', 'pnpm lint', 'pnpm typecheck', 'pnpm test', 'pnpm contracts:check']);
    const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(workflow).toContain('node-version-file: .node-version');
    expect(workflow).toContain('sh scripts/ci.sh');
    expect(workflow).toMatch(/postgres:18\.\d+@sha256:[0-9a-f]{64}/);
  });

  it('the repository itself passes its boundary rules', () => {
    expect(checkBoundaries(repoRoot)).toEqual([]);
  });
});
