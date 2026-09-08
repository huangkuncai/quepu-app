import {
  evaluateSusongWin,
  normalizeSusongConfig,
  SUSONG_SCORE_ORDER_VERSION
} from './susong.js';
import { susongTileFace } from './susong-wall.js';

const TIER_INDEX = Object.freeze({
  small: 0,
  big: 1,
  double_big: 2,
  one_bamboo: 3
});

export { SUSONG_SCORE_ORDER_VERSION } from './susong.js';

const FLOWER_AWARD_FACES = Object.freeze([
  'red_dragon', 'green_dragon', 'white_dragon', 'red_flower', 'black_flower'
]);

/** Count overlapping flower-award patterns from server-owned physical tiles. */
export function countSusongFlowerAwards({ tileIds = [] } = {}) {
  if (!Array.isArray(tileIds)) throw new TypeError('tileIds must be an array');
  const counts = Object.fromEntries(FLOWER_AWARD_FACES.map(face => [face, 0]));
  for (const tileId of tileIds) {
    const face = susongTileFace(tileId);
    if (Object.hasOwn(counts, face)) counts[face] += 1;
  }
  const dragonQuadCount = ['red_dragon', 'green_dragon', 'white_dragon']
    .reduce((sum, face) => sum + Math.floor(counts[face] / 4), 0);
  const threeDragonTripletCount = Math.min(
    ...['red_dragon', 'green_dragon', 'white_dragon']
      .map(face => Math.floor(counts[face] / 3))
  );
  const pairUnits = FLOWER_AWARD_FACES
    .reduce((sum, face) => sum + Math.floor(counts[face] / 2), 0);
  const fourPairCount = Math.floor(pairUnits / 4);
  return deepFreeze({
    count: dragonQuadCount + threeDragonTripletCount + fourPairCount,
    dragonQuadCount,
    threeDragonTripletCount,
    fourPairCount,
    pairUnits,
    faceCounts: counts
  });
}

/** Derive per-player awards only from laid-out replacement flowers. */
export function deriveSusongFlowerAwardCounts({ playerIds, replacementHistory = [] } = {}) {
  const players = normalizePlayers(playerIds);
  if (!Array.isArray(replacementHistory)) throw new TypeError('replacementHistory must be an array');
  const tileIdsByPlayer = Object.fromEntries(players.map(playerId => [playerId, []]));
  for (const operation of replacementHistory) {
    if (operation?.action !== 'replace') continue;
    const playerId = member(operation.playerId, players, 'replacementHistory.playerId');
    if (!Array.isArray(operation.removedTileIds)) {
      throw new TypeError('replacementHistory.removedTileIds must be an array');
    }
    tileIdsByPlayer[playerId].push(...operation.removedTileIds);
  }
  return deepFreeze(Object.fromEntries(players.map(playerId => [
    playerId,
    countSusongFlowerAwards({ tileIds: tileIdsByPlayer[playerId] }).count
  ])));
}

/**
 * Derive symmetric Sanxi relations from authoritative public meld history.
 * A relation is formed when either player has claimed at least three chi/peng
 * melds from the same opponent. An added kong still counts as its original
 * peng; an exposed/concealed kong does not create a Sanxi claim.
 */
export function deriveSusongSanxiPairs({ meldsByPlayer, playerIds } = {}) {
  const players = normalizePlayers(playerIds);
  if (!meldsByPlayer || typeof meldsByPlayer !== 'object' || Array.isArray(meldsByPlayer)) {
    throw new TypeError('meldsByPlayer must be an object');
  }
  const directedCounts = new Map();
  for (const claimantId of players) {
    const melds = meldsByPlayer[claimantId] ?? [];
    if (!Array.isArray(melds)) throw new TypeError(`meldsByPlayer.${claimantId} must be an array`);
    for (const meld of melds) {
      if (!meld || typeof meld !== 'object' || Array.isArray(meld)) {
        throw new TypeError(`meldsByPlayer.${claimantId} contains an invalid meld`);
      }
      if (!['chi', 'peng', 'added_kong'].includes(meld.action)) continue;
      const providerId = member(meld.fromPlayerId, players, 'meld.fromPlayerId');
      if (providerId === claimantId) throw new TypeError('a Sanxi claim requires another player');
      const key = `${claimantId}\u0000${providerId}`;
      directedCounts.set(key, (directedCounts.get(key) ?? 0) + 1);
    }
  }
  const pairKeys = new Set();
  for (const [key, count] of directedCounts) {
    if (count < 3) continue;
    const [claimantId, providerId] = key.split('\u0000');
    pairKeys.add(pairKey(claimantId, providerId));
  }
  return deepFreeze([...pairKeys]
    .sort()
    .map(key => key.split('\u0000')));
}

