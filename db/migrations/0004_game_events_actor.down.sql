BEGIN;

DROP TABLE IF EXISTS outbox_messages;
DROP TABLE IF EXISTS game_command_results;
DROP TABLE IF EXISTS game_snapshots;
DROP TABLE IF EXISTS game_events;
DROP FUNCTION IF EXISTS prevent_game_fact_mutation();

COMMIT;
