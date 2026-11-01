-- Test-only forward migration (AC-58): expand. Adds application.display_name alongside the legacy
-- application.name; a trigger dual-writes so old writers keep producing complete rows.
-- phase: expand
SET LOCAL search_path = factory, public;
ALTER TABLE application ADD COLUMN display_name text;
CREATE FUNCTION sync_application_display_name() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.display_name := COALESCE(NEW.display_name, NEW.name);
  NEW.name := COALESCE(NEW.name, NEW.display_name);
  RETURN NEW;
END $$;
CREATE TRIGGER application_display_name_sync BEFORE INSERT OR UPDATE ON application
  FOR EACH ROW EXECUTE FUNCTION sync_application_display_name();
GRANT UPDATE (display_name) ON application TO factory_runtime;
