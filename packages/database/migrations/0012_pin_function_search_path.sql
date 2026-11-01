-- 0012_pin_function_search_path.sql: forward fix for a reference DDL defect (docs/spec-issues.md SI-06).
-- The reference guard functions reference factory tables unqualified (e.g. task%ROWTYPE) and do not
-- pin search_path, so they fail for sessions whose search_path omits `factory` and could resolve
-- objects from another schema. Pin each function to the factory schema.
-- phase: expand
SET LOCAL search_path = factory, public;
ALTER FUNCTION guard_artifact_link_embargo() SET search_path = factory, pg_catalog;
ALTER FUNCTION guard_child_embargo() SET search_path = factory, pg_catalog;
ALTER FUNCTION initialize_task_owner() SET search_path = factory, pg_catalog;
ALTER FUNCTION guard_stage_run() SET search_path = factory, pg_catalog;
ALTER FUNCTION guard_environment_generation() SET search_path = factory, pg_catalog;
ALTER FUNCTION guard_factory_tool_call() SET search_path = factory, pg_catalog;
ALTER FUNCTION guard_task_delivery_scope() SET search_path = factory, pg_catalog;
ALTER FUNCTION guard_task_design_source() SET search_path = factory, pg_catalog;
ALTER FUNCTION guard_design_build_binding() SET search_path = factory, pg_catalog;
