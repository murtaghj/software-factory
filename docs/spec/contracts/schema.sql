-- Reference PostgreSQL 18 schema for implementation planning.
-- Revision 1.7 DDL was applied to a clean PostgreSQL 18 instance with a tenant-isolation smoke test
-- (non-owner role, cross-tenant write rejected, unscoped reads empty). This is not migration,
-- upgrade or full privilege qualification; those remain W-006 obligations in CI.
-- Revision 1.11 embargo policies and revision 1.13 AI review and design-delivery storage are not yet proven on PostgreSQL.
-- Split into reviewed migrations; validate SQL, roles, RLS and forward upgrades in CI.
-- UUIDs are supplied by the application. All owned references are tenant qualified.
BEGIN;
CREATE SCHEMA factory;
SET LOCAL search_path = factory, public;
CREATE DOMAIN git_object_id AS text
  CHECK (VALUE ~ '^([0-9a-f]{40}|[0-9a-f]{64})$' AND VALUE !~ '^0+$');
CREATE TABLE organization (
  id uuid PRIMARY KEY, name text NOT NULL, status text NOT NULL,
  default_policy_ref jsonb, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE principal (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  issuer text NOT NULL, subject text NOT NULL, display_name text NOT NULL,
disabled_at timestamptz, UNIQUE (org_id, issuer, subject),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE membership (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  principal_id uuid NOT NULL, role text NOT NULL, application_scope jsonb NOT NULL DEFAULT '[]',
revoked_at timestamptz, FOREIGN KEY (org_id, principal_id) REFERENCES principal(org_id,id),
UNIQUE (org_id, principal_id, role),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE security_group (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  name text NOT NULL, authority_ref jsonb NOT NULL, UNIQUE(org_id,name),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE security_group_member (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  group_id uuid NOT NULL, principal_id uuid NOT NULL, authority_ref jsonb NOT NULL,
revoked_at timestamptz,
FOREIGN KEY(org_id,group_id) REFERENCES security_group(org_id,id),
FOREIGN KEY(org_id,principal_id) REFERENCES principal(org_id,id),
UNIQUE(org_id,group_id,principal_id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE repository (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  provider text NOT NULL, installation_ref text NOT NULL, external_id text NOT NULL,
clone_url text NOT NULL, default_branch text NOT NULL, policy_ref jsonb NOT NULL,
data_classification text,
UNIQUE (org_id, provider, installation_ref, external_id),
embargo_group_id uuid, FOREIGN KEY(org_id,embargo_group_id) REFERENCES security_group(org_id,id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE application (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  app_key text NOT NULL, name text NOT NULL, owner_ids jsonb NOT NULL,
data_classification text,
lifecycle text NOT NULL CHECK (lifecycle IN ('draft','experimental','production','deprecated')),
current_definition_id uuid, current_draft_revision integer NOT NULL DEFAULT 0 CHECK(current_draft_revision >= 0),
UNIQUE (org_id, app_key),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE artifact (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'), media_type text NOT NULL,
schema_version text NOT NULL, size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
storage_key text NOT NULL, storage_version text, producer_id text NOT NULL,
classification text NOT NULL CHECK (classification IN ('ordinary','restricted','sensitive_session')),
-- classification is retention/access; data_classification governs provider eligibility.
data_classification text,
finalized_at timestamptz NOT NULL, retention_until timestamptz NOT NULL,
UNIQUE NULLS NOT DISTINCT (org_id, sha256, media_type, schema_version, classification, data_classification, embargo_group_id),
embargo_group_id uuid, FOREIGN KEY(org_id,embargo_group_id) REFERENCES security_group(org_id,id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE artifact_upload (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  producer_id text NOT NULL, temporary_key text NOT NULL, max_bytes bigint NOT NULL CHECK(max_bytes > 0),
reservation_scope text NOT NULL CHECK(reservation_scope IN ('task_stage','application_draft','organization_controller')),
task_id uuid, stage_run_id uuid, application_id uuid, controller_kind text,
authority_ref jsonb NOT NULL, media_type text NOT NULL, schema_version text NOT NULL,
data_classification text,
CHECK((reservation_scope='task_stage' AND task_id IS NOT NULL AND stage_run_id IS NOT NULL AND application_id IS NULL AND controller_kind IS NULL)
 OR (reservation_scope='application_draft' AND task_id IS NULL AND stage_run_id IS NULL AND application_id IS NOT NULL AND controller_kind IS NULL)
 OR (reservation_scope='organization_controller' AND task_id IS NULL AND stage_run_id IS NULL AND application_id IS NULL AND controller_kind IS NOT NULL AND controller_kind IN ('emergency_stop','policy_release'))),
FOREIGN KEY (org_id, application_id) REFERENCES application(org_id,id),
classification text NOT NULL CHECK(classification IN ('ordinary','restricted','sensitive_session')),
state text NOT NULL CHECK(state IN ('reserved','uploading','verifying','finalized','failed','expired')),
expires_at timestamptz NOT NULL, artifact_id uuid,
FOREIGN KEY (org_id, artifact_id) REFERENCES artifact(org_id,id),
embargo_group_id uuid, FOREIGN KEY(org_id,embargo_group_id) REFERENCES security_group(org_id,id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE definition_version (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  entity_kind text NOT NULL, entity_key text NOT NULL, source_repository_id uuid NOT NULL,
source_commit git_object_id NOT NULL, source_path text NOT NULL, artifact_id uuid NOT NULL,
document_digest text NOT NULL, validation_state text NOT NULL CHECK(validation_state IN ('valid','invalid')),
FOREIGN KEY (org_id, source_repository_id) REFERENCES repository(org_id,id),
FOREIGN KEY (org_id, artifact_id) REFERENCES artifact(org_id,id),
UNIQUE (org_id, entity_kind, entity_key, source_repository_id, source_commit, source_path, document_digest),
embargo_group_id uuid, FOREIGN KEY(org_id,embargo_group_id) REFERENCES security_group(org_id,id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE registry_import (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  source_repository_id uuid NOT NULL, source_commit git_object_id NOT NULL, source_path text NOT NULL,
state text NOT NULL CHECK(state IN ('queued','validating','published','failed')),
result_ref jsonb, findings jsonb NOT NULL DEFAULT '[]',
FOREIGN KEY(org_id,source_repository_id) REFERENCES repository(org_id,id),
embargo_group_id uuid, FOREIGN KEY(org_id,embargo_group_id) REFERENCES security_group(org_id,id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE application_repository (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  application_id uuid NOT NULL, repository_id uuid NOT NULL, subpath text NOT NULL DEFAULT '', purpose text NOT NULL,
FOREIGN KEY(org_id,application_id) REFERENCES application(org_id,id),
FOREIGN KEY(org_id,repository_id) REFERENCES repository(org_id,id),
UNIQUE(org_id,application_id,repository_id,subpath,purpose),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE observation (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  application_id uuid NOT NULL, environment text NOT NULL, observation_kind text NOT NULL,
valid_from timestamptz NOT NULL, valid_until timestamptz NOT NULL, evidence_ref jsonb NOT NULL,
observed_release text, telemetry_identity text,
CHECK(valid_until > valid_from), FOREIGN KEY(org_id,application_id) REFERENCES application(org_id,id),
embargo_group_id uuid, FOREIGN KEY(org_id,embargo_group_id) REFERENCES security_group(org_id,id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE relationship (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  source_key text NOT NULL, target_key text NOT NULL, kind text NOT NULL,
basis text NOT NULL CHECK(basis IN ('declared','observed')),
definition_id uuid, observation_id uuid, environment text,
valid_from timestamptz NOT NULL, valid_until timestamptz,
FOREIGN KEY(org_id,definition_id) REFERENCES definition_version(org_id,id),
FOREIGN KEY(org_id,observation_id) REFERENCES observation(org_id,id),
CHECK((basis='declared' AND definition_id IS NOT NULL AND observation_id IS NULL)
 OR (basis='observed' AND observation_id IS NOT NULL AND definition_id IS NULL)),
embargo_group_id uuid, FOREIGN KEY(org_id,embargo_group_id) REFERENCES security_group(org_id,id),
  PRIMARY KEY (org_id,id)
);

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

CREATE TABLE gate_evaluation (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, gate_id text NOT NULL, input_hash text NOT NULL, input_binding jsonb NOT NULL,
verdict text NOT NULL CHECK(verdict IN ('passed','failed','inconclusive','superseded')),
evidence_refs jsonb NOT NULL, evaluator_id text NOT NULL, policy_ref jsonb NOT NULL,
reason_codes jsonb NOT NULL, superseded_by uuid,
resolved_mode text CHECK(resolved_mode IN ('human','human_sampled','automated')), mode_decision_ref jsonb,
FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id),
FOREIGN KEY(org_id,superseded_by) REFERENCES gate_evaluation(org_id,id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE finding (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, gate_evaluation_id uuid NOT NULL, subject_hash text NOT NULL,
severity text NOT NULL CHECK(severity IN ('critical','high','medium','low')),
category text NOT NULL, statement text NOT NULL, evidence_refs jsonb NOT NULL,
consequence text CHECK(length(consequence)>0), confidence text CHECK(confidence IN ('low','medium','high')),
criterion_ids jsonb NOT NULL, location jsonb,
finding_kind text CHECK(finding_kind IN ('unnecessary_code','rule_conflict','check_conflict','unsupported_claim')),
rule_ids jsonb, suggested_deletions jsonb,
CHECK(finding_kind IS DISTINCT FROM 'unnecessary_code' OR suggested_deletions IS NOT NULL),
required_action text NOT NULL, status text NOT NULL CHECK(status IN ('open','fixed','rejected','accepted_risk')),
disposition_ref jsonb, FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id),
FOREIGN KEY(org_id,gate_evaluation_id) REFERENCES gate_evaluation(org_id,id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE decision_request (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, action text NOT NULL CHECK(action IN ('confirm_intent','approve_plan','approve_rule_exception','reconcile_pr_head','handover_pr','propose_unreproduced_fix','confirm_application_owners','resume_campaign','lift_embargo','authorize_release','accept_residual_risk','approve_oracle','resolve_scope')), subject_hash text NOT NULL,
subject_ref jsonb NOT NULL, policy_ref jsonb NOT NULL, evidence_refs jsonb NOT NULL,
eligible_roles jsonb NOT NULL, required_principal_id uuid,
CHECK(action NOT IN ('confirm_intent','approve_plan','approve_rule_exception') OR required_principal_id IS NOT NULL),
FOREIGN KEY(org_id,required_principal_id) REFERENCES principal(org_id,id),
state text NOT NULL CHECK(state IN ('pending','approved','rejected','changes_requested','expired','superseded')),
expires_at timestamptz NOT NULL, reason text NOT NULL,
FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE decision (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  request_id uuid NOT NULL, decider_id uuid NOT NULL, subject_hash text NOT NULL,
actor_kind text NOT NULL DEFAULT 'human' CHECK(actor_kind='human'),
command_id uuid NOT NULL, reviewed_section_ids jsonb NOT NULL DEFAULT '[]', review_notes_ref jsonb,
CHECK(jsonb_typeof(reviewed_section_ids)='array'),
outcome text NOT NULL CHECK(outcome IN ('approve','reject','request_changes')), reason text NOT NULL,
authority_ref jsonb NOT NULL, FOREIGN KEY(org_id,request_id) REFERENCES decision_request(org_id,id),
FOREIGN KEY(org_id,decider_id) REFERENCES principal(org_id,id), UNIQUE(org_id,request_id), UNIQUE(org_id,command_id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE command (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, principal_id uuid NOT NULL, expected_revision bigint NOT NULL,
kind text NOT NULL, request_hash text NOT NULL, payload jsonb NOT NULL,
state text NOT NULL CHECK(state IN ('queued','delivered','accepted','applied','rejected')),
workflow_result jsonb, rejection_reason text,
FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id),
FOREIGN KEY(org_id,principal_id) REFERENCES principal(org_id,id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE plan_review_comment (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, command_id uuid NOT NULL, subject_hash text NOT NULL,
author_id uuid NOT NULL, note jsonb NOT NULL,
state text NOT NULL CHECK(state IN ('open','resolved','superseded')), resolution_ref jsonb,
FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id),
FOREIGN KEY(org_id,command_id) REFERENCES command(org_id,id),
FOREIGN KEY(org_id,author_id) REFERENCES principal(org_id,id), UNIQUE(org_id,command_id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE task_event (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, sequence bigint NOT NULL CHECK(sequence > 0), producer_event_id text NOT NULL,
event_type text NOT NULL, occurred_at timestamptz NOT NULL, source text NOT NULL,
recorded_at timestamptz NOT NULL DEFAULT now(), schema_version text NOT NULL,
correlation_id text NOT NULL, payload_ref jsonb NOT NULL,
FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id),
UNIQUE(org_id,task_id,sequence), UNIQUE(org_id,producer_event_id),
  PRIMARY KEY (org_id,id)
);

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

CREATE TABLE application_health_sample (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  application_id uuid NOT NULL, cohort_hash text NOT NULL, metric_version text NOT NULL,
window_start timestamptz NOT NULL, window_end timestamptz NOT NULL, observed_at timestamptz NOT NULL,
sample_count integer NOT NULL CHECK(sample_count >= 0), sample_ref jsonb NOT NULL,
CHECK(window_end > window_start),
FOREIGN KEY(org_id,application_id) REFERENCES application(org_id,id),
UNIQUE(org_id,application_id,cohort_hash,metric_version,window_start,window_end,observed_at),
embargo_group_id uuid, FOREIGN KEY(org_id,embargo_group_id) REFERENCES security_group(org_id,id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE autonomy_policy_decision (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  application_id uuid NOT NULL, cohort_hash text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
direction text NOT NULL CHECK(direction IN ('establish','relax','tighten')),
actor_kind text NOT NULL CHECK(actor_kind IN ('human','authorized_rule')), actor_id text NOT NULL,
decision_ref jsonb NOT NULL, authority_ref jsonb NOT NULL, ledger_refs jsonb NOT NULL,
expires_at timestamptz NOT NULL, CHECK(direction <> 'relax' OR actor_kind='human'),
FOREIGN KEY(org_id,application_id) REFERENCES application(org_id,id),
UNIQUE(org_id,application_id,cohort_hash,revision),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE review_mode_decision (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  application_id uuid NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
review_mode text NOT NULL CHECK(review_mode='ai_only'), scope jsonb NOT NULL,
policy_owner_id uuid NOT NULL, application_owner_id uuid NOT NULL,
actor_kind text NOT NULL CHECK(actor_kind='human'),
subject_hash text NOT NULL CHECK(subject_hash ~ '^[0-9a-f]{64}$'),
decision_ref jsonb NOT NULL, owner_approval_refs jsonb NOT NULL,
qualification_cohort_ref jsonb NOT NULL, reviewer_qualification_refs jsonb NOT NULL,
degradation_policy_ref jsonb NOT NULL, audit_policy_ref jsonb NOT NULL,
audit_sample_basis_points integer NOT NULL CHECK(audit_sample_basis_points BETWEEN 1 AND 10000),
repository_binding_state text NOT NULL CHECK(repository_binding_state IN ('pre_repository','bound')),
repository_intent_policy_ref jsonb,
dev_repository_id uuid, dev_branch text NOT NULL CHECK(length(dev_branch)>0),
factory_git_identity_ref jsonb NOT NULL, branch_protection_evidence_ref jsonb,
CHECK((repository_binding_state='pre_repository' AND repository_intent_policy_ref IS NOT NULL
       AND dev_repository_id IS NULL AND branch_protection_evidence_ref IS NULL)
   OR (repository_binding_state='bound' AND dev_repository_id IS NOT NULL AND branch_protection_evidence_ref IS NOT NULL)),
policy_owner_approved_at timestamptz NOT NULL, application_owner_approved_at timestamptz NOT NULL,
valid_from timestamptz NOT NULL, expires_at timestamptz NOT NULL CHECK(expires_at > valid_from),
CHECK(policy_owner_approved_at <= valid_from AND application_owner_approved_at <= valid_from),
FOREIGN KEY(org_id,application_id) REFERENCES application(org_id,id),
FOREIGN KEY(org_id,policy_owner_id) REFERENCES principal(org_id,id),
FOREIGN KEY(org_id,application_owner_id) REFERENCES principal(org_id,id),
FOREIGN KEY(org_id,dev_repository_id) REFERENCES repository(org_id,id),
UNIQUE(org_id,application_id,revision), UNIQUE(org_id,application_id,id),
UNIQUE(org_id,application_id,id,audit_sample_basis_points),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE review_mode_repository_binding (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  application_id uuid NOT NULL, review_mode_decision_id uuid NOT NULL,
repository_intent_policy_ref jsonb NOT NULL, bootstrap_receipt_ref jsonb NOT NULL,
dev_repository_id uuid NOT NULL, dev_branch text NOT NULL CHECK(length(dev_branch)>0),
factory_git_identity_ref jsonb NOT NULL, branch_protection_evidence_ref jsonb NOT NULL,
binding_ref jsonb NOT NULL, bound_at timestamptz NOT NULL,
FOREIGN KEY(org_id,application_id,review_mode_decision_id) REFERENCES review_mode_decision(org_id,application_id,id),
FOREIGN KEY(org_id,dev_repository_id) REFERENCES repository(org_id,id),
UNIQUE(org_id,application_id,review_mode_decision_id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE review_mode_transition (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  application_id uuid NOT NULL, decision_id uuid NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
effective_mode text NOT NULL CHECK(effective_mode='human'),
reason text NOT NULL CHECK(reason IN ('revoked','expired','emergency_stop','degraded','configuration_changed')),
actor_kind text NOT NULL CHECK(actor_kind IN ('human','authorized_rule')),
authority_ref jsonb NOT NULL, transition_ref jsonb NOT NULL, effective_at timestamptz NOT NULL,
FOREIGN KEY(org_id,application_id,decision_id) REFERENCES review_mode_decision(org_id,application_id,id),
UNIQUE(org_id,application_id,revision),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE ai_review_decision (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, application_id uuid NOT NULL, review_mode_decision_id uuid NOT NULL,
decision_kind text NOT NULL CHECK(decision_kind='ai_review'),
gate_id text NOT NULL CHECK(gate_id IN ('intent_aligned','architecture_accepted','plan_accepted','plan_peer_approved','oracle_accepted','pr_review')),
subject_hash text NOT NULL CHECK(subject_hash ~ '^[0-9a-f]{64}$'), subject_ref jsonb NOT NULL,
assignment_ref jsonb NOT NULL, reviewer_slot_id text NOT NULL, reviewer_configuration_ref jsonb NOT NULL,
model_family text NOT NULL CHECK(length(model_family)>0), review_round integer NOT NULL CHECK(review_round>0),
verdict text NOT NULL CHECK(verdict IN ('approve','reject','request_changes')),
decision_ref jsonb NOT NULL, finding_refs jsonb NOT NULL, submitted_at timestamptz NOT NULL,
FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id),
FOREIGN KEY(org_id,application_id,review_mode_decision_id) REFERENCES review_mode_decision(org_id,application_id,id),
UNIQUE(org_id,task_id,gate_id,subject_hash,assignment_ref,reviewer_slot_id,review_round),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE review_audit_selection (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, application_id uuid NOT NULL, review_mode_decision_id uuid NOT NULL,
selected boolean NOT NULL, selected_at timestamptz NOT NULL,
sample_basis_points integer NOT NULL CHECK(sample_basis_points BETWEEN 1 AND 10000),
selection_ref jsonb NOT NULL,
FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id),
FOREIGN KEY(org_id,application_id,review_mode_decision_id,sample_basis_points)
  REFERENCES review_mode_decision(org_id,application_id,id,audit_sample_basis_points),
UNIQUE(org_id,task_id), UNIQUE(org_id,task_id,id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE review_audit_result (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, selection_id uuid NOT NULL, auditor_principal_id uuid NOT NULL,
actor_kind text NOT NULL CHECK(actor_kind='human'), outcome_ref jsonb NOT NULL,
result text NOT NULL CHECK(result IN ('pass','missed_defect','inconclusive')),
result_ref jsonb NOT NULL, finding_refs jsonb NOT NULL, completed_at timestamptz NOT NULL,
FOREIGN KEY(org_id,task_id,selection_id) REFERENCES review_audit_selection(org_id,task_id,id),
FOREIGN KEY(org_id,auditor_principal_id) REFERENCES principal(org_id,id),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE design_delivery (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, task_delivery_scope text NOT NULL DEFAULT 'design' CHECK(task_delivery_scope='design'),
application_id uuid NOT NULL,
work_type text NOT NULL CHECK(work_type IN ('feature','refactor','performance','platform')),
target_kind text NOT NULL CHECK(target_kind IN ('new_application','existing_application')),
template_id text NOT NULL CHECK(template_id IN ('greenfield_design','feature_design','refactor_design','performance_design','platform_design')),
template_version text NOT NULL, design_profile text NOT NULL CHECK(design_profile='design-delivery/1.0'),
packet_ref jsonb NOT NULL, subject_ref jsonb NOT NULL, subject_hash text NOT NULL CHECK(subject_hash ~ '^[0-9a-f]{64}$'),
basis_ref jsonb NOT NULL, basis_hash text NOT NULL CHECK(basis_hash ~ '^[0-9a-f]{64}$'),
approval_refs jsonb NOT NULL CHECK(jsonb_typeof(approval_refs)='array' AND jsonb_array_length(approval_refs) BETWEEN 3 AND 4),
review_mode text NOT NULL CHECK(review_mode IN ('human','ai_only')), review_mode_decision_id uuid,
CHECK((review_mode='ai_only') = (review_mode_decision_id IS NOT NULL)),
rendered_ref jsonb NOT NULL, renderer_version text NOT NULL CHECK(length(renderer_version)>0),
delivery_kind text NOT NULL CHECK(delivery_kind IN ('design_pr','report')),
git_change_id uuid, report_artifact_id uuid,
CHECK((delivery_kind='design_pr' AND git_change_id IS NOT NULL AND report_artifact_id IS NULL)
   OR (delivery_kind='report' AND report_artifact_id IS NOT NULL AND git_change_id IS NULL)),
data_classification text NOT NULL CHECK(length(data_classification)>0),
record_ref jsonb NOT NULL, approved_at timestamptz NOT NULL, delivered_at timestamptz NOT NULL,
approvals_expire_at timestamptz NOT NULL,
CHECK(approved_at <= delivered_at AND delivered_at < approvals_expire_at),
FOREIGN KEY(org_id,task_id,task_delivery_scope) REFERENCES task(org_id,id,delivery_scope),
FOREIGN KEY(org_id,application_id) REFERENCES application(org_id,id),
FOREIGN KEY(org_id,application_id,review_mode_decision_id) REFERENCES review_mode_decision(org_id,application_id,id),
FOREIGN KEY(org_id,git_change_id) REFERENCES git_change(org_id,id),
FOREIGN KEY(org_id,report_artifact_id) REFERENCES artifact(org_id,id),
UNIQUE(org_id,task_id,subject_hash), UNIQUE(org_id,task_id,id,subject_hash),
  PRIMARY KEY (org_id,id)
);

CREATE TABLE design_build_binding (
  org_id uuid NOT NULL REFERENCES organization(id),
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  task_id uuid NOT NULL, design_task_id uuid NOT NULL, design_delivery_id uuid NOT NULL,
subject_hash text NOT NULL CHECK(subject_hash ~ '^[0-9a-f]{64}$'), CHECK(task_id <> design_task_id),
current_basis_hash text NOT NULL CHECK(current_basis_hash ~ '^[0-9a-f]{64}$'),
result text NOT NULL CHECK(result IN ('reuse','replan')),
drift jsonb NOT NULL CHECK(jsonb_typeof(drift)='array'),
reopened_section_ids jsonb NOT NULL CHECK(jsonb_typeof(reopened_section_ids)='array'),
rerequested_gate_ids jsonb NOT NULL CHECK(jsonb_typeof(rerequested_gate_ids)='array'),
replacement_packet_ref jsonb,
CHECK((result='reuse' AND drift='[]'::jsonb AND reopened_section_ids='[]'::jsonb
       AND rerequested_gate_ids='[]'::jsonb AND replacement_packet_ref IS NULL)
   OR (result='replan' AND jsonb_array_length(drift)>0 AND jsonb_array_length(rerequested_gate_ids)>0
       AND (jsonb_array_length(reopened_section_ids)=0 OR replacement_packet_ref IS NOT NULL))),
binding_ref jsonb NOT NULL, evaluated_at timestamptz NOT NULL,
FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id),
FOREIGN KEY(org_id,design_task_id,design_delivery_id,subject_hash) REFERENCES design_delivery(org_id,task_id,id,subject_hash),
UNIQUE(org_id,task_id,design_delivery_id,current_basis_hash,result,evaluated_at),
  PRIMARY KEY (org_id,id)
);

ALTER TABLE application ADD CONSTRAINT application_current_definition_fk FOREIGN KEY(org_id,current_definition_id) REFERENCES definition_version(org_id,id);
ALTER TABLE artifact_upload ADD FOREIGN KEY(org_id,task_id) REFERENCES task(org_id,id), ADD FOREIGN KEY(org_id,stage_run_id) REFERENCES stage_run(org_id,id);
ALTER TABLE stage_run ADD UNIQUE(org_id,task_id,id);
ALTER TABLE artifact_upload ADD FOREIGN KEY(org_id,task_id,stage_run_id) REFERENCES stage_run(org_id,task_id,id);
ALTER TABLE decision ADD FOREIGN KEY(org_id,command_id) REFERENCES command(org_id,id);
CREATE UNIQUE INDEX one_active_application_bootstrap ON application_bootstrap(org_id,application_id) WHERE state NOT IN ('ready','cancelled','failed');
CREATE UNIQUE INDEX intent_owner_request ON decision_request(org_id,task_id,subject_hash,required_principal_id) WHERE action='confirm_intent';
CREATE UNIQUE INDEX plan_peer_request ON decision_request(org_id,task_id,subject_hash,required_principal_id) WHERE action='approve_plan';
CREATE UNIQUE INDEX rule_exception_approver_request ON decision_request(org_id,task_id,subject_hash,required_principal_id) WHERE action='approve_rule_exception';
CREATE UNIQUE INDEX one_stage_result_proposal ON factory_tool_call(org_id,stage_run_id) WHERE proposal_accepted;
CREATE INDEX pr_review_wait_idx ON pr_review_state(org_id,phase,review_deadline);
CREATE INDEX review_mode_expiry_idx ON review_mode_decision(org_id,application_id,expires_at);
CREATE INDEX review_audit_backlog_idx ON review_audit_selection(org_id,selected,selected_at);
CREATE INDEX health_cohort_idx ON application_health_sample(org_id,application_id,cohort_hash,observed_at DESC);
CREATE INDEX task_status_idx ON task(org_id,status,updated_at DESC,id);
CREATE INDEX task_list_cursor_idx ON task(org_id,created_at DESC,id DESC);
CREATE INDEX stage_task_idx ON stage_run(org_id,task_id,node_id,semantic_attempt);
CREATE INDEX stage_input_idx ON stage_run(org_id,input_hash);
CREATE INDEX gate_binding_idx ON gate_evaluation(org_id,task_id,gate_id,input_hash);
CREATE INDEX workspace_lease_idx ON workspace(org_id,state,lease_until);
CREATE INDEX allocation_workspace_epoch_idx ON execution_allocation(org_id,workspace_id,owner_epoch DESC);
CREATE INDEX environment_cleanup_idx ON environment(org_id,cleanup_state,expires_at);
CREATE INDEX operation_reconcile_idx ON external_operation(org_id,state,reconcile_after);
CREATE INDEX outbox_due_idx ON outbox(org_id,state,available_at,lease_until);
CREATE INDEX knowledge_search_idx ON knowledge_record USING gin(search_vector);
CREATE INDEX knowledge_signature_digest_idx ON knowledge_record(org_id,signature_digest);
CREATE INDEX knowledge_signature_keys_idx ON knowledge_record USING gin(signature_keys);
CREATE INDEX artifact_retention_idx ON artifact(org_id,retention_until);
CREATE INDEX artifact_link_root_idx ON artifact_link(org_id,task_id,artifact_id);
CREATE UNIQUE INDEX one_active_allocation ON execution_allocation(org_id,stage_run_id) WHERE state IN ('desired','starting','running','suspect','stopping','finalizing');
CREATE UNIQUE INDEX one_live_checkpoint_job ON checkpoint_job(org_id,allocation_id) WHERE state IN ('desired','starting','running','quarantined');
-- Runtime roles MUST NOT own these tables or have SUPERUSER/BYPASSRLS.
-- API/worker authorize tenant, then SET LOCAL factory.org_id inside each transaction.
-- Dispatcher enumerates authorized organizations and opens a scoped transaction per tenant.
-- Migration/admin credentials are separate and never mounted in execution Jobs.
ALTER TABLE principal ENABLE ROW LEVEL SECURITY;
ALTER TABLE principal FORCE ROW LEVEL SECURITY;
CREATE POLICY principal_org_scope ON principal USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_org_scope ON membership USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE security_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_group FORCE ROW LEVEL SECURITY;
CREATE POLICY security_group_org_scope ON security_group USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE security_group_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_group_member FORCE ROW LEVEL SECURITY;
CREATE POLICY security_group_member_org_scope ON security_group_member USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE repository ENABLE ROW LEVEL SECURITY;
ALTER TABLE repository FORCE ROW LEVEL SECURITY;
CREATE POLICY repository_org_scope ON repository USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE application ENABLE ROW LEVEL SECURITY;
ALTER TABLE application FORCE ROW LEVEL SECURITY;
CREATE POLICY application_org_scope ON application USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE artifact ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_org_scope ON artifact USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE artifact_upload ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_upload FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_upload_org_scope ON artifact_upload USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE definition_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE definition_version FORCE ROW LEVEL SECURITY;
CREATE POLICY definition_version_org_scope ON definition_version USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE registry_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry_import FORCE ROW LEVEL SECURITY;
CREATE POLICY registry_import_org_scope ON registry_import USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE application_repository ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_repository FORCE ROW LEVEL SECURITY;
CREATE POLICY application_repository_org_scope ON application_repository USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE observation FORCE ROW LEVEL SECURITY;
CREATE POLICY observation_org_scope ON observation USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE relationship ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationship FORCE ROW LEVEL SECURITY;
CREATE POLICY relationship_org_scope ON relationship USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE task ENABLE ROW LEVEL SECURITY;
ALTER TABLE task FORCE ROW LEVEL SECURITY;
CREATE POLICY task_org_scope ON task USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE application_draft_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_draft_version FORCE ROW LEVEL SECURITY;
CREATE POLICY application_draft_version_org_scope ON application_draft_version USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE application_bootstrap ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_bootstrap FORCE ROW LEVEL SECURITY;
CREATE POLICY application_bootstrap_org_scope ON application_bootstrap USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE task_spec_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_spec_version FORCE ROW LEVEL SECURITY;
CREATE POLICY task_spec_version_org_scope ON task_spec_version USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE task_dependency ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_dependency FORCE ROW LEVEL SECURITY;
CREATE POLICY task_dependency_org_scope ON task_dependency USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE workflow_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_binding FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_binding_org_scope ON workflow_binding USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE execution_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_plan FORCE ROW LEVEL SECURITY;
CREATE POLICY execution_plan_org_scope ON execution_plan USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE stage_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE stage_run FORCE ROW LEVEL SECURITY;
CREATE POLICY stage_run_org_scope ON stage_run USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_org_scope ON workspace USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE execution_allocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_allocation FORCE ROW LEVEL SECURITY;
CREATE POLICY execution_allocation_org_scope ON execution_allocation USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE checkpoint_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkpoint_job FORCE ROW LEVEL SECURITY;
CREATE POLICY checkpoint_job_org_scope ON checkpoint_job USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE session ENABLE ROW LEVEL SECURITY;
ALTER TABLE session FORCE ROW LEVEL SECURITY;
CREATE POLICY session_org_scope ON session USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE candidate ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate FORCE ROW LEVEL SECURITY;
CREATE POLICY candidate_org_scope ON candidate USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE artifact_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_link FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_link_org_scope ON artifact_link USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE gate_evaluation ENABLE ROW LEVEL SECURITY;
ALTER TABLE gate_evaluation FORCE ROW LEVEL SECURITY;
CREATE POLICY gate_evaluation_org_scope ON gate_evaluation USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE finding ENABLE ROW LEVEL SECURITY;
ALTER TABLE finding FORCE ROW LEVEL SECURITY;
CREATE POLICY finding_org_scope ON finding USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE decision_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_request FORCE ROW LEVEL SECURITY;
CREATE POLICY decision_request_org_scope ON decision_request USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision FORCE ROW LEVEL SECURITY;
CREATE POLICY decision_org_scope ON decision USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE command ENABLE ROW LEVEL SECURITY;
ALTER TABLE command FORCE ROW LEVEL SECURITY;
CREATE POLICY command_org_scope ON command USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE plan_review_comment ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_review_comment FORCE ROW LEVEL SECURITY;
CREATE POLICY plan_review_comment_org_scope ON plan_review_comment USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE task_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_event FORCE ROW LEVEL SECURITY;
CREATE POLICY task_event_org_scope ON task_event USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE external_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY external_operation_org_scope ON external_operation USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE environment ENABLE ROW LEVEL SECURITY;
ALTER TABLE environment FORCE ROW LEVEL SECURITY;
CREATE POLICY environment_org_scope ON environment USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE git_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE git_change FORCE ROW LEVEL SECURITY;
CREATE POLICY git_change_org_scope ON git_change USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE knowledge_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_record FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_record_org_scope ON knowledge_record USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE knowledge_dispute ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_dispute FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_dispute_org_scope ON knowledge_dispute USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE budget_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_account FORCE ROW LEVEL SECURITY;
CREATE POLICY budget_account_org_scope ON budget_account USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE budget_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY budget_ledger_org_scope ON budget_ledger USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE capacity_reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE capacity_reservation FORCE ROW LEVEL SECURITY;
CREATE POLICY capacity_reservation_org_scope ON capacity_reservation USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_org_scope ON outbox USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY inbox_org_scope ON inbox USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE idempotency_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_record FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_record_org_scope ON idempotency_record USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_event FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_event_org_scope ON audit_event USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE factory_tool_call ENABLE ROW LEVEL SECURITY;
ALTER TABLE factory_tool_call FORCE ROW LEVEL SECURITY;
CREATE POLICY factory_tool_call_org_scope ON factory_tool_call USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE pr_review_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_review_state FORCE ROW LEVEL SECURITY;
CREATE POLICY pr_review_state_org_scope ON pr_review_state USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE application_health_sample ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_health_sample FORCE ROW LEVEL SECURITY;
CREATE POLICY application_health_sample_org_scope ON application_health_sample USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE autonomy_policy_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE autonomy_policy_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY autonomy_policy_decision_org_scope ON autonomy_policy_decision USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE review_mode_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_mode_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY review_mode_decision_org_scope ON review_mode_decision USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE review_mode_repository_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_mode_repository_binding FORCE ROW LEVEL SECURITY;
CREATE POLICY review_mode_repository_binding_org_scope ON review_mode_repository_binding USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE review_mode_transition ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_mode_transition FORCE ROW LEVEL SECURITY;
CREATE POLICY review_mode_transition_org_scope ON review_mode_transition USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE ai_review_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_review_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_review_decision_org_scope ON ai_review_decision USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE review_audit_selection ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_audit_selection FORCE ROW LEVEL SECURITY;
CREATE POLICY review_audit_selection_org_scope ON review_audit_selection USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE review_audit_result ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_audit_result FORCE ROW LEVEL SECURITY;
CREATE POLICY review_audit_result_org_scope ON review_audit_result USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE design_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE design_delivery FORCE ROW LEVEL SECURITY;
CREATE POLICY design_delivery_org_scope ON design_delivery USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
ALTER TABLE design_build_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE design_build_binding FORCE ROW LEVEL SECURITY;
CREATE POLICY design_build_binding_org_scope ON design_build_binding USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
-- factory.principal_id is set only from authenticated human/workload identity.
-- Workers need explicit group membership; an operator role alone cannot read embargoed work.
-- ArtifactStore labels artifacts BEFORE upload/finalization, including logs and receipts;
-- group-aware deduplication must never reuse an ordinary artifact row for embargoed output.
-- Outbox/inbox/audit/registry projections inherit the source group before insertion.
-- Embargo lift is an exact-subject human decision; disclosure copies may be released only
-- for its approved scope. Original artifacts retain their immutable labels.
CREATE POLICY application_health_sample_embargo ON application_health_sample AS RESTRICTIVE USING ((application_health_sample.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=application_health_sample.org_id AND m.group_id=application_health_sample.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL))) WITH CHECK ((application_health_sample.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=application_health_sample.org_id AND m.group_id=application_health_sample.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL)));
CREATE POLICY artifact_embargo ON artifact AS RESTRICTIVE USING ((artifact.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=artifact.org_id AND m.group_id=artifact.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL))) WITH CHECK ((artifact.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=artifact.org_id AND m.group_id=artifact.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL)));
CREATE POLICY artifact_upload_embargo ON artifact_upload AS RESTRICTIVE USING ((artifact_upload.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=artifact_upload.org_id AND m.group_id=artifact_upload.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL))) WITH CHECK ((artifact_upload.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=artifact_upload.org_id AND m.group_id=artifact_upload.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL)));
CREATE POLICY audit_event_embargo ON audit_event AS RESTRICTIVE USING ((audit_event.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=audit_event.org_id AND m.group_id=audit_event.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL))) WITH CHECK ((audit_event.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=audit_event.org_id AND m.group_id=audit_event.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL)));
CREATE POLICY definition_version_embargo ON definition_version AS RESTRICTIVE USING ((definition_version.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=definition_version.org_id AND m.group_id=definition_version.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL))) WITH CHECK ((definition_version.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=definition_version.org_id AND m.group_id=definition_version.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL)));
CREATE POLICY idempotency_record_embargo ON idempotency_record AS RESTRICTIVE USING ((idempotency_record.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=idempotency_record.org_id AND m.group_id=idempotency_record.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL))) WITH CHECK ((idempotency_record.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=idempotency_record.org_id AND m.group_id=idempotency_record.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL)));
CREATE POLICY inbox_embargo ON inbox AS RESTRICTIVE USING ((inbox.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=inbox.org_id AND m.group_id=inbox.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL))) WITH CHECK ((inbox.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=inbox.org_id AND m.group_id=inbox.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL)));
CREATE POLICY observation_embargo ON observation AS RESTRICTIVE USING ((observation.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=observation.org_id AND m.group_id=observation.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL))) WITH CHECK ((observation.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=observation.org_id AND m.group_id=observation.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL)));
CREATE POLICY outbox_embargo ON outbox AS RESTRICTIVE USING ((outbox.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=outbox.org_id AND m.group_id=outbox.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL))) WITH CHECK ((outbox.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=outbox.org_id AND m.group_id=outbox.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL)));
CREATE POLICY registry_import_embargo ON registry_import AS RESTRICTIVE USING ((registry_import.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=registry_import.org_id AND m.group_id=registry_import.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL))) WITH CHECK ((registry_import.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=registry_import.org_id AND m.group_id=registry_import.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL)));
CREATE POLICY relationship_embargo ON relationship AS RESTRICTIVE USING ((relationship.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=relationship.org_id AND m.group_id=relationship.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL))) WITH CHECK ((relationship.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=relationship.org_id AND m.group_id=relationship.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL)));
CREATE POLICY repository_embargo ON repository AS RESTRICTIVE USING ((repository.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=repository.org_id AND m.group_id=repository.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL))) WITH CHECK ((repository.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=repository.org_id AND m.group_id=repository.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL)));
CREATE POLICY task_embargo ON task AS RESTRICTIVE USING ((task.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=task.org_id AND m.group_id=task.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL))) WITH CHECK ((task.embargo_group_id IS NULL OR EXISTS (SELECT 1 FROM security_group_member m WHERE m.org_id=task.org_id AND m.group_id=task.embargo_group_id AND m.principal_id=nullif(current_setting('factory.principal_id',true),'')::uuid AND m.revoked_at IS NULL)));
CREATE POLICY application_bootstrap_task_visibility ON application_bootstrap AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=application_bootstrap.org_id AND t.id=application_bootstrap.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=application_bootstrap.org_id AND t.id=application_bootstrap.task_id));
CREATE POLICY task_spec_version_task_visibility ON task_spec_version AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=task_spec_version.org_id AND t.id=task_spec_version.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=task_spec_version.org_id AND t.id=task_spec_version.task_id));
CREATE POLICY task_dependency_task_visibility ON task_dependency AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=task_dependency.org_id AND t.id=task_dependency.task_id) AND EXISTS (SELECT 1 FROM task p WHERE p.org_id=task_dependency.org_id AND p.id=task_dependency.prerequisite_task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=task_dependency.org_id AND t.id=task_dependency.task_id) AND EXISTS (SELECT 1 FROM task p WHERE p.org_id=task_dependency.org_id AND p.id=task_dependency.prerequisite_task_id));
CREATE POLICY workflow_binding_task_visibility ON workflow_binding AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=workflow_binding.org_id AND t.id=workflow_binding.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=workflow_binding.org_id AND t.id=workflow_binding.task_id));
CREATE POLICY execution_plan_task_visibility ON execution_plan AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=execution_plan.org_id AND t.id=execution_plan.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=execution_plan.org_id AND t.id=execution_plan.task_id));
CREATE POLICY stage_run_task_visibility ON stage_run AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=stage_run.org_id AND t.id=stage_run.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=stage_run.org_id AND t.id=stage_run.task_id));
CREATE POLICY workspace_task_visibility ON workspace AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=workspace.org_id AND t.id=workspace.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=workspace.org_id AND t.id=workspace.task_id));
CREATE POLICY session_task_visibility ON session AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=session.org_id AND t.id=session.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=session.org_id AND t.id=session.task_id));
CREATE POLICY candidate_task_visibility ON candidate AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=candidate.org_id AND t.id=candidate.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=candidate.org_id AND t.id=candidate.task_id));
CREATE POLICY artifact_link_task_visibility ON artifact_link AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=artifact_link.org_id AND t.id=artifact_link.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=artifact_link.org_id AND t.id=artifact_link.task_id));
CREATE POLICY gate_evaluation_task_visibility ON gate_evaluation AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=gate_evaluation.org_id AND t.id=gate_evaluation.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=gate_evaluation.org_id AND t.id=gate_evaluation.task_id));
CREATE POLICY finding_task_visibility ON finding AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=finding.org_id AND t.id=finding.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=finding.org_id AND t.id=finding.task_id));
CREATE POLICY decision_request_task_visibility ON decision_request AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=decision_request.org_id AND t.id=decision_request.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=decision_request.org_id AND t.id=decision_request.task_id));
CREATE POLICY command_task_visibility ON command AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=command.org_id AND t.id=command.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=command.org_id AND t.id=command.task_id));
CREATE POLICY plan_review_comment_task_visibility ON plan_review_comment AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=plan_review_comment.org_id AND t.id=plan_review_comment.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=plan_review_comment.org_id AND t.id=plan_review_comment.task_id));
CREATE POLICY task_event_task_visibility ON task_event AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=task_event.org_id AND t.id=task_event.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=task_event.org_id AND t.id=task_event.task_id));
CREATE POLICY external_operation_task_visibility ON external_operation AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=external_operation.org_id AND t.id=external_operation.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=external_operation.org_id AND t.id=external_operation.task_id));
CREATE POLICY environment_task_visibility ON environment AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=environment.org_id AND t.id=environment.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=environment.org_id AND t.id=environment.task_id));
CREATE POLICY git_change_task_visibility ON git_change AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=git_change.org_id AND t.id=git_change.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=git_change.org_id AND t.id=git_change.task_id));
CREATE POLICY knowledge_record_task_visibility ON knowledge_record AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=knowledge_record.org_id AND t.id=knowledge_record.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=knowledge_record.org_id AND t.id=knowledge_record.task_id));
CREATE POLICY budget_account_task_visibility ON budget_account AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=budget_account.org_id AND t.id=budget_account.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=budget_account.org_id AND t.id=budget_account.task_id));
CREATE POLICY capacity_reservation_task_visibility ON capacity_reservation AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=capacity_reservation.org_id AND t.id=capacity_reservation.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=capacity_reservation.org_id AND t.id=capacity_reservation.task_id));
CREATE POLICY factory_tool_call_task_visibility ON factory_tool_call AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=factory_tool_call.org_id AND t.id=factory_tool_call.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=factory_tool_call.org_id AND t.id=factory_tool_call.task_id));
CREATE POLICY pr_review_state_task_visibility ON pr_review_state AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=pr_review_state.org_id AND t.id=pr_review_state.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=pr_review_state.org_id AND t.id=pr_review_state.task_id));
CREATE POLICY ai_review_decision_task_visibility ON ai_review_decision AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=ai_review_decision.org_id AND t.id=ai_review_decision.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=ai_review_decision.org_id AND t.id=ai_review_decision.task_id));
CREATE POLICY review_audit_selection_task_visibility ON review_audit_selection AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=review_audit_selection.org_id AND t.id=review_audit_selection.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=review_audit_selection.org_id AND t.id=review_audit_selection.task_id));
CREATE POLICY review_audit_result_task_visibility ON review_audit_result AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=review_audit_result.org_id AND t.id=review_audit_result.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=review_audit_result.org_id AND t.id=review_audit_result.task_id));
CREATE POLICY design_delivery_task_visibility ON design_delivery AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=design_delivery.org_id AND t.id=design_delivery.task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=design_delivery.org_id AND t.id=design_delivery.task_id));
CREATE POLICY design_build_binding_task_visibility ON design_build_binding AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM task t WHERE t.org_id=design_build_binding.org_id AND t.id=design_build_binding.task_id) AND EXISTS (SELECT 1 FROM task d WHERE d.org_id=design_build_binding.org_id AND d.id=design_build_binding.design_task_id)) WITH CHECK (EXISTS (SELECT 1 FROM task t WHERE t.org_id=design_build_binding.org_id AND t.id=design_build_binding.task_id) AND EXISTS (SELECT 1 FROM task d WHERE d.org_id=design_build_binding.org_id AND d.id=design_build_binding.design_task_id));
CREATE POLICY execution_allocation_task_visibility ON execution_allocation AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM stage_run p WHERE p.org_id=execution_allocation.org_id AND p.id=execution_allocation.stage_run_id)) WITH CHECK (EXISTS (SELECT 1 FROM stage_run p WHERE p.org_id=execution_allocation.org_id AND p.id=execution_allocation.stage_run_id));
CREATE POLICY checkpoint_job_task_visibility ON checkpoint_job AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM execution_allocation p WHERE p.org_id=checkpoint_job.org_id AND p.id=checkpoint_job.allocation_id)) WITH CHECK (EXISTS (SELECT 1 FROM execution_allocation p WHERE p.org_id=checkpoint_job.org_id AND p.id=checkpoint_job.allocation_id));
CREATE POLICY decision_task_visibility ON decision AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM decision_request p WHERE p.org_id=decision.org_id AND p.id=decision.request_id)) WITH CHECK (EXISTS (SELECT 1 FROM decision_request p WHERE p.org_id=decision.org_id AND p.id=decision.request_id));
CREATE POLICY budget_ledger_task_visibility ON budget_ledger AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM budget_account p WHERE p.org_id=budget_ledger.org_id AND p.id=budget_ledger.account_id)) WITH CHECK (EXISTS (SELECT 1 FROM budget_account p WHERE p.org_id=budget_ledger.org_id AND p.id=budget_ledger.account_id));
CREATE POLICY artifact_upload_task_visibility ON artifact_upload AS RESTRICTIVE USING ((artifact_upload.reservation_scope <> 'task_stage' OR EXISTS (SELECT 1 FROM task t WHERE t.org_id=artifact_upload.org_id AND t.id=artifact_upload.task_id))) WITH CHECK ((artifact_upload.reservation_scope <> 'task_stage' OR EXISTS (SELECT 1 FROM task t WHERE t.org_id=artifact_upload.org_id AND t.id=artifact_upload.task_id)));
CREATE POLICY knowledge_dispute_visibility ON knowledge_dispute AS RESTRICTIVE USING (EXISTS (SELECT 1 FROM knowledge_record k WHERE k.org_id=knowledge_dispute.org_id AND k.id=knowledge_dispute.record_id) AND EXISTS (SELECT 1 FROM knowledge_record k WHERE k.org_id=knowledge_dispute.org_id AND k.id=knowledge_dispute.disputing_record_id)) WITH CHECK (EXISTS (SELECT 1 FROM knowledge_record k WHERE k.org_id=knowledge_dispute.org_id AND k.id=knowledge_dispute.record_id) AND EXISTS (SELECT 1 FROM knowledge_record k WHERE k.org_id=knowledge_dispute.org_id AND k.id=knowledge_dispute.disputing_record_id));
CREATE FUNCTION guard_artifact_link_embargo() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE task_group uuid; artifact_group uuid;
BEGIN
  SELECT embargo_group_id INTO task_group FROM task WHERE org_id=NEW.org_id AND id=NEW.task_id;
  SELECT embargo_group_id INTO artifact_group FROM artifact WHERE org_id=NEW.org_id AND id=NEW.artifact_id;
  IF NOT FOUND OR (task_group IS NOT NULL AND artifact_group IS DISTINCT FROM task_group)
    OR (task_group IS NULL AND artifact_group IS NOT NULL) THEN
    RAISE EXCEPTION 'artifact confidentiality does not match task';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER artifact_link_embargo BEFORE INSERT ON artifact_link
  FOR EACH ROW EXECUTE FUNCTION guard_artifact_link_embargo();
