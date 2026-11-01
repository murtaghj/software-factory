// Real PostgreSQL 18 for tests (never mocked). Connects to the podman compose service started by
// `pnpm services:up`; override with FACTORY_PG_ADMIN_URL. Each test suite gets its own database.
import pg from 'pg';
import { randomBytes } from 'node:crypto';

export const DEFAULT_ADMIN_URL = 'postgres://factory_admin:factory_admin_local@127.0.0.1:55432/factory';

export function adminUrl(): string {
  return process.env.FACTORY_PG_ADMIN_URL ?? DEFAULT_ADMIN_URL;
}

export function urlForDatabase(base: string, database: string, user?: { name: string; password: string }): string {
  const u = new URL(base);
  u.pathname = `/${database}`;
  if (user) { u.username = user.name; u.password = user.password; }
  return u.toString();
}

export type IsolatedDatabase = { name: string; url: string; drop: () => Promise<void> };

export async function createIsolatedDatabase(prefix: string): Promise<IsolatedDatabase> {
  const name = `${prefix}_${randomBytes(6).toString('hex')}`.toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error(`invalid database name ${name}`);
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = urlForDatabase(adminUrl(), name);
  return {
    name,
    url,
    drop: async () => {
      const c = new pg.Client({ connectionString: adminUrl() });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}

export async function serverVersion(url: string): Promise<string> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const r = await c.query<{ server_version: string }>('SHOW server_version');
    return r.rows[0]?.server_version ?? 'unknown';
  } finally {
    await c.end();
  }
}
