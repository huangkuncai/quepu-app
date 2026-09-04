import { randomUUID } from 'node:crypto';
import { RepositoryError, assertRepository } from './contracts.js';

const USER_STATUSES = new Set(['ACTIVE', 'BANNED', 'DELETED']);
const SESSION_STATUSES = new Set(['ACTIVE', 'REVOKED', 'EXPIRED']);
const ACTOR_TYPES = new Set(['USER', 'ADMIN', 'SYSTEM', 'SERVICE']);

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

function text(value, field, { required = true, max = 256 } = {}) {
  if (value === undefined || value === null) {
    if (!required) return null;
    throw new RepositoryError('VALIDATION_ERROR', `${field} is required`);
  }
  const normalized = String(value).trim();
  if (!required && normalized.length === 0) return null;
  if (required && normalized.length === 0) {
    throw new RepositoryError('VALIDATION_ERROR', `${field} must not be blank`);
  }
  if (normalized.length > max) {
    throw new RepositoryError('VALIDATION_ERROR', `${field} exceeds ${max} characters`);
  }
  return normalized;
}

function timestamp(value, field, clock, { required = false } = {}) {
  const missing = value === undefined || value === null;
  if (missing && required) {
    throw new RepositoryError('VALIDATION_ERROR', `${field} is required`);
  }
  // Required fields must fail before consulting the clock. Optional fields use
  // the injected clock so tests and providers can keep time deterministic.
  const date = new Date(missing ? clock() : value);
  if (Number.isNaN(date.getTime())) {
    throw new RepositoryError('VALIDATION_ERROR', `${field} must be a valid timestamp`);
  }
  return date.toISOString();
}

function optionalTimestamp(value, field, clock) {
  return value === undefined || value === null ? null : timestamp(value, field, clock);
}

function assertStatus(status, allowed, field) {
  if (!allowed.has(status)) {
    throw new RepositoryError('VALIDATION_ERROR', `${field} is invalid`);
  }
  return status;
}

function mapKey(scope, key) {
  return `${scope}\u0000${key}`;
}

/**
 * Dependency-free repository used by tests, local development and fake
 * providers. Values returned from it are cloned and frozen so callers cannot
 * mutate repository state accidentally.
 */
export class MemoryRepository {
  constructor({ clock = () => Date.now(), idFactory = randomUUID } = {}) {
    this.clock = clock;
    this.idFactory = idFactory;
    this.users = new Map();
    this.userIdsByPhone = new Map();
    this.devices = new Map();
    this.sessions = new Map();
    this.sessionIdsByAccessHash = new Map();
    this.sessionIdsByRefreshHash = new Map();
    this.idempotency = new Map();
    this.auditLogs = [];
    this.nextAuditId = 1;
  }

  createUser({ id = this.idFactory(), phoneE164 = null, displayName, status = 'ACTIVE', createdAt, updatedAt } = {}) {
    const userId = text(id, 'id', { max: 128 });
    const phone = text(phoneE164, 'phoneE164', { required: false, max: 32 });
    const name = text(displayName, 'displayName', { max: 128 });
    assertStatus(status, USER_STATUSES, 'status');
    if (this.users.has(userId)) throw new RepositoryError('UNIQUE_VIOLATION', 'user id already exists');
    if (phone && this.userIdsByPhone.has(phone)) {
      throw new RepositoryError('UNIQUE_VIOLATION', 'phoneE164 already exists');
    }
    const now = timestamp(createdAt, 'createdAt', this.clock);
    const user = {
      id: userId,
      phoneE164: phone,
      displayName: name,
      status,
      createdAt: now,
      updatedAt: timestamp(updatedAt ?? now, 'updatedAt', this.clock)
    };
    this.users.set(userId, user);
    if (phone) this.userIdsByPhone.set(phone, userId);
    return output(user);
  }

  findUserById(id) {
    const user = this.users.get(text(id, 'id', { max: 128 }));
    return user ? output(user) : null;
  }

  findUserByPhone(phoneE164) {
    const phone = text(phoneE164, 'phoneE164', { max: 32 });
    const userId = this.userIdsByPhone.get(phone);
    return userId ? output(this.users.get(userId)) : null;
  }

