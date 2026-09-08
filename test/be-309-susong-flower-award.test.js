import assert from 'node:assert/strict';
import test from 'node:test';

import { createSusongFlowerState, resolveSusongFlowers } from '../src/domain/rules/susong.js';
import {
  countSusongFlowerAwards,
  deriveSusongFlowerAwardCounts,
  scoreSusongRound,
  validateSusongSettlementAudit
} from '../src/domain/rules/susong-scoring.js';

const players = ['A', 'B', 'C', 'D'];
const config = { rounds: 8, scoreTiers: [5, 6, 7, 8], zeng: 0, piao: 'optional', forcedHu: false };
const zengByPlayer = { A: 0, B: 0, C: 0, D: 0 };

function flowers(count = 4) {
  return resolveSusongFlowers(
    createSusongFlowerState({ piaoMode: 'optional', initialFlowerCount: count }),
    { replace: count }
  );
}

test('overlapping flower awards reproduce two dragon quads plus four pairs', () => {
  const result = countSusongFlowerAwards({
    tileIds: [
      'red_dragon-1', 'red_dragon-2', 'red_dragon-3', 'red_dragon-4',
      'green_dragon-1', 'green_dragon-2', 'green_dragon-3', 'green_dragon-4'
    ]
  });
  assert.deepEqual({
    count: result.count,
    dragonQuadCount: result.dragonQuadCount,
    threeDragonTripletCount: result.threeDragonTripletCount,
    fourPairCount: result.fourPairCount
  }, { count: 3, dragonQuadCount: 2, threeDragonTripletCount: 0, fourPairCount: 1 });
});

test('three dragon triplets form one independent flower award', () => {
  const result = countSusongFlowerAwards({ tileIds: [
    'red_dragon-1', 'red_dragon-2', 'red_dragon-3',
    'green_dragon-1', 'green_dragon-2', 'green_dragon-3',
    'white_dragon-1', 'white_dragon-2', 'white_dragon-3'
  ] });
  assert.equal(result.count, 1);
  assert.equal(result.threeDragonTripletCount, 1);
});

test('only replaced flowers count; strong-piao discarded flowers do not', () => {
  const counts = deriveSusongFlowerAwardCounts({
    playerIds: players,
    replacementHistory: [
      { action: 'replace', playerId: 'A', removedTileIds: ['red_dragon-1', 'red_dragon-2', 'red_dragon-3', 'red_dragon-4'] },
      { action: 'discard', playerId: 'B', removedTileIds: ['green_dragon-1', 'green_dragon-2', 'green_dragon-3', 'green_dragon-4'] }
    ]
  });
  assert.deepEqual(counts, { A: 1, B: 0, C: 0, D: 0 });
});

test('flower award adds three independent payments and Sanxi excludes it', () => {
  const settlement = scoreSusongRound({
    config,
    playerIds: players,
    outcome: 'self_draw',
    winnerId: 'A',
    flowerState: flowers(),
    zengByPlayer,
    sanxiPairs: [['A', 'B']],
    flowerAwardCountByPlayer: { A: 3, B: 0, C: 0, D: 0 }
  });
  assert.deepEqual(
    settlement.transfers.map(transfer => [transfer.kind, transfer.from, transfer.to, transfer.amount]),
    [
      ['win', 'B', 'A', 10], ['win', 'C', 'A', 5], ['win', 'D', 'A', 5],
      ['flower_award', 'B', 'A', 18], ['flower_award', 'C', 'A', 18], ['flower_award', 'D', 'A', 18]
    ]
  );
  assert.deepEqual(settlement.deltaByPlayer, { A: 74, B: -28, C: -23, D: -23 });
  assert.equal(validateSusongSettlementAudit({ config, playerIds: players, zengByPlayer, settlement }), true);
  const forged = structuredClone(settlement);
  forged.transfers.find(transfer => transfer.kind === 'flower_award').amount += 1;
  assert.throws(
    () => validateSusongSettlementAudit({ config, playerIds: players, zengByPlayer, settlement: forged }),
    /flower award is invalid/
  );
});

test('a discarder loses their own award while a third-party award still settles', () => {
  const settlement = scoreSusongRound({
    config,
    playerIds: players,
    outcome: 'discard',
    discarderId: 'B',
    winnerId: 'A',
    flowerState: flowers(),
    zengByPlayer,
    flowerAwardCountByPlayer: { A: 0, B: 2, C: 1, D: 0 }
  });
  assert.deepEqual(settlement.flowerAwardCountByPlayer, { A: 0, B: 0, C: 1, D: 0 });
  assert.deepEqual(
    settlement.transfers.map(transfer => [transfer.kind, transfer.from, transfer.to, transfer.amount]),
    [
      ['win', 'B', 'A', 5],
      ['flower_award', 'A', 'C', 6], ['flower_award', 'B', 'C', 6], ['flower_award', 'D', 'C', 6]
    ]
  );
  assert.equal(validateSusongSettlementAudit({ config, playerIds: players, zengByPlayer, settlement }), true);
});

test('when the room enables zeng, a player with zero zeng receives no flower award', () => {
  const settlement = scoreSusongRound({
    config: { ...config, zeng: 2 },
    playerIds: players,
    outcome: 'self_draw',
    winnerId: 'A',
    flowerState: flowers(),
    zengByPlayer: { A: 0, B: 1, C: 0, D: 0 },
    flowerAwardCountByPlayer: { A: 3, B: 0, C: 0, D: 0 }
  });
  assert.equal(settlement.flowerAwardCountByPlayer.A, 0);
  assert.equal(settlement.transfers.some(transfer => transfer.kind === 'flower_award'), false);
});
