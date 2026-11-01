// Test harness: a fresh, fully migrated PostgreSQL 18 database with the real role split.
import { adminUrl, createIsolatedDatabase, urlForDatabase } from '@factory/test-support';
import { bootstrapDatabase, MIGRATOR_LOGIN, RUNTIME_LOGIN } from './roles.ts';
import { migrate, type MigrateOptions } from './migrate.ts';

export type MigratedDatabase = { name: string; adminUrl: string; migratorUrl: string; runtimeUrl: string; drop: () => Promise<void> };

export async function createBootstrappedDatabase(prefix = 'factory_test'): Promise<MigratedDatabase> {
  const db = await createIsolatedDatabase(prefix);
  await bootstrapDatabase(db.url, db.name);
  return {
    name: db.name,
    adminUrl: db.url,
    migratorUrl: urlForDatabase(adminUrl(), db.name, MIGRATOR_LOGIN),
    runtimeUrl: urlForDatabase(adminUrl(), db.name, RUNTIME_LOGIN),
    drop: db.drop,
  };
}

export async function createMigratedDatabase(prefix = 'factory_test', options: MigrateOptions = {}): Promise<MigratedDatabase> {
  const db = await createBootstrappedDatabase(prefix);
  await migrate(db.migratorUrl, options);
  return db;
}
