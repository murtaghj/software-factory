# @factory/database (W-006)

PostgreSQL 18 migrations, the migrator/runtime role split and tenant-scoped access.

## Migrations

- `migrations/0001–0010` are the reference DDL (`docs/spec/contracts/schema.sql`), split at named
  anchors and copied verbatim by `scripts/import-reference-schema.ts`. A test re-runs the import
  and compares the result byte for byte. A second test applies both the reference script and the
  migrations to fresh databases and compares the full catalog: tables, columns, constraints,
  indexes, policies, triggers, functions, grants and owners.
- `0011+` are hand-written forward migrations. 0011 and 0012 fix reference defects SI-04 and SI-06
  (docs/spec-issues.md).
- Every file declares `-- phase: expand|backfill|contract`. The runner (`migrate()`) does this:
  - It runs as `factory_migrator`.
  - It records SHA-256 checksums and refuses edited applied files.
  - It runs backfills in bounded batches, per tenant and restartably (forced RLS applies to the
    owner too).
  - It refuses a contract migration while any worker that reads its `-- retires:` capability has
    heartbeated within the reader window (`heartbeatSchemaReader` / `retireSchemaReader`).

## Roles

| Role | Kind | Rights |
| --- | --- | --- |
| factory_migrator | NOLOGIN | Owns the schema and every object |
| factory_runtime | NOLOGIN | Column-limited grants only; owns nothing; no DELETE |
| factory_migrate_login | LOGIN, NOINHERIT | May only `SET ROLE factory_migrator` |
| factory_app_login | LOGIN, INHERIT | Inherits factory_runtime; cannot SET ROLE |

None of these roles has SUPERUSER, BYPASSRLS or CREATEROLE. `bootstrapDatabase()` creates them.
It is an administrator step and is never run with runtime credentials.

## Tenant access

`Database.withTenant({ orgId, principalId }, fn)` opens a transaction with `factory.org_id` and
`factory.principal_id` set locally. Without a tenant, RLS-protected tables read empty and reject
writes. Only `provisionOrganization` (migrator credentials) can create organizations.

Tests run as `factory_app_login` against real PostgreSQL. AC-05 (database layer), AC-58
(expand/backfill/contract with old and new readers) and AC-203 (runtime storage authority) are in
`test/`.
