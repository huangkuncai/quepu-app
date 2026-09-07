import { createHash, randomBytes } from 'node:crypto';

export const SUSONG_WALL_VERSION = 'susong-144-candidate-v1';
export const SUSONG_SHUFFLE_ALGORITHM = 'sha256-counter-fisher-yates-v1';
export const SUSONG_DEAL_ALGORITHM = 'dealer-clockwise-4x3-1x1-extra-v1';
// The reference client proves that flower replacement exists, but not which
// end of the authoritative wall the legacy server used. Keep that choice
// versioned and provisional until server captures or signed rules confirm it.
export const SUSONG_REPLACEMENT_DRAW_POLICY = 'tail-v1-provisional';

const SUITS = Object.freeze(['characters', 'bamboo', 'dots']);
const WINDS = Object.freeze(['east', 'south', 'west', 'north']);
const DRAGONS = Object.freeze(['red_dragon', 'green_dragon', 'white_dragon']);

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

/** Deal 53 opening tiles in four-tile batches, starting from the dealer. */
export function dealSusongOpeningHands({ wall, playerIds, dealerId } = {}) {
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
  for (const playerId of seatOrder) {
    handsByPlayer[playerId].push(tileIds[cursor]);
    cursor += 1;
  }
  handsByPlayer[dealer].push(tileIds[cursor]);
  cursor += 1;

  return deepFreeze({
    wallVersion: wall.wallVersion,
    shuffleAlgorithm: wall.shuffleAlgorithm,
    dealAlgorithm: SUSONG_DEAL_ALGORITHM,
    replacementDrawPolicy: SUSONG_REPLACEMENT_DRAW_POLICY,
    seedCommitment: wall.seedCommitment,
    dealerId: dealer,
    handsByPlayer,
    handCountsByPlayer: Object.fromEntries(players.map(playerId => [playerId, handsByPlayer[playerId].length])),
    remainingWall: tileIds.slice(cursor),
    wallRemaining: tileIds.length - cursor
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

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
