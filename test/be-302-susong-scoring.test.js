import assert from 'node:assert/strict';
import test from 'node:test';

import { createSusongFlowerState, resolveSusongFlowers } from '../src/domain/rules/susong.js';
import {
  deriveSusongSanxiPairs,
  scoreSusongRound,
  scoreSusongWin,
  SUSONG_SCORE_ORDER_VERSION,
  validateSusongSettlementAudit
} from '../src/domain/rules/susong-scoring.js';
import { Room } from '../src/domain/room.js';
import { RoomService } from '../src/modules/room/service.js';

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
    { stage: 'winner_zeng', count: 2, unit: 2, value: 4 },
    { stage: 'payer_zeng', count: 3, unit: 2, value: 6 },
    {
      stage: 'piao',
      status: 'not_piao',
      cappedByNoFlowerSelfDraw: false,
      cappedByNoFlowerDiscarder: false,
      value: 0
    },
    { stage: 'flower_tier', tier: 'small', value: 5, subtotal: 15 },
    { stage: 'sanxi', multiplier: 1, regularShare: 1, sanxiShare: 0, value: 15 }
  ]);
  assert.equal(settlement.scoreOrderVersion, SUSONG_SCORE_ORDER_VERSION);
  assert.equal(settlement.transfers[0].scoreOrderVersion, SUSONG_SCORE_ORDER_VERSION);
});

test('signed flower boundaries stay 1-4 small, 5-9 big and 10+ double-big', () => {
  const cases = [
    [1, 'small', 5],
    [4, 'small', 5],
    [5, 'big', 6],
    [9, 'big', 6],
    [10, 'double_big', 7],
    [18, 'double_big', 7]
  ];
  for (const [flowers, tier, amount] of cases) {
    const settlement = scoreSusongWin({
      config,
      playerIds: players,
      winnerId: 'A',
      winSource: 'self_draw',
      flowerState: flowerState(flowers),
      zengByPlayer: { A: 0, B: 0, C: 0, D: 0 }
    });
    assert.equal(settlement.settledTier, tier, `${flowers} flowers`);
    assert.deepEqual(
      settlement.transfers.map(item => item.amount),
      [amount, amount, amount],
      `${flowers} flowers`
    );
    assert.equal(settlement.selfDrawPromoted, false);
  }
});