/**
 * Produce an immutable, zero-sum settlement from server-owned round facts.
 *
 * Pair score confirmed by the 2026-09-07 A/B/C/D example:
 *   flower-tier score
 *   + winner zeng count * room zeng unit
 *   + payer zeng count * room zeng unit
 * The pair result is then doubled when that winner/payer relation is Sanxi.
 */
export function scoreSusongWin({
  config: configInput,
  playerIds,
  winnerId,
  winSource,
  discarderId = null,
  flowerState,
  zengByPlayer,
  patterns = [],
  gangWinCount = 0,
  sanxiPairs = []
} = {}) {
  const config = normalizeSusongConfig(configInput);
  const players = normalizePlayers(playerIds);
  const winner = member(winnerId, players, 'winnerId');
  const zeng = normalizeZeng(zengByPlayer, players);
  const normalizedPatterns = [...new Set(patterns)].sort();
  const decision = evaluateSusongWin({
    flowerState,
    winSource,
    patterns: normalizedPatterns,
    gangWinCount
  });
  if (!decision.allowed) {
    throw new TypeError(`win is not allowed: ${decision.reason}`);
  }

  const regularPayers = winSource === 'self_draw'
    ? players.filter(playerId => playerId !== winner)
    : [member(discarderId, players, 'discarderId')];
  if (regularPayers.includes(winner)) throw new TypeError('winnerId cannot also be a payer');

  const tier = decision.tier;
  const baseScore = config.scoreTiers[TIER_INDEX[tier]];
  const relations = normalizeSanxiPairs(sanxiPairs, players);
  const sanxiPayers = players.filter(playerId =>
    playerId !== winner && relations.has(pairKey(winner, playerId)));
  const payers = players.filter(playerId =>
    regularPayers.includes(playerId) || sanxiPayers.includes(playerId));
  const transfers = payers.map(payerId => {
    const winnerZengScore = zeng[winner] * config.zeng;
    const payerZengScore = zeng[payerId] * config.zeng;
    const beforeSanxi = baseScore + winnerZengScore + payerZengScore;
    const regularShare = regularPayers.includes(payerId) ? 1 : 0;
    const sanxiShare = relations.has(pairKey(winner, payerId)) ? 1 : 0;
    const sanxiMultiplier = regularShare + sanxiShare;
    return deepFreeze({
      kind: 'win',
      from: payerId,
      to: winner,
      amount: beforeSanxi * sanxiMultiplier,
      tier,
      scoreOrderVersion: SUSONG_SCORE_ORDER_VERSION,
      trace: [
        { stage: 'winner_zeng', count: zeng[winner], unit: config.zeng, value: winnerZengScore },
        { stage: 'payer_zeng', count: zeng[payerId], unit: config.zeng, value: payerZengScore },
        {
          stage: 'piao',
          status: decision.piao ? 'piao' : 'not_piao',
          cappedByNoFlowerSelfDraw: decision.cappedByNoFlowerSelfDraw,
          value: 0
        },
        { stage: 'flower_tier', tier, value: baseScore, subtotal: beforeSanxi },
        {
          stage: 'sanxi',
          multiplier: sanxiMultiplier,
          regularShare,
          sanxiShare,
          value: beforeSanxi * sanxiMultiplier
        }
      ]
    });
  });

  const deltaByPlayer = Object.fromEntries(players.map(playerId => [playerId, 0]));
  for (const transfer of transfers) {
    deltaByPlayer[transfer.from] -= transfer.amount;
    deltaByPlayer[transfer.to] += transfer.amount;
  }
  if (Object.values(deltaByPlayer).reduce((sum, value) => sum + value, 0) !== 0) {
    throw new Error('Susong settlement must be zero-sum');
  }

  return deepFreeze({
    scoreAuthority: 'server',
    winnerId: winner,
    winSource,
    flowerCount: decision.flowerCount,
    scoreOrderVersion: SUSONG_SCORE_ORDER_VERSION,
    classifiedTier: decision.tier,
    settledTier: tier,
    selfDrawPromoted: false,
    piao: decision.piao,
    cappedByNoFlowerSelfDraw: decision.cappedByNoFlowerSelfDraw === true,
    patterns: normalizedPatterns,
    gangWinCount,
    sanxiPairs: normalizedSanxiPairList(sanxiPairs, players),
    transfers,
    deltaByPlayer
  });
}

