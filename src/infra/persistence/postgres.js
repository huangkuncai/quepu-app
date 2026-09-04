import { createHash, randomUUID } from 'node:crypto';
import { RepositoryError, assertRepository } from './contracts.js';
import { assertGameEventStore } from './game-memory.js';
import { PostgresDeadlineStore, assertDeadlineStore } from './deadline-store.js';
import { createRedisClient, RedisFencingLock } from '../redis/fencing-lock.js';

function clone(value) {
  return value === undefined || value === null ? value : structuredClone(value);
}

function output(value) {
  return clone(value);
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function snapshotValue(input, roomId, roomVersion) {
  const value = clone(input || {});
  value.roomId ??= roomId;
  value.roomVersion ??= roomVersion;
  value.version ??= roomVersion;
  if (!value.snapshotHash) value.snapshotHash = createHash('sha256').update(canonical(value)).digest('hex');
  return value;
}

function required(value, field) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new RepositoryError('VALIDATION_ERROR', `${field} is required`);
  }
  return String(value).trim();
}

function positiveVersion(value, field = 'roomVersion', allowZero = false) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1)) {
    throw new RepositoryError('VALIDATION_ERROR', `${field} must be an integer`);
  }
  return number;
}

function isoTimestamp(value, field) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RepositoryError('VALIDATION_ERROR', `${field} must be a valid timestamp`);
  return date.toISOString();
}

function normalizePresence(input) {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new RepositoryError('VALIDATION_ERROR', 'presence must be an object');
  }
  const result = {};
  for (const [playerIdInput, state] of Object.entries(input)) {
    const playerId = required(playerIdInput, 'presence.playerId');
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new RepositoryError('VALIDATION_ERROR', 'presence state must be an object', [{ playerId }]);
    }
    if (typeof state.connected !== 'boolean') {
      throw new RepositoryError('VALIDATION_ERROR', 'presence.connected must be boolean', [{ playerId }]);
    }
    const disconnectedAt = state.disconnectedAt === undefined || state.disconnectedAt === null
      ? null
      : isoTimestamp(state.disconnectedAt, 'presence.disconnectedAt');
    result[playerId] = { connected: state.connected, disconnectedAt };
  }
  return result;
}

function mapError(error) {
  if (error instanceof RepositoryError) return error;
  if (error?.code === '23505') return new RepositoryError('UNIQUE_VIOLATION', error.detail || error.message, error);
  if (error?.code === '23503') return new RepositoryError('NOT_FOUND', error.detail || error.message, error);
  if (error?.code === '40001' || error?.code === '40P01') return new RepositoryError('CONFLICT', error.message, error);
  return error;
}

function eventFromRow(row) {
  const payload = row.payload_json ?? row.payload ?? {};
  const event = payload && typeof payload === 'object' && !Array.isArray(payload) ? clone(payload) : { payload };
  return {
    ...event,
    eventId: row.event_id,
    roomId: row.room_id,
    roomVersion: Number(row.room_version),
    version: Number(row.room_version),
    seq: Number(row.room_version),
    type: event.type || row.event_type,
    payload: event.payload === undefined ? clone(payload) : event.payload,
    ...(row.match_id ? { matchId: row.match_id } : {}),
    ...(row.round_id ? { roundId: row.round_id } : {}),
    ...(row.command_id ? { commandId: row.command_id } : {}),
    ...(row.request_id ? { requestId: row.request_id } : {}),
    ...(row.occurred_at ? { occurredAt: new Date(row.occurred_at).toISOString(), at: new Date(row.occurred_at).toISOString() } : {})
  };
}

function snapshotFromRow(row) {
  if (!row) return null;
  const snapshot = clone(row.snapshot_json ?? row.snapshot ?? {});
  snapshot.roomId ??= row.room_id;
  snapshot.roomVersion ??= Number(row.room_version);
  snapshot.version ??= Number(row.room_version);
  snapshot.snapshotHash ??= row.snapshot_hash;
  return snapshot;
}

