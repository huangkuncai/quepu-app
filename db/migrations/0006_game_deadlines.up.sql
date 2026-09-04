BEGIN;

-- Durable scheduler intents.  The in-process timer is only a wake-up hint;
-- status/lease columns below are the cross-instance execution boundary.
CREATE TABLE game_deadlines (
  deadline_id text PRIMARY KEY,
  room_id text NOT NULL,
  command_id text NOT NULL,
  deadline_at timestamptz NOT NULL,
  expected_room_version integer,
  round_id text,
  player_id text,
  timeout_action_json jsonb NOT NULL,
  fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'SCHEDULED'
    CHECK (status IN ('SCHEDULED', 'CLAIMED', 'EXECUTED', 'STALE', 'FAILED', 'CANCELLED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner text,
  lease_token bigint,
  lease_expires_at timestamptz,
  claimed_at timestamptz,
  completed_at timestamptz,
  reason text,
  result_json jsonb,
  error_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT game_deadlines_id_not_blank CHECK (length(btrim(deadline_id)) > 0),
  CONSTRAINT game_deadlines_room_not_blank CHECK (length(btrim(room_id)) > 0),
  CONSTRAINT game_deadlines_command_not_blank CHECK (length(btrim(command_id)) > 0),
  CONSTRAINT game_deadlines_fingerprint_not_blank CHECK (length(btrim(fingerprint)) > 0),
  CONSTRAINT game_deadlines_expected_version_nonnegative CHECK (expected_room_version IS NULL OR expected_room_version >= 0),
  CONSTRAINT game_deadlines_attempt_lease_consistent CHECK (
    (status = 'CLAIMED' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'CLAIMED')
  )
);

CREATE INDEX game_deadlines_due_idx
  ON game_deadlines (deadline_at ASC, updated_at ASC)
  WHERE status IN ('SCHEDULED', 'CLAIMED');
CREATE INDEX game_deadlines_room_idx
  ON game_deadlines (room_id, deadline_at ASC);

COMMENT ON TABLE game_deadlines IS 'Durable room command deadlines; claim lease and token make one due deadline executable by one worker at a time.';

COMMIT;
