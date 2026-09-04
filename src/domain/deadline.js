import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../shared/errors.js';

/**
 * A storage-agnostic server deadline scheduler.
 *
 * The scheduler deliberately knows nothing about Mahjong rules. A caller must
 * provide both an explicit deadline (`deadlineAt` or `deadlineMs`) and an
 * explicit `timeoutAction`; otherwise no timer is created. When the timer
 * fires, the action is dispatched through the room registry with optimistic
 * version/round guards so a stale timer cannot advance a newer turn.
 *
 * This is an in-process/fake adapter. Production deployments must replace the
 * timer and dispatch ports with a durable scheduler/actor boundary before
 * claiming multi-instance deadline guarantees.
 */

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const STALE_ERROR_CODES = new Set([
  'VERSION_CONFLICT',
  'ROUND_FINISHED',
  'ROUND_NOT_PLAYING',
  'ROOM_NOT_JOINABLE',
  'PLAYER_NOT_FOUND',
  'NOT_YOUR_TURN'
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (value === undefined || value === null) return value;
  return structuredClone(value);
}

function canonical(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return JSON.stringify(String(value));
    return JSON.stringify(value);
  }
  if (seen.has(value)) throw new TypeError('cyclic deadline input');
  seen.add(value);
  const result = Array.isArray(value)
    ? `[${value.map(item => canonical(item, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
}

// A deadline is materialized independently by every server instance. Derive
// its command correlation ID from the logical deadline while keeping the UUID
// shape required by the wire envelope and downstream idempotency stores.
function stableDeadlineCommandId(deadlineId) {
  const bytes = createHash('sha256').update(`susong:deadline:${deadlineId}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function text(value, field, { max = 256, required = true } = {}) {
  if (value === undefined || value === null) {
    if (!required) return null;
    throw new AppError('INVALID_ACTION', { details: [{ path: field, message: 'is required' }] });
  }
  const normalized = String(value).trim();
  if (!normalized && required) {
    throw new AppError('INVALID_ACTION', { details: [{ path: field, message: 'must not be blank' }] });
  }
  if (!normalized && !required) return null;
  if (normalized.length > max) {
    throw new AppError('INVALID_ACTION', { details: [{ path: field, message: `must be <= ${max} characters` }] });
  }
  return normalized;
}

function nonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new AppError('INVALID_ACTION', { details: [{ path: field, message: 'must be a non-negative integer' }] });
  }
  return value;
}

function nowMillis(clock) {
  const raw = clock();
  if (raw instanceof Date) {
    const value = raw.getTime();
    if (Number.isFinite(value)) return value;
  }
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new AppError('INTERNAL_ERROR', { message: 'Deadline clock returned an invalid time' });
  return value;
}

function deadlineMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return Date.parse(value);
  return Number(value);
}

function normalizeTimeoutAction(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const action = text(value, 'timeoutAction', { max: 64 });
    return { type: 'action', action };
  }
  if (!isRecord(value)) return null;

  // Accept either `{ action, args }` or a command-shaped action carrying its
  // payload. The action name remains mandatory; no implicit default is chosen.
  const payload = isRecord(value.payload) ? clone(value.payload) : {};
  const action = value.action ?? value.name ?? payload.action;
  if (action === undefined || action === null || String(action).trim() === '') return null;
  const type = text(value.type ?? 'action', 'timeoutAction.type', { max: 64 });
  const normalized = { type, action: text(action, 'timeoutAction.action', { max: 64 }) };
  if (value.args !== undefined) normalized.args = clone(value.args);
  if (Object.keys(payload).length > 0) normalized.payload = payload;
  if (value.requestId !== undefined && value.requestId !== null) {
    normalized.requestId = text(value.requestId, 'timeoutAction.requestId', { max: 256 });
  }
  return normalized;
}

