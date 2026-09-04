import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REPOSITORY_CONTRACT_VERSION,
  REPOSITORY_METHODS,
  RepositoryError,
  assertRepository,
  createMemoryRepository
} from '../src/infra/persistence/index.js';
import { checkRedisHealth } from '../src/infra/redis/index.js';

function fixture() {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const repository = createMemoryRepository({ clock: () => now, idFactory: () => 'generated-id' });
  return {
    repository,
    advance(ms) { now += ms; },
    iso() { return new Date(now).toISOString(); }
  };
}

test('memory repository advertises the BE-104 contract and isolates returned values', () => {
  const { repository } = fixture();
  assert.equal(REPOSITORY_CONTRACT_VERSION, '1.0');
  assert.doesNotThrow(() => assertRepository(repository));
  for (const method of REPOSITORY_METHODS) assert.equal(typeof repository[method], 'function');

  const user = repository.createUser({ id: 'user-1', displayName: 'One' });
  assert.equal(Object.isFrozen(user), true);
  assert.throws(() => { user.displayName = 'mutated'; }, TypeError);
  assert.equal(repository.findUserById('user-1').displayName, 'One');
});

test('users, devices and sessions enforce ownership and unique token hashes', () => {
  const { repository, iso } = fixture();
  repository.createUser({ id: 'user-1', phoneE164: '+8613800000000', displayName: 'One' });
  assert.throws(
    () => repository.createUser({ id: 'user-2', phoneE164: '+8613800000000', displayName: 'Two' }),
    error => error instanceof RepositoryError && error.code === 'UNIQUE_VIOLATION'
  );
  repository.upsertDevice({ id: 'device-1', userId: 'user-1', platform: 'android' });
  assert.throws(
    () => repository.upsertDevice({ id: 'device-2', userId: 'missing', platform: 'ios' }),
    error => error instanceof RepositoryError && error.code === 'NOT_FOUND'
  );
  repository.createSession({
    id: 'session-1',
    userId: 'user-1',
    deviceId: 'device-1',
    accessTokenHash: 'access-hash-1',
    refreshTokenHash: 'refresh-hash-1',
    expiresAt: new Date(Date.parse(iso()) + 60_000).toISOString()
  });
  assert.equal(repository.findSessionByAccessTokenHash('access-hash-1').id, 'session-1');
  assert.equal(repository.findSessionByRefreshTokenHash('refresh-hash-1').id, 'session-1');
  assert.throws(
    () => repository.createSession({
      id: 'session-2',
      userId: 'user-1',
      deviceId: 'device-1',
      accessTokenHash: 'access-hash-1',
      refreshTokenHash: 'refresh-hash-2',
      expiresAt: new Date(Date.parse(iso()) + 60_000).toISOString()
    }),
    error => error.code === 'UNIQUE_VIOLATION'
  );
  assert.equal(repository.revokeSession('session-1').status, 'REVOKED');
  assert.throws(() => repository.touchSession('session-1'), error => error.code === 'CONFLICT');
});

test('required expiry timestamps reject missing values before consulting the clock', () => {
  let clockCalls = 0;
  const repository = createMemoryRepository({
    clock: () => {
      clockCalls += 1;
      throw new Error('clock should not be called for a missing required value');
    }
  });
  repository.createUser({ id: 'user-1', displayName: 'One', createdAt: '2026-01-01T00:00:00.000Z' });
  repository.upsertDevice({ id: 'device-1', userId: 'user-1', platform: 'android', lastSeenAt: '2026-01-01T00:00:00.000Z' });

  assert.throws(
    () => repository.createSession({
      id: 'session-1', userId: 'user-1', deviceId: 'device-1',
      accessTokenHash: 'access-hash-1', refreshTokenHash: 'refresh-hash-1'
    }),
    error => error instanceof RepositoryError && error.code === 'VALIDATION_ERROR' && /expiresAt is required/.test(error.message)
  );
  assert.throws(
    () => repository.claimIdempotencyKey({ scope: 'user-1:op', key: 'command-1', requestHash: 'hash-1' }),
    error => error instanceof RepositoryError && error.code === 'VALIDATION_ERROR' && /expiresAt is required/.test(error.message)
  );
  assert.equal(clockCalls, 0);
});

