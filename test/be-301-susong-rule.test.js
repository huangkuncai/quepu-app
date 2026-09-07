import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SUSONG_DEFAULT_CONFIG,
  classifySusongHu,
  flowerAwardScore,
  flowerUnitsForMeld,
  normalizeSusongConfig,
  susongRule,
  toLegacy8931Config
} from '../src/domain/rules/susong.js';
import { RoomService } from '../src/modules/room/service.js';

test('8931 room options normalize to an immutable semantic snapshot', () => {
  assert.deepEqual(normalizeSusongConfig(), SUSONG_DEFAULT_CONFIG);
  const config = normalizeSusongConfig({ times: 16, branch: '2469', zun: 5, piao: 2, hu: 1 });
  assert.deepEqual(config, { rounds: 16, scoreTiers: [2, 4, 6, 9], zeng: 5, piao: 'strong', forcedHu: true });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.scoreTiers), true);
  assert.deepEqual(toLegacy8931Config(config), { times: 16, branch: '2469', zun: 5, piao: 2, hu: 1, maxPlayerNum: 4 });
});

test('8931 room options reject values the reference client cannot create', () => {
  assert.throws(() => normalizeSusongConfig({ rounds: 12 }), /rounds/);
  assert.throws(() => normalizeSusongConfig({ scoreTiers: [1, 2, 3] }), /exactly four/);
  assert.throws(() => normalizeSusongConfig({ scoreTiers: [1, 2, 2, 4] }), /unique/);
  assert.throws(() => normalizeSusongConfig({ scoreTiers: [4, 3, 2, 1] }), /increasing/);
  assert.throws(() => normalizeSusongConfig({ zeng: 4 }), /zeng/);
  assert.throws(() => normalizeSusongConfig({ piao: 0 }), /piao/);
});

test('flower boundaries and special wins match the embedded 8931 rule sheet', () => {
  assert.equal(classifySusongHu({ flowerCount: 1 }), 'small');
  assert.equal(classifySusongHu({ flowerCount: 4 }), 'small');
  assert.equal(classifySusongHu({ flowerCount: 5 }), 'big');
  assert.equal(classifySusongHu({ flowerCount: 9 }), 'big');
  assert.equal(classifySusongHu({ flowerCount: 10 }), 'double_big');
  assert.equal(classifySusongHu({ flowerCount: 0 }), 'one_bamboo');
  assert.equal(classifySusongHu({ flowerCount: 3, patterns: ['seven_pairs'] }), 'one_bamboo');
});

test('kong win and wind meld flower units use the 8931 thresholds', () => {
  assert.equal(classifySusongHu({ flowerCount: 1, gangWinCount: 1 }), 'big');
  assert.equal(classifySusongHu({ flowerCount: 4, gangWinCount: 1 }), 'double_big');
  assert.equal(classifySusongHu({ flowerCount: 6, gangWinCount: 1 }), 'one_bamboo');
  assert.equal(classifySusongHu({ flowerCount: 1, gangWinCount: 2 }), 'one_bamboo');
  assert.equal(flowerUnitsForMeld({ kind: 'triplet', isWind: true }), 1);
  assert.equal(flowerUnitsForMeld({ kind: 'exposed_kong', isWind: true }), 2);
  assert.equal(flowerUnitsForMeld({ kind: 'concealed_kong', isWind: true }), 3);
  assert.equal(flowerUnitsForMeld({ kind: 'concealed_kong' }), 2);
});

test('flower award uses second selected score and is cancelled by discard win or draw', () => {
  const config = { scoreTiers: [2, 4, 6, 8] };
  assert.equal(flowerAwardScore(config), 4);
  assert.equal(flowerAwardScore(config, { wonByDiscard: true }), 0);
  assert.equal(flowerAwardScore(config, { draw: true }), 0);
  assert.equal(susongRule.settlement.drawAtRemainingTiles, 14);
  assert.equal(susongRule.settlement.multipleDiscardWinners, true);
});

test('room creation freezes normalized 8931 config instead of accepting client scoring rules', async () => {
  const actors = new Map();
  const registry = {
    dispatch() {},
    findCommandResult: async () => null,
    register(room, id) { actors.set(id, { room, version: room.version }); },
    initialize: async () => {},
    delete(id) { actors.delete(id); },
    get(id) { return actors.get(id); },
    recover: async id => actors.get(id)
  };
  const service = new RoomService({ registry, idFactory: () => '8931-room' });
  const created = await service.createRoom({
    principal: { userId: 'owner-1' },
    commandId: '08d62d0d-d80e-4a62-bc4b-f56f3baa90c4',
    payload: { ruleId: 'susong_v1', ruleConfig: { times: 8, branch: '1359', zun: 3, piao: 2, hu: 1 } }
  });
  assert.equal(created.room.maxPlayers, 4);
  assert.equal(created.room.totalRounds, 8);
  assert.equal(created.room.ruleVersion, '8931-apk-baseline.1');
  assert.deepEqual(created.room.ruleSnapshot.config, {
    rounds: 8,
    scoreTiers: [1, 3, 5, 9],
    zeng: 3,
    piao: 'strong',
    forcedHu: true
  });
  await assert.rejects(
    service.createRoom({
      principal: { userId: 'owner-1' },
      commandId: '2e7e7b5e-862f-4eac-a43f-7a0b01d16e5f',
      payload: { ruleId: 'susong_v1', ruleConfig: { branch: '1111' } }
    }),
    error => error.code === 'INVALID_ACTION' && error.details[0].path === 'ruleConfig'
  );
});
