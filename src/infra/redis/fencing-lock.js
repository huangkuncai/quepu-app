import { randomUUID } from 'node:crypto';
import { RepositoryError } from '../persistence/contracts.js';

function keyPart(value, field) {
  if (value === undefined || value === null || String(value).trim() === '') throw new RepositoryError('VALIDATION_ERROR', `${field} is required`);
  return String(value).trim();
}

function token(value, required = false) {
  const candidate = value && typeof value === 'object' ? (value.fencingToken ?? value.token) : value;
  if (candidate === undefined || candidate === null) {
    if (required) throw new RepositoryError('FENCING_TOKEN_REQUIRED', 'fencingToken is required');
    return null;
  }
  const parsed = Number(candidate);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new RepositoryError('VALIDATION_ERROR', 'fencingToken must be a positive integer');
  return parsed;
}

function parseLease(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

/** Redis fencing lock using SET NX PX and Lua compare-and-delete. */
export class RedisFencingLock {
  constructor({ client, prefix = 'susong:room-lock:', fencePrefix = 'susong:room-fence:', leaseMs = 30000, idFactory = randomUUID } = {}) {
    this.client = client;
    if (!client || typeof client.get !== 'function' || typeof client.set !== 'function' || typeof client.incr !== 'function') throw new TypeError('RedisFencingLock requires get/set/incr methods');
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new TypeError('leaseMs must be positive');
    this.prefix = prefix;
    this.fencePrefix = fencePrefix;
    this.leaseMs = leaseMs;
    this.idFactory = idFactory;
  }

  _key(roomId) { return `${this.prefix}${keyPart(roomId, 'roomId')}`; }
  _fenceKey(roomId) { return `${this.fencePrefix}${keyPart(roomId, 'roomId')}`; }

  async _setNx(key, value, ttl) {
    try {
      const result = await this.client.set(key, value, { NX: true, PX: ttl });
      if (result !== undefined) return result === true || String(result).toUpperCase() === 'OK';
    } catch (error) {
      if (!/argument|option|syntax/i.test(error.message || '')) throw error;
    }
    const result = await this.client.set(key, value, 'PX', ttl, 'NX');
    return result === true || String(result).toUpperCase() === 'OK';
  }

  async acquire(roomIdInput, options = {}) {
    if (roomIdInput && typeof roomIdInput === 'object') { options = { ...roomIdInput, ...options }; roomIdInput = options.roomId; }
    const roomId = keyPart(roomIdInput, 'roomId');
    const ownerId = keyPart(options.ownerId || options.actorId || this.idFactory(), 'ownerId');
    const leaseMs = options.leaseMs === undefined ? this.leaseMs : options.leaseMs;
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new RepositoryError('VALIDATION_ERROR', 'leaseMs must be positive');
    const current = parseLease(await this.client.get(this._key(roomId)));
    if (current?.ownerId === ownerId) return current;
    const fencingToken = Number(await this.client.incr(this._fenceKey(roomId)));
    const acquiredAt = new Date().toISOString();
    const record = { roomId, ownerId, fencingToken, token: fencingToken, acquiredAt, expiresAt: new Date(Date.now() + leaseMs).toISOString() };
    if (!(await this._setNx(this._key(roomId), JSON.stringify(record), leaseMs))) throw new RepositoryError('LOCK_BUSY', 'room lock is held by another actor', [{ roomId }]);
    return record;
  }

  async assert(roomIdInput, fencingToken) {
    if (roomIdInput && typeof roomIdInput === 'object') { fencingToken = roomIdInput.fencingToken ?? roomIdInput.token ?? fencingToken; roomIdInput = roomIdInput.roomId; }
    const roomId = keyPart(roomIdInput, 'roomId');
    const expected = token(fencingToken, true);
    const current = parseLease(await this.client.get(this._key(roomId)));
    if (!current) throw new RepositoryError('LOCK_NOT_HELD', 'room lock is not held', [{ roomId }]);
    if (Number(current.fencingToken) !== expected) throw new RepositoryError('FENCING_TOKEN_STALE', 'fencing token is stale', [{ roomId, fencingToken: expected }]);
    return current;
  }

  async release(roomIdInput, fencingToken) {
    if (roomIdInput && typeof roomIdInput === 'object') { fencingToken = roomIdInput.fencingToken ?? roomIdInput.token ?? fencingToken; roomIdInput = roomIdInput.roomId; }
    const roomId = keyPart(roomIdInput, 'roomId');
    const expected = token(fencingToken, true);
    const script = 'local v=redis.call("GET",KEYS[1]); if not v then return 0 end; local p=cjson.decode(v); if tonumber(p.fencingToken) ~= tonumber(ARGV[1]) then return -1 end; return redis.call("DEL",KEYS[1])';
    let result;
    if (typeof this.client.eval === 'function') {
      try {
        result = await this.client.eval(script, { keys: [this._key(roomId)], arguments: [String(expected)] });
      } catch (error) {
        if (!/argument|option|syntax/i.test(error.message || '') || typeof this.client.eval !== 'function') throw error;
        result = await this.client.eval(script, 1, this._key(roomId), String(expected));
      }
    } else {
      if (typeof this.client.del !== 'function') throw new TypeError('Redis client requires eval() or del() for release');
      await this.assert(roomId, expected);
      result = await this.client.del(this._key(roomId));
    }
    if (Number(result) === -1) throw new RepositoryError('FENCING_TOKEN_STALE', 'fencing token is stale', [{ roomId, fencingToken: expected }]);
    return Number(result) === 1;
  }

  assertFencingToken(roomId, fencingToken) { return this.assert(roomId, fencingToken); }
  releaseFencing(roomId, fencingToken) { return this.release(roomId, fencingToken); }
  async current(roomId) { return parseLease(await this.client.get(this._key(roomId))); }
}

export function createRedisFencingLock(options = {}) { return new RedisFencingLock(options); }

/** Optional runtime loader for node-redis. Tests and other clients inject their own client. */
export async function createRedisClient({ url, ...options } = {}) {
  if (!url) throw new RepositoryError('CONFIG_INVALID', 'REDIS_URL is required for Redis');
  try {
    const module = await import('redis');
    const createClient = module.createClient || module.default?.createClient;
    if (!createClient) throw new Error('redis.createClient is unavailable');
    const client = createClient({ url, ...options });
    await client.connect();
    return client;
  } catch (error) {
    throw new RepositoryError('CONFIG_INVALID', 'Redis adapter requires the optional redis dependency', error);
  }
}
