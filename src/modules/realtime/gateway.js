import { randomUUID } from 'node:crypto';
import { RoomActor } from '../../domain/room-actor.js';
import { AppError } from '../../shared/errors.js';

function clone(value) {
  if (value === undefined || value === null) return value;
  return structuredClone(value);
}

function roomKey(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new AppError('ROOM_NOT_FOUND');
  }
  return String(value).trim();
}

function isOpen(socket) {
  // `ws` uses OPEN = 1. Keeping this check duck-typed makes the gateway easy
  // to exercise with a small fake socket in protocol and backpressure tests.
  return socket && (socket.readyState === undefined || socket.readyState === 1);
}

function normalizeActor(value) {
  if (value instanceof RoomActor) return value;
  if (value && typeof value.dispatch === 'function' && (value.room || value.roomId)) return value;
  throw new TypeError('room actor must expose dispatch and room');
}

/**
 * Owns one RoomActor per room. The registry deliberately has no transport
 * dependency, so a REST adapter and the WSS gateway can share the same actor
 * ordering and persistence boundary.
 */
export class RoomActorRegistry {
  constructor({
    rooms = new Map(),
    actors = new Map(),
    eventStore,
    lock,
    outbox,
    roomFactory,
    actorOptions = {}
  } = {}) {
    if (!eventStore) throw new TypeError('RoomActorRegistry requires an eventStore');
    this.rooms = rooms;
    this.actors = actors;
    this.eventStore = eventStore;
    this.lock = lock || eventStore.lock || null;
    this.outbox = outbox || eventStore.outbox || null;
    this.roomFactory = roomFactory;
    this.actorOptions = { ...actorOptions };
    // A restart can leave the in-memory room/actor maps empty while several
    // sockets reconnect at once. Share one materialization promise per room
    // so they cannot create competing actors from the same durable stream.
    this.recoveries = new Map();
  }

  has(roomId) {
    const id = roomKey(roomId);
    return this.actors.has(id) || this.rooms.has(id);
  }

  get(roomId) {
    const id = roomKey(roomId);
    const existing = this.actors.get(id);
    if (existing) return existing;
    const room = this.rooms.get(id);
    if (!room) return null;
    const actor = room && typeof room.dispatch === 'function' ? normalizeActor(room) : new RoomActor({
      ...this.actorOptions,
      roomId: id,
      room,
      eventStore: this.eventStore,
      lock: this.lock,
      outbox: this.outbox,
      roomFactory: this.roomFactory
    });
    // A caller may pass a RoomActor in the room map for convenience.
    if (actor instanceof RoomActor || typeof actor.dispatch === 'function') {
      this.actors.set(id, actor);
      if (actor.room && actor.room !== room) this.rooms.set(id, actor.room);
    }
    return actor;
  }

  register(roomOrActor, roomId) {
    const actor = roomOrActor instanceof RoomActor || typeof roomOrActor?.dispatch === 'function'
      ? normalizeActor(roomOrActor)
      : new RoomActor({
        ...this.actorOptions,
        roomId: roomId || roomOrActor?.id,
        room: roomOrActor,
        eventStore: this.eventStore,
        lock: this.lock,
        outbox: this.outbox,
        roomFactory: this.roomFactory
      });
    const id = roomKey(roomId || actor.roomId || actor.room?.id);
    this.actors.set(id, actor);
    if (actor.room) this.rooms.set(id, actor.room);
    return actor;
  }

  set(roomId, roomOrActor) {
    return this.register(roomOrActor, roomId);
  }

  delete(roomId) {
    const id = roomKey(roomId);
    const actor = this.actors.get(id);
    this.actors.delete(id);
    this.rooms.delete(id);
    return actor || null;
  }

  async recover(roomId) {
    const id = roomKey(roomId);
    const inFlight = this.recoveries.get(id);
    if (inFlight) return inFlight;
    const task = this._recover(id);
    this.recoveries.set(id, task);
    try {
      return await task;
    } finally {
      if (this.recoveries.get(id) === task) this.recoveries.delete(id);
    }
  }

