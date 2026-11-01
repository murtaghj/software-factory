// ESLint flat config (W-002). Type-aware strict rules over all workspace TypeScript.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'docs/**', 'tools/test-fixtures/**', '**/*.generated.ts', '**/generated/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ['eslint.config.js'] }, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'off',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['apps/worker/src/workflows/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error',
        { name: 'Date', message: 'INV-01: use workflow-safe time from @temporalio/workflow' },
        { name: 'setTimeout', message: 'INV-01: use sleep() from @temporalio/workflow' },
        { name: 'fetch', message: 'INV-01: I/O belongs in Activities' },
        { name: 'process', message: 'INV-01: no process APIs in workflow code' }],
      'no-restricted-properties': ['error', { object: 'Math', property: 'random', message: 'INV-01: deterministic workflow code' },
        { object: 'crypto', property: 'randomUUID', message: 'INV-01: use uuid4() from @temporalio/workflow' }],
    },
  },
);
