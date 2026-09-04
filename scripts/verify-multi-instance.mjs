import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { Room } from '../src/domain/room.js';
import { RoomActor } from '../src/domain/room-actor.js';
import { PostgresGameEventStore } from '../src/infra/persistence/postgres.js';
import { RedisFencingLock } from '../src/infra/redis/fencing-lock.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const migrationsDirectory = join(repositoryRoot, 'db', 'migrations');
const databaseUrl = process.env.DATABASE_URL
  || 'postgresql://susong:susong_dev_only@127.0.0.1:5432/susong';
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const connectTimeoutMs = Number(process.env.VERIFY_CONNECT_TIMEOUT_MS || 1500);

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function adminConnectionString(connectionString) {
  const url = new URL(connectionString);
  url.pathname = '/postgres';
  return url.toString();
}

function unavailable(error) {
  // Do not inspect arbitrary error text for "connect": a failed assertion
  // may contain a snapshot field such as `connected` and must remain a real
  // verification failure. Only classify transport/library errno values (or
  // an explicitly tagged timeout) as an unavailable dependency.
  const code = String(error?.code || error?.errno || '').toUpperCase();
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return true;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return true;
  return error?.dependencyUnavailable === true;
}

function reportSkipped(reason, error) {
  console.log(JSON.stringify({
    status: 'skipped',
    reason,
    message: String(error?.message || error || 'dependency is unavailable'),
    hint: 'start infra/docker-compose.dev.yml or set DATABASE_URL/REDIS_URL'
  }));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

async function applyMigrations(pool) {
  const files = (await readdir(migrationsDirectory))
    .filter(file => file.endsWith('.up.sql'))
    .sort();
  for (const file of files) await pool.query(await readFile(join(migrationsDirectory, file), 'utf8'));
  return files;
}

async function dispatchEventually(actor, command, context, { attempts = 120 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await actor.dispatch(command, context);
    } catch (error) {
      lastError = error;
      // A contender can lose the Redis room lease while another process is
      // committing. Re-send the exact commandId so the eventual attempt is a
      // durable replay rather than a second game operation.
      if (!new Set([
        'LOCK_BUSY',
        'LOCK_NOT_HELD',
        'LOCK_EXPIRED',
        'FENCING_TOKEN_STALE',
        'CONFLICT',
        'VERSION_CONFLICT'
      ]).has(error?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  throw lastError || new Error('command retry budget exhausted');
}

async function verifyMultiInstance(targetUrl) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const roomId = `verify-multi-${suffix}`;
  const prefix = `verify-multi:${suffix}:`;
  const poolA = new Pool({ connectionString: targetUrl, connectionTimeoutMillis: connectTimeoutMs });
  const poolB = new Pool({ connectionString: targetUrl, connectionTimeoutMillis: connectTimeoutMs });
  const redisA = createClient({ url: redisUrl, socket: { connectTimeout: connectTimeoutMs } });
  const redisB = createClient({ url: redisUrl, socket: { connectTimeout: connectTimeoutMs } });
  let lockA;
  let lockB;
  try {
    await Promise.all([redisA.connect(), redisB.connect()]);
    lockA = new RedisFencingLock({
      client: redisA,
      prefix: `${prefix}lock:`,
      fencePrefix: `${prefix}fence:`,
      leaseMs: 5000
    });
    lockB = new RedisFencingLock({
      client: redisB,
      prefix: `${prefix}lock:`,
      fencePrefix: `${prefix}fence:`,
      leaseMs: 5000
    });
    const storeA = new PostgresGameEventStore({ pool: poolA, lock: lockA });
    const storeB = new PostgresGameEventStore({ pool: poolB, lock: lockB });

    const room = new Room({
      id: roomId,
      maxPlayers: 8,
      matchId: `match-${suffix}`,
      idFactory: randomUUID
    });
    const initialSnapshot = room.snapshot();
    const bootstrap = await lockA.acquire(roomId, { ownerId: `bootstrap-${suffix}` });
    await storeA.saveSnapshot({
      roomId,
      roomVersion: 0,
      snapshot: initialSnapshot,
      fencingToken: bootstrap.fencingToken
    });
    await lockA.release(roomId, bootstrap.fencingToken);

    const actorA = new RoomActor({
      roomId,
      room: Room.fromSnapshot(initialSnapshot, { idFactory: randomUUID }),
      eventStore: storeA,
      lock: lockA,
      actorId: `instance-a-${suffix}`,
      idFactory: randomUUID
    });
    const actorB = new RoomActor({
      roomId,
      eventStore: storeB,
      lock: lockB,
      roomFactory: ({ snapshot }) => snapshot
        ? Room.fromSnapshot(snapshot, { idFactory: randomUUID })
        : new Room({ id: roomId, maxPlayers: 8, matchId: `match-${suffix}`, idFactory: randomUUID }),
      actorId: `instance-b-${suffix}`,
      idFactory: randomUUID
    });

    // Two workers receive the same command at the same time (for example,
    // after a reconnect). One append is authoritative; the other replays it.
    const duplicate = {
      type: 'join_room',
      roomId,
      commandId: `cmd-${suffix}-p1`,
      requestId: `request-${suffix}-p1`,
      payload: { playerId: 'p1', name: 'P1', seat: 0 }
    };
    const [duplicateA, duplicateB] = await Promise.all([
      dispatchEventually(actorA, duplicate, { actorId: 'p1' }),
      dispatchEventually(actorB, duplicate, { actorId: 'p1' })
    ]);
    assert(canonical(duplicateA) === canonical(duplicateB), `duplicate command ACKs differ: A=${JSON.stringify(duplicateA)} B=${JSON.stringify(duplicateB)}`);

    // Fan out unique commands to both instances. Every operation uses a
    // stable commandId and retries only lease/version races.
    const joins = Array.from({ length: 7 }, (_, index) => {
      const playerId = `p${index + 2}`;
      const command = {
        type: 'join_room',
        roomId,
        commandId: `cmd-${suffix}-${playerId}`,
        payload: { playerId, name: playerId.toUpperCase(), seat: index + 1 }
      };
      return dispatchEventually(index % 2 === 0 ? actorA : actorB, command, { actorId: playerId });
    });
    await Promise.all(joins);

    const readyCommands = Array.from({ length: 8 }, (_, index) => {
      const playerId = `p${index + 1}`;
      const command = {
        type: 'ready',
        roomId,
        commandId: `cmd-${suffix}-ready-${playerId}`,
        payload: { playerId, ready: true }
      };
      return dispatchEventually(index % 2 === 0 ? actorA : actorB, command, { actorId: playerId });
    });
    await Promise.all(readyCommands);

    const start = {
      type: 'start_round',
      roomId,
      commandId: `cmd-${suffix}-start`,
      payload: { roundId: `round-${suffix}`, autoAdvance: true }
    };
    await Promise.all([
      dispatchEventually(actorA, start, { actorId: 'p1' }),
      dispatchEventually(actorB, start, { actorId: 'p1' })
    ]);

    await Promise.all([actorA.recover(), actorB.recover()]);
    const snapshotA = actorA.snapshot();
    const snapshotB = actorB.snapshot();
    const latestVersion = await storeA.getLatestVersion(roomId);
    const events = await storeA.getEvents(roomId, { afterVersion: 0 });
    const durableSnapshot = await storeA.getSnapshot(roomId);
    const outboxCount = Number((await poolA.query(
      'SELECT COUNT(*) AS count FROM outbox_messages WHERE room_id = $1',
      [roomId]
    )).rows[0]?.count || 0);
    assert(snapshotA.roomVersion === latestVersion, 'actor A cursor is stale');
    assert(snapshotB.roomVersion === latestVersion, 'actor B cursor is stale');
    assert(snapshotA.snapshotHash === snapshotB.snapshotHash, 'final snapshotHash differs between instances');
    assert(snapshotA.snapshotHash === durableSnapshot.snapshotHash, 'durable snapshotHash differs from actors');
    assert(events.length === latestVersion, 'event stream has a gap or duplicate version');
    assert(events.every((event, index) => event.roomVersion === index + 1), 'event versions are not contiguous');
    assert(outboxCount === events.length, 'outbox does not contain one row per event');

    await Promise.all([actorA.close(), actorB.close()]);
    return {
      roomId,
      roomVersion: latestVersion,
      eventCount: events.length,
      outboxCount,
      snapshotHash: snapshotA.snapshotHash
    };
  } finally {
    await poolA.query('DELETE FROM game_command_results WHERE room_id = $1', [roomId]).catch(() => {});
    await poolA.query('DELETE FROM outbox_messages WHERE room_id = $1', [roomId]).catch(() => {});
    await poolA.query('DELETE FROM game_snapshots WHERE room_id = $1', [roomId]).catch(() => {});
    await poolA.query('DELETE FROM game_events WHERE room_id = $1', [roomId]).catch(() => {});
    await poolA.end().catch(() => {});
    await poolB.end().catch(() => {});
    await redisA.del(`${prefix}lock:${roomId}`, `${prefix}fence:${roomId}`).catch(() => {});
    await redisB.del(`${prefix}lock:${roomId}`, `${prefix}fence:${roomId}`).catch(() => {});
    await redisA.quit().catch(() => {});
    await redisB.quit().catch(() => {});
  }
}

let adminPool;
let targetPool;
let temporaryDatabase;
try {
  // Probe both dependencies first so a developer without Docker gets a
  // successful, explicit skip instead of a long stack trace.
  const probePool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: connectTimeoutMs });
  try {
    await probePool.query('SELECT 1');
  } catch (error) {
    if (unavailable(error)) {
      reportSkipped('postgres_unavailable', error);
      process.exitCode = 0;
    } else {
      throw error;
    }
  } finally {
    await probePool.end().catch(() => {});
  }
  if (process.exitCode === 0) process.exit(0);

  const probeRedis = createClient({ url: redisUrl, socket: { connectTimeout: connectTimeoutMs } });
  try {
    await probeRedis.connect();
    await probeRedis.ping();
  } catch (error) {
    if (unavailable(error)) {
      reportSkipped('redis_unavailable', error);
      process.exitCode = 0;
      process.exit(0);
    }
    throw error;
  } finally {
    await probeRedis.quit().catch(() => {});
  }

  temporaryDatabase = `susong_multi_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  adminPool = new Pool({ connectionString: adminConnectionString(databaseUrl), connectionTimeoutMillis: connectTimeoutMs });
  await adminPool.query(`CREATE DATABASE ${quoteIdentifier(temporaryDatabase)}`);
  const targetUrl = new URL(databaseUrl);
  targetUrl.pathname = `/${temporaryDatabase}`;
  targetPool = new Pool({ connectionString: targetUrl.toString(), connectionTimeoutMillis: connectTimeoutMs });
  const migrations = await applyMigrations(targetPool);
  const result = await verifyMultiInstance(targetUrl.toString());
  console.log(JSON.stringify({ status: 'ok', migrations: migrations.length, ...result }));
} catch (error) {
  if (unavailable(error)) {
    reportSkipped('dependency_unavailable', error);
    process.exitCode = 0;
  } else {
    console.error(JSON.stringify({ status: 'failed', message: String(error?.stack || error) }));
    process.exitCode = 1;
  }
} finally {
  await targetPool?.end().catch(() => {});
  if (adminPool && temporaryDatabase) {
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(temporaryDatabase)}`).catch(error => {
      console.error(`failed to drop verification database ${temporaryDatabase}: ${error.message}`);
    });
  }
  await adminPool?.end().catch(() => {});
}
