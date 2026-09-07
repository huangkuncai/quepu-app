import { createHash, randomUUID } from 'node:crypto';
import { Room, stableCommandString } from './room.js';
import { AppError, asAppError } from '../shared/errors.js';

/**
 * A small, storage-agnostic room actor.
 *
 * The actor owns ordering; the event store owns durability.  Both interfaces
 * are deliberately promise-friendly so the in-memory adapter can be swapped
 * for PostgreSQL/Redis without changing command handlers.  A command is never
 * executed while another command for this actor is running, and every write is
 * fenced with the lease token acquired for this invocation.
 */

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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

function presenceFromSnapshot(snapshot) {
  const result = {};
  for (const player of Array.isArray(snapshot?.players) ? snapshot.players : []) {
    const playerId = player?.id ?? player?.playerId;
    if (playerId === undefined || playerId === null) continue;
    result[String(playerId)] = {
      connected: player.connected !== false,
      disconnectedAt: player.connected === false ? (player.disconnectedAt || null) : null
    };
  }
  return result;
}

function text(value, field, { required = true, max = 256 } = {}) {
  if (value === undefined || value === null) {
    if (!required) return null;
    throw new AppError('INVALID_ACTION', { details: [{ path: field, message: 'is required' }] });
  }
  const normalized = String(value).trim();
  if (!normalized && required) throw new AppError('INVALID_ACTION', { details: [{ path: field, message: 'must not be blank' }] });
  if (!normalized && !required) return null;
  if (normalized.length > max) throw new AppError('INVALID_ACTION', { details: [{ path: field, message: `must be <= ${max} characters` }] });
  return normalized;
}

function hash(value) {
  return createHash('sha256').update(stableCommandString(value)).digest('hex');
}

function commandType(command) {
  const value = command?.type || command?.name || command?.command;
  return value === undefined || value === null ? '' : String(value).trim().toLowerCase();
}

function commandRoomId(command, fallback) {
  const payload = isRecord(command?.payload) ? command.payload : {};
  return command?.roomId ?? payload.roomId ?? fallback;
}

function normalizeCommand(command, context, fallbackRoomId, idFactory) {
  if (!isRecord(command)) throw new AppError('INVALID_MESSAGE');
  const payload = isRecord(command.payload) ? clone(command.payload) : {};
  const type = commandType(command);
  if (!type) throw new AppError('INVALID_MESSAGE');
  const roomId = text(commandRoomId(command, fallbackRoomId), 'roomId', { max: 128 });
  if (fallbackRoomId && roomId !== fallbackRoomId) throw new AppError('INVALID_ACTION');
  const actorId = context.actorId ?? command.actorId ?? payload.actorId ?? payload.playerId ?? payload.userId;
  const commandId = command.commandId ?? context.commandId;
  const requestId = command.requestId ?? context.requestId;
  const expectedRoomVersion = command.expectedRoomVersion
    ?? command.roomVersion
    ?? context.expectedRoomVersion;
  const normalized = {
    ...clone(command),
    type,
    roomId,
    payload,
    ...(actorId === undefined || actorId === null ? {} : { actorId: text(actorId, 'actorId', { max: 128 }) }),
    ...(commandId === undefined || commandId === null ? {} : { commandId: text(commandId, 'commandId', { max: 256 }) }),
    ...(requestId === undefined || requestId === null ? {} : { requestId: text(requestId, 'requestId', { max: 256 }) }),
    ...(expectedRoomVersion === undefined || expectedRoomVersion === null ? {} : { expectedRoomVersion })
  };
  if (!normalized.commandId && idFactory) normalized.commandId = text(idFactory(), 'commandId', { max: 256 });
  return normalized;
}

function requestHash(command, context) {
  if (command.requestHash !== undefined && command.requestHash !== null) {
    return text(command.requestHash, 'requestHash', { max: 256 });
  }
  // Correlation IDs are transport metadata and must not make a retry look like
  // a new request. Keep actor identity and the optimistic version in the hash.
  return hash({
    type: command.type,
    roomId: command.roomId,
    actorId: command.actorId ?? context.actorId ?? null,
    expectedRoomVersion: command.expectedRoomVersion ?? null,
    payload: command.payload
  });
}

