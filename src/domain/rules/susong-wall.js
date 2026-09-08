import { createHash, randomBytes } from 'node:crypto';

export const SUSONG_WALL_VERSION = 'susong-144-candidate-v1';
export const SUSONG_SHUFFLE_ALGORITHM = 'sha256-counter-fisher-yates-v1';
export const SUSONG_DEAL_ALGORITHM = 'dealer-clockwise-4x3-jump-one-idle-one-v2';
export const LEGACY_SUSONG_DEAL_ALGORITHM = 'dealer-clockwise-4x3-1x1-extra-v1';
// Confirmed rule: ordinary draws consume the head; flower and kong replacement
// draws consume the tail. The legacy name remains accepted when replaying old
// snapshots because both versions used the same deterministic algorithm.
export const SUSONG_REPLACEMENT_DRAW_POLICY = 'head-live-tail-replacement-v1';

const SUITS = Object.freeze(['characters', 'bamboo', 'dots']);
const WINDS = Object.freeze(['east', 'south', 'west', 'north']);
const DRAGONS = Object.freeze(['red_dragon', 'green_dragon', 'white_dragon']);
let tileById;

/** Build the physical 144-tile candidate wall with stable, unique tile IDs. */
export function buildSusongTileSet() {
  const tiles = [];
  for (const suit of SUITS) {
    for (let rank = 1; rank <= 9; rank += 1) {
      for (let copy = 1; copy <= 4; copy += 1) {
        tiles.push(tile(`${suit}-${rank}-${copy}`, 'suited', { suit, rank, copy }));
      }
    }
  }
  for (const wind of WINDS) {
    for (let copy = 1; copy <= 4; copy += 1) {
      tiles.push(tile(`${wind}-${copy}`, 'wind', { value: wind, copy }));
    }
  }
  for (const dragon of DRAGONS) {
    for (let copy = 1; copy <= 4; copy += 1) {
      tiles.push(tile(`${dragon}-${copy}`, 'dragon', {
        value: dragon,
        copy,
        isReplacementFlower: true
      }));
    }
  }
  for (const color of ['red', 'black']) {
    for (let index = 1; index <= 4; index += 1) {
      tiles.push(tile(`${color}_flower-${index}`, 'flower', {
        value: `${color}_flower`,
        copy: index,
        isReplacementFlower: true
      }));
    }
  }
  if (tiles.length !== 144 || new Set(tiles.map(item => item.id)).size !== 144) {
    throw new Error('Susong wall definition must contain 144 unique physical tiles');
  }
  return Object.freeze(tiles);
}

export function isSusongReplacementFlower(tileId) {
  const id = String(tileId ?? '');
  return DRAGONS.some(dragon => id.startsWith(`${dragon}-`))
    || id.startsWith('red_flower-')
    || id.startsWith('black_flower-');
}

/** Return the logical face shared by the physical copies of one tile. */
export function susongTileFace(tileId) {
  const id = String(tileId ?? '');
  tileById ??= new Map(buildSusongTileSet().map(tile => [tile.id, tile]));
  const tile = tileById.get(id);
  if (!tile) throw new TypeError('tileId must identify a Susong tile');
  if (tile.category === 'suited') return `${tile.suit}-${tile.rank}`;
  return tile.value;
}

/**
 * Compute discard reactions from server-owned hand data. The returned
 * physical IDs are private engine input and must not be broadcast directly.
 * Priority/arbitration is intentionally handled by the room state machine.
 */
