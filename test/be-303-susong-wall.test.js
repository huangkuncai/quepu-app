import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSusongTileSet,
  createSusongShuffledWall,
  dealSusongOpeningHands,
  publicSusongWallState,
  verifySusongSeedCommitment
} from '../src/domain/rules/susong-wall.js';

const players = ['A', 'B', 'C', 'D'];
const seed = '0123456789abcdef'.repeat(4);

test('candidate Susong wall contains 144 unique physical tiles', () => {
  const tiles = buildSusongTileSet();
  assert.equal(tiles.length, 144);
  assert.equal(new Set(tiles.map(tile => tile.id)).size, 144);
  assert.equal(tiles.filter(tile => tile.category === 'suited').length, 108);
  assert.equal(tiles.filter(tile => tile.category === 'wind').length, 16);
  assert.equal(tiles.filter(tile => tile.category === 'dragon').length, 12);
  assert.equal(tiles.filter(tile => tile.category === 'flower').length, 8);
  assert.equal(tiles.filter(tile => tile.isReplacementFlower).length, 20);
});

test('seeded shuffle is deterministic, unique and auditable', () => {
  const first = createSusongShuffledWall({ seed });
  const second = createSusongShuffledWall({ seed });
  const different = createSusongShuffledWall({ seed: 'ff'.repeat(32) });
  assert.deepEqual(first.tileIds, second.tileIds);
  assert.notDeepEqual(first.tileIds, different.tileIds);
  assert.equal(new Set(first.tileIds).size, 144);
  assert.equal(verifySusongSeedCommitment(seed, first.seedCommitment), true);
  assert.equal(verifySusongSeedCommitment('ee'.repeat(32), first.seedCommitment), false);
});

test('opening deal gives dealer 14, other players 13 and leaves 91 tiles', () => {
  const wall = createSusongShuffledWall({ seed });
  const dealt = dealSusongOpeningHands({ wall, playerIds: players, dealerId: 'C' });
  assert.deepEqual(dealt.handCountsByPlayer, { A: 13, B: 13, C: 14, D: 13 });
  assert.equal(dealt.wallRemaining, 91);
  const allDealt = players.flatMap(playerId => dealt.handsByPlayer[playerId]);
  assert.equal(allDealt.length, 53);
  assert.equal(new Set([...allDealt, ...dealt.remainingWall]).size, 144);
  assert.deepEqual([...allDealt, ...dealt.remainingWall].sort(), [...wall.tileIds].sort());
});

test('public wall state exposes counts and commitment but no secret material', () => {
  const wall = createSusongShuffledWall({ seed });
  const dealt = dealSusongOpeningHands({ wall, playerIds: players, dealerId: 'A' });
  const publicState = publicSusongWallState(dealt);
  const serialized = JSON.stringify(publicState);
  assert.equal(publicState.wallRemaining, 91);
  assert.deepEqual(publicState.handCountsByPlayer, { A: 14, B: 13, C: 13, D: 13 });
  assert.equal(serialized.includes(seed), false);
  assert.equal(serialized.includes('privateSeedHex'), false);
  assert.equal(serialized.includes('tileIds'), false);
  assert.equal(serialized.includes('handsByPlayer'), false);
  assert.equal(serialized.includes('remainingWall'), false);
});

test('wall and player validation rejects malformed authority input', () => {
  const wall = createSusongShuffledWall({ seed });
  assert.throws(
    () => dealSusongOpeningHands({ wall, playerIds: ['A', 'B', 'C', 'C'], dealerId: 'A' }),
    /four unique/
  );
  assert.throws(
    () => dealSusongOpeningHands({ wall, playerIds: players, dealerId: 'X' }),
    /dealerId/
  );
});
