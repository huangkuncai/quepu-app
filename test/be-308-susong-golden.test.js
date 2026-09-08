import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createSusongFlowerState, resolveSusongFlowers } from '../src/domain/rules/susong.js';
import {
  scoreSusongRound,
  validateSusongSettlementAudit
} from '../src/domain/rules/susong-scoring.js';

const playerIds = ['A', 'B', 'C', 'D'];
const config = {
  rounds: 8,
  scoreTiers: [5, 6, 7, 8],
  zeng: 2,
  piao: 'optional',
  forcedHu: true
};
const cases = JSON.parse(readFileSync(
  new URL('./fixtures/rules/susong-scoring-golden.json', import.meta.url),
  'utf8'
));

function flowerState(count) {
  if (count === 0) {
    return createSusongFlowerState({ piaoMode: 'optional', initialFlowerCount: 0 });
  }
  return resolveSusongFlowers(
    createSusongFlowerState({ piaoMode: 'optional', initialFlowerCount: count }),
    { replace: count }
  );
}

test('BE-308 confirmed scoring fixture contains at least twenty named golden cases', () => {
  assert.ok(cases.length >= 20);
  assert.equal(new Set(cases.map(item => item.id)).size, cases.length);
});

for (const fixture of cases) {
  test(`BE-308 golden: ${fixture.id}`, () => {
    const zengByPlayer = fixture.zeng ?? { A: 0, B: 0, C: 0, D: 0 };
    const settlement = scoreSusongRound({
      config,
      playerIds,
      outcome: fixture.outcome,
      discarderId: fixture.discarderId,
      discarderNoFlower: fixture.discarderNoFlower ?? false,
      winners: fixture.winners.map(([winnerId, flowers]) => ({
        winnerId,
        flowerState: flowerState(flowers)
      })),
      zengByPlayer,
      sanxiPairs: fixture.sanxiPairs ?? []
    });

    assert.deepEqual(settlement.wins.map(win => win.tier), fixture.expectedTier);
    assert.deepEqual(
      settlement.transfers.map(transfer => [transfer.from, transfer.to, transfer.amount]),
      fixture.expectedTransfers
    );
    assert.deepEqual(settlement.deltaByPlayer, fixture.expectedDelta);
    assert.deepEqual(settlement.releasedSanxiPairs, fixture.expectedReleased ?? []);
    assert.equal(validateSusongSettlementAudit({
      config,
      playerIds,
      zengByPlayer,
      settlement
    }), true);
  });
}
