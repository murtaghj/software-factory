// Re-pins fixture releases: writes fixtures/src/releases/releases.lock.json from current sources.
// Run after a deliberate fixture change; the fixture suite fails while the lock is stale.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RELEASES, computePins, fixtureSrcDir } from '../src/releases/releases.ts';
import { packageDigest, packagesDir } from '../src/runner/runner.ts';
import { readdirSync } from 'node:fs';

const lock = {
  releases: Object.fromEntries(Object.values(RELEASES).map((r) => [r.id, computePins(r)])),
  packages: Object.fromEntries(readdirSync(packagesDir).sort().map((p) => [p, packageDigest(join(packagesDir, p))])),
};
writeFileSync(join(fixtureSrcDir, 'releases', 'releases.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
console.log(`pinned ${String(Object.keys(lock.releases).length)} releases and ${String(Object.keys(lock.packages).length)} test packages`);
