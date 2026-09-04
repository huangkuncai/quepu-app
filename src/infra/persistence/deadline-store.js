import { randomUUID } from 'node:crypto';
import { RepositoryError } from './contracts.js';

/**
 * Durable deadline claim/lease port.
 *
 * A deadline is an intent to dispatch one guarded room command.  The timer
 * that wakes a process up is deliberately outside this port; this port owns
 * the cross-process state transition that makes execution unique.
 */
export const DEADLINE_STORE_CONTRACT_VERSION = '1.0';
export const DEADLINE_STORE_METHODS = Object.freeze([
  'upsert',
  'get',
  'list',
  'claim',
  'complete',
  'fail',
  'cancel',
  'cancelRoom'
]);

export const DEADLINE_STATUS = Object.freeze({
  SCHEDULED: 'SCHEDULED',
  CLAIMED: 'CLAIMED',
  EXECUTED: 'EXECUTED',
  STALE: 'STALE',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
});

const TERMINAL = new Set([
  DEADLINE_STATUS.EXECUTED,
  DEADLINE_STATUS.STALE,
  DEADLINE_STATUS.FAILED,
  DEADLINE_STATUS.CANCELLED
]);

function clone(value) {
  if (value === undefined || value === null) return value;
  return structuredClone(value);
}