function repositoryCode(error) {
  return error?.code || error?.name;
}

const REPOSITORY_ERROR_CODES = new Set([
  'VALIDATION_ERROR',
  'UNIQUE_VIOLATION',
  'NOT_FOUND',
  'CONFLICT',
  'VERSION_CONFLICT',
  'DUPLICATE_REQUEST',
  'FENCING_TOKEN_REQUIRED',
  'FENCING_TOKEN_STALE',
  'LOCK_BUSY',
  'LOCK_NOT_HELD',
  'LOCK_EXPIRED',
  'IDEMPOTENCY_CONFLICT'
]);

function isNotFound(error) {
  return repositoryCode(error) === 'NOT_FOUND' || repositoryCode(error) === 'ROOM_NOT_FOUND';
}

function isSameHash(record, requestHashValue) {
  return record && (record.requestHash === requestHashValue || record.requestHash === record.hash && record.hash === requestHashValue);
}

function invoke(target, method, ...args) {
  if (!target || typeof target[method] !== 'function') return undefined;
  return target[method](...args);
}

export class RoomActor {
  constructor({
    roomId,
    room,
    eventStore,
    store,
    roomStore,
    lock,
    outbox,
    roomFactory,
    clock = () => Date.now(),
    idFactory = randomUUID,
    actorId,
    ownerId,
    historyLimit = 2048,
    snapshotEvery = 1
  } = {}) {
    this.eventStore = eventStore || store || roomStore;
    if (!this.eventStore) throw new TypeError('RoomActor requires an eventStore');
    for (const method of ['getEvents', 'getSnapshot', 'getCommandResult', 'saveCommandResult']) {
      if (typeof this.eventStore[method] !== 'function') throw new TypeError(`eventStore is missing ${method}`);
    }
    this.lock = lock || this.eventStore.lock || null;
    if (this.lock) {
      for (const method of ['acquire', 'assert', 'release']) {
        if (typeof this.lock[method] !== 'function') throw new TypeError(`lock is missing ${method}`);
      }
    }
    this.outbox = outbox || this.eventStore.outbox || null;
    this.clock = clock;
    this.idFactory = idFactory;
    this.historyLimit = historyLimit;
    this.snapshotEvery = Number.isInteger(snapshotEvery) && snapshotEvery > 0 ? snapshotEvery : 1;
    this.actorId = text(actorId || ownerId || `room-actor-${idFactory()}`, 'actorId', { max: 256 });
    this.roomId = roomId || room?.id || room?.roomId || null;
    this.roomFactory = typeof roomFactory === 'function' ? roomFactory : null;
    this._room = room || null;
    if (!this.roomId && this._room) this.roomId = this._room.id;
    this.roomId = text(this.roomId, 'roomId', { max: 128 });
    this._persistedVersion = null;
    this._fencingToken = null;
    this._tail = Promise.resolve();
    this._recovering = null;
  }

  get room() {
    return this._room;
  }

  get version() {
    return this._room?.roomVersion ?? 0;
  }

  get roomVersion() {
    return this.version;
  }

  snapshot(options = {}) {
    if (!this._room) return null;
    return output(this._room.snapshot(options));
  }

  /** Queue recovery behind any in-flight command. */
  recover(roomId = this.roomId) {
    if (roomId !== this.roomId) throw new AppError('ROOM_NOT_FOUND');
    const task = this._tail.then(() => this._recoverNow());
    this._tail = task.catch(() => undefined);
    return task;
  }

