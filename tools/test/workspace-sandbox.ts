// Builds throwaway mini-workspaces that reuse the repository's toolchain so a test can
// prove that lint, typecheck and boundary checks reject a seeded violation (AC-260).
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

export const repoRoot = join(import.meta.dirname, '..', '..');

export type Sandbox = { dir: string; write: (path: string, text: string) => void; dispose: () => void };

export function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'factory-ac260-'));
  for (const f of ['tsconfig.base.json', 'eslint.config.js']) copyFileSync(join(repoRoot, f), join(dir, f));
  symlinkSync(join(repoRoot, 'node_modules'), join(dir, 'node_modules'));
  mkdirSync(join(dir, 'tools'));
  copyFileSync(join(repoRoot, 'tools', 'boundaries.json'), join(dir, 'tools', 'boundaries.json'));
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  write('tsconfig.json', JSON.stringify({ extends: './tsconfig.base.json', include: ['packages/*/src/**/*.ts'] }));
  write('package.json', JSON.stringify({ name: 'sandbox', private: true, type: 'module' }));
  return { dir, write, dispose: () => { rmSync(dir, { recursive: true, force: true }); } };
}

export type RunResult = { status: number | null; output: string };

export function run(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}): RunResult {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 300_000 });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

export const bin = (name: string): string => join(repoRoot, 'node_modules', '.bin', name);
