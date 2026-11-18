// The k3s tier's global setup. A missing cluster, or a missing compose Postgres, is a failure with one line: never a skip.
import { adminUrl } from '@factory/test-support';
import pg from 'pg';
import { AdminClient, loadK3sEnv } from './cluster.ts';

export default async function setup(): Promise<void> {
  const env = loadK3sEnv();
  try {
    const r = await new AdminClient(env).call('GET', '/readyz');
    if (r.status !== 200) throw new Error(`HTTP ${String(r.status)}`);
  } catch (e) {
    throw new Error(`k3s tier: the cluster at ${env.server} does not answer (${e instanceof Error ? e.message : 'error'}); run "sh scripts/k3s.sh up"`, { cause: e });
  }
  const client = new pg.Client({ connectionString: adminUrl(), connectionTimeoutMillis: 5000 });
  try { await client.connect(); await client.query('SELECT 1'); } catch (e) {
    throw new Error(`k3s tier: the compose Postgres does not answer (${e instanceof Error ? e.message : 'error'}); run "pnpm services:up"`, { cause: e });
  } finally { await client.end().catch(() => undefined); }
}
