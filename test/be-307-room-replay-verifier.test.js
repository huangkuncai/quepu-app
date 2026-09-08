import assert from 'node:assert/strict';
import test from 'node:test';

import { Room } from '../src/domain/room.js';
import { RoomActor } from '../src/domain/room-actor.js';
import { verifyDurableRoomReplays } from '../src/domain/room-replay-verifier.js';
import { createMemoryGameStore } from '../src/infra/persistence/index.js';

test('BE-307 batch verifier recovers each durable room twice at one hash', async () => {
  const store = createMemoryGameStore();
  for (const roomId of ['replay-b', 'replay-a']) {
    const room = new Room({ id: roomId, maxPlayers: 2 });
    const lease = store.lock.acquire(roomId, { ownerId: `bootstrap:${roomId}` });
    store.eventStore.saveSnapshot({
      roomId,
      roomVersion: 0,
      snapshot: room.persistenceSnapshot(),
      fencingToken: lease.fencingToken
    });
    store.lock.release(roomId, lease.fencingToken);
    const actor = new RoomActor({
      roomId,
      eventStore: store.eventStore,
      actorId: `writer:${roomId}`
    });
    await actor.recover();
    await actor.dispatch({
      type: 'join_room',
      commandId: `join:${roomId}`,
      payload: { playerId: `${roomId}:player`, seat: 0 }
    }, { actorId: `${roomId}:player` });
  }

  const report = await verifyDurableRoomReplays({ eventStore: store.eventStore });
  assert.equal(report.status, 'ok');
  assert.equal(report.checkedRooms, 2);
  assert.equal(report.failedRooms, 0);
  assert.deepEqual(report.rooms.map(room => room.roomId), ['replay-a', 'replay-b']);
  assert.ok(report.rooms.every(room => room.roomVersion === 1));
  assert.ok(report.rooms.every(room => room.snapshotHash?.length === 64));
  assert.equal(Object.isFrozen(report.rooms[0]), true);
});

test('BE-307 batch verifier reports and can fail closed on a corrupt checkpoint', async () => {
  const store = createMemoryGameStore();
  const room = new Room({ id: 'corrupt-replay-room', maxPlayers: 2 });
  const lease = store.lock.acquire(room.id, { ownerId: 'bootstrap:corrupt' });
  store.eventStore.saveSnapshot({
    roomId: room.id,
    roomVersion: 0,
    snapshot: room.persistenceSnapshot(),
    fencingToken: lease.fencingToken
  });
  store.lock.release(room.id, lease.fencingToken);
  const corruptStore = forwardingStore(store.eventStore, {
    getSnapshot: async roomId => {
      const snapshot = await store.eventStore.getSnapshot(roomId);
      return { ...snapshot, status: 'not-a-room-status', snapshotHash: undefined };
    }
  });

  const report = await verifyDurableRoomReplays({
    eventStore: corruptStore,
    roomIds: [room.id]
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.failedRooms, 1);
  assert.equal(report.rooms[0].code, 'INVALID_ACTION');
  await assert.rejects(
    verifyDurableRoomReplays({
      eventStore: corruptStore,
      roomIds: [room.id],
      throwOnFailure: true
    }),
    error => error.code === 'REPLAY_VERIFICATION_FAILED'
      && error.report.failedRooms === 1
  );
});

function forwardingStore(store, overrides = {}) {
  return {
    getSnapshot: overrides.getSnapshot ?? ((...args) => store.getSnapshot(...args)),
    getEvents: (...args) => store.getEvents(...args),
    getLatestVersion: (...args) => store.getLatestVersion(...args),
    getCommandResult: (...args) => store.getCommandResult(...args),
    saveCommandResult: (...args) => store.saveCommandResult(...args),
    listRooms: (...args) => store.listRooms(...args)
  };
}
