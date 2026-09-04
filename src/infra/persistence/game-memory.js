import { createHash, randomUUID } from 'node:crypto';
import { RepositoryError } from './contracts.js';
import { MemoryDeadlineStore } from './deadline-store.js';

export const GAME_EVENT_STORE_CONTRACT_VERSION = '1.1';
export const GAME_EVENT_STORE_METHODS = Object.freeze([
  'append',
  'getEvents',
  // Required for process restart recovery: schedulers and gateways need a
  // durable room inventory before they can materialize actors.
  'listRooms',
  'getSnapshot',
  'saveSnapshot',
  'getCommandResult',
  'saveCommandResult'
]);
export const FENCING_LOCK_METHODS = Object.freeze(['acquire', 'assert', 'release']);
export const OUTBOX_METHODS = Object.freeze(['listPending', 'markPublished']);

function clone(value) {
  if (value === undefined || value === null) return value;
  return structuredClone(value);
}

function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function output(value) {
  return freeze(clone(value));
}

function canonical(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return JSON.stringify(String(value));
    return JSON.stringify(value);
  }
  if (seen.has(value)) throw new TypeError('cyclic value');
  seen.add(value);
  const result = Array.isArray(value)
    ? `[${value.map(item => canonical(item, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
}

function hash(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function verifySnapshotHash(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.snapshotHash) return true;
  const candidate = clone(snapshot);
  const supplied = candidate.snapshotHash;
  delete candidate.snapshotHash;
  return hash(candidate) === supplied;
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

function version(value, field = 'roomVersion', { allowZero = true } = {}) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new RepositoryError('VALIDATION_ERROR', `${field} must be an integer`);
  }
  return value;
}

function timestamp(value, field, clock) {
  const date = new Date(value === undefined || value === null ? clock() : value);
  if (Number.isNaN(date.getTime())) throw new RepositoryError('VALIDATION_ERROR', `${field} must be a valid timestamp`);
  return date.toISOString();
}

function tokenValue(value, field = 'fencingToken', { required = false } = {}) {
  const candidate = value && typeof value === 'object'
    ? (value.fencingToken ?? value.token)
    : value;
  if (candidate === undefined || candidate === null) {
    if (required) throw new RepositoryError('FENCING_TOKEN_REQUIRED', `${field} is required`);
    return null;
  }
  const normalized = Number(candidate);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new RepositoryError('VALIDATION_ERROR', `${field} must be a positive integer`);
  }
  return normalized;
}

function roomKey(roomId) {
  return text(roomId, 'roomId', { max: 128 });
}

function normalizePresence(input, roomId, clock = () => Date.now()) {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new RepositoryError('VALIDATION_ERROR', 'presence must be an object');
  }
  const result = {};
  for (const [playerIdInput, state] of Object.entries(input)) {
    const playerId = text(playerIdInput, 'presence.playerId', { max: 128 });
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new RepositoryError('VALIDATION_ERROR', 'presence state must be an object', [{ roomId, playerId }]);
    }
    if (typeof state.connected !== 'boolean') {
      throw new RepositoryError('VALIDATION_ERROR', 'presence.connected must be boolean', [{ roomId, playerId }]);
    }
    const disconnectedAt = state.disconnectedAt === undefined || state.disconnectedAt === null
      ? null
      : timestamp(state.disconnectedAt, 'presence.disconnectedAt', clock);
    result[playerId] = {
      connected: state.connected,
      disconnectedAt
    };
  }
  return result;
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
  value.snapshotHash = hash(value);
  return value;
}

function commandKey(roomId, commandId) {
  return `${roomKey(roomId)}\u0000${text(commandId, 'commandId', { max: 256 })}`;
}

function sameValue(left, right) {
  return canonical(left) === canonical(right);
}

/**
 * Development outbox. Messages are append-only until they are acknowledged;
 * a production adapter can map this port to a transactional outbox table.
 */
export class MemoryOutbox {
  constructor({ clock = () => Date.now(), idFactory = randomUUID } = {}) {
    if (typeof clock !== 'function' || typeof idFactory !== 'function') {
      throw new TypeError('outbox clock and idFactory must be functions');
    }
    this.clock = clock;
    this.idFactory = idFactory;
    this.messages = new Map();
    this.dedupeKeys = new Map();
    this.eventIds = new Map();
  }

  _prepare(input = {}) {
    const roomId = roomKey(input.roomId);
    const roomVersion = version(input.roomVersion, 'roomVersion', { allowZero: false });
    const kind = text(input.kind ?? 'game_event', 'kind', { max: 64 });
    const dedupeKey = text(input.dedupeKey ?? `${roomId}:${roomVersion}:${kind}`, 'dedupeKey', { max: 512 });
    const messageId = text(input.messageId ?? this.idFactory(), 'messageId', { max: 128 });
    const eventId = input.eventId === undefined || input.eventId === null
      ? null
      : text(input.eventId, 'eventId', { max: 128 });
    const event = input.event === undefined ? null : clone(input.event);
    const payload = input.payload === undefined ? clone(event) : clone(input.payload);
    const candidate = {
      id: messageId,
      messageId,
      kind,
      dedupeKey,
      roomId,
      roomVersion,
      eventId,
      event,
      payload,
      status: 'PENDING',
      attempts: Number.isInteger(input.attempts) && input.attempts >= 0 ? input.attempts : 0,
      createdAt: timestamp(input.createdAt, 'createdAt', this.clock),
      publishedAt: input.publishedAt === undefined || input.publishedAt === null
        ? null
        : timestamp(input.publishedAt, 'publishedAt', this.clock)
    };
    if (candidate.publishedAt) candidate.status = 'PUBLISHED';

    const existingId = this.dedupeKeys.get(dedupeKey);
    if (existingId) {
      const existing = this.messages.get(existingId);
      const comparable = ({ id: _id, messageId: _messageId, createdAt: _createdAt,
        publishedAt: _publishedAt, status: _status, attempts: _attempts, ...rest }) => rest;
      if (sameValue(comparable(existing), comparable(candidate))) {
        return { existing };
      }
      throw new RepositoryError('UNIQUE_VIOLATION', 'outbox dedupe key already exists', [{ dedupeKey }]);
    }
    if (this.messages.has(messageId)) {
      throw new RepositoryError('UNIQUE_VIOLATION', 'outbox message id already exists', [{ messageId }]);
    }
    if (eventId !== null) {
      const existingEventMessageId = this.eventIds.get(eventId);
      if (existingEventMessageId && existingEventMessageId !== messageId) {
        throw new RepositoryError('UNIQUE_VIOLATION', 'outbox event id already exists', [{ eventId }]);
      }
    }
    return { candidate };
  }

  _commit(prepared) {
    if (prepared.existing) return prepared.existing;
    const { candidate } = prepared;
    this.messages.set(candidate.messageId, candidate);
    this.dedupeKeys.set(candidate.dedupeKey, candidate.messageId);
    if (candidate.eventId !== null) this.eventIds.set(candidate.eventId, candidate.messageId);
    return candidate;
  }

  prepare(input = {}) {
    return this._prepare(input);
  }

  commit(prepared) {
    return this._commit(prepared);
  }

  /**
   * Commit a prepared batch as one synchronous unit.  The production outbox
   * maps this operation to the same database transaction as the event insert;
   * keeping it as a distinct port lets the in-memory adapter exercise the
   * atomicity guarantee without exposing its Maps to callers.
   */
  _commitBatch(prepared = []) {
    if (!Array.isArray(prepared) || prepared.length === 0) {
      throw new RepositoryError('VALIDATION_ERROR', 'outbox batch requires at least one message');
    }
    const fresh = prepared.filter(item => !item?.existing);
    const messageIds = new Set();
    const eventIds = new Set();
    const dedupeKeys = new Set();
    for (const item of fresh) {
      const candidate = item?.candidate;
      if (!candidate) throw new RepositoryError('VALIDATION_ERROR', 'invalid prepared outbox message');
      if (messageIds.has(candidate.messageId) || this.messages.has(candidate.messageId)) {
        throw new RepositoryError('UNIQUE_VIOLATION', 'outbox message id already exists', [{ messageId: candidate.messageId }]);
      }
      if (dedupeKeys.has(candidate.dedupeKey) || this.dedupeKeys.has(candidate.dedupeKey)) {
        throw new RepositoryError('UNIQUE_VIOLATION', 'outbox dedupe key already exists', [{ dedupeKey: candidate.dedupeKey }]);
      }
      if (candidate.eventId !== null) {
        if (eventIds.has(candidate.eventId) || this.eventIds.has(candidate.eventId)) {
          throw new RepositoryError('UNIQUE_VIOLATION', 'outbox event id already exists', [{ eventId: candidate.eventId }]);
        }
        eventIds.add(candidate.eventId);
      }
      messageIds.add(candidate.messageId);
      dedupeKeys.add(candidate.dedupeKey);
    }
    const messagesBefore = new Map(this.messages);
    const dedupeBefore = new Map(this.dedupeKeys);
    const eventIdsBefore = new Map(this.eventIds);
    try {
      for (const item of fresh) this._commit(item);
      return prepared.map(item => item?.existing || item?.candidate);
    } catch (error) {
      // A failed outbox row must not expose a prefix of the transaction. This
      // also makes fault-injection tests representative of a database rollback.
      this.messages = messagesBefore;
      this.dedupeKeys = dedupeBefore;
      this.eventIds = eventIdsBefore;
      throw error;
    }
  }

  enqueue(input = {}) {
    return output(this._commit(this._prepare(input)));
  }

  enqueueBatch(inputs = []) {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new RepositoryError('VALIDATION_ERROR', 'outbox batch requires at least one message');
    }
    const prepared = inputs.map(input => this._prepare(input));
    return output(this._commitBatch(prepared));
  }

  add(input = {}) {
    return this.enqueue(input);
  }

  get(messageId) {
    const id = text(messageId, 'messageId', { max: 128 });
    const message = this.messages.get(id);
    return message ? output(message) : null;
  }

  listPending({ roomId, limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new RepositoryError('VALIDATION_ERROR', 'limit must be between 1 and 10000');
    }
    const normalizedRoomId = roomId === undefined ? undefined : roomKey(roomId);
    return [...this.messages.values()]
      .filter(message => message.status === 'PENDING'
        && (normalizedRoomId === undefined || message.roomId === normalizedRoomId))
      .slice(0, limit)
      .map(output);
  }

  pending(options = {}) {
    return this.listPending(options);
  }

  list(options = {}) {
    const { roomId, limit = 10_000 } = options;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new RepositoryError('VALIDATION_ERROR', 'limit must be between 1 and 10000');
    }
    const normalizedRoomId = roomId === undefined ? undefined : roomKey(roomId);
    return [...this.messages.values()]
      .filter(message => normalizedRoomId === undefined || message.roomId === normalizedRoomId)
      .slice(0, limit)
      .map(output);
  }

  markPublished(messageIdOrOptions, options = {}) {
    const input = messageIdOrOptions && typeof messageIdOrOptions === 'object'
      ? messageIdOrOptions
      : { ...options, messageId: messageIdOrOptions };
    const id = text(input.messageId ?? input.id, 'messageId', { max: 128 });
    const current = this.messages.get(id);
    if (!current) throw new RepositoryError('NOT_FOUND', 'outbox message was not found');
    if (current.status === 'PUBLISHED') return output(current);
    const publishedAt = timestamp(input.publishedAt, 'publishedAt', this.clock);
    const next = { ...current, status: 'PUBLISHED', publishedAt, attempts: current.attempts + 1 };
    this.messages.set(id, next);
    return output(next);
  }

  publish(messageIdOrOptions, options = {}) {
    return this.markPublished(messageIdOrOptions, options);
  }

  ack(messageIdOrOptions, options = {}) {
    return this.markPublished(messageIdOrOptions, options);
  }

  clear() {
    this.messages.clear();
    this.dedupeKeys.clear();
    this.eventIds.clear();
  }
}

/**
 * In-process fencing lock with Redis-compatible semantics. Tokens are
 * monotonically increasing per lock instance and are checked by every write.
 */
export class MemoryRoomLock {
  constructor({ clock = () => Date.now(), idFactory = randomUUID, leaseMs = null, tokenFactory } = {}) {
    if (typeof clock !== 'function' || typeof idFactory !== 'function') {
      throw new TypeError('lock clock and idFactory must be functions');
    }
    this.clock = clock;
    this.idFactory = idFactory;
    this.leaseMs = leaseMs;
    this.tokenFactory = tokenFactory;
    this.nextToken = 0;
    this.locks = new Map();
  }

  _next() {
    const value = this.tokenFactory ? this.tokenFactory() : this.nextToken + 1;
    if (!Number.isSafeInteger(Number(value)) || Number(value) < 1) {
      throw new RepositoryError('INTERNAL_ERROR', 'lock token factory returned an invalid token');
    }
    if (Number(value) <= this.nextToken) {
      throw new RepositoryError('INTERNAL_ERROR', 'lock token factory must return monotonically increasing tokens');
    }
    this.nextToken = Math.max(this.nextToken, Number(value));
    return Number(value);
  }

  acquire(roomIdInput, options = {}) {
    if (roomIdInput && typeof roomIdInput === 'object') {
      options = { ...roomIdInput, ...options };
      roomIdInput = options.roomId;
    }
    const roomId = roomKey(roomIdInput);
    const now = Date.parse(timestamp(undefined, 'now', this.clock));
    const existing = this.locks.get(roomId);
    if (existing && existing.expiresAt !== null && Date.parse(existing.expiresAt) <= now) this.locks.delete(roomId);
    const current = this.locks.get(roomId);
    const ownerId = text(options.ownerId ?? options.actorId ?? this.idFactory(), 'ownerId', { max: 128 });
    if (current) {
      if (current.ownerId === ownerId) return output(current);
      throw new RepositoryError('LOCK_BUSY', 'room lock is held by another actor', [{ roomId }]);
    }
    const ttl = options.leaseMs === undefined ? this.leaseMs : options.leaseMs;
    if (ttl !== null && (!Number.isFinite(ttl) || ttl <= 0)) {
      throw new RepositoryError('VALIDATION_ERROR', 'leaseMs must be positive or null');
    }
    const acquiredAt = timestamp(undefined, 'acquiredAt', this.clock);
    const record = {
      roomId,
      ownerId,
      fencingToken: this._next(),
      token: null,
      acquiredAt,
      expiresAt: ttl === null ? null : new Date(Date.parse(acquiredAt) + ttl).toISOString()
    };
    record.token = record.fencingToken;
    this.locks.set(roomId, record);
    return output(record);
  }

  assert(roomIdInput, fencingToken) {
    if (roomIdInput && typeof roomIdInput === 'object') {
      fencingToken = roomIdInput.fencingToken ?? roomIdInput.token ?? fencingToken;
      roomIdInput = roomIdInput.roomId;
    }
    const roomId = roomKey(roomIdInput);
    const token = tokenValue(fencingToken, 'fencingToken', { required: true });
    const current = this.locks.get(roomId);
    if (!current) throw new RepositoryError('LOCK_NOT_HELD', 'room lock is not held', [{ roomId }]);
    if (current.expiresAt !== null && Date.parse(current.expiresAt) <= Date.parse(timestamp(undefined, 'now', this.clock))) {
      this.locks.delete(roomId);
      throw new RepositoryError('LOCK_EXPIRED', 'room lock has expired', [{ roomId }]);
    }
    if (current.fencingToken !== token) {
      throw new RepositoryError('FENCING_TOKEN_STALE', 'fencing token is stale', [{ roomId, fencingToken: token }]);
    }
    return output(current);
  }

  assertFencingToken(roomId, fencingToken) {
    return this.assert(roomId, fencingToken);
  }

  release(roomIdInput, fencingToken) {
    if (roomIdInput && typeof roomIdInput === 'object') {
      fencingToken = roomIdInput.fencingToken ?? roomIdInput.token ?? fencingToken;
      roomIdInput = roomIdInput.roomId;
    }
    const roomId = roomKey(roomIdInput);
    const token = tokenValue(fencingToken, 'fencingToken', { required: true });
    const current = this.locks.get(roomId);
    if (!current) return false;
    if (current.expiresAt !== null && Date.parse(current.expiresAt) <= Date.parse(timestamp(undefined, 'now', this.clock))) {
      this.locks.delete(roomId);
      return false;
    }
    if (current.fencingToken !== token) {
      throw new RepositoryError('FENCING_TOKEN_STALE', 'fencing token is stale', [{ roomId, fencingToken: token }]);
    }
    this.locks.delete(roomId);
    return true;
  }

  releaseFencing(roomId, fencingToken) {
    return this.release(roomId, fencingToken);
  }

  current(roomIdInput) {
    if (roomIdInput && typeof roomIdInput === 'object') roomIdInput = roomIdInput.roomId;
    const current = this.locks.get(roomKey(roomIdInput));
    if (!current) return null;
    if (current.expiresAt !== null && Date.parse(current.expiresAt) <= Date.parse(timestamp(undefined, 'now', this.clock))) {
      this.locks.delete(current.roomId);
      return null;
    }
    return output(current);
  }

  clear() {
    this.locks.clear();
  }
}

export class MemoryGameEventStore {
  constructor({ clock = () => Date.now(), idFactory = randomUUID, outbox, lock, deadlineStore } = {}) {
    if (typeof clock !== 'function' || typeof idFactory !== 'function') {
      throw new TypeError('event store clock and idFactory must be functions');
    }
    this.clock = clock;
    this.idFactory = idFactory;
    this.outbox = outbox || new MemoryOutbox({ clock, idFactory });
    this.lock = lock || null;
    // Deadline state is separate from the append-only event stream. Keeping
    // the port on the game store makes the development factory easy to mount
    // while allowing production callers to inject a PostgreSQL adapter.
    this.deadlineStore = deadlineStore || new MemoryDeadlineStore({ clock, idFactory });
    this.events = new Map();
    this.eventIds = new Map();
    // Checkpoints are append-only by room version. `getSnapshot` returns the
    // latest checkpoint; exact-version reads remain available for replay.
    this.snapshots = new Map();
    // Presence is mutable transport state and therefore lives outside the
    // append-only event/snapshot maps. The value is still versioned so an old
    // actor cannot overwrite a newer checkpoint after losing its lease.
    this.presence = new Map();
    this.commandResults = new Map();
    this.fencingTokens = new Map();
  }

  bindLock(lock) {
    if (!lock || typeof lock.assert !== 'function') throw new TypeError('lock must expose assert');
    this.lock = lock;
    return this;
  }

  _currentVersion(roomId) {
    const events = this.events.get(roomId);
    return events && events.length > 0 ? events[events.length - 1].roomVersion : 0;
  }

  _assertFencing(roomId, fencingToken, { allowMissing = true } = {}) {
    const token = tokenValue(fencingToken);
    const current = this.fencingTokens.get(roomId) || 0;
    if (token === null) {
      if (!allowMissing || current > 0 || this.lock) {
        throw new RepositoryError('FENCING_TOKEN_REQUIRED', 'fencingToken is required', [{ roomId }]);
      }
      return null;
    }
    if (this.lock) this.lock.assert(roomId, token);
    if (token < current) {
      throw new RepositoryError('FENCING_TOKEN_STALE', 'fencing token is stale', [{ roomId, fencingToken: token, currentFencingToken: current }]);
    }
    return token;
  }

  _recordFencing(roomId, token) {
    if (token !== null && token !== undefined) this.fencingTokens.set(roomId, token);
  }

  _normalizeEvent(input, roomId, expectedVersion) {
    const candidate = clone(input.event || input);
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new RepositoryError('VALIDATION_ERROR', 'event must be an object');
    }
    const eventRoomId = candidate.roomId === undefined ? roomId : roomKey(candidate.roomId);
    if (eventRoomId !== roomId) throw new RepositoryError('VALIDATION_ERROR', 'event roomId does not match roomId');
    const eventVersion = candidate.roomVersion ?? candidate.version ?? expectedVersion;
    if (version(eventVersion, 'event.roomVersion', { allowZero: false }) !== expectedVersion) {
      throw new RepositoryError('VERSION_CONFLICT', 'event roomVersion does not match append version', [{ roomId, expected: expectedVersion, actual: eventVersion }]);
    }
    const eventId = text(candidate.eventId ?? this.idFactory(), 'eventId', { max: 128 });
    if (candidate.type !== undefined && (typeof candidate.type !== 'string' || candidate.type.trim().length === 0)) {
      throw new RepositoryError('VALIDATION_ERROR', 'event.type must not be blank');
    }
    const occurredAt = timestamp(candidate.occurredAt ?? candidate.at, 'occurredAt', this.clock);
    const normalized = {
      ...candidate,
      eventId,
      roomId,
      version: expectedVersion,
      roomVersion: expectedVersion,
      seq: expectedVersion,
      occurredAt,
      at: candidate.at === undefined ? occurredAt : timestamp(candidate.at, 'at', this.clock)
    };
    for (const field of ['matchId', 'roundId', 'commandId', 'requestId']) {
      if (normalized[field] === undefined && input[field] !== undefined && input[field] !== null) {
        normalized[field] = text(input[field], field, { max: 256 });
      }
    }
    return normalized;
  }

  _normalizeSnapshot(snapshotInput, roomId, roomVersion) {
    if (snapshotInput === undefined || snapshotInput === null) return null;
    if (typeof snapshotInput !== 'object' || Array.isArray(snapshotInput)) {
      throw new RepositoryError('VALIDATION_ERROR', 'snapshot must be an object');
    }
    const snapshot = clone(snapshotInput);
    const snapshotVersion = snapshot.roomVersion ?? snapshot.version ?? roomVersion;
    if (version(snapshotVersion, 'snapshot.roomVersion') !== roomVersion) {
      throw new RepositoryError('VERSION_CONFLICT', 'snapshot roomVersion does not match append version', [{ roomId, expected: roomVersion, actual: snapshotVersion }]);
    }
    snapshot.roomId = snapshot.roomId === undefined ? roomId : roomKey(snapshot.roomId);
    if (snapshot.roomId !== roomId) throw new RepositoryError('VALIDATION_ERROR', 'snapshot roomId does not match roomId');
    snapshot.roomVersion = roomVersion;
    snapshot.version = roomVersion;
    if (!verifySnapshotHash(snapshot)) {
      throw new RepositoryError('VERSION_CONFLICT', 'snapshot hash does not match payload', [{ roomId, roomVersion }]);
    }
    if (snapshot.ruleSnapshotHash && snapshot.ruleSnapshot
      && snapshot.ruleSnapshotHash !== hash(snapshot.ruleSnapshot)) {
      throw new RepositoryError('VERSION_CONFLICT', 'rule snapshot hash does not match payload', [{ roomId, roomVersion }]);
    }
    // Add the generation timestamp before deriving a hash.  A Room snapshot
    // already carries its own hash, so changing the payload after validating it
    // would make an otherwise healthy checkpoint impossible to restore.
    if (snapshot.snapshotHash === undefined) {
      if (snapshot.createdAt === undefined && snapshot.generatedAt === undefined) snapshot.generatedAt = timestamp(undefined, 'generatedAt', this.clock);
      snapshot.snapshotHash = hash(snapshot);
    }
    return snapshot;
  }

  _prepareAppend(input = {}, fencingTokenOverride) {
    const roomId = roomKey(input.roomId);
    const currentVersion = this._currentVersion(roomId);
    const roomVersion = version(input.roomVersion ?? input.event?.roomVersion ?? input.event?.version, 'roomVersion', { allowZero: false });
    if (roomVersion !== currentVersion + 1) {
      throw new RepositoryError('VERSION_CONFLICT', 'roomVersion must append exactly one next version', [{ roomId, expected: currentVersion + 1, actual: roomVersion }]);
    }
    const token = tokenValue(fencingTokenOverride ?? input.fencingToken);
    const event = this._normalizeEvent(input, roomId, roomVersion);
    const snapshot = this._normalizeSnapshot(input.snapshot, roomId, roomVersion);
    return { roomId, roomVersion, token, event, snapshot };
  }

  _prepareBatch(inputs, fencingToken, expectedVersionInput) {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new RepositoryError('VALIDATION_ERROR', 'appendBatch requires at least one event');
    }
    const firstRoomId = roomKey(inputs[0].roomId);
    const token = tokenValue(fencingToken ?? inputs[0].fencingToken);
    const currentVersion = this._currentVersion(firstRoomId);
    const expectedVersion = expectedVersionInput ?? inputs[0].expectedRoomVersion;
    if (expectedVersion !== undefined && expectedVersion !== null
      && (!Number.isInteger(expectedVersion) || expectedVersion !== currentVersion)) {
      throw new RepositoryError('VERSION_CONFLICT', 'expectedRoomVersion does not match stream version', [
        { roomId: firstRoomId, expectedRoomVersion: expectedVersion, actualRoomVersion: currentVersion }
      ]);
    }
    const prepared = inputs.map((input, index) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new RepositoryError('VALIDATION_ERROR', 'appendBatch entries must be objects');
      }
      const roomId = roomKey(input.roomId);
      if (roomId !== firstRoomId) throw new RepositoryError('VALIDATION_ERROR', 'appendBatch accepts one room at a time');
      const itemToken = tokenValue(input.fencingToken);
      if (itemToken !== null && token !== null && itemToken !== token) {
        throw new RepositoryError('FENCING_TOKEN_STALE', 'appendBatch entries must use one fencing token', [{ roomId }]);
      }
      const roomVersion = version(
        input.roomVersion ?? input.event?.roomVersion ?? input.event?.version ?? currentVersion + index + 1,
        'roomVersion',
        { allowZero: false }
      );
      if (roomVersion !== currentVersion + index + 1) {
        throw new RepositoryError('VERSION_CONFLICT', 'roomVersion must append exactly one next version', [{ roomId, expected: currentVersion + index + 1, actual: roomVersion }]);
      }
      return {
        roomId,
        roomVersion,
        token,
        event: this._normalizeEvent(input, roomId, roomVersion),
        snapshot: this._normalizeSnapshot(input.snapshot, roomId, roomVersion)
      };
    });
    const existingIds = new Set(this.eventIds.keys());
    for (const item of prepared) {
      const previousRoom = this.eventIds.get(item.event.eventId);
      if (previousRoom && (previousRoom.roomId !== item.roomId || previousRoom.roomVersion !== item.roomVersion)) {
        throw new RepositoryError('UNIQUE_VIOLATION', 'event id already exists', [{ eventId: item.event.eventId }]);
      }
      if (existingIds.has(item.event.eventId)) {
        const occurrences = prepared.filter(candidate => candidate.event.eventId === item.event.eventId);
        if (occurrences.length > 1) throw new RepositoryError('UNIQUE_VIOLATION', 'event id occurs more than once', [{ eventId: item.event.eventId }]);
      }
      existingIds.add(item.event.eventId);
    }
    this._assertFencing(firstRoomId, token);
    return prepared;
  }

  _commitPrepared(prepared) {
    const roomId = prepared[0].roomId;
    const token = prepared[0].token;
    const existingEvents = this.events.get(roomId) || [];
    const existingEventIds = new Set(existingEvents.map(event => event.eventId));
    const batchEventIds = new Set();
    for (const item of prepared) {
      if (existingEventIds.has(item.event.eventId) || batchEventIds.has(item.event.eventId)) {
        throw new RepositoryError('UNIQUE_VIOLATION', 'eventId already exists', [{ roomId, eventId: item.event.eventId }]);
      }
      batchEventIds.add(item.event.eventId);
    }
    const outboxRows = prepared.map(item => ({
      roomId,
      roomVersion: item.roomVersion,
      eventId: item.event.eventId,
      event: item.event,
      payload: item.event,
      kind: 'game_event',
      dedupeKey: `${roomId}:${item.roomVersion}:game_event`
    }));
    // Validate snapshot uniqueness/monotonicity before mutating events,
    // event-id indexes or the outbox. This keeps appendBatch atomic even when
    // a checkpoint conflicts with an existing version.
    const snapshotPlans = [];
    const plannedSnapshots = new Map();
    const existingSnapshots = this.snapshots.get(roomId) || new Map();
    let latestSnapshotVersion = [...existingSnapshots.keys()].sort((left, right) => left - right).at(-1) ?? null;
    for (const item of prepared) {
      if (!item.snapshot) continue;
      const snapshotVersion = item.snapshot.roomVersion;
      if (latestSnapshotVersion !== null && snapshotVersion < latestSnapshotVersion) {
        throw new RepositoryError('VERSION_CONFLICT', 'snapshot version is stale', [
          { roomId, roomVersion: snapshotVersion, current: latestSnapshotVersion }
        ]);
      }
      const existing = plannedSnapshots.get(snapshotVersion) || existingSnapshots.get(snapshotVersion);
      if (existing && !sameValue(existing, item.snapshot)) {
        throw new RepositoryError('UNIQUE_VIOLATION', 'snapshot version already exists', [
          { roomId, roomVersion: snapshotVersion }
        ]);
      }
      plannedSnapshots.set(snapshotVersion, item.snapshot);
      snapshotPlans.push(item.snapshot);
      latestSnapshotVersion = snapshotVersion;
    }
    const outboxPrepared = typeof this.outbox.enqueueBatch === 'function'
      ? null
      : outboxRows.map(item => this.outbox._prepare(item));
    if (typeof this.outbox.enqueueBatch === 'function') this.outbox.enqueueBatch(outboxRows);
    else for (const message of outboxPrepared) this.outbox._commit(message);

    const nextEvents = [...existingEvents, ...prepared.map(item => deepFreezeClone(item.event))];
    this.events.set(roomId, nextEvents);
    for (const item of prepared) {
      this.eventIds.set(item.event.eventId, { roomId, roomVersion: item.roomVersion });
    }
    if (snapshotPlans.length > 0) {
      const roomSnapshots = new Map(existingSnapshots);
      for (const snapshot of snapshotPlans) roomSnapshots.set(snapshot.roomVersion, deepFreezeClone(snapshot));
      this.snapshots.set(roomId, roomSnapshots);
    }
    this._recordFencing(roomId, token);
    return prepared.map(item => item.event);
  }

  append(inputOrRoomId, eventOrOptions, options = {}) {
    const input = typeof inputOrRoomId === 'string'
      ? { ...options, roomId: inputOrRoomId, event: eventOrOptions }
      : { ...(inputOrRoomId || {}) };
    const prepared = this._prepareBatch([input], input.fencingToken, input.expectedRoomVersion);
    return output(this._commitPrepared(prepared)[0]);
  }

  appendBatch(inputs, options = {}) {
    const prepared = this._prepareBatch(inputs, options.fencingToken, options.expectedRoomVersion ?? options.expectedVersion);
    return output(this._commitPrepared(prepared));
  }

  getEvents(roomIdInput, options = {}) {
    if (roomIdInput && typeof roomIdInput === 'object') {
      options = { ...roomIdInput, ...options };
      roomIdInput = options.roomId;
    }
    const roomId = roomKey(roomIdInput);
    const events = this.events.get(roomId) || [];
    const afterVersion = options.afterVersion ?? options.afterRoomVersion ?? 0;
    const throughVersion = options.throughVersion ?? options.throughRoomVersion ?? this._currentVersion(roomId);
    version(afterVersion, 'afterVersion');
    version(throughVersion, 'throughVersion');
    if (throughVersion < afterVersion) throw new RepositoryError('VALIDATION_ERROR', 'throughVersion precedes afterVersion');
    const limit = options.limit === undefined ? 10_000 : options.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new RepositoryError('VALIDATION_ERROR', 'limit must be between 1 and 10000');
    return events
      .filter(event => event.roomVersion > afterVersion && event.roomVersion <= throughVersion)
      .slice(0, limit)
      .map(output);
  }

  getEvent(roomIdInput, roomVersion) {
    if (roomIdInput && typeof roomIdInput === 'object') {
      roomVersion = roomIdInput.roomVersion ?? roomIdInput.version ?? roomVersion;
      roomIdInput = roomIdInput.roomId;
    }
    const roomId = roomKey(roomIdInput);
    const target = version(roomVersion, 'roomVersion', { allowZero: false });
    return (this.events.get(roomId) || []).find(event => event.roomVersion === target)
      ? output((this.events.get(roomId) || []).find(event => event.roomVersion === target))
      : null;
  }

  getLatestVersion(roomIdInput) {
    if (roomIdInput && typeof roomIdInput === 'object') roomIdInput = roomIdInput.roomId;
    return this._currentVersion(roomKey(roomIdInput));
  }

  eventsSince(roomIdInput, lastVersion = 0) {
    if (roomIdInput && typeof roomIdInput === 'object') {
      lastVersion = roomIdInput.lastVersion ?? roomIdInput.afterVersion ?? 0;
      roomIdInput = roomIdInput.roomId;
    }
    return this.getEvents(roomIdInput, { afterVersion: lastVersion });
  }

  saveSnapshot(roomIdInput, snapshotOrOptions, options = {}) {
    const input = typeof roomIdInput === 'string'
      ? { ...options, roomId: roomIdInput, snapshot: snapshotOrOptions }
      : { ...(roomIdInput || {}) };
    const roomId = roomKey(input.roomId);
    const roomVersion = version(input.roomVersion ?? input.snapshot?.roomVersion ?? input.snapshot?.version, 'roomVersion');
    const latest = this._currentVersion(roomId);
    if (roomVersion > latest) throw new RepositoryError('VERSION_CONFLICT', 'snapshot cannot be ahead of events', [{ roomId, roomVersion, latest }]);
    const token = this._assertFencing(roomId, input.fencingToken);
    const snapshot = this._normalizeSnapshot(input.snapshot, roomId, roomVersion);
    const roomSnapshots = this.snapshots.get(roomId) || new Map();
    const latestSnapshot = [...roomSnapshots.entries()]
      .sort(([left], [right]) => left - right)
      .at(-1)?.[1] || null;
    if (latestSnapshot && roomVersion < latestSnapshot.roomVersion) {
      throw new RepositoryError('VERSION_CONFLICT', 'snapshot version is stale', [
        { roomId, roomVersion, current: latestSnapshot.roomVersion }
      ]);
    }
    const current = roomSnapshots.get(roomVersion);
    // Event snapshots are immutable by default. Presence changes are
    // deliberately non-versioned, however, so the actor may replace the
    // checkpoint at the same roomVersion after an explicit `replace` opt-in.
    // This keeps reconnect state durable without manufacturing game events.
    if (current && !sameValue(current, snapshot) && input.replace !== true) {
      throw new RepositoryError('UNIQUE_VIOLATION', 'snapshot version already exists', [{ roomId, roomVersion }]);
    }
    roomSnapshots.set(roomVersion, deepFreezeClone(snapshot));
    this.snapshots.set(roomId, roomSnapshots);
    this._recordFencing(roomId, token);
    return output(snapshot);
  }

  /**
   * Atomically initialize a room checkpoint and its create-command result.
   * PostgreSQL adapters should implement the same operation in one
   * transaction; the memory adapter keeps rollback semantics explicit so a
   * failed response write cannot leave an orphaned version-zero room.
   */
  initializeRoom(input = {}) {
    if (!input.commandId || !input.requestHash || input.result === undefined) {
      return this.saveSnapshot(input);
    }
    const roomId = roomKey(input.roomId);
    const snapshotState = this.snapshots.get(roomId);
    const commandKeyValue = commandKey(roomId, input.commandId);
    const commandState = this.commandResults.get(commandKeyValue);
    const fencingState = this.fencingTokens.get(roomId);
    try {
      const snapshot = this.saveSnapshot(input);
      const command = this.saveCommandResult({
        roomId,
        commandId: input.commandId,
        requestHash: input.requestHash,
        result: input.result,
        roomVersion: input.roomVersion ?? input.snapshot?.roomVersion ?? input.snapshot?.version ?? 0,
        ...(input.fencingToken === undefined ? {} : { fencingToken: input.fencingToken })
      });
      return { snapshot, commandResult: command };
    } catch (error) {
      if (snapshotState === undefined) this.snapshots.delete(roomId);
      else this.snapshots.set(roomId, snapshotState);
      if (commandState === undefined) this.commandResults.delete(commandKeyValue);
      else this.commandResults.set(commandKeyValue, commandState);
      if (fencingState === undefined) this.fencingTokens.delete(roomId);
      else this.fencingTokens.set(roomId, fencingState);
      throw error;
    }
  }

  getSnapshot(roomIdInput, options = {}) {
    if (roomIdInput && typeof roomIdInput === 'object') {
      options = { ...roomIdInput, ...options };
      roomIdInput = options.roomId;
    }
    const normalizedRoomId = roomKey(roomIdInput);
    const roomSnapshots = this.snapshots.get(normalizedRoomId);
    if (!roomSnapshots || roomSnapshots.size === 0) return null;
    const requestedVersion = options.roomVersion ?? options.version;
    if (requestedVersion !== undefined) {
      const snapshotVersion = version(requestedVersion, 'roomVersion');
      const exact = roomSnapshots.get(snapshotVersion);
      return exact ? output(mergePresence(exact, this.presence.get(normalizedRoomId))) : null;
    }
    const latest = [...roomSnapshots.entries()].sort(([left], [right]) => left - right).at(-1)?.[1];
    return output(mergePresence(latest, this.presence.get(normalizedRoomId)));
  }

  snapshot(roomIdInput, options = {}) {
    return this.getSnapshot(roomIdInput, options);
  }

  savePresence(roomIdOrInput, presenceOrOptions, options = {}) {
    const input = typeof roomIdOrInput === 'string'
      ? { ...options, roomId: roomIdOrInput, presence: presenceOrOptions }
      : { ...(roomIdOrInput || {}) };
    const roomId = roomKey(input.roomId);
    const roomVersion = version(
      input.roomVersion ?? input.version ?? 0,
      'roomVersion'
    );
    const latest = this._currentVersion(roomId);
    if (roomVersion > latest) {
      throw new RepositoryError('VERSION_CONFLICT', 'presence cannot be ahead of events', [
        { roomId, roomVersion, latest }
      ]);
    }
    const token = this._assertFencing(roomId, input.fencingToken);
    const existing = this.presence.get(roomId);
    if (existing && roomVersion < existing.roomVersion) {
      throw new RepositoryError('VERSION_CONFLICT', 'presence version is stale', [
        { roomId, roomVersion, current: existing.roomVersion }
      ]);
    }
    const record = {
      roomId,
      roomVersion,
      presence: normalizePresence(input.presence, roomId, this.clock),
      updatedAt: timestamp(input.updatedAt, 'updatedAt', this.clock),
      fencingToken: token
    };
    this.presence.set(roomId, record);
    this._recordFencing(roomId, token);
    return output(record);
  }

  getPresence(roomIdInput) {
    if (roomIdInput && typeof roomIdInput === 'object') roomIdInput = roomIdInput.roomId;
    const record = this.presence.get(roomKey(roomIdInput));
    return record ? output(record) : null;
  }

  saveCommandResult(roomIdOrInput, commandIdOrHash, requestHashOrResult, resultOrOptions, options = {}) {
    let input;
    if (roomIdOrInput && typeof roomIdOrInput === 'object') {
      input = { ...roomIdOrInput };
    } else {
      input = {
        ...(options || {}),
        roomId: roomIdOrInput,
        commandId: commandIdOrHash,
        requestHash: requestHashOrResult,
        result: resultOrOptions
      };
    }
    const roomId = roomKey(input.roomId);
    const commandId = text(input.commandId, 'commandId', { max: 256 });
    const requestHash = text(input.requestHash, 'requestHash', { max: 256 });
    const key = commandKey(roomId, commandId);
    const existing = this.commandResults.get(key);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new RepositoryError('DUPLICATE_REQUEST', 'commandId was already used with another request hash', [{ roomId, commandId }]);
      }
      return output(existing);
    }
    const token = this._assertFencing(roomId, input.fencingToken);
    const record = {
      roomId,
      commandId,
      requestHash,
      hash: requestHash,
      result: clone(input.result),
      roomVersion: input.roomVersion ?? input.result?.roomVersion ?? this._currentVersion(roomId),
      createdAt: timestamp(input.createdAt, 'createdAt', this.clock)
    };
    version(record.roomVersion, 'roomVersion');
    this.commandResults.set(key, record);
    this._recordFencing(roomId, token);
    return output(record);
  }

  getCommandResult(roomIdInput, commandIdInput) {
    if (roomIdInput && typeof roomIdInput === 'object') {
      commandIdInput = roomIdInput.commandId;
      roomIdInput = roomIdInput.roomId;
    }
    const record = this.commandResults.get(commandKey(roomIdInput, commandIdInput));
    return record ? output(record) : null;
  }

  listCommandResults(roomIdInput) {
    const roomId = roomKey(roomIdInput);
    return [...this.commandResults.values()].filter(record => record.roomId === roomId).map(output);
  }

  listRooms() {
    return [...new Set([...this.events.keys(), ...this.snapshots.keys()])];
  }

  health() {
    return Object.freeze({
      status: 'ok',
      backend: 'memory',
      rooms: this.listRooms().length,
      events: [...this.events.values()].reduce((count, events) => count + events.length, 0),
      outboxPending: this.outbox.listPending({ limit: 10_000 }).length
    });
  }

  clear() {
    this.events.clear();
    this.eventIds.clear();
    this.snapshots.clear();
    this.presence.clear();
    this.commandResults.clear();
    this.fencingTokens.clear();
    this.outbox.clear();
    this.deadlineStore.clear?.();
  }
}

function deepFreezeClone(value) {
  return freeze(clone(value));
}

export const MemoryEventStore = MemoryGameEventStore;
export const MemoryFencingLock = MemoryRoomLock;
// Stable port names for future PostgreSQL/Redis adapters. Consumers should
// depend on these contracts rather than the development adapter class names.
export const GameEventStore = MemoryGameEventStore;
export const FencingLock = MemoryRoomLock;
export const OutboxStore = MemoryOutbox;
export const MemoryOutboxStore = MemoryOutbox;
export const GameStoreError = RepositoryError;

export function assertGameEventStore(store) {
  if (!store || typeof store !== 'object') throw new TypeError('game event store must be an object');
  const missing = GAME_EVENT_STORE_METHODS.filter(method => typeof store[method] !== 'function');
  if (missing.length > 0) throw new TypeError(`game event store is missing methods: ${missing.join(', ')}`);
  return store;
}

export function createMemoryGameStore(options = {}) {
  const outbox = options.outbox || new MemoryOutbox(options);
  const lock = options.lock || new MemoryRoomLock(options);
  const deadlineStore = options.deadlineStore || new MemoryDeadlineStore(options);
  const eventStore = options.eventStore || new MemoryGameEventStore({ ...options, outbox, lock, deadlineStore });
  if (eventStore.outbox !== outbox) eventStore.outbox = outbox;
  if (eventStore.deadlineStore !== deadlineStore) eventStore.deadlineStore = deadlineStore;
  if (typeof eventStore.bindLock === 'function') eventStore.bindLock(lock);
  return Object.freeze({ eventStore, lock, outbox, deadlineStore });
}

// Naming used by the persistence port documentation. Keeping the aliases here
// lets callers choose a descriptive name without coupling to this development
// adapter's implementation class names.
export const createMemoryGamePersistence = createMemoryGameStore;
export const MemoryGamePersistence = MemoryGameEventStore;
