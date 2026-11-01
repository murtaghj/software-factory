-- 0009_guards.sql: integrity guard functions and triggers.
-- Imported verbatim from docs/spec/contracts/schema.sql (sha256 3538dceed1bcb99449e9379006a482ae1f78467b0949e798e86172e05056900b) by
-- packages/database/scripts/import-reference-schema.ts. Do not edit; add a forward migration.
-- phase: expand
SET LOCAL search_path = factory, public;
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
