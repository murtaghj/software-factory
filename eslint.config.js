// ESLint flat config (W-002). Type-aware strict rules over all workspace TypeScript.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const SUPERVISOR_PID = [{ selector: "CallExpression[callee.object.name='process'][callee.property.name='kill'] > UnaryExpression[operator='-']", message: 'W-019: a negative pid belongs to group.ts alone (process.kill(-1) would reach every process of the session)' }];
const SUPERVISOR_FS = [
  { selector: "ImportExpression[source.value=/^(node:)?(fs|module)(\\/.*)?$/]", message: 'W-019: a dynamic import of node:fs belongs to workspace-view.ts and token-file.ts alone' },
  { selector: "CallExpression[callee.name='createRequire']", message: 'W-019: createRequire would reach node:fs around the import rule' },
  { selector: "CallExpression[callee.name='require']", message: 'W-019: no require() in the supervisor' },
];

// W-020a: the untrusted-Git reader runs no program and opens a file only through fs-safe.ts (7.3 "File access", 7.7). Its imports are an allowlist:
// its own files, the node modules below, and the three fs-free modules of the package it needs. A new import has to be added here on purpose.
const READER_ALLOWED = [/^\.\/[\w-]+\.ts$/, /^\.\.\/(errors|tree-digest|containment|checkpoint-manifest)\.ts$/, /^node:(crypto|zlib|path)$/, /^@factory\/(domain|contracts)$/];
const readerPlugin = {
  rules: {
    'allowlist': {
      meta: { type: 'problem', schema: [{ type: 'object', properties: { extra: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }] },
      create(context) {
        const extra = (context.options[0]?.extra ?? []);
        const check = (node) => {
          if (node.source === null || node.source === undefined) return;
          const value = String(node.source.value);
          if (READER_ALLOWED.some((re) => re.test(value)) || extra.includes(value)) return;
          context.report({ node, message: `W-020a: the reader may import only its own files, ../errors.ts, ../tree-digest.ts, ../containment.ts, ../checkpoint-manifest.ts, node:crypto, node:zlib, node:path (fs-safe.ts also node:fs), @factory/domain and @factory/contracts; "${value}" is none of them` });
        };
        return { ImportDeclaration: check, ExportNamedDeclaration: check, ExportAllDeclaration: check };
      },
    },
  },
};
const READER_DOORS = [
  { selector: 'ImportExpression', message: 'W-020a: no dynamic import in the reader (it would reach node:fs or child_process around the import rule)' },
  { selector: "CallExpression[callee.name='createRequire']", message: 'W-020a: createRequire would reach node:fs around the import rule' },
  { selector: "CallExpression[callee.name='require']", message: 'W-020a: no require() in the reader' },
  { selector: "CallExpression[callee.property.name='getBuiltinModule']", message: 'W-020a: process.getBuiltinModule would reach node:fs around the import rule' },
  { selector: "Identifier[name='process']", message: 'W-020a: the reader does not touch `process` (getBuiltinModule, binding and dlopen are all reached through it, and a computed name hides them)' },
  { selector: "Identifier[name='globalThis']", message: 'W-020a: the reader does not reach for `globalThis` (process is a property of it)' },
  { selector: "Identifier[name='global']", message: 'W-020a: `global` is `globalThis` in Node, and process is a property of it' },
  { selector: "Identifier[name='eval']", message: 'W-020a: no eval, direct or aliased' },
  { selector: "MemberExpression[property.name='constructor']", message: 'W-020a: no `.constructor`: `({}).constructor.constructor(\'return process\')()` is Function' },
  { selector: "MemberExpression[property.value='constructor']", message: 'W-020a: no [\'constructor\']: it reaches Function' },
  { selector: "Identifier[name='Function']", message: 'W-020a: no `Function`, aliased or not: it compiles code from a string' },
  { selector: "Property[key.name='constructor']", message: 'W-020a: no destructured `constructor`' },
  { selector: "Literal[value='constructor']", message: "W-020a: no 'constructor' as a name: it reaches Function" },
  { selector: 'TemplateElement[value.raw=/constructor|process/]', message: 'W-020a: no template text naming `constructor` or `process` (a tagged template builds a name)' },
  { selector: 'Identifier[name=/^(getOwnPropertyDescriptors?|getPrototypeOf)$/]', message: 'W-020a: no property descriptors and no prototype walks: they reach `constructor` without naming it' },
  { selector: "Identifier[name='Reflect']", message: 'W-020a: no Reflect in the reader (Reflect.get reaches any property by a computed name)' },
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
    // W-020a: the reader's imports are an allowlist (node:fs only in fs-safe.ts), and it has no side door to a built-in module.
    files: ['packages/workspace/src/git-reader/**/*.ts'],
    plugins: { w020: readerPlugin },
    rules: { 'w020/allowlist': 'error', 'no-restricted-syntax': ['error', ...READER_DOORS], 'no-eval': ['error', { allowIndirect: false }], 'no-implied-eval': 'error', 'no-new-func': 'error', '@typescript-eslint/no-implied-eval': 'error' },
  },
  {
    files: ['packages/workspace/src/git-reader/fs-safe.ts'],
    rules: { 'w020/allowlist': ['error', { extra: ['node:fs'] }] },
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