  updateUser(id, patch = {}) {
    const userId = text(id, 'id', { max: 128 });
    const current = this.users.get(userId);
    if (!current) throw new RepositoryError('NOT_FOUND', 'user was not found');
    const nextPhone = patch.phoneE164 === undefined
      ? current.phoneE164
      : text(patch.phoneE164, 'phoneE164', { required: false, max: 32 });
    if (nextPhone && nextPhone !== current.phoneE164 && this.userIdsByPhone.has(nextPhone)) {
      throw new RepositoryError('UNIQUE_VIOLATION', 'phoneE164 already exists');
    }
    const next = {
      ...current,
      phoneE164: nextPhone,
      displayName: patch.displayName === undefined
        ? current.displayName
        : text(patch.displayName, 'displayName', { max: 128 }),
      status: patch.status === undefined ? current.status : assertStatus(patch.status, USER_STATUSES, 'status'),
      updatedAt: timestamp(patch.updatedAt, 'updatedAt', this.clock)
    };
    if (current.phoneE164) this.userIdsByPhone.delete(current.phoneE164);
    if (nextPhone) this.userIdsByPhone.set(nextPhone, userId);
    this.users.set(userId, next);
    return output(next);
  }

  upsertDevice({ id, userId, platform, appVersion, deviceName, lastSeenAt, revokedAt } = {}) {
    const deviceId = text(id, 'id', { max: 128 });
    const ownerId = text(userId, 'userId', { max: 128 });
    if (!this.users.has(ownerId)) throw new RepositoryError('NOT_FOUND', 'device user was not found');
    const current = this.devices.get(deviceId);
    if (current && current.userId !== ownerId) {
      throw new RepositoryError('UNIQUE_VIOLATION', 'device belongs to another user');
    }
    const now = timestamp(lastSeenAt, 'lastSeenAt', this.clock);
    const next = {
      id: deviceId,
      userId: ownerId,
      platform: text(platform, 'platform', { max: 32 }),
      appVersion: appVersion === undefined
        ? (current?.appVersion || null)
        : text(appVersion, 'appVersion', { required: false, max: 64 }),
      deviceName: deviceName === undefined
        ? (current?.deviceName || null)
        : text(deviceName, 'deviceName', { required: false, max: 128 }),
      lastSeenAt: now,
      revokedAt: revokedAt === undefined
        ? (current?.revokedAt || null)
        : optionalTimestamp(revokedAt, 'revokedAt', this.clock),
      createdAt: current?.createdAt || now,
      updatedAt: now
    };
    this.devices.set(deviceId, next);
    return output(next);
  }

  findDeviceById(id) {
    const device = this.devices.get(text(id, 'id', { max: 128 }));
    return device ? output(device) : null;
  }

  listDevicesByUser(userId, { includeRevoked = true } = {}) {
    const ownerId = text(userId, 'userId', { max: 128 });
    return [...this.devices.values()]
      .filter(device => device.userId === ownerId && (includeRevoked || !device.revokedAt))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .map(output);
  }

  revokeDevice(id, { at } = {}) {
    const deviceId = text(id, 'id', { max: 128 });
    const device = this.devices.get(deviceId);
    if (!device) throw new RepositoryError('NOT_FOUND', 'device was not found');
    const revokedAt = timestamp(at, 'revokedAt', this.clock);
    const next = { ...device, revokedAt, updatedAt: revokedAt };
    this.devices.set(deviceId, next);
    return output(next);
  }

