BEGIN;

CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id text REFERENCES users (id) ON DELETE SET NULL,
  actor_type text NOT NULL DEFAULT 'USER'
    CHECK (actor_type IN ('USER', 'ADMIN', 'SYSTEM', 'SERVICE')),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  request_id text,
  reason text,
  before_json jsonb,
  after_json jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_action_not_blank CHECK (length(btrim(action)) > 0),
  CONSTRAINT audit_resource_type_not_blank CHECK (length(btrim(resource_type)) > 0),
  CONSTRAINT audit_reason_length CHECK (reason IS NULL OR length(reason) <= 2048),
  CONSTRAINT audit_request_id_length CHECK (request_id IS NULL OR length(request_id) <= 128)
);

CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX audit_logs_resource_idx ON audit_logs (resource_type, resource_id, created_at DESC);
CREATE INDEX audit_logs_request_idx ON audit_logs (request_id)
  WHERE request_id IS NOT NULL;

-- Audit entries are append-only. Corrections must be represented by a new
-- compensating entry, preserving the original evidence for review/replay.
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs are append-only';
END;
$$;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

COMMENT ON TABLE audit_logs IS 'Append-only operator and system audit evidence; corrections use compensating entries.';

COMMIT;
