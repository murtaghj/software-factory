-- 0003_tasks_execution.sql: tasks, drafts, specs, plans, stage runs, workspaces, allocations, sessions, candidates, artifact links.
-- Imported verbatim from docs/spec/contracts/schema.sql (sha256 3538dceed1bcb99449e9379006a482ae1f78467b0949e798e86172e05056900b) by
-- packages/database/scripts/import-reference-schema.ts. Do not edit; add a forward migration.
-- phase: expand
SET LOCAL search_path = factory, public;
CREATE TABLE task (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  parent_task_id uuid, creator_id uuid NOT NULL, primary_application_id uuid NOT NULL,
owner_principal_id uuid NOT NULL, interactive_holder_principal_id uuid,
target_kind text NOT NULL CHECK(target_kind IN ('new_application','existing_application')),
target_context jsonb NOT NULL CHECK(jsonb_typeof(target_context)='object' AND target_context ? 'kind' AND target_context ? 'applicationId' AND jsonb_typeof(target_context->'kind')='string' AND jsonb_typeof(target_context->'applicationId')='string'),
CHECK(target_context->>'kind'=target_kind AND target_context->>'applicationId'=primary_application_id::text),
work_type text NOT NULL CHECK(work_type IN ('feature','bug','refactor','maintenance','performance','platform','documentation','investigation')),
priority_class text NOT NULL DEFAULT 'normal' CHECK(priority_class IN ('incident','normal','background')),
change_class text NOT NULL CHECK(length(change_class)>0), incident_ref jsonb,
security jsonb, embargo_group_id uuid,
delivery_scope text NOT NULL CHECK(delivery_scope IN ('report','patch','pr','preview','production','design')),
CHECK(delivery_scope <> 'design' OR work_type IN ('feature','refactor','performance','platform')),
design_source_task_id uuid, CHECK(design_source_task_id IS NULL OR delivery_scope <> 'design'),
CHECK(security IS NULL OR COALESCE(
  (work_type IN ('bug','maintenance') OR delivery_scope='design'
   OR (design_source_task_id IS NOT NULL AND delivery_scope <> 'design' AND security->>'embargoed'='true'))
  AND jsonb_typeof(security)='object'
  AND security->>'severity' IN ('critical','high','medium','low')
  AND jsonb_typeof(security->'sourceRef')='object'
  AND jsonb_typeof(security->'embargoed')='boolean', false)),
CHECK(CASE WHEN security->>'embargoed'='true'
  THEN embargo_group_id IS NOT NULL AND COALESCE(security->>'securityGroupId'=embargo_group_id::text,false)
  ELSE embargo_group_id IS NULL END),
FOREIGN KEY(org_id,embargo_group_id) REFERENCES security_group(org_id,id),
CHECK(work_type='feature' OR target_kind='existing_application'),
status text NOT NULL CHECK(status IN ('accepted','queued','running','waiting_input','waiting_decision','paused','cancelling','succeeded','incomplete','failed','cancelled')),
spec_version integer NOT NULL DEFAULT 1 CHECK(spec_version > 0),
control_revision bigint NOT NULL DEFAULT 1 CHECK(control_revision > 0),
plan_version integer NOT NULL DEFAULT 1 CHECK(plan_version > 0),
projection_sequence bigint NOT NULL DEFAULT 0 CHECK(projection_sequence >= 0), projection_hash text,
CHECK((projection_sequence = 0) = (projection_hash IS NULL)),
CHECK(projection_hash ~ '^[0-9a-f]{64}$'),
last_event_sequence bigint NOT NULL DEFAULT 0, projected_at timestamptz,
current_node_id text, outcome_ref jsonb, waiting_reason text,
intent_revision bigint NOT NULL DEFAULT 0 CHECK(intent_revision >= 0), intent_state_ref jsonb,
plan_review_revision bigint NOT NULL DEFAULT 0 CHECK(plan_review_revision >= 0), plan_review_state_ref jsonb,
cleanup_state text NOT NULL DEFAULT 'pending' CHECK(cleanup_state IN ('pending','running','complete','needs_operator')),
FOREIGN KEY(org_id,primary_application_id) REFERENCES application(org_id,id),
FOREIGN KEY(org_id,creator_id) REFERENCES principal(org_id,id),
FOREIGN KEY(org_id,owner_principal_id) REFERENCES principal(org_id,id),
FOREIGN KEY(org_id,interactive_holder_principal_id) REFERENCES principal(org_id,id),
FOREIGN KEY(org_id,parent_task_id) REFERENCES task(org_id,id),
FOREIGN KEY(org_id,design_source_task_id) REFERENCES task(org_id,id),
UNIQUE(org_id,id,delivery_scope),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE application_draft_version (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  application_id uuid NOT NULL, version integer NOT NULL CHECK(version > 0),
draft_artifact_id uuid NOT NULL, actor_id uuid NOT NULL,
FOREIGN KEY(org_id,application_id) REFERENCES application(org_id,id),
FOREIGN KEY(org_id,draft_artifact_id) REFERENCES artifact(org_id,id),
FOREIGN KEY(org_id,actor_id) REFERENCES principal(org_id,id),
UNIQUE(org_id,application_id,version),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE application_bootstrap (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  application_id uuid NOT NULL, task_id uuid NOT NULL, draft_revision integer NOT NULL,
plan_ref jsonb, request_hash text NOT NULL, operation_refs jsonb NOT NULL DEFAULT '[]',
state text NOT NULL CHECK(state IN ('claimed','planned','creating','initializing','scaffolding','verifying','registering','ready','reconciling','needs_operator','cancelled','failed')),
receipt_ref jsonb, disposition_ref jsonb, owner_ids jsonb NOT NULL,
FOREIGN KEY(org_id,application_id,draft_revision) REFERENCES application_draft_version(org_id,application_id,version),
FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id), UNIQUE(org_id,task_id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE task_spec_version (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, version integer NOT NULL CHECK(version > 0), spec jsonb NOT NULL,
spec_hash text NOT NULL, actor_id uuid NOT NULL,
FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id),
FOREIGN KEY(org_id,actor_id) REFERENCES principal(org_id,id), UNIQUE(org_id,task_id,version),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE task_dependency (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, prerequisite_task_id uuid NOT NULL, mandatory boolean NOT NULL DEFAULT true,
reason text NOT NULL, CHECK(task_id <> prerequisite_task_id),
FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id),
FOREIGN KEY(org_id,prerequisite_task_id) REFERENCES task(org_id,id),
UNIQUE(org_id,task_id,prerequisite_task_id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE workflow_binding (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, workflow_id text NOT NULL, current_run_id text,
template_id text, template_version text, template_ref jsonb,
worker_build_id text NOT NULL, last_observed_state text NOT NULL,
CHECK((template_id IS NULL AND template_version IS NULL AND template_ref IS NULL) OR (template_id IS NOT NULL AND template_version IS NOT NULL AND template_ref IS NOT NULL)),
FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id), UNIQUE(org_id,task_id), UNIQUE(org_id,workflow_id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE execution_plan (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, version integer NOT NULL CHECK(version > 0), spec_version integer NOT NULL,
plan_ref jsonb NOT NULL, policy_ref jsonb NOT NULL, plan_hash text NOT NULL,
template_id text NOT NULL, template_version text NOT NULL, template_ref jsonb NOT NULL,
FOREIGN KEY(org_id,task_id,spec_version) REFERENCES task_spec_version(org_id,task_id,version),
UNIQUE(org_id,task_id,version),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE stage_run (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, plan_version integer NOT NULL, node_id text NOT NULL,
semantic_attempt integer NOT NULL CHECK(semantic_attempt > 0), logical_id text NOT NULL,
input_hash text NOT NULL, input_ref jsonb NOT NULL, role text NOT NULL,
status text NOT NULL CHECK(status IN ('pending','ready','running','awaiting_input','evaluating','passed','failed','inconclusive','skipped','cancelled')),
limits jsonb NOT NULL, result_ref jsonb, error_class text, started_at timestamptz, completed_at timestamptz,
superseded_at timestamptz, superseded_by_plan_version integer, superseded_by_stage_run_id uuid,
CHECK ((superseded_at IS NULL) = (superseded_by_plan_version IS NULL)),
CHECK (superseded_by_stage_run_id IS NULL OR superseded_at IS NOT NULL),
CHECK (superseded_by_plan_version > plan_version),
FOREIGN KEY(org_id,task_id,superseded_by_plan_version) REFERENCES execution_plan(org_id,task_id,version),
FOREIGN KEY(org_id,superseded_by_stage_run_id) REFERENCES stage_run(org_id,id),
FOREIGN KEY(org_id,task_id,plan_version) REFERENCES execution_plan(org_id,task_id,version),
UNIQUE(org_id,task_id,plan_version,node_id,semantic_attempt), UNIQUE(org_id,logical_id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE workspace (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, repository_id uuid NOT NULL, stage_run_id uuid NOT NULL, role text NOT NULL,
branch text, base_commit git_object_id NOT NULL, candidate_commit git_object_id,
state text NOT NULL CHECK(state IN ('allocated','active','quiescing','checkpointed','retained','releasing','released','quarantined')),
generation integer NOT NULL CHECK(generation > 0), owner_epoch bigint NOT NULL CHECK(owner_epoch > 0),
owner_pod_uid text, lease_until timestamptz, setup_profile_ref jsonb NOT NULL, checkpoint_ref jsonb,
FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id),
FOREIGN KEY(org_id,repository_id) REFERENCES repository(org_id,id),
FOREIGN KEY(org_id,stage_run_id) REFERENCES stage_run(org_id,id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE execution_allocation (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  stage_run_id uuid NOT NULL, workspace_id uuid, generation integer NOT NULL CHECK(generation > 0),
owner_epoch bigint NOT NULL CHECK(owner_epoch > 0), spec_hash text NOT NULL,
job_name text NOT NULL, job_uid text, pod_uid text, namespace text NOT NULL,
supervisor_identity text NOT NULL, controller_lease_until timestamptz,
data_classification text, provider_eligibility_ref jsonb,
CHECK((data_classification IS NULL) = (provider_eligibility_ref IS NULL)),
state text NOT NULL CHECK(state IN ('desired','starting','running','suspect','stopping','finalizing','terminated','completed','quarantined')),
last_heartbeat_at timestamptz, terminated_at timestamptz,
FOREIGN KEY(org_id,stage_run_id) REFERENCES stage_run(org_id,id),
FOREIGN KEY(org_id,workspace_id) REFERENCES workspace(org_id,id),
UNIQUE(org_id,stage_run_id,generation), UNIQUE(org_id,namespace,job_name),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE checkpoint_job (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  allocation_id uuid NOT NULL, generation integer NOT NULL CHECK(generation > 0),
owner_epoch bigint NOT NULL CHECK(owner_epoch > 0), job_name text NOT NULL,
job_uid text, pod_uid text, namespace text NOT NULL, identity_audience text NOT NULL,
state text NOT NULL CHECK(state IN ('desired','starting','running','completed','failed','quarantined')),
receipt_id uuid NOT NULL,
FOREIGN KEY(org_id,allocation_id) REFERENCES execution_allocation(org_id,id),
UNIQUE(org_id,namespace,job_name),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE session (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, workspace_id uuid NOT NULL, harness text NOT NULL, adapter_version text NOT NULL,
model_profile text NOT NULL, config_hash text NOT NULL, native_id text NOT NULL, native_state_ref jsonb,
workspace_generation integer NOT NULL, role text NOT NULL,
FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id), FOREIGN KEY(org_id,workspace_id) REFERENCES workspace(org_id,id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE candidate (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, manifest_ref jsonb NOT NULL, candidate_hash text NOT NULL,
created_by_stage_run_id uuid NOT NULL,
FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id),
FOREIGN KEY(org_id,created_by_stage_run_id) REFERENCES stage_run(org_id,id),
UNIQUE(org_id,task_id,candidate_hash),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE artifact_link (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  artifact_id uuid NOT NULL, task_id uuid NOT NULL, stage_run_id uuid, candidate_id uuid,
purpose text NOT NULL, retain_until timestamptz NOT NULL,
FOREIGN KEY(org_id,artifact_id) REFERENCES artifact(org_id,id),
FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id),
FOREIGN KEY(org_id,stage_run_id) REFERENCES stage_run(org_id,id),
FOREIGN KEY(org_id,candidate_id) REFERENCES candidate(org_id,id),
  PRIMARY KEY (org_id,id)
);
