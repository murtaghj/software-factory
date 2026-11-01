-- Test-only forward migration (AC-58): contract. Removes the legacy column once no worker still reads it.
-- phase: contract
-- retires: application.name
SET LOCAL search_path = factory, public;
DROP TRIGGER application_display_name_sync ON application;
DROP FUNCTION sync_application_display_name();
ALTER TABLE application ALTER COLUMN display_name SET NOT NULL;
ALTER TABLE application DROP COLUMN name;