test('audit trace follows zeng then piao then flower tier then sanxi', () => {
  const settlement = scoreSusongWin({
    config,
    playerIds: players,
    winnerId: 'A',
    winSource: 'self_draw',
    flowerState: flowerState(4),
    zengByPlayer: { A: 2, B: 3, C: 1, D: 5 },
    sanxiPairs: [['A', 'B']]
  });
  assert.deepEqual(
    settlement.transfers[0].trace.map(item => item.stage),
    ['winner_zeng', 'payer_zeng', 'piao', 'flower_tier', 'sanxi']
  );
  assert.equal(settlement.transfers[0].trace.at(-1).value, 30);
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

test('sanxi forms only after one direction claims three chi or peng melds', () => {
  const meldsByPlayer = {
    A: [
      { action: 'chi', fromPlayerId: 'B' },
      { action: 'peng', fromPlayerId: 'B' }
    ],
    B: [
      { action: 'peng', fromPlayerId: 'A' },
      { action: 'exposed_kong', fromPlayerId: 'A' }
    ],
    C: [],
    D: []
  };
  assert.deepEqual(deriveSusongSanxiPairs({ playerIds: players, meldsByPlayer }), []);
  meldsByPlayer.A.push({ action: 'added_kong', fromPlayerId: 'B' });
  assert.deepEqual(deriveSusongSanxiPairs({ playerIds: players, meldsByPlayer }), [['A', 'B']]);
});

test('third-party discard makes the discarder and Sanxi counterpart each pay one share', () => {
  const settlement = scoreSusongRound({
    config,
    playerIds: players,
    outcome: 'discard',
    discarderId: 'C',
    winnerId: 'A',
    flowerState: flowerState(4),
    zengByPlayer: { A: 2, B: 3, C: 1, D: 5 },
    sanxiPairs: [['A', 'B']]
  });
  assert.deepEqual(
    settlement.transfers.map(item => [
      item.from,
      item.to,
      item.amount,
      item.trace.at(-1).regularShare,
      item.trace.at(-1).sanxiShare
    ]),
    [
      ['B', 'A', 15, 0, 1],
      ['C', 'A', 11, 1, 0]
    ]
  );
  assert.deepEqual(settlement.deltaByPlayer, { A: 26, B: -15, C: -11, D: 0 });
});

test('related discarder pays both the normal and Sanxi shares', () => {
  const settlement = scoreSusongRound({
    config,
    playerIds: players,
    outcome: 'discard',
    discarderId: 'B',
    winnerId: 'A',
    flowerState: flowerState(4),
    zengByPlayer: { A: 2, B: 3, C: 1, D: 5 },
    sanxiPairs: [['A', 'B']]
  });
  assert.deepEqual(settlement.transfers.map(item => [item.from, item.to, item.amount]), [['B', 'A', 30]]);
  assert.deepEqual(settlement.transfers[0].trace.at(-1), {
    stage: 'sanxi', multiplier: 2, regularShare: 1, sanxiShare: 1, value: 30
  });
});

test('one discard with related co-winners releases their Sanxi relation', () => {
  const settlement = scoreSusongRound({
    config,
    playerIds: players,
    outcome: 'discard',
    discarderId: 'C',
    winners: [
      { playerId: 'A', flowerState: flowerState(4) },
      { playerId: 'B', flowerState: flowerState(5) }
    ],
    zengByPlayer: { A: 2, B: 3, C: 1, D: 5 },
    sanxiPairs: [['A', 'B']]
  });
  assert.deepEqual(settlement.sanxiPairs, []);
  assert.deepEqual(settlement.releasedSanxiPairs, [['A', 'B']]);
  assert.deepEqual(
    settlement.transfers.map(item => [item.from, item.to, item.amount]),
    [['C', 'A', 11], ['C', 'B', 14]]
  );
  assert.deepEqual(settlement.deltaByPlayer, { A: 11, B: 14, C: -25, D: 0 });
  assert.equal(validateSusongSettlementAudit({
    config,
    playerIds: players,
    zengByPlayer: { A: 2, B: 3, C: 1, D: 5 },
    settlement
  }), true);

  const forged = structuredClone(settlement);
  forged.sanxiPairs = [['A', 'B']];
  forged.releasedSanxiPairs = [];
  assert.throws(
    () => validateSusongSettlementAudit({
      config,
      playerIds: players,
      zengByPlayer: { A: 2, B: 3, C: 1, D: 5 },
      settlement: forged
    }),
    /must be released/
  );
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
  assert.equal(settlement.cappedByNoFlowerSelfDraw, true);
  assert.equal(settlement.piao, false);
  assert.deepEqual(settlement.deltaByPlayer, { A: 24, B: -8, C: -8, D: -8 });
});

test('a no-flower discarder promotes every legal winner to one-bamboo', () => {
  const input = {
    config,
    playerIds: players,
    outcome: 'discard',
    discarderId: 'D',
    discarderNoFlower: true,
    winners: [
      { winnerId: 'A', flowerState: flowerState(1) },
      { winnerId: 'B', flowerState: flowerState(5) }
    ],
    zengByPlayer: { A: 2, B: 3, C: 1, D: 5 }
  };
  const settlement = scoreSusongRound(input);

  assert.equal(settlement.discarderNoFlower, true);
  assert.deepEqual(settlement.wins.map(win => win.tier), ['one_bamboo', 'one_bamboo']);
  assert.deepEqual(
    settlement.wins.map(win => win.cappedByNoFlowerDiscarder),
    [true, true]
  );
  assert.deepEqual(settlement.transfers.map(transfer => transfer.amount), [22, 24]);
  assert.deepEqual(settlement.deltaByPlayer, { A: 22, B: 24, C: 0, D: -46 });
  assert.equal(validateSusongSettlementAudit({
    config,
    playerIds: players,
    zengByPlayer: input.zengByPlayer,
    expectedDiscarderNoFlower: true,
    settlement
  }), true);
  assert.throws(
    () => validateSusongSettlementAudit({
      config,
      playerIds: players,
      zengByPlayer: input.zengByPlayer,
      expectedDiscarderNoFlower: false,
      settlement
    }),
    /no-flower discarder state/
  );
  assert.throws(
    () => scoreSusongWin({
      config,
      playerIds: players,
      winnerId: 'A',
      winSource: 'discard',
      discarderId: 'D',
      discarderNoFlower: true,
      flowerState: flowerState(0),
      zengByPlayer: { A: 0, B: 0, C: 0, D: 0 }
    }),
    /NO_FLOWER_SELF_DRAW_ONLY/
  );
});

test('discard win charges only the discarder', () => {
  const settlement = scoreSusongRound({
    config,
    playerIds: players,
    outcome: 'discard',
    discarderId: 'D',
    winnerId: 'A',
    flowerState: flowerState(4),
    zengByPlayer: { A: 2, B: 3, C: 1, D: 5 }
  });
  assert.deepEqual(settlement.winnerIds, ['A']);
  assert.equal(settlement.scoreOrderVersion, SUSONG_SCORE_ORDER_VERSION);
  assert.deepEqual(settlement.transfers.map(item => [item.from, item.to, item.amount]), [['D', 'A', 19]]);
  assert.deepEqual(settlement.deltaByPlayer, { A: 19, B: 0, C: 0, D: -19 });
});

test('one discard can pay two or three independently classified winners', () => {
  const settlement = scoreSusongRound({
    config,
    playerIds: players,
    outcome: 'discard',
    discarderId: 'D',
    winners: [
      { playerId: 'A', flowerState: flowerState(4) },
      { playerId: 'B', flowerState: flowerState(5) },
      { playerId: 'C', flowerState: flowerState(10) }
    ],
    zengByPlayer: { A: 2, B: 3, C: 1, D: 5 }
  });
  assert.deepEqual(settlement.winnerIds, ['A', 'B', 'C']);
  assert.deepEqual(settlement.wins.map(win => win.tier), ['small', 'big', 'double_big']);
  assert.ok(settlement.wins.every(win => Array.isArray(win.patterns)));
  assert.deepEqual(settlement.transfers.map(item => item.amount), [19, 22, 19]);
  assert.deepEqual(settlement.deltaByPlayer, { A: 19, B: 22, C: 19, D: -60 });
});

test('draw at the wall boundary is an auditable zero settlement', () => {
  const settlement = scoreSusongRound({ config, playerIds: players, outcome: 'draw' });
  assert.deepEqual(settlement.winnerIds, []);
  assert.equal(settlement.scoreOrderVersion, SUSONG_SCORE_ORDER_VERSION);
  assert.deepEqual(settlement.transfers, []);
  assert.deepEqual(settlement.deltaByPlayer, { A: 0, B: 0, C: 0, D: 0 });
});

test('persisted score audit rejects reordered or arithmetically forged traces', () => {
  const settlement = scoreSusongRound({
    config,
    playerIds: players,
    outcome: 'self_draw',
    winnerId: 'A',
    flowerState: flowerState(4),
    zengByPlayer: { A: 2, B: 3, C: 1, D: 5 }
  });
  const input = {
    config,
    playerIds: players,
    zengByPlayer: { A: 2, B: 3, C: 1, D: 5 }
  };
  assert.equal(validateSusongSettlementAudit({ ...input, settlement }), true);

  const reordered = structuredClone(settlement);
  [reordered.transfers[0].trace[0], reordered.transfers[0].trace[1]] =
    [reordered.transfers[0].trace[1], reordered.transfers[0].trace[0]];
  assert.throws(
    () => validateSusongSettlementAudit({ ...input, settlement: reordered }),
    /trace order/
  );

  const forged = structuredClone(settlement);
  forged.transfers[0].trace[3].subtotal += 100;
  assert.throws(
    () => validateSusongSettlementAudit({ ...input, settlement: forged }),
    /trace arithmetic/
  );

  const priorSummaryShape = structuredClone(settlement);
  delete priorSummaryShape.discarderNoFlower;
  for (const win of priorSummaryShape.wins) {
    delete win.piao;
    delete win.cappedByNoFlowerSelfDraw;
    delete win.cappedByNoFlowerDiscarder;
    delete win.patterns;
    delete win.gangWinCount;
  }
  assert.equal(
    validateSusongSettlementAudit({ ...input, settlement: priorSummaryShape }),
    true
  );
});

test('internal RoomService settlement scores and persists through SYSTEM authority', async () => {
  let sequence = 0;
  const room = new Room({
    id: 'score-room',
    ownerId: 'A',
    idFactory: () => `score-generated-${++sequence}`,
    ruleSnapshot: {
      gameType: 'mahjong',
      ruleId: 'susong_v1',
      ruleVersion: '8931-apk-baseline.3',
      config
    }
  });
  for (const playerId of players) room.join({ id: playerId });
  for (const [playerId, count] of Object.entries({ A: 2, B: 3, C: 1, D: 5 })) {
    for (let index = 0; index < count; index += 1) {
      room.increaseZeng(playerId, { actorId: playerId, commandId: `${playerId}-zeng-${index}` });
    }
  }
  for (const playerId of players) room.setReady(playerId);
  room.start({ actorId: 'A' });
  const actor = { room, version: room.version };
  const registry = {
    get: id => id === room.id ? actor : null,
    recover: async () => null,
    dispatch: async (id, command, context) => {
      assert.equal(id, room.id);
      const result = room.execute(command, context);
      actor.version = room.version;
      return result;
    }
  };
  const service = new RoomService({ registry });
  await service.initializeSusongRoundFlowers({
    roomId: room.id,
    roomVersion: room.version,
    commandId: 'system-opening-flowers',
    openingFlowerCountByPlayer: { A: 4, B: 0, C: 0, D: 0 }
  });
  for (let index = 0; index < 4; index += 1) {
    room.resolveSusongFlower('A', 'replace', { actorId: 'A', commandId: `A-replace-${index}` });
  }
  room.beginPlaying({ actorId: 'A' });
  room.currentRound.meldsByPlayer.A = [
    { action: 'chi', fromPlayerId: 'B' },
    { action: 'peng', fromPlayerId: 'B' },
    { action: 'peng', fromPlayerId: 'B' }
  ];
  const result = await service.settleSusongRound({
    roomId: room.id,
    roomVersion: room.version,
    commandId: 'system-score-example',
    requestId: 'system-score-request',
    facts: {
      outcome: 'self_draw',
      winnerId: 'A',
      // Both client-like scoring claims are ignored in favor of Room state.
      flowerState: flowerState(10),
      // This forged input is ignored; settlement reads the Room map above.
      zengByPlayer: { A: 999, B: 999, C: 999, D: 999 },
      flowerAwardCountByPlayer: { A: 999, B: 999, C: 999, D: 999 }
    }
  });
  assert.equal(result.snapshot.round.settlement.scoreAuthority, 'server');
  assert.deepEqual(result.snapshot.round.sanxiPairs, [['A', 'B']]);
  assert.deepEqual(result.snapshot.round.settlement.flowerAwardCountByPlayer, { A: 0, B: 0, C: 0, D: 0 });
  assert.deepEqual(result.snapshot.scores, { A: 60, B: -30, C: -11, D: -19 });
});

test('strong-piao round actions persist opening choice, flower discard and draw state', () => {
  let sequence = 0;
  const room = new Room({
    id: 'piao-room',
    ownerId: 'A',
    idFactory: () => `piao-generated-${++sequence}`,
    ruleSnapshot: {
      gameType: 'mahjong',
      ruleId: 'susong_v1',
      ruleVersion: '8931-apk-baseline.3',
      config: { ...config, piao: 'strong' }
    }
  });
  for (const playerId of players) room.join({ id: playerId });
  for (const playerId of players) room.setReady(playerId);
  room.start({ actorId: 'A' });
  const beforeFlowers = room.snapshot();
  const initialized = room.initializeSusongFlowers(
    { A: 0, B: 2, C: 1, D: 0 },
    { actorId: 'system', actorRole: 'SYSTEM', commandId: 'init-piao' }
  );
  assert.equal(initialized.flowerStates.A.status, 'piao');
  assert.equal(initialized.flowerStates.B.status, 'awaiting_piao_choice');

  room.chooseSusongPiao('B', true, { actorId: 'B', commandId: 'B-piao' });
  room.chooseSusongPiao('C', false, { actorId: 'C', commandId: 'C-no-piao' });
  assert.throws(
    () => room.resolveSusongFlower('C', 'discard', { actorId: 'C' }),
    error => error.code === 'INVALID_ACTION'
  );
  room.resolveSusongFlower('C', 'replace', { actorId: 'C', commandId: 'C-replace' });
  room.beginPlaying({ actorId: 'A' });
  room.recordSusongFlowerDraw('A', 1, {
    actorId: 'system',
    actorRole: 'SYSTEM',
    commandId: 'A-draw-flower'
  });
  assert.equal(room.snapshot().round.flowerStates.A.pendingFlowerDiscards, 0);
  assert.equal(room.snapshot().round.flowerStates.A.drawnFlowers, 1);
  assert.equal(room.snapshot().round.flowerStates.A.countedFlowers, 0);

  const recovered = Room.fromSnapshot(beforeFlowers);
  for (const event of room.events.filter(event => event.version > beforeFlowers.roomVersion)) {
    recovered.applyPersistedEvent(event);
  }
  assert.deepEqual(recovered.snapshot().round.flowerStates, room.snapshot().round.flowerStates);
});
