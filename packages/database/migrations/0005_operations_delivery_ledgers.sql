-- 0005_operations_delivery_ledgers.sql: external operations, environments, git changes, knowledge, budgets, outbox/inbox, idempotency, audit, tool calls, PR review.
-- Imported verbatim from docs/spec/contracts/schema.sql (sha256 3538dceed1bcb99449e9379006a482ae1f78467b0949e798e86172e05056900b) by
-- packages/database/scripts/import-reference-schema.ts. Do not edit; add a forward migration.
-- phase: expand
SET LOCAL search_path = factory, public;
CREATE TABLE external_operation (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, provider text NOT NULL, kind text NOT NULL, logical_key text NOT NULL,
request_hash text NOT NULL, request_ref jsonb NOT NULL,
state text NOT NULL CHECK(state IN ('reserved','submitted','reconciling','succeeded','failed','unknown','needs_operator')),
external_handle text, result_ref jsonb, last_observed_at timestamptz, reconcile_after timestamptz,
FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id), UNIQUE(org_id,provider,kind,logical_key),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE environment (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, provider text NOT NULL, external_handle text, plan_ref jsonb NOT NULL,
revision bigint NOT NULL DEFAULT 1 CHECK(revision > 0), generation bigint NOT NULL DEFAULT 1 CHECK(generation > 0),
current_operation_id uuid, deployment_status jsonb, status_observed_at timestamptz,
CHECK((deployment_status IS NULL) = (status_observed_at IS NULL)),
CHECK(deployment_status IS NULL OR current_operation_id IS NOT NULL),
FOREIGN KEY(org_id,current_operation_id) REFERENCES external_operation(org_id,id),
state text NOT NULL CHECK(state IN ('planned','provisioning','reconciling','deployed','preparing','ready','verifying','verified','verification_failed','retained','retiring','retired','needs_operator')),
endpoints jsonb NOT NULL DEFAULT '[]', observed_release_ref jsonb, verification_ref jsonb,
expires_at timestamptz NOT NULL, cleanup_state text NOT NULL CHECK(cleanup_state IN ('pending','running','complete','needs_operator')),
FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id), UNIQUE(org_id,provider,external_handle),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE git_change (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, repository_id uuid NOT NULL, branch text NOT NULL,
source_repository_id uuid NOT NULL, publication_target_ref jsonb NOT NULL,
FOREIGN KEY(org_id,source_repository_id) REFERENCES repository(org_id,id),
pr_external_id text, pr_url text, expected_head git_object_id, expected_base git_object_id, merged_commit git_object_id,
provider_observation_ref jsonb, stacked_on_git_change_id uuid,
FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id),
FOREIGN KEY(org_id,repository_id) REFERENCES repository(org_id,id),
FOREIGN KEY(org_id,stacked_on_git_change_id) REFERENCES git_change(org_id,id),
UNIQUE(org_id,task_id,repository_id), UNIQUE(org_id,repository_id,branch),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE knowledge_record (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, kind text NOT NULL, scope text NOT NULL, statement text NOT NULL,
source_refs jsonb NOT NULL, applicable_versions jsonb NOT NULL, environment text,
status text NOT NULL CHECK(status IN ('proposed','reviewed','verified','disputed','superseded','expired')),
verified_at timestamptz, expires_at timestamptz, superseded_by uuid, review_ref jsonb,
signature_digest text CHECK(signature_digest ~ '^[0-9a-f]{64}$'), signature_keys jsonb, component_ids jsonb,
CHECK((signature_digest IS NULL) = (signature_keys IS NULL)),
search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', statement)) STORED,
FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id),
FOREIGN KEY(org_id,superseded_by) REFERENCES knowledge_record(org_id,id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE knowledge_dispute (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  record_id uuid NOT NULL, disputing_record_id uuid NOT NULL,
CHECK(record_id <> disputing_record_id),
FOREIGN KEY(org_id,record_id) REFERENCES knowledge_record(org_id,id),
FOREIGN KEY(org_id,disputing_record_id) REFERENCES knowledge_record(org_id,id),
UNIQUE(org_id,record_id,disputing_record_id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE budget_account (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, parent_account_id uuid, limit_micro_usd bigint NOT NULL CHECK(limit_micro_usd >= 0),
reserved_micro_usd bigint NOT NULL DEFAULT 0 CHECK(reserved_micro_usd >= 0),
charged_micro_usd bigint NOT NULL DEFAULT 0 CHECK(charged_micro_usd >= 0), revision bigint NOT NULL DEFAULT 1,
budget_class text NOT NULL CHECK(budget_class IN ('task','design')), task_delivery_scope text NOT NULL,
CHECK((budget_class='design') = (task_delivery_scope='design')),
FOREIGN KEY(org_id,task_id,task_delivery_scope) REFERENCES task(org_id,id,delivery_scope) ON UPDATE CASCADE,
FOREIGN KEY(org_id,parent_account_id,budget_class) REFERENCES budget_account(org_id,id,budget_class),
UNIQUE(org_id,id,budget_class),
FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id),
FOREIGN KEY(org_id,parent_account_id) REFERENCES budget_account(org_id,id), UNIQUE(org_id,task_id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE budget_ledger (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  account_id uuid NOT NULL, operation_key text NOT NULL,
kind text NOT NULL CHECK(kind IN ('reservation','observed_usage','estimated_usage','adjustment','release','unknown_charge')),
amount_micro_usd bigint NOT NULL, pricing_ref jsonb, provider_request_id text,
details_ref jsonb, FOREIGN KEY(org_id,account_id) REFERENCES budget_account(org_id,id),
UNIQUE(org_id,account_id,operation_key,kind),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE capacity_reservation (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, stage_run_id uuid NOT NULL, pool_key text NOT NULL,
slots integer NOT NULL CHECK(slots > 0), state text NOT NULL CHECK(state IN ('reserved','active','released')),
expires_at timestamptz NOT NULL,
FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id),
FOREIGN KEY(org_id,stage_run_id) REFERENCES stage_run(org_id,id), UNIQUE(org_id,stage_run_id,pool_key),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE outbox (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL, aggregate_id uuid NOT NULL, dedupe_key text NOT NULL, payload jsonb NOT NULL,
state text NOT NULL CHECK(state IN ('pending','leased','delivered','dead_letter')),
attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
lease_owner text, lease_until timestamptz, last_error text, UNIQUE(org_id,dedupe_key),
embargo_group_id uuid, FOREIGN KEY(org_id,embargo_group_id) REFERENCES security_group(org_id,id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE inbox (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  provider text NOT NULL, installation_ref text NOT NULL, external_event_id text NOT NULL,
body_digest text NOT NULL, body_ref jsonb NOT NULL, verified_at timestamptz NOT NULL,
processed_at timestamptz, UNIQUE(org_id,provider,installation_ref,external_event_id),
embargo_group_id uuid, FOREIGN KEY(org_id,embargo_group_id) REFERENCES security_group(org_id,id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE idempotency_record (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  principal_id uuid NOT NULL, route text NOT NULL, request_key text NOT NULL, request_hash text NOT NULL,
response_status integer NOT NULL, response_body jsonb NOT NULL, expires_at timestamptz NOT NULL,
FOREIGN KEY(org_id,principal_id) REFERENCES principal(org_id,id), UNIQUE(org_id,principal_id,route,request_key),
embargo_group_id uuid, FOREIGN KEY(org_id,embargo_group_id) REFERENCES security_group(org_id,id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE audit_event (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  actor_id text NOT NULL, action text NOT NULL, resource_kind text NOT NULL, resource_id text NOT NULL,
outcome text NOT NULL, correlation_id text NOT NULL, request_digest text NOT NULL, details_ref jsonb,
embargo_group_id uuid, FOREIGN KEY(org_id,embargo_group_id) REFERENCES security_group(org_id,id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE factory_tool_call (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, stage_run_id uuid NOT NULL, allocation_id uuid NOT NULL,
call_id uuid NOT NULL, epoch bigint NOT NULL CHECK(epoch > 0),
tool_name text NOT NULL CHECK(tool_name IN ('verify', 'submit_result', 'request_decision', 'get_evidence', 'open_hypothesis', 'record_evidence', 'close_hypothesis', 'extend_hypothesis', 'reopen_hypothesis')),
request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]64$'), input_hash text NOT NULL,
role text NOT NULL, input_binding_ref jsonb,
sequence bigint NOT NULL CHECK(sequence > 0),
state text NOT NULL CHECK(state IN ('reserved','running','proposal_received','finalizing','finalized','failed','rejected')),
request_ref jsonb NOT NULL, receipt_ref jsonb, result_ref jsonb,
proposal_accepted boolean NOT NULL DEFAULT false,
CHECK(NOT proposal_accepted OR tool_name='submit_result'),
FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id),
FOREIGN KEY(org_id,stage_run_id) REFERENCES stage_run(org_id,id),
FOREIGN KEY(org_id,allocation_id) REFERENCES execution_allocation(org_id,id),
UNIQUE(org_id,stage_run_id,call_id), UNIQUE(org_id,stage_run_id,sequence),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE pr_review_state (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, repository_id uuid NOT NULL, provider text NOT NULL, external_id text NOT NULL,
revision bigint NOT NULL CHECK(revision > 0),
completion_mode text NOT NULL CHECK(completion_mode IN ('pr_created','review_completed','merged')),
phase text NOT NULL CHECK(phase IN ('reconciling','preview_only','waiting_review','rework','head_conflict','completed','abandoned','handed_over')),
expected_head git_object_id NOT NULL, observed_head git_object_id, review_round integer NOT NULL DEFAULT 0 CHECK(review_round >= 0),
state_ref jsonb NOT NULL, provider_observation_ref jsonb, review_deadline timestamptz NOT NULL,
FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id),
FOREIGN KEY(org_id,repository_id) REFERENCES repository(org_id,id),
UNIQUE(org_id,task_id,repository_id),
  PRIMARY KEY (org_id,id)
);
