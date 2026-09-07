import assert from 'node:assert/strict';
import test from 'node:test';

import { createSusongFlowerState, resolveSusongFlowers } from '../src/domain/rules/susong.js';
import { scoreSusongWin } from '../src/domain/rules/susong-scoring.js';

const players = ['A', 'B', 'C', 'D'];
const config = {
  rounds: 8,
  scoreTiers: [5, 6, 7, 8],
  zeng: 2,
  piao: 'optional',
  forcedHu: true
};

function flowerState(count) {
  return resolveSusongFlowers(
    createSusongFlowerState({ piaoMode: 'optional', initialFlowerCount: count }),
    { replace: count }
  );
}

test('A self-draw with four flowers stays small and settles each zeng relation', () => {
  const settlement = scoreSusongWin({
    config,
    playerIds: players,
    winnerId: 'A',
    winSource: 'self_draw',
    flowerState: flowerState(4),
    zengByPlayer: { A: 2, B: 3, C: 1, D: 5 }
  });

  assert.equal(settlement.classifiedTier, 'small');
  assert.equal(settlement.settledTier, 'small');
  assert.equal(settlement.selfDrawPromoted, false);
  assert.deepEqual(settlement.transfers.map(item => item.amount), [15, 11, 19]);
  assert.deepEqual(settlement.deltaByPlayer, { A: 45, B: -15, C: -11, D: -19 });
  assert.equal(Object.values(settlement.deltaByPlayer).reduce((sum, value) => sum + value, 0), 0);
  assert.deepEqual(settlement.transfers[0].trace, [
    { stage: 'flower_tier', value: 5 },
    { stage: 'winner_zeng', count: 2, unit: 2, value: 4 },
    { stage: 'payer_zeng', count: 3, unit: 2, value: 6 },
    { stage: 'sanxi', multiplier: 1, value: 15 }
  ]);
});

test('the original 6-point base example is correct when A has five flowers', () => {
  const settlement = scoreSusongWin({
    config,
    playerIds: players,
    winnerId: 'A',
    winSource: 'self_draw',
    flowerState: flowerState(5),
    zengByPlayer: { A: 2, B: 3, C: 1, D: 5 }
  });
  assert.equal(settlement.settledTier, 'big');
  assert.deepEqual(settlement.transfers.map(item => item.amount), [16, 12, 20]);
  assert.deepEqual(settlement.deltaByPlayer, { A: 48, B: -16, C: -12, D: -20 });
});

test('sanxi doubles only the matching pair after flower tier and both zeng terms', () => {
  const settlement = scoreSusongWin({
    config,
    playerIds: players,
    winnerId: 'A',
    winSource: 'self_draw',
    flowerState: flowerState(4),
    zengByPlayer: { A: 2, B: 3, C: 1, D: 5 },
    sanxiPairs: [['A', 'B']]
  });
  assert.deepEqual(settlement.transfers.map(item => item.amount), [30, 11, 19]);
  assert.deepEqual(settlement.deltaByPlayer, { A: 60, B: -30, C: -11, D: -19 });
});

test('no-flower discard win is rejected instead of accepting client scoring claims', () => {
  const flowerState = createSusongFlowerState({ piaoMode: 'optional', initialFlowerCount: 0 });
  assert.throws(() => scoreSusongWin({
    config,
    playerIds: players,
    winnerId: 'A',
    discarderId: 'B',
    winSource: 'discard',
    flowerState,
    zengByPlayer: { A: 2, B: 3, C: 1, D: 5 }
  }), /NO_FLOWER_SELF_DRAW_ONLY/);
});

test('no-flower self-draw remains at the cap tier', () => {
  const settlement = scoreSusongWin({
    config,
    playerIds: players,
    winnerId: 'A',
    winSource: 'self_draw',
    flowerState: createSusongFlowerState({ piaoMode: 'optional', initialFlowerCount: 0 }),
    zengByPlayer: { A: 0, B: 0, C: 0, D: 0 }
  });
  assert.equal(settlement.settledTier, 'one_bamboo');
  assert.deepEqual(settlement.deltaByPlayer, { A: 24, B: -8, C: -8, D: -8 });
});
