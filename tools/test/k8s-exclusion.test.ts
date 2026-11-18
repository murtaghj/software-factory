// W-017 (17b): the k3s tier never runs by accident, and a missing cluster is a failure, never a skip.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './workspace-sandbox.ts';

const k8sFilesOnDisk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  if (n === 'node_modules' || n === '.git' || n === '.k3s') return [];
  const p = join(dir, n);
  return statSync(p).isDirectory() ? k8sFilesOnDisk(p) : n.endsWith('.k8s.test.ts') ? [p.slice(repoRoot.length + 1)] : [];
});
const vitest = (args: string[], env: Record<string, string> = {}): { status: number | null; out: string } => {
  const r = spawnSync(join(repoRoot, 'node_modules', '.bin', 'vitest'), args, { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

describe('W-017 k3s tier opt-in', () => {
  it('the default configuration selects no *.k8s.test.ts file while at least two exist on disk; the k8s configuration selects exactly them', () => {
    const onDisk = k8sFilesOnDisk(repoRoot).sort();
    expect(onDisk.length).toBeGreaterThanOrEqual(2);
    const selectedByDefault = vitest(['list', '--filesOnly']).out.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.test.ts'));
    expect(selectedByDefault.length).toBeGreaterThan(50);                       // control: the listing works and finds the ordinary files
    expect(selectedByDefault.filter((f) => f.endsWith('.k8s.test.ts'))).toEqual([]);
    const selectedByK8s = vitest(['list', '--filesOnly', '--config', 'vitest.k8s.config.ts']).out.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.test.ts')).sort();
    expect(selectedByK8s).toEqual(onDisk);
  });

  it('a missing cluster fails the k3s run with one line; it is never a skip', () => {
    const missing = vitest(['run', '--config', 'vitest.k8s.config.ts'], { FACTORY_K3S_ENV: join(tmpdir(), 'no-such-k3s-env') });
    expect(missing.status).not.toBe(0);
    expect(missing.out).toContain('a missing cluster is a failure, not a skip');
    expect(missing.out).not.toMatch(/skipped/);
    // An environment file that names a cluster nobody answers at.
    const dir = mkdtempSync(join(tmpdir(), 'k3s-env-'));
    try {
      for (const f of ['ca.crt', 'admin.crt', 'admin.key', 'runner.token']) writeFileSync(join(dir, f), 'x');
      const env = join(dir, 'env');
      writeFileSync(env, [`FACTORY_K3S_SERVER=https://127.0.0.1:1`, `FACTORY_K3S_CA_FILE=${dir}/ca.crt`, `FACTORY_K3S_ADMIN_CERT_FILE=${dir}/admin.crt`, `FACTORY_K3S_ADMIN_KEY_FILE=${dir}/admin.key`,
        `FACTORY_K3S_RUNNER_TOKEN_FILE=${dir}/runner.token`, 'FACTORY_K3S_NAMESPACE=factory-exec-local', `FACTORY_K3S_FIXTURE_COMMIT=${'c'.repeat(40)}`, `FACTORY_K3S_IMAGE_DIGEST=sha256:${'d'.repeat(64)}`].join('\n'));
      const down = vitest(['run', '--config', 'vitest.k8s.config.ts'], { FACTORY_K3S_ENV: env });
      expect(down.status).not.toBe(0);
      expect(down.out).toMatch(/does not answer|ENOENT|error/i);
      expect(down.out).not.toMatch(/skipped/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