export function getSusongDiscardReactionCandidates({ hand, tileId, isNextPlayer = false } = {}) {
  if (!Array.isArray(hand)) throw new TypeError('hand must be an array');
  if (isSusongReplacementFlower(tileId)) return deepFreeze([]);
  const discardedFace = susongTileFace(tileId);
  const matching = hand.filter(candidate => susongTileFace(candidate) === discardedFace);
  const candidates = [];
  if (matching.length >= 3) {
    candidates.push({ action: 'exposed_kong', consumeTileIds: matching.slice(0, 3) });
  }
  if (matching.length >= 2) {
    candidates.push({ action: 'peng', consumeTileIds: matching.slice(0, 2) });
  }
  if (isNextPlayer && /^(characters|bamboo|dots)-[1-9]$/.test(discardedFace)) {
    const [suit, rankText] = discardedFace.split('-');
    const rank = Number(rankText);
    for (let start = Math.max(1, rank - 2); start <= Math.min(7, rank); start += 1) {
      const sequence = [start, start + 1, start + 2].map(value => `${suit}-${value}`);
      const requiredFaces = sequence.filter(face => face !== discardedFace);
      const consumeTileIds = requiredFaces.map(face =>
        hand.find(candidate => susongTileFace(candidate) === face));
      if (consumeTileIds.every(Boolean)) {
        candidates.push({ action: 'chi', sequence, consumeTileIds });
      }
    }
  }
  return deepFreeze(candidates);
}

/** Return self-kong choices from the private hand and already-public melds. */
export function getSusongTurnKongCandidates({ hand, melds = [] } = {}) {
  if (!Array.isArray(hand)) throw new TypeError('hand must be an array');
  if (!Array.isArray(melds)) throw new TypeError('melds must be an array');
  const byFace = new Map();
  for (const tileId of hand) {
    if (isSusongReplacementFlower(tileId)) continue;
    const face = susongTileFace(tileId);
    if (!byFace.has(face)) byFace.set(face, []);
    byFace.get(face).push(tileId);
  }
  const candidates = [];
  for (const [face, tileIds] of byFace) {
    if (tileIds.length === 4) {
      candidates.push({ action: 'concealed_kong', face, consumeTileIds: [...tileIds] });
    }
  }
  melds.forEach((meld, meldIndex) => {
    if (meld?.action !== 'peng' || !Array.isArray(meld.tileIds) || meld.tileIds.length !== 3) return;
    const face = susongTileFace(meld.tileIds[0]);
    const tileId = byFace.get(face)?.[0];
    if (tileId) candidates.push({ action: 'added_kong', face, meldIndex, consumeTileIds: [tileId] });
  });
  return deepFreeze(candidates);
}

/**
 * Recognize a server-owned concealed hand. This slice deliberately supports
 * the ordinary four-groups-and-a-pair shape plus seven pairs. Patterns that
 * depend on turn history or public meld ownership are added by the Room.
 */
export function getSusongWinningHand({
  hand,
  claimedTileId = null,
  meldCount = 0,
  melds = []
} = {}) {
  if (!Array.isArray(hand)) throw new TypeError('hand must be an array');
  if (!Array.isArray(melds)) throw new TypeError('melds must be an array');
  const effectiveMeldCount = melds.length > 0 ? melds.length : meldCount;
  if (!Number.isInteger(effectiveMeldCount) || effectiveMeldCount < 0 || effectiveMeldCount > 4) {
    throw new TypeError('meldCount must be an integer from 0 through 4');
  }
  const tileIds = [...hand, ...(claimedTileId === null ? [] : [claimedTileId])];
  const expectedTileCount = 14 - effectiveMeldCount * 3;
  if (tileIds.length !== expectedTileCount || tileIds.some(isSusongReplacementFlower)) {
    return deepFreeze({ winning: false, kind: null, patterns: [] });
  }
  let faces;
  try {
    faces = tileIds.map(susongTileFace);
  } catch {
    return deepFreeze({ winning: false, kind: null, patterns: [] });
  }
  const counts = faceCounts(faces);
  if (effectiveMeldCount === 0 && counts.size === 7 && [...counts.values()].every(count => count === 2)) {
    return deepFreeze({ winning: true, kind: 'seven_pairs', patterns: ['seven_pairs'] });
  }
  if (isStandardWinningCounts(counts, 4 - effectiveMeldCount)) {
    const publicTileIds = melds.flatMap(meld => Array.isArray(meld?.tileIds) ? meld.tileIds : []);
    const allFaces = [...faces, ...publicTileIds.map(susongTileFace)];
    const patterns = suitedPattern(allFaces);
    if (melds.every(meld => meld?.action !== 'chi')
      && isTripletWinningCounts(counts, 4 - effectiveMeldCount)) {
      patterns.push('all_triplets');
    }
    return deepFreeze({ winning: true, kind: 'standard', patterns });
  }
  return deepFreeze({ winning: false, kind: null, patterns: [] });
}

