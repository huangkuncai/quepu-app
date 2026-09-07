import {
  evaluateSusongWin,
  normalizeSusongConfig
} from './susong.js';

const TIER_INDEX = Object.freeze({
  small: 0,
  big: 1,
  double_big: 2,
  one_bamboo: 3
});

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
  const decision = evaluateSusongWin({ flowerState, winSource, patterns, gangWinCount });
  if (!decision.allowed) {
    throw new TypeError(`win is not allowed: ${decision.reason}`);
  }

  const payers = winSource === 'self_draw'
    ? players.filter(playerId => playerId !== winner)
    : [member(discarderId, players, 'discarderId')];
  if (payers.includes(winner)) throw new TypeError('winnerId cannot also be a payer');

  const tier = decision.tier;
  const baseScore = config.scoreTiers[TIER_INDEX[tier]];
  const relations = normalizeSanxiPairs(sanxiPairs, players);
  const transfers = payers.map(payerId => {
    const winnerZengScore = zeng[winner] * config.zeng;
    const payerZengScore = zeng[payerId] * config.zeng;
    const beforeSanxi = baseScore + winnerZengScore + payerZengScore;
    const sanxiMultiplier = relations.has(pairKey(winner, payerId)) ? 2 : 1;
    return deepFreeze({
      from: payerId,
      to: winner,
      amount: beforeSanxi * sanxiMultiplier,
      tier,
      trace: [
        { stage: 'flower_tier', value: baseScore },
        { stage: 'winner_zeng', count: zeng[winner], unit: config.zeng, value: winnerZengScore },
        { stage: 'payer_zeng', count: zeng[payerId], unit: config.zeng, value: payerZengScore },
        { stage: 'sanxi', multiplier: sanxiMultiplier, value: beforeSanxi * sanxiMultiplier }
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
    classifiedTier: decision.tier,
    settledTier: tier,
    selfDrawPromoted: false,
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
    return deepFreeze({
      scoreAuthority: 'server',
      outcome: 'draw',
      winnerIds: [],
      discarderId: null,
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
    sanxiPairs: input.sanxiPairs ?? []
  }));
  const transfers = wins.flatMap(win => win.transfers);
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
    outcome,
    winnerIds,
    discarderId,
    wins: wins.map(win => ({
      winnerId: win.winnerId,
      flowerCount: win.flowerCount,
      tier: win.settledTier
    })),
    transfers,
    deltaByPlayer
  });
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

function pairKey(left, right) {
  return [left, right].sort().join('\u0000');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
