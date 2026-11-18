// ESLint flat config (W-002). Type-aware strict rules over all workspace TypeScript.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'docs/**', '.k3s/**', 'deploy/**', 'tools/test-fixtures/**', '**/*.generated.ts', '**/generated/**'] },
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
    // W-017: every age and deadline is computed in SQL on clock_timestamp(); and nothing may ask Kubernetes for a
    // grace period of its own (a force delete, grace 0, removes the pod object while its processes still run).
    files: ['apps/runner/src/**/*.ts'],
    rules: {
      'no-restricted-properties': ['error', { object: 'Date', property: 'now', message: 'W-017: judge time in SQL on clock_timestamp(), not in controller code' }],
      'no-restricted-syntax': ['error',
        { selector: "Property[key.name='gracePeriodSeconds']", message: 'W-017: only the HTTPS client sends a grace period, and it is always 15 s' },
        { selector: "Literal[value='gracePeriodSeconds']", message: 'W-017: only the HTTPS client sends a grace period, and it is always 15 s' }],
    },
  },
  { files: ['apps/runner/src/kube/https-client.ts'], rules: { 'no-restricted-syntax': 'off' } },
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
