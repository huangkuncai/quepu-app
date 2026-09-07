import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSusongTileSet,
  createSusongShuffledWall,
  dealSusongOpeningHands,
  drawSusongLiveTile,
  drawSusongReplacementTile,
  getSusongDiscardReactionCandidates,
  isSusongReplacementFlower,
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

test('candidate replacement draw consumes the tail and respects the 14-tile reserve', () => {
  const draw = drawSusongReplacementTile(['first', 'second', 'tail'], { reserveTiles: 1 });
  assert.equal(draw.tileId, 'tail');
  assert.deepEqual(draw.remainingWall, ['first', 'second']);
  assert.equal(draw.wallRemaining, 2);
  assert.throws(
    () => drawSusongReplacementTile(Array.from({ length: 14 }, (_, index) => String(index))),
    /reserved wall boundary/
  );
});

test('normal turn draw consumes the live-wall head and respects the 14-tile reserve', () => {
  const draw = drawSusongLiveTile(['head', 'second', 'tail'], { reserveTiles: 1 });
  assert.equal(draw.tileId, 'head');
  assert.deepEqual(draw.remainingWall, ['second', 'tail']);
  assert.equal(draw.wallRemaining, 2);
  assert.throws(
    () => drawSusongLiveTile(Array.from({ length: 14 }, (_, index) => String(index))),
    /reserved wall boundary/
  );
});

test('server-owned hands generate peng, exposed-kong and next-seat chi candidates', () => {
  const hand = [
    'characters-5-1', 'characters-5-2', 'characters-5-3',
    'characters-3-1', 'characters-4-1', 'characters-6-1', 'characters-7-1'
  ];
  const nextSeat = getSusongDiscardReactionCandidates({
    hand,
    tileId: 'characters-5-4',
    isNextPlayer: true
  });
  assert.deepEqual(nextSeat.map(candidate => candidate.action), [
    'exposed_kong', 'peng', 'chi', 'chi', 'chi'
  ]);
  assert.deepEqual(nextSeat.filter(candidate => candidate.action === 'chi').map(candidate => candidate.sequence), [
    ['characters-3', 'characters-4', 'characters-5'],
    ['characters-4', 'characters-5', 'characters-6'],
    ['characters-5', 'characters-6', 'characters-7']
  ]);
  assert.deepEqual(
    getSusongDiscardReactionCandidates({ hand, tileId: 'characters-5-4' }).map(candidate => candidate.action),
    ['exposed_kong', 'peng']
  );
  assert.deepEqual(getSusongDiscardReactionCandidates({ hand, tileId: 'red_dragon-1' }), []);
});

function susongRoom(id = 'wall-room', piao = 'optional') {
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
        piao,
        forcedHu: false
      }
    }
  });
  for (const playerId of players) room.join({ id: playerId });
  for (const playerId of players) room.setReady(playerId);
  room.start({ actorId: 'A' });
  return room;
}

function passSusongReaction(room, prefix = 'reaction') {
  const responders = [];
  while (room.currentRound.turnPhase === 'reaction') {
    const playerId = room.turn;
    responders.push(playerId);
    room.applyAction(playerId, 'pass', { commandId: `${prefix}-${responders.length}-${playerId}` });
  }
  return responders;
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
  assert.ok(persisted.privateRoundState.remainingWall.length < 91);

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

  const replacementDraws = 91 - room.currentRound.wall.wallRemaining;
  assert.ok(replacementDraws > 0);
  assert.ok(Object.values(room.currentRound.flowerStates).every(state => state.pendingFlowerReplacements === 0));
  assert.deepEqual(room.currentRound.wall.handCountsByPlayer, { A: 13, B: 13, C: 14, D: 13 });
  const postReplacement = room.persistenceSnapshot();
  const conservedTiles = Object.values(postReplacement.privateRoundState.handsByPlayer).flat().length
    + Object.values(postReplacement.privateRoundState.resolvedFlowerTilesByPlayer).flat().length
    + postReplacement.privateRoundState.remainingWall.length;
  assert.equal(conservedTiles, 144);
  const recoveredAfterReplacement = Room.fromSnapshot(postReplacement);
  assert.deepEqual(recoveredAfterReplacement.persistenceSnapshot(), postReplacement);
  assert.equal(JSON.stringify(room.snapshot()).includes('resolvedFlowerTilesByPlayer'), false);
  room.beginPlaying({ actorId: 'A' });
  assert.equal(room.turn, 'C');
});

