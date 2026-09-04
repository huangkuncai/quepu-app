import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresGameEventStore, PostgresOutbox, createConfiguredGamePersistence } from '../src/infra/persistence/index.js';
import { RedisFencingLock } from '../src/infra/redis/index.js';

class ScriptedPool {
  constructor() { this.calls = []; this.outboxId = 0; }
  async query(text, values = []) {
    this.calls.push({ text, values });
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK' || text === 'SELECT 1') return { rows: [] };
    if (/SELECT room_id FROM game_events/.test(text)) {
      return { rows: [{ room_id: 'room-a' }, { room_id: 'room-b' }] };
    }
    if (/COALESCE\(MAX\(room_version\)/.test(text)) return { rows: [{ room_version: 0 }] };
    if (/INSERT INTO game_events/.test(text)) return { rows: [] };
    if (/INSERT INTO outbox_messages/.test(text)) return { rows: [{ id: values[0], event_id: values[1], room_id: values[2], room_version: values[3], topic: values[4], payload_json: JSON.parse(values[5]), status: 'PENDING', attempts: 0, created_at: '2026-01-01T00:00:00.000Z' }] };
    if (/INSERT INTO game_snapshots/.test(text)) return { rows: [] };
    if (/SELECT event_id/.test(text)) return { rows: [{ event_id: 'event-1', room_id: values[0], room_version: 1, event_type: 'ROOM_CREATED', payload_json: { type: 'ROOM_CREATED', payload: { ok: true } }, occurred_at: '2026-01-01T00:00:00.000Z' }] };
    return { rows: [] };
  }
  async connect() { return { query: this.query.bind(this), release() {} }; }
}

class PresencePool extends ScriptedPool {
  constructor() {
    super();
    this.presenceRow = null;
  }