function presenceFromRow(row) {
  if (!row) return null;
  return output({
    roomId: row.room_id,
    roomVersion: Number(row.room_version),
    presence: clone(row.presence_json ?? row.presence ?? {}),
    fencingToken: row.fencing_token === null || row.fencing_token === undefined
      ? null
      : Number(row.fencing_token),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  });
}

function mergePresence(snapshot, checkpoint) {
  if (!snapshot || !checkpoint || checkpoint.roomVersion > (snapshot.roomVersion ?? snapshot.version ?? 0)) {
    return snapshot;
  }
  const value = clone(snapshot);
  const states = checkpoint.presence || {};
  const updatePlayer = player => {
    if (!player || typeof player !== 'object') return player;
    const id = player.id ?? player.playerId;
    const state = id === undefined || id === null ? null : states[String(id)];
    if (!state) return player;
    const next = { ...player, connected: state.connected };
    if (state.connected || !state.disconnectedAt) delete next.disconnectedAt;
    else next.disconnectedAt = state.disconnectedAt;
    return next;
  };
  if (Array.isArray(value.players)) value.players = value.players.map(updatePlayer);
  if (Array.isArray(value.seats)) {
    value.seats = value.seats.map(seat => seat?.player
      ? { ...seat, player: updatePlayer(seat.player) }
      : seat);
  }
  if (Array.isArray(value.players)) value.connectedCount = value.players.filter(player => player.connected).length;
  delete value.snapshotHash;
  value.snapshotHash = createHash('sha256').update(canonical(value)).digest('hex');
  return value;
}

/** PostgreSQL adapter for the BE-202/204 game event-store port. */
export class PostgresGameEventStore {
  constructor({ pool, client, outbox, lock, deadlineStore, idFactory = randomUUID } = {}) {
    this.pool = pool || client;
    if (!this.pool || typeof this.pool.query !== 'function') {
      throw new TypeError('PostgresGameEventStore requires a pg-compatible pool/client');
    }
    this.outbox = outbox || new PostgresOutbox({ pool: this.pool, idFactory });
    this.lock = lock || null;
    this.deadlineStore = deadlineStore || new PostgresDeadlineStore({ pool: this.pool });
    this.idFactory = idFactory;
  }

  async _query(executor, text, values = []) {
    try {
      return await executor.query(text, values);
    } catch (error) {
      throw mapError(error);
    }
  }

  async _transaction(callback) {
    if (typeof this.pool.connect !== 'function') {
      throw new RepositoryError('CONFIG_INVALID', 'PostgreSQL writes require a pool with connect()');
    }
    const client = await this.pool.connect();
    try {
      await this._query(client, 'BEGIN');
      const result = await callback(client);
      await this._query(client, 'COMMIT');
      return result;
    } catch (error) {
      try { await this._query(client, 'ROLLBACK'); } catch { /* preserve original error */ }
      throw mapError(error);
    } finally {
      client.release?.();
    }
  }

  async getLatestVersion(roomId) {
    const result = await this._query(this.pool, 'SELECT COALESCE(MAX(room_version), 0) AS room_version FROM game_events WHERE room_id = $1', [required(roomId, 'roomId')]);
    return Number(result.rows[0]?.room_version || 0);
  }

  /**
   * Return every room known to durable storage.  A restarted process has no
   * in-memory room map, so the deadline scheduler and WSS recovery path use
   * this inventory before accepting reconnects or re-arming turn timers.
   * Presence is intentionally excluded: it is an overlay for an existing
   * event/snapshot stream and must not create a room by itself.
   */
  async listRooms() {
    const result = await this._query(
      this.pool,
      `SELECT room_id FROM game_events
       UNION
       SELECT room_id FROM game_snapshots
       ORDER BY room_id ASC`
    );
    return result.rows
      .map(row => row?.room_id)
      .filter(roomId => roomId !== undefined && roomId !== null)
      .map(roomId => String(roomId));
  }

