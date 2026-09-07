import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, ROOM_ACCESS_POLICY, ROOM_STATUS } from '../src/domain/room.js';

function makeRoom(options = {}) {
  let sequence = 0;
  return new Room({
    id: 'room-201',
    maxPlayers: 4,
    ownerId: 'p1',
    idFactory: () => `generated-${++sequence}`,
    ruleSnapshot: {
      gameType: 'mahjong',
      ruleId: 'fake',
      ruleVersion: 'fake-1',
      config: { baseScore: 'TBD' }
    },
    ...options
  });
}

function fillRoom(room) {
  for (let index = 1; index <= 4; index += 1) {
    room.join({ id: `p${index}`, name: `P${index}` }, { membershipApproved: true });
  }
}

function readyRoom(room) {
  for (let index = 1; index <= 4; index += 1) room.setReady(`p${index}`);
}

test('room assigns stable seats, owner and an immutable rule snapshot', () => {
  const room = makeRoom();
  fillRoom(room);
  assert.equal(room.ownerId, 'p1');
  assert.deepEqual(room.seats, ['p1', 'p2', 'p3', 'p4']);
  assert.equal(room.snapshot().ruleSnapshot.ruleVersion, 'fake-1');
  assert.equal(Object.isFrozen(room.ruleSnapshot), true);
  assert.equal(Object.isFrozen(room.ruleSnapshot.config), true);
  assert.throws(() => { room.ruleSnapshot.config.baseScore = 1; }, TypeError);
  const before = room.ruleSnapshotHash;
  assert.throws(() => room.join({ id: 'p1' }), error => error.code === 'DUPLICATE_REQUEST');
  assert.equal(room.ruleSnapshotHash, before);
});

test('membership and seat boundaries return stable errors', () => {
  const room = new Room({
    id: 'club-room',
    clubId: 'club-1',
    accessPolicy: ROOM_ACCESS_POLICY.MEMBERS_ONLY,
    maxPlayers: 2,
    ownerId: 'owner'
  });
  room.join({ id: 'owner', seat: 0 });
  assert.throws(() => room.join({ id: 'outsider', seat: 1 }), error => error.code === 'CLUB_MEMBERSHIP_REQUIRED');
  room.join({ id: 'member', seat: 1 }, { membershipApproved: true });
  assert.throws(() => room.join({ id: 'third', seat: 0 }, { membershipApproved: true }), error => error.code === 'ROOM_FULL');
});

test('ready/start/action transitions enforce owner, turn and expected version', () => {
  const room = makeRoom();
  fillRoom(room);
  assert.equal(room.status, ROOM_STATUS.WAITING);
  readyRoom(room);
  assert.equal(room.status, ROOM_STATUS.READY);
  assert.throws(() => room.start({ actorId: 'p2' }), error => error.code === 'NOT_ROOM_OWNER');
  const started = room.start({ actorId: 'p1', commandId: 'start-1', expectedRoomVersion: room.version });
  assert.equal(started.snapshot.status, ROOM_STATUS.DEALING);
  assert.equal(room.currentRound.ruleSnapshotHash, room.ruleSnapshotHash);
  assert.equal(room.beginPlaying({ actorId: 'p1' }).snapshot.status, ROOM_STATUS.PLAYING);
  assert.equal(room.turn, 'p1');
  assert.throws(() => room.applyAction('p2', 'pass'), error => error.code === 'NOT_YOUR_TURN');
  const action = room.applyAction('p1', { action: 'pass', args: { source: 'fake' } }, { commandId: 'action-1' });
  assert.equal(action.nextTurn, 'p2');
  assert.equal(room.version, action.roomVersion);
  assert.throws(() => room.applyAction('p2', 'pass', { expectedRoomVersion: 0 }), error => error.code === 'VERSION_CONFLICT');
});

test('command IDs replay the same result without appending another event', () => {
  const room = makeRoom();
  const first = room.join({ id: 'p1' }, { commandId: 'join-1' });
  const version = room.version;
  const replay = room.join({ id: 'p1' }, { commandId: 'join-1' });
  assert.deepEqual(replay, first);
  assert.equal(room.version, version);
  assert.throws(
    () => room.join({ id: 'p1', name: 'different' }, { commandId: 'join-1' }),
    error => error.code === 'DUPLICATE_REQUEST'
  );
});

test('invalid owner transfer is rejected without partially mutating the room', () => {
  const room = makeRoom({ maxPlayers: 2 });
  room.join({ id: 'p1' });
  room.join({ id: 'p2' });
  const before = room.snapshot();
  const eventsBefore = room.events;
  assert.throws(
    () => room.leave('p1', { transferOwnerTo: 'missing' }),
    error => error.code === 'PLAYER_NOT_FOUND'
  );
  assert.deepEqual(room.snapshot(), before);
  assert.deepEqual(room.events, eventsBefore);
});

