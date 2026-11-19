// ESLint flat config (W-002). Type-aware strict rules over all workspace TypeScript.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const SUPERVISOR_PID = [{ selector: "CallExpression[callee.object.name='process'][callee.property.name='kill'] > UnaryExpression[operator='-']", message: 'W-019: a negative pid belongs to group.ts alone (process.kill(-1) would reach every process of the session)' }];
const SUPERVISOR_FS = [
  { selector: "ImportExpression[source.value=/^(node:)?(fs|module)(\\/.*)?$/]", message: 'W-019: a dynamic import of node:fs belongs to workspace-view.ts and token-file.ts alone' },
  { selector: "CallExpression[callee.name='createRequire']", message: 'W-019: createRequire would reach node:fs around the import rule' },
  { selector: "CallExpression[callee.name='require']", message: 'W-019: no require() in the supervisor' },
];

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
    // W-019 (the supervisor): no Date.now (the fence is judged on the monotonic clock), no negative pid outside the one group-kill helper, and `node:fs` only in the
    // workspace view (the one place that reads a workspace path), the token file reader, and the scripted harness (src/scripts): static imports, dynamic `import()` and `createRequire` alike.
    files: ['apps/supervisor/src/**/*.ts'],
    rules: {
      'no-restricted-properties': ['error', { object: 'Date', property: 'now', message: 'W-019: the supervisor judges time on the monotonic clock' }],
      'no-restricted-syntax': ['error', ...SUPERVISOR_PID, ...SUPERVISOR_FS],
      'no-restricted-imports': ['error', { patterns: [{ group: ['node:fs', 'node:fs/*', 'fs', 'fs/*', 'node:module', 'module'], message: 'W-019: node:fs (and createRequire) only in workspace-view.ts and token-file.ts (and src/scripts)' }] }],
    },
  },
  { files: ['apps/supervisor/src/workspace-view.ts', 'apps/supervisor/src/token-file.ts', 'apps/supervisor/src/scripts/**/*.ts'], rules: { 'no-restricted-imports': 'off', 'no-restricted-syntax': ['error', ...SUPERVISOR_PID] } },
  { files: ['apps/supervisor/src/group.ts'], rules: { 'no-restricted-syntax': ['error', ...SUPERVISOR_FS] } },
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