  async getEvents(roomId, { afterVersion = 0, throughVersion, limit = 10000 } = {}) {
    const id = required(roomId, 'roomId');
    const after = positiveVersion(afterVersion, 'afterVersion', true);
    const through = throughVersion === undefined ? 2147483647 : positiveVersion(throughVersion, 'throughVersion', true);
    if (through < after || !Number.isInteger(limit) || limit < 1 || limit > 10000) throw new RepositoryError('VALIDATION_ERROR', 'invalid event range');
    const result = await this._query(this.pool, 'SELECT event_id, room_id, room_version, match_id, round_id, event_type, payload_json, command_id, request_id, occurred_at FROM game_events WHERE room_id = $1 AND room_version > $2 AND room_version <= $3 ORDER BY room_version ASC LIMIT $4', [id, after, through, limit]);
    return result.rows.map(eventFromRow).map(output);
  }

  async getEvent(roomId, roomVersion) {
    const events = await this.getEvents(roomId, { afterVersion: positiveVersion(roomVersion, 'roomVersion') - 1, throughVersion: roomVersion, limit: 1 });
    return events[0] || null;
  }

  async getSnapshot(roomId, { roomVersion } = {}) {
    const id = required(roomId, 'roomId');
    const result = roomVersion === undefined
      ? await this._query(this.pool, 'SELECT room_id, room_version, snapshot_hash, snapshot_json FROM game_snapshots WHERE room_id = $1 ORDER BY room_version DESC LIMIT 1', [id])
      : await this._query(this.pool, 'SELECT room_id, room_version, snapshot_hash, snapshot_json FROM game_snapshots WHERE room_id = $1 AND room_version = $2', [id, positiveVersion(roomVersion, 'roomVersion', true)]);
    const snapshot = snapshotFromRow(result.rows[0]);
    if (!snapshot) return null;
    const presence = await this.getPresence(id);
    return output(mergePresence(snapshot, presence));
  }

  async getPresence(roomId) {
    const id = required(roomId, 'roomId');
    const result = await this._query(
      this.pool,
      'SELECT room_id, room_version, presence_json, fencing_token, updated_at FROM game_presence WHERE room_id = $1',
      [id]
    );
    return presenceFromRow(result.rows[0]);
  }

  async savePresence({ roomId, roomVersion, presence, fencingToken, updatedAt } = {}) {
    const id = required(roomId, 'roomId');
    const versionValue = positiveVersion(roomVersion ?? 0, 'roomVersion', true);
    const value = normalizePresence(presence);
    const timestampValue = isoTimestamp(updatedAt || new Date().toISOString(), 'updatedAt');
    return this._transaction(async client => {
      if (this.lock) await this.lock.assert(id, fencingToken);
      const currentResult = await this._query(
        client,
        'SELECT room_version FROM game_presence WHERE room_id = $1 FOR UPDATE',
        [id]
      );
      const currentVersion = currentResult.rows[0]?.room_version;
      if (currentVersion !== undefined && Number(currentVersion) > versionValue) {
        throw new RepositoryError('VERSION_CONFLICT', 'presence version is stale', [
          { roomId: id, roomVersion: versionValue, current: Number(currentVersion) }
        ]);
      }
      const result = await this._query(
        client,
        `INSERT INTO game_presence (room_id, room_version, presence_json, fencing_token, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, $5)
         ON CONFLICT (room_id) DO UPDATE SET
           room_version = EXCLUDED.room_version,
           presence_json = EXCLUDED.presence_json,
           fencing_token = EXCLUDED.fencing_token,
           updated_at = EXCLUDED.updated_at
         RETURNING room_id, room_version, presence_json, fencing_token, updated_at`,
        [id, versionValue, JSON.stringify(value), fencingToken ?? null, timestampValue]
      );
      return presenceFromRow(result.rows[0]) || {
        roomId: id,
        roomVersion: versionValue,
        presence: value,
        fencingToken: fencingToken ?? null,
        updatedAt: timestampValue
      };
    });
  }

  async append(input) {
    const result = await this.appendBatch([input], { fencingToken: input?.fencingToken, expectedRoomVersion: input?.expectedRoomVersion });
    return result[0];
  }