/**
 * Shuffle a fresh wall. The seed is private round state; only its commitment
 * may be sent to clients until the round is finished.
 */
export function createSusongShuffledWall({ seed } = {}) {
  const privateSeed = normalizeSeed(seed ?? randomBytes(32));
  const random = createCounterRandom(privateSeed);
  const tileIds = buildSusongTileSet().map(item => item.id);
  for (let index = tileIds.length - 1; index > 0; index -= 1) {
    const swapIndex = random.uniformInteger(index + 1);
    [tileIds[index], tileIds[swapIndex]] = [tileIds[swapIndex], tileIds[index]];
  }
  return deepFreeze({
    wallVersion: SUSONG_WALL_VERSION,
    shuffleAlgorithm: SUSONG_SHUFFLE_ALGORITHM,
    privateSeedHex: privateSeed.toString('hex'),
    seedCommitment: seedCommitment(privateSeed),
    tileIds
  });
}

/** Deal 52 opening tiles: 4x3, dealer jumps one stack, then idle players take one. */
export function dealSusongOpeningHands({
  wall,
  playerIds,
  dealerId,
  dealAlgorithm = SUSONG_DEAL_ALGORITHM
} = {}) {
  const players = normalizePlayers(playerIds);
  const dealer = String(dealerId ?? '').trim();
  const dealerIndex = players.indexOf(dealer);
  if (dealerIndex < 0) throw new TypeError('dealerId must identify a room player');
  const tileIds = normalizeWall(wall);
  const handsByPlayer = Object.fromEntries(players.map(playerId => [playerId, []]));
  const seatOrder = players.map((_, offset) => players[(dealerIndex + offset) % players.length]);
  let cursor = 0;

  for (let round = 0; round < 3; round += 1) {
    for (const playerId of seatOrder) {
      handsByPlayer[playerId].push(...tileIds.slice(cursor, cursor + 4));
      cursor += 4;
    }
  }
  if (dealAlgorithm === LEGACY_SUSONG_DEAL_ALGORITHM) {
    for (const playerId of seatOrder) {
      handsByPlayer[playerId].push(tileIds[cursor]);
      cursor += 1;
    }
    handsByPlayer[dealer].push(tileIds[cursor]);
    cursor += 1;
  } else if (dealAlgorithm === SUSONG_DEAL_ALGORITHM) {
    const skippedStack = tileIds.slice(cursor, cursor + 2);
    cursor += 2;
    handsByPlayer[dealer].push(tileIds[cursor]);
    cursor += 1;
    for (const playerId of seatOrder.slice(1)) {
      handsByPlayer[playerId].push(tileIds[cursor]);
      cursor += 1;
    }
    const liveWall = tileIds.slice(cursor);
    return dealResult({
      wall,
      dealer,
      handsByPlayer,
      players,
      dealAlgorithm,
      remainingWall: [...liveWall, ...skippedStack]
    });
  } else {
    throw new TypeError('dealAlgorithm is unsupported');
  }

  return dealResult({
    wall,
    dealer,
    handsByPlayer,
    players,
    dealAlgorithm,
    remainingWall: tileIds.slice(cursor)
  });
}

function dealResult({ wall, dealer, handsByPlayer, players, dealAlgorithm, remainingWall }) {
  return deepFreeze({
    wallVersion: wall.wallVersion,
    shuffleAlgorithm: wall.shuffleAlgorithm,
    dealAlgorithm,
    replacementDrawPolicy: SUSONG_REPLACEMENT_DRAW_POLICY,
    seedCommitment: wall.seedCommitment,
    dealerId: dealer,
    handsByPlayer,
    handCountsByPlayer: Object.fromEntries(players.map(playerId => [playerId, handsByPlayer[playerId].length])),
    remainingWall,
    wallRemaining: remainingWall.length
  });
}

