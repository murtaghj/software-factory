// Starts an isolated fixture environment for one pinned release: a fresh PostgreSQL database with
// the release schema and seed data, inventory and orders services, the event worker and the web
// storefront client. Every request carries W3C trace context into the shared collector.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { adminUrl, createIsolatedDatabase, serverVersion, type IsolatedDatabase } from '@factory/test-support';
import { computePins, fixtureSrcDir, release, type ReleaseDefinition, type ReleasePins } from './releases/releases.ts';
import { inventoryVariant, ordersVariant } from './releases/variants.ts';
import { TraceCollector } from './system/tracing.ts';
import type { FaultConfig, ServiceDeps } from './system/deps.ts';
import { startInventory } from './system/inventory/service.ts';
import { startOrders } from './system/orders/service.ts';
import { createEventWorker, type EventWorker } from './system/worker/event-worker.ts';
import { createStorefront, type Storefront } from './system/web/storefront.ts';

export const FIXTURE_RUNNER = { framework: 'fixture-test-runner', frameworkVersion: '1.0.0' } as const;

export type EnvironmentFingerprint = {
  releaseId: string;
  sourceDigest: string;
  // Equivalence inputs: identical for comparable environments (chapter 09 red/lock/green).
  equivalence: { postgresServerVersion: string; schemaDigest: string; seedDigest: string; contractsDigest: string; faultsDigest: string; runner: string };
};

export type FixtureEnvironment = {
  release: ReleaseDefinition;
  pins: ReleasePins;
  fingerprint: EnvironmentFingerprint;
  ordersUrl: string;
  inventoryUrl: string;
  storefront: Storefront;
  worker: EventWorker;
  collector: TraceCollector;
  pool: pg.Pool;
  // Fault injection for infrastructure-failure scenarios: refuse and drop all database connections.
  makeDatabaseUnavailable: () => Promise<void>;
  stop: () => Promise<void>;
};

export function faultsDigest(faults: Record<string, boolean | undefined>): string {
  const enabled = Object.keys(faults).filter((k) => faults[k] === true).sort();
  return createHash('sha256').update(JSON.stringify(enabled)).digest('hex');
}

export async function startEnvironment(releaseId: string, options: { faults?: FaultConfig; databaseUrl?: string } = {}): Promise<FixtureEnvironment> {
  const def = release(releaseId);
  const pins = computePins(def);
  const faults = options.faults ?? {};
  let db: IsolatedDatabase | undefined;
  const url = options.databaseUrl ?? (db = await createIsolatedDatabase('fixture')).url;
  const pool = new pg.Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 2000 });
  pool.on('error', () => undefined); // idle clients killed by an injected outage must not crash the process
  const cleanup: Array<() => Promise<void>> = [];
  try {
    for (const file of def.schema) await pool.query(readFileSync(join(fixtureSrcDir, file), 'utf8'));
    const seed = JSON.parse(readFileSync(join(fixtureSrcDir, def.seed), 'utf8')) as { stock: Array<{ sku: string; available: number }> };
    for (const s of seed.stock) await pool.query('INSERT INTO stock (sku, available) VALUES ($1, $2)', [s.sku, s.available]);
    const collector = new TraceCollector();
    const deps: ServiceDeps = { pool, collector, faults };
    const inventory = await startInventory(deps, inventoryVariant(def));
    cleanup.push(inventory.close);
    const orders = await startOrders(deps, inventory.url, ordersVariant(def));
    cleanup.push(orders.close);
    const fingerprint: EnvironmentFingerprint = {
      releaseId: def.id,
      sourceDigest: pins.sourceDigest,
      equivalence: {
        postgresServerVersion: await serverVersion(url),
        schemaDigest: pins.schemaDigest,
        seedDigest: pins.seedDigest,
        contractsDigest: pins.contractsDigest,
        faultsDigest: faultsDigest(faults),
        runner: `${FIXTURE_RUNNER.framework}@${FIXTURE_RUNNER.frameworkVersion}`,
      },
    };
    return {
      release: def, pins, fingerprint, ordersUrl: orders.url, inventoryUrl: inventory.url,
      storefront: createStorefront(orders.url, collector), worker: createEventWorker(deps), collector, pool,
      makeDatabaseUnavailable: async () => {
        const name = new URL(url).pathname.slice(1);
        const admin = new pg.Client({ connectionString: adminUrl() });
        await admin.connect();
        try {
          await admin.query(`ALTER DATABASE ${name} WITH ALLOW_CONNECTIONS false`);
          await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
        } finally {
          await admin.end();
        }
      },
      stop: async () => {
        for (const c of cleanup.reverse()) await c();
        await pool.end().catch(() => undefined);
        if (db) await db.drop();
      },
    };
  } catch (e) {
    for (const c of cleanup.reverse()) await c();
    await pool.end();
    if (db) await db.drop();
    throw e;
  }
}