  async _recover(id) {
    let actor = this.get(id);
    // On a process restart the in-memory room map is empty, while a durable
    // event store may still know the room. Lazily materialize an actor from
    // that stream so reconnect can rebuild the aggregate before subscribe.
    if (!actor) {
      const knownRooms = typeof this.eventStore.listRooms === 'function'
        ? await this.eventStore.listRooms()
        : [];
      let exists = Array.isArray(knownRooms) && knownRooms.includes(id);
      if (!exists && typeof this.eventStore.getLatestVersion === 'function') {
        try {
          exists = (await this.eventStore.getLatestVersion(id)) > 0;
        } catch (error) {
          if (error?.code !== 'NOT_FOUND' && error?.code !== 'ROOM_NOT_FOUND') throw error;
        }
      }
      if (exists) {
        actor = new RoomActor({
          ...this.actorOptions,
          roomId: id,
          eventStore: this.eventStore,
          lock: this.lock,
          outbox: this.outbox,
          roomFactory: this.roomFactory
        });
        this.actors.set(id, actor);
      }
    }
    if (!actor) throw new AppError('ROOM_NOT_FOUND');
    await actor.recover();
    if (actor.room) this.rooms.set(actor.roomId, actor.room);
    return actor;
  }

  async dispatch(roomId, command, context = {}) {
    const actor = this.get(roomId) || await this.recover(roomId);
    const result = await actor.dispatch(command, context);
    if (actor.room) this.rooms.set(actor.roomId, actor.room);
    return result;
  }

  /** Persist a version-zero checkpoint for a freshly created room. */
  async initialize(roomId, snapshot, command = {}) {
    const id = roomKey(roomId);
    const actor = this.get(id);
    if (!actor?.room || typeof this.eventStore.saveSnapshot !== 'function') return null;
    const value = snapshot || actor.room.snapshot();
    let lease = null;
    let token = null;
    try {
      if (this.lock) {
        lease = await this.lock.acquire(id, { ownerId: actor.actorId || `room-init-${id}` });
        token = lease?.fencingToken ?? lease?.token ?? lease;
      }
      const initial = {
        roomId: id,
        snapshot: value,
        roomVersion: value.roomVersion ?? value.version ?? 0,
        ...(token === null || token === undefined ? {} : { fencingToken: token })
      };
      if (command.commandId && command.requestHash && command.result !== undefined
        && typeof this.eventStore.initializeRoom === 'function') {
        return await this.eventStore.initializeRoom({
          ...initial,
          commandId: command.commandId,
          requestHash: command.requestHash,
          result: command.result
        });
      }
      const savedSnapshot = await this.eventStore.saveSnapshot(initial);
      if (command.commandId && command.requestHash && command.result !== undefined
        && typeof this.eventStore.saveCommandResult === 'function') {
        await this.eventStore.saveCommandResult({
          roomId: id,
          commandId: command.commandId,
          requestHash: command.requestHash,
          result: command.result,
          roomVersion: initial.roomVersion,
          ...(token === null || token === undefined ? {} : { fencingToken: token })
        });
      }
      return savedSnapshot;
    } finally {
      if (this.lock && token !== null && token !== undefined) {
        await this.lock.release(id, token);
      }
    }
  }

  /**
   * Find a command result when the room id is not part of the incoming
   * command (notably create_room). PostgreSQL adapters may replace this scan
   * with a command-id index; the development store keeps the same semantics
   * behind this registry boundary.
   */
  async findCommandResult(commandId) {
    if (commandId === undefined || commandId === null
      || typeof this.eventStore.getCommandResult !== 'function') return null;
    const roomIds = typeof this.eventStore.listRooms === 'function'
      ? await this.eventStore.listRooms()
      : [];
    for (const roomId of roomIds || []) {
      const result = await this.eventStore.getCommandResult(roomId, commandId);
      if (result) return { roomId: String(roomId), ...result };
    }
    return null;
  }

  async close() {
    await Promise.all([...this.actors.values()].map(actor => actor.close?.()));
  }
}

/**
 * Transport-facing room gateway. It tracks subscriptions independently from
 * Room membership, allowing a socket to receive only rooms it explicitly
 * subscribed to and preventing a stale socket from deleting a replacement.
 */
export class RealtimeGateway {
  constructor({
    registry,
    clients = new Map(),
    protocolVersion = '1.0',
    createEvent,
    metrics,
    maxBufferedBytes = 1024 * 1024,
    maxQueueMessages = 256,
    closeCode = 1013,
    logger,
    reconnectGraceMs = 120000,
    onGraceExpired
  } = {}) {
    if (!registry) throw new TypeError('RealtimeGateway requires a room actor registry');
    if (typeof createEvent !== 'function') throw new TypeError('RealtimeGateway requires createEvent');
    this.registry = registry;
    this.clients = clients;
    this.protocolVersion = protocolVersion;
    this.createEvent = createEvent;
    this.metrics = metrics;
    this.maxBufferedBytes = Number.isFinite(maxBufferedBytes) && maxBufferedBytes > 0
      ? maxBufferedBytes : 1024 * 1024;
    this.maxQueueMessages = Number.isInteger(maxQueueMessages) && maxQueueMessages > 0
      ? maxQueueMessages : 256;
    this.closeCode = closeCode;
    this.logger = logger;
    this.reconnectGraceMs = Number.isFinite(reconnectGraceMs) && reconnectGraceMs > 0
      ? reconnectGraceMs : 120000;
    this.onGraceExpired = typeof onGraceExpired === 'function' ? onGraceExpired : null;
    this.subscribers = new Map();
    this.broadcastVersions = new Map();
    this.broadcastTails = new Map();
    this.graceTimers = new Map();
  }