  createSession({
    id = this.idFactory(),
    userId,
    deviceId,
    accessTokenHash,
    refreshTokenHash,
    status = 'ACTIVE',
    createdAt,
    lastSeenAt,
    expiresAt,
    revokedAt = null
  } = {}) {
    const sessionId = text(id, 'id', { max: 128 });
    const ownerId = text(userId, 'userId', { max: 128 });
    const installationId = text(deviceId, 'deviceId', { max: 128 });
    const accessHash = text(accessTokenHash, 'accessTokenHash', { max: 256 });
    const refreshHash = text(refreshTokenHash, 'refreshTokenHash', { max: 256 });
    assertStatus(status, SESSION_STATUSES, 'status');
    if (!this.users.has(ownerId)) throw new RepositoryError('NOT_FOUND', 'session user was not found');
    const device = this.devices.get(installationId);
    if (!device || device.userId !== ownerId) throw new RepositoryError('NOT_FOUND', 'session device was not found');
    if (this.sessions.has(sessionId) || this.sessionIdsByAccessHash.has(accessHash) || this.sessionIdsByRefreshHash.has(refreshHash)) {
      throw new RepositoryError('UNIQUE_VIOLATION', 'session id or token hash already exists');
    }
    // Validate required expiry before deriving optional timestamps. This keeps
    // a missing required field deterministic even when the injected clock is
    // unavailable or throws.
    const expiry = timestamp(expiresAt, 'expiresAt', this.clock, { required: true });
    const created = timestamp(createdAt, 'createdAt', this.clock);
    const session = {
      id: sessionId,
      userId: ownerId,
      deviceId: installationId,
      accessTokenHash: accessHash,
      refreshTokenHash: refreshHash,
      status,
      createdAt: created,
      lastSeenAt: timestamp(lastSeenAt ?? created, 'lastSeenAt', this.clock),
      expiresAt: expiry,
      revokedAt: optionalTimestamp(revokedAt, 'revokedAt', this.clock)
    };
    if (status === 'ACTIVE' && session.revokedAt !== null) {
      throw new RepositoryError('VALIDATION_ERROR', 'active session cannot have revokedAt');
    }
    if (new Date(session.expiresAt) < new Date(session.createdAt)) {
      throw new RepositoryError('VALIDATION_ERROR', 'expiresAt must not precede createdAt');
    }
    this.sessions.set(sessionId, session);
    this.sessionIdsByAccessHash.set(accessHash, sessionId);
    this.sessionIdsByRefreshHash.set(refreshHash, sessionId);
    return output(session);
  }

  findSessionById(id) {
    const session = this.sessions.get(text(id, 'id', { max: 128 }));
    return session ? output(session) : null;
  }

  findSessionByAccessTokenHash(accessTokenHash) {
    const hash = text(accessTokenHash, 'accessTokenHash', { max: 256 });
    const id = this.sessionIdsByAccessHash.get(hash);
    return id ? output(this.sessions.get(id)) : null;
  }

  findSessionByRefreshTokenHash(refreshTokenHash) {
    const hash = text(refreshTokenHash, 'refreshTokenHash', { max: 256 });
    const id = this.sessionIdsByRefreshHash.get(hash);
    return id ? output(this.sessions.get(id)) : null;
  }

  touchSession(id, { at } = {}) {
    const sessionId = text(id, 'id', { max: 128 });
    const current = this.sessions.get(sessionId);
    if (!current) throw new RepositoryError('NOT_FOUND', 'session was not found');
    if (current.status !== 'ACTIVE') throw new RepositoryError('CONFLICT', 'session is not active');
    const next = { ...current, lastSeenAt: timestamp(at, 'lastSeenAt', this.clock) };
    this.sessions.set(sessionId, next);
    return output(next);
  }

  revokeSession(id, { status = 'REVOKED', at } = {}) {
    const sessionId = text(id, 'id', { max: 128 });
    const current = this.sessions.get(sessionId);
    if (!current) throw new RepositoryError('NOT_FOUND', 'session was not found');
    if (status !== 'REVOKED' && status !== 'EXPIRED') {
      throw new RepositoryError('VALIDATION_ERROR', 'revocation status is invalid');
    }
    const revokedAt = timestamp(at, 'revokedAt', this.clock);
    const next = { ...current, status, revokedAt };
    this.sessions.set(sessionId, next);
    return output(next);
  }

  claimIdempotencyKey({ scope, key, requestHash, expiresAt } = {}) {
    const normalizedScope = text(scope, 'scope', { max: 256 });
    const normalizedKey = text(key, 'key', { max: 256 });
    const hash = text(requestHash, 'requestHash', { max: 256 });
    const expiry = timestamp(expiresAt, 'expiresAt', this.clock, { required: true });
    const composite = mapKey(normalizedScope, normalizedKey);
    const existing = this.idempotency.get(composite);
    const now = new Date(this.clock());
    if (existing && new Date(existing.expiresAt) > now) {
      if (existing.requestHash !== hash) {
        throw new RepositoryError('IDEMPOTENCY_CONFLICT', 'idempotency key was used with another request hash');
      }
      return output({ claimed: false, record: existing });
    }
    const record = {
      scope: normalizedScope,
      key: normalizedKey,
      requestHash: hash,
      response: null,
      responseStatus: null,
      createdAt: timestamp(undefined, 'createdAt', this.clock),
      expiresAt: expiry
    };
    if (new Date(record.expiresAt) < new Date(record.createdAt)) {
      throw new RepositoryError('VALIDATION_ERROR', 'expiresAt must not precede createdAt');
    }
    this.idempotency.set(composite, record);
    return output({ claimed: true, record });
  }