/** Score a complete draw, self-draw, discard win, or one-discard-multi-win round. */
export function scoreSusongRound(input = {}) {
  const players = normalizePlayers(input.playerIds);
  const config = normalizeSusongConfig(input.config);
  const outcome = input.outcome ?? input.winSource;
  if (outcome === 'draw') {
    const configuredSanxiPairs = normalizedSanxiPairList(input.sanxiPairs ?? [], players);
    return deepFreeze({
      scoreAuthority: 'server',
      scoreOrderVersion: SUSONG_SCORE_ORDER_VERSION,
      outcome: 'draw',
      winnerIds: [],
      discarderId: null,
      sanxiPairs: configuredSanxiPairs,
      releasedSanxiPairs: [],
      flowerAwardCountByPlayer: Object.fromEntries(players.map(playerId => [playerId, 0])),
      wins: [],
      transfers: [],
      deltaByPlayer: Object.fromEntries(players.map(playerId => [playerId, 0]))
    });
  }
  if (!['self_draw', 'discard'].includes(outcome)) {
    throw new TypeError('outcome must be draw, self_draw or discard');
  }

  const winnerInputs = normalizeWinnerInputs(input);
  if (outcome === 'self_draw' && winnerInputs.length !== 1) {
    throw new TypeError('self_draw must contain exactly one winner');
  }
  const winnerIds = winnerInputs.map(winner => member(winner.winnerId, players, 'winnerId'));
  if (new Set(winnerIds).size !== winnerIds.length) {
    throw new TypeError('winners must be unique');
  }
  const discarderId = outcome === 'discard'
    ? member(input.discarderId, players, 'discarderId')
    : null;
  if (discarderId && winnerIds.includes(discarderId)) {
    throw new TypeError('discarderId cannot be a winner');
  }

  const configuredSanxiPairs = normalizedSanxiPairList(input.sanxiPairs ?? [], players);
  const releasedSanxiPairs = outcome === 'discard' && winnerIds.length > 1
    ? configuredSanxiPairs.filter(pair => pair.every(playerId => winnerIds.includes(playerId)))
    : [];
  const releasedKeys = new Set(releasedSanxiPairs.map(pair => pairKey(pair[0], pair[1])));
  const appliedSanxiPairs = configuredSanxiPairs.filter(pair => !releasedKeys.has(pairKey(pair[0], pair[1])));

  const wins = winnerInputs.map(winner => scoreSusongWin({
    config,
    playerIds: players,
    winnerId: winner.winnerId,
    winSource: outcome,
    discarderId,
    flowerState: winner.flowerState,
    zengByPlayer: input.zengByPlayer,
    patterns: winner.patterns ?? [],
    gangWinCount: winner.gangWinCount ?? 0,
    sanxiPairs: appliedSanxiPairs
  }));
  const flowerAwardCountByPlayer = normalizeFlowerAwardCounts(
    input.flowerAwardCountByPlayer,
    players
  );
  if (config.zeng > 0) {
    const roundZeng = normalizeZeng(input.zengByPlayer, players);
    for (const playerId of players) {
      if (roundZeng[playerId] === 0) flowerAwardCountByPlayer[playerId] = 0;
    }
  }
  if (discarderId) flowerAwardCountByPlayer[discarderId] = 0;
  const flowerAwardUnit = config.scoreTiers[1];
  const flowerAwardTransfers = players.flatMap(holderId => {
    const count = flowerAwardCountByPlayer[holderId];
    if (count === 0) return [];
    return players.filter(playerId => playerId !== holderId).map(payerId => deepFreeze({
      kind: 'flower_award',
      from: payerId,
      to: holderId,
      amount: count * flowerAwardUnit,
      scoreOrderVersion: SUSONG_SCORE_ORDER_VERSION,
      trace: [{
        stage: 'flower_award',
        count,
        unit: flowerAwardUnit,
        value: count * flowerAwardUnit
      }]
    }));
  });
  const transfers = [...wins.flatMap(win => win.transfers), ...flowerAwardTransfers];
  const deltaByPlayer = Object.fromEntries(players.map(playerId => [playerId, 0]));
  for (const transfer of transfers) {
    deltaByPlayer[transfer.from] -= transfer.amount;
    deltaByPlayer[transfer.to] += transfer.amount;
  }
  if (Object.values(deltaByPlayer).reduce((sum, value) => sum + value, 0) !== 0) {
    throw new Error('Susong round settlement must be zero-sum');
  }
  return deepFreeze({
    scoreAuthority: 'server',
    scoreOrderVersion: SUSONG_SCORE_ORDER_VERSION,
    outcome,
    winnerIds,
    discarderId,
    sanxiPairs: appliedSanxiPairs,
    releasedSanxiPairs,
    flowerAwardCountByPlayer,
    wins: wins.map(win => ({
      winnerId: win.winnerId,
      flowerCount: win.flowerCount,
      tier: win.settledTier,
      piao: win.piao,
      cappedByNoFlowerSelfDraw: win.cappedByNoFlowerSelfDraw,
      patterns: [...win.patterns],
      gangWinCount: win.gangWinCount
    })),
    transfers,
    deltaByPlayer
  });
}