CREATE FUNCTION guard_child_embargo() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_group uuid;
BEGIN
  IF NEW.parent_task_id IS NOT NULL THEN
    SELECT embargo_group_id INTO parent_group FROM task
      WHERE org_id=NEW.org_id AND id=NEW.parent_task_id;
    IF NOT FOUND OR (parent_group IS NOT NULL AND NEW.embargo_group_id IS DISTINCT FROM parent_group) THEN
      RAISE EXCEPTION 'child must inherit parent confidentiality';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER child_embargo BEFORE INSERT ON task
  FOR EACH ROW EXECUTE FUNCTION guard_child_embargo();
-- The caller may omit the initial owner; creation defaults it to the authenticated creator.
CREATE FUNCTION initialize_task_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_principal_id IS NULL THEN NEW.owner_principal_id := NEW.creator_id; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_initial_owner BEFORE INSERT ON task
  FOR EACH ROW EXECUTE FUNCTION initialize_task_owner();

CREATE FUNCTION guard_stage_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('passed','failed','inconclusive','skipped','cancelled','awaiting_input')
     AND (to_jsonb(NEW) - ARRAY['superseded_at','superseded_by_plan_version','superseded_by_stage_run_id','updated_at'])
         IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['superseded_at','superseded_by_plan_version','superseded_by_stage_run_id','updated_at']) THEN
    RAISE EXCEPTION 'terminal stage outcome is immutable';
  END IF;
  IF (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at)
     OR (OLD.superseded_by_plan_version IS NOT NULL AND NEW.superseded_by_plan_version IS DISTINCT FROM OLD.superseded_by_plan_version)
     OR (OLD.superseded_by_stage_run_id IS NOT NULL AND NEW.superseded_by_stage_run_id IS DISTINCT FROM OLD.superseded_by_stage_run_id) THEN
    RAISE EXCEPTION 'stage supersession metadata is append-only';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stage_run_guard BEFORE UPDATE ON stage_run
  FOR EACH ROW EXECUTE FUNCTION guard_stage_run();

