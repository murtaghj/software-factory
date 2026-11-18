import { defineConfig } from 'vitest/config';

// The k3s tier (W-017, 17b): opt-in, `pnpm test:k8s`. One worker, one file at a time, never beside the full suite.
// The default configuration excludes these files, so `pnpm test` and `pnpm check` never run them.
export default defineConfig({
  test: {
    include: ['apps/*/test/**/*.k8s.test.ts', 'tests/**/*.k8s.test.ts'],
    globalSetup: ['./apps/runner/test/k8s/global-setup.ts'],
    testTimeout: 240_000,
    hookTimeout: 240_000,
    fileParallelism: false,
    maxWorkers: 1,
    allowOnly: false,
    passWithNoTests: false,
  },
});