function stateRoomVersion(state) {
  const room = state?.room || state?.aggregate || state;
  const value = room?.roomVersion ?? room?.version;
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function stateRoundId(state) {
  const room = state?.room || state?.aggregate || state;
  return room?.roundId ?? room?.currentRound?.roundId ?? room?.round?.roundId ?? null;
}

function errorCode(error) {
  return error?.code || error?.name || error?.message;
}

function publicError(error) {
  if (!error) return null;
  return {
    code: error.code || 'INTERNAL_ERROR',
    message: String(error.message || error)
  };
}

export class DeadlineScheduler {
  constructor({
    dispatch,
    registry,
    getState,
    deadlineStore,
    workerId,
    leaseMs = 30000,
    clock = () => Date.now(),
    setTimeout: scheduleTimer = globalThis.setTimeout,
    clearTimeout: cancelTimer = globalThis.clearTimeout,
    idFactory = randomUUID,
    logger,
    onExpired,
    onTimeout,
    metrics,
    maxTimerDelayMs = MAX_TIMER_DELAY_MS
  } = {}) {
    const resolvedDispatch = typeof dispatch === 'function'
      ? dispatch
      : (typeof registry?.dispatch === 'function' ? registry.dispatch.bind(registry) : null);
    if (!resolvedDispatch) throw new TypeError('DeadlineScheduler requires dispatch or registry.dispatch');
    if (typeof clock !== 'function' || typeof scheduleTimer !== 'function' || typeof cancelTimer !== 'function') {
      throw new TypeError('DeadlineScheduler clock and timer ports must be functions');
    }
    if (typeof idFactory !== 'function') throw new TypeError('DeadlineScheduler idFactory must be a function');
    if (!Number.isInteger(maxTimerDelayMs) || maxTimerDelayMs < 1 || maxTimerDelayMs > MAX_TIMER_DELAY_MS) {
      throw new TypeError('maxTimerDelayMs must be a positive safe timer delay');
    }
    if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new TypeError('DeadlineScheduler leaseMs must be a positive integer');
    this.registry = registry || null;
    this.dispatch = resolvedDispatch;
    this.getState = typeof getState === 'function'
      ? getState
      : (typeof registry?.get === 'function' ? registry.get.bind(registry) : null);
    this.clock = clock;
    this.setTimeout = scheduleTimer;
    this.clearTimeout = cancelTimer;
    this.idFactory = idFactory;
    this.deadlineStore = deadlineStore || registry?.deadlineStore || registry?.eventStore?.deadlineStore || null;
    if (this.deadlineStore) {
      const required = ['upsert', 'get', 'claim', 'complete', 'cancel'];
      const missing = required.filter(method => typeof this.deadlineStore[method] !== 'function');
      if (missing.length > 0) throw new TypeError(`deadlineStore is missing methods: ${missing.join(', ')}`);
    }
    this.workerId = workerId === undefined || workerId === null ? `deadline-worker:${this.idFactory()}` : String(workerId);
    if (!this.workerId.trim()) throw new TypeError('DeadlineScheduler workerId must not be blank');
    this.leaseMs = leaseMs;
    this.logger = logger;
    // `onTimeout` is the server integration name; `onExpired` remains the
    // generic scheduler name so direct adapters can use either spelling.
    this.onExpired = typeof onExpired === 'function'
      ? onExpired
      : (typeof onTimeout === 'function' ? onTimeout : null);
    this.metrics = metrics || null;
    this.maxTimerDelayMs = maxTimerDelayMs;
    this.entries = new Map();
    this.closed = false;
  }

  _normalizeInput(roomOrOptions, options = {}) {
    if (typeof roomOrOptions === 'string' || typeof roomOrOptions === 'number') {
      return { ...options, roomId: roomOrOptions };
    }
    if (!isRecord(roomOrOptions)) throw new AppError('INVALID_ACTION');
    return roomOrOptions;
  }

  _normalizeSchedule(roomOrOptions, options) {
    const input = this._normalizeInput(roomOrOptions, options);
    const roomId = text(input.roomId, 'roomId', { max: 128 });
    const hasDeadlineAt = input.deadlineAt !== undefined && input.deadlineAt !== null;
    const hasDeadlineMs = input.deadlineMs !== undefined && input.deadlineMs !== null;
    // Missing explicit timing or action is an intentional no-op. This keeps
    // unresolved rule decisions from silently acquiring a guessed timeout.
    if ((!hasDeadlineAt && !hasDeadlineMs) || input.timeoutAction === undefined || input.timeoutAction === null) return null;

    const action = normalizeTimeoutAction(input.timeoutAction);
    if (!action) return null;
    const now = nowMillis(this.clock);
    let at;
    if (hasDeadlineAt) {
      at = deadlineMillis(input.deadlineAt);
      if (!Number.isFinite(at)) throw new AppError('INVALID_ACTION', { details: [{ path: 'deadlineAt', message: 'must be a valid timestamp' }] });
    } else {
      const duration = Number(input.deadlineMs);
      if (!Number.isInteger(duration) || duration < 0) {
        throw new AppError('INVALID_ACTION', { details: [{ path: 'deadlineMs', message: 'must be a non-negative integer' }] });
      }
      at = now + duration;
      if (!Number.isSafeInteger(at)) throw new AppError('INVALID_ACTION', { details: [{ path: 'deadlineMs', message: 'is out of range' }] });
    }

    const expectedValue = input.expectedRoomVersion ?? input.roomVersion;
    const expectedRoomVersion = expectedValue === undefined || expectedValue === null
      ? null
      : nonNegativeInteger(expectedValue, 'expectedRoomVersion');
    const roundId = input.roundId === undefined || input.roundId === null
      ? null
      : text(input.roundId, 'roundId', { max: 128 });
    const playerId = input.playerId === undefined || input.playerId === null
      ? null
      : text(input.playerId, 'playerId', { max: 128 });
    const deadlineId = text(input.deadlineId ?? this.idFactory(), 'deadlineId', { max: 256 });
    const commandId = text(input.commandId ?? stableDeadlineCommandId(deadlineId), 'commandId', { max: 256 });
    const normalized = {
      roomId,
      deadlineId,
      commandId,
      deadlineAt: at,
      expectedRoomVersion,
      roundId,
      playerId,
      timeoutAction: action
    };
    return {
      ...normalized,
      fingerprint: canonical(normalized)
    };
  }

  _descriptor(entry) {
    if (!entry) return null;
    return clone({
      deadlineId: entry.deadlineId,
      roomId: entry.roomId,
      commandId: entry.commandId,
      deadlineAt: entry.deadlineAt,
      expectedRoomVersion: entry.expectedRoomVersion,
      roundId: entry.roundId,
      playerId: entry.playerId,
      timeoutAction: entry.timeoutAction,
      status: entry.status,
      ...(entry.reason ? { reason: entry.reason } : {}),
      ...(entry.result !== undefined ? { result: entry.result } : {}),
      ...(entry.error ? { error: entry.error } : {})
    });
  }

  _persist(entry) {
    if (!this.deadlineStore) return Promise.resolve(null);
    const input = {
      deadlineId: entry.deadlineId,
      roomId: entry.roomId,
      commandId: entry.commandId,
      deadlineAt: new Date(entry.deadlineAt).toISOString(),
      expectedRoomVersion: entry.expectedRoomVersion,
      roundId: entry.roundId,
      playerId: entry.playerId,
      timeoutAction: clone(entry.timeoutAction)
    };
    return Promise.resolve()
      .then(() => this.deadlineStore.upsert(input))
      .then(record => {
        entry.persisted = clone(record);
        return record;
      })
      .catch(error => {
        // Keep persistence failures attached to the entry so the timer cannot
        // accidentally execute an action that was never durably registered.
        entry.persistError = error;
        this.logger?.warn?.('room.deadline_persist_failed', {
          roomId: entry.roomId,
          deadlineId: entry.deadlineId,
          code: error?.code,
          message: error?.message
        });
        return null;
      });
  }

  async _completeDurable(entry, status, options = {}) {
    if (!this.deadlineStore || !entry.claim) return null;
    try {
      const result = await this.deadlineStore.complete(entry.deadlineId, {
        ownerId: this.workerId,
        leaseToken: entry.claim.leaseToken,
        status,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
        ...(options.result === undefined ? {} : { result: clone(options.result) }),
        ...(options.error === undefined ? {} : { error: clone(options.error) })
      });
      entry.persisted = clone(result);
      return result;
    } catch (error) {
      this.logger?.warn?.('room.deadline_complete_failed', {
        roomId: entry.roomId,
        deadlineId: entry.deadlineId,
        code: error?.code,
        message: error?.message
      });
      throw error;
    }
  }

  async _claim(entry) {
    if (!this.deadlineStore) return null;
    await entry.persistPromise;
    if (entry.persistError) throw entry.persistError;
    const result = await this.deadlineStore.claim(entry.deadlineId, {
      ownerId: this.workerId,
      now: this.clock(),
      leaseMs: this.leaseMs
    });
    if (result?.claimed) entry.claim = clone(result);
    return result;
  }

  _cancelPersistedRoom(roomId, exceptDeadlineId, reason) {
    if (!this.deadlineStore) return Promise.resolve(null);
    if (typeof this.deadlineStore.cancelRoom === 'function') {
      return Promise.resolve(this.deadlineStore.cancelRoom(roomId, { exceptDeadlineId, reason }))
        .catch(error => {
          this.logger?.warn?.('room.deadline_room_cancel_persist_failed', {
            roomId,
            code: error?.code,
            message: error?.message
          });
          return null;
        });
    }
    if (typeof this.deadlineStore.list !== 'function') return Promise.resolve(null);
    return Promise.resolve(this.deadlineStore.list({
      roomId,
      statuses: ['SCHEDULED']
    })).then(records => Promise.all((records || [])
      .filter(record => record.deadlineId !== exceptDeadlineId)
      .map(record => this.deadlineStore.cancel(record.deadlineId, { reason }))))
      .catch(error => {
        this.logger?.warn?.('room.deadline_room_cancel_persist_failed', {
          roomId,
          code: error?.code,
          message: error?.message
        });
        return null;
      });
  }

  _arm(entry) {
    if (this.closed || entry.status !== 'scheduled') return;
    const wakeAt = entry.retryAt ?? entry.deadlineAt;
    const remaining = Math.max(0, wakeAt - nowMillis(this.clock));
    const delay = Math.min(remaining, this.maxTimerDelayMs);
    try {
      entry.timer = this.setTimeout(() => {
        entry.timer = null;
        if (entry.status !== 'scheduled' || this.closed) return;
        // Node clamps delays above a signed 32-bit integer. Re-arm long
        // deadlines in bounded chunks so an hour/day deadline remains valid.
        if (remaining > this.maxTimerDelayMs) {
          this._arm(entry);
          return;
        }
        entry.retryAt = null;
        return this.expire(entry.deadlineId).catch(error => {
          this.logger?.warn?.('room.deadline_expire_failed', {
            roomId: entry.roomId,
            deadlineId: entry.deadlineId,
            message: error.message
          });
        });
      }, delay);
      entry.timer?.unref?.();
    } catch (error) {
      this.entries.delete(entry.deadlineId);
      throw error;
    }
  }

  /**
   * Schedule one deadline. `schedule(roomId, options)` and
   * `schedule({ roomId, ... })` are both supported. Missing explicit timing
   * or `timeoutAction` returns `null` and creates no timer.
   */
  schedule(roomOrOptions, options = {}) {
    if (this.closed) throw new AppError('RETRYABLE', { message: 'Deadline scheduler is closed' });
    const normalized = this._normalizeSchedule(roomOrOptions, options);
    if (!normalized) return null;
    const previous = this.entries.get(normalized.deadlineId);
    if (previous) {
      if (previous.fingerprint === normalized.fingerprint) return this._descriptor(previous);
      throw new AppError('DUPLICATE_REQUEST', {
        details: [{ deadlineId: normalized.deadlineId, reason: 'deadline id was already used with another request' }]
      });
    }
    const entry = {
      ...normalized,
      status: 'scheduled',
      timer: null,
      reason: null,
      result: undefined,
      error: null
    };
    entry.persistPromise = this._persist(entry);
    this.entries.set(entry.deadlineId, entry);
    this._arm(entry);
    return this._descriptor(entry);
  }

  /**
   * Arm the deadline currently persisted on a Room snapshot. Calling refresh
   * after every room command is idempotent; a changed roomVersion/round gets a
   * new deadline id and the old scheduled entry is cancelled.
   */
  refresh(roomOrActor) {
    if (this.closed) return null;
    const room = roomOrActor?.room || roomOrActor;
    const roomId = room?.roomId || room?.id;
    if (roomId === undefined || roomId === null) return null;
    const id = String(roomId);
    const policy = room?.deadlinePolicy;
    const round = room?.currentRound || room?.round;
    const playerId = room?.turnPlayerId || room?.turn;
    const deadlineAt = round?.turnDeadlineAt;
    const timeoutAction = policy?.timeoutAction;
    const expectedRoomVersion = room?.roomVersion ?? room?.version;
    const roundId = round?.roundId || round?.id;
    if (policy?.enabled !== true || room?.status !== 'playing' || !playerId
      || !deadlineAt || timeoutAction === undefined || timeoutAction === null
      || expectedRoomVersion === undefined || expectedRoomVersion === null) {
      this.cancelRoom(id, 'NO_ACTIVE_DEADLINE');
      this._cancelPersistedRoom(id, null, 'NO_ACTIVE_DEADLINE');
      return null;
    }
    const deadlineId = `turn:${id}:${roundId || 'unknown'}:${expectedRoomVersion}`;
    const existing = this.entries.get(deadlineId);
    if (existing?.status === 'scheduled') return this._descriptor(existing);
    // The same logical deadline should never be armed twice in one process.
    // A new room version receives a different id, so cancelling the older turn
    // cannot collide with the idempotency record.
    this.cancelRoom(id, 'REPLACED');
    const scheduled = this.schedule({
      roomId: id,
      deadlineId,
      deadlineAt,
      timeoutAction,
      playerId,
      expectedRoomVersion,
      roundId
    });
    this._cancelPersistedRoom(id, deadlineId, 'REPLACED');
    return scheduled;
  }

  /** Recover and arm active turn deadlines from all durable room snapshots. */
  async recoverAll() {
    if (this.closed) return [];
    const store = this.registry?.eventStore;
    const roomIds = typeof store?.listRooms === 'function' ? await store.listRooms() : [];
    const armed = [];
    for (const roomId of roomIds || []) {
      try {
        const state = typeof this.registry?.recover === 'function'
          ? await this.registry.recover(roomId)
          : await this._readState(roomId);
        const entry = this.refresh(state?.room || state);
        if (entry) armed.push(entry);
      } catch (error) {
        this.logger?.warn?.('room.deadline_recovery_failed', {
          roomId: String(roomId),
          code: error?.code,
          message: error?.message
        });
      }
    }
    return armed;
  }

  scheduleDeadline(roomOrOptions, options = {}) {
    return this.schedule(roomOrOptions, options);
  }

  _command(entry) {
    const action = entry.timeoutAction;
    const payload = isRecord(action.payload) ? clone(action.payload) : {};
    payload.action = action.action;
    if (action.args !== undefined) payload.args = clone(action.args);
    if (entry.playerId !== null && payload.playerId === undefined) payload.playerId = entry.playerId;
    if (entry.roundId !== null && payload.roundId === undefined) payload.roundId = entry.roundId;
    payload.deadlineId = entry.deadlineId;
    payload.deadlineAt = new Date(entry.deadlineAt).toISOString();
    payload.timeout = true;
    return {
      type: action.type,
      roomId: entry.roomId,
      commandId: entry.commandId,
      ...(action.requestId ? { requestId: action.requestId } : {}),
      ...(entry.expectedRoomVersion === null ? {} : { expectedRoomVersion: entry.expectedRoomVersion }),
      ...(entry.roundId === null ? {} : { roundId: entry.roundId }),
      payload
    };
  }

  async _readState(roomId) {
    if (!this.getState) return null;
    try {
      return await this.getState(roomId);
    } catch (error) {
      // State lookup is an optimization. The command still carries its
      // optimistic guards, so a transient lookup failure must not execute an
      // unguarded action or turn a timer callback into an unhandled rejection.
      this.logger?.debug?.('room.deadline_state_lookup_failed', {
        roomId,
        message: error.message
      });
      return null;
    }
  }

  async _staleReason(entry) {
    const state = await this._readState(entry.roomId);
    if (!state) return null;
    if (entry.expectedRoomVersion !== null) {
      const actual = stateRoomVersion(state);
      if (actual !== null && actual !== entry.expectedRoomVersion) {
        return { code: 'VERSION_CONFLICT', expectedRoomVersion: entry.expectedRoomVersion, actualRoomVersion: actual };
      }
    }
    if (entry.roundId !== null) {
      const actual = stateRoundId(state);
      if (actual !== null && String(actual) !== String(entry.roundId)) {
        return { code: 'ROUND_CONFLICT', expectedRoundId: entry.roundId, actualRoundId: actual };
      }
    }
    return null;
  }

  async _notify(entry, descriptor) {
    this.metrics?.increment?.('room_deadlines_total', { status: descriptor.status });
    if (!this.onExpired) return;
    try {
      await this.onExpired({ ...descriptor, command: this._command(entry) });
    } catch (error) {
      this.logger?.warn?.('room.deadline_callback_failed', {
        roomId: entry.roomId,
        deadlineId: entry.deadlineId,
        message: error.message
      });
    }
  }

  /** Execute a scheduled deadline once. Primarily exposed for deterministic tests. */
  async expire(deadlineId) {
    const id = text(deadlineId, 'deadlineId', { max: 256 });
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.status !== 'scheduled') return this._descriptor(entry);
    if (entry.timer !== null && entry.timer !== undefined) {
      this.clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.status = 'firing';
    let claim;
    try {
      claim = await this._claim(entry);
    } catch (error) {
      entry.status = 'failed';
      entry.reason = 'PERSISTENCE_FAILED';
      entry.error = publicError(error);
      const descriptor = this._descriptor(entry);
      await this._notify(entry, descriptor);
      return descriptor;
    }
    if (this.deadlineStore && !claim) {
      entry.status = 'failed';
      entry.reason = 'CLAIM_FAILED';
      entry.error = publicError(new Error('deadline store returned no claim result'));
      const descriptor = this._descriptor(entry);
      await this._notify(entry, descriptor);
      return descriptor;
    }
    if (claim && !claim.claimed) {
      const retryAt = claim.reason === 'LEASE_HELD'
        ? (claim.record?.leaseExpiresAt ? Date.parse(claim.record.leaseExpiresAt) : null)
        : claim.reason === 'NOT_DUE'
          ? (claim.record?.deadlineAt ? Date.parse(claim.record.deadlineAt) : null)
          : null;
      if (retryAt !== null && Number.isFinite(retryAt) && retryAt > nowMillis(this.clock)) {
        entry.status = 'scheduled';
        entry.reason = claim.reason;
        entry.result = clone(claim.record);
        entry.error = null;
        entry.retryAt = retryAt;
        this._arm(entry);
        return this._descriptor(entry);
      }
      entry.status = 'skipped';
      entry.reason = claim.reason || 'CLAIMED_ELSEWHERE';
      entry.result = clone(claim.record);
      entry.error = null;
      const descriptor = this._descriptor(entry);
      await this._notify(entry, descriptor);
      return descriptor;
    }
    const stale = await this._staleReason(entry);
    if (stale) {
      entry.status = 'stale';
      entry.reason = stale.code;
      entry.error = null;
      if (claim) {
        try {
          await this._completeDurable(entry, 'STALE', { reason: stale.code });
        } catch (error) {
          entry.status = 'failed';
          entry.reason = 'CLAIM_LOST';
          entry.error = publicError(error);
        }
      }
      const descriptor = this._descriptor(entry);
      await this._notify(entry, descriptor);
      return descriptor;
    }

    const command = this._command(entry);
    try {
      const result = await this.dispatch(entry.roomId, command, {
        actorId: entry.playerId,
        actorRole: 'SYSTEM',
        source: 'deadline',
        deadlineId: entry.deadlineId,
        expectedRoomVersion: entry.expectedRoomVersion,
        roundId: entry.roundId
      });
      entry.status = 'executed';
      entry.result = clone(result);
      entry.error = null;
      if (claim) {
        try {
          await this._completeDurable(entry, 'EXECUTED', { result });
        } catch (error) {
          entry.status = 'failed';
          entry.reason = 'CLAIM_LOST';
          entry.error = publicError(error);
        }
      }
      const descriptor = this._descriptor(entry);
      await this._notify(entry, descriptor);
      return descriptor;
    } catch (error) {
      const code = errorCode(error);
      entry.status = STALE_ERROR_CODES.has(code) ? 'stale' : 'failed';
      entry.reason = STALE_ERROR_CODES.has(code) ? code : 'DISPATCH_FAILED';
      entry.error = publicError(error);
      if (claim) {
        try {
          await this._completeDurable(entry, STALE_ERROR_CODES.has(code) ? 'STALE' : 'FAILED', {
            reason: entry.reason,
            error: entry.error
          });
        } catch (completionError) {
          entry.status = 'failed';
          entry.reason = 'CLAIM_LOST';
          entry.error = publicError(completionError);
        }
      }
      const descriptor = this._descriptor(entry);
      await this._notify(entry, descriptor);
      return descriptor;
    }
  }

  runNow(deadlineId) {
    return this.expire(deadlineId);
  }

  get(deadlineId) {
    if (deadlineId === undefined || deadlineId === null) return null;
    return this._descriptor(this.entries.get(String(deadlineId)));
  }

  list({ roomId, status } = {}) {
    const normalizedRoomId = roomId === undefined || roomId === null ? null : String(roomId);
    return [...this.entries.values()]
      .filter(entry => (normalizedRoomId === null || entry.roomId === normalizedRoomId)
        && (status === undefined || entry.status === status))
      .map(entry => this._descriptor(entry));
  }

  cancel(deadlineId, reason = 'CANCELLED') {
    const id = text(deadlineId, 'deadlineId', { max: 256 });
    const entry = this.entries.get(id);
    if (!entry || entry.status !== 'scheduled') return false;
    if (entry.timer !== null && entry.timer !== undefined) this.clearTimeout(entry.timer);
    entry.timer = null;
    entry.status = 'cancelled';
    entry.reason = String(reason);
    if (this.deadlineStore) {
      entry.cancelPromise = Promise.resolve(entry.persistPromise)
        .then(() => this.deadlineStore.cancel(entry.deadlineId, { reason: String(reason) }))
        .catch(error => {
          this.logger?.warn?.('room.deadline_cancel_persist_failed', {
            roomId: entry.roomId,
            deadlineId: entry.deadlineId,
            code: error?.code,
            message: error?.message
          });
          return null;
        });
    }
    return true;
  }

  cancelRoom(roomId, reason = 'ROOM_CANCELLED') {
    const id = text(roomId, 'roomId', { max: 128 });
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.roomId === id && this.cancel(entry.deadlineId, reason)) count += 1;
    }
    return count;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.entries.values()) {
      if (entry.status === 'scheduled') this.cancel(entry.deadlineId, 'SCHEDULER_CLOSED');
    }
  }

  dispose() {
    return this.close();
  }
}

export const RoomDeadlineScheduler = DeadlineScheduler;

export function createDeadlineScheduler(options = {}) {
  return new DeadlineScheduler(options);
}

export function createRoomDeadlineScheduler(options = {}) {
  return new DeadlineScheduler(options);
}

export { MAX_TIMER_DELAY_MS };