  async _recoverNow() {
    if (this._recovering) return this._recovering;
    this._recovering = (async () => {
      const storedSnapshot = await this.eventStore.getSnapshot(this.roomId);
      const latestVersion = typeof this.eventStore.getLatestVersion === 'function'
        ? await this.eventStore.getLatestVersion(this.roomId)
        : null;
      const snapshotVersion = storedSnapshot?.roomVersion ?? storedSnapshot?.version ?? 0;
      if (!Number.isInteger(snapshotVersion) || snapshotVersion < 0) throw new AppError('VERSION_CONFLICT');
      const events = await this.eventStore.getEvents(this.roomId, {
        afterVersion: snapshotVersion,
        throughVersion: latestVersion === null || latestVersion === undefined ? undefined : latestVersion
      });
      const tail = Array.isArray(events) ? events : [];
      let base = null;

      if (storedSnapshot) {
        base = await this._makeRoomFromSnapshot(storedSnapshot);
      } else if (this._room && this._room.version === 0 && snapshotVersion === 0) {
        base = this._room;
      } else if (this._room && snapshotVersion === 0 && (latestVersion === null || latestVersion === 0)) {
        base = this._room;
      } else if (this.roomFactory) {
        base = await this.roomFactory({ roomId: this.roomId, snapshot: null, events: tail });
      }

      // A freshly-created actor may be handed a room that already contains
      // local events. Bootstrap those facts once; subsequent recoveries use
      // the durable stream instead of that object.
      if (!storedSnapshot && (!latestVersion || latestVersion === 0) && base && base.version > 0 && tail.length === 0) {
        this._room = base;
        this._persistedVersion = 0;
        return this._room;
      }
      if (!base) {
        if (tail.length === 0 && (!latestVersion || latestVersion === 0)) {
          throw new AppError('ROOM_NOT_FOUND');
        }
        throw new AppError('VERSION_CONFLICT', { details: [{ roomId: this.roomId, reason: 'no room snapshot factory' }] });
      }
      this._room = base;
      // The snapshot is a complete state checkpoint. Apply only its contiguous
      // tail and reject gaps, duplicate versions, or a stale store response.
      let expected = snapshotVersion + 1;
      for (const event of tail) {
        const eventVersion = event?.roomVersion ?? event?.version;
        if (eventVersion !== expected) {
          throw new AppError('VERSION_CONFLICT', {
            details: [{ roomId: this.roomId, expectedRoomVersion: expected, actualRoomVersion: eventVersion }]
          });
        }
        this._room.applyPersistedEvent(event);
        expected += 1;
      }
      const durableVersion = latestVersion === null || latestVersion === undefined
        ? (tail.at(-1)?.roomVersion ?? snapshotVersion)
        : latestVersion;
      await this._restorePresence(this._room, durableVersion);
      if (this._room.version !== durableVersion) {
        throw new AppError('VERSION_CONFLICT', {
          details: [{ roomId: this.roomId, roomVersion: this._room.version, durableVersion }]
        });
      }
      this._persistedVersion = durableVersion;
      return this._room;
    })();
    try {
      return await this._recovering;
    } finally {
      this._recovering = null;
    }
  }

  async _restorePresence(room, durableVersion) {
    if (typeof this.eventStore.getPresence !== 'function') return;
    const checkpoint = await this.eventStore.getPresence(this.roomId);
    if (!checkpoint) return;
    const checkpointVersion = checkpoint.roomVersion ?? checkpoint.version ?? 0;
    if (!Number.isInteger(checkpointVersion) || checkpointVersion < 0) {
      throw new AppError('VERSION_CONFLICT', {
        details: [{ roomId: this.roomId, reason: 'presence checkpoint has an invalid version' }]
      });
    }
    if (checkpointVersion > durableVersion) {
      throw new AppError('VERSION_CONFLICT', {
        details: [{ roomId: this.roomId, presenceVersion: checkpointVersion, durableVersion }]
      });
    }
    const presence = checkpoint.presence;
    if (!isRecord(presence)) {
      throw new AppError('VERSION_CONFLICT', {
        details: [{ roomId: this.roomId, reason: 'presence checkpoint is not an object' }]
      });
    }
    for (const [playerId, state] of Object.entries(presence)) {
      if (!isRecord(state) || typeof state.connected !== 'boolean') {
        throw new AppError('VERSION_CONFLICT', {
          details: [{ roomId: this.roomId, playerId, reason: 'presence state is invalid' }]
        });
      }
      if (!room.players.has(playerId)) continue;
      room.setConnected(playerId, state.connected, {
        at: state.disconnectedAt || undefined
      });
    }
  }

