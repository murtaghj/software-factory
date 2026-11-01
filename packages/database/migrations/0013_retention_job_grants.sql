-- 0013_retention_job_grants.sql: column-limited grants for the separate retention/sweep job role.
-- The reference states "retention deletion runs as a separate audited job role" but defines none
-- (docs/assumptions.md A-05). factory_retention (created by bootstrap, BYPASSRLS so reachability
-- checks see embargoed rows too) may read only what a sweep needs and may only expire uploads.
-- phase: expand
SET LOCAL search_path = factory, public;
GRANT USAGE ON SCHEMA factory TO factory_retention;
GRANT SELECT (id) ON organization TO factory_retention;
GRANT SELECT (org_id, id, storage_key) ON artifact TO factory_retention;
GRANT SELECT (org_id, id, temporary_key, state, expires_at) ON artifact_upload TO factory_retention;
GRANT UPDATE (state, updated_at) ON artifact_upload TO factory_retention;
GRANT INSERT ON audit_event TO factory_retention;