-- The controller authorizes admission and uses revision/generation compare-and-set.
-- Immutable operation requests retain each old/new plan, generation and admission evidence.
CREATE FUNCTION guard_environment_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.plan_ref IS DISTINCT FROM OLD.plan_ref THEN
    IF OLD.state IN ('retiring','retired') OR NEW.generation <> OLD.generation + 1
       OR NEW.revision <> OLD.revision + 1 OR NEW.current_operation_id IS NULL
       OR NEW.current_operation_id IS NOT DISTINCT FROM OLD.current_operation_id
       OR NEW.state <> 'planned' OR NEW.endpoints <> '[]'::jsonb
       OR NEW.observed_release_ref IS NOT NULL OR NEW.verification_ref IS NOT NULL
       OR NEW.deployment_status IS NOT NULL OR NEW.status_observed_at IS NOT NULL THEN
      RAISE EXCEPTION 'new environment plan requires a fresh generation and cleared evidence';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM external_operation WHERE org_id=NEW.org_id
        AND id=NEW.current_operation_id AND task_id=NEW.task_id AND provider=NEW.provider
        AND state='reserved') THEN
      RAISE EXCEPTION 'environment generation requires its reserved operation';
    END IF;
  ELSIF NEW.generation <> OLD.generation
        OR NEW.current_operation_id IS DISTINCT FROM OLD.current_operation_id THEN
    RAISE EXCEPTION 'environment generation binding changes only with a new plan';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER environment_generation_guard BEFORE UPDATE ON environment
  FOR EACH ROW EXECUTE FUNCTION guard_environment_generation();