/** Return the shareable wall metadata without private seed, order, or hands. */
export function publicSusongWallState(dealt) {
  if (!dealt || typeof dealt !== 'object' || Array.isArray(dealt)) {
    throw new TypeError('dealt wall state must be an object');
  }
  return deepFreeze({
    wallVersion: dealt.wallVersion,
    shuffleAlgorithm: dealt.shuffleAlgorithm,
    dealAlgorithm: dealt.dealAlgorithm,
    replacementDrawPolicy: dealt.replacementDrawPolicy,
    seedCommitment: dealt.seedCommitment,
    dealerId: dealt.dealerId,
    handCountsByPlayer: { ...dealt.handCountsByPlayer },
    wallRemaining: dealt.wallRemaining
  });
}

/** Draw one replacement tile from the versioned candidate tail. */
export function drawSusongReplacementTile(remainingWall, { reserveTiles = 14 } = {}) {
  if (!Array.isArray(remainingWall)) throw new TypeError('remainingWall must be an array');
  if (!Number.isInteger(reserveTiles) || reserveTiles < 0) {
    throw new TypeError('reserveTiles must be a non-negative integer');
  }
  if (remainingWall.length <= reserveTiles) {
    throw new RangeError('replacement draw reached the reserved wall boundary');
  }
  const next = [...remainingWall];
  const tileId = next.pop();
  return deepFreeze({
    tileId,
    remainingWall: next,
    wallRemaining: next.length,
    replacementDrawPolicy: SUSONG_REPLACEMENT_DRAW_POLICY
  });
}

/** Draw one normal turn tile from the live-wall head. */
export function drawSusongLiveTile(remainingWall, { reserveTiles = 14 } = {}) {
  if (!Array.isArray(remainingWall)) throw new TypeError('remainingWall must be an array');
  if (!Number.isInteger(reserveTiles) || reserveTiles < 0) {
    throw new TypeError('reserveTiles must be a non-negative integer');
  }
  if (remainingWall.length <= reserveTiles) {
    throw new RangeError('live draw reached the reserved wall boundary');
  }
  const next = [...remainingWall];
  const tileId = next.shift();
  return deepFreeze({ tileId, remainingWall: next, wallRemaining: next.length });
}

/** Verify a post-round seed reveal against the commitment published at deal. */
export function verifySusongSeedCommitment(seed, commitment) {
  if (typeof commitment !== 'string' || !/^[0-9a-f]{64}$/i.test(commitment)) return false;
  try {
    return seedCommitment(normalizeSeed(seed)) === commitment.toLowerCase();
  } catch {
    return false;
  }
}

function tile(id, category, extra = {}) {
  return Object.freeze({ id, category, isReplacementFlower: false, ...extra });
}

function normalizeSeed(value) {
  let seed;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    seed = Buffer.from(value);
  } else if (typeof value === 'string' && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value)) {
    seed = Buffer.from(value, 'hex');
  } else {
    throw new TypeError('seed must be a Buffer, Uint8Array, or even-length hexadecimal string');
  }
  if (seed.length < 32) throw new TypeError('seed must contain at least 32 bytes');
  return seed;
}

function seedCommitment(seed) {
  return createHash('sha256')
    .update(SUSONG_WALL_VERSION)
    .update('\0')
    .update(SUSONG_SHUFFLE_ALGORITHM)
    .update('\0')
    .update(seed)
    .digest('hex');
}

