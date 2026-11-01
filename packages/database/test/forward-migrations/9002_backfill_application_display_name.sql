-- Test-only forward migration (AC-58): restartable backfill in bounded batches per tenant.
-- phase: backfill
SET LOCAL search_path = factory, public;
UPDATE application SET display_name = name
WHERE (org_id, id) IN (SELECT org_id, id FROM application WHERE display_name IS NULL ORDER BY id LIMIT 2)