  async query(text, values = []) {
    this.calls.push({ text, values });
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
    if (/SELECT room_version FROM game_presence/.test(text)) {
      return { rows: this.presenceRow ? [{ room_version: this.presenceRow.room_version }] : [] };
    }
    if (/INSERT INTO game_presence/.test(text)) {
      this.presenceRow = {
        room_id: values[0],
        room_version: values[1],
        presence_json: JSON.parse(values[2]),
        fencing_token: values[3],
        updated_at: values[4]
      };
      return { rows: [this.presenceRow] };
    }
    if (/SELECT room_id, room_version, presence_json/.test(text)) {
      return { rows: this.presenceRow ? [this.presenceRow] : [] };
    }
    return { rows: [] };
  }
}

test('Postgres adapter uses one transaction for event, snapshot and outbox writes', async () => {
  const pool = new ScriptedPool();
  const store = new PostgresGameEventStore({ pool, idFactory: () => 'event-1' });
  const event = await store.append({ roomId: 'room-1', roomVersion: 1, event: { type: 'ROOM_CREATED', payload: { ok: true } }, snapshot: { roomId: 'room-1', roomVersion: 1, snapshotHash: 'hash' } });
  assert.equal(event.roomVersion, 1);
  assert.equal(pool.calls[0].text, 'BEGIN');
  assert.ok(pool.calls.some(call => /INSERT INTO game_events/.test(call.text)));
  assert.ok(pool.calls.some(call => /INSERT INTO outbox_messages/.test(call.text)));
  assert.equal(pool.calls.at(-1).text, 'COMMIT');
});

test('Postgres adapter maps durable event rows to room event shape', async () => {
  const pool = new ScriptedPool();
  const store = new PostgresGameEventStore({ pool });
  const events = await store.getEvents('room-1', { afterVersion: 0, throughVersion: 1 });
  assert.deepEqual(events[0], { eventId: 'event-1', roomId: 'room-1', roomVersion: 1, version: 1, seq: 1, type: 'ROOM_CREATED', payload: { ok: true }, occurredAt: '2026-01-01T00:00:00.000Z', at: '2026-01-01T00:00:00.000Z' });
});

test('Postgres adapter inventories durable rooms for restart recovery', async () => {
  const pool = new ScriptedPool();
  const store = new PostgresGameEventStore({ pool });
  assert.deepEqual(await store.listRooms(), ['room-a', 'room-b']);
  assert.equal(pool.calls.filter(call => /SELECT room_id FROM game_events/.test(call.text)).length, 1);
});

class FakeRedis {
  constructor() { this.values = new Map(); this.fences = new Map(); }
  async get(key) { return this.values.get(key) || null; }
  async incr(key) { const next = (this.fences.get(key) || 0) + 1; this.fences.set(key, next); return next; }
  async set(key, value, options) { if (options?.NX && this.values.has(key)) return null; this.values.set(key, value); return 'OK'; }
  async eval(_script, { keys, arguments: args }) { const current = await this.get(keys[0]); if (!current) return 0; if (JSON.parse(current).fencingToken !== Number(args[0])) return -1; this.values.delete(keys[0]); return 1; }
}

test('Redis fencing lock issues monotonic tokens and rejects stale release', async () => {
  const lock = new RedisFencingLock({ client: new FakeRedis(), leaseMs: 1000 });
  const first = await lock.acquire('room-1', { ownerId: 'actor-1' });
  assert.equal(first.fencingToken, 1);
  assert.equal((await lock.acquire('room-1', { ownerId: 'actor-1' })).fencingToken, 1);
  await assert.rejects(() => lock.acquire('room-1', { ownerId: 'actor-2' }), error => error.code === 'LOCK_BUSY');
  await assert.rejects(() => lock.assert('room-1', 2), error => error.code === 'FENCING_TOKEN_STALE');
  assert.equal(await lock.release('room-1', first.fencingToken), true);
  const second = await lock.acquire('room-1', { ownerId: 'actor-2' });
  // A failed contender still consumes a fencing counter value; gaps are safe,
  // while every issued token remains strictly increasing.
  assert.equal(second.fencingToken, 3);
});

test('PostgresOutbox requires a pg-compatible client and exposes the port', () => {
  assert.throws(() => new PostgresOutbox(), TypeError);
  const outbox = new PostgresOutbox({ pool: { query: async () => ({ rows: [] }) } });
  assert.equal(typeof outbox.listPending, 'function');
});

test('Postgres presence overlay is mutable at one room version and rejects stale writes', async () => {
  const pool = new PresencePool();
  const store = new PostgresGameEventStore({ pool });
  const saved = await store.savePresence({
    roomId: 'room-1',
    roomVersion: 1,
    presence: {
      p1: { connected: false, disconnectedAt: '2026-01-01T00:00:00.000Z' }
    },
    updatedAt: '2026-01-01T00:00:01.000Z'
  });
  assert.equal(saved.roomVersion, 1);
  assert.equal(saved.presence.p1.connected, false);
  const replacement = await store.savePresence({
    roomId: 'room-1',
    roomVersion: 1,
    presence: { p1: { connected: true } },
    updatedAt: '2026-01-01T00:00:02.000Z'
  });
  assert.equal(replacement.presence.p1.connected, true);
  assert.deepEqual(await store.getPresence('room-1'), replacement);
  await assert.rejects(
    () => store.savePresence({ roomId: 'room-1', roomVersion: 0, presence: {} }),
    error => error.code === 'VERSION_CONFLICT'
  );
  assert.equal(pool.calls.filter(call => call.text === 'BEGIN').length, 3);
  assert.equal(pool.calls.filter(call => call.text === 'COMMIT').length, 2);
});

test('configured persistence keeps memory as explicit development default', async () => {
  const persistence = await createConfiguredGamePersistence({ config: { PERSISTENCE_BACKEND: 'memory' } });
  assert.equal(persistence.eventStore.health().backend, 'memory');
  await assert.rejects(
    () => createConfiguredGamePersistence({ config: { PERSISTENCE_BACKEND: 'postgres', DATABASE_URL: '' } }),
    error => error.code === 'CONFIG_INVALID'
  );
});
