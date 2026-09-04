BEGIN;

-- Room events are the durable ordering source for BE-202.  A room version is
-- allocated exactly once, so consumers can use (room_id, room_version) as a
-- stable cursor after reconnects and during replay.
CREATE TABLE game_events (
  event_id text PRIMARY KEY,
  room_id text NOT NULL,
  room_version integer NOT NULL,
  match_id text,
  round_id text,
  event_type text NOT NULL,
  payload_json jsonb NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  command_id text,
  request_id text,
  actor_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT game_events_event_id_not_blank CHECK (length(btrim(event_id)) > 0),
  CONSTRAINT game_events_room_id_not_blank CHECK (length(btrim(room_id)) > 0),
  CONSTRAINT game_events_room_version_positive CHECK (room_version > 0),
  CONSTRAINT game_events_type_not_blank CHECK (length(btrim(event_type)) > 0)
);

CREATE UNIQUE INDEX game_events_room_version_unique
  ON game_events (room_id, room_version);
CREATE INDEX game_events_room_cursor_idx
  ON game_events (room_id, room_version ASC);
CREATE INDEX game_events_command_idx
  ON game_events (room_id, command_id)
  WHERE command_id IS NOT NULL;

-- Snapshots are versioned and append-only.  A newer snapshot never overwrites
-- an older one, which keeps historical replay and hash verification possible.
CREATE TABLE game_snapshots (
  room_id text NOT NULL,
  room_version integer NOT NULL,
  snapshot_hash text NOT NULL,
  snapshot_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, room_version),
  CONSTRAINT game_snapshots_room_id_not_blank CHECK (length(btrim(room_id)) > 0),
  CONSTRAINT game_snapshots_version_nonnegative CHECK (room_version >= 0),
  CONSTRAINT game_snapshots_hash_not_blank CHECK (length(btrim(snapshot_hash)) > 0)
);

CREATE INDEX game_snapshots_latest_idx
  ON game_snapshots (room_id, room_version DESC);

-- Event facts, checkpoints and command responses are immutable. Corrections
-- are represented by a new event/compensating response, never an UPDATE or
-- DELETE that would make replay history diverge.
CREATE OR REPLACE FUNCTION prevent_game_fact_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER game_events_append_only
  BEFORE UPDATE OR DELETE ON game_events
  FOR EACH ROW EXECUTE FUNCTION prevent_game_fact_mutation();
CREATE TRIGGER game_snapshots_append_only
  BEFORE UPDATE OR DELETE ON game_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_game_fact_mutation();

-- Command responses are persisted separately from the event stream so a retry
-- can return the exact original response without applying the command again.
CREATE TABLE game_command_results (
  room_id text NOT NULL,
  command_id text NOT NULL,
  request_hash text NOT NULL,
  response_json jsonb NOT NULL,
  room_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, command_id),
  CONSTRAINT game_command_results_room_id_not_blank CHECK (length(btrim(room_id)) > 0),
  CONSTRAINT game_command_results_command_id_not_blank CHECK (length(btrim(command_id)) > 0),
  CONSTRAINT game_command_results_hash_not_blank CHECK (length(btrim(request_hash)) > 0),
  CONSTRAINT game_command_results_version_nonnegative CHECK (room_version >= 0)
);

CREATE TRIGGER game_command_results_append_only
  BEFORE UPDATE OR DELETE ON game_command_results
  FOR EACH ROW EXECUTE FUNCTION prevent_game_fact_mutation();

-- Outbox rows are created with the event and published asynchronously.  The
-- event id is unique so retries cannot broadcast the same durable event twice.
CREATE TABLE outbox_messages (
  id text PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  room_id text NOT NULL,
  room_version integer NOT NULL,
  topic text NOT NULL,
  payload_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_id_not_blank CHECK (length(btrim(id)) > 0),
  CONSTRAINT outbox_event_id_not_blank CHECK (length(btrim(event_id)) > 0),
  CONSTRAINT outbox_room_id_not_blank CHECK (length(btrim(room_id)) > 0),
  CONSTRAINT outbox_topic_not_blank CHECK (length(btrim(topic)) > 0),
  CONSTRAINT outbox_version_positive CHECK (room_version > 0),
  CONSTRAINT outbox_attempts_nonnegative CHECK (attempts >= 0),
  CONSTRAINT outbox_published_consistent CHECK (
    (status = 'PUBLISHED' AND published_at IS NOT NULL)
    OR (status IN ('PENDING', 'FAILED'))
  )
);

CREATE INDEX outbox_pending_idx
  ON outbox_messages (available_at ASC, created_at ASC)
  WHERE status IN ('PENDING', 'FAILED');
CREATE INDEX outbox_room_cursor_idx
  ON outbox_messages (room_id, room_version ASC);

COMMENT ON TABLE game_events IS 'Append-only authoritative room event stream; room_version is the reconnect cursor.';
COMMENT ON TABLE game_snapshots IS 'Versioned room aggregate snapshots used for restart recovery and replay checks.';
COMMENT ON TABLE game_command_results IS 'Durable room command idempotency responses keyed by room and command id.';
COMMENT ON TABLE outbox_messages IS 'Transactional publication queue for room events; rows are never deleted for replay evidence.';

COMMIT;
