import { describe, expect, it } from 'vitest';
import { attributeBoundaryFault, startEnvironment } from '../src/index.ts';

async function placeOn(releaseId: string, faults = {}) {
  const env = await startEnvironment(releaseId, { faults });
  try {
    const r = await env.storefront.placeOrder('cust-alice', [{ sku: 'SKU-RED-1', quantity: 2 }]);
    return { status: r.status, spans: env.collector.trace(r.traceId) };
  } finally {
    await env.stop();
  }
}

describe('AC-32 wrong service blamed', () => {
  it('invalid upstream input: inventory is the last erroring API, but the evidence blames orders', async () => {
    const { status, spans } = await placeOn('orders-3.0.0');
    expect(status).toBe(502);
    const inventory = spans.find((s) => s.service === 'inventory' && s.kind === 'server');
    expect(inventory?.status).toBe('error');
    expect(inventory?.httpStatus).toBe(500);
    const diagnosis = attributeBoundaryFault(spans);
    expect(diagnosis.lastErroringService).toBe('inventory');
    expect(diagnosis.affectedComponents).toEqual(['orders']);
    const boundary = diagnosis.evidence.find((e) => e.caller === 'orders' && e.callee === 'inventory');
    expect(boundary?.violations).toEqual(expect.arrayContaining(["/ must have required property 'quantity'", '/ must NOT have additional properties']));
    expect(diagnosis.gaps).toEqual([]);
  });

  it('control: the same journey on the known-good release has contract-valid boundaries and no fault', async () => {
    const { status, spans } = await placeOn('orders-1.0.0');
    expect(status).toBe(201);
    const diagnosis = attributeBoundaryFault(spans);
    expect(diagnosis.affectedComponents).toEqual([]);
    expect(diagnosis.evidence.every((e) => e.violations.length === 0)).toBe(true);
  });

  it('control: when inventory fails on a contract-valid request, the evidence blames inventory', async () => {
    const { status, spans } = await placeOn('orders-1.0.0', { inventoryFailOnValidInput: true });
    expect(status).toBe(502);
    const diagnosis = attributeBoundaryFault(spans);
    expect(diagnosis.lastErroringService).toBe('inventory');
    expect(diagnosis.affectedComponents).toEqual(['inventory']);
  });
});
