import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/domain/room.js';
import { RoomActor } from '../src/domain/room-actor.js';
import {
  MemoryGameEventStore,
  MemoryOutbox,
  MemoryRoomLock,
  createMemoryGameStore
} from '../src/infra/persistence/index.js';

function fixture() {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  let sequence = 0;
  const clock = () => now;
  const idFactory = () => `id-${++sequence}`;
  const store = createMemoryGameStore({ clock, idFactory });
  return {
    ...store,
    clock,
    idFactory,
    advance(ms) { now += ms; }
  };
}

function event(roomVersion, type = `EVENT_${roomVersion}`) {
  return { roomId: 'room-1', roomVersion, type, payload: { value: roomVersion } };
}

test('memory game event store appends one contiguous immutable stream and outbox message', () => {
  const { eventStore, lock } = fixture();
  const lease = lock.acquire('room-1', { ownerId: 'actor-1' });
  const first = eventStore.append({
    ...event(1, 'ROOM_CREATED'),
    snapshot: { roomId: 'room-1', roomVersion: 1, status: 'waiting' },
    commandId: 'cmd-1',
    requestId: 'req-1',
    fencingToken: lease.fencingToken
  });
  assert.equal(first.roomVersion, 1);
  assert.equal(first.commandId, 'cmd-1');
  assert.equal(eventStore.getLatestVersion('room-1'), 1);
  assert.equal(eventStore.getSnapshot('room-1').status, 'waiting');
  assert.equal(eventStore.outbox.listPending()[0].roomVersion, 1);
  assert.equal(Object.isFrozen(first), true);

  assert.throws(() => { first.payload.value = 99; }, TypeError);
  assert.equal(eventStore.getEvent('room-1', 1).payload.value, 1);
  assert.deepEqual(eventStore.getEvents('room-1', { afterVersion: 0 }).map(item => item.roomVersion), [1]);
  assert.throws(
    () => eventStore.append({ ...event(3), fencingToken: lease.fencingToken }),
    error => error.code === 'VERSION_CONFLICT'
  );
  assert.throws(
    () => eventStore.append({ ...event(1), fencingToken: lease.fencingToken }),
    error => error.code === 'VERSION_CONFLICT'
  );
});

test('appendBatch validates all rows before committing, preserving atomicity', () => {
  const { eventStore, lock } = fixture();
  const lease = lock.acquire('room-1', { ownerId: 'actor-1' });
  assert.throws(
    () => eventStore.appendBatch([
      { ...event(1), fencingToken: lease.fencingToken },
      { ...event(3), fencingToken: lease.fencingToken }
    ]),
    error => error.code === 'VERSION_CONFLICT'
  );
  assert.equal(eventStore.getLatestVersion('room-1'), 0);
  assert.deepEqual(eventStore.getEvents('room-1'), []);
  assert.deepEqual(eventStore.outbox.listPending(), []);
});

test('appendBatch rolls back the event stream when an outbox write fails', () => {
  class FaultyOutbox extends MemoryOutbox {
    constructor(options) {
      super(options);
      this.commitCount = 0;
    }

    _commit(prepared) {
      this.commitCount += 1;
      if (this.commitCount === 2) throw new Error('injected outbox failure');
      return super._commit(prepared);
    }
  }

  const clock = () => Date.parse('2026-01-01T00:00:00.000Z');
  const lock = new MemoryRoomLock({ clock });
  const outbox = new FaultyOutbox({ clock });
  const eventStore = new MemoryGameEventStore({ clock, lock, outbox });
  const lease = lock.acquire('room-1', { ownerId: 'actor-1' });

  assert.throws(
    () => eventStore.appendBatch([
      { ...event(1), fencingToken: lease.fencingToken },
      { ...event(2), fencingToken: lease.fencingToken }
    ]),
    /injected outbox failure/
  );
  assert.equal(eventStore.getLatestVersion('room-1'), 0);
  assert.deepEqual(eventStore.getEvents('room-1'), []);
  assert.deepEqual(outbox.list(), []);
});

test('fencing tokens prevent stale writers after lock ownership changes', () => {
  const { eventStore, lock } = fixture();
  const first = lock.acquire('room-1', { ownerId: 'actor-1' });
  eventStore.append({ ...event(1), fencingToken: first.fencingToken });
  lock.release('room-1', first.fencingToken);
  const second = lock.acquire('room-1', { ownerId: 'actor-2' });
  assert.ok(second.fencingToken > first.fencingToken);
  assert.throws(
    () => eventStore.append({ ...event(2), fencingToken: first.fencingToken }),
    error => ['FENCING_TOKEN_STALE', 'LOCK_NOT_HELD'].includes(error.code)
  );
  assert.doesNotThrow(() => eventStore.append({ ...event(2), fencingToken: second.fencingToken }));
});

test('command results are hash-bound and returned as immutable replays', () => {
  const { eventStore, lock } = fixture();
  const lease = lock.acquire('room-1', { ownerId: 'actor-1' });
  const result = eventStore.saveCommandResult({
    roomId: 'room-1',
    commandId: 'cmd-1',
    requestHash: 'hash-1',
    result: { accepted: true, roomVersion: 1, nested: { ok: true } },
    fencingToken: lease.fencingToken
  });
  const replay = eventStore.getCommandResult('room-1', 'cmd-1');
  assert.deepEqual(replay.result, result.result);
  assert.equal(Object.isFrozen(replay.result.nested), true);
  assert.throws(() => {
    replay.result.nested.ok = false;
  }, TypeError);
  assert.deepEqual(eventStore.saveCommandResult({
    roomId: 'room-1', commandId: 'cmd-1', requestHash: 'hash-1', result: { ignored: true }, fencingToken: lease.fencingToken
  }).result, result.result);
  assert.throws(
    () => eventStore.saveCommandResult({
      roomId: 'room-1', commandId: 'cmd-1', requestHash: 'hash-2', result: {}, fencingToken: lease.fencingToken
    }),
    error => error.code === 'DUPLICATE_REQUEST'
  );
});

