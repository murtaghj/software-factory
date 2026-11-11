import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'apps/*/test/**/*.test.tsx', 'tests/**/*.test.ts', 'fixtures/test/**/*.test.ts', 'tools/test/**/*.test.ts'],
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
