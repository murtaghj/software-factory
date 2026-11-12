-- 0014_principal_allowance.sql: per-principal spending allowances (docs/plan-additions.md P-09;
-- docs/assumptions.md A-17). Not in the reference DDL. A principal_allowance row is one principal's
-- limit and usage for one calendar period; budget_account_allowance records which allowance a task
-- budget account draws on (fixed when the account is opened). Reservations and charges on a linked
-- account are applied to the allowance in the same transaction as the account chain.
-- phase: expand
SET LOCAL search_path = factory, public;

CREATE TABLE principal_allowance (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  principal_id uuid NOT NULL, period_start date NOT NULL, period_end date NOT NULL,
  limit_micro_usd bigint NOT NULL CHECK(limit_micro_usd >= 0),
  reserved_micro_usd bigint NOT NULL DEFAULT 0 CHECK(reserved_micro_usd >= 0),
  charged_micro_usd bigint NOT NULL DEFAULT 0 CHECK(charged_micro_usd >= 0),
  revision bigint NOT NULL DEFAULT 1, set_by_principal_id uuid NOT NULL,
  CHECK(period_end > period_start),
  FOREIGN KEY (org_id, principal_id) REFERENCES principal(org_id, id),
  FOREIGN KEY (org_id, set_by_principal_id) REFERENCES principal(org_id, id),
  UNIQUE (org_id, principal_id, period_start),
  PRIMARY KEY (org_id, id)
);

CREATE TABLE budget_account_allowance (
  org_id uuid NOT NULL REFERENCES organization(id),
  account_id uuid NOT NULL, allowance_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, account_id) REFERENCES budget_account(org_id, id),
  FOREIGN KEY (org_id, allowance_id) REFERENCES principal_allowance(org_id, id),
  PRIMARY KEY (org_id, account_id)
);
CREATE INDEX budget_account_allowance_by_allowance ON budget_account_allowance (org_id, allowance_id);

ALTER TABLE principal_allowance ENABLE ROW LEVEL SECURITY;
ALTER TABLE principal_allowance FORCE ROW LEVEL SECURITY;
CREATE POLICY principal_allowance_org_scope ON principal_allowance USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE budget_account_allowance ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_account_allowance FORCE ROW LEVEL SECURITY;
CREATE POLICY budget_account_allowance_org_scope ON budget_account_allowance USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);

-- Runtime may create and update allowances but never delete one; a link is append-only.
GRANT SELECT, INSERT ON principal_allowance TO factory_runtime;
GRANT UPDATE (limit_micro_usd, reserved_micro_usd, charged_micro_usd, revision, set_by_principal_id, updated_at) ON principal_allowance TO factory_runtime;
GRANT SELECT, INSERT ON budget_account_allowance TO factory_runtime;