test('Susong turns enforce server-owned draw, hand ownership and public discards', () => {
  const room = susongRoom('turn-wall-room');
  room.dealSusongOpeningRound({ seed, dealerSeat: 2 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM',
    commandId: 'turn-deal'
  });
  room.beginPlaying({ actorId: 'A', commandId: 'turn-begin' });
  assert.equal(room.turn, 'C');
  assert.equal(room.currentRound.turnPhase, 'discard');
  assert.throws(
    () => room.applyAction('C', 'draw', { commandId: 'dealer-illegal-draw' }),
    error => error.code === 'INVALID_ACTION'
  );

  const dealerHand = room.snapshot({ viewerId: 'C' }).round.privateHand;
  const dealerDiscard = dealerHand.find(tileId => !tileId.includes('flower') && !tileId.includes('dragon'));
  const discarded = room.applyAction('C', {
    action: 'discard',
    args: { tileId: dealerDiscard }
  }, { commandId: 'dealer-discard' });
  assert.equal(discarded.event.type, 'SUSONG_TILE_DISCARDED');
  assert.equal(room.snapshot({ viewerId: 'C' }).round.privateHand.length, 13);
  assert.deepEqual(room.currentRound.discardsByPlayer.C, [dealerDiscard]);
  assert.equal(room.turn, 'D');
  assert.equal(room.currentRound.turnPhase, 'reaction');
  assert.deepEqual(room.snapshot({ viewerId: 'D' }).round.availableReactions, ['pass']);
  assert.equal('availableReactions' in room.snapshot({ viewerId: 'A' }).round, false);
  assert.throws(
    () => room.applyAction('A', 'pass', { commandId: 'out-of-order-pass' }),
    error => error.code === 'NOT_YOUR_TURN'
  );
  const firstPass = room.applyAction('D', 'pass', { commandId: 'dealer-reaction-D' });
  const versionAfterPass = room.version;
  assert.deepEqual(room.applyAction('D', 'pass', { commandId: 'dealer-reaction-D' }), firstPass);
  assert.equal(room.version, versionAfterPass);
  assert.deepEqual(passSusongReaction(room, 'dealer-reaction-rest'), ['A', 'B']);
  assert.equal(room.turn, 'D');
  assert.equal(room.currentRound.turnPhase, 'draw');
  assert.throws(
    () => room.applyAction('D', { action: 'draw', args: { tileId: 'forged' } }, { commandId: 'forged-draw' }),
    error => error.code === 'INVALID_ACTION'
  );

  const wallBefore = room.currentRound.wall.wallRemaining;
  const drawn = room.applyAction('D', 'draw', { commandId: 'D-draw' });
  assert.equal(drawn.event.type, 'SUSONG_TILE_DRAWN');
  assert.equal(JSON.stringify(drawn.event).includes('tileId'), false);
  assert.equal(room.currentRound.wall.wallRemaining < wallBefore, true);
  assert.equal(room.turn, 'D');
  assert.equal(room.currentRound.turnPhase, 'discard');
  assert.throws(
    () => room.applyAction('D', { action: 'discard', args: { tileId: dealerDiscard } }, { commandId: 'D-forged-discard' }),
    error => error.code === 'INVALID_ACTION'
  );

  const dHand = room.snapshot({ viewerId: 'D' }).round.privateHand;
  const dDiscard = dHand.find(tileId => !tileId.includes('flower') && !tileId.includes('dragon'));
  room.applyAction('D', { action: 'discard', args: { tileId: dDiscard } }, { commandId: 'D-discard' });
  assert.equal(room.turn, 'A');
  assert.equal(room.currentRound.turnPhase, 'reaction');
  const persisted = room.persistenceSnapshot();
  assert.deepEqual(Room.fromSnapshot(persisted).persistenceSnapshot(), persisted);
  assert.equal(JSON.stringify(room.snapshot()).includes('turnHistory'), false);
});