test('invalid timestamps return validation errors and clock failures are not swallowed', () => {
  const repository = createMemoryRepository({ clock: () => Date.parse('2026-01-01T00:00:00.000Z') });
  repository.createUser({ id: 'user-1', displayName: 'One' });
  repository.upsertDevice({ id: 'device-1', userId: 'user-1', platform: 'ios' });
  assert.throws(
    () => repository.createSession({
      id: 'session-1', userId: 'user-1', deviceId: 'device-1',
      accessTokenHash: 'access-hash-1', refreshTokenHash: 'refresh-hash-1', expiresAt: 'not-a-date'
    }),
    error => error instanceof RepositoryError && error.code === 'VALIDATION_ERROR' && /expiresAt/.test(error.message)
  );
  assert.throws(
    () => repository.claimIdempotencyKey({
      scope: 'user-1:op', key: 'command-1', requestHash: 'hash-1', expiresAt: 'not-a-date'
    }),
    error => error instanceof RepositoryError && error.code === 'VALIDATION_ERROR' && /expiresAt/.test(error.message)
  );

  const clockError = new Error('clock unavailable');
  const brokenClock = createMemoryRepository({ clock: () => { throw clockError; } });
  assert.throws(
    () => brokenClock.createUser({ id: 'user-1', displayName: 'One' }),
    error => error === clockError
  );
  assert.equal(brokenClock.findUserById('user-1'), null);
});

test('idempotency claims are replay-safe, hash-bound and expire deterministically', () => {
  const { repository, advance, iso } = fixture();
  const expiresAt = new Date(Date.parse(iso()) + 10_000).toISOString();
  const first = repository.claimIdempotencyKey({
    scope: 'user-1:create-room', key: 'command-1', requestHash: 'hash-1', expiresAt
  });
  assert.equal(first.claimed, true);
  const replay = repository.claimIdempotencyKey({
    scope: 'user-1:create-room', key: 'command-1', requestHash: 'hash-1', expiresAt
  });
  assert.equal(replay.claimed, false);
  assert.throws(
    () => repository.claimIdempotencyKey({
      scope: 'user-1:create-room', key: 'command-1', requestHash: 'different', expiresAt
    }),
    error => error.code === 'IDEMPOTENCY_CONFLICT'
  );
  repository.completeIdempotencyKey({
    scope: 'user-1:create-room', key: 'command-1', response: { roomId: 'room-1' }, responseStatus: 201
  });
  assert.deepEqual(repository.getIdempotencyKey({ scope: 'user-1:create-room', key: 'command-1' }).response, { roomId: 'room-1' });
  advance(11_000);
  assert.equal(repository.getIdempotencyKey({ scope: 'user-1:create-room', key: 'command-1' }), null);
  assert.equal(repository.purgeExpiredIdempotencyKeys(), 0);
});

test('audit records are append-only from the repository API and can be filtered', () => {
  const { repository } = fixture();
  repository.createUser({ id: 'user-1', displayName: 'One' });
  const entry = repository.appendAuditLog({
    actorUserId: 'user-1',
    action: 'ROOM_CREATED',
    resourceType: 'room',
    resourceId: 'room-1',
    metadata: { source: 'test' }
  });
  assert.equal(entry.id, 1);
  assert.throws(() => { entry.metadata.source = 'changed'; }, TypeError);
  assert.equal(repository.listAuditLogs({ resourceType: 'room' })[0].metadata.source, 'test');
  assert.throws(
    () => repository.appendAuditLog({ actorUserId: 'missing', action: 'X', resourceType: 'room' }),
    error => error.code === 'NOT_FOUND'
  );
});

test('redis health reports PONG, unavailable clients and timeout without throwing', async () => {
  assert.deepEqual(await checkRedisHealth({ ping: async () => 'PONG' }), {
    status: 'ok', backend: 'redis', response: 'PONG'
  });
  assert.equal((await checkRedisHealth(null)).status, 'unconfigured');
  assert.equal((await checkRedisHealth({ ping: async () => { throw new Error('connection refused'); } })).status, 'unavailable');
  const result = await checkRedisHealth({ ping: () => new Promise(() => {}) }, { timeoutMs: 5 });
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /timed out/);
});
