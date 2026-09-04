BEGIN;

CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  device_id text NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,
  access_token_hash text NOT NULL UNIQUE,
  refresh_token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT sessions_id_not_blank CHECK (length(btrim(id)) > 0),
  CONSTRAINT sessions_access_hash_not_blank CHECK (length(btrim(access_token_hash)) > 0),
  CONSTRAINT sessions_refresh_hash_not_blank CHECK (length(btrim(refresh_token_hash)) > 0),
  CONSTRAINT sessions_expiry_after_creation CHECK (expires_at >= created_at),
  CONSTRAINT sessions_revocation_consistent CHECK (
    (status = 'ACTIVE' AND revoked_at IS NULL)
    OR (status IN ('REVOKED', 'EXPIRED'))
  )
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id, created_at DESC);
CREATE INDEX sessions_device_id_idx ON sessions (device_id, created_at DESC);
CREATE INDEX sessions_active_expiry_idx ON sessions (expires_at)
  WHERE status = 'ACTIVE';

-- scope is deliberately explicit: callers can isolate a key by operation and
-- actor without relying on a nullable user foreign key.
CREATE TABLE idempotency_keys (
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response_json jsonb,
  response_status integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, key),
  CONSTRAINT idempotency_scope_not_blank CHECK (length(btrim(scope)) > 0),
  CONSTRAINT idempotency_key_not_blank CHECK (length(btrim(key)) > 0),
  CONSTRAINT idempotency_hash_not_blank CHECK (length(btrim(request_hash)) > 0),
  CONSTRAINT idempotency_key_length CHECK (length(key) <= 256),
  CONSTRAINT idempotency_scope_length CHECK (length(scope) <= 256),
  CONSTRAINT idempotency_expiry_after_creation CHECK (expires_at >= created_at),
  CONSTRAINT idempotency_status_range CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599)
);

CREATE INDEX idempotency_expiry_idx ON idempotency_keys (expires_at);

COMMENT ON TABLE sessions IS 'Opaque access/refresh session hashes; raw tokens are never persisted.';
COMMENT ON TABLE idempotency_keys IS 'Replay protection records keyed by an explicit operation/actor scope.';

COMMIT;
