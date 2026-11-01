-- 0007_indexes.sql: partial unique and query indexes.
-- Imported verbatim from docs/spec/contracts/schema.sql (sha256 3538dceed1bcb99449e9379006a482ae1f78467b0949e798e86172e05056900b) by
-- packages/database/scripts/import-reference-schema.ts. Do not edit; add a forward migration.
-- phase: expand
SET LOCAL search_path = factory, public;
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
