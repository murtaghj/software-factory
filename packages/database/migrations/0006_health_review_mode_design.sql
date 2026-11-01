-- 0006_health_review_mode_design.sql: application health, autonomy policy, review mode (D5) and design delivery tables.
-- Imported verbatim from docs/spec/contracts/schema.sql (sha256 3538dceed1bcb99449e9379006a482ae1f78467b0949e798e86172e05056900b) by
-- packages/database/scripts/import-reference-schema.ts. Do not edit; add a forward migration.
-- phase: expand
SET LOCAL search_path = factory, public;
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