CREATE FUNCTION guard_factory_tool_call() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['state','receipt_ref','result_ref','proposal_accepted','updated_at'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['state','receipt_ref','result_ref','proposal_accepted','updated_at']) THEN
    RAISE EXCEPTION 'factory tool request identity is immutable';
  END IF;
  IF OLD.proposal_accepted AND NOT NEW.proposal_accepted THEN
    RAISE EXCEPTION 'accepted proposal cannot be cleared';
  END IF;
  IF NOT OLD.proposal_accepted AND NEW.proposal_accepted AND NEW.state IN ('failed','rejected') THEN
    RAISE EXCEPTION 'failed or rejected call cannot accept a proposal';
  END IF;
  IF OLD.state IN ('finalized','failed','rejected') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'terminal tool call cannot transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER factory_tool_call_guard BEFORE UPDATE ON factory_tool_call
  FOR EACH ROW EXECUTE FUNCTION guard_factory_tool_call();

-- request_delivery may widen an implementation scope, but a design task never becomes
-- an implementation task (or the reverse); "build from this design" is a new linked task.
CREATE FUNCTION guard_task_delivery_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.delivery_scope = 'design') <> (NEW.delivery_scope = 'design') THEN
    RAISE EXCEPTION 'design delivery scope requires a new task';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_delivery_scope_guard BEFORE UPDATE ON task
  FOR EACH ROW EXECUTE FUNCTION guard_task_delivery_scope();