test('an unambiguous peng is private-player projected and resolved by the server', () => {
  const pengSeed = '1'.padStart(64, '0');
  const room = susongRoom('peng-room');
  room.dealSusongOpeningRound({ seed: pengSeed, dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  const discardedTileId = 'characters-8-2';
  assert.ok(room.snapshot({ viewerId: 'A' }).round.privateHand.includes(discardedTileId));
  room.applyAction('A', { action: 'discard', args: { tileId: discardedTileId } });

  assert.deepEqual(room.snapshot({ viewerId: 'B' }).round.availableReactions, ['pass']);
  assert.throws(
    () => room.applyAction('B', 'peng'),
    error => error.code === 'INVALID_ACTION'
  );
  room.applyAction('B', 'pass');
  assert.deepEqual(room.snapshot({ viewerId: 'C' }).round.availableReactions, ['pass', 'peng']);
  assert.equal('availableReactions' in room.snapshot({ viewerId: 'D' }).round, false);
  const claimed = room.applyAction('C', 'peng');
  assert.equal(claimed.event.type, 'SUSONG_REACTION_CLAIMED');
  assert.equal(room.turn, 'D');
  assert.equal(room.currentRound.turnPhase, 'reaction');

  const resolved = room.applyAction('D', 'pass');
  assert.equal(resolved.resolution.action, 'peng');
  assert.equal(resolved.resolution.playerId, 'C');
  assert.equal(room.turn, 'C');
  assert.equal(room.currentRound.turnPhase, 'discard');
  assert.equal(room.currentRound.pendingReaction, null);
  assert.deepEqual(room.currentRound.discardsByPlayer.A, []);
  assert.equal(room.currentRound.meldsByPlayer.C.length, 1);
  assert.equal(room.currentRound.meldsByPlayer.C[0].tileIds.length, 3);
  assert.equal(room.snapshot({ viewerId: 'C' }).round.privateHand.length, 11);
  assert.equal('availableReactions' in room.snapshot({ viewerId: 'C' }).round, false);

  const persisted = room.persistenceSnapshot();
  assert.deepEqual(Room.fromSnapshot(persisted).persistenceSnapshot(), persisted);
  const tampered = structuredClone(persisted);
  delete tampered.snapshotHash;
  tampered.round.meldsByPlayer.C[0].tileIds[0] = 'dots-1-1';
  assert.throws(
    () => Room.fromSnapshot(tampered),
    error => error.code === 'INVALID_ACTION'
  );
});

test('a wind peng adds one authoritative flower while an ordinary peng adds none', () => {
  const room = susongRoom('wind-peng-room');
  room.dealSusongOpeningRound({ seed: 'f'.padStart(64, '0'), dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  const before = room.currentRound.flowerStates.B;
  room.applyAction('A', { action: 'discard', args: { tileId: 'north-1' } });
  room.applyAction('B', 'peng');
  room.applyAction('C', 'pass');
  const resolved = room.applyAction('D', 'pass');

  assert.equal(resolved.resolution.meldFlowerUnits, 1);
  assert.equal(room.currentRound.flowerStates.B.meldFlowers, before.meldFlowers + 1);
  assert.equal(room.currentRound.flowerStates.B.countedFlowers, before.countedFlowers + 1);
  assert.deepEqual(Room.fromSnapshot(room.persistenceSnapshot()).persistenceSnapshot(), room.persistenceSnapshot());
});

test('an exposed kong consumes three private tiles, counts its flower and draws from the tail', () => {
  const kongSeed = 'b'.padStart(64, '0');
  const room = susongRoom('exposed-kong-room');
  room.dealSusongOpeningRound({ seed: kongSeed, dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  const discardedTileId = 'dots-9-2';
  const wallBefore = room.currentRound.wall.wallRemaining;
  const flowerCountBefore = room.currentRound.flowerStates.B.countedFlowers;
  assert.ok(room.snapshot({ viewerId: 'A' }).round.privateHand.includes(discardedTileId));
  room.applyAction('A', { action: 'discard', args: { tileId: discardedTileId } });

  assert.deepEqual(room.snapshot({ viewerId: 'B' }).round.availableReactions, [
    'pass', 'exposed_kong', 'peng'
  ]);
  room.applyAction('B', 'exposed_kong');
  room.applyAction('C', 'pass');
  const resolved = room.applyAction('D', 'pass');

  assert.equal(resolved.resolution.action, 'exposed_kong');
  assert.equal(resolved.resolution.playerId, 'B');
  assert.equal(resolved.resolution.meldFlowerUnits, 1);
  assert.equal(resolved.resolution.replacementCount, 1);
  assert.equal(room.currentRound.wall.wallRemaining, wallBefore - 1);
  assert.equal(room.currentRound.flowerStates.B.countedFlowers, flowerCountBefore + 1);
  assert.equal(room.currentRound.flowerStates.B.meldFlowers, 1);
  assert.equal(room.currentRound.meldsByPlayer.B[0].tileIds.length, 4);
  assert.equal(room.snapshot({ viewerId: 'B' }).round.privateHand.length, 11);
  assert.equal(room.turn, 'B');
  assert.equal(room.currentRound.turnPhase, 'discard');
  assert.deepEqual(room.currentRound.discardsByPlayer.A, []);
  assert.equal(JSON.stringify(resolved.event).includes('replacementTileId'), false);

  const persisted = room.persistenceSnapshot();
  assert.deepEqual(Room.fromSnapshot(persisted).persistenceSnapshot(), persisted);
  const tampered = structuredClone(persisted);
  delete tampered.snapshotHash;
  tampered.privateRoundState.turnHistory.at(-1).replacementTileId = 'characters-1-1';
  assert.throws(
    () => Room.fromSnapshot(tampered),
    error => error.code === 'INVALID_ACTION'
  );
});

test('an exposed kong replacement flower is resolved continuously from the tail', () => {
  const room = susongRoom('exposed-kong-flower-room');
  room.dealSusongOpeningRound({ seed: '1f6'.padStart(64, '0'), dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  const wallBefore = room.currentRound.wall.wallRemaining;
  const flowerCountBefore = room.currentRound.flowerStates.D.countedFlowers;
  room.applyAction('A', { action: 'discard', args: { tileId: 'dots-9-3' } });
  room.applyAction('B', 'pass');
  room.applyAction('C', 'pass');
  assert.deepEqual(room.snapshot({ viewerId: 'D' }).round.availableReactions, [
    'pass', 'exposed_kong', 'peng'
  ]);
  const resolved = room.applyAction('D', 'exposed_kong');

  assert.equal(resolved.resolution.flowerDisposition, 'replaced');
  assert.equal(resolved.resolution.replacementCount, 2);
  assert.equal(room.currentRound.wall.wallRemaining, wallBefore - 2);
  assert.equal(room.currentRound.flowerStates.D.meldFlowers, 1);
  assert.equal(room.currentRound.flowerStates.D.drawnFlowers, 1);
  assert.equal(room.currentRound.flowerStates.D.countedFlowers, flowerCountBefore + 2);
  assert.equal(room.snapshot({ viewerId: 'D' }).round.privateHand.length, 11);
  assert.deepEqual(Room.fromSnapshot(room.persistenceSnapshot()).persistenceSnapshot(), room.persistenceSnapshot());
});

test('RoomActor atomically checkpoints a resolved peng with its private hand mutation', async () => {
  const store = createMemoryGameStore();
  const room = susongRoom('actor-peng-room');
  const actor = new RoomActor({
    room,
    eventStore: store.eventStore,
    lock: store.lock,
    actorId: 'peng-actor-1',
    snapshotEvery: 100
  });
  await actor.dispatch({
    type: 'deal_susong_round',
    commandId: 'actor-peng-deal',
    payload: { seed: '1'.padStart(64, '0'), dealerSeat: 0 }
  }, { actorId: 'system:susong-rule-engine', actorRole: 'SYSTEM' });
  await actor.dispatch({ type: 'begin_playing', commandId: 'actor-peng-begin', payload: {} }, { actorId: 'A' });
  await actor.dispatch({
    type: 'action',
    commandId: 'actor-peng-discard',
    payload: { playerId: 'A', action: { action: 'discard', args: { tileId: 'characters-8-2' } } }
  }, { actorId: 'A' });
  for (const [playerId, action] of [['B', 'pass'], ['C', 'peng'], ['D', 'pass']]) {
    await actor.dispatch({
      type: 'action',
      commandId: `actor-peng-${playerId}`,
      payload: { playerId, action }
    }, { actorId: playerId });
  }
  const durable = store.eventStore.getSnapshot(room.id);
  assert.equal(durable.round.meldsByPlayer.C.length, 1);
  assert.equal(durable.privateRoundState.handsByPlayer.C.length, 11);
  const restarted = new RoomActor({
    roomId: room.id,
    eventStore: store.eventStore,
    lock: store.lock,
    actorId: 'peng-actor-2',
    snapshotEvery: 100
  });
  await restarted.recover();
  assert.deepEqual(restarted.snapshot({ viewerId: 'C' }), actor.snapshot({ viewerId: 'C' }));
});

test('non-piao live flower is replaced server-side without exposing either private tile', () => {
  const flowerSeed = '17'.padStart(64, '0');
  const room = susongRoom('turn-flower-replace-room');
  room.dealSusongOpeningRound({ seed: flowerSeed, dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  const aDiscard = room.snapshot({ viewerId: 'A' }).round.privateHand.find(tileId => !isSusongReplacementFlower(tileId));
  room.applyAction('A', { action: 'discard', args: { tileId: aDiscard } });
  passSusongReaction(room, 'replace-reaction');
  const wallBefore = room.currentRound.wall.wallRemaining;
  const result = room.applyAction('B', 'draw');
  assert.equal(result.flowerDisposition, 'replaced');
  assert.ok(result.resolvedCount >= 1);
  assert.ok(room.currentRound.wall.wallRemaining <= wallBefore - 2);
  assert.equal(room.snapshot({ viewerId: 'B' }).round.privateHand.length, 14);
  assert.equal(room.turn, 'B');
  assert.equal(room.currentRound.turnPhase, 'discard');
  assert.equal(JSON.stringify(result.event).includes('tileId'), false);
  assert.deepEqual(Room.fromSnapshot(room.persistenceSnapshot()).persistenceSnapshot(), room.persistenceSnapshot());
});

test('strong-piao live flower is discarded server-side and advances the turn', () => {
  const flowerSeed = '3c'.padStart(64, '0');
  const room = susongRoom('turn-flower-discard-room', 'strong');
  room.dealSusongOpeningRound({ seed: flowerSeed, dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  for (const playerId of players) {
    if (room.currentRound.flowerStates[playerId].status !== 'awaiting_piao_choice') continue;
    room.chooseSusongPiao(playerId, true, { actorId: playerId });
    while (room.currentRound.flowerStates[playerId].pendingFlowerDiscards > 0) {
      room.resolveSusongFlower(playerId, 'discard', { actorId: playerId });
    }
  }
  room.beginPlaying({ actorId: 'A' });
  const aDiscard = room.snapshot({ viewerId: 'A' }).round.privateHand.find(tileId => !isSusongReplacementFlower(tileId));
  room.applyAction('A', { action: 'discard', args: { tileId: aDiscard } });
  passSusongReaction(room, 'piao-reaction');
  const wallBefore = room.currentRound.wall.wallRemaining;
  const result = room.applyAction('B', 'draw');
  assert.equal(result.flowerDisposition, 'discarded');
  assert.equal(room.currentRound.wall.wallRemaining, wallBefore - 1);
  assert.equal(room.snapshot({ viewerId: 'B' }).round.privateHand.length, 13);
  assert.equal(room.turn, 'C');
  assert.equal(room.currentRound.turnPhase, 'draw');
  assert.equal(JSON.stringify(result.event).includes('tileId'), false);
});

test('Susong live wall settles as a zero-score draw at the reserved 14-tile boundary', () => {
  const room = susongRoom('reserved-wall-room');
  room.dealSusongOpeningRound({ seed, dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  let result;
  for (let step = 0; step < 300 && room.status === 'playing'; step += 1) {
    const playerId = room.turn;
    if (room.currentRound.turnPhase === 'reaction') {
      result = room.applyAction(playerId, 'pass', { commandId: `reserve-pass-${step}` });
    } else if (room.currentRound.turnPhase === 'draw') {
      result = room.applyAction(playerId, 'draw', { commandId: `reserve-draw-${step}` });
    } else {
      const tileId = room.snapshot({ viewerId: playerId }).round.privateHand
        .find(value => !isSusongReplacementFlower(value));
      result = room.applyAction(playerId, { action: 'discard', args: { tileId } }, {
        commandId: `reserve-discard-${step}`
      });
    }
  }
  assert.equal(room.status, 'settling');
  assert.equal(result.event.type, 'ROUND_SETTLING');
  assert.equal(result.reason, 'WALL_RESERVED_14');
  assert.ok(room.currentRound.wall.wallRemaining >= 14);
  assert.ok(room.currentRound.wall.wallRemaining <= 15);
  assert.deepEqual(result.settlement.deltaByPlayer, { A: 0, B: 0, C: 0, D: 0 });
  assert.equal(room.turn, null);
  assert.equal(room.currentRound.turnPhase, null);
  assert.deepEqual(Room.fromSnapshot(room.persistenceSnapshot()).persistenceSnapshot(), room.persistenceSnapshot());
});

test('RoomActor checkpoints private hands after every authoritative turn mutation', async () => {
  const store = createMemoryGameStore();
  const room = susongRoom('actor-turn-wall-room');
  const actor = new RoomActor({
    room,
    eventStore: store.eventStore,
    lock: store.lock,
    actorId: 'turn-actor-1',
    snapshotEvery: 100
  });
  await actor.dispatch({
    type: 'deal_susong_round',
    commandId: 'actor-turn-deal',
    payload: { seed, dealerSeat: 0 }
  }, { actorId: 'system:susong-rule-engine', actorRole: 'SYSTEM' });
  await actor.dispatch({
    type: 'begin_playing',
    commandId: 'actor-turn-begin',
    payload: {}
  }, { actorId: 'A' });
  const tileId = actor.snapshot({ viewerId: 'A' }).round.privateHand
    .find(value => !value.includes('flower') && !value.includes('dragon'));
  await actor.dispatch({
    type: 'action',
    commandId: 'actor-turn-discard',
    payload: { playerId: 'A', action: { action: 'discard', args: { tileId } } }
  }, { actorId: 'A' });
  let durable = store.eventStore.getSnapshot(room.id);
  assert.deepEqual(durable.round.discardsByPlayer.A, [tileId]);
  assert.equal(durable.privateRoundState.handsByPlayer.A.includes(tileId), false);

  await actor.dispatch({
    type: 'action',
    commandId: 'actor-turn-pass-B',
    payload: { playerId: 'B', action: 'pass' }
  }, { actorId: 'B' });
  const afterPass = new RoomActor({
    roomId: room.id,
    eventStore: store.eventStore,
    lock: store.lock,
    actorId: 'turn-actor-after-pass',
    snapshotEvery: 100
  });
  await afterPass.recover();
  assert.equal(afterPass.snapshot().round.turnPhase, 'reaction');
  assert.equal(afterPass.snapshot().turn, 'C');
  assert.deepEqual(afterPass.snapshot().round.pendingReaction.respondedPlayerIds, ['B']);
  for (const playerId of ['C', 'D']) {
    await afterPass.dispatch({
      type: 'action',
      commandId: `actor-turn-pass-${playerId}`,
      payload: { playerId, action: 'pass' }
    }, { actorId: playerId });
  }

  await afterPass.dispatch({
    type: 'action',
    commandId: 'actor-turn-draw',
    payload: { playerId: 'B', action: 'draw' }
  }, { actorId: 'B' });
  durable = store.eventStore.getSnapshot(room.id);
  assert.equal(durable.round.turnPhase, 'discard');
  assert.equal(durable.privateRoundState.handsByPlayer.B.length, 14);
  const restarted = new RoomActor({
    roomId: room.id,
    eventStore: store.eventStore,
    lock: store.lock,
    actorId: 'turn-actor-2',
    snapshotEvery: 100
  });
  await restarted.recover();
  assert.deepEqual(restarted.snapshot({ viewerId: 'B' }), afterPass.snapshot({ viewerId: 'B' }));
});

test('RoomActor forces an atomic private checkpoint even with sparse snapshots', async () => {
  const store = createMemoryGameStore();
  const room = susongRoom('actor-wall-room', 'strong');
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
  let durable = store.eventStore.getSnapshot(room.id);
  assert.equal(durable.privateRoundState.remainingWall.length, 91);
  const replacement = await actor.dispatch({
    type: 'choose_piao',
    commandId: 'actor-no-piao-command',
    payload: { playerId: 'A', choosesPiao: false }
  }, { actorId: 'A' });
  assert.ok(replacement.event.payload.resolvedCount >= 1);
  durable = store.eventStore.getSnapshot(room.id);
  assert.equal(durable.roomVersion, replacement.roomVersion);
  assert.equal(
    durable.privateRoundState.remainingWall.length,
    91 - replacement.event.payload.resolvedCount
  );

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

test('strong-piao flower discard leaves the wall untouched and reduces only that private hand', () => {
  const room = susongRoom('strong-piao-wall-room', 'strong');
  room.dealSusongOpeningRound({ seed, dealerSeat: 2 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM',
    commandId: 'strong-piao-deal'
  });
  assert.equal(room.currentRound.flowerStates.A.status, 'awaiting_piao_choice');
  room.chooseSusongPiao('A', true, { actorId: 'A', commandId: 'A-choose-piao' });
  const wallBefore = room.currentRound.wall.wallRemaining;
  const handBefore = room.snapshot({ viewerId: 'A' }).round.privateHand.length;
  const discarded = room.resolveSusongFlower('A', 'discard', {
    actorId: 'A',
    commandId: 'A-discard-opening-flower'
  });
  assert.equal(discarded.resolvedCount, 1);
  assert.equal(discarded.wallRemaining, wallBefore);
  assert.equal(room.snapshot({ viewerId: 'A' }).round.privateHand.length, handBefore - 1);
  assert.equal(JSON.stringify(discarded.event).includes('black_flower-1'), false);
  const persisted = room.persistenceSnapshot();
  assert.equal(persisted.privateRoundState.resolvedFlowerTilesByPlayer.A.length, 1);
  assert.deepEqual(Room.fromSnapshot(persisted).persistenceSnapshot(), persisted);
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
  assert.ok(result.room.round.wall.wallRemaining < 91);
  assert.ok([13, 14].includes(result.room.round.privateHand.length));
  assert.equal('privateRoundState' in result.room, false);
});
