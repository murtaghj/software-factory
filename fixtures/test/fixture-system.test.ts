import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RELEASES, computePins, packageDigest, packagesDir, startEnvironment } from '../src/index.ts';

const lock = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'src', 'releases', 'releases.lock.json'), 'utf8')) as {
  releases: Record<string, { sourceDigest: string; schemaDigest: string; seedDigest: string; contractsDigest: string }>;
  packages: Record<string, string>;
};

describe('W-004 representative fixture system', () => {
  it('every release and canonical test package matches its pinned digests', () => {
    expect(Object.keys(lock.releases).sort()).toEqual(Object.keys(RELEASES).sort());
    for (const r of Object.values(RELEASES)) expect(computePins(r), r.id).toMatchObject(lock.releases[r.id] ?? {});
    for (const p of readdirSync(packagesDir)) expect(packageDigest(join(packagesDir, p)), p).toBe(lock.packages[p]);
  });

  it('known-good, faulty and fixed releases differ in source but share schema, seed data and contracts', () => {
    const [good, faulty, fixed] = ['orders-1.0.0', 'orders-1.1.0', 'orders-1.1.1'].map((id) => lock.releases[id]);
    expect(faulty?.sourceDigest).not.toBe(good?.sourceDigest);
    expect(fixed?.sourceDigest).not.toBe(faulty?.sourceDigest);
    for (const k of ['schemaDigest', 'seedDigest', 'contractsDigest'] as const) {
      expect(faulty?.[k]).toBe(good?.[k]);
      expect(fixed?.[k]).toBe(faulty?.[k]);
    }
  });

  it('a placed order flows web → orders → inventory → event worker on one propagated trace with seeded data', async () => {
    const env = await startEnvironment('orders-1.0.0');
    try {
      const placed = await env.storefront.placeOrder('cust-alice', [{ sku: 'SKU-RED-1', quantity: 4 }]);
      expect(placed.status).toBe(201);
      const orderId = (placed.body as { orderId: string }).orderId;
      expect((await env.pool.query<{ available: number }>("SELECT available FROM stock WHERE sku = 'SKU-RED-1'")).rows[0]?.available).toBe(16);
      expect(await env.worker.drain()).toBe(1);
      expect(await env.worker.drain()).toBe(0);
      const spans = env.collector.trace(placed.traceId);
      expect(new Set(spans.map((s) => s.traceId))).toEqual(new Set([placed.traceId]));
      const byService = (svc: string) => spans.filter((s) => s.service === svc);
      const web = byService('web')[0];
      const ordersServer = byService('orders').find((s) => s.kind === 'server');
      const inventoryServer = byService('inventory').find((s) => s.kind === 'server');
      const consumer = byService('event-worker')[0];
      expect(web?.parentSpanId).toBeUndefined();
      expect(ordersServer?.parentSpanId).toBe(web?.spanId);
      const reserveClient = byService('orders').find((s) => s.kind === 'client');
      expect(reserveClient?.parentSpanId).toBe(ordersServer?.spanId);
      expect(inventoryServer?.parentSpanId).toBe(reserveClient?.spanId);
      expect(consumer?.parentSpanId).toBe(ordersServer?.spanId);
      const view = await env.storefront.viewOrder('cust-alice', orderId);
      expect(view.body).toMatchObject({ orderId, status: 'reserved', items: [{ sku: 'SKU-RED-1', quantity: 4 }] });
      expect((await env.storefront.viewOrder('cust-bob', orderId)).status).toBe(404);
      expect(env.fingerprint.equivalence.postgresServerVersion).toMatch(/^18\./);
    } finally {
      await env.stop();
    }
  });
});