/** Verify a persisted settlement without trusting its precomputed total. */
export function validateSusongSettlementAudit({
  config: configInput,
  playerIds,
  zengByPlayer,
  settlement
} = {}) {
  const config = normalizeSusongConfig(configInput);
  const players = normalizePlayers(playerIds);
  const zeng = normalizeZeng(zengByPlayer, players);
  if (!settlement || typeof settlement !== 'object' || Array.isArray(settlement)
    || settlement.scoreAuthority !== 'server'
    || settlement.scoreOrderVersion !== SUSONG_SCORE_ORDER_VERSION) {
    throw new TypeError('settlement must use the supported server score order');
  }
  if (!['draw', 'self_draw', 'discard'].includes(settlement.outcome)
    || !Array.isArray(settlement.winnerIds) || !Array.isArray(settlement.wins)
    || !Array.isArray(settlement.transfers)) {
    throw new TypeError('settlement audit shape is invalid');
  }
  const winnerIds = settlement.winnerIds.map(id => member(id, players, 'winnerId'));
  if (new Set(winnerIds).size !== winnerIds.length
    || settlement.wins.length !== winnerIds.length) {
    throw new TypeError('settlement winners are inconsistent');
  }
  const tierByWinner = new Map();
  const piaoByWinner = new Map();
  for (const [index, win] of settlement.wins.entries()) {
    if (!win || typeof win !== 'object' || Array.isArray(win)) {
      throw new TypeError(`settlement.wins.${index} is invalid`);
    }
    const winnerId = member(win.winnerId, players, 'winnerId');
    if (winnerId !== winnerIds[index] || TIER_INDEX[win.tier] === undefined
      || (win.piao !== undefined && typeof win.piao !== 'boolean')
      || (win.cappedByNoFlowerSelfDraw !== undefined
        && typeof win.cappedByNoFlowerSelfDraw !== 'boolean')
      || (win.patterns !== undefined && (!Array.isArray(win.patterns)
        || win.patterns.some(pattern => typeof pattern !== 'string')))
      || (win.gangWinCount !== undefined
        && (!Number.isInteger(win.gangWinCount) || win.gangWinCount < 0))) {
      throw new TypeError(`settlement.wins.${index} is inconsistent`);
    }
    tierByWinner.set(winnerId, win.tier);
    piaoByWinner.set(winnerId, win.piao);
  }
  const hasSanxiMetadata = settlement.sanxiPairs !== undefined
    || settlement.releasedSanxiPairs !== undefined;
  if (hasSanxiMetadata
    && (!Array.isArray(settlement.sanxiPairs) || !Array.isArray(settlement.releasedSanxiPairs))) {
    throw new TypeError('settlement Sanxi metadata is incomplete');
  }
  const appliedSanxiPairs = hasSanxiMetadata
    ? normalizedSanxiPairList(settlement.sanxiPairs, players)
    : [];
  const releasedSanxiPairs = hasSanxiMetadata
    ? normalizedSanxiPairList(settlement.releasedSanxiPairs, players)
    : [];
  const appliedSanxi = new Set(appliedSanxiPairs.map(pair => pairKey(pair[0], pair[1])));
  const releasedSanxi = new Set(releasedSanxiPairs.map(pair => pairKey(pair[0], pair[1])));
  if (hasSanxiMetadata && [...appliedSanxi].some(key => releasedSanxi.has(key))) {
    throw new TypeError('applied and released Sanxi relations must be disjoint');
  }
  if (settlement.outcome === 'discard' && winnerIds.length > 1
    && appliedSanxiPairs.some(pair => pair.every(playerId => winnerIds.includes(playerId)))) {
    throw new TypeError('Sanxi relations between co-winners must be released');
  }
  if (releasedSanxiPairs.some(pair => settlement.outcome !== 'discard'
    || winnerIds.length < 2
    || !pair.every(playerId => winnerIds.includes(playerId)))) {
    throw new TypeError('released Sanxi relations must connect co-winners of one discard');
  }
  const flowerAwardCountByPlayer = normalizeFlowerAwardCounts(
    settlement.flowerAwardCountByPlayer,
    players
  );
  if (config.zeng > 0
    && players.some(playerId => zeng[playerId] === 0 && flowerAwardCountByPlayer[playerId] !== 0)) {
    throw new TypeError('a player without zeng cannot receive a flower award');
  }
  if (settlement.outcome === 'draw'
    && Object.values(flowerAwardCountByPlayer).some(count => count !== 0)) {
    throw new TypeError('draw settlement must cancel flower awards');
  }
  if (settlement.outcome === 'discard'
    && flowerAwardCountByPlayer[settlement.discarderId] !== 0) {
    throw new TypeError('discarder flower awards must be cancelled');
  }
  const expectedFlowerRelations = new Set();
  if (settlement.outcome !== 'draw') {
    for (const holderId of players) {
      if (flowerAwardCountByPlayer[holderId] === 0) continue;
      for (const payerId of players) {
        if (payerId !== holderId) expectedFlowerRelations.add(`${payerId}\u0000${holderId}`);
      }
    }
  }
  const expectedRelations = new Set();
  if (hasSanxiMetadata && settlement.outcome !== 'draw') {
    for (const winnerId of winnerIds) {
      const regularPayers = settlement.outcome === 'self_draw'
        ? players.filter(playerId => playerId !== winnerId)
        : [settlement.discarderId];
      const sanxiPayers = players.filter(playerId =>
        playerId !== winnerId && appliedSanxi.has(pairKey(winnerId, playerId)));
      for (const payerId of new Set([...regularPayers, ...sanxiPayers])) {
        expectedRelations.add(`${payerId}\u0000${winnerId}`);
      }
    }
  }
  if (settlement.outcome === 'draw') {
    if (winnerIds.length !== 0 || settlement.transfers.length !== 0
      || settlement.discarderId !== null) {
      throw new TypeError('draw settlement must not contain winners or transfers');
    }
  } else if (settlement.outcome === 'self_draw') {
    if (winnerIds.length !== 1 || settlement.discarderId !== null
      || settlement.transfers.length !== (hasSanxiMetadata ? expectedRelations.size : players.length - 1)
        + expectedFlowerRelations.size) {
      throw new TypeError('self-draw settlement shape is invalid');
    }
  } else {
    const discarderId = member(settlement.discarderId, players, 'discarderId');
    if (winnerIds.length < 1 || winnerIds.length > 3 || winnerIds.includes(discarderId)
      || settlement.transfers.length !== (hasSanxiMetadata ? expectedRelations.size : winnerIds.length)
        + expectedFlowerRelations.size) {
      throw new TypeError('discard settlement shape is invalid');
    }
  }

  const reconstructed = Object.fromEntries(players.map(playerId => [playerId, 0]));
  const relationKeys = new Set();
  const flowerRelationKeys = new Set();
  for (const [index, transfer] of settlement.transfers.entries()) {
    const payerId = member(transfer?.from, players, 'transfer.from');
    const winnerId = member(transfer?.to, players, 'transfer.to');
    const relationKey = `${payerId}\u0000${winnerId}`;
    if (transfer?.kind === 'flower_award') {
      const count = flowerAwardCountByPlayer[winnerId];
      const unit = config.scoreTiers[1];
      const trace = transfer.trace;
      if (payerId === winnerId || count < 1 || !expectedFlowerRelations.has(relationKey)
        || flowerRelationKeys.has(relationKey)
        || transfer.scoreOrderVersion !== SUSONG_SCORE_ORDER_VERSION
        || !Array.isArray(trace) || trace.length !== 1 || trace[0]?.stage !== 'flower_award'
        || trace[0].count !== count || trace[0].unit !== unit
        || trace[0].value !== count * unit || transfer.amount !== count * unit) {
        throw new TypeError(`settlement.transfers.${index} flower award is invalid`);
      }
      flowerRelationKeys.add(relationKey);
      reconstructed[payerId] -= transfer.amount;
      reconstructed[winnerId] += transfer.amount;
      continue;
    }
    const tier = tierByWinner.get(winnerId);
    if ((transfer?.kind !== undefined && transfer.kind !== 'win')
      || !tier || payerId === winnerId || relationKeys.has(relationKey)
      || transfer.tier !== tier
      || transfer.scoreOrderVersion !== SUSONG_SCORE_ORDER_VERSION) {
      throw new TypeError(`settlement.transfers.${index} relation is invalid`);
    }
    relationKeys.add(relationKey);
    if (settlement.outcome === 'self_draw') {
      if (winnerId !== winnerIds[0] || winnerIds.includes(payerId)) {
        throw new TypeError(`settlement.transfers.${index} self-draw relation is invalid`);
      }
    } else if (settlement.outcome === 'discard'
      && payerId !== settlement.discarderId
      && !(hasSanxiMetadata && appliedSanxi.has(pairKey(winnerId, payerId)))) {
      throw new TypeError(`settlement.transfers.${index} payer is not the discarder`);
    }
    const trace = transfer.trace;
    const stages = ['winner_zeng', 'payer_zeng', 'piao', 'flower_tier', 'sanxi'];
    if (!Array.isArray(trace) || trace.length !== stages.length
      || trace.some((stage, stageIndex) => stage?.stage !== stages[stageIndex])) {
      throw new TypeError(`settlement.transfers.${index} trace order is invalid`);
    }
    const winnerZeng = zeng[winnerId] * config.zeng;
    const payerZeng = zeng[payerId] * config.zeng;
    const baseScore = config.scoreTiers[TIER_INDEX[tier]];
    const subtotal = winnerZeng + payerZeng + baseScore;
    const multiplier = trace[4].multiplier;
    const expectedRegularShare = settlement.outcome === 'self_draw'
      ? (payerId === winnerId ? 0 : 1)
      : (payerId === settlement.discarderId ? 1 : 0);
    const expectedSanxiShare = hasSanxiMetadata && appliedSanxi.has(pairKey(winnerId, payerId)) ? 1 : 0;
    if (trace[0].count !== zeng[winnerId] || trace[0].unit !== config.zeng
      || trace[0].value !== winnerZeng
      || trace[1].count !== zeng[payerId] || trace[1].unit !== config.zeng
      || trace[1].value !== payerZeng
      || !['piao', 'not_piao'].includes(trace[2].status) || trace[2].value !== 0
      || (piaoByWinner.get(winnerId) !== undefined
        && (trace[2].status === 'piao') !== piaoByWinner.get(winnerId))
      || trace[3].tier !== tier || trace[3].value !== baseScore
      || trace[3].subtotal !== subtotal
      || ![1, 2].includes(multiplier)
      || (hasSanxiMetadata && (trace[4].regularShare !== expectedRegularShare
        || trace[4].sanxiShare !== expectedSanxiShare
        || multiplier !== expectedRegularShare + expectedSanxiShare))
      || trace[4].value !== subtotal * multiplier
      || transfer.amount !== trace[4].value
      || !Number.isSafeInteger(transfer.amount) || transfer.amount <= 0) {
      throw new TypeError(`settlement.transfers.${index} trace arithmetic is invalid`);
    }
    reconstructed[payerId] -= transfer.amount;
    reconstructed[winnerId] += transfer.amount;
  }
  if (hasSanxiMetadata
    && (relationKeys.size !== expectedRelations.size
      || [...expectedRelations].some(key => !relationKeys.has(key)))) {
    throw new TypeError('settlement transfers do not match Sanxi payment relations');
  }
  if (flowerRelationKeys.size !== expectedFlowerRelations.size
    || [...expectedFlowerRelations].some(key => !flowerRelationKeys.has(key))) {
    throw new TypeError('settlement transfers do not match flower award relations');
  }
  if (!settlement.deltaByPlayer || typeof settlement.deltaByPlayer !== 'object'
    || Array.isArray(settlement.deltaByPlayer)
    || Object.keys(settlement.deltaByPlayer).length !== players.length
    || players.some(playerId => settlement.deltaByPlayer[playerId] !== reconstructed[playerId])) {
    throw new TypeError('settlement delta does not reconcile with its audit trace');
  }
  return true;
}

