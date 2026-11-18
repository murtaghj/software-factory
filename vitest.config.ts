import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'apps/*/test/**/*.test.tsx', 'tests/**/*.test.ts', 'tests/**/*.test.tsx', 'fixtures/test/**/*.test.ts', 'tools/test/**/*.test.ts'],
    // The k3s tier (W-017, 17b) runs only through `pnpm test:k8s`: a missing cluster there is a failure, so it must never be selected here.
    exclude: [...configDefaults.exclude, '**/*.k8s.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: true,
    // Each integration file starts its own Temporal dev server and Postgres database. More than three
    // at once starves a 6-core laptop: servers miss their 5 s start window and waits time out.
    maxWorkers: 3,
    allowOnly: false,
    passWithNoTests: false,
  },
});
