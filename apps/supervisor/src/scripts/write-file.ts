// Writes a file into the checkout (work/main of the one generation it finds), then exits 0.
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env['FACTORY_WORKSPACE'] ?? '/workspace/factory';
const main = ((): string | undefined => {
  for (const org of readdirSync(root)) for (const ws of readdirSync(join(root, org))) for (const g of readdirSync(join(root, org, ws))) {
    if (g.startsWith('g')) return join(root, org, ws, g, 'work', 'main');
  }
  return undefined;
})();
if (main === undefined) { process.stderr.write('no checkout found\n'); process.exit(2); }
writeFileSync(join(main, 'harness-was-here'), 'written by the scripted harness\n');
process.exit(0);
