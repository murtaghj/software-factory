// Database roles (chapter 02: "Keep migration privileges separate from runtime privileges").
//   factory_migrator: NOLOGIN group role that owns the schema and every object.
//   factory_runtime:  NOLOGIN group role with only column-limited grants; never owns anything.
// Installations log in as members. These local-development login roles stand in for INT-07
// credentials (docs/assumptions.md A-04).
import pg from 'pg';

export const MIGRATOR_LOGIN = { name: 'factory_migrate_login', password: 'factory_migrate_local' } as const;
export const RUNTIME_LOGIN = { name: 'factory_app_login', password: 'factory_app_local' } as const;
// Separate audited retention/sweep job role (reference DDL: "retention deletion runs as a separate
// audited job role"). BYPASSRLS so reachability checks also see embargoed rows; its grants are
// limited to the columns a sweep reads (migration 0013). Never used by API, worker or runner.
export const RETENTION_LOGIN = { name: 'factory_retention_login', password: 'factory_retention_local' } as const;

const ROLE_STATEMENTS = [
  `CREATE ROLE factory_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`,
  `CREATE ROLE factory_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`,
  `CREATE ROLE ${MIGRATOR_LOGIN.name} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD '${MIGRATOR_LOGIN.password}'`,
  `CREATE ROLE ${RUNTIME_LOGIN.name} LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD '${RUNTIME_LOGIN.password}'`,
  `CREATE ROLE factory_retention NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`,
  `CREATE ROLE ${RETENTION_LOGIN.name} LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD '${RETENTION_LOGIN.password}'`,
];

async function tolerateExisting(client: pg.Client, sql: string): Promise<void> {
  try {
    await client.query(sql);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== '42710' && code !== '23505' && code !== 'XX000') throw e; // role exists / concurrent create
  }
}

// Run once per cluster and database by an administrator (never by runtime or migration logins).
export async function bootstrapDatabase(adminDatabaseUrl: string, database: string): Promise<void> {
  if (!/^[a-z][a-z0-9_]*$/.test(database)) throw new Error(`invalid database name ${database}`);
  const admin = new pg.Client({ connectionString: adminDatabaseUrl });
  await admin.connect();
  try {
    for (const sql of ROLE_STATEMENTS) await tolerateExisting(admin, sql);
    await tolerateExisting(admin, `GRANT factory_migrator TO ${MIGRATOR_LOGIN.name} WITH INHERIT FALSE, SET TRUE`);
    await tolerateExisting(admin, `GRANT factory_runtime TO ${RUNTIME_LOGIN.name} WITH INHERIT TRUE, SET FALSE`);
    await tolerateExisting(admin, `GRANT factory_retention TO ${RETENTION_LOGIN.name} WITH INHERIT FALSE, SET TRUE`);
    await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT, CREATE ON DATABASE ${database} TO factory_migrator`);
    await admin.query(`GRANT CONNECT ON DATABASE ${database} TO factory_runtime, factory_retention, ${MIGRATOR_LOGIN.name}, ${RUNTIME_LOGIN.name}, ${RETENTION_LOGIN.name}`);
  } finally {
    await admin.end();
  }
}