function normalizeWinnerInputs(input) {
  if (Array.isArray(input.winners)) {
    if (input.winners.length < 1 || input.winners.length > 3) {
      throw new TypeError('winners must contain between one and three winners');
    }
    return input.winners.map((winner, index) => {
      if (!winner || typeof winner !== 'object' || Array.isArray(winner)) {
        throw new TypeError(`winners.${index} must be an object`);
      }
      return {
        ...winner,
        winnerId: winner.winnerId ?? winner.playerId
      };
    });
  }
  return [{
    winnerId: input.winnerId,
    flowerState: input.flowerState,
    patterns: input.patterns,
    gangWinCount: input.gangWinCount
  }];
}

function normalizePlayers(value) {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new TypeError('playerIds must contain exactly four players');
  }
  const players = value.map(playerId => String(playerId).trim());
  if (players.some(playerId => !playerId) || new Set(players).size !== 4) {
    throw new TypeError('playerIds must contain four unique non-empty players');
  }
  return players;
}

function member(value, players, field) {
  const playerId = value === null || value === undefined ? '' : String(value).trim();
  if (!players.includes(playerId)) throw new TypeError(`${field} must identify a room player`);
  return playerId;
}

function normalizeZeng(value, players) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('zengByPlayer must be an object');
  }
  const result = {};
  for (const playerId of players) {
    const count = value[playerId];
    if (!Number.isInteger(count) || count < 0) {
      throw new TypeError(`zengByPlayer.${playerId} must be a non-negative integer`);
    }
    result[playerId] = count;
  }
  return result;
}

function normalizeFlowerAwardCounts(value, players) {
  if (value === undefined || value === null) {
    return Object.fromEntries(players.map(playerId => [playerId, 0]));
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('flowerAwardCountByPlayer must be an object');
  }
  const result = {};
  for (const playerId of players) {
    const count = value[playerId] ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(`flowerAwardCountByPlayer.${playerId} must be a non-negative integer`);
    }
    result[playerId] = count;
  }
  return result;
}

function normalizeSanxiPairs(value, players) {
  if (!Array.isArray(value)) throw new TypeError('sanxiPairs must be an array');
  const result = new Set();
  for (const relation of value) {
    if (!Array.isArray(relation) || relation.length !== 2) {
      throw new TypeError('each sanxi pair must contain two players');
    }
    const left = member(relation[0], players, 'sanxiPair');
    const right = member(relation[1], players, 'sanxiPair');
    if (left === right) throw new TypeError('a sanxi pair must contain two different players');
    result.add(pairKey(left, right));
  }
  return result;
}

function normalizedSanxiPairList(value, players) {
  return [...normalizeSanxiPairs(value, players)]
    .sort()
    .map(key => key.split('\u0000'));
}

function pairKey(left, right) {
  return [left, right].sort().join('\u0000');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