  _connectionsFor(playerId) {
    return this.clients.get(playerId) || new Set();
  }

  _queue(socket) {
    if (!socket.__realtimeGatewayQueue) socket.__realtimeGatewayQueue = [];
    return socket.__realtimeGatewayQueue;
  }

  /** Send one envelope with bounded buffering. Returns false when dropped. */
  send(socket, message) {
    if (!isOpen(socket)) return false;
    const encoded = JSON.stringify(message);
    const buffered = Number(socket.bufferedAmount || 0);
    const queue = this._queue(socket);
    if (buffered > this.maxBufferedBytes || queue.length >= this.maxQueueMessages) {
      socket.__realtimeBackpressure = true;
      this.metrics?.increment?.('ws_messages_dropped_total', { reason: 'backpressure' });
      this.logger?.warn?.('websocket.backpressure', {
        bufferedAmount: buffered,
        queuedMessages: queue.length
      });
      try {
        socket.close?.(this.closeCode, 'backpressure');
      } catch (cause) {
        this.logger?.warn?.('websocket.backpressure_close_failed', { message: cause.message });
      }
      return false;
    }
    try {
      queue.push(message);
      socket.send(encoded, () => {
        const index = queue.indexOf(message);
        if (index >= 0) queue.splice(index, 1);
      });
      // Some fake sockets do not implement the callback contract. Do not let
      // the queue grow forever in that case; ws itself still preserves order.
      if (socket.send.length < 2) queue.shift();
      return true;
    } catch (cause) {
      const index = queue.indexOf(message);
      if (index >= 0) queue.splice(index, 1);
      this.logger?.warn?.('websocket.send_failed', { message: cause.message });
      return false;
    }
  }

  _filterDomainEvent(latest, viewerId) {
    const event = latest ? clone(latest) : null;
    if (!event || typeof event !== 'object') return null;
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : null;
    if (!payload) return event;
    const target = payload.privateForPlayerId ?? event.privateForPlayerId;
    if (target !== undefined && target !== null && String(target) !== String(viewerId)) {
      const privateOnly = payload.privateOnly === true || event.visibility === 'player';
      delete payload.privateForPlayerId;
      delete payload.privatePayload;
      delete payload.privateOnly;
      // These names are reserved for rule adapters' viewer-only state. A
      // future game can expose a different public projection explicitly.
      for (const field of ['hand', 'privateHand', 'drawnTile', 'privateTiles', 'concealedTiles', 'cards']) {
        delete payload[field];
      }
      if (privateOnly) {
        // Keep the viewer's roomVersion cursor contiguous without exposing
        // the private payload. Clients can safely apply this as a no-op.
        event.visibility = 'public';
        event.payload = { redacted: true };
      }
    } else if (target !== undefined && target !== null) {
      event.visibility = 'player';
      delete payload.privateForPlayerId;
    }
    return event;
  }

  _viewerEvent(room, latest, correlation = {}, viewerId) {
    const snapshot = room.snapshot({ viewerId });
    const event = this._filterDomainEvent(latest, viewerId);
    if (!event) return null;
    const eventVersion = event.roomVersion ?? event.version ?? room.version;
    const visibility = event?.visibility === 'player' ? 'player' : 'public';
    return this.createEvent('room_event', {
      snapshot,
      latest: event
    }, {
      roomId: room.id,
      // A gap fill can publish an older event after the aggregate has already
      // advanced. Preserve the domain event cursor in the envelope so clients
      // can apply a contiguous sequence instead of seeing every backfilled
      // event mislabeled as the latest room version.
      roomVersion: eventVersion,
      requestId: correlation.requestId,
      commandId: correlation.commandId,
      visibility
    });
  }

  roomEvent(room, latest, correlation = {}, viewerId) {
    return this._viewerEvent(room, latest, correlation, viewerId);
  }

