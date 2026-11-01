-- 0010_roles_ownership_grants.sql: reference roles, ownership and column-limited runtime grants.
-- Imported verbatim from docs/spec/contracts/schema.sql (sha256 3538dceed1bcb99449e9379006a482ae1f78467b0949e798e86172e05056900b) by
-- packages/database/scripts/import-reference-schema.ts. Do not edit; add a forward migration.
-- phase: expand
SET LOCAL search_path = factory, public;
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
