import test from 'node:test';
import assert from 'node:assert/strict';
import { assertProductionSafe, parseEnv } from '../src/config/index.js';
import { AppError, ERROR_CODES, ERROR_REGISTRY, getErrorDefinition, toErrorPayload } from '../src/shared/errors.js';
import { moduleDefinitions, moduleNames } from '../src/modules/index.js';

test('module registry exposes the eleven BE-101 boundaries', () => {
  assert.deepEqual(moduleNames, ['auth', 'lobby', 'club', 'floor', 'room', 'realtime', 'game', 'ledger', 'history', 'support', 'admin']);
  assert.equal(Object.isFrozen(moduleDefinitions), true);
  assert.equal(moduleDefinitions.room.status, 'skeleton');
  assert.match(moduleDefinitions.game.boundary, /rule/i);
});

test('environment schema applies safe defaults and coerces supported values', () => {
  const config = parseEnv({
    NODE_ENV: 'test',
    PORT: '9000',
    FEATURE_REAL_RULES: 'true',
    FEATURE_REAL_DIAMONDS: 'off'
  });
  assert.equal(config.PORT, 9000);
  assert.equal(config.FEATURE_REAL_RULES, true);
  assert.equal(config.FEATURE_REAL_DIAMONDS, false);
  assert.equal(config.WS_MAX_PAYLOAD_BYTES, 65536);
  assert.equal(config.WS_RATE_LIMIT_PER_MINUTE, 120);
  assert.equal(config.ALLOWED_ORIGINS, '');
  assert.equal(config.featureFlags.realRules, true);
  assert.equal(Object.isFrozen(config), true);
});

test('environment schema rejects invalid values and unsafe heartbeat timing', () => {
  assert.throws(
    () => parseEnv({ PORT: 'not-a-port' }),
    error => error instanceof AppError && error.code === ERROR_CODES.CONFIG_INVALID
  );
  assert.throws(
    () => parseEnv({ WS_HEARTBEAT_INTERVAL_MS: '5000', WS_HEARTBEAT_TIMEOUT_MS: '5000' }),
    error => error instanceof AppError && error.code === 'CONFIG_INVALID'
  );
});

test('production safety remains fail-closed until real services are wired', () => {
  const development = parseEnv({ NODE_ENV: 'development' });
  assert.doesNotThrow(() => assertProductionSafe(development));
  const production = parseEnv({
    NODE_ENV: 'production',
    AUTH_MODE: 'stub',
    FEATURE_REAL_RULES: 'false',
    FEATURE_REAL_DIAMONDS: 'false'
  });
  assert.throws(() => assertProductionSafe(production), error => error.code === 'CONFIG_INVALID');
});

test('error registry is immutable and transport payload is stable', () => {
  assert.equal(Object.isFrozen(ERROR_REGISTRY), true);
  assert.equal(getErrorDefinition('NOT_A_CODE').code, 'INTERNAL_ERROR');
  const error = new AppError('VERSION_CONFLICT');
  assert.deepEqual(toErrorPayload(error, 'req-1'), {
    requestId: 'req-1',
    error: { code: 'VERSION_CONFLICT', message: 'State version is stale', retryable: true }
  });
});
