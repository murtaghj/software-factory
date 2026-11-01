-- 0004_gates_decisions_events.sql: gate evaluations, findings, decisions, commands, plan review comments, task events.
-- Imported verbatim from docs/spec/contracts/schema.sql (sha256 3538dceed1bcb99449e9379006a482ae1f78467b0949e798e86172e05056900b) by
-- packages/database/scripts/import-reference-schema.ts. Do not edit; add a forward migration.
-- phase: expand
SET LOCAL search_path = factory, public;
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