function canonical(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return JSON.stringify(String(value));
    return JSON.stringify(value);
  }
  if (seen.has(value)) throw new TypeError('cyclic deadline value');
  seen.add(value);
  const result = Array.isArray(value)
    ? `[${value.map(item => canonical(item, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
}

function text(value, field, { required = true, max = 256 } = {}) {
  if (value === undefined || value === null) {
    if (!required) return null;
    throw new RepositoryError('VALIDATION_ERROR', `${field} is required`);
  }
  const normalized = String(value).trim();
  if (!normalized && required) throw new RepositoryError('VALIDATION_ERROR', `${field} must not be blank`);
  if (!normalized && !required) return null;
  if (normalized.length > max) throw new RepositoryError('VALIDATION_ERROR', `${field} exceeds ${max} characters`);
  return normalized;
}

function integer(value, field, { min = 0, allowNull = false } = {}) {
  if ((value === undefined || value === null) && allowNull) return null;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < min) {
    throw new RepositoryError('VALIDATION_ERROR', `${field} must be an integer >= ${min}`);
  }
  return normalized;
}

function dateValue(value, field, { allowNull = false, fallback } = {}) {
  if ((value === undefined || value === null) && allowNull) return null;
  const candidate = value === undefined || value === null ? fallback : value;
  const date = new Date(candidate);
  if (Number.isNaN(date.getTime())) throw new RepositoryError('VALIDATION_ERROR', `${field} must be a valid timestamp`);
  return date;
}

function iso(value, field, options = {}) {
  const date = dateValue(value, field, options);
  return date === null ? null : date.toISOString();
}

function timestampMillis(value, field = 'now', fallback = Date.now()) {
  const date = dateValue(value, field, { fallback });
  return date.getTime();
}

function normalizeAction(value) {
  if (typeof value === 'string') {
    return { type: 'action', action: text(value, 'timeoutAction', { max: 64 }) };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RepositoryError('VALIDATION_ERROR', 'timeoutAction must be an object');
  }
  const action = text(value.action ?? value.name, 'timeoutAction.action', { max: 64 });
  const type = text(value.type ?? 'action', 'timeoutAction.type', { max: 64 });
  const result = { type, action };
  if (value.args !== undefined) result.args = clone(value.args);
  if (value.payload !== undefined) result.payload = clone(value.payload);
  if (value.requestId !== undefined && value.requestId !== null) {
    result.requestId = text(value.requestId, 'timeoutAction.requestId');
  }
  return result;
}

function normalizeInput(input = {}, clock = () => Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RepositoryError('VALIDATION_ERROR', 'deadline must be an object');
  }
  const roomId = text(input.roomId, 'roomId', { max: 128 });
  const deadlineId = text(input.deadlineId, 'deadlineId');
  const commandId = text(input.commandId, 'commandId');
  const deadlineAt = iso(input.deadlineAt, 'deadlineAt');
  const expectedRoomVersion = integer(input.expectedRoomVersion, 'expectedRoomVersion', { min: 0, allowNull: true });
  const roundId = text(input.roundId, 'roundId', { required: false, max: 128 });
  const playerId = text(input.playerId, 'playerId', { required: false, max: 128 });
  const timeoutAction = normalizeAction(input.timeoutAction);
  const immutable = {
    deadlineId,
    roomId,
    commandId,
    deadlineAt,
    expectedRoomVersion,
    roundId,
    playerId,
    timeoutAction
  };
  return {
    ...immutable,
    // The adapter owns the definition hash. Never trust a caller-supplied
    // fingerprint to make two different deadline definitions look equal.
    fingerprint: canonical(immutable),
    createdAt: iso(input.createdAt, 'createdAt', { fallback: clock() }),
    updatedAt: iso(input.updatedAt, 'updatedAt', { fallback: clock() })
  };
}

function normalizeStatuses(statuses) {
  if (statuses === undefined || statuses === null) return null;
  const values = Array.isArray(statuses) ? statuses : [statuses];
  const normalized = values.map(value => text(value, 'status', { max: 32 }).toUpperCase());
  for (const value of normalized) {
    if (!Object.values(DEADLINE_STATUS).includes(value)) {
      throw new RepositoryError('VALIDATION_ERROR', `unsupported deadline status: ${value}`);
    }
  }
  return normalized;
}

function claimResult(record, { claimed, reason, replayed = false } = {}) {
  return clone({
    claimed: Boolean(claimed),
    ...(reason ? { reason } : {}),
    ...(replayed ? { replayed: true } : {}),
    record,
    ...(claimed ? {
      leaseOwner: record.leaseOwner,
      leaseToken: record.leaseToken,
      leaseExpiresAt: record.leaseExpiresAt
    } : {})
  });
}

function completeStatus(value) {
  const status = text(value ?? DEADLINE_STATUS.EXECUTED, 'status', { max: 32 }).toUpperCase();
  if (![DEADLINE_STATUS.EXECUTED, DEADLINE_STATUS.STALE, DEADLINE_STATUS.FAILED].includes(status)) {
    throw new RepositoryError('VALIDATION_ERROR', 'completion status must be EXECUTED, STALE or FAILED');
  }
  return status;
}

function leaseToken(value) {
  return integer(value, 'leaseToken', { min: 1 });
}

function assertLease(record, options = {}) {
  if (record.status !== DEADLINE_STATUS.CLAIMED) {
    if (TERMINAL.has(record.status)) return false;
    throw new RepositoryError('LEASE_NOT_HELD', 'deadline is not currently claimed', [{ deadlineId: record.deadlineId }]);
  }
  const token = leaseToken(options.leaseToken);
  if (record.leaseToken !== token) {
    throw new RepositoryError('FENCING_TOKEN_STALE', 'deadline lease token is stale', [{ deadlineId: record.deadlineId, leaseToken: token }]);
  }
  const ownerId = text(options.ownerId, 'ownerId', { max: 128 });
  if (record.leaseOwner !== ownerId) {
    throw new RepositoryError('LEASE_NOT_HELD', 'deadline lease belongs to another worker', [{ deadlineId: record.deadlineId }]);
  }
  return true;
}

/** In-process durable-port test adapter. Share one instance across schedulers. */
export class MemoryDeadlineStore {
  constructor({ clock = () => Date.now(), idFactory = randomUUID } = {}) {
    if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('deadline store clock and idFactory must be functions');
    this.clock = clock;
    this.idFactory = idFactory;
    this.records = new Map();
    this.nextLeaseToken = 0;
  }

  upsert(input = {}) {
    const normalized = normalizeInput(input, this.clock);
    const existing = this.records.get(normalized.deadlineId);
    if (existing) {
      if (existing.fingerprint !== normalized.fingerprint) {
        throw new RepositoryError('DUPLICATE_REQUEST', 'deadlineId was already used with another definition', [{ deadlineId: normalized.deadlineId }]);
      }
      return clone(existing);
    }
    const record = {
      ...normalized,
      status: DEADLINE_STATUS.SCHEDULED,
      attempts: 0,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      claimedAt: null,
      completedAt: null,
      reason: null,
      result: undefined,
      error: null
    };
    this.records.set(record.deadlineId, record);
    return clone(record);
  }

  get(deadlineId) {
    const id = text(deadlineId, 'deadlineId');
    return clone(this.records.get(id) || null);
  }

  list({ roomId, statuses, status, dueBefore, limit = 10000 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new RepositoryError('VALIDATION_ERROR', 'limit must be between 1 and 10000');
    const allowed = normalizeStatuses(statuses ?? status);
    const cutoff = dueBefore === undefined || dueBefore === null ? null : timestampMillis(dueBefore, 'dueBefore');
    const id = roomId === undefined || roomId === null ? null : text(roomId, 'roomId', { max: 128 });
    return [...this.records.values()]
      .filter(record => (id === null || record.roomId === id)
        && (!allowed || allowed.includes(record.status))
        && (cutoff === null || Date.parse(record.deadlineAt) <= cutoff))
      .sort((left, right) => Date.parse(left.deadlineAt) - Date.parse(right.deadlineAt))
      .slice(0, limit)
      .map(clone);
  }

  claim(deadlineId, { ownerId, now, leaseMs = 30000 } = {}) {
    const id = text(deadlineId, 'deadlineId');
    const record = this.records.get(id);
    if (!record) throw new RepositoryError('NOT_FOUND', 'deadline was not found', [{ deadlineId: id }]);
    const worker = text(ownerId, 'ownerId', { max: 128 });
    const ttl = integer(leaseMs, 'leaseMs', { min: 1 });
    const nowMs = timestampMillis(now, 'now', this.clock());
    if (TERMINAL.has(record.status)) return claimResult(record, { reason: 'TERMINAL' });
    if (record.status === DEADLINE_STATUS.CLAIMED) {
      const expires = record.leaseExpiresAt ? Date.parse(record.leaseExpiresAt) : Number.POSITIVE_INFINITY;
      if (expires > nowMs) {
        if (record.leaseOwner === worker) return claimResult(record, { claimed: true, replayed: true });
        return claimResult(record, { reason: 'LEASE_HELD' });
      }
    }
    if (Date.parse(record.deadlineAt) > nowMs) return claimResult(record, { reason: 'NOT_DUE' });
    record.status = DEADLINE_STATUS.CLAIMED;
    record.attempts += 1;
    record.leaseOwner = worker;
    record.leaseToken = ++this.nextLeaseToken;
    record.leaseExpiresAt = new Date(nowMs + ttl).toISOString();
    record.claimedAt = new Date(nowMs).toISOString();
    record.updatedAt = new Date(nowMs).toISOString();
    return claimResult(record, { claimed: true });
  }

  complete(deadlineId, options = {}) {
    const id = text(deadlineId, 'deadlineId');
    const record = this.records.get(id);
    if (!record) throw new RepositoryError('NOT_FOUND', 'deadline was not found', [{ deadlineId: id }]);
    if (TERMINAL.has(record.status)) return clone(record);
    assertLease(record, options);
    const status = completeStatus(options.status);
    const now = iso(options.completedAt, 'completedAt', { fallback: this.clock() });
    record.status = status;
    record.completedAt = now;
    record.updatedAt = now;
    record.reason = options.reason === undefined || options.reason === null ? null : text(options.reason, 'reason', { max: 256 });
    record.result = options.result === undefined ? undefined : clone(options.result);
    record.error = options.error === undefined || options.error === null ? null : clone(options.error);
    record.leaseOwner = null;
    record.leaseToken = null;
    record.leaseExpiresAt = null;
    return clone(record);
  }

  fail(deadlineId, options = {}) {
    return this.complete(deadlineId, { ...options, status: DEADLINE_STATUS.FAILED });
  }

  cancel(deadlineId, { reason = 'CANCELLED', ownerId, leaseToken: token } = {}) {
    const id = text(deadlineId, 'deadlineId');
    const record = this.records.get(id);
    if (!record) throw new RepositoryError('NOT_FOUND', 'deadline was not found', [{ deadlineId: id }]);
    if (TERMINAL.has(record.status)) return clone(record);
    if (record.status === DEADLINE_STATUS.CLAIMED) {
      assertLease(record, { ownerId, leaseToken: token });
    }
    const now = iso(undefined, 'updatedAt', { fallback: this.clock() });
    record.status = DEADLINE_STATUS.CANCELLED;
    record.reason = text(reason, 'reason', { max: 256 });
    record.updatedAt = now;
    record.completedAt = now;
    record.leaseOwner = null;
    record.leaseToken = null;
    record.leaseExpiresAt = null;
    return clone(record);
  }

  cancelRoom(roomId, { exceptDeadlineId, reason = 'ROOM_CANCELLED' } = {}) {
    const id = text(roomId, 'roomId', { max: 128 });
    const except = exceptDeadlineId === undefined || exceptDeadlineId === null
      ? null : text(exceptDeadlineId, 'exceptDeadlineId');
    let count = 0;
    for (const record of this.records.values()) {
      if (record.roomId !== id || record.deadlineId === except || record.status !== DEADLINE_STATUS.SCHEDULED) continue;
      this.cancel(record.deadlineId, { reason });
      count += 1;
    }
    return count;
  }

  health() {
    return { status: 'ok', backend: 'memory', deadlines: this.records.size };
  }

  clear() {
    this.records.clear();
    this.nextLeaseToken = 0;
  }
}

function mapDatabaseError(error) {
  if (error instanceof RepositoryError) return error;
  if (error?.code === '23505') return new RepositoryError('UNIQUE_VIOLATION', error.detail || error.message, error);
  if (error?.code === '40001' || error?.code === '40P01') return new RepositoryError('CONFLICT', error.message, error);
  return error;
}

function rowRecord(row) {
  if (!row) return null;
  return {
    deadlineId: row.deadline_id,
    roomId: row.room_id,
    commandId: row.command_id,
    deadlineAt: new Date(row.deadline_at).toISOString(),
    expectedRoomVersion: row.expected_room_version === null || row.expected_room_version === undefined ? null : Number(row.expected_room_version),
    roundId: row.round_id ?? null,
    playerId: row.player_id ?? null,
    timeoutAction: clone(row.timeout_action_json ?? row.timeout_action ?? {}),
    fingerprint: row.fingerprint,
    status: row.status,
    attempts: Number(row.attempts || 0),
    leaseOwner: row.lease_owner ?? null,
    leaseToken: row.lease_token === null || row.lease_token === undefined ? null : Number(row.lease_token),
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : null,
    claimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    reason: row.reason ?? null,
    result: row.result_json === undefined || row.result_json === null ? undefined : clone(row.result_json),
    error: row.error_json === undefined || row.error_json === null ? null : clone(row.error_json),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

const ROW_COLUMNS = `deadline_id, room_id, command_id, deadline_at, expected_room_version,
  round_id, player_id, timeout_action_json, fingerprint, status, attempts, lease_owner,
  lease_token, lease_expires_at, claimed_at, completed_at, reason, result_json, error_json,
  created_at, updated_at`;

/** PostgreSQL adapter for the durable deadline claim/lease port. */
export class PostgresDeadlineStore {
  constructor({ pool, client, clock = () => Date.now() } = {}) {
    this.pool = pool || client;
    if (!this.pool || typeof this.pool.query !== 'function') throw new TypeError('PostgresDeadlineStore requires a pg-compatible pool/client');
    this.clock = clock;
  }

  async _query(executor, textValue, values = []) {
    try {
      return await executor.query(textValue, values);
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }

  async _transaction(callback) {
    if (typeof this.pool.connect !== 'function') throw new RepositoryError('CONFIG_INVALID', 'PostgreSQL deadline writes require a pool with connect()');
    const client = await this.pool.connect();
    try {
      await this._query(client, 'BEGIN');
      const value = await callback(client);
      await this._query(client, 'COMMIT');
      return value;
    } catch (error) {
      try { await this._query(client, 'ROLLBACK'); } catch { /* keep original */ }
      throw mapDatabaseError(error);
    } finally {
      client.release?.();
    }
  }

  async upsert(input = {}) {
    const normalized = normalizeInput(input, this.clock);
    const values = [
      normalized.deadlineId,
      normalized.roomId,
      normalized.commandId,
      normalized.deadlineAt,
      normalized.expectedRoomVersion,
      normalized.roundId,
      normalized.playerId,
      JSON.stringify(normalized.timeoutAction),
      normalized.fingerprint,
      normalized.createdAt,
      normalized.updatedAt
    ];
    const inserted = await this._query(
      this.pool,
      `INSERT INTO game_deadlines (${ROW_COLUMNS.split(',').slice(0, 9).join(', ')}, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
       ON CONFLICT (deadline_id) DO NOTHING
       RETURNING ${ROW_COLUMNS}`,
      values
    );
    const existing = rowRecord(inserted.rows?.[0]);
    if (existing) return clone(existing);
    const current = await this.get(normalized.deadlineId);
    if (!current) throw new RepositoryError('CONFLICT', 'deadline upsert did not return a row');
    if (current.fingerprint !== normalized.fingerprint) {
      throw new RepositoryError('DUPLICATE_REQUEST', 'deadlineId was already used with another definition', [{ deadlineId: normalized.deadlineId }]);
    }
    return current;
  }

  async get(deadlineId) {
    const id = text(deadlineId, 'deadlineId');
    const result = await this._query(this.pool, `SELECT ${ROW_COLUMNS} FROM game_deadlines WHERE deadline_id = $1`, [id]);
    return outputRecord(rowRecord(result.rows?.[0]));
  }

  async list({ roomId, statuses, status, dueBefore, limit = 10000 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new RepositoryError('VALIDATION_ERROR', 'limit must be between 1 and 10000');
    const allowed = normalizeStatuses(statuses ?? status);
    const values = [];
    const where = [];
    if (roomId !== undefined && roomId !== null) {
      values.push(text(roomId, 'roomId', { max: 128 }));
      where.push(`room_id = $${values.length}`);
    }
    if (allowed) {
      values.push(allowed);
      where.push(`status = ANY($${values.length}::text[])`);
    }
    if (dueBefore !== undefined && dueBefore !== null) {
      values.push(iso(dueBefore, 'dueBefore'));
      where.push(`deadline_at <= $${values.length}`);
    }
    values.push(limit);
    const result = await this._query(this.pool, `SELECT ${ROW_COLUMNS} FROM game_deadlines${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY deadline_at ASC LIMIT $${values.length}`, values);
    return (result.rows || []).map(rowRecord).map(outputRecord);
  }

  async claim(deadlineId, { ownerId, now, leaseMs = 30000 } = {}) {
    const id = text(deadlineId, 'deadlineId');
    const worker = text(ownerId, 'ownerId', { max: 128 });
    const ttl = integer(leaseMs, 'leaseMs', { min: 1 });
    const nowDate = dateValue(now, 'now', { fallback: this.clock() });
    return this._transaction(async client => {
      const result = await this._query(client, `SELECT ${ROW_COLUMNS} FROM game_deadlines WHERE deadline_id = $1 FOR UPDATE`, [id]);
      const record = rowRecord(result.rows?.[0]);
      if (!record) throw new RepositoryError('NOT_FOUND', 'deadline was not found', [{ deadlineId: id }]);
      const nowMs = nowDate.getTime();
      if (TERMINAL.has(record.status)) return claimResult(record, { reason: 'TERMINAL' });
      if (record.status === DEADLINE_STATUS.CLAIMED) {
        const expires = record.leaseExpiresAt ? Date.parse(record.leaseExpiresAt) : Number.POSITIVE_INFINITY;
        if (expires > nowMs) {
          if (record.leaseOwner === worker) return claimResult(record, { claimed: true, replayed: true });
          return claimResult(record, { reason: 'LEASE_HELD' });
        }
      }
      if (Date.parse(record.deadlineAt) > nowMs) return claimResult(record, { reason: 'NOT_DUE' });
      const nextToken = (record.leaseToken || 0) + 1;
      const expiresAt = new Date(nowMs + ttl).toISOString();
      const updated = await this._query(client, `UPDATE game_deadlines
        SET status = 'CLAIMED', attempts = attempts + 1, lease_owner = $2,
            lease_token = $3, lease_expires_at = $4, claimed_at = $5, updated_at = $5
        WHERE deadline_id = $1
        RETURNING ${ROW_COLUMNS}`, [id, worker, nextToken, expiresAt, nowDate.toISOString()]);
      const next = rowRecord(updated.rows?.[0]);
      return claimResult(next, { claimed: true });
    });
  }

  async complete(deadlineId, options = {}) {
    const id = text(deadlineId, 'deadlineId');
    const status = completeStatus(options.status);
    const completedAt = iso(options.completedAt, 'completedAt', { fallback: this.clock() });
    return this._transaction(async client => {
      const result = await this._query(client, `SELECT ${ROW_COLUMNS} FROM game_deadlines WHERE deadline_id = $1 FOR UPDATE`, [id]);
      const record = rowRecord(result.rows?.[0]);
      if (!record) throw new RepositoryError('NOT_FOUND', 'deadline was not found', [{ deadlineId: id }]);
      if (TERMINAL.has(record.status)) return record;
      assertLease(record, options);
      const reason = options.reason === undefined || options.reason === null ? null : text(options.reason, 'reason', { max: 256 });
      const updated = await this._query(client, `UPDATE game_deadlines
        SET status = $2, completed_at = $3, updated_at = $3, reason = $4,
            result_json = $5::jsonb, error_json = $6::jsonb,
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
        WHERE deadline_id = $1
        RETURNING ${ROW_COLUMNS}`,
      [id, status, completedAt, reason, options.result === undefined ? null : JSON.stringify(options.result), options.error === undefined || options.error === null ? null : JSON.stringify(options.error)]);
      return rowRecord(updated.rows?.[0]);
    });
  }

  async fail(deadlineId, options = {}) {
    return this.complete(deadlineId, { ...options, status: DEADLINE_STATUS.FAILED });
  }

  async cancel(deadlineId, { reason = 'CANCELLED', ownerId, leaseToken: token } = {}) {
    const id = text(deadlineId, 'deadlineId');
    return this._transaction(async client => {
      const result = await this._query(client, `SELECT ${ROW_COLUMNS} FROM game_deadlines WHERE deadline_id = $1 FOR UPDATE`, [id]);
      const record = rowRecord(result.rows?.[0]);
      if (!record) throw new RepositoryError('NOT_FOUND', 'deadline was not found', [{ deadlineId: id }]);
      if (TERMINAL.has(record.status)) return record;
      if (record.status === DEADLINE_STATUS.CLAIMED) assertLease(record, { ownerId, leaseToken: token });
      const now = iso(undefined, 'updatedAt', { fallback: this.clock() });
      const updated = await this._query(client, `UPDATE game_deadlines
        SET status = 'CANCELLED', reason = $2, completed_at = $3, updated_at = $3,
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
        WHERE deadline_id = $1
        RETURNING ${ROW_COLUMNS}`, [id, text(reason, 'reason', { max: 256 }), now]);
      return rowRecord(updated.rows?.[0]);
    });
  }

  async cancelRoom(roomId, { exceptDeadlineId, reason = 'ROOM_CANCELLED' } = {}) {
    const id = text(roomId, 'roomId', { max: 128 });
    const except = exceptDeadlineId === undefined || exceptDeadlineId === null
      ? null : text(exceptDeadlineId, 'exceptDeadlineId');
    return this._transaction(async client => {
      const values = [id];
      const where = ['room_id = $1', "status = 'SCHEDULED'"];
      if (except !== null) {
        values.push(except);
        where.push(`deadline_id <> $${values.length}`);
      }
      const selected = await this._query(client, `SELECT ${ROW_COLUMNS} FROM game_deadlines WHERE ${where.join(' AND ')} FOR UPDATE`, values);
      const now = iso(undefined, 'updatedAt', { fallback: this.clock() });
      const cancelled = [];
      for (const row of selected.rows || []) {
        const deadline = rowRecord(row);
        const updated = await this._query(client, `UPDATE game_deadlines
          SET status = 'CANCELLED', reason = $2, completed_at = $3, updated_at = $3
          WHERE deadline_id = $1 AND status = 'SCHEDULED'
          RETURNING ${ROW_COLUMNS}`, [deadline.deadlineId, text(reason, 'reason', { max: 256 }), now]);
        if (updated.rows?.[0]) cancelled.push(rowRecord(updated.rows[0]));
      }
      return cancelled;
    });
  }

  async health() {
    try {
      await this._query(this.pool, 'SELECT 1');
      return { status: 'ok', backend: 'postgres' };
    } catch (error) {
      return { status: 'unavailable', backend: 'postgres', reason: error.message };
    }
  }
}

function outputRecord(value) {
  return value === null ? null : clone(value);
}

export function assertDeadlineStore(store) {
  if (!store || typeof store !== 'object') throw new TypeError('deadline store must be an object');
  const missing = DEADLINE_STORE_METHODS.filter(method => typeof store[method] !== 'function');
  if (missing.length > 0) throw new TypeError(`deadline store is missing methods: ${missing.join(', ')}`);
  return store;
}
