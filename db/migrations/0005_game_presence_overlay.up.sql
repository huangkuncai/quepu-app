BEGIN;

-- Presence is transport state, not a game event. It may be replaced at the
-- same room version when a socket connects or disconnects, while the game
-- event/snapshot tables remain append-only for replay evidence.
CREATE TABLE game_presence (
  room_id text PRIMARY KEY,
  room_version integer NOT NULL,
  presence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  fencing_token bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT game_presence_room_id_not_blank CHECK (length(btrim(room_id)) > 0),
  CONSTRAINT game_presence_version_nonnegative CHECK (room_version >= 0),
  CONSTRAINT game_presence_json_object CHECK (jsonb_typeof(presence_json) = 'object'),
  CONSTRAINT game_presence_fencing_positive CHECK (fencing_token IS NULL OR fencing_token > 0)
);

CREATE INDEX game_presence_updated_idx
  ON game_presence (updated_at DESC);

COMMENT ON TABLE game_presence IS 'Mutable room-level connection presence overlay; never part of the game event cursor.';

COMMIT;
