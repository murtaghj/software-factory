-- 0011_fix_factory_tool_call_request_hash.sql: forward fix for a reference DDL defect (docs/spec-issues.md SI-04).
-- The reference check '^[0-9a-f]64$' matches one hex character followed by the literal "64", so no
-- real SHA-256 request digest can be stored. Replace it with the intended 64-hex-character check.
-- phase: expand
SET LOCAL search_path = factory, public;
ALTER TABLE factory_tool_call DROP CONSTRAINT factory_tool_call_request_hash_check;
ALTER TABLE factory_tool_call ADD CONSTRAINT factory_tool_call_request_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$');
