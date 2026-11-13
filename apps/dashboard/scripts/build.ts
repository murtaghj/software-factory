// Builds the dashboard into a static directory: `node apps/dashboard/scripts/build.ts <outDir>`.
// The output is index.html plus hashed assets; config.json is supplied by whoever serves it.
import { resolve } from 'node:path';
import { build } from 'vite';

const outDir = process.argv[2];
if (!outDir) { process.stderr.write('usage: build.ts <outDir>\n'); process.exit(2); }
await build({
  root: resolve(import.meta.dirname, '..'),
  configFile: false,
  logLevel: 'warn',
  base: './',
  oxc: { jsx: { runtime: 'automatic' } },
  build: { outDir: resolve(outDir), emptyOutDir: true, target: 'es2022', sourcemap: false },
});
