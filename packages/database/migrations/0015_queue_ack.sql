-- 0015_queue_ack.sql: "Mark as seen" for the ranked "what needs you next" queue (docs/plan-additions.md
-- P-24; docs/assumptions.md A-21). Not in the reference DDL. A queue_ack row says one person has looked
-- at one queue item (a stopped or finished task, or a budget notice); it is that person's view state
-- and changes no task. Append-only: no UPDATE and no DELETE. A person reads and writes only their own
-- rows. The partial index serves the queue's lookup of decisions waiting on one person.
-- phase: expand
SET LOCAL search_path = factory, public;

CREATE TABLE queue_ack (
  org_id uuid NOT NULL REFERENCES organization(id),
  principal_id uuid NOT NULL,
  item_key text NOT NULL CHECK (length(item_key) BETWEEN 3 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, principal_id) REFERENCES principal(org_id, id),
  PRIMARY KEY (org_id, principal_id, item_key)
);
ALTER TABLE queue_ack ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_ack FORCE ROW LEVEL SECURITY;
CREATE POLICY queue_ack_org_scope ON queue_ack USING (org_id = nullif(current_setting('factory.org_id',true),'')::uuid) WITH CHECK (org_id = nullif(current_setting('factory.org_id',true),'')::uuid);
CREATE POLICY queue_ack_own ON queue_ack AS RESTRICTIVE USING (principal_id = nullif(current_setting('factory.principal_id',true),'')::uuid) WITH CHECK (principal_id = nullif(current_setting('factory.principal_id',true),'')::uuid);
GRANT SELECT, INSERT ON queue_ack TO factory_runtime;

CREATE INDEX decision_request_pending_by_principal ON decision_request (org_id, required_principal_id, expires_at) WHERE state = 'pending';