  async appendBatch(inputs, { expectedRoomVersion, fencingToken } = {}) {
    if (!Array.isArray(inputs) || inputs.length === 0) throw new RepositoryError('VALIDATION_ERROR', 'appendBatch requires events');
    const roomId = required(inputs[0].roomId, 'roomId');
    for (const input of inputs) if (required(input.roomId, 'roomId') !== roomId) throw new RepositoryError('VALIDATION_ERROR', 'appendBatch accepts one room');
    return this._transaction(async client => {
      if (this.lock) await this.lock.assert(roomId, fencingToken);
      const currentRow = (await this._query(client, 'SELECT room_version FROM game_events WHERE room_id = $1 ORDER BY room_version DESC LIMIT 1 FOR UPDATE', [roomId])).rows[0];
      const current = Number(currentRow?.room_version || 0);
      if (expectedRoomVersion !== undefined && Number(expectedRoomVersion) !== current) throw new RepositoryError('VERSION_CONFLICT', 'expectedRoomVersion does not match stream');
      const rows = [];
      for (let index = 0; index < inputs.length; index += 1) {
        const input = inputs[index];
        const event = clone(input.event || input);
        const version = positiveVersion(input.roomVersion ?? event.roomVersion ?? event.version ?? current + index + 1, 'roomVersion');
        if (version !== current + index + 1) throw new RepositoryError('VERSION_CONFLICT', 'roomVersion must append exactly one next version');
        const eventId = required(event.eventId || this.idFactory(), 'eventId');
        const occurredAt = isoTimestamp(event.occurredAt || event.at || new Date().toISOString(), 'occurredAt');
        const payload = clone(event);
        const eventType = required(event.type || 'ROOM_EVENT', 'event.type');
        const metadata = fencingToken === undefined || fencingToken === null ? {} : { fencingToken: Number(fencingToken) };
        await this._query(client, 'INSERT INTO game_events (event_id, room_id, room_version, match_id, round_id, event_type, payload_json, metadata_json, command_id, request_id, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)', [eventId, roomId, version, event.matchId || null, event.roundId || null, eventType, JSON.stringify(payload), JSON.stringify(metadata), event.commandId || input.commandId || null, event.requestId || input.requestId || null, occurredAt]);
        const normalized = { ...payload, eventId, roomId, roomVersion: version, version, seq: version, type: eventType, occurredAt, at: occurredAt };
        rows.push({ normalized, input });
        await this.outbox._enqueueWithExecutor(client, { roomId, roomVersion: version, eventId, event: normalized, payload: normalized, kind: 'game_event', dedupeKey: `${roomId}:${version}:game_event` });
        if (input.snapshot) await this._insertSnapshot(client, roomId, version, input.snapshot);
      }
      return rows.map(row => output(row.normalized));
    });
  }

  async _insertSnapshot(client, roomId, roomVersion, snapshot) {
    const value = snapshotValue(snapshot, roomId, roomVersion);
    const hash = value.snapshotHash;
    await this._query(client, 'INSERT INTO game_snapshots (room_id, room_version, snapshot_hash, snapshot_json) VALUES ($1,$2,$3,$4::jsonb)', [roomId, roomVersion, hash, JSON.stringify(value)]);
  }

  async saveSnapshot({ roomId, roomVersion, snapshot, replace = false, fencingToken } = {}) {
    const id = required(roomId, 'roomId');
    const version = positiveVersion(roomVersion ?? snapshot?.roomVersion, 'roomVersion', true);
    if (this.lock) await this.lock.assert(id, fencingToken);
    const value = snapshotValue(snapshot, id, version);
    const hash = value.snapshotHash;
    if (replace) {
      // 0004 deliberately installs an append-only trigger. Presence updates
      // need a separate overlay table/migration; silently issuing UPDATE here
      // would turn a valid actor operation into a trigger failure.
      throw new RepositoryError('CONFLICT', 'PostgreSQL snapshots are append-only; replacement requires a presence overlay migration');
    }
    await this._query(this.pool, 'INSERT INTO game_snapshots (room_id, room_version, snapshot_hash, snapshot_json) VALUES ($1,$2,$3,$4::jsonb)', [id, version, hash, JSON.stringify(value)]);
    return output(value);
  }

