-- 0001_schema_identity.sql: factory schema, git_object_id domain, organization and identity tables.
-- Imported verbatim from docs/spec/contracts/schema.sql (sha256 3538dceed1bcb99449e9379006a482ae1f78467b0949e798e86172e05056900b) by
-- packages/database/scripts/import-reference-schema.ts. Do not edit; add a forward migration.
-- phase: expand
SET LOCAL search_path = factory, public;
CREATE SCHEMA factory;
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