  async _makeRoomFromSnapshot(snapshot) {
    if (this.roomFactory) {
      const result = await this.roomFactory({ roomId: this.roomId, snapshot: output(snapshot) });
      if (result) {
        // A factory may only know how to construct a rule-specific Room shell.
        // Hydrate that shell here unless it explicitly restored the checkpoint.
        if (typeof result.restoreSnapshot === 'function') {
          const resultVersion = result.version ?? result.roomVersion ?? 0;
          if (resultVersion === 0 && (snapshot.roomVersion ?? snapshot.version ?? 0) > 0) {
            result.restoreSnapshot(snapshot, { historyLimit: this.historyLimit });
          }
        }
        const resultVersion = result.version ?? result.roomVersion;
        const snapshotVersion = snapshot.roomVersion ?? snapshot.version ?? 0;
        if (resultVersion !== snapshotVersion) {
          throw new AppError('VERSION_CONFLICT', {
            details: [{ roomId: this.roomId, snapshotVersion, restoredVersion: resultVersion }]
          });
        }
        return result;
      }
    }
    return Room.fromSnapshot(snapshot, {
      clock: this.clock,
      idFactory: this.idFactory,
      historyLimit: this.historyLimit
    });
  }

  async _acquire() {
    if (!this.lock) return null;
    const lease = await this.lock.acquire(this.roomId, { ownerId: this.actorId });
    const token = lease?.fencingToken ?? lease?.token ?? lease;
    if (token === undefined || token === null) throw new AppError('INTERNAL_ERROR', { message: 'lock did not return fencing token' });
    this._fencingToken = token;
    return token;
  }

  async _assertLock(token) {
    if (this.lock) await this.lock.assert(this.roomId, token);
  }

  async _release(token) {
    if (!this.lock || token === null || token === undefined) return;
    try {
      await this.lock.release(this.roomId, token);
    } finally {
      if (this._fencingToken === token) this._fencingToken = null;
    }
  }

  async _findStoredCommand(command, requestHashValue) {
    const record = await this.eventStore.getCommandResult(this.roomId, command.commandId);
    if (record) {
      if (!isSameHash(record, requestHashValue)) {
        throw new AppError('DUPLICATE_REQUEST', {
          details: [{ commandId: command.commandId, reason: 'commandId was already used with another request' }]
        });
      }
      return output(record.result ?? record.response ?? record);
    }
    // A process can crash after appending the event but before recording the
    // result. Treat an event bearing the commandId as the durable evidence and
    // synthesize the same ACK from the recovered state on retry.
    const durableEvents = await this.eventStore.getEvents(this.roomId, { afterVersion: 0 });
    const matching = (durableEvents || []).filter(event => event.commandId === command.commandId);
    if (matching.length > 0) {
      const latest = matching.at(-1);
      if (latest.requestHash && latest.requestHash !== requestHashValue) {
        throw new AppError('DUPLICATE_REQUEST', {
          details: [{ commandId: command.commandId, reason: 'commandId was already used with another request' }]
        });
      }
      // `requestHash` is an internal persistence guard added by
      // `_appendEvents`; it is not part of the aggregate event returned by
      // `Room.execute`.  Remove it when synthesizing an ACK during the crash
      // gap (event committed, command-result row not yet committed), so a
      // cross-instance retry receives the same response shape as the original
      // caller.  Keeping the guard in the durable row still lets us reject a
      // commandId reused with a different payload.
      const replayEvent = clone(latest);
      delete replayEvent.requestHash;
      const result = {
        accepted: true,
        event: output(replayEvent),
        // Preserve the correlation metadata that was durably written with
        // the event when a retry omits (or rotates) its transport requestId.
        // `requestHash` intentionally excludes requestId, so this is a valid
        // idempotent replay rather than a new request.
        requestId: latest.requestId ?? command.requestId,
        commandId: latest.commandId ?? command.commandId,
        roomVersion: this._room.version,
        version: this._room.version,
        snapshot: this._room.snapshot()
      };
      return { recovered: true, result: output(result) };
    }
    return null;
  }