  subscribe(socket, roomId, { playerId, allowUnseated = false } = {}) {
    const id = roomKey(roomId);
    const actor = this.registry.get(id);
    if (!actor?.room) throw new AppError('ROOM_NOT_FOUND');
    let room = actor.room;
    const viewerId = playerId || socket.playerId;
    if (!allowUnseated && viewerId && !room.players.has(viewerId)
      && room.ownerId !== viewerId && socket.principal?.role !== 'ADMIN'
      && socket.principal?.role !== 'CLUB_ADMIN') {
      throw new AppError('FORBIDDEN');
    }
    const listeners = this.subscribers.get(id) || new Set();
    // A subscription is a live-feed cursor, not a replay request. If the room
    // had no listeners while state advanced, the joining socket must use
    // reconnect/sync for the missed history instead of receiving old events
    // after the current snapshot and creating an apparent version rewind.
    if (listeners.size === 0) {
      const previousBroadcast = this.broadcastVersions.get(id) || 0;
      this.broadcastVersions.set(id, Math.max(previousBroadcast, room.version));
    }
    const subscriptions = socket.__roomSubscriptions || new Set();
    subscriptions.add(id);
    socket.__roomSubscriptions = subscriptions;
    listeners.add(socket);
    this.subscribers.set(id, listeners);
    if (!this.broadcastVersions.has(id)) this.broadcastVersions.set(id, room.version);
    if (viewerId) this.cancelReconnectGrace(id, viewerId);
    return { roomId: id, roomVersion: room.version, snapshot: room.snapshot({ viewerId }) };
  }

  unsubscribe(socket, roomId) {
    const id = roomKey(roomId);
    const subscriptions = socket.__roomSubscriptions;
    subscriptions?.delete(id);
    const listeners = this.subscribers.get(id);
    listeners?.delete(socket);
    if (listeners?.size === 0) this.subscribers.delete(id);
    return { roomId: id, subscribed: false };
  }

  unsubscribeAll(socket) {
    for (const roomId of [...(socket.__roomSubscriptions || [])]) this.unsubscribe(socket, roomId);
  }

  isSubscribed(socket, roomId) {
    return Boolean(socket.__roomSubscriptions?.has(roomKey(roomId)));
  }

  /** Broadcast a viewer-scoped event to the room's current subscribers. */
  async _broadcastNow(room, latest, correlation = {}) {
    if (!latest) return 0;
    const targetVersion = latest.roomVersion ?? latest.version ?? room.version;
    const previousVersion = this.broadcastVersions.get(room.id) || 0;
    if (targetVersion <= previousVersion) return 0;
    let pending = [latest];
    // An actor can finish a later queued command before an earlier command's
    // transport continuation resumes. Fill the durable gap before publishing
    // so subscribers observe a contiguous, duplicate-free sequence.
    const store = this.registry.get(room.id)?.eventStore;
    if (targetVersion > previousVersion + 1 && typeof store?.getEvents === 'function') {
      const retained = await store.getEvents(room.id, {
        afterVersion: previousVersion,
        throughVersion: targetVersion
      });
      if (retained.length > 0) pending = retained;
    }
    const listeners = this.subscribers.get(room.id) || new Set();
    let sent = 0;
    for (const domainEvent of pending) {
      for (const socket of listeners) {
        const eventCorrelation = domainEvent === latest
          ? correlation
          : { requestId: domainEvent.requestId, commandId: domainEvent.commandId };
        const event = this._viewerEvent(room, domainEvent, eventCorrelation, socket.playerId);
        if (event && this.send(socket, event)) sent += 1;
      }
    }
    this.broadcastVersions.set(room.id, targetVersion);
    return sent;
  }

  /**
   * Serialize transport publication per room. RoomActor serializes state
   * changes, but publication may await a durable gap read; without this queue
   * two command continuations could both observe the same previous version and
   * publish duplicate deltas.
   */
  broadcast(room, latest, correlation = {}) {
    const roomId = roomKey(room?.id);
    const previous = this.broadcastTails.get(roomId) || Promise.resolve();
    const task = previous.then(() => this._broadcastNow(room, latest, correlation));
    this.broadcastTails.set(roomId, task.catch(() => undefined));
    return task;
  }

  sendToPlayer(playerId, message) {
    let sent = 0;
    for (const socket of this._connectionsFor(playerId)) if (this.send(socket, message)) sent += 1;
    return sent;
  }

