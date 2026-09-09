import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSusongTileSet,
  createSusongShuffledWall,
  dealSusongOpeningHands,
  drawSusongLiveTile,
  drawSusongReplacementTile,
  getSusongDiscardReactionCandidates,
  getSusongTurnKongCandidates,
  getSusongWinningHand,
  isSusongReplacementFlower,
  publicSusongWallState,
  verifySusongSeedCommitment
} from '../src/domain/rules/susong-wall.js';
import { scoreSusongRound } from '../src/domain/rules/susong-scoring.js';
import { createSusongFlowerState, SUSONG_RULE_VERSION } from '../src/domain/rules/susong.js';
import { Room } from '../src/domain/room.js';
import { RoomActor } from '../src/domain/room-actor.js';
import { createMemoryGameStore } from '../src/infra/persistence/index.js';
import { RoomService } from '../src/modules/room/service.js';

const players = ['A', 'B', 'C', 'D'];
const seed = '0123456789abcdef'.repeat(4);

test('confirmed Susong wall contains 144 unique physical tiles', () => {
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

test('opening deal gives dealer 14 by taking the first and fifth jump tiles', () => {
  const wall = createSusongShuffledWall({ seed });
  const dealt = dealSusongOpeningHands({ wall, playerIds: players, dealerId: 'C' });
  assert.deepEqual(dealt.handCountsByPlayer, { A: 13, B: 13, C: 14, D: 13 });
  assert.equal(dealt.wallRemaining, 91);
  assert.deepEqual(dealt.handsByPlayer.C.slice(-2), [wall.tileIds[48], wall.tileIds[52]]);
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

test('current rule deals the dealer 14 and starts directly in discard phase', () => {
  const room = new Room({
    id: 'current-opening-draw-room',
    ownerId: 'A',
    maxPlayers: 4,
    ruleSnapshot: {
      gameType: 'mahjong',
      ruleId: 'susong_v1',
      ruleVersion: SUSONG_RULE_VERSION,
      config: { rounds: 4, scoreTiers: [1, 2, 3, 4], zeng: 1, piao: 'optional', forcedHu: false }
    }
  });
  for (const playerId of players) room.join({ id: playerId });
  for (const playerId of players) room.setReady(playerId);
  room.start({ actorId: 'A' });
  room.dealSusongOpeningRound({ seed, dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  const publicFlowerTiles = room.snapshot({ viewerId: 'A' }).round.flowerTilesByPlayer;
  const allowedFlowerFaces = new Set([
    'red_dragon', 'green_dragon', 'white_dragon', 'red_flower', 'black_flower'
  ]);
  for (const playerId of players) {
    assert.equal(publicFlowerTiles[playerId].every(face =>
      allowedFlowerFaces.has(face.replace(/^(red|black)_flower-[1-4]$/, '$1_flower'))), true);
    assert.equal(
      publicFlowerTiles[playerId].length,
      room._privateRoundState.resolvedFlowerTilesByPlayer[playerId].length
    );
  }
  assert.deepEqual(room.currentRound.wall.handCountsByPlayer, { A: 14, B: 13, C: 13, D: 13 });
  const wallBefore = room.currentRound.wall.wallRemaining;

  room.beginPlaying({ actorId: 'A' });

  assert.equal(room.currentRound.wall.handCountsByPlayer.A, 14);
  assert.equal(room.currentRound.wall.wallRemaining, wallBefore);
  assert.deepEqual(room._privateRoundState.turnHistory, []);
  assert.equal(room.currentRound.turnPhase, 'discard');
  assert.equal(room.events.at(-1).type, 'ROUND_PLAYING');
  assert.deepEqual(Room.fromSnapshot(room.persistenceSnapshot()).persistenceSnapshot(), room.persistenceSnapshot());
});

test('current dealer can settle a heavenly win without an opening draw event', () => {
  const room = new Room({
    id: 'current-heavenly-win-room',
    ownerId: 'A',
    ruleSnapshot: {
      gameType: 'mahjong',
      ruleId: 'susong_v1',
      ruleVersion: SUSONG_RULE_VERSION,
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
  room.dealSusongOpeningRound({ seed, dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  room._privateRoundState.handsByPlayer.A = [
    'characters-1-1', 'characters-2-1', 'characters-3-1',
    'bamboo-1-1', 'bamboo-2-1', 'bamboo-3-1',
    'dots-4-1', 'dots-5-1', 'dots-6-1',
    'east-1', 'east-2', 'east-3', 'north-1', 'north-2'
  ];
  room.currentRound.wall.handCountsByPlayer.A = 14;
  room.currentRound.flowerStates.A = {
    ...room.currentRound.flowerStates.A,
    status: 'not_piao',
    openingFlowers: 1,
    countedFlowers: 1
  };

  const viewer = room.snapshot({ viewerId: 'A' });
  assert.deepEqual(room._privateRoundState.turnHistory, []);
  assert.equal(viewer.round.availableActions.includes('self_draw'), true);
  const result = room.applyAction('A', 'self_draw');

  assert.equal(result.event.type, 'ROUND_SETTLING');
  assert.equal(result.settlement.wins[0].tier, 'one_bamboo');
  assert.equal(result.settlement.wins[0].patterns.includes('heavenly_win'), true);
  assert.equal(room.events.some(event => event.type === 'SUSONG_TILE_DRAWN'), false);
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

test('replacement draw consumes the tail and respects the 14-tile reserve', () => {
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

test('server-owned turn state generates concealed and added kong candidates', () => {
  const candidates = getSusongTurnKongCandidates({
    hand: [
      'characters-5-1', 'characters-5-2', 'characters-5-3', 'characters-5-4',
      'east-4', 'dots-1-1'
    ],
    melds: [{
      action: 'peng',
      tileIds: ['east-1', 'east-2', 'east-3']
    }]
  });
  assert.deepEqual(candidates.map(candidate => ({
    action: candidate.action,
    face: candidate.face,
    consumeCount: candidate.consumeTileIds.length,
    meldIndex: candidate.meldIndex ?? null
  })), [
    { action: 'concealed_kong', face: 'characters-5', consumeCount: 4, meldIndex: null },
    { action: 'added_kong', face: 'east', consumeCount: 1, meldIndex: 0 }
  ]);
});

test('server recognizes standard, discard-completed and seven-pairs winning hands', () => {
  const standard = [
    'characters-1-1', 'characters-2-1', 'characters-3-1',
    'bamboo-1-1', 'bamboo-2-1', 'bamboo-3-1',
    'dots-4-1', 'dots-5-1', 'dots-6-1',
    'east-1', 'east-2', 'east-3',
    'north-1', 'north-2'
  ];
  assert.deepEqual(getSusongWinningHand({ hand: standard }), {
    winning: true,
    kind: 'standard',
    patterns: []
  });
  assert.equal(getSusongWinningHand({
    hand: standard.slice(0, -1),
    claimedTileId: 'north-2'
  }).winning, true);
  assert.equal(getSusongWinningHand({ hand: standard.slice(0, -1) }).winning, false);
  assert.equal(getSusongWinningHand({ hand: standard.slice(3), meldCount: 1 }).winning, true);
  const sevenPairs = [
    'characters-1-1', 'characters-1-2', 'characters-3-1', 'characters-3-2',
    'bamboo-2-1', 'bamboo-2-2', 'bamboo-7-1', 'bamboo-7-2',
    'dots-4-1', 'dots-4-2', 'dots-9-1', 'dots-9-2', 'west-1', 'west-2'
  ];
  assert.deepEqual(getSusongWinningHand({ hand: sevenPairs }), {
    winning: true,
    kind: 'seven_pairs',
    patterns: ['seven_pairs']
  });
});

test('server promotes unambiguous pure, mixed and all-triplets special hands', () => {
  const pure = [
    'characters-1-1', 'characters-1-2', 'characters-1-3',
    'characters-2-1', 'characters-3-1', 'characters-4-1',
    'characters-3-2', 'characters-4-2', 'characters-5-1',
    'characters-6-1', 'characters-7-1', 'characters-8-1',
    'characters-9-1', 'characters-9-2'
  ];
  assert.deepEqual(getSusongWinningHand({ hand: pure }).patterns, ['pure_one_suit']);
  const mixed = [
    'characters-1-1', 'characters-2-1', 'characters-3-1',
    'characters-4-1', 'characters-5-1', 'characters-6-1',
    'characters-7-1', 'characters-8-1', 'characters-9-1',
    'east-1', 'east-2', 'east-3', 'north-1', 'north-2'
  ];
  assert.deepEqual(getSusongWinningHand({ hand: mixed }).patterns, ['mixed_one_suit']);
  const triplets = [
    'characters-1-1', 'characters-1-2', 'characters-1-3',
    'bamboo-2-1', 'bamboo-2-2', 'bamboo-2-3',
    'dots-3-1', 'dots-3-2', 'dots-3-3',
    'east-1', 'east-2', 'east-3', 'north-1', 'north-2'
  ];
  assert.deepEqual(getSusongWinningHand({ hand: triplets }).patterns, ['all_triplets']);
});

test('Room derives heavenly, earthly and all-from-others patterns from authoritative history', () => {
  const room = susongRoom('history-pattern-room');
  room.dealSusongOpeningRound({ seed, dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  const winningHand = [
    'characters-1-1', 'characters-2-1', 'characters-3-1',
    'bamboo-1-1', 'bamboo-2-1', 'bamboo-3-1',
    'dots-4-1', 'dots-5-1', 'dots-6-1',
    'east-1', 'east-2', 'east-3', 'north-1', 'north-2'
  ];
  room._privateRoundState.handsByPlayer.A = [...winningHand];
  room.currentRound.flowerStates.A = {
    ...room.currentRound.flowerStates.A,
    status: 'not_piao',
    openingFlowers: 1,
    countedFlowers: 1
  };
  assert.ok(room._susongWinningCandidate('A', 'self_draw').patterns.includes('heavenly_win'));

  room._privateRoundState.handsByPlayer.B = [...winningHand];
  room.currentRound.flowerStates.B = { ...room.currentRound.flowerStates.A };
  room._privateRoundState.turnHistory = [
    { action: 'discard', playerId: 'A' },
    { action: 'draw', playerId: 'B' }
  ];
  assert.ok(room._susongWinningCandidate('B', 'self_draw').patterns.includes('earthly_win'));
  room._privateRoundState.turnHistory = [{ action: 'added_kong', playerId: 'B' }];
  assert.equal(room._susongWinningCandidate('B', 'self_draw').gangWinCount, 1);

  room._privateRoundState.handsByPlayer.C = ['south-1'];
  room.currentRound.flowerStates.C = { ...room.currentRound.flowerStates.A };
  room.currentRound.meldsByPlayer.C = [
    ['characters-1-1', 'characters-2-1', 'characters-3-1'],
    ['bamboo-1-1', 'bamboo-2-1', 'bamboo-3-1'],
    ['dots-4-1', 'dots-5-1', 'dots-6-1'],
    ['east-1', 'east-2', 'east-3']
  ].map(tileIds => ({ action: 'chi', playerId: 'C', fromPlayerId: 'B', tileIds }));
  room.currentRound.pendingReaction = { kind: 'discard', tileId: 'south-2' };
  assert.ok(room._susongWinningCandidate('C', 'discard').patterns.includes('all_from_others'));
});

test('Room counts only the current consecutive kong chain for a kong win', () => {
  const room = susongRoom('consecutive-kong-win-room');
  room.dealSusongOpeningRound({ seed, dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  room._privateRoundState.handsByPlayer.B = [
    'characters-1-1', 'characters-2-1', 'characters-3-1',
    'bamboo-1-1', 'bamboo-2-1', 'bamboo-3-1',
    'dots-4-1', 'dots-5-1', 'dots-6-1',
    'east-1', 'east-2', 'east-3', 'north-1', 'north-2'
  ];
  room.currentRound.flowerStates.B = {
    ...room.currentRound.flowerStates.B,
    status: 'not_piao',
    openingFlowers: 1,
    countedFlowers: 1
  };
  room._privateRoundState.turnHistory = [
    { action: 'draw', playerId: 'B' },
    { action: 'concealed_kong', playerId: 'B' },
    { action: 'added_kong', playerId: 'B' }
  ];

  const doubleKongWinner = room._susongWinningCandidate('B', 'self_draw');
  assert.equal(doubleKongWinner.gangWinCount, 2);
  const settlement = scoreSusongRound({
    config: room.ruleSnapshot.config,
    playerIds: players,
    outcome: 'self_draw',
    winners: [{
      winnerId: 'B',
      flowerState: room.currentRound.flowerStates.B,
      patterns: doubleKongWinner.patterns,
      gangWinCount: doubleKongWinner.gangWinCount
    }],
    zengByPlayer: { A: 0, B: 0, C: 0, D: 0 }
  });
  assert.equal(settlement.wins[0].tier, 'one_bamboo');

  room._privateRoundState.turnHistory = [
    { action: 'concealed_kong', playerId: 'B' },
    { action: 'discard', playerId: 'B' },
    { action: 'draw', playerId: 'B' }
  ];
  assert.equal(room._susongWinningCandidate('B', 'self_draw').gangWinCount, 0);
});

function susongRoom(
  id = 'wall-room',
  piao = 'optional',
  config = {},
  ruleVersion = '8931-apk-baseline.3'
) {
  const room = new Room({
    id,
    ownerId: 'A',
    ruleSnapshot: {
      gameType: 'mahjong',
      ruleId: 'susong_v1',
      ruleVersion,
      config: {
        rounds: 4,
        scoreTiers: [1, 2, 3, 4],
        zeng: 1,
        piao,
        forcedHu: false,
        ...config
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

function settleSusongFixture(room, facts) {
  const settlement = scoreSusongRound({
    config: room.ruleSnapshot.config,
    playerIds: players,
    zengByPlayer: Object.fromEntries(room.zengByPlayer),
    ...facts
  });
  room.settleRound(settlement, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  return settlement;
}

test('next Susong round assigns the first winner as dealer and rejects a dealer override', () => {
  const room = susongRoom('winner-dealer-room');
  room.dealSusongOpeningRound({ seed, dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  settleSusongFixture(room, {
    outcome: 'discard',
    discarderId: 'A',
    winners: [
      {
        winnerId: 'C',
        flowerState: room.currentRound.flowerStates.C,
        patterns: [],
        gangWinCount: 0
      },
      {
        winnerId: 'B',
        flowerState: room.currentRound.flowerStates.B,
        patterns: [],
        gangWinCount: 0
      }
    ]
  });
  room.nextRound({ actorId: 'A' });
  const beforeDealing = room.persistenceSnapshot();
  const dealing = room.beginNextRound({ actorId: 'A' });
  assert.equal(dealing.event.payload.dealerSeat, 2);
  assert.equal(room.currentRound.dealerSeat, 2);

  const forged = structuredClone(dealing.event);
  forged.payload.dealerSeat = 1;
  assert.throws(
    () => Room.fromSnapshot(beforeDealing).applyPersistedEvent(forged),
    error => error.code === 'INVALID_ACTION'
  );
  const replayed = Room.fromSnapshot(beforeDealing);
  replayed.applyPersistedEvent(dealing.event);
  assert.equal(replayed.currentRound.dealerSeat, 2);

  assert.throws(
    () => room.dealSusongOpeningRound({ seed: '1'.repeat(64), dealerSeat: 1 }, {
      actorId: 'system:susong-rule-engine',
      actorRole: 'SYSTEM'
    }),
    error => error.code === 'INVALID_ACTION'
  );
  room.dealSusongOpeningRound({ seed: '1'.repeat(64) }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  assert.deepEqual(room.currentRound.wall.handCountsByPlayer, { A: 13, B: 13, C: 14, D: 13 });
});

test('a drawn Susong round keeps the previous dealer for the next round', () => {
  const room = susongRoom('draw-dealer-room');
  room.dealSusongOpeningRound({ seed, dealerSeat: 3 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  settleSusongFixture(room, { outcome: 'draw' });
  room.nextRound({ actorId: 'A' });
  room.beginNextRound({ actorId: 'A' });
  assert.equal(room.currentRound.dealerSeat, 3);
});

function advanceSusongToAddedKong(room, maxSteps = 300) {
  for (let step = 0; step < maxSteps && room.status === 'playing'; step += 1) {
    const playerId = room.turn;
    const viewer = room.snapshot({ viewerId: playerId });
    if (viewer.round.availableActions?.includes('added_kong')) return { playerId, viewer };
    if (room.currentRound.turnPhase === 'reaction') {
      room.applyAction(playerId, viewer.round.availableReactions.includes('peng') ? 'peng' : 'pass', {
        commandId: `seek-added-kong-reaction-${step}`
      });
    } else if (room.currentRound.turnPhase === 'draw') {
      room.applyAction(playerId, 'draw', { commandId: `seek-added-kong-draw-${step}` });
    } else {
      const tileId = viewer.round.privateHand.find(value => !isSusongReplacementFlower(value));
      room.applyAction(playerId, { action: 'discard', args: { tileId } }, {
        commandId: `seek-added-kong-discard-${step}`
      });
    }
  }
  throw new Error('deterministic fixture did not reach an added kong');
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

  assert.deepEqual(room.snapshot({ viewerId: 'B' }).round.availableReactions, ['pass', 'chi']);
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
  room.currentRound.passedHuByPlayer.C = true;

  const resolved = room.applyAction('D', 'pass');
  assert.equal(resolved.resolution.action, 'peng');
  assert.equal(resolved.resolution.playerId, 'C');
  assert.equal(room.turn, 'C');
  assert.equal(room.currentRound.turnPhase, 'discard');
  assert.equal(room.currentRound.pendingReaction, null);
  assert.equal(room.currentRound.passedHuByPlayer.C, true);
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

test('only the next player receives server-indexed chi choices and can resolve one', () => {
  const room = susongRoom('chi-room');
  room.dealSusongOpeningRound({ seed: '0'.padStart(64, '0'), dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  room.applyAction('A', { action: 'discard', args: { tileId: 'dots-5-3' } });
  const bView = room.snapshot({ viewerId: 'B' });
  assert.deepEqual(bView.round.availableReactions, ['pass', 'chi']);
  assert.deepEqual(bView.round.reactionOptions, {
    chi: [
      { candidateIndex: 0, sequence: ['dots-3', 'dots-4', 'dots-5'] },
      { candidateIndex: 1, sequence: ['dots-4', 'dots-5', 'dots-6'] }
    ]
  });
  assert.equal('reactionOptions' in room.snapshot({ viewerId: 'C' }).round, false);
  assert.throws(
    () => room.applyAction('B', { action: 'chi', args: { candidateIndex: 2 } }),
    error => error.code === 'INVALID_ACTION'
  );
  room.applyAction('B', { action: 'chi', args: { candidateIndex: 1 } });
  room.applyAction('C', 'pass');
  const resolved = room.applyAction('D', 'pass');

  assert.equal(resolved.resolution.action, 'chi');
  assert.deepEqual(resolved.resolution.sequence, ['dots-4', 'dots-5', 'dots-6']);
  assert.equal(room.currentRound.meldsByPlayer.B[0].tileIds.length, 3);
  assert.equal(room.snapshot({ viewerId: 'B' }).round.privateHand.length, 11);
  assert.deepEqual(room.currentRound.discardsByPlayer.A, []);
  assert.equal(room.turn, 'B');
  assert.equal(room.currentRound.turnPhase, 'discard');
  assert.deepEqual(Room.fromSnapshot(room.persistenceSnapshot()).persistenceSnapshot(), room.persistenceSnapshot());
});

test('authoritative reaction priority is hu over peng over chi regardless of response order', () => {
  const createPriorityRoom = ({ id, dCanWin }) => {
    const room = susongRoom(id);
    room.dealSusongOpeningRound({ seed: '3'.padStart(64, '0'), dealerSeat: 0 }, {
      actorId: 'system:susong-rule-engine',
      actorRole: 'SYSTEM'
    });
    room.beginPlaying({ actorId: 'A' });
    room._privateRoundState.handsByPlayer = {
      A: [
        'characters-3-1', 'characters-4-1', 'characters-5-1', 'characters-6-1',
        'characters-7-1', 'characters-8-1', 'characters-9-1',
        'bamboo-1-1', 'bamboo-2-1', 'bamboo-3-1', 'bamboo-4-1',
        'bamboo-5-1', 'bamboo-6-1', 'bamboo-7-1'
      ],
      B: [
        'characters-1-1', 'characters-2-1',
        'bamboo-1-2', 'bamboo-2-2', 'bamboo-3-2', 'bamboo-4-2', 'bamboo-5-2',
        'bamboo-6-2', 'bamboo-7-2', 'bamboo-8-2', 'bamboo-9-2', 'dots-1-1', 'dots-2-1'
      ],
      C: [
        'characters-3-2', 'characters-3-3', 'characters-3-4',
        'dots-1-2', 'dots-2-2', 'dots-3-2', 'dots-4-2', 'dots-5-2',
        'dots-6-2', 'dots-7-2', 'dots-8-2', 'dots-9-2', 'south-1'
      ],
      D: dCanWin ? [
        'characters-1-4', 'characters-2-4',
        'bamboo-1-4', 'bamboo-2-4', 'bamboo-3-4',
        'dots-4-4', 'dots-5-4', 'dots-6-4',
        'east-1', 'east-2', 'east-3', 'north-1', 'north-2'
      ] : [
        'characters-1-2', 'characters-1-3', 'characters-1-4',
        'bamboo-1-3', 'bamboo-2-3', 'bamboo-4-3',
        'dots-1-3', 'dots-2-3', 'dots-4-3',
        'east-4', 'south-3', 'west-1', 'north-3'
      ]
    };
    room.currentRound.wall.handCountsByPlayer = Object.fromEntries(
      Object.entries(room._privateRoundState.handsByPlayer).map(([playerId, hand]) => [playerId, hand.length])
    );
    for (const playerId of ['A', 'B', 'C', 'D']) {
      room.currentRound.flowerStates[playerId] = {
        ...room.currentRound.flowerStates[playerId],
        status: 'not_piao',
        openingFlowers: 1,
        countedFlowers: 1
      };
    }
    room.applyAction('A', { action: 'discard', args: { tileId: 'characters-3-1' } });
    return room;
  };

  const huRoom = createPriorityRoom({ id: 'hu-peng-chi-priority-room', dCanWin: true });
  assert.equal(huRoom.snapshot({ viewerId: 'B' }).round.availableReactions.includes('chi'), true);
  huRoom.applyAction('B', { action: 'chi', args: { candidateIndex: 0 } });
  assert.equal(huRoom.snapshot({ viewerId: 'C' }).round.availableReactions.includes('peng'), true);
  assert.equal(huRoom.snapshot({ viewerId: 'C' }).round.availableReactions.includes('exposed_kong'), true);
  huRoom.applyAction('C', 'peng');
  assert.equal(huRoom.snapshot({ viewerId: 'D' }).round.availableReactions.includes('hu'), true);
  const huResult = huRoom.applyAction('D', 'hu');
  assert.equal(huResult.event.type, 'ROUND_SETTLING');
  assert.deepEqual(huResult.settlement.winnerIds, ['D']);
  assert.deepEqual(huRoom.currentRound.meldsByPlayer.B, []);
  assert.deepEqual(huRoom.currentRound.meldsByPlayer.C, []);

  const pengRoom = createPriorityRoom({ id: 'peng-chi-priority-room', dCanWin: false });
  pengRoom.applyAction('B', { action: 'chi', args: { candidateIndex: 0 } });
  pengRoom.applyAction('C', 'peng');
  const pengResult = pengRoom.applyAction('D', 'pass');
  assert.equal(pengResult.resolution.action, 'peng');
  assert.equal(pengResult.resolution.playerId, 'C');
  assert.deepEqual(pengRoom.currentRound.meldsByPlayer.B, []);
  assert.equal(pengRoom.currentRound.meldsByPlayer.C.at(-1).action, 'peng');
  assert.equal(pengRoom.turn, 'C');
  assert.equal(pengRoom.currentRound.turnPhase, 'discard');

  const kongRoom = createPriorityRoom({ id: 'kong-chi-priority-room', dCanWin: false });
  kongRoom.applyAction('B', { action: 'chi', args: { candidateIndex: 0 } });
  const wallBefore = kongRoom.currentRound.wall.wallRemaining;
  kongRoom.applyAction('C', 'exposed_kong');
  const kongResult = kongRoom.applyAction('D', 'pass');
  assert.equal(kongResult.resolution.action, 'exposed_kong');
  assert.equal(kongResult.resolution.playerId, 'C');
  assert.deepEqual(kongRoom.currentRound.meldsByPlayer.B, []);
  assert.equal(kongRoom.currentRound.meldsByPlayer.C.at(-1).action, 'exposed_kong');
  assert.ok(kongRoom.currentRound.wall.wallRemaining < wallBefore);
  assert.equal(kongRoom.turn, 'C');
  assert.equal(kongRoom.currentRound.turnPhase, 'discard');
});

test('a player cannot immediately discard the same face that was just claimed by chi', () => {
  const room = susongRoom('chi-discard-restriction-room');
  room.dealSusongOpeningRound({ seed: '0'.padStart(64, '0'), dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  room.applyAction('A', { action: 'discard', args: { tileId: 'dots-2-4' } });
  room.applyAction('B', { action: 'chi', args: { candidateIndex: 0 } });
  room.applyAction('C', 'pass');
  room.applyAction('D', 'pass');

  assert.ok(room.snapshot({ viewerId: 'B' }).round.privateHand.includes('dots-2-3'));
  assert.throws(
    () => room.applyAction('B', { action: 'discard', args: { tileId: 'dots-2-3' } }),
    error => error.code === 'INVALID_ACTION'
      && error.details?.[0]?.message === 'cannot discard the claimed face immediately after chi'
  );
});

test('a piao player cannot peng or kong a wind tile', () => {
  const room = susongRoom('piao-wind-claim-room');
  room.dealSusongOpeningRound({ seed: 'f'.padStart(64, '0'), dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  room.currentRound.flowerStates.B = createSusongFlowerState({
    piaoMode: 'strong',
    initialFlowerCount: 0
  });
  room.applyAction('A', { action: 'discard', args: { tileId: 'north-1' } });

  assert.deepEqual(room.snapshot({ viewerId: 'B' }).round.availableReactions, ['pass']);
  assert.throws(() => room.applyAction('B', 'peng'), error => error.code === 'INVALID_ACTION');
});

test('a piao player is not offered a concealed wind kong', () => {
  const room = susongRoom('piao-concealed-wind-kong-room');
  room.dealSusongOpeningRound({ seed: '5dc'.padStart(64, '0'), dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  room.currentRound.flowerStates.A = createSusongFlowerState({
    piaoMode: 'strong',
    initialFlowerCount: 0
  });

  const viewer = room.snapshot({ viewerId: 'A' });
  assert.equal(viewer.round.privateHand.filter(tileId => tileId.startsWith('north-')).length, 4);
  assert.equal(viewer.round.availableActions.includes('concealed_kong'), false);
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

test('a concealed kong is selected by server index, counts two flowers and replaces from the tail', () => {
  const room = susongRoom('concealed-kong-room');
  room.dealSusongOpeningRound({ seed: '2da'.padStart(64, '0'), dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  const before = room.persistenceSnapshot();
  const viewer = room.snapshot({ viewerId: 'A' });

  assert.ok(viewer.round.availableActions.includes('concealed_kong'));
  assert.deepEqual(viewer.round.kongOptions, {
    concealed_kong: [{ candidateIndex: 0, face: 'bamboo-9' }]
  });
  assert.equal(JSON.stringify(viewer.round.kongOptions).includes('bamboo-9-1'), false);
  assert.throws(
    () => room.applyAction('A', { action: 'concealed_kong', args: { candidateIndex: 1 } }),
    error => error.code === 'INVALID_ACTION'
  );
  room.currentRound.passedHuByPlayer.A = true;
  const result = room.applyAction('A', {
    action: 'concealed_kong',
    args: { candidateIndex: 0 }
  });

  assert.equal(result.event.type, 'SUSONG_KONG_RESOLVED');
  assert.equal(result.resolution.action, 'concealed_kong');
  assert.equal(result.resolution.meldFlowerUnits, 2);
  assert.equal(result.resolution.replacementCount, 1);
  assert.equal(room.currentRound.flowerStates.A.meldFlowers, 2);
  assert.equal(room.currentRound.wall.wallRemaining, before.round.wall.wallRemaining - 1);
  assert.equal(room.currentRound.meldsByPlayer.A[0].tileIds.length, 4);
  assert.equal(room.snapshot({ viewerId: 'A' }).round.privateHand.length, 11);
  assert.equal(room.turn, 'A');
  assert.equal(room.currentRound.turnPhase, 'discard');
  assert.equal(room.currentRound.passedHuByPlayer.A, true);
  assert.equal(JSON.stringify(result.event).includes('replacementTileId'), false);

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

test('RoomActor atomically checkpoints a concealed kong private mutation', async () => {
  const store = createMemoryGameStore();
  const room = susongRoom('actor-concealed-kong-room');
  const actor = new RoomActor({
    room,
    eventStore: store.eventStore,
    lock: store.lock,
    actorId: 'concealed-kong-actor-1',
    snapshotEvery: 100
  });
  await actor.dispatch({
    type: 'deal_susong_round',
    commandId: 'actor-concealed-kong-deal',
    payload: { seed: '2da'.padStart(64, '0'), dealerSeat: 0 }
  }, { actorId: 'system:susong-rule-engine', actorRole: 'SYSTEM' });
  await actor.dispatch({
    type: 'begin_playing',
    commandId: 'actor-concealed-kong-begin',
    payload: {}
  }, { actorId: 'A' });
  await actor.dispatch({
    type: 'action',
    commandId: 'actor-concealed-kong-action',
    payload: {
      playerId: 'A',
      action: { action: 'concealed_kong', args: { candidateIndex: 0 } }
    }
  }, { actorId: 'A' });

  const durable = store.eventStore.getSnapshot(room.id);
  assert.equal(durable.round.meldsByPlayer.A[0].action, 'concealed_kong');
  assert.equal(durable.privateRoundState.handsByPlayer.A.length, 11);
  const restarted = new RoomActor({
    roomId: room.id,
    eventStore: store.eventStore,
    lock: store.lock,
    actorId: 'concealed-kong-actor-2',
    snapshotEvery: 100
  });
  await restarted.recover();
  assert.deepEqual(restarted.snapshot({ viewerId: 'A' }), actor.snapshot({ viewerId: 'A' }));
});

test('an added kong waits for all robbing-kong responses before upgrading and replacing', () => {
  const room = susongRoom('added-kong-room');
  room.dealSusongOpeningRound({ seed: '1'.padStart(64, '0'), dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  const { playerId, viewer } = advanceSusongToAddedKong(room);
  assert.equal(playerId, 'B');
  assert.deepEqual(viewer.round.kongOptions.added_kong, [{
    candidateIndex: 0,
    face: 'characters-9',
    meldIndex: 1
  }]);
  const handCountBefore = viewer.round.privateHand.length;
  const wallBefore = room.currentRound.wall.wallRemaining;
  const flowersBefore = room.currentRound.flowerStates.B.meldFlowers;
  const beforeDeclaration = room.persistenceSnapshot();
  const declared = room.applyAction('B', { action: 'added_kong', args: { candidateIndex: 0 } });

  assert.equal(declared.event.type, 'SUSONG_ADDED_KONG_DECLARED');
  assert.equal(room.currentRound.pendingReaction.kind, 'added_kong');
  assert.equal(room.currentRound.meldsByPlayer.B[1].action, 'peng');
  assert.equal(room.snapshot({ viewerId: 'B' }).round.privateHand.length, handCountBefore);
  assert.equal(room.turn, 'C');
  assert.deepEqual(room.snapshot({ viewerId: 'C' }).round.availableReactions, ['pass']);
  const recoveredDeclaration = Room.fromSnapshot(beforeDeclaration);
  recoveredDeclaration.applyPersistedEvent(declared.event);
  assert.deepEqual(
    recoveredDeclaration.snapshot({ viewerId: 'C' }),
    room.snapshot({ viewerId: 'C' })
  );
  room.applyAction('C', 'pass');
  room.applyAction('D', 'pass');
  room.currentRound.passedHuByPlayer.B = true;
  const resolved = room.applyAction('A', 'pass');

  assert.equal(resolved.resolution.action, 'added_kong');
  assert.equal(resolved.resolution.meldFlowerUnits, 1);
  assert.equal(room.currentRound.meldsByPlayer.B[1].action, 'added_kong');
  assert.equal(room.currentRound.meldsByPlayer.B[1].tileIds.length, 4);
  assert.equal(room.currentRound.flowerStates.B.meldFlowers, flowersBefore + 1);
  assert.equal(room.currentRound.wall.wallRemaining, wallBefore - 1);
  assert.equal(room.snapshot({ viewerId: 'B' }).round.privateHand.length, handCountBefore);
  assert.equal(room.currentRound.pendingReaction, null);
  assert.equal(room.turn, 'B');
  assert.equal(room.currentRound.turnPhase, 'discard');
  assert.equal(room.currentRound.passedHuByPlayer.B, true);

  const persisted = room.persistenceSnapshot();
  assert.deepEqual(Room.fromSnapshot(persisted).persistenceSnapshot(), persisted);
  const tampered = structuredClone(persisted);
  delete tampered.snapshotHash;
  tampered.privateRoundState.turnHistory.at(-1).replacementTileId = 'characters-1-1';
  assert.throws(() => Room.fromSnapshot(tampered), error => error.code === 'INVALID_ACTION');
});

test('a legal robbing-kong winner cancels the added kong and charges its declarer', () => {
  const room = susongRoom('robbing-kong-room');
  room.dealSusongOpeningRound({ seed: '1'.padStart(64, '0'), dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  advanceSusongToAddedKong(room);
  room._privateRoundState.handsByPlayer.C = [
    'characters-1-1', 'characters-2-1', 'characters-3-1',
    'bamboo-1-1', 'bamboo-2-1', 'bamboo-3-1',
    'dots-4-1', 'dots-5-1', 'dots-6-1',
    'east-1', 'east-2', 'east-3', 'characters-9-2'
  ];
  room.currentRound.flowerStates.C = {
    ...room.currentRound.flowerStates.C,
    status: 'not_piao',
    openingFlowers: 1,
    countedFlowers: 1
  };
  room.applyAction('B', { action: 'added_kong', args: { candidateIndex: 0 } });

  assert.deepEqual(room.snapshot({ viewerId: 'C' }).round.availableReactions, ['pass', 'hu']);
  room.applyAction('C', 'hu');
  room.applyAction('D', 'pass');
  const result = room.applyAction('A', 'pass');

  assert.equal(result.event.type, 'ROUND_SETTLING');
  assert.deepEqual(result.settlement.winnerIds, ['C']);
  assert.equal(result.settlement.discarderId, 'B');
  assert.equal(result.settlement.wins[0].tier, 'one_bamboo');
  assert.equal(room.currentRound.meldsByPlayer.B[1].action, 'peng');
  assert.equal(room._privateRoundState.handsByPlayer.B.includes('characters-9-1'), true);
});

test('one added kong can be robbed by multiple authoritative winners', () => {
  const room = susongRoom('multi-robbing-kong-room');
  room.dealSusongOpeningRound({ seed: '1'.padStart(64, '0'), dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  advanceSusongToAddedKong(room);
  room._privateRoundState.handsByPlayer.C = [
    'characters-1-1', 'characters-2-1', 'characters-3-1',
    'bamboo-1-1', 'bamboo-2-1', 'bamboo-3-1',
    'dots-4-1', 'dots-5-1', 'dots-6-1',
    'east-1', 'east-2', 'east-3', 'characters-9-2'
  ];
  room._privateRoundState.handsByPlayer.D = [
    'characters-4-1', 'characters-5-1', 'characters-6-1',
    'bamboo-4-1', 'bamboo-5-1', 'bamboo-6-1',
    'dots-1-1', 'dots-2-1', 'dots-3-1',
    'south-1', 'south-2', 'south-3', 'characters-9-3'
  ];
  for (const playerId of ['C', 'D']) {
    room.currentRound.flowerStates[playerId] = {
      ...room.currentRound.flowerStates[playerId],
      status: 'not_piao',
      openingFlowers: 1,
      countedFlowers: 1
    };
  }
  room.applyAction('B', { action: 'added_kong', args: { candidateIndex: 0 } });

  assert.deepEqual(room.snapshot({ viewerId: 'C' }).round.availableReactions, ['pass', 'hu']);
  room.applyAction('C', 'hu');
  assert.deepEqual(room.snapshot({ viewerId: 'D' }).round.availableReactions, ['pass', 'hu']);
  room.applyAction('D', 'hu');
  const result = room.applyAction('A', 'pass');

  assert.equal(result.event.type, 'ROUND_SETTLING');
  assert.deepEqual(result.settlement.winnerIds, ['C', 'D']);
  assert.equal(result.settlement.discarderId, 'B');
  assert.deepEqual(result.settlement.wins.map(win => win.tier), ['one_bamboo', 'one_bamboo']);
  assert.deepEqual(result.settlement.transfers.map(transfer => [transfer.from, transfer.to]), [
    ['B', 'C'],
    ['B', 'D']
  ]);
  assert.equal(room.currentRound.meldsByPlayer.B[1].action, 'peng');
  assert.equal(room._privateRoundState.handsByPlayer.B.includes('characters-9-1'), true);
});

test('passing a legal robbing-kong win enters pass-hu until the player draws', () => {
  const room = susongRoom('pass-robbing-kong-room');
  room.dealSusongOpeningRound({ seed: '1'.padStart(64, '0'), dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  advanceSusongToAddedKong(room);
  room._privateRoundState.handsByPlayer.C = [
    'characters-1-1', 'characters-2-1', 'characters-3-1',
    'bamboo-1-1', 'bamboo-2-1', 'bamboo-3-1',
    'dots-4-1', 'dots-5-1', 'dots-6-1',
    'east-1', 'east-2', 'east-3', 'characters-9-2'
  ];
  room.currentRound.flowerStates.C = {
    ...room.currentRound.flowerStates.C,
    status: 'not_piao',
    openingFlowers: 1,
    countedFlowers: 1
  };
  room.applyAction('B', { action: 'added_kong', args: { candidateIndex: 0 } });

  assert.deepEqual(room.snapshot({ viewerId: 'C' }).round.availableReactions, ['pass', 'hu']);
  room.applyAction('C', 'pass');
  assert.equal(room.currentRound.passedHuByPlayer.C, true);
  room.applyAction('D', 'pass');
  room.applyAction('A', 'pass');
  assert.equal(room.currentRound.passedHuByPlayer.C, true);

  const bHand = room.snapshot({ viewerId: 'B' }).round.privateHand;
  const discardTileId = bHand.find(tileId => !isSusongReplacementFlower(tileId));
  room.applyAction('B', { action: 'discard', args: { tileId: discardTileId } });
  assert.equal(room.snapshot({ viewerId: 'C' }).round.availableReactions.includes('hu'), false);
  room.applyAction('C', 'pass');
  room.applyAction('D', 'pass');
  room.applyAction('A', 'pass');
  assert.equal(room.turn, 'C');
  assert.equal(room.currentRound.turnPhase, 'draw');
  assert.equal(room.currentRound.passedHuByPlayer.C, true);
  room.applyAction('C', 'draw');
  assert.equal(room.currentRound.passedHuByPlayer.C, false);
});

test('a discard win is recognized and settled entirely from authoritative room state', () => {
  const room = susongRoom('discard-win-room');
  room.dealSusongOpeningRound({ seed: 'e68'.padStart(64, '0'), dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  room.applyAction('A', { action: 'discard', args: { tileId: 'dots-6-3' } });
  room.applyAction('B', 'pass');
  room.applyAction('C', 'pass');
  assert.deepEqual(room.snapshot({ viewerId: 'D' }).round.availableReactions, ['pass', 'hu']);
  assert.throws(
    () => room.applyAction('D', { action: 'hu', args: { tier: 'one_bamboo', score: 999 } }),
    error => error.code === 'INVALID_ACTION'
  );
  const beforeSettlement = room.persistenceSnapshot();
  const result = room.applyAction('D', 'hu');

  assert.equal(result.event.type, 'ROUND_SETTLING');
  assert.equal(room.status, 'settling');
  assert.deepEqual(result.settlement.winnerIds, ['D']);
  assert.equal(result.settlement.outcome, 'discard');
  assert.equal(result.settlement.scoreOrderVersion, 'zeng-piao-flower-sanxi-v1');
  assert.deepEqual(
    result.settlement.transfers[0].trace.map(item => item.stage),
    ['winner_zeng', 'payer_zeng', 'piao', 'flower_tier', 'sanxi']
  );
  assert.equal(result.settlement.discarderId, 'A');
  assert.deepEqual(result.settlement.deltaByPlayer, { A: -1, B: 0, C: 0, D: 1 });
  assert.deepEqual(room.snapshot().scores, { A: -1, B: 0, C: 0, D: 1 });
  assert.deepEqual(Room.fromSnapshot(room.persistenceSnapshot()).persistenceSnapshot(), room.persistenceSnapshot());
  const forgedEvent = structuredClone(result.event);
  forgedEvent.payload.settlement.transfers[0].trace[3].subtotal += 100;
  assert.throws(
    () => Room.fromSnapshot(beforeSettlement).applyPersistedEvent(forgedEvent),
    error => error.code === 'INVALID_ACTION'
  );
  const forgedSnapshot = structuredClone(room.persistenceSnapshot());
  delete forgedSnapshot.snapshotHash;
  forgedSnapshot.round.settlement.transfers[0].trace[3].subtotal += 100;
  assert.throws(
    () => Room.fromSnapshot(forgedSnapshot),
    error => error.code === 'INVALID_ACTION'
  );
});

test('current rule derives the no-flower discarder cap from server flower state', () => {
  const room = susongRoom(
    'no-flower-discarder-room',
    'optional',
    {},
    SUSONG_RULE_VERSION
  );
  room.dealSusongOpeningRound({ seed: 'e68'.padStart(64, '0'), dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  room.currentRound.flowerStates.A = {
    ...room.currentRound.flowerStates.A,
    status: 'not_piao',
    openingFlowers: 0,
    drawnFlowers: 0,
    meldFlowers: 0,
    countedFlowers: 0,
    pendingFlowerDiscards: 0,
    pendingFlowerReplacements: 0
  };
  room.applyAction('A', { action: 'discard', args: { tileId: 'dots-6-3' } });
  room.applyAction('B', 'pass');
  room.applyAction('C', 'pass');
  const beforeSettlement = room.persistenceSnapshot();
  const result = room.applyAction('D', 'hu');

  assert.equal(result.settlement.discarderNoFlower, true);
  assert.equal(result.settlement.wins[0].tier, 'one_bamboo');
  assert.equal(result.settlement.wins[0].cappedByNoFlowerDiscarder, true);
  assert.equal(result.settlement.transfers[0].trace[2].cappedByNoFlowerDiscarder, true);
  const forged = structuredClone(result.event);
  forged.payload.settlement.discarderNoFlower = false;
  forged.payload.settlement.wins[0].cappedByNoFlowerDiscarder = false;
  forged.payload.settlement.transfers[0].trace[2].cappedByNoFlowerDiscarder = false;
  assert.throws(
    () => Room.fromSnapshot(beforeSettlement).applyPersistedEvent(forged),
    error => error.code === 'INVALID_ACTION'
  );
});

test('passing a legal discard win blocks further discard wins until the player turn comes around', () => {
  const room = susongRoom('pass-hu-circle-room');
  room.dealSusongOpeningRound({ seed: 'e68'.padStart(64, '0'), dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  room.applyAction('A', { action: 'discard', args: { tileId: 'dots-6-3' } });
  room.applyAction('B', 'pass');
  room.applyAction('C', 'pass');
  assert.deepEqual(room.snapshot({ viewerId: 'D' }).round.availableReactions, ['pass', 'hu']);
  room.applyAction('D', 'pass');

  assert.equal(room.currentRound.passedHuByPlayer.D, true);
  assert.deepEqual(
    Room.fromSnapshot(room.persistenceSnapshot()).currentRound.passedHuByPlayer,
    room.currentRound.passedHuByPlayer
  );
  for (let step = 0; step < 40; step += 1) {
    if (room.turn === 'D' && room.currentRound.turnPhase === 'draw') break;
    const playerId = room.turn;
    const viewer = room.snapshot({ viewerId: playerId });
    if (room.currentRound.turnPhase === 'reaction') {
      room.applyAction(playerId, 'pass');
    } else if (room.currentRound.turnPhase === 'draw') {
      room.applyAction(playerId, 'draw');
    } else {
      const tileId = viewer.round.privateHand.find(value => !isSusongReplacementFlower(value));
      room.applyAction(playerId, { action: 'discard', args: { tileId } });
    }
  }
  assert.equal(room.turn, 'D');
  assert.equal(room.currentRound.turnPhase, 'draw');
  assert.equal(room.currentRound.passedHuByPlayer.D, true);
  room.applyAction('D', 'draw');
  assert.equal(room.currentRound.passedHuByPlayer.D, false);
  assert.deepEqual(Room.fromSnapshot(room.persistenceSnapshot()).persistenceSnapshot(), room.persistenceSnapshot());
});

test('forced-hu rooms settle every eligible discard winner without waiting for client input', () => {
  const room = susongRoom('forced-discard-win-room', 'optional', { forcedHu: true });
  room.dealSusongOpeningRound({ seed: 'e68'.padStart(64, '0'), dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  const versionBefore = room.version;
  const result = room.applyAction('A', { action: 'discard', args: { tileId: 'dots-6-3' } });

  assert.equal(result.event.type, 'ROUND_SETTLING');
  assert.equal(room.version, versionBefore + 2);
  assert.deepEqual(room.events.slice(-2).map(event => event.type), [
    'SUSONG_TILE_DISCARDED', 'ROUND_SETTLING'
  ]);
  assert.deepEqual(result.settlement.winnerIds, ['D']);
  assert.deepEqual(result.settlement.deltaByPlayer, { A: -1, B: 0, C: 0, D: 1 });
});

test('RoomActor persists an automatic forced-hu discard and settlement atomically', async () => {
  const store = createMemoryGameStore();
  const room = susongRoom('actor-forced-win-room', 'optional', { forcedHu: true });
  const actor = new RoomActor({
    room,
    eventStore: store.eventStore,
    lock: store.lock,
    actorId: 'forced-win-actor-1',
    snapshotEvery: 100
  });
  await actor.dispatch({
    type: 'deal_susong_round',
    commandId: 'actor-forced-win-deal',
    payload: { seed: 'e68'.padStart(64, '0'), dealerSeat: 0 }
  }, { actorId: 'system:susong-rule-engine', actorRole: 'SYSTEM' });
  await actor.dispatch({
    type: 'begin_playing',
    commandId: 'actor-forced-win-begin',
    payload: {}
  }, { actorId: 'A' });
  const result = await actor.dispatch({
    type: 'action',
    commandId: 'actor-forced-win-discard',
    payload: { playerId: 'A', action: { action: 'discard', args: { tileId: 'dots-6-3' } } }
  }, { actorId: 'A' });

  assert.equal(result.event.type, 'ROUND_SETTLING');
  const durable = store.eventStore.getSnapshot(room.id);
  assert.equal(durable.status, 'settling');
  assert.equal(durable.round.settlement.scoreOrderVersion, 'zeng-piao-flower-sanxi-v1');
  assert.deepEqual(
    durable.round.settlement.transfers[0].trace.map(item => item.stage),
    ['winner_zeng', 'payer_zeng', 'piao', 'flower_tier', 'sanxi']
  );
  const restarted = new RoomActor({
    roomId: room.id,
    eventStore: store.eventStore,
    lock: store.lock,
    actorId: 'forced-win-actor-2',
    snapshotEvery: 100
  });
  await restarted.recover();
  assert.deepEqual(restarted.snapshot(), actor.snapshot());
  assert.deepEqual(
    restarted.snapshot().round.settlement,
    actor.snapshot().round.settlement
  );
});

test('a legal self-draw is privately projected and settled without client-authored facts', () => {
  const room = susongRoom('self-draw-room');
  room.dealSusongOpeningRound({ seed: '762'.padStart(64, '0'), dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  let winnerId = null;
  for (let step = 0; step < 250 && room.status === 'playing'; step += 1) {
    const playerId = room.turn;
    if (room.currentRound.turnPhase === 'reaction') {
      room.applyAction(playerId, 'pass', { commandId: `self-draw-pass-${step}` });
    } else if (room.currentRound.turnPhase === 'draw') {
      room.applyAction(playerId, 'draw', { commandId: `self-draw-draw-${step}` });
    } else {
      const snapshot = room.snapshot({ viewerId: playerId });
      if (snapshot.round.availableActions.includes('self_draw')) {
        winnerId = playerId;
        break;
      }
      const tileId = snapshot.round.privateHand.find(value => !isSusongReplacementFlower(value));
      room.applyAction(playerId, { action: 'discard', args: { tileId } }, {
        commandId: `self-draw-discard-${step}`
      });
    }
  }
  assert.equal(winnerId, 'D');
  assert.equal('availableActions' in room.snapshot({ viewerId: 'A' }).round, false);
  const result = room.applyAction(winnerId, 'self_draw');

  assert.equal(result.event.type, 'ROUND_SETTLING');
  assert.deepEqual(result.settlement.winnerIds, ['D']);
  assert.equal(result.settlement.outcome, 'self_draw');
  assert.deepEqual(result.settlement.deltaByPlayer, { A: -2, B: -2, C: -2, D: 6 });
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
  assert.equal(result.settlement.scoreOrderVersion, 'zeng-piao-flower-sanxi-v1');
  assert.equal(result.settlement.scoreAuthority, 'server');
  assert.deepEqual(result.settlement.transfers, []);
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
  assert.equal(result.room.status, 'playing');
  assert.ok(result.room.round.wall.wallRemaining < 91);
  assert.ok([13, 14].includes(result.room.round.privateHand.length));
  assert.equal('privateRoundState' in result.room, false);
});

test('RoomService advances, assigns and deals the next Susong round atomically', async () => {
  const room = susongRoom('service-next-round-room');
  room.dealSusongOpeningRound({ seed, dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  settleSusongFixture(room, {
    outcome: 'self_draw',
    winners: [{
      winnerId: 'C',
      flowerState: room.currentRound.flowerStates.C,
      patterns: [],
      gangWinCount: 0
    }]
  });
  const actor = { room, version: room.version };
  const registry = {
    get: roomId => roomId === room.id ? actor : null,
    recover: async () => null,
    dispatch: async (roomId, command, context) => {
      assert.equal(roomId, room.id);
      const result = room.execute(command, context);
      actor.version = room.version;
      return result;
    }
  };
  const service = new RoomService({ registry });
  const result = await service.dispatch({
    roomId: room.id,
    principal: { userId: 'A', role: 'USER' },
    type: 'next_round',
    payload: { autoDeal: false, dealerSeat: 1 },
    commandId: 'service-next-round-command',
    requestId: 'service-next-round-request',
    roomVersion: room.version
  });
  assert.equal(result.room.status, 'playing');
  assert.equal(result.room.round.roundNumber, 2);
  assert.equal(result.room.round.dealerSeat, 2);
  assert.equal(result.room.round.wall.handCountsByPlayer.C, 14);
  assert.equal('privateRoundState' in result.room, false);
});

test('RoomService starts play when the final strong-piao opening flower is resolved', async () => {
  const room = susongRoom('service-strong-piao-room', 'strong');
  room.dealSusongOpeningRound({ seed, dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  const actor = { room, version: room.version };
  const registry = {
    get: roomId => roomId === room.id ? actor : null,
    recover: async () => null,
    dispatch: async (roomId, command, context) => {
      const result = room.execute(command, context);
      actor.version = room.version;
      return result;
    }
  };
  const service = new RoomService({ registry });
  let commandSequence = 0;
  const dispatch = (playerId, type, payload) => service.dispatch({
    roomId: room.id,
    principal: { userId: playerId, role: 'USER' },
    type,
    payload,
    commandId: `strong-opening-${++commandSequence}`,
    requestId: `strong-opening-request-${commandSequence}`,
    roomVersion: room.version
  });
  for (const playerId of players) {
    if (room.currentRound.flowerStates[playerId].status !== 'awaiting_piao_choice') continue;
    await dispatch(playerId, 'choose_piao', { choosesPiao: true });
    while (room.currentRound.flowerStates[playerId].pendingFlowerDiscards > 0) {
      await dispatch(playerId, 'resolve_flower', { action: 'discard' });
    }
  }
  assert.equal(room.status, 'playing');
  assert.equal(room.turn, 'A');
  assert.equal(room.currentRound.turnPhase, 'discard');
  assert.equal(room.events.filter(event => event.type === 'ROUND_PLAYING').length, 1);
});

test('durable next-round retries do not duplicate dealer or wall events', async () => {
  const store = createMemoryGameStore();
  const room = susongRoom('durable-next-round-room');
  room.dealSusongOpeningRound({ seed, dealerSeat: 0 }, {
    actorId: 'system:susong-rule-engine',
    actorRole: 'SYSTEM'
  });
  room.beginPlaying({ actorId: 'A' });
  settleSusongFixture(room, {
    outcome: 'self_draw',
    winners: [{
      winnerId: 'D',
      flowerState: room.currentRound.flowerStates.D,
      patterns: [],
      gangWinCount: 0
    }]
  });
  const actor = new RoomActor({
    room,
    eventStore: store.eventStore,
    lock: store.lock,
    actorId: 'next-round-actor-1'
  });
  const registry = {
    get: roomId => roomId === room.id ? actor : null,
    recover: async () => null,
    dispatch: (roomId, command, context) => actor.dispatch(command, context)
  };
  const service = new RoomService({ registry });
  const previousVersion = room.version;
  const request = {
    roomId: room.id,
    principal: { userId: 'A', role: 'USER' },
    type: 'next_round',
    payload: {},
    commandId: 'durable-next-round-command',
    requestId: 'durable-next-round-request',
    roomVersion: previousVersion
  };
  const first = await service.dispatch(request);
  const versionAfterFirst = actor.version;
  const eventsAfterFirst = await store.eventStore.getEvents(room.id, { afterVersion: previousVersion });
  assert.deepEqual(eventsAfterFirst.map(event => event.type), [
    'NEXT_ROUND',
    'ROUND_DEALING',
    'SUSONG_ROUND_DEALT',
    'ROUND_PLAYING'
  ]);
  assert.equal(first.room.round.dealerSeat, 3);

  const replay = await service.dispatch(request);
  assert.equal(actor.version, versionAfterFirst);
  assert.deepEqual(replay.room, first.room);
  assert.equal(
    (await store.eventStore.getEvents(room.id, { afterVersion: previousVersion })).length,
    eventsAfterFirst.length
  );

  const restarted = new RoomActor({
    roomId: room.id,
    eventStore: store.eventStore,
    lock: store.lock,
    actorId: 'next-round-actor-2'
  });
  await restarted.recover();
  assert.deepEqual(restarted.snapshot({ viewerId: 'A' }), actor.snapshot({ viewerId: 'A' }));
  assert.equal(restarted.room.currentRound.dealerSeat, 3);
});
