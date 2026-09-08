import { isDeepStrictEqual } from 'node:util';

import { RoomActor } from './room-actor.js';

/**
 * Recover every requested durable room twice and compare the authoritative
 * result at one event cursor. Recovery itself validates snapshot hashes,
 * private wall replay, settlement audit traces, and contiguous event tails.
 */
export async function verifyDurableRoomReplays({
  eventStore,
  roomIds,
  roomFactory,
  throwOnFailure = false
} = {}) {
  if (!eventStore || typeof eventStore.getSnapshot !== 'function'
    || typeof eventStore.getEvents !== 'function') {
    throw new TypeError('eventStore must expose durable snapshot and event reads');
  }
  const inventory = roomIds === undefined
    ? await listDurableRooms(eventStore)
    : normalizeRoomIds(roomIds);
  const rooms = [];
  for (const roomId of inventory) {
    try {
      const left = new RoomActor({
        roomId,
        eventStore,
        roomFactory,
        actorId: `replay-verifier:${roomId}:a`
      });
      const right = new RoomActor({
        roomId,
        eventStore,
        roomFactory,
        actorId: `replay-verifier:${roomId}:b`
      });
      await left.recover();
      await right.recover();
      const leftSnapshot = left.snapshot();
      const rightSnapshot = right.snapshot();
      if (!leftSnapshot || !rightSnapshot
        || left.version !== right.version
        || leftSnapshot.snapshotHash !== rightSnapshot.snapshotHash
        || !isDeepStrictEqual(leftSnapshot, rightSnapshot)) {
        throw verifierError('REPLAY_DIVERGENCE', 'independent recoveries produced different snapshots');
      }
      rooms.push({
        roomId,
        status: 'ok',
        roomVersion: left.version,
        snapshotHash: leftSnapshot.snapshotHash
      });
    } catch (error) {
      rooms.push({
        roomId,
        status: 'failed',
        code: error?.code || 'REPLAY_FAILED',
        message: error?.message || 'room replay failed'
      });
    }
  }
  const failedRooms = rooms.filter(room => room.status === 'failed').length;
  const report = deepFreeze({
    status: failedRooms === 0 ? 'ok' : 'failed',
    checkedRooms: rooms.length,
    failedRooms,
    rooms
  });
  if (throwOnFailure && failedRooms > 0) {
    const error = verifierError('REPLAY_VERIFICATION_FAILED', `${failedRooms} room replay(s) failed`);
    error.report = report;
    throw error;
  }
  return report;
}

async function listDurableRooms(eventStore) {
  if (typeof eventStore.listRooms !== 'function') {
    throw new TypeError('eventStore must expose listRooms when roomIds are omitted');
  }
  return normalizeRoomIds(await eventStore.listRooms());
}

function normalizeRoomIds(value) {
  if (!Array.isArray(value)) throw new TypeError('roomIds must be an array');
  const roomIds = value.map(roomId => String(roomId).trim());
  if (roomIds.some(roomId => !roomId) || new Set(roomIds).size !== roomIds.length) {
    throw new TypeError('roomIds must contain unique non-empty values');
  }
  return roomIds.sort();
}

function verifierError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