test('outbox enqueue is idempotent and publish ACK is repeatable', () => {
  const outbox = new MemoryOutbox({ clock: () => Date.parse('2026-01-01T00:00:00.000Z'), idFactory: () => 'message-1' });
  const first = outbox.enqueue({ roomId: 'room-1', roomVersion: 1, eventId: 'event-1', payload: { a: 1 }, dedupeKey: 'room-1:1' });
  const replay = outbox.enqueue({ roomId: 'room-1', roomVersion: 1, eventId: 'event-1', payload: { a: 1 }, dedupeKey: 'room-1:1' });
  assert.deepEqual(replay, first);
  assert.equal(outbox.listPending().length, 1);
  const published = outbox.markPublished(first.messageId);
  assert.equal(published.status, 'PUBLISHED');
  assert.equal(outbox.markPublished(first.messageId).publishedAt, published.publishedAt);
  assert.deepEqual(outbox.listPending(), []);
});

test('version-zero room initialization rolls back checkpoint when command result write fails', () => {
  const { eventStore, lock, clock, idFactory } = fixture();
  const room = new Room({ id: 'room-1', maxPlayers: 2, clock, idFactory, ownerId: 'p1' });
  const lease = lock.acquire('room-1', { ownerId: 'room-init' });
  const snapshot = room.snapshot();
  const originalSaveCommandResult = eventStore.saveCommandResult;
  eventStore.saveCommandResult = () => { throw new Error('injected command result failure'); };
  assert.throws(
    () => eventStore.initializeRoom({
      roomId: 'room-1',
      snapshot,
      roomVersion: 0,
      commandId: 'create-1',
      requestHash: 'hash-create-1',
      result: { accepted: true, roomId: 'room-1', roomVersion: 0 },
      fencingToken: lease.fencingToken
    }),
    /injected command result failure/
  );
  eventStore.saveCommandResult = originalSaveCommandResult;
  assert.equal(eventStore.getSnapshot('room-1'), null);
  assert.equal(eventStore.getCommandResult('room-1', 'create-1'), null);
  assert.equal(eventStore.fencingTokens.has('room-1'), false);
  lock.release('room-1', lease.fencingToken);
});

test('RoomActor serializes concurrent commands and restores from durable snapshot', async () => {
  const { eventStore, lock, clock, idFactory } = fixture();
  const room = new Room({ id: 'room-1', maxPlayers: 2, clock, idFactory });
  const actor = new RoomActor({ room, eventStore, lock, clock, idFactory, actorId: 'actor-1' });
  const [first, second] = await Promise.all([
    actor.dispatch({ type: 'join_room', commandId: 'join-1', payload: { playerId: 'p1' } }),
    actor.dispatch({ type: 'join_room', commandId: 'join-2', payload: { playerId: 'p2' } })
  ]);
  assert.equal(first.roomVersion, 1);
  assert.equal(second.roomVersion, 2);
  assert.equal(eventStore.getLatestVersion('room-1'), 2);

  const restarted = new RoomActor({ roomId: 'room-1', eventStore, lock, clock, idFactory, actorId: 'actor-2' });
  const recovered = await restarted.recover();
  assert.equal(recovered.version, 2);
  assert.deepEqual([...recovered.players.keys()], ['p1', 'p2']);
  const replay = await restarted.dispatch({ type: 'join_room', commandId: 'join-2', payload: { playerId: 'p2' } });
  assert.deepEqual(replay, second);
  assert.equal(eventStore.getLatestVersion('room-1'), 2);
});

test('RoomActor rolls back local state when event persistence fails before commit', async () => {
  class FailingOnceOutbox extends MemoryOutbox {
    constructor(options) {
      super(options);
      this.failed = false;
    }

    _commitBatch(prepared) {
      if (!this.failed) {
        this.failed = true;
        throw new Error('injected transaction failure');
      }
      return super._commitBatch(prepared);
    }
  }

  const clock = () => Date.parse('2026-01-01T00:00:00.000Z');
  const lock = new MemoryRoomLock({ clock });
  const outbox = new FailingOnceOutbox({ clock });
  const eventStore = new MemoryGameEventStore({ clock, lock, outbox });
  const room = new Room({ id: 'room-1', maxPlayers: 2, clock });
  const actor = new RoomActor({ room, eventStore, lock, clock, actorId: 'actor-1' });
  const command = { type: 'join_room', commandId: 'join-retry', payload: { playerId: 'p1' } };

  await assert.rejects(() => actor.dispatch(command), error => error.code === 'INTERNAL_ERROR');
  assert.equal(actor.roomVersion, 0);
  assert.equal(actor.room.players.size, 0);
  assert.equal(eventStore.getLatestVersion('room-1'), 0);

  const retry = await actor.dispatch(command);
  assert.equal(retry.roomVersion, 1);
  assert.deepEqual([...actor.room.players.keys()], ['p1']);
  assert.equal(eventStore.getLatestVersion('room-1'), 1);
});
