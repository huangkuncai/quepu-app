BEGIN;

-- Identity records are intentionally application-generated opaque text ids. This
-- keeps the migration independent of an extension such as pgcrypto and matches
-- the current auth adapter's UUID/player-id boundary.
CREATE TABLE users (
  id text PRIMARY KEY,
  phone_e164 text,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'BANNED', 'DELETED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_id_not_blank CHECK (length(btrim(id)) > 0),
  CONSTRAINT users_display_name_not_blank CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT users_phone_length CHECK (phone_e164 IS NULL OR length(phone_e164) BETWEEN 3 AND 32)
);

CREATE UNIQUE INDEX users_phone_e164_unique
  ON users (phone_e164)
  WHERE phone_e164 IS NOT NULL;

CREATE TABLE devices (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  platform text NOT NULL,
  app_version text,
  device_name text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devices_id_not_blank CHECK (length(btrim(id)) > 0),
  CONSTRAINT devices_platform_not_blank CHECK (length(btrim(platform)) > 0),
  CONSTRAINT devices_app_version_length CHECK (app_version IS NULL OR length(app_version) <= 64)
);

CREATE INDEX devices_user_id_idx ON devices (user_id);
CREATE INDEX devices_active_idx ON devices (user_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE users IS 'Account identity and soft-deletion state; no client payment fields.';
COMMENT ON TABLE devices IS 'Installations associated with an account for session/reconnect control.';

COMMIT;
