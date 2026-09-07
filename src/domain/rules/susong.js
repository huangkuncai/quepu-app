const ROUND_OPTIONS = Object.freeze([4, 8, 16]);
const SCORE_OPTIONS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9]);
const ZENG_OPTIONS = Object.freeze([0, 1, 2, 3, 5]);
const PIAO_MODES = Object.freeze(['strong', 'optional']);

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

export const susongRule = deepFreeze({
  id: 'susong_v1',
  version: '8931-apk-baseline.1',
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
    flowerTiers: { small: [1, 4], big: [5, 9], doubleBig: [10, null] },
    specialTier: 'one_bamboo',
    discardLoss: 'discarder_only',
    selfDrawLoss: 'all_other_players',
    multipleDiscardWinners: true,
    drawAtRemainingTiles: 14,
    drawScores: false,
    sanxiMultiplier: 2
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

function fail(field, message) {
  throw new TypeError(`${field} ${message}`);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
