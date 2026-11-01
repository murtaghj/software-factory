import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'apps/*/test/**/*.test.tsx', 'tests/**/*.test.ts', 'fixtures/test/**/*.test.ts', 'tools/test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: true,
    allowOnly: false,
    passWithNoTests: false,
  },
});
