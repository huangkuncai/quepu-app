import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSusongTileSet,
  createSusongShuffledWall,
  dealSusongOpeningHands,
  publicSusongWallState,
  verifySusongSeedCommitment
} from '../src/domain/rules/susong-wall.js';
import { Room } from '../src/domain/room.js';
import { RoomActor } from '../src/domain/room-actor.js';
import { createMemoryGameStore } from '../src/infra/persistence/index.js';
import { RoomService } from '../src/modules/room/service.js';

const players = ['A', 'B', 'C', 'D'];
const seed = '0123456789abcdef'.repeat(4);

test('candidate Susong wall contains 144 unique physical tiles', () => {
  const tiles = buildSusongTileSet();
  assert.equal(tiles.length, 144);
  assert.equal(new Set(tiles.map(tile => tile.id)).size, 144);
  assert.equal(tiles.filter(tile => tile.category === 'suited').length, 108);
  assert.equal(tiles.filter(tile => tile.category === 'wind').length, 16);
  assert.equal(tiles.filter(tile => tile.category === 'dragon').length, 12);
  assert.equal(tiles.filter(tile => tile.category === 'flower').length, 8);
  assert.equal(tiles.filter(tile => tile.isReplacementFlower).length, 20);
});

test('seeded shuffle is deterministic, unique and auditable', () => {
  const first = createSusongShuffledWall({ seed });
  const second = createSusongShuffledWall({ seed });
  const different = createSusongShuffledWall({ seed: 'ff'.repeat(32) });
  assert.deepEqual(first.tileIds, second.tileIds);
  assert.notDeepEqual(first.tileIds, different.tileIds);
  assert.equal(new Set(first.tileIds).size, 144);
  assert.equal(verifySusongSeedCommitment(seed, first.seedCommitment), true);
  assert.equal(verifySusongSeedCommitment('ee'.repeat(32), first.seedCommitment), false);
});

test('opening deal gives dealer 14, other players 13 and leaves 91 tiles', () => {
  const wall = createSusongShuffledWall({ seed });
  const dealt = dealSusongOpeningHands({ wall, playerIds: players, dealerId: 'C' });
  assert.deepEqual(dealt.handCountsByPlayer, { A: 13, B: 13, C: 14, D: 13 });
  assert.equal(dealt.wallRemaining, 91);
  const allDealt = players.flatMap(playerId => dealt.handsByPlayer[playerId]);
  assert.equal(allDealt.length, 53);
  assert.equal(new Set([...allDealt, ...dealt.remainingWall]).size, 144);
  assert.deepEqual([...allDealt, ...dealt.remainingWall].sort(), [...wall.tileIds].sort());
});

test('public wall state exposes counts and commitment but no secret material', () => {
  const wall = createSusongShuffledWall({ seed });
  const dealt = dealSusongOpeningHands({ wall, playerIds: players, dealerId: 'A' });
  const publicState = publicSusongWallState(dealt);
  const serialized = JSON.stringify(publicState);
  assert.equal(publicState.wallRemaining, 91);
  assert.deepEqual(publicState.handCountsByPlayer, { A: 14, B: 13, C: 13, D: 13 });
  assert.equal(serialized.includes(seed), false);
  assert.equal(serialized.includes('privateSeedHex'), false);
  assert.equal(serialized.includes('tileIds'), false);
  assert.equal(serialized.includes('handsByPlayer'), false);
  assert.equal(serialized.includes('remainingWall'), false);
});

test('wall and player validation rejects malformed authority input', () => {
  const wall = createSusongShuffledWall({ seed });
  assert.throws(
    () => dealSusongOpeningHands({ wall, playerIds: ['A', 'B', 'C', 'C'], dealerId: 'A' }),
    /four unique/
  );
  assert.throws(
    () => dealSusongOpeningHands({ wall, playerIds: players, dealerId: 'X' }),
    /dealerId/
  );
});

function susongRoom(id = 'wall-room') {
  const room = new Room({
    id,
    ownerId: 'A',
    ruleSnapshot: {
      gameType: 'mahjong',
      ruleId: 'susong_v1',
      ruleVersion: '8931-apk-baseline.3',
      config: {
        rounds: 4,
        scoreTiers: [1, 2, 3, 4],
        zeng: 1,
        piao: 'optional',
        forcedHu: false
      }
    }
  });
  for (const playerId of players) room.join({ id: playerId });
  for (const playerId of players) room.setReady(playerId);
  room.start({ actorId: 'A' });
  return room;
}