  getIdempotencyKey({ scope, key } = {}) {
    const record = this.idempotency.get(mapKey(text(scope, 'scope', { max: 256 }), text(key, 'key', { max: 256 })));
    if (!record) return null;
    if (new Date(record.expiresAt) <= new Date(this.clock())) {
      this.idempotency.delete(mapKey(record.scope, record.key));
      return null;
    }
    return output(record);
  }

  completeIdempotencyKey({ scope, key, response, responseStatus } = {}) {
    const normalizedScope = text(scope, 'scope', { max: 256 });
    const normalizedKey = text(key, 'key', { max: 256 });
    const composite = mapKey(normalizedScope, normalizedKey);
    const current = this.idempotency.get(composite);
    if (!current) throw new RepositoryError('NOT_FOUND', 'idempotency key was not found');
    if (responseStatus !== undefined && (!Number.isInteger(responseStatus) || responseStatus < 100 || responseStatus > 599)) {
      throw new RepositoryError('VALIDATION_ERROR', 'responseStatus is invalid');
    }
    const next = { ...current, response: clone(response), responseStatus: responseStatus ?? null };
    this.idempotency.set(composite, next);
    return output(next);
  }

  purgeExpiredIdempotencyKeys({ at } = {}) {
    const now = new Date(at === undefined ? this.clock() : at);
    if (Number.isNaN(now.getTime())) throw new RepositoryError('VALIDATION_ERROR', 'at must be a valid timestamp');
    let removed = 0;
    for (const [key, record] of this.idempotency) {
      if (new Date(record.expiresAt) <= now) {
        this.idempotency.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  appendAuditLog({
    actorUserId = null,
    actorType = 'USER',
    action,
    resourceType,
    resourceId = null,
    requestId = null,
    reason = null,
    before = null,
    after = null,
    metadata = {},
    createdAt
  } = {}) {
    const actor = text(actorUserId, 'actorUserId', { required: false, max: 128 });
    assertStatus(actorType, ACTOR_TYPES, 'actorType');
    if (actor && !this.users.has(actor)) {
      throw new RepositoryError('NOT_FOUND', 'audit actor was not found');
    }
    const record = {
      id: this.nextAuditId++,
      actorUserId: actor,
      actorType,
      action: text(action, 'action', { max: 128 }),
      resourceType: text(resourceType, 'resourceType', { max: 128 }),
      resourceId: text(resourceId, 'resourceId', { required: false, max: 256 }),
      requestId: text(requestId, 'requestId', { required: false, max: 128 }),
      reason: text(reason, 'reason', { required: false, max: 2048 }),
      before: clone(before),
      after: clone(after),
      metadata: clone(metadata ?? {}),
      createdAt: timestamp(createdAt, 'createdAt', this.clock)
    };
    this.auditLogs.push(record);
    return output(record);
  }

  listAuditLogs({ actorUserId, resourceType, resourceId, limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new RepositoryError('VALIDATION_ERROR', 'limit must be between 1 and 1000');
    }
    const actor = actorUserId === undefined ? undefined : text(actorUserId, 'actorUserId', { max: 128 });
    const type = resourceType === undefined ? undefined : text(resourceType, 'resourceType', { max: 128 });
    const id = resourceId === undefined ? undefined : text(resourceId, 'resourceId', { max: 256 });
    return this.auditLogs
      .filter(record => (actor === undefined || record.actorUserId === actor)
        && (type === undefined || record.resourceType === type)
        && (id === undefined || record.resourceId === id))
      .slice(-limit)
      .reverse()
      .map(output);
  }

  health() {
    return Object.freeze({ status: 'ok', backend: 'memory' });
  }

  clear() {
    this.users.clear();
    this.userIdsByPhone.clear();
    this.devices.clear();
    this.sessions.clear();
    this.sessionIdsByAccessHash.clear();
    this.sessionIdsByRefreshHash.clear();
    this.idempotency.clear();
    this.auditLogs.length = 0;
    this.nextAuditId = 1;
  }
}

assertRepository(MemoryRepository.prototype);

export function createMemoryRepository(options) {
  return new MemoryRepository(options);
}