test('settlement, next-round and reconnect preserve ordered history without scoring assumptions', () => {
  const room = makeRoom({ totalRounds: 2 });
  fillRoom(room);
  readyRoom(room);
  room.start({ actorId: 'p1' });
  room.beginPlaying({ actorId: 'p1' });
  room.applyAction('p1', 'pass');
  room.settleRound({ outcome: 'draw', deltaByPlayer: { p1: 99 } }, { actorId: 'p1' });
  assert.equal(room.status, ROOM_STATUS.SETTLING);
  assert.deepEqual(room.snapshot().scores, { p1: 0, p2: 0, p3: 0, p4: 0 });
  room.nextRound({ actorId: 'p1' });
  assert.equal(room.status, ROOM_STATUS.NEXT_ROUND);
  room.beginNextRound({ actorId: 'p1' });
  room.beginPlaying({ actorId: 'p1' });
  room.settleRound(null, { actorId: 'p1' });
  room.nextRound({ actorId: 'p1' });
  assert.equal(room.status, ROOM_STATUS.FINISHED);

  const sync = room.reconnectSync('p2', 2);
  assert.equal(sync.syncRequired, false);
  assert.equal(sync.snapshot.roomVersion, room.version);
  assert.deepEqual(sync.events.map(event => event.version), room.events.filter(event => event.version > 2).map(event => event.version));
  assert.throws(() => room.reconnectSync('missing', 0), error => error.code === 'PLAYER_NOT_FOUND');
});

test('SYSTEM-authored settlement applies reconciled scores exactly once', () => {
  const room = makeRoom();
  fillRoom(room);
  readyRoom(room);
  room.start({ actorId: 'p1' });
  room.beginPlaying({ actorId: 'p1' });
  const settlement = {
    scoreAuthority: 'server',
    transfers: [
      { from: 'p2', to: 'p1', amount: 15 },
      { from: 'p3', to: 'p1', amount: 11 },
      { from: 'p4', to: 'p1', amount: 19 }
    ],
    deltaByPlayer: { p1: 45, p2: -15, p3: -11, p4: -19 }
  };
  assert.throws(
    () => room.settleRound(settlement, { actorId: 'p1' }),
    error => error.code === 'INVALID_ACTION'
  );
  const beforeSettlement = room.snapshot();
  const first = room.settleRound(settlement, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM',
    commandId: 'system-settle-1'
  });
  assert.deepEqual(room.snapshot().scores, { p1: 45, p2: -15, p3: -11, p4: -19 });
  const replay = room.settleRound(settlement, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM',
    commandId: 'system-settle-1'
  });
  assert.deepEqual(replay, first);
  assert.deepEqual(room.snapshot().scores, { p1: 45, p2: -15, p3: -11, p4: -19 });

  const recovered = Room.fromSnapshot(beforeSettlement);
  recovered.applyPersistedEvent(first.event);
  assert.deepEqual(recovered.snapshot().scores, room.snapshot().scores);
});

test('Susong zeng is server-owned, monotonic, idempotent and replayable', () => {
  const room = makeRoom({
    ruleSnapshot: {
      gameType: 'mahjong',
      ruleId: 'susong_v1',
      ruleVersion: '8931-apk-baseline.3',
      config: { zeng: 2 }
    }
  });
  fillRoom(room);
  const before = room.snapshot();
  const first = room.increaseZeng('p1', { actorId: 'p1', commandId: 'p1-zeng-1' });
  assert.equal(first.current, 1);
  const replay = room.increaseZeng('p1', { actorId: 'p1', commandId: 'p1-zeng-1' });
  assert.deepEqual(replay, first);
  assert.equal(room.snapshot().zengByPlayer.p1, 1);
  assert.throws(
    () => room.increaseZeng('p1', { actorId: 'p2' }),
    error => error.code === 'FORBIDDEN'
  );
  const recovered = Room.fromSnapshot(before);
  recovered.applyPersistedEvent(first.event);
  assert.deepEqual(recovered.snapshot().zengByPlayer, room.snapshot().zengByPlayer);

  const disabled = makeRoom({
    ruleSnapshot: {
      gameType: 'mahjong',
      ruleId: 'susong_v1',
      ruleVersion: '8931-apk-baseline.3',
      config: { zeng: 0 }
    }
  });
  fillRoom(disabled);
  assert.throws(() => disabled.increaseZeng('p1'), error => error.code === 'INVALID_ACTION');
});

test('history window asks for a full sync when the requested version is too old', () => {
  const room = makeRoom({ historyLimit: 2 });
  room.join({ id: 'p1' });
  room.join({ id: 'p2' });
  room.join({ id: 'p3' });
  assert.throws(() => room.eventsSince(0), error => error.code === 'VERSION_CONFLICT' && error.details[0].syncRequired === true);
});
