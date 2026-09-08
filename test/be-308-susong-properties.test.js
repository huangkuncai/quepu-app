import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSusongFlowerState,
  resolveSusongFlowers
} from '../src/domain/rules/susong.js';
import {
  scoreSusongRound,
  SUSONG_SCORE_ORDER_VERSION,
  validateSusongSettlementAudit
} from '../src/domain/rules/susong-scoring.js';

const players = ['A', 'B', 'C', 'D'];
const config = {
  rounds: 8,
  scoreTiers: [5, 6, 7, 8],
  zeng: 2,
  piao: 'optional',
  forcedHu: true
};

test('BE-308 replays 10,000 signed scoring inputs with zero divergence', () => {
  const random = xorshift32(0x8931_2026);
  for (let iteration = 0; iteration < 10_000; iteration += 1) {
    const zengByPlayer = Object.fromEntries(
      players.map(playerId => [playerId, randomInt(random, 9)])
    );
    const outcome = randomInt(random, 2) === 0 ? 'self_draw' : 'discard';
    const discarderId = outcome === 'discard'
      ? players[randomInt(random, players.length)]
      : null;
    const eligibleWinners = players.filter(playerId => playerId !== discarderId);
    const winnerCount = outcome === 'self_draw' ? 1 : randomInt(random, 3) + 1;
    shuffleInPlace(eligibleWinners, random);
    const winners = eligibleWinners.slice(0, winnerCount).map(winnerId => ({
      winnerId,
      flowerState: flowerState(randomInt(random, 18) + 1)
    }));
    const sanxiPairs = [];
    for (const winner of winners) {
      const payers = outcome === 'self_draw'
        ? players.filter(playerId => playerId !== winner.winnerId)
        : [discarderId];
      for (const payerId of payers) {
        if (randomInt(random, 4) === 0) sanxiPairs.push([winner.winnerId, payerId]);
      }
    }
    const input = {
      config,
      playerIds: players,
      outcome,
      discarderId,
      winners,
      zengByPlayer,
      sanxiPairs
    };
    const first = scoreSusongRound(input);
    const replay = scoreSusongRound(structuredClone(input));

    assert.deepEqual(replay, first, `divergence at iteration ${iteration}`);
    assert.equal(first.scoreOrderVersion, SUSONG_SCORE_ORDER_VERSION);
    assert.equal(
      Object.values(first.deltaByPlayer).reduce((sum, value) => sum + value, 0),
      0
    );
    assert.equal(validateSusongSettlementAudit({
      config,
      playerIds: players,
      zengByPlayer,
      settlement: first
    }), true);
  }
});

test('BE-308 no-flower self-draw cap remains deterministic and auditable', () => {
  const piao = createSusongFlowerState({
    piaoMode: 'strong',
    initialFlowerCount: 0
  });
  const input = {
    config: { ...config, piao: 'strong' },
    playerIds: players,
    outcome: 'self_draw',
    winnerId: 'A',
    flowerState: piao,
    zengByPlayer: { A: 0, B: 0, C: 0, D: 0 }
  };
  const settlement = scoreSusongRound(input);
  assert.equal(settlement.wins[0].tier, 'one_bamboo');
  assert.deepEqual(settlement.transfers.map(transfer => transfer.amount), [8, 8, 8]);
  assert.equal(validateSusongSettlementAudit({
    config: input.config,
    playerIds: players,
    zengByPlayer: input.zengByPlayer,
    settlement
  }), true);
});

function flowerState(count) {
  return resolveSusongFlowers(
    createSusongFlowerState({ piaoMode: 'optional', initialFlowerCount: count }),
    { replace: count }
  );
}

function randomInt(random, maxExclusive) {
  return Math.floor(random() * maxExclusive);
}

function shuffleInPlace(values, random) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(random, index + 1);
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
}

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}