  async _appendEvents(events, snapshot, command, token, requestHashValue = null) {
    if (!events.length) return;
    const items = events.map((event, index) => ({
      roomId: this.roomId,
      roomVersion: event.roomVersion ?? event.version,
      event: requestHashValue ? { ...clone(event), requestHash: requestHashValue } : event,
      // A snapshot is attached to the last event so an appendBatch adapter can
      // commit event, checkpoint and outbox message as one unit.
      ...(index === events.length - 1 && snapshot ? { snapshot } : {}),
      commandId: command.commandId,
      requestId: command.requestId,
      fencingToken: token
    }));
    if (typeof this.eventStore.appendBatch === 'function') {
      await this.eventStore.appendBatch(items, { fencingToken: token });
      return;
    }
    for (const item of items) await this.eventStore.append(item);
    if (snapshot && typeof this.eventStore.saveSnapshot === 'function') {
      await this.eventStore.saveSnapshot({ roomId: this.roomId, snapshot, roomVersion: snapshot.roomVersion, fencingToken: token });
    }
  }

  async _bootstrapInitialEvents(token) {
    if (!this._room || this._room.version < 1 || this._persistedVersion !== 0) return;
    const events = this._room.events;
    if (!events.length || events[0].roomVersion > 1) {
      throw new AppError('VERSION_CONFLICT', { details: [{ reason: 'initial aggregate history is incomplete' }] });
    }
    const snapshot = this._room.persistenceSnapshot();
    await this._appendEvents(events, snapshot, { commandId: null, requestId: null }, token);
    this._persistedVersion = this._room.version;
  }

  async _saveCommandResult(command, requestHashValue, result, token) {
    const input = {
      roomId: this.roomId,
      commandId: command.commandId,
      requestHash: requestHashValue,
      result: output(result),
      roomVersion: result.roomVersion ?? this._room.version,
      fencingToken: token
    };
    try {
      const saved = await this.eventStore.saveCommandResult(input);
      return output(saved?.result ?? saved?.response ?? result);
    } catch (error) {
      if (repositoryCode(error) === 'DUPLICATE_REQUEST') {
        const existing = await this.eventStore.getCommandResult(this.roomId, command.commandId);
        if (existing && isSameHash(existing, requestHashValue)) return output(existing.result ?? existing.response ?? result);
      }
      throw error;
    }
  }

  async _restoreAfterFailedPersistence(beforeSnapshot, beforeVersion, afterVersion) {
    if (!beforeSnapshot || !this._room || afterVersion <= beforeVersion) return;
    let durableVersion = null;
    try {
      if (typeof this.eventStore.getLatestVersion === 'function') {
        durableVersion = await this.eventStore.getLatestVersion(this.roomId);
      }
    } catch {
      // Preserve the original persistence error. The next actor invocation
      // will retry recovery against the durable store.
    }
    if (durableVersion !== null && durableVersion > beforeVersion) {
      // The write may have committed before a later step failed (for example,
      // saving the command response). Rebuild from the durable stream instead
      // of discarding an event that is already authoritative.
      this._persistedVersion = null;
      await this._recoverNow();
      return;
    }
    // No durable event reached the command version. Restore the checkpoint
    // captured before executing the command so a retry sees the same state.
    this._room = await this._makeRoomFromSnapshot(beforeSnapshot);
    this._persistedVersion = beforeVersion;
  }