-- A build names its design source at admission and inherits that design's confidentiality;
-- work type, application and target context must match (chapter 19).
CREATE FUNCTION guard_task_design_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source task%ROWTYPE;
BEGIN
  IF NEW.design_source_task_id IS NOT NULL THEN
    SELECT * INTO source FROM task WHERE org_id=NEW.org_id AND id=NEW.design_source_task_id;
    IF source.id IS NULL OR source.delivery_scope <> 'design' OR NEW.work_type <> source.work_type
       OR NEW.primary_application_id <> source.primary_application_id OR NEW.target_kind <> source.target_kind
       OR NEW.embargo_group_id IS DISTINCT FROM source.embargo_group_id THEN
      RAISE EXCEPTION 'build must match its visible design source and inherit its security group';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_design_source_guard BEFORE INSERT ON task
  FOR EACH ROW EXECUTE FUNCTION guard_task_design_source();

-- A build binding belongs to the non-design task that named this design at admission,
-- with the delivery's application/target/work type, its security group and unexpired reuse.
CREATE FUNCTION guard_design_build_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE builder task%ROWTYPE; design task%ROWTYPE; dd design_delivery%ROWTYPE;
BEGIN
  SELECT * INTO builder FROM task WHERE org_id=NEW.org_id AND id=NEW.task_id;
  SELECT * INTO design FROM task WHERE org_id=NEW.org_id AND id=NEW.design_task_id;
  SELECT * INTO dd FROM design_delivery WHERE org_id=NEW.org_id AND id=NEW.design_delivery_id;
  IF builder.id IS NULL OR design.id IS NULL OR dd.id IS NULL OR builder.delivery_scope = 'design'
     OR design.delivery_scope <> 'design' OR builder.design_source_task_id IS DISTINCT FROM NEW.design_task_id
     OR builder.work_type <> dd.work_type OR builder.primary_application_id <> dd.application_id
     OR builder.target_kind <> dd.target_kind
     OR builder.embargo_group_id IS DISTINCT FROM design.embargo_group_id
     OR (NEW.result = 'reuse' AND NEW.evaluated_at >= dd.approvals_expire_at) THEN
    RAISE EXCEPTION 'build binding requires the matching non-design builder, same security group and unexpired reuse';
  END IF;
  -- Reusing AI approvals requires the authorizing decision to be in force at evaluated_at
  -- for THIS builder: in scope, not security/embargoed/incident, and no later revocation,
  -- expiry, emergency stop, degradation or cohort change recorded as a transition.
  IF NEW.result = 'reuse' AND dd.review_mode = 'ai_only' AND (
       builder.security IS NOT NULL OR builder.embargo_group_id IS NOT NULL
       OR builder.priority_class = 'incident' OR builder.incident_ref IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM review_mode_decision d WHERE d.org_id = NEW.org_id
            AND d.id = dd.review_mode_decision_id AND d.application_id = builder.primary_application_id
            AND d.valid_from <= NEW.evaluated_at AND NEW.evaluated_at < d.expires_at
            AND d.scope->'workTypes' ? builder.work_type AND d.scope->'changeClasses' ? builder.change_class)
       OR EXISTS (SELECT 1 FROM review_mode_transition t WHERE t.org_id = NEW.org_id
            AND t.decision_id = dd.review_mode_decision_id AND t.effective_at <= NEW.evaluated_at)) THEN
    RAISE EXCEPTION 'AI design approvals are not reusable: decision not in force for this build';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER design_build_binding_guard BEFORE INSERT ON design_build_binding
  FOR EACH ROW EXECUTE FUNCTION guard_design_build_binding();
