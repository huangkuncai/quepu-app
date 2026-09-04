import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/domain/room.js';
import { RoomActor } from '../src/domain/room-actor.js';
import { createMemoryGameStore } from '../src/infra/persistence/index.js';

const RETRYABLE_LEASE_CODES = new Set([
  'LOCK_BUSY',
  'LOCK_NOT_HELD',
  'LOCK_EXPIRED',
  'FENCING_TOKEN_STALE',
  'CONFLICT',
  'VERSION_CONFLICT'
]);

const tick = () => new Promise(resolve => setImmediate(resolve));

/**
 * A client-side command retry is expected when another process owns the room
 * lease.  The actor itself deliberately fails fast on LOCK_BUSY; callers can
 * retry the same commandId and receive the durable ACK once the lease is free.
 */
async function dispatchEventually(actor, command, context, { attempts = 50 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await actor.dispatch(command, context);
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_LEASE_CODES.has(error?.code)) throw error;
      await tick();
    }
  }
  throw lastError || new Error('command retry budget exhausted');
}

function fixture() {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  let sequence = 0;
  const idFactory = () => `fixture-id-${++sequence}`;
  const clock = () => now;
  const store = createMemoryGameStore({ clock, idFactory });
  const room = new Room({
    id: 'multi-instance-room',
    maxPlayers: 2,
    matchId: 'multi-instance-match',
    clock,
    idFactory
  });
  const bootstrap = store.lock.acquire(room.id, { ownerId: 'bootstrap' });
  store.eventStore.saveSnapshot({
    roomId: room.id,
    roomVersion: 0,
    snapshot: room.snapshot(),
    fencingToken: bootstrap.fencingToken
  });
  store.lock.release(room.id, bootstrap.fencingToken);

  const actorA = new RoomActor({
    roomId: room.id,
    eventStore: store.eventStore,
    lock: store.lock,
    clock,
    idFactory: () => `actor-a-${++sequence}`,
    actorId: 'instance-a'
  });
  const actorB = new RoomActor({
    roomId: room.id,
    eventStore: store.eventStore,
    lock: store.lock,
    clock,
    idFactory: () => `actor-b-${++sequence}`,
    actorId: 'instance-b'
  });
  return { ...store, room, actorA, actorB };
}

test('BE-204 two room actors converge on one durable stream and final snapshotHash', async () => {
  const { eventStore, actorA, actorB, room } = fixture();

  // The same command may be sent by two instances during a reconnect race.
  // Exactly one event is appended and both callers receive the same ACK.
  const duplicateJoin = {
    type: 'join_room',
    roomId: room.id,
    commandId: 'multi-join-p1',
    requestId: 'multi-request-p1',
    payload: { playerId: 'p1', name: '一号', seat: 0 }
  };
  const [ackA, ackB] = await Promise.all([
    dispatchEventually(actorA, duplicateJoin, { actorId: 'p1' }),
    dispatchEventually(actorB, duplicateJoin, { actorId: 'p1' })
  ]);
  assert.deepEqual(ackA, ackB);
  assert.equal(eventStore.getLatestVersion(room.id), 1);
  assert.equal(eventStore.getEvents(room.id).filter(event => event.commandId === duplicateJoin.commandId).length, 1);

  // A different instance appends the second player, then both instances race
  // ready commands.  Lease contention is resolved by retrying the same IDs.
  await dispatchEventually(actorB, {
    type: 'join_room',
    roomId: room.id,
    commandId: 'multi-join-p2',
    payload: { playerId: 'p2', name: '二号', seat: 1 }
  }, { actorId: 'p2' });
  await Promise.all([
    dispatchEventually(actorA, {
      type: 'ready',
      roomId: room.id,
      commandId: 'multi-ready-p1',
      payload: { playerId: 'p1', ready: true }
    }, { actorId: 'p1' }),
    dispatchEventually(actorB, {
      type: 'ready',
      roomId: room.id,
      commandId: 'multi-ready-p2',
      payload: { playerId: 'p2', ready: true }
    }, { actorId: 'p2' })
  ]);

  await dispatchEventually(actorA, {
    type: 'start_round',
    roomId: room.id,
    commandId: 'multi-start',
    payload: {
      roundId: 'multi-round-1',
      autoAdvance: true
    }
  }, { actorId: 'p1' });
  await dispatchEventually(actorA, {
    type: 'action',
    roomId: room.id,
    commandId: 'multi-action-p1',
    payload: { playerId: 'p1', action: 'pass' }
  }, { actorId: 'p1' });
  await dispatchEventually(actorB, {
    type: 'action',
    roomId: room.id,
    commandId: 'multi-action-p2',
    payload: { playerId: 'p2', action: 'pass' }
  }, { actorId: 'p2' });

  // Recovery is intentionally performed by both actors after all writes;
  // their local aggregates must be byte-for-byte equivalent at one cursor.
  await Promise.all([actorA.recover(), actorB.recover()]);
  const snapshotA = actorA.snapshot();
  const snapshotB = actorB.snapshot();
  assert.equal(snapshotA.roomVersion, eventStore.getLatestVersion(room.id));
  assert.equal(snapshotA.snapshotHash, snapshotB.snapshotHash);
  assert.deepEqual(snapshotA, snapshotB);

  const events = eventStore.getEvents(room.id, { afterVersion: 0 });
  assert.deepEqual(events.map(event => event.roomVersion), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(new Set(events.map(event => event.eventId)).size, events.length);
  assert.equal(eventStore.listCommandResults(room.id).length, 7);

  await Promise.all([actorA.close(), actorB.close()]);
});

test('BE-204 crash gap replay strips persistence-only metadata and preserves event correlation', async () => {
  const { eventStore, lock, room } = fixture();
  const originalSave = eventStore.saveCommandResult.bind(eventStore);
  let failOnce = true;
  eventStore.saveCommandResult = input => {
    if (failOnce) {
      failOnce = false;
      throw new Error('simulated crash after event commit');
    }
    return originalSave(input);
  };
  const actorA = new RoomActor({
    roomId: room.id,
    eventStore,
    lock,
    actorId: 'crash-instance-a'
  });
  const actorB = new RoomActor({
    roomId: room.id,
    eventStore,
    lock,
    actorId: 'crash-instance-b'
  });
  const command = {
    type: 'join_room',
    roomId: room.id,
    commandId: 'crash-gap-command',
    requestId: 'original-request-id',
    payload: { playerId: 'p1', name: '一号', seat: 0 }
  };
  await assert.rejects(() => actorA.dispatch(command), error => error.code === 'INTERNAL_ERROR');
  assert.equal(eventStore.getLatestVersion(room.id), 1);
  const replay = await actorB.dispatch({ ...command, requestId: 'retry-request-id' }, { actorId: 'p1' });
  assert.equal(replay.requestId, 'original-request-id');
  assert.equal(replay.event.requestId, 'original-request-id');
  assert.equal('requestHash' in replay.event, false);
  assert.equal(replay.roomVersion, 1);
  assert.equal(eventStore.getCommandResult(room.id, command.commandId).result.requestId, 'original-request-id');
  await Promise.all([actorA.close(), actorB.close()]);
});
