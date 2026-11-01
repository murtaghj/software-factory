-- 0002_registry_artifacts.sql: repositories, applications, artifacts, definitions, observations and relationships.
-- Imported verbatim from docs/spec/contracts/schema.sql (sha256 3538dceed1bcb99449e9379006a482ae1f78467b0949e798e86172e05056900b) by
-- packages/database/scripts/import-reference-schema.ts. Do not edit; add a forward migration.
-- phase: expand
SET LOCAL search_path = factory, public;
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
