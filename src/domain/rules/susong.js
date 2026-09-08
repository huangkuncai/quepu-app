const ROUND_OPTIONS = Object.freeze([4, 8, 16]);
const SCORE_OPTIONS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9]);
const ZENG_OPTIONS = Object.freeze([0, 1, 2, 3, 5]);
const PIAO_MODES = Object.freeze(['strong', 'optional']);

export const SUSONG_SCORE_ORDER_VERSION = 'zeng-piao-flower-sanxi-v1';

export const SUSONG_SPECIAL_HU = Object.freeze([
  'seven_pairs', 'no_flower', 'pure_one_suit', 'mixed_one_suit', 'all_triplets',
  'all_from_others', 'heavenly_win', 'earthly_win', 'robbing_kong'
]);

export const SUSONG_DEFAULT_CONFIG = deepFreeze({
  rounds: 4,
  scoreTiers: [1, 2, 3, 4],
  zeng: 1,
  piao: 'optional',
  forcedHu: false
});

/** Normalize the room options exposed by the legacy 8931 client. */
export function normalizeSusongConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Susong config must be an object');
  }
  const rounds = integer(input.rounds ?? input.times ?? SUSONG_DEFAULT_CONFIG.rounds, 'rounds');
  if (!ROUND_OPTIONS.includes(rounds)) fail('rounds', 'must be one of 4, 8 or 16');
  const scoreTiers = normalizeScoreTiers(input.scoreTiers ?? input.branch ?? SUSONG_DEFAULT_CONFIG.scoreTiers);
  const zeng = integer(input.zeng ?? input.zun ?? SUSONG_DEFAULT_CONFIG.zeng, 'zeng');
  if (!ZENG_OPTIONS.includes(zeng)) fail('zeng', 'must be one of 0, 1, 2, 3 or 5');
  const piao = normalizePiao(input.piao ?? SUSONG_DEFAULT_CONFIG.piao);
  const forcedHu = normalizeBoolean(input.forcedHu ?? input.hu ?? SUSONG_DEFAULT_CONFIG.forcedHu, 'forcedHu');
  return deepFreeze({ rounds, scoreTiers, zeng, piao, forcedHu });
}

export function toLegacy8931Config(input = {}) {
  const config = normalizeSusongConfig(input);
  return Object.freeze({
    times: config.rounds,
    branch: config.scoreTiers.join(''),
    zun: config.zeng,
    piao: config.piao === 'strong' ? 2 : 1,
    hu: config.forcedHu ? 1 : 0,
    maxPlayerNum: 4
  });
}

/** Return the score tier named by the APK rule sheet, before zeng/piao/sanxi. */
export function classifySusongHu({ flowerCount, patterns = [], gangWinCount = 0 } = {}) {
  const flowers = integer(flowerCount, 'flowerCount');
  const gangWins = integer(gangWinCount, 'gangWinCount');
  if (flowers < 0) fail('flowerCount', 'must be zero or greater');
  if (gangWins < 0) fail('gangWinCount', 'must be zero or greater');
  const declaredPatterns = new Set(patterns);
  if ([...declaredPatterns].some(pattern => !SUSONG_SPECIAL_HU.includes(pattern))) {
    fail('patterns', 'contains an unknown Susong winning pattern');
  }
  if (gangWins >= 2 || [...declaredPatterns].some(pattern => SUSONG_SPECIAL_HU.includes(pattern))) {
    return 'one_bamboo';
  }
  if (gangWins === 1) {
    if (flowers >= 6) return 'one_bamboo';
    if (flowers >= 4) return 'double_big';
    return 'big';
  }
  if (flowers === 0) return 'one_bamboo';
  if (flowers <= 4) return 'small';
  if (flowers <= 9) return 'big';
  return 'double_big';
}

export function flowerUnitsForMeld({ kind, isWind = false } = {}) {
  if (kind === 'concealed_kong') return isWind ? 3 : 2;
  if (kind === 'exposed_kong' || kind === 'added_kong') return isWind ? 2 : 1;
  if (kind === 'triplet') return isWind ? 1 : 0;
  fail('kind', 'must be triplet, exposed_kong, added_kong or concealed_kong');
}

export function flowerAwardScore(input = {}, { wonByDiscard = false, draw = false } = {}) {
  if (wonByDiscard || draw) return 0;
  return normalizeSusongConfig(input).scoreTiers[1];
}

/**
 * Create the server-owned flower/piao state after the opening hand is dealt.
 *
 * `piao` is a flower-handling rule, never a score supplied by a client. In a
 * strong-piao room an opening hand without flowers is automatically piao. An
 * opening hand with flowers must make the one permitted choice before play.
 */