-- Reference roles. Installations create LOGIN users as members of these group roles.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='factory_migrator') THEN
    CREATE ROLE factory_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='factory_runtime') THEN
    CREATE ROLE factory_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
END $$;
ALTER SCHEMA factory OWNER TO factory_migrator;
ALTER DOMAIN git_object_id OWNER TO factory_migrator;
ALTER FUNCTION initialize_task_owner() OWNER TO factory_migrator;
ALTER FUNCTION guard_artifact_link_embargo() OWNER TO factory_migrator;
ALTER FUNCTION guard_child_embargo() OWNER TO factory_migrator;
ALTER FUNCTION guard_factory_tool_call() OWNER TO factory_migrator;
ALTER FUNCTION guard_stage_run() OWNER TO factory_migrator;
ALTER FUNCTION guard_task_delivery_scope() OWNER TO factory_migrator;
ALTER FUNCTION guard_design_build_binding() OWNER TO factory_migrator;
ALTER FUNCTION guard_task_design_source() OWNER TO factory_migrator;
GRANT USAGE ON SCHEMA factory TO factory_runtime;
-- Organization provisioning belongs to migration/admin credentials. This lookup is intentionally unscoped.
GRANT SELECT (id, status) ON organization TO factory_runtime;
ALTER TABLE organization OWNER TO factory_migrator;
ALTER TABLE principal OWNER TO factory_migrator;
GRANT SELECT, INSERT ON principal TO factory_runtime;
GRANT UPDATE (display_name, disabled_at, updated_at) ON principal TO factory_runtime;
ALTER TABLE membership OWNER TO factory_migrator;
GRANT SELECT, INSERT ON membership TO factory_runtime;
GRANT UPDATE (application_scope, revoked_at, updated_at) ON membership TO factory_runtime;
ALTER TABLE security_group OWNER TO factory_migrator;
GRANT SELECT ON security_group TO factory_runtime;
ALTER TABLE security_group_member OWNER TO factory_migrator;
GRANT SELECT ON security_group_member TO factory_runtime;
ALTER TABLE repository OWNER TO factory_migrator;
GRANT SELECT, INSERT ON repository TO factory_runtime;
GRANT UPDATE (clone_url, default_branch, policy_ref, data_classification, updated_at) ON repository TO factory_runtime;
ALTER TABLE application OWNER TO factory_migrator;
GRANT SELECT, INSERT ON application TO factory_runtime;
GRANT UPDATE (name, owner_ids, lifecycle, current_definition_id, current_draft_revision, data_classification, updated_at) ON application TO factory_runtime;
ALTER TABLE artifact OWNER TO factory_migrator;
GRANT SELECT, INSERT ON artifact TO factory_runtime;
GRANT UPDATE (retention_until, updated_at) ON artifact TO factory_runtime;
ALTER TABLE artifact_upload OWNER TO factory_migrator;
GRANT SELECT, INSERT ON artifact_upload TO factory_runtime;
GRANT UPDATE (state, artifact_id, updated_at) ON artifact_upload TO factory_runtime;
ALTER TABLE definition_version OWNER TO factory_migrator;
GRANT SELECT, INSERT ON definition_version TO factory_runtime;
GRANT UPDATE (validation_state, updated_at) ON definition_version TO factory_runtime;
ALTER TABLE registry_import OWNER TO factory_migrator;
GRANT SELECT, INSERT ON registry_import TO factory_runtime;
GRANT UPDATE (state, result_ref, findings, updated_at) ON registry_import TO factory_runtime;
ALTER TABLE application_repository OWNER TO factory_migrator;
GRANT SELECT, INSERT ON application_repository TO factory_runtime;
ALTER TABLE observation OWNER TO factory_migrator;
GRANT SELECT, INSERT ON observation TO factory_runtime;
ALTER TABLE relationship OWNER TO factory_migrator;
GRANT SELECT, INSERT ON relationship TO factory_runtime;
ALTER TABLE task OWNER TO factory_migrator;
GRANT SELECT, INSERT ON task TO factory_runtime;
GRANT UPDATE (security, embargo_group_id, delivery_scope, priority_class, change_class, owner_principal_id, interactive_holder_principal_id, status, spec_version, control_revision, plan_version, projection_sequence, projection_hash, last_event_sequence, projected_at, current_node_id, outcome_ref, waiting_reason, intent_revision, intent_state_ref, plan_review_revision, plan_review_state_ref, cleanup_state, updated_at) ON task TO factory_runtime;
ALTER TABLE application_draft_version OWNER TO factory_migrator;
GRANT SELECT, INSERT ON application_draft_version TO factory_runtime;
ALTER TABLE application_bootstrap OWNER TO factory_migrator;
GRANT SELECT, INSERT ON application_bootstrap TO factory_runtime;
GRANT UPDATE (plan_ref, operation_refs, state, receipt_ref, disposition_ref, updated_at) ON application_bootstrap TO factory_runtime;
ALTER TABLE task_spec_version OWNER TO factory_migrator;
GRANT SELECT, INSERT ON task_spec_version TO factory_runtime;
ALTER TABLE task_dependency OWNER TO factory_migrator;
GRANT SELECT, INSERT ON task_dependency TO factory_runtime;
ALTER TABLE workflow_binding OWNER TO factory_migrator;
GRANT SELECT, INSERT ON workflow_binding TO factory_runtime;
GRANT UPDATE (current_run_id, template_id, template_version, template_ref, worker_build_id, last_observed_state, updated_at) ON workflow_binding TO factory_runtime;
ALTER TABLE execution_plan OWNER TO factory_migrator;
GRANT SELECT, INSERT ON execution_plan TO factory_runtime;
ALTER TABLE stage_run OWNER TO factory_migrator;
GRANT SELECT, INSERT ON stage_run TO factory_runtime;
GRANT UPDATE (status, result_ref, error_class, started_at, completed_at, superseded_at, superseded_by_plan_version, superseded_by_stage_run_id, updated_at) ON stage_run TO factory_runtime;
ALTER TABLE workspace OWNER TO factory_migrator;
GRANT SELECT, INSERT ON workspace TO factory_runtime;
GRANT UPDATE (candidate_commit, state, generation, owner_epoch, owner_pod_uid, lease_until, checkpoint_ref, updated_at) ON workspace TO factory_runtime;
ALTER TABLE execution_allocation OWNER TO factory_migrator;
GRANT SELECT, INSERT ON execution_allocation TO factory_runtime;
GRANT UPDATE (job_uid, pod_uid, state, controller_lease_until, last_heartbeat_at, terminated_at, updated_at) ON execution_allocation TO factory_runtime;
ALTER TABLE checkpoint_job OWNER TO factory_migrator;
GRANT SELECT, INSERT ON checkpoint_job TO factory_runtime;
GRANT UPDATE (job_uid, pod_uid, state, updated_at) ON checkpoint_job TO factory_runtime;
ALTER TABLE session OWNER TO factory_migrator;
GRANT SELECT, INSERT ON session TO factory_runtime;
GRANT UPDATE (native_state_ref, updated_at) ON session TO factory_runtime;
ALTER TABLE candidate OWNER TO factory_migrator;
GRANT SELECT, INSERT ON candidate TO factory_runtime;
ALTER TABLE artifact_link OWNER TO factory_migrator;
GRANT SELECT, INSERT ON artifact_link TO factory_runtime;
ALTER TABLE gate_evaluation OWNER TO factory_migrator;
GRANT SELECT, INSERT ON gate_evaluation TO factory_runtime;
GRANT UPDATE (superseded_by, updated_at) ON gate_evaluation TO factory_runtime;
ALTER TABLE finding OWNER TO factory_migrator;
GRANT SELECT, INSERT ON finding TO factory_runtime;
GRANT UPDATE (status, disposition_ref, updated_at) ON finding TO factory_runtime;
ALTER TABLE decision_request OWNER TO factory_migrator;
GRANT SELECT, INSERT ON decision_request TO factory_runtime;
GRANT UPDATE (state, updated_at) ON decision_request TO factory_runtime;
ALTER TABLE decision OWNER TO factory_migrator;
GRANT SELECT, INSERT ON decision TO factory_runtime;
ALTER TABLE command OWNER TO factory_migrator;
GRANT SELECT, INSERT ON command TO factory_runtime;
GRANT UPDATE (state, workflow_result, rejection_reason, updated_at) ON command TO factory_runtime;
ALTER TABLE plan_review_comment OWNER TO factory_migrator;
GRANT SELECT, INSERT ON plan_review_comment TO factory_runtime;
GRANT UPDATE (state, resolution_ref, updated_at) ON plan_review_comment TO factory_runtime;
ALTER TABLE task_event OWNER TO factory_migrator;
GRANT SELECT, INSERT ON task_event TO factory_runtime;
ALTER TABLE external_operation OWNER TO factory_migrator;
GRANT SELECT, INSERT ON external_operation TO factory_runtime;
GRANT UPDATE (state, external_handle, result_ref, last_observed_at, reconcile_after, updated_at) ON external_operation TO factory_runtime;
ALTER TABLE environment OWNER TO factory_migrator;
GRANT SELECT, INSERT ON environment TO factory_runtime;
GRANT UPDATE (external_handle, plan_ref, generation, current_operation_id, deployment_status, status_observed_at, revision, state, endpoints, observed_release_ref, verification_ref, expires_at, cleanup_state, updated_at) ON environment TO factory_runtime;
ALTER TABLE git_change OWNER TO factory_migrator;
GRANT SELECT, INSERT ON git_change TO factory_runtime;
GRANT UPDATE (pr_external_id, pr_url, expected_head, expected_base, merged_commit, provider_observation_ref, updated_at) ON git_change TO factory_runtime;
ALTER TABLE knowledge_record OWNER TO factory_migrator;
GRANT SELECT, INSERT ON knowledge_record TO factory_runtime;
GRANT UPDATE (status, verified_at, expires_at, superseded_by, review_ref, updated_at) ON knowledge_record TO factory_runtime;
ALTER TABLE knowledge_dispute OWNER TO factory_migrator;
GRANT SELECT, INSERT ON knowledge_dispute TO factory_runtime;
ALTER TABLE budget_account OWNER TO factory_migrator;
GRANT SELECT, INSERT ON budget_account TO factory_runtime;
GRANT UPDATE (limit_micro_usd, reserved_micro_usd, charged_micro_usd, revision, updated_at) ON budget_account TO factory_runtime;
ALTER TABLE budget_ledger OWNER TO factory_migrator;
GRANT SELECT, INSERT ON budget_ledger TO factory_runtime;
ALTER TABLE capacity_reservation OWNER TO factory_migrator;
GRANT SELECT, INSERT ON capacity_reservation TO factory_runtime;
GRANT UPDATE (state, expires_at, updated_at) ON capacity_reservation TO factory_runtime;
ALTER TABLE outbox OWNER TO factory_migrator;
GRANT SELECT, INSERT ON outbox TO factory_runtime;
GRANT UPDATE (state, attempts, available_at, lease_owner, lease_until, last_error, updated_at) ON outbox TO factory_runtime;
ALTER TABLE inbox OWNER TO factory_migrator;
GRANT SELECT, INSERT ON inbox TO factory_runtime;
GRANT UPDATE (processed_at, updated_at) ON inbox TO factory_runtime;
ALTER TABLE idempotency_record OWNER TO factory_migrator;
GRANT SELECT, INSERT ON idempotency_record TO factory_runtime;
ALTER TABLE audit_event OWNER TO factory_migrator;
GRANT SELECT, INSERT ON audit_event TO factory_runtime;
ALTER TABLE factory_tool_call OWNER TO factory_migrator;
GRANT SELECT, INSERT ON factory_tool_call TO factory_runtime;
GRANT UPDATE (state, receipt_ref, result_ref, proposal_accepted, updated_at) ON factory_tool_call TO factory_runtime;
ALTER TABLE pr_review_state OWNER TO factory_migrator;
GRANT SELECT, INSERT ON pr_review_state TO factory_runtime;
GRANT UPDATE (revision, completion_mode, phase, expected_head, observed_head, review_round, state_ref, provider_observation_ref, review_deadline, updated_at) ON pr_review_state TO factory_runtime;
ALTER TABLE application_health_sample OWNER TO factory_migrator;
GRANT SELECT, INSERT ON application_health_sample TO factory_runtime;
ALTER TABLE autonomy_policy_decision OWNER TO factory_migrator;
GRANT SELECT, INSERT ON autonomy_policy_decision TO factory_runtime;
ALTER TABLE review_mode_decision OWNER TO factory_migrator;
GRANT SELECT, INSERT ON review_mode_decision TO factory_runtime;
ALTER TABLE review_mode_repository_binding OWNER TO factory_migrator;
GRANT SELECT, INSERT ON review_mode_repository_binding TO factory_runtime;
ALTER TABLE review_mode_transition OWNER TO factory_migrator;
GRANT SELECT, INSERT ON review_mode_transition TO factory_runtime;
ALTER TABLE ai_review_decision OWNER TO factory_migrator;
GRANT SELECT, INSERT ON ai_review_decision TO factory_runtime;
ALTER TABLE review_audit_selection OWNER TO factory_migrator;
GRANT SELECT, INSERT ON review_audit_selection TO factory_runtime;
ALTER TABLE review_audit_result OWNER TO factory_migrator;
GRANT SELECT, INSERT ON review_audit_result TO factory_runtime;
ALTER TABLE design_delivery OWNER TO factory_migrator;
GRANT SELECT, INSERT ON design_delivery TO factory_runtime;
ALTER TABLE design_build_binding OWNER TO factory_migrator;
GRANT SELECT, INSERT ON design_build_binding TO factory_runtime;
-- No DELETE is granted to factory_runtime; retention deletion runs as a separate audited job role.
-- Runtime append-only tables: security_group, application_repository, observation, relationship, application_draft_version, task_spec_version, task_dependency, execution_plan, candidate, artifact_link, decision, task_event, knowledge_dispute, budget_ledger, idempotency_record, audit_event, application_health_sample, autonomy_policy_decision, review_mode_decision, review_mode_repository_binding, review_mode_transition, ai_review_decision, review_audit_selection, review_audit_result, design_delivery, design_build_binding.
-- Mutable projections/operation status have column-limited UPDATE grants.
-- Inbox rows are insert-once evidence; only processed_at/updated_at may be updated.
-- factory_tool_call has column-limited status updates with immutable request identity,
-- irreversible proposal acceptance and no transitions out of terminal states.
-- Gate evidence is immutable; only superseded_by/updated_at may be updated by the gate controller.
-- approve_plan decisions MUST persist non-empty reviewed_section_ids and an immutable
-- review_notes_ref when notes exist; repositories validate scope against the peer assignment.
-- checkpoint_job admission and acceptance lock the parent allocation and verify its
-- finalizing state, generation and owner_epoch; the receipt identifies the durable request.
-- review_mode_decision/transition appends lock the application and compare a shared
-- monotonic revision across both journals; latest transition, expiry, stop and cohort
-- validity are checked live before every gate/publication/merge. Rules only tighten.
-- Pre-repository decisions bind the draft application and organization namespace
-- policy. Bootstrap appends review_mode_repository_binding only after resolving
-- its receipt, policy, real repository, branch/identity and protection evidence.
-- This append locks the application and checks current decision authority; the
-- review/merge controller refuses PR/merge authority until that binding exists.
-- review_audit_selection is selected before execution and never exposed through agent
-- API/context/tool projections. Retries reuse its unique task row; results are separate.
-- Reviewer finalization authenticates configuration/model provenance; decision and
-- human approval artifact refs reject any AI record. No agent has database credentials.
-- design_delivery rows are appended by the delivery controller after rendering and
-- reconciled publication; design_build_binding rows are appended at admission and every
-- later gate. Neither is agent-writable; reuse never copies approval rows to a new subject.
-- JSON references are validated through ArtifactStore; do not trust arbitrary JSON
-- to establish same-task authority or valid hashes. updated_at is set by repositories.
COMMIT;
