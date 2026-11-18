-- 0016_command_authority_basis.sql: records, at ingress, how a command's issuer was authorized when
-- that basis is not a membership row (docs/plan-additions.md P-18; docs/assumptions.md A-24). The
-- API grants application ownership to a principal whose token asserts a group listed in the
-- application's owner_ids ("group:<name>"); the worker cannot see token groups, so it re-checks that
-- the group is still listed when the command is applied. Null means no group basis was used.
-- phase: expand
SET LOCAL search_path = factory, public;

ALTER TABLE command ADD COLUMN authority_basis text CHECK (authority_basis IS NULL OR authority_basis ~ '^group:.{1,200}$');