test('Room exposes only the viewer hand while persistence retains all private state', () => {
  const room = susongRoom();
  const dealt = room.dealSusongOpeningRound({ seed, dealerSeat: 2 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM',
    commandId: 'deal-wall-room'
  });
  const publicSnapshot = room.snapshot();
  const aSnapshot = room.snapshot({ viewerId: 'A' });
  const bSnapshot = room.snapshot({ viewerId: 'B' });
  const persisted = room.persistenceSnapshot();

  assert.equal(dealt.event.type, 'SUSONG_ROUND_DEALT');
  assert.equal(dealt.event.payload.dealerSeat, 2);
  assert.equal(JSON.stringify(dealt.event).includes(seed), false);
  assert.equal('privateHand' in publicSnapshot.round, false);
  assert.equal(aSnapshot.round.privateHand.length, 13);
  assert.equal(bSnapshot.round.privateHand.length, 13);
  assert.notDeepEqual(aSnapshot.round.privateHand, bSnapshot.round.privateHand);
  assert.equal(aSnapshot.snapshotHash, bSnapshot.snapshotHash);
  assert.equal(aSnapshot.snapshotHash, publicSnapshot.snapshotHash);
  assert.equal('handsByPlayer' in aSnapshot.round, false);
  assert.equal(persisted.privateRoundState.handsByPlayer.C.length, 14);
  assert.equal(persisted.privateRoundState.remainingWall.length, 91);

  const recovered = Room.fromSnapshot(persisted);
  assert.deepEqual(recovered.snapshot({ viewerId: 'A' }).round.privateHand, aSnapshot.round.privateHand);
  assert.equal('privateRoundState' in recovered.snapshot(), false);
  assert.deepEqual(recovered.persistenceSnapshot(), persisted);

  const tampered = structuredClone(persisted);
  delete tampered.snapshotHash;
  [tampered.privateRoundState.handsByPlayer.A[0], tampered.privateRoundState.handsByPlayer.B[0]] = [
    tampered.privateRoundState.handsByPlayer.B[0],
    tampered.privateRoundState.handsByPlayer.A[0]
  ];
  assert.throws(
    () => Room.fromSnapshot(tampered),
    error => error.code === 'INVALID_ACTION' && /committed seed/.test(error.details?.[0]?.message)
  );

  for (const [playerId, state] of Object.entries(room.currentRound.flowerStates)) {
    for (let count = 0; count < state.pendingFlowerReplacements; count += 1) {
      room.resolveSusongFlower(playerId, 'replace', {
        actorId: playerId,
        commandId: `${playerId}-opening-replacement-${count}`
      });
    }
  }
  room.beginPlaying({ actorId: 'A' });
  assert.equal(room.turn, 'C');
});

test('RoomActor forces an atomic private checkpoint even with sparse snapshots', async () => {
  const store = createMemoryGameStore();
  const room = susongRoom('actor-wall-room');
  const actor = new RoomActor({
    room,
    eventStore: store.eventStore,
    lock: store.lock,
    actorId: 'wall-actor-1',
    snapshotEvery: 100
  });
  const result = await actor.dispatch({
    type: 'deal_susong_round',
    commandId: 'actor-deal-command',
    payload: { seed, dealerSeat: 0 }
  }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  assert.equal(result.snapshot.round.wall.wallRemaining, 91);
  assert.equal('privateHand' in result.snapshot.round, false);
  const durable = store.eventStore.getSnapshot(room.id);
  assert.equal(durable.privateRoundState.remainingWall.length, 91);

  const restarted = new RoomActor({
    roomId: room.id,
    eventStore: store.eventStore,
    lock: store.lock,
    actorId: 'wall-actor-2',
    snapshotEvery: 100
  });
  await restarted.recover();
  assert.deepEqual(
    restarted.snapshot({ viewerId: 'A' }).round.privateHand,
    actor.snapshot({ viewerId: 'A' }).round.privateHand
  );
  assert.equal('privateRoundState' in restarted.snapshot(), false);
});

test('RoomService start immediately invokes authoritative Susong dealing', async () => {
  const room = susongRoom('service-wall-room');
  // Return to READY so RoomService owns the start/deal transition in this test.
  const readySnapshot = room.snapshot();
  const restored = Room.fromSnapshot({
    ...readySnapshot,
    status: 'ready',
    state: 'ready',
    round: null,
    roundId: null,
    roundNumber: 0,
    snapshotHash: undefined
  });
  const actor = { room: restored, version: restored.version };
  const registry = {
    get: roomId => roomId === restored.id ? actor : null,
    recover: async () => null,
    dispatch: async (roomId, command, context) => {
      assert.equal(roomId, restored.id);
      const result = restored.execute(command, context);
      actor.version = restored.version;
      return result;
    }
  };
  const service = new RoomService({ registry });
  const result = await service.dispatch({
    roomId: restored.id,
    principal: { userId: 'A', role: 'USER' },
    type: 'start_round',
    payload: {},
    commandId: 'service-start-command',
    requestId: 'service-start-request',
    roomVersion: restored.version
  });
  assert.equal(result.room.status, 'dealing');
  assert.equal(result.room.round.wall.wallRemaining, 91);
  assert.ok([13, 14].includes(result.room.round.privateHand.length));
  assert.equal('privateRoundState' in result.room, false);
});
