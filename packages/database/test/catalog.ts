// Structural snapshot of the factory schema, used to prove the migrations reproduce the reference DDL.
import pg from 'pg';

const QUERY = `SELECT json_build_object(
 'tables', (SELECT json_agg(json_build_object('table', c.relname, 'owner', pg_get_userbyid(c.relowner), 'rls', c.relrowsecurity, 'force', c.relforcerowsecurity) ORDER BY c.relname)
            FROM pg_class c WHERE c.relnamespace = 'factory'::regnamespace AND c.relkind = 'r'),
 'columns', (SELECT json_agg(json_build_object('table', table_name, 'column', column_name, 'type', data_type, 'domain', domain_name, 'nullable', is_nullable, 'default', column_default) ORDER BY table_name, ordinal_position)
             FROM information_schema.columns WHERE table_schema = 'factory'),
 'constraints', (SELECT json_agg(json_build_object('table', conrelid::regclass::text, 'name', conname, 'def', pg_get_constraintdef(oid)) ORDER BY conrelid::regclass::text, conname)
                 FROM pg_constraint WHERE connamespace = 'factory'::regnamespace),
 'indexes', (SELECT json_agg(json_build_object('name', indexname, 'def', indexdef) ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'factory'),
 'policies', (SELECT json_agg(json_build_object('table', tablename, 'name', policyname, 'permissive', permissive, 'roles', roles, 'cmd', cmd, 'qual', qual, 'check', with_check) ORDER BY tablename, policyname)
              FROM pg_policies WHERE schemaname = 'factory'),
 'triggers', (SELECT json_agg(json_build_object('name', tgname, 'def', pg_get_triggerdef(oid)) ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'factory'::regnamespace)),
 'functions', (SELECT json_agg(json_build_object('name', proname, 'owner', pg_get_userbyid(proowner), 'def', pg_get_functiondef(oid)) ORDER BY proname) FROM pg_proc WHERE pronamespace = 'factory'::regnamespace),
 'tableGrants', (SELECT json_agg(json_build_object('grantee', grantee, 'table', table_name, 'privilege', privilege_type) ORDER BY grantee, table_name, privilege_type)
                 FROM information_schema.role_table_grants WHERE table_schema = 'factory' AND grantee IN ('factory_runtime', 'factory_migrator', 'PUBLIC')),
 'columnGrants', (SELECT json_agg(json_build_object('table', table_name, 'column', column_name, 'privilege', privilege_type) ORDER BY table_name, column_name, privilege_type)
                  FROM information_schema.column_privileges WHERE table_schema = 'factory' AND grantee = 'factory_runtime'),
 'schemaOwner', (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'factory'),
 'domains', (SELECT json_agg(json_build_object('name', typname, 'owner', pg_get_userbyid(typowner)) ORDER BY typname) FROM pg_type WHERE typnamespace = 'factory'::regnamespace AND typtype = 'd')
) AS snapshot`;

export type Catalog = Record<string, Array<Record<string, unknown>> | string>;

export async function catalogSnapshot(url: string): Promise<Catalog> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<{ snapshot: Catalog }>(QUERY)).rows[0]?.snapshot ?? {};
  } finally {
    await c.end();
  }
}

export function diffCatalog(a: Catalog, b: Catalog): string[] {
  const out: string[] = [];
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const left = JSON.stringify(a[key]);
    const right = JSON.stringify(b[key]);
    if (left === right) continue;
    const la = Array.isArray(a[key]) ? (a[key] as unknown[]).map((x) => JSON.stringify(x)) : [left];
    const lb = Array.isArray(b[key]) ? (b[key] as unknown[]).map((x) => JSON.stringify(x)) : [right];
    for (const x of la) if (!lb.includes(x)) out.push(`${key}: only in first: ${x}`);
    for (const x of lb) if (!la.includes(x)) out.push(`${key}: only in second: ${x}`);
  }
  return out;
}