  /**
   * Produce a snapshot plus durable event tail. If the requested version is
   * older than the retained event window, the snapshot remains authoritative
   * and `syncRequired` tells the client to replace local state atomically.
   */
  async sync(socket, roomId, playerId, lastRoomVersion = 0) {
    const id = roomKey(roomId);
    if (!Number.isInteger(lastRoomVersion) || lastRoomVersion < 0) throw new AppError('VERSION_CONFLICT');
    const actor = await this.registry.recover(id);
    let room = actor.room;
    if (!room?.players.has(playerId)) throw new AppError('PLAYER_NOT_FOUND');
    this.cancelReconnectGrace(id, playerId);
    let latestVersion = room.version;
    if (lastRoomVersion > latestVersion) throw new AppError('VERSION_CONFLICT');
    // Mark the player online through the actor so the snapshot mutation is
    // serialized, fenced and durable. Presence does not advance roomVersion;
    // the durable event stream below remains the source for reconnect deltas.
    await actor.dispatch({
      type: 'reconnect',
      roomId: id,
      commandId: randomUUID(),
      payload: { playerId, lastRoomVersion: latestVersion }
    }, { actorId: playerId });
    // RoomActor recovery may replace its aggregate instance with a hydrated
    // snapshot. Always read the post-dispatch instance for the response.
    room = actor.room;
    // A command from another connection may have been queued behind the
    // presence update. Use the actor's post-dispatch version for the
    // authoritative snapshot/cursor rather than the pre-dispatch value.
    latestVersion = actor.version;
    let events = [];
    let syncRequired = false;
    const store = actor.eventStore;
    if (typeof store?.getEvents === 'function') {
      const all = await store.getEvents(id, { afterVersion: 0 });
      const earliest = all[0]?.roomVersion ?? latestVersion + 1;
      syncRequired = lastRoomVersion < earliest - 1;
      events = syncRequired ? [] : all
        .filter(event => event.roomVersion > lastRoomVersion)
        .map(event => this._filterDomainEvent(event, playerId))
        .filter(Boolean);
    } else {
      try {
      events = room.eventsSince(lastRoomVersion)
        .map(event => this._filterDomainEvent(event, playerId))
        .filter(Boolean);
      } catch (error) {
        if (error?.code !== 'VERSION_CONFLICT') throw error;
        syncRequired = true;
      }
    }
    const snapshot = room.snapshot({ viewerId: playerId });
    const payload = {
      snapshot,
      snapshotHash: snapshot.snapshotHash,
      events: events.map(clone),
      fromRoomVersion: lastRoomVersion,
      toRoomVersion: latestVersion,
      syncRequired
    };
    return this.createEvent('room_sync', payload, {
      roomId: id,
      roomVersion: latestVersion,
      visibility: 'player'
    });
  }

  disconnect(socket) {
    this.unsubscribeAll(socket);
  }

  _graceKey(roomId, playerId) {
    return `${roomKey(roomId)}\u0000${String(playerId)}`;
  }

  scheduleReconnectGrace(roomId, playerId, options = {}) {
    const id = roomKey(roomId);
    if (playerId === undefined || playerId === null || String(playerId).trim() === '') return null;
    const key = this._graceKey(id, playerId);
    this.cancelReconnectGrace(id, playerId);
    const graceMs = options.graceMs === undefined ? this.reconnectGraceMs : Number(options.graceMs);
    if (!Number.isFinite(graceMs) || graceMs < 0) throw new AppError('INVALID_ACTION');
    const callback = typeof options.onExpired === 'function' ? options.onExpired : this.onGraceExpired;
    const timer = setTimeout(() => {
      this.graceTimers.delete(key);
      Promise.resolve(callback?.({ roomId: id, playerId: String(playerId) }))
        .catch(error => this.logger?.warn?.('websocket.reconnect_grace_expired_failed', { message: error.message }));
    }, graceMs);
    timer.unref?.();
    this.graceTimers.set(key, timer);
    return { roomId: id, playerId: String(playerId), graceMs };
  }

  cancelReconnectGrace(roomId, playerId) {
    const key = this._graceKey(roomId, playerId);
    const timer = this.graceTimers.get(key);
    if (!timer) return false;
    clearTimeout(timer);
    this.graceTimers.delete(key);
    return true;
  }

  hasReconnectGrace(roomId, playerId) {
    return this.graceTimers.has(this._graceKey(roomId, playerId));
  }

  clearReconnectGraceForPlayer(playerId) {
    const suffix = `\u0000${String(playerId)}`;
    let count = 0;
    for (const [key, timer] of this.graceTimers) {
      if (!key.endsWith(suffix)) continue;
      clearTimeout(timer);
      this.graceTimers.delete(key);
      count += 1;
    }
    return count;
  }

  close() {
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
    this.subscribers.clear();
    this.broadcastVersions.clear();
    this.broadcastTails.clear();
  }
}

export function createRoomActorRegistry(options = {}) {
  return new RoomActorRegistry(options);
}

export function createRealtimeGateway(options = {}) {
  return new RealtimeGateway(options);
}