export function createSusongFlowerState({
  piaoMode = SUSONG_DEFAULT_CONFIG.piao,
  initialFlowerCount = 0,
  choosesPiao
} = {}) {
  const mode = normalizePiao(piaoMode);
  const openingFlowers = nonNegativeInteger(initialFlowerCount, 'initialFlowerCount');

  if (mode === 'strong' && openingFlowers > 0 && typeof choosesPiao !== 'boolean') {
    return flowerState({
      mode,
      status: 'awaiting_piao_choice',
      openingFlowers,
      pendingFlowerDiscards: openingFlowers
    });
  }

  const isPiao = mode === 'strong' && (openingFlowers === 0 || choosesPiao === true);
  if (isPiao) {
    return flowerState({
      mode,
      status: 'piao',
      openingFlowers,
      pendingFlowerDiscards: openingFlowers
    });
  }

  return flowerState({
    mode,
    status: 'not_piao',
    openingFlowers,
    countedFlowers: openingFlowers,
    pendingFlowerReplacements: openingFlowers
  });
}

/** Record a server-observed flower draw and return the next immutable state. */
export function recordSusongFlowerDraw(current, count = 1) {
  const state = normalizeFlowerState(current);
  const drawn = nonNegativeInteger(count, 'count');
  if (drawn === 0) return state;
  if (state.status === 'awaiting_piao_choice') {
    fail('flowerState', 'must resolve the opening piao choice before drawing');
  }
  if (state.status === 'piao') {
    return flowerState({
      ...state,
      drawnFlowers: state.drawnFlowers + drawn,
      pendingFlowerDiscards: state.pendingFlowerDiscards + drawn
    });
  }
  return flowerState({
    ...state,
    drawnFlowers: state.drawnFlowers + drawn,
    countedFlowers: state.countedFlowers + drawn,
    pendingFlowerReplacements: state.pendingFlowerReplacements + drawn
  });
}

/** Add flower units earned from a public peng/kong without faking a flower draw. */
export function recordSusongMeldFlowers(current, units) {
  const state = normalizeFlowerState(current);
  const amount = nonNegativeInteger(units, 'units');
  if (state.status === 'awaiting_piao_choice') {
    fail('flowerState', 'must resolve the opening piao choice before declaring a meld');
  }
  return flowerState({
    ...state,
    meldFlowers: state.meldFlowers + amount,
    countedFlowers: state.countedFlowers + amount
  });
}

/** Resolve flower discards/replacements; the server calls this after actions. */
export function resolveSusongFlowers(current, { discard = 0, replace = 0 } = {}) {
  const state = normalizeFlowerState(current);
  const discarded = nonNegativeInteger(discard, 'discard');
  const replaced = nonNegativeInteger(replace, 'replace');
  if (discarded > state.pendingFlowerDiscards) fail('discard', 'exceeds pending flower discards');
  if (replaced > state.pendingFlowerReplacements) fail('replace', 'exceeds pending flower replacements');
  return flowerState({
    ...state,
    pendingFlowerDiscards: state.pendingFlowerDiscards - discarded,
    pendingFlowerReplacements: state.pendingFlowerReplacements - replaced
  });
}

/**
 * Decide win eligibility and the flower tier from authoritative round state.
 * A piao/no-flower hand cannot win from a discard; self-draw is the cap tier.
 */
export function evaluateSusongWin({ flowerState: current, winSource, patterns = [], gangWinCount = 0 } = {}) {
  const state = normalizeFlowerState(current);
  if (!['discard', 'self_draw'].includes(winSource)) {
    fail('winSource', 'must be discard or self_draw');
  }
  if (state.status === 'awaiting_piao_choice') {
    return winDecision(false, null, 'PIAO_CHOICE_REQUIRED', state);
  }
  if (state.pendingFlowerDiscards > 0) {
    return winDecision(false, null, 'FLOWER_DISCARD_REQUIRED', state);
  }
  if (state.pendingFlowerReplacements > 0) {
    return winDecision(false, null, 'FLOWER_REPLACEMENT_REQUIRED', state);
  }
  const noFlower = state.status === 'piao' || state.countedFlowers === 0;
  if (noFlower && winSource !== 'self_draw') {
    return winDecision(false, null, 'NO_FLOWER_SELF_DRAW_ONLY', state);
  }
  const tier = noFlower
    ? 'one_bamboo'
    : classifySusongHu({ flowerCount: state.countedFlowers, patterns, gangWinCount });
  return winDecision(true, tier, null, state, { cappedByNoFlowerSelfDraw: noFlower });
}