  async getCommandResult(roomId, commandId) {
    const result = await this._query(this.pool, 'SELECT room_id, command_id, request_hash, response_json, room_version, created_at FROM game_command_results WHERE room_id = $1 AND command_id = $2', [required(roomId, 'roomId'), required(commandId, 'commandId')]);
    const row = result.rows[0];
    return row ? output({ roomId: row.room_id, commandId: row.command_id, requestHash: row.request_hash, hash: row.request_hash, result: clone(row.response_json), roomVersion: Number(row.room_version), createdAt: new Date(row.created_at).toISOString() }) : null;
  }

  async saveCommandResult({ roomId, commandId, requestHash, result, roomVersion, fencingToken } = {}) {
    const id = required(roomId, 'roomId');
    if (this.lock) await this.lock.assert(id, fencingToken);
    const values = [id, required(commandId, 'commandId'), required(requestHash, 'requestHash'), JSON.stringify(result), positiveVersion(roomVersion ?? 0, 'roomVersion', true)];
    try {
      await this._query(this.pool, 'INSERT INTO game_command_results (room_id, command_id, request_hash, response_json, room_version) VALUES ($1,$2,$3,$4::jsonb,$5)', values);
    } catch (error) {
      if (error.code === 'UNIQUE_VIOLATION') {
        const existing = await this.getCommandResult(id, commandId);
        if (existing?.requestHash === requestHash) return existing;
        throw new RepositoryError('DUPLICATE_REQUEST', 'commandId was already used with another request hash');
      }
      throw error;
    }
    return output({ roomId: id, commandId, requestHash, hash: requestHash, result: clone(result), roomVersion: values[4] });
  }

  async health() {
    try { await this._query(this.pool, 'SELECT 1'); return { status: 'ok', backend: 'postgres' }; } catch (error) { return { status: 'unavailable', backend: 'postgres', reason: error.message }; }
  }
}

export class PostgresOutbox {
  constructor({ pool, idFactory = randomUUID } = {}) {
    this.pool = pool;
    if (!pool || typeof pool.query !== 'function') throw new TypeError('PostgresOutbox requires a pg-compatible pool/client');
    this.idFactory = idFactory;
  }

  async _enqueueWithExecutor(executor, input = {}) {
    const eventId = required(input.eventId, 'eventId');
    const id = required(input.messageId || this.idFactory(), 'messageId');
    const roomId = required(input.roomId, 'roomId');
    const version = positiveVersion(input.roomVersion, 'roomVersion');
    const payload = input.payload === undefined ? input.event : input.payload;
    try {
      const result = await executor.query('INSERT INTO outbox_messages (id, event_id, room_id, room_version, topic, payload_json) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id, event_id, room_id, room_version, topic, payload_json, status, attempts, available_at, published_at, created_at', [id, eventId, roomId, version, input.kind || 'game_event', JSON.stringify(payload)]);
      return output(this._row(result.rows[0]));
    } catch (error) {
      throw mapError(error);
    }
  }

  _row(row) {
    return { id: row.id, messageId: row.id, eventId: row.event_id, roomId: row.room_id, roomVersion: Number(row.room_version), kind: row.topic, topic: row.topic, payload: clone(row.payload_json), event: clone(row.payload_json), status: row.status, attempts: Number(row.attempts), availableAt: row.available_at && new Date(row.available_at).toISOString(), publishedAt: row.published_at && new Date(row.published_at).toISOString(), createdAt: row.created_at && new Date(row.created_at).toISOString() };
  }

