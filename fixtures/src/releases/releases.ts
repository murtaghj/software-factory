// Fixture releases (W-004). Each release pins the exact source files of its component variants,
// its schema, seed data and service contracts. releases.lock.json records the digests; the
// fixture suite fails if any pinned input changes without re-pinning (node fixtures/scripts/pin-releases.ts).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const fixtureSrcDir = join(import.meta.dirname, '..');

export type ReleaseKind = 'known_good' | 'faulty' | 'candidate_fix' | 'feature_candidate' | 'faulty_feature_candidate';
export type ReleaseDefinition = {
  id: string;
  kind: ReleaseKind;
  description: string;
  components: {
    ordersClient: 'standard' | 'qty-field';
    ordersCancel: 'none' | 'complete' | 'happy-path';
    inventoryReserve: 'idempotent' | 'non-idempotent';
  };
  schema: string[];
  seed: string;
  contracts: string[];
  knownDefects: string[];
};

const COMMON_SOURCE = ['system/http.ts', 'system/tracing.ts', 'system/deps.ts', 'system/orders/service.ts', 'system/inventory/service.ts', 'system/worker/event-worker.ts', 'system/web/storefront.ts'];
const VARIANT_SOURCE = {
  ordersClient: { standard: ['system/orders/inventory-client.ts'], 'qty-field': ['system/orders/inventory-client.ts', 'system/orders/inventory-client.qty-field.ts'] },
  ordersCancel: { none: [], complete: ['system/orders/cancel.complete.ts'], 'happy-path': ['system/orders/cancel.happy-path.ts'] },
  inventoryReserve: { idempotent: ['system/inventory/reserve.idempotent.ts'], 'non-idempotent': ['system/inventory/reserve.idempotent.ts', 'system/inventory/reserve.non-idempotent.ts'] },
} as const;
const CONTRACTS = ['contracts/inventory-http-v1.schema.json', 'contracts/orders-http-v1.schema.json'];

export const RELEASES: Record<string, ReleaseDefinition> = {
  'orders-1.0.0': { id: 'orders-1.0.0', kind: 'known_good', description: 'Known-good baseline: idempotent reservations, no cancellation feature.', components: { ordersClient: 'standard', ordersCancel: 'none', inventoryReserve: 'idempotent' }, schema: ['system/schema-v1.sql'], seed: 'seed/seed-v1.json', contracts: CONTRACTS, knownDefects: [] },
  'orders-1.1.0': { id: 'orders-1.1.0', kind: 'faulty', description: 'Regression: inventory reservation lost idempotency; a retry after a dropped response reserves twice.', components: { ordersClient: 'standard', ordersCancel: 'none', inventoryReserve: 'non-idempotent' }, schema: ['system/schema-v1.sql'], seed: 'seed/seed-v1.json', contracts: CONTRACTS, knownDefects: ['duplicate-reservation'] },
  'orders-1.1.1': { id: 'orders-1.1.1', kind: 'candidate_fix', description: 'Candidate repair for orders-1.1.0: reservation deduplicates on idempotency key again.', components: { ordersClient: 'standard', ordersCancel: 'none', inventoryReserve: 'idempotent' }, schema: ['system/schema-v1.sql'], seed: 'seed/seed-v1.json', contracts: CONTRACTS, knownDefects: [] },
  'orders-2.0.0': { id: 'orders-2.0.0', kind: 'feature_candidate', description: 'Cancellation with authorization, idempotent repeat and audit history.', components: { ordersClient: 'standard', ordersCancel: 'complete', inventoryReserve: 'idempotent' }, schema: ['system/schema-v1.sql', 'system/schema-v2.sql'], seed: 'seed/seed-v1.json', contracts: CONTRACTS, knownDefects: [] },
  'orders-2.0.0-happy-path': { id: 'orders-2.0.0-happy-path', kind: 'faulty_feature_candidate', description: 'Cancellation happy path only: no ownership check; repeat cancels re-release and re-audit.', components: { ordersClient: 'standard', ordersCancel: 'happy-path', inventoryReserve: 'idempotent' }, schema: ['system/schema-v1.sql', 'system/schema-v2.sql'], seed: 'seed/seed-v1.json', contracts: CONTRACTS, knownDefects: ['cancel-without-authorization', 'repeated-cancel-not-idempotent'] },
  'orders-3.0.0': { id: 'orders-3.0.0', kind: 'faulty', description: 'Orders sends `qty` instead of `quantity`; inventory fails with 500 on the invalid request.', components: { ordersClient: 'qty-field', ordersCancel: 'none', inventoryReserve: 'idempotent' }, schema: ['system/schema-v1.sql'], seed: 'seed/seed-v1.json', contracts: CONTRACTS, knownDefects: ['upstream-invalid-reservation-request'] },
};

const fileDigest = (rel: string): string => createHash('sha256').update(readFileSync(join(fixtureSrcDir, rel))).digest('hex');

export function digestFiles(files: readonly string[]): string {
  const h = createHash('sha256');
  for (const f of [...new Set(files)].sort()) h.update(`${f}\0${fileDigest(f)}\n`);
  return h.digest('hex');
}

export type ReleasePins = { sourceDigest: string; schemaDigest: string; seedDigest: string; contractsDigest: string; sourceFiles: string[] };

export function releaseSourceFiles(def: ReleaseDefinition): string[] {
  const c = def.components;
  return [...new Set([...COMMON_SOURCE, ...VARIANT_SOURCE.ordersClient[c.ordersClient], ...VARIANT_SOURCE.ordersCancel[c.ordersCancel], ...VARIANT_SOURCE.inventoryReserve[c.inventoryReserve]])].sort();
}

export function computePins(def: ReleaseDefinition): ReleasePins {
  const sourceFiles = releaseSourceFiles(def);
  return { sourceDigest: digestFiles(sourceFiles), schemaDigest: digestFiles(def.schema), seedDigest: digestFiles([def.seed]), contractsDigest: digestFiles(def.contracts), sourceFiles };
}

export function release(id: string): ReleaseDefinition {
  const def = RELEASES[id];
  if (!def) throw new Error(`unknown fixture release ${id}`);
  return def;
}