function createCounterRandom(seed) {
  let counter = 0;
  let bytes = Buffer.alloc(0);
  function nextUInt32() {
    if (bytes.length < 4) {
      const counterBytes = Buffer.allocUnsafe(8);
      counterBytes.writeBigUInt64BE(BigInt(counter));
      counter += 1;
      bytes = createHash('sha256').update(seed).update(counterBytes).digest();
    }
    const value = bytes.readUInt32BE(0);
    bytes = bytes.subarray(4);
    return value;
  }
  return {
    uniformInteger(maxExclusive) {
      if (!Number.isInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > 0x100000000) {
        throw new RangeError('maxExclusive must be an integer from 1 through 2^32');
      }
      const range = 0x100000000;
      const limit = range - (range % maxExclusive);
      let value = nextUInt32();
      while (value >= limit) value = nextUInt32();
      return value % maxExclusive;
    }
  };
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

function normalizeWall(wall) {
  if (!wall || typeof wall !== 'object' || !Array.isArray(wall.tileIds)) {
    throw new TypeError('wall must be created by createSusongShuffledWall');
  }
  if (wall.wallVersion !== SUSONG_WALL_VERSION || wall.tileIds.length !== 144) {
    throw new TypeError('wall must use the supported 144-tile version');
  }
  if (new Set(wall.tileIds).size !== 144) throw new TypeError('wall tile IDs must be unique');
  return [...wall.tileIds];
}

function faceCounts(faces) {
  const counts = new Map();
  for (const face of faces) counts.set(face, (counts.get(face) || 0) + 1);
  return counts;
}

function isStandardWinningCounts(counts, groupCount) {
  for (const [face, count] of counts) {
    if (count < 2) continue;
    const next = new Map(counts);
    changeFaceCount(next, face, -2);
    if (consumeSusongGroups(next, groupCount)) return true;
  }
  return false;
}

function isTripletWinningCounts(counts, groupCount) {
  for (const [face, count] of counts) {
    if (count < 2) continue;
    const rest = new Map(counts);
    changeFaceCount(rest, face, -2);
    if ([...rest.values()].every(value => value === 3)
      && [...rest.values()].reduce((sum, value) => sum + value, 0) === groupCount * 3) return true;
  }
  return false;
}

function suitedPattern(faces) {
  const suits = new Set();
  let hasWind = false;
  for (const face of faces) {
    const suited = /^(characters|bamboo|dots)-[1-9]$/.exec(face);
    if (suited) suits.add(suited[1]);
    else hasWind = true;
  }
  if (suits.size !== 1) return [];
  return [hasWind ? 'mixed_one_suit' : 'pure_one_suit'];
}

function consumeSusongGroups(counts, groupsRemaining) {
  if (groupsRemaining === 0) return counts.size === 0;
  const face = [...counts.keys()].sort(compareSusongFaces)[0];
  if (!face) return false;
  if ((counts.get(face) || 0) >= 3) {
    const triplet = new Map(counts);
    changeFaceCount(triplet, face, -3);
    if (consumeSusongGroups(triplet, groupsRemaining - 1)) return true;
  }
  const suited = /^(characters|bamboo|dots)-([1-9])$/.exec(face);
  if (!suited || Number(suited[2]) > 7) return false;
  const sequence = [0, 1, 2].map(offset => `${suited[1]}-${Number(suited[2]) + offset}`);
  if (sequence.every(candidate => (counts.get(candidate) || 0) > 0)) {
    const rest = new Map(counts);
    for (const candidate of sequence) changeFaceCount(rest, candidate, -1);
    if (consumeSusongGroups(rest, groupsRemaining - 1)) return true;
  }
  return false;
}

function changeFaceCount(counts, face, delta) {
  const next = (counts.get(face) || 0) + delta;
  if (next < 0) throw new TypeError('tile face count cannot be negative');
  if (next === 0) counts.delete(face);
  else counts.set(face, next);
}

function compareSusongFaces(left, right) {
  const order = { characters: 0, bamboo: 1, dots: 2, east: 3, south: 4, west: 5, north: 6 };
  const [leftKind, leftRank = '0'] = left.split('-');
  const [rightKind, rightRank = '0'] = right.split('-');
  return (order[leftKind] ?? 99) - (order[rightKind] ?? 99)
    || Number(leftRank) - Number(rightRank)
    || left.localeCompare(right);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