export const susongRule = deepFreeze({
  id: 'susong_v1',
  version: '8931-apk-baseline.3',
  legacyGameId: 8931,
  name: '宿松麻将',
  players: 4,
  scoreSettlement: 'points',
  config: {
    defaults: SUSONG_DEFAULT_CONFIG,
    rounds: ROUND_OPTIONS,
    scoreTierChoices: SCORE_OPTIONS,
    scoreTierCount: 4,
    zeng: ZENG_OPTIONS,
    piao: PIAO_MODES,
    forcedHu: [false, true]
  },
  tiles: {
    suits: ['characters', 'bamboo', 'dots'],
    ranks: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    winds: ['east', 'south', 'west', 'north'],
    flowerOnDraw: ['red_dragon', 'green_dragon', 'white_dragon', 'red_flower', 'black_flower']
  },
  actions: [
    'draw', 'discard', 'chi', 'peng', 'exposed_kong', 'concealed_kong',
    'added_kong', 'flower_replacement', 'hu', 'self_draw', 'pass'
  ],
  settlement: {
    scoreOrderVersion: SUSONG_SCORE_ORDER_VERSION,
    flowerTiers: { small: [1, 4], big: [5, 9], doubleBig: [10, null] },
    specialTier: 'one_bamboo',
    discardLoss: 'discarder_only',
    selfDrawLoss: 'all_other_players',
    multipleDiscardWinners: true,
    drawAtRemainingTiles: 14,
    drawScores: false,
    sanxiMultiplier: 2
  },
  piaoFlow: {
    meaning: 'flower_handling_mode',
    strongOpeningNoFlower: 'automatic_piao',
    strongOpeningWithFlower: 'choose_piao_or_not_piao',
    piaoFlowerAction: 'discard',
    nonPiaoFlowerAction: 'replace',
    noFlowerWin: 'self_draw_only',
    noFlowerSelfDrawTier: 'one_bamboo'
  },
  source: 'reference-apk:assets/res/common/8931_rule.txt'
});

export const ruleRegistry = new Map([[susongRule.id, susongRule]]);

function normalizeScoreTiers(value) {
  const values = typeof value === 'string' ? [...value].map(Number) : Array.from(value || []);
  if (values.length !== 4) fail('scoreTiers', 'must contain exactly four scores');
  for (const score of values) {
    if (!Number.isInteger(score) || !SCORE_OPTIONS.includes(score)) {
      fail('scoreTiers', 'scores must be integers from 1 to 9');
    }
  }
  if (new Set(values).size !== values.length) fail('scoreTiers', 'scores must be unique');
  if (!values.every((score, index) => index === 0 || values[index - 1] < score)) {
    fail('scoreTiers', 'scores must be strictly increasing');
  }
  return values;
}

function normalizePiao(value) {
  if (value === 2 || value === '2' || value === 'strong') return 'strong';
  if (value === 1 || value === '1' || value === 'optional') return 'optional';
  fail('piao', 'must be strong/2 or optional/1');
}

function normalizeBoolean(value, field) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  fail(field, 'must be a boolean');
}

function integer(value, field) {
  const result = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(result)) fail(field, 'must be an integer');
  return result;
}

function nonNegativeInteger(value, field) {
  const result = integer(value, field);
  if (result < 0) fail(field, 'must be zero or greater');
  return result;
}

function flowerState({
  mode,
  status,
  openingFlowers = 0,
  drawnFlowers = 0,
  meldFlowers = 0,
  countedFlowers = 0,
  pendingFlowerDiscards = 0,
  pendingFlowerReplacements = 0
}) {
  return deepFreeze({
    mode,
    status,
    openingFlowers,
    drawnFlowers,
    meldFlowers,
    countedFlowers,
    pendingFlowerDiscards,
    pendingFlowerReplacements
  });
}

function normalizeFlowerState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('flowerState', 'must be an object');
  }
  if (!PIAO_MODES.includes(value.mode)) fail('flowerState.mode', 'is invalid');
  if (!['awaiting_piao_choice', 'piao', 'not_piao'].includes(value.status)) {
    fail('flowerState.status', 'is invalid');
  }
  return flowerState({
    mode: value.mode,
    status: value.status,
    openingFlowers: nonNegativeInteger(value.openingFlowers ?? 0, 'openingFlowers'),
    drawnFlowers: nonNegativeInteger(value.drawnFlowers ?? 0, 'drawnFlowers'),
    meldFlowers: nonNegativeInteger(value.meldFlowers ?? 0, 'meldFlowers'),
    countedFlowers: nonNegativeInteger(value.countedFlowers ?? 0, 'countedFlowers'),
    pendingFlowerDiscards: nonNegativeInteger(value.pendingFlowerDiscards ?? 0, 'pendingFlowerDiscards'),
    pendingFlowerReplacements: nonNegativeInteger(value.pendingFlowerReplacements ?? 0, 'pendingFlowerReplacements')
  });
}

function winDecision(allowed, tier, reason, state, extra = {}) {
  return deepFreeze({
    allowed,
    tier,
    reason,
    flowerCount: state.countedFlowers,
    piao: state.status === 'piao',
    ...extra
  });
}

function fail(field, message) {
  throw new TypeError(`${field} ${message}`);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