  async enqueue(input) { return this._enqueueWithExecutor(this.pool, input); }
  async add(input) { return this.enqueue(input); }
  async listPending({ roomId, limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new RepositoryError('VALIDATION_ERROR', 'limit must be between 1 and 10000');
    const params = roomId === undefined ? [limit] : [required(roomId, 'roomId'), limit];
    const where = roomId === undefined ? 'room_id IS NOT NULL' : 'room_id = $1';
    const result = await this.pool.query(`SELECT id, event_id, room_id, room_version, topic, payload_json, status, attempts, available_at, published_at, created_at FROM outbox_messages WHERE ${where} AND status IN ('PENDING','FAILED') AND available_at <= now() ORDER BY created_at ASC LIMIT $${params.length}`, params);
    return result.rows.map(row => output(this._row(row)));
  }
  async pending(options) { return this.listPending(options); }
  async markPublished(messageId, { publishedAt = new Date().toISOString() } = {}) {
    const id = required(typeof messageId === 'object' ? messageId.messageId || messageId.id : messageId, 'messageId');
    const result = await this.pool.query('UPDATE outbox_messages SET status = \'PUBLISHED\', published_at = $2, attempts = attempts + 1 WHERE id = $1 AND status <> \'PUBLISHED\' RETURNING id, event_id, room_id, room_version, topic, payload_json, status, attempts, available_at, published_at, created_at', [id, publishedAt]);
    if (!result.rows[0]) {
      const existing = await this.pool.query('SELECT id, event_id, room_id, room_version, topic, payload_json, status, attempts, available_at, published_at, created_at FROM outbox_messages WHERE id = $1', [id]);
      if (existing.rows[0]) return output(this._row(existing.rows[0]));
      throw new RepositoryError('NOT_FOUND', 'outbox message was not found');
    }
    return output(this._row(result.rows[0]));
  }
  async publish(messageId, options) { return this.markPublished(messageId, options); }
  async ack(messageId, options) { return this.markPublished(messageId, options); }
}

export function createPostgresGamePersistence(options = {}) {
  const outbox = options.outbox || new PostgresOutbox(options);
  const deadlineStore = options.deadlineStore || new PostgresDeadlineStore(options);
  assertDeadlineStore(deadlineStore);
  const eventStore = options.eventStore || new PostgresGameEventStore({ ...options, outbox, deadlineStore });
  assertGameEventStore(eventStore);
  return Object.freeze({
    eventStore,
    outbox,
    deadlineStore,
    lock: options.lock || null,
    pool: options.pool || null,
    redisClient: options.redisClient || null,
    close: async () => {
      await options.redisClient?.quit?.();
      await options.pool?.end?.();
    }
  });
}

/** Optional runtime loader. `pg` remains an application deployment dependency. */
export async function createPostgresPool({ connectionString, ...options } = {}) {
  if (!connectionString) throw new RepositoryError('CONFIG_INVALID', 'DATABASE_URL is required for PostgreSQL');
  try {
    const module = await import('pg');
    const Pool = module.Pool || module.default?.Pool;
    if (!Pool) throw new Error('pg.Pool is unavailable');
    return new Pool({ connectionString, ...options });
  } catch (error) {
    throw new RepositoryError('CONFIG_INVALID', 'PostgreSQL adapter requires the optional pg dependency', error);
  }
}

/** Select memory or PostgreSQL explicitly; never silently fall back in production. */
export async function createConfiguredGamePersistence({ config, ...options } = {}) {
  const backend = config?.PERSISTENCE_BACKEND || config?.persistenceBackend || 'memory';
  if (backend === 'memory') {
    const { createMemoryGamePersistence } = await import('./game-memory.js');
    return createMemoryGamePersistence(options);
  }
  if (backend !== 'postgres') throw new RepositoryError('CONFIG_INVALID', `unsupported persistence backend: ${backend}`);
  const pool = options.pool || await createPostgresPool({ connectionString: config?.DATABASE_URL });
  let redisClient = options.redisClient || null;
  let lock = options.lock || null;
  if (!lock && config?.REDIS_URL) {
    redisClient = redisClient || await createRedisClient({ url: config.REDIS_URL });
    lock = new RedisFencingLock({ client: redisClient });
  }
  return createPostgresGamePersistence({ ...options, pool, lock, redisClient });
}

export { assertRepository };
