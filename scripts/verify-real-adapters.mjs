import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { Room } from '../src/domain/room.js';
import { RoomActor } from '../src/domain/room-actor.js';
import {
  DEADLINE_STATUS,
  PostgresDeadlineStore
} from '../src/infra/persistence/deadline-store.js';
import { PostgresGameEventStore } from '../src/infra/persistence/postgres.js';
import { RedisFencingLock } from '../src/infra/redis/fencing-lock.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const migrationsDirectory = join(repositoryRoot, 'db', 'migrations');
const databaseUrl = process.env.DATABASE_URL
  || 'postgresql://susong:susong_dev_only@127.0.0.1:5432/susong';
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function adminConnectionString(connectionString) {
  const url = new URL(connectionString);
  url.pathname = '/postgres';
  return url.toString();
}

async function applyMigrations(pool) {
  const files = (await readdir(migrationsDirectory))
    .filter(file => file.endsWith('.up.sql'))
    .sort();
  for (const file of files) {
    await pool.query(await readFile(join(migrationsDirectory, file), 'utf8'));
  }
  return files;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function verifyDeadlineStore(pool) {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const storeA = new PostgresDeadlineStore({ pool, clock: () => now });
  const storeB = new PostgresDeadlineStore({ pool, clock: () => now });
  const deadlineId = `verify-deadline-${randomUUID()}`;
  await storeA.upsert({
    deadlineId,
    roomId: 'verify-room',
    commandId: `verify-command-${randomUUID()}`,
    deadlineAt: new Date(now).toISOString(),
    expectedRoomVersion: 7,
    roundId: 'round-1',
    playerId: 'p1',
    timeoutAction: { type: 'action', action: 'pass' }
  });
  const futureId = `verify-future-${randomUUID()}`;
  await storeA.upsert({
    deadlineId: futureId,
    roomId: 'verify-room',
    commandId: `verify-command-${randomUUID()}`,
    deadlineAt: new Date(now + 100).toISOString(),
    timeoutAction: 'pass'
  });
  const notDue = await storeB.claim(futureId, { ownerId: 'worker-a', now: now + 99, leaseMs: 1000 });
  assert(!notDue.claimed && notDue.reason === 'NOT_DUE', 'future deadline was claimed before due time');

  const [claimA, claimB] = await Promise.all([
    storeA.claim(deadlineId, { ownerId: 'worker-a', now, leaseMs: 100 }),
    storeB.claim(deadlineId, { ownerId: 'worker-b', now, leaseMs: 100 })
  ]);
  assert([claimA, claimB].filter(result => result.claimed).length === 1, 'concurrent deadline claim did not elect one worker');
  const first = claimA.claimed ? claimA : claimB;
  const held = claimA.claimed ? claimB : claimA;
  const winnerStore = claimA.claimed ? storeA : storeB;
  const winnerOwner = claimA.claimed ? 'worker-a' : 'worker-b';
  const takeoverStore = claimA.claimed ? storeB : storeA;
  const takeoverOwner = claimA.claimed ? 'worker-b' : 'worker-a';
  assert(held.reason === 'LEASE_HELD', 'second deadline worker stole a live lease');
  const takeover = await takeoverStore.claim(deadlineId, { ownerId: takeoverOwner, now: now + 100, leaseMs: 100 });
  assert(takeover.claimed && takeover.leaseToken > first.leaseToken, 'expired deadline lease was not reclaimed');
  let staleRejected = false;
  try {
    await winnerStore.complete(deadlineId, {
      ownerId: winnerOwner,
      leaseToken: first.leaseToken,
      status: DEADLINE_STATUS.EXECUTED
    });
  } catch (error) {
    staleRejected = error.code === 'FENCING_TOKEN_STALE';
  }
  assert(staleRejected, 'stale deadline completion was accepted');
  const completed = await takeoverStore.complete(deadlineId, {
    ownerId: takeoverOwner,
    leaseToken: takeover.leaseToken,
    status: DEADLINE_STATUS.EXECUTED,
    result: { roomVersion: 8 }
  });
  assert(completed.status === DEADLINE_STATUS.EXECUTED, 'deadline completion did not persist');
  const replay = await storeA.claim(deadlineId, { ownerId: 'worker-c', now: now + 200, leaseMs: 100 });
  assert(!replay.claimed && replay.reason === 'TERMINAL', 'terminal deadline was claimed again');
  await pool.query('DELETE FROM game_deadlines WHERE deadline_id = ANY($1::text[])', [[deadlineId, futureId]]);
  return { status: completed.status, attempts: completed.attempts };
}

async function verifyEventRecovery(pool) {
  const roomId = `verify-room-${randomUUID()}`;
  const eventStore = new PostgresGameEventStore({ pool, idFactory: randomUUID });
  const initialRoom = new Room({ id: roomId, maxPlayers: 4, idFactory: randomUUID });
  const initialSnapshot = initialRoom.snapshot();
  await eventStore.saveSnapshot({ roomId, roomVersion: 0, snapshot: initialSnapshot });

  const actorA = new RoomActor({
    roomId,
    room: Room.fromSnapshot(initialSnapshot, { idFactory: randomUUID }),
    eventStore,
    idFactory: randomUUID
  });
  const joined = await actorA.dispatch({
    type: 'join_room',
    commandId: `verify-join-${randomUUID()}`,
    requestId: `verify-request-${randomUUID()}`,
    payload: { playerId: 'p1', name: 'P1' }
  }, { actorId: 'p1' });
  assert(joined.roomVersion === 1, 'event actor did not append room version 1');

  const actorB = new RoomActor({
    roomId,
    eventStore,
    roomFactory: ({ snapshot }) => snapshot
      ? Room.fromSnapshot(snapshot, { idFactory: randomUUID })
      : new Room({ id: roomId, idFactory: randomUUID }),
    idFactory: randomUUID
  });
  await actorB.recover();
  assert(actorA.snapshot().snapshotHash === actorB.snapshot().snapshotHash, 'recovered actor snapshot hash differs');

  await actorA.dispatch({
    type: 'disconnect',
    commandId: `verify-disconnect-${randomUUID()}`,
    payload: { playerId: 'p1' }
  }, { actorId: 'p1' });
  await actorB.recover();
  assert(actorA.snapshot().snapshotHash === actorB.snapshot().snapshotHash, 'presence overlay recovery hash differs');
  assert(actorB.snapshot().players[0].connected === false, 'presence overlay did not restore disconnected player');

  const latestVersion = await eventStore.getLatestVersion(roomId);
  const events = await eventStore.getEvents(roomId, { afterVersion: 0 });
  const snapshot = await eventStore.getSnapshot(roomId);
  assert(latestVersion === 1 && events.length === 1 && snapshot.roomVersion === 1, 'event stream inventory is inconsistent');
  return { roomId, roomVersion: latestVersion, eventCount: events.length, snapshotHash: snapshot.snapshotHash };
}

async function verifyRedisLock(redisClient) {
  const suffix = randomUUID();
  const lock = new RedisFencingLock({
    client: redisClient,
    prefix: `verify:${suffix}:lock:`,
    fencePrefix: `verify:${suffix}:fence:`,
    leaseMs: 1000
  });
  const first = await lock.acquire('room-1', { ownerId: 'actor-a' });
  let busy = false;
  try {
    await lock.acquire('room-1', { ownerId: 'actor-b' });
  } catch (error) {
    busy = error.code === 'LOCK_BUSY';
  }
  assert(busy, 'Redis lock allowed two owners simultaneously');
  assert(await lock.release('room-1', first.fencingToken), 'Redis lock release failed');
  const second = await lock.acquire('room-1', { ownerId: 'actor-b' });
  assert(second.fencingToken > first.fencingToken, 'Redis fencing token did not increase');
  await lock.release('room-1', second.fencingToken);
  await redisClient.del(`${lock.prefix}room-1`, `${lock.fencePrefix}room-1`);
  return { fencingTokens: [first.fencingToken, second.fencingToken] };
}

const verificationDatabase = `susong_verify_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
const adminPool = new Pool({ connectionString: adminConnectionString(databaseUrl) });
let targetPool;
let redisClient;
try {
  await adminPool.query(`CREATE DATABASE ${quoteIdentifier(verificationDatabase)}`);
  const targetUrl = new URL(databaseUrl);
  targetUrl.pathname = `/${verificationDatabase}`;
  targetPool = new Pool({ connectionString: targetUrl.toString() });
  const migrations = await applyMigrations(targetPool);
  redisClient = createClient({ url: redisUrl });
  await redisClient.connect();
  const [deadlines, recovery, redis] = await Promise.all([
    verifyDeadlineStore(targetPool),
    verifyEventRecovery(targetPool),
    verifyRedisLock(redisClient)
  ]);
  console.log(JSON.stringify({
    status: 'ok',
    database: verificationDatabase,
    migrations: migrations.length,
    deadlines,
    recovery,
    redis
  }));
} finally {
  await redisClient?.quit().catch(() => {});
  await targetPool?.end().catch(() => {});
  await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(verificationDatabase)}`).catch(error => {
    console.error(`failed to drop verification database ${verificationDatabase}: ${error.message}`);
  });
  await adminPool.end();
}