  async _dispatchNow(rawCommand, context = {}) {
    const command = normalizeCommand(rawCommand, context, this.roomId, this.idFactory);
    const requestHashValue = requestHash(command, context);
    const existing = await this.eventStore.getCommandResult(this.roomId, command.commandId);
    if (existing) {
      if (!isSameHash(existing, requestHashValue)) {
        throw new AppError('DUPLICATE_REQUEST', { details: [{ commandId: command.commandId }] });
      }
      return output(existing.result ?? existing.response ?? existing);
    }

    const token = await this._acquire();
    try {
      await this._assertLock(token);
      await this._recoverNow();
      await this._bootstrapInitialEvents(token);
      const recovered = await this._findStoredCommand(command, requestHashValue);
      if (recovered) {
        const replay = recovered.recovered ? recovered.result : recovered;
        if (recovered.recovered) {
          // Best effort persistence closes the crash gap; the original event
          // remains authoritative if this write is interrupted again.
          await this._saveCommandResult(command, requestHashValue, replay, token);
        }
        return output(replay);
      }

      const beforeVersion = this._room.version;
      const beforeSnapshot = this._room.persistenceSnapshot();
      let afterVersion = beforeVersion;
      try {
        const result = await this._room.execute(command, {
          ...context,
          actorId: command.actorId ?? context.actorId,
          commandId: command.commandId,
          requestId: command.requestId,
          expectedRoomVersion: command.expectedRoomVersion,
          fencingToken: token
        });
        afterVersion = this._room.version;
        if (afterVersion < beforeVersion) throw new AppError('VERSION_CONFLICT');
        const events = this._room.events.filter(event => (event.roomVersion ?? event.version) > (this._persistedVersion ?? beforeVersion));
        if (events.length !== afterVersion - (this._persistedVersion ?? beforeVersion)) {
          throw new AppError('VERSION_CONFLICT', { details: [{ reason: 'aggregate event history is incomplete' }] });
        }
        const afterSnapshot = this._room.persistenceSnapshot();
        // Presence commands intentionally do not advance roomVersion, but
        // their connected/disconnected flags still need to survive actor
        // recovery. Persist a same-version checkpoint when the aggregate
        // state changed without producing an event.
        const stateChangedWithoutEvent = events.length === 0
          && stableCommandString(beforeSnapshot) !== stableCommandString(afterSnapshot);
        const containsPrivateStateChange = events.some(event => event.type === 'SUSONG_ROUND_DEALT');
        const shouldSnapshot = (events.length > 0 && (
          containsPrivateStateChange
          || this.snapshotEvery === 1
          || afterVersion % this.snapshotEvery === 0
          || !await this.eventStore.getSnapshot(this.roomId)
        )) || stateChangedWithoutEvent;
        const snapshot = shouldSnapshot ? afterSnapshot : null;
        await this._assertLock(token);
        await this._appendEvents(events, snapshot, command, token, requestHashValue);
        if (snapshot && events.length === 0) {
          if (typeof this.eventStore.savePresence === 'function') {
            await this.eventStore.savePresence({
              roomId: this.roomId,
              roomVersion: afterVersion,
              presence: presenceFromSnapshot(snapshot),
              fencingToken: token
            });
          } else if (typeof this.eventStore.saveSnapshot === 'function') {
            await this.eventStore.saveSnapshot({
              roomId: this.roomId,
              snapshot,
              roomVersion: afterVersion,
              fencingToken: token,
              replace: stateChangedWithoutEvent
            });
          }
        }
        this._persistedVersion = afterVersion;
        const saved = await this._saveCommandResult(command, requestHashValue, result, token);
        return output(saved);
      } catch (error) {
        try {
          await this._restoreAfterFailedPersistence(beforeSnapshot, beforeVersion, afterVersion);
        } catch {
          // Do not replace the original command/persistence error. A later
          // invocation will retry recovery from the durable stream.
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      const code = repositoryCode(error);
      if (REPOSITORY_ERROR_CODES.has(code)) {
        throw new AppError(code, {
          message: error.message,
          details: error.details,
          cause: error
        });
      }
      throw asAppError(error);
    } finally {
      await this._release(token);
    }
  }

  /** Dispatch is always serialized, including asynchronous command handlers. */
  dispatch(command, context = {}) {
    const task = this._tail.then(() => this._dispatchNow(command, context));
    this._tail = task.catch(() => undefined);
    return task;
  }

  execute(command, context = {}) {
    return this.dispatch(command, context);
  }

  async close() {
    await this._tail;
    if (this.lock && this._fencingToken !== null) await this._release(this._fencingToken);
  }
}

export const RoomActorError = AppError;

export function createRoomActor(options = {}) {
  return new RoomActor(options);
}
