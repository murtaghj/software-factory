// The API a canonical test package sees. Packages receive it by injection (they import nothing at
// runtime), so a package directory can be copied, digested and executed on its own.
import type { FixtureEnvironment } from '../environment.ts';

export class AssertionFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionFailure';
  }
}

export type Scenario = { id: string; title: string; criterionIds: string[]; run: () => Promise<void> };

export type TestKit = {
  env: FixtureEnvironment;
  expectEqual: (label: string, expected: unknown, observed: unknown) => void;
  fail: (message: string) => never;
  reservations: (orderId: string) => Promise<Array<{ sku: string; quantity: number; released: boolean }>>;
  stock: (sku: string) => Promise<number>;
  fulfillments: (orderId: string) => Promise<number>;
};

export type PackageManifest = {
  id: string;
  version: string;
  framework: string;
  frameworkVersion: string;
  criteria: Record<string, string>;
  environment: { faults: Record<string, boolean> };
};

export type PackageModule = { default: (t: TestKit) => Scenario[] };

export function createKit(env: FixtureEnvironment): TestKit {
  const fail = (message: string): never => { throw new AssertionFailure(message); };
  return {
    env,
    fail,
    expectEqual: (label, expected, observed) => {
      if (JSON.stringify(expected) !== JSON.stringify(observed)) fail(`expected ${label} ${JSON.stringify(expected)}; observed ${JSON.stringify(observed)}`);
    },
    reservations: async (orderId) => (await env.pool.query<{ sku: string; quantity: number; released: boolean }>('SELECT sku, quantity, released FROM reservations WHERE order_id = $1 ORDER BY id', [orderId])).rows,
    stock: async (sku) => (await env.pool.query<{ available: number }>('SELECT available FROM stock WHERE sku = $1', [sku])).rows[0]?.available ?? -1,
    fulfillments: async (orderId) => Number((await env.pool.query<{ n: string }>('SELECT count(*) AS n FROM fulfillment_requests WHERE order_id = $1', [orderId])).rows[0]?.n ?? 0),
  };
}
