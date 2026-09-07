import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { createRoomDeadlineScheduler } from './domain/deadline.js';
import {
  createConfiguredGamePersistence,
  createMemoryGameStore
} from './infra/persistence/index.js';
import { createRoomActorRegistry, createRealtimeGateway } from './modules/realtime/gateway.js';
import { AuthService } from './modules/auth/index.js';
import { assertProductionSafe, loadConfig } from './config/index.js';
import { AppError, asAppError, toErrorPayload } from './shared/errors.js';
import { createLogger } from './observability/logger.js';
import { HealthRegistry } from './observability/health.js';
import { MetricsRegistry } from './observability/metrics.js';
import { FixedWindowRateLimiter } from './security/rate-limit.js';
import { isAllowedOrigin, parseAllowedOrigins } from './security/origin.js';
import { createRoomService } from './modules/room/service.js';
import { createRoomApiServer } from './modules/room/http.js';
import {
  createMemorySupportTicketRepository,
  createSupportTicketService
} from './modules/support/index.js';
import {
  PROTOCOL_VERSION,
  adaptLegacyCommand,
  createEvent,
  validateCommand
} from './protocol/index.js';

const BUSINESS_COMMANDS = new Set([
  'create_room',
  'join_room',
  'leave_room',
  'ready',
  'increase_zeng',
  'choose_piao',
  'resolve_flower',
  'start_round',
  'begin_playing',
  'action',
  'settle_round',
  'next_round',
  'disband_room',
  'reconnect',
  'subscribe',
  'unsubscribe'
]);
const ROOM_ERROR_CODES = new Set([
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'ROOM_NOT_JOINABLE',
  'SEAT_OCCUPIED',
  'NOT_ROOM_OWNER',
  'NOT_YOUR_TURN',
  'INVALID_ACTION',
  'VERSION_CONFLICT',
  'DUPLICATE_REQUEST',
  'ROUND_FINISHED',
  'CLUB_MEMBERSHIP_REQUIRED',
  'FORBIDDEN',
  'PLAYER_NOT_FOUND',
  'PLAYERS_NOT_READY',
  'ROUND_NOT_PLAYING'
]);

function decodeIncoming(raw) {
  if (typeof raw === 'string') return JSON.parse(raw);
  if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) return JSON.parse(Buffer.from(raw).toString('utf8'));
  return raw;
}

function normalizeRoomError(error) {
  if (error instanceof AppError) return error;
  if (error instanceof SyntaxError) return new AppError('INVALID_MESSAGE', { cause: error });
  const code = ROOM_ERROR_CODES.has(error?.message) ? error.message : 'INTERNAL_ERROR';
  return new AppError(code, { cause: error });
}

function commandRoomId(command) {
  return command.roomId || command.payload?.roomId || null;
}

/**
 * Create the development realtime server. The factory keeps tests and future
 * HTTP composition from binding a port merely by importing this module.
 */
export function createRealtimeServer({
  config = loadConfig(),
  authService,
  port,
  host,
  roomStore = new Map(),
  clientStore = new Map(),
  actorStore = new Map(),
  persistence,
  eventStore,
  lock,
  outbox,
  deadlineStore,
  roomActorRegistry,
  realtimeGateway,
  deadlineScheduler,
  supportRepository,
  supportService,
  logger,
  metrics,
  health,
  rateLimiter,
  http = false,
  httpPort = 0,
  httpHost = '127.0.0.1',
  persistenceClose
} = {}) {
  const safeConfig = assertProductionSafe(config);
  const resolvedAuthService = authService || new AuthService({ mode: safeConfig.AUTH_MODE });
  const resolvedPort = port === undefined ? safeConfig.PORT : port;
  const resolvedHost = host === undefined ? safeConfig.HOST : host;
  const resolvedLogger = logger || createLogger({ level: safeConfig.LOG_LEVEL });
  const resolvedMetrics = metrics || new MetricsRegistry();
  const resolvedHealth = health || new HealthRegistry();
  const resolvedRateLimiter = rateLimiter || new FixedWindowRateLimiter({
    limit: safeConfig.WS_RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000
  });
  const allowedOrigins = parseAllowedOrigins(safeConfig.ALLOWED_ORIGINS);
  const persistenceBackend = safeConfig.PERSISTENCE_BACKEND || 'memory';
  const rooms = roomStore;
  // Support is intentionally memory-backed in this development/fake-staging
  // baseline.  A persistent adapter must be reviewed separately; keeping it
  // explicit prevents accidental claims that tickets survive process restart.
  const resolvedSupportRepository = supportRepository || createMemorySupportTicketRepository();
  const resolvedSupportService = supportService || createSupportTicketService({
    repository: resolvedSupportRepository,
    logger: resolvedLogger
  });
  // userId -> Set<WebSocket>; multiple devices are allowed and close handlers
  // remove only their own socket, so an old socket cannot delete a new one.
  const clients = clientStore;
  const selectedPersistence = persistence || (eventStore
    ? {
      eventStore,
      lock: lock || eventStore.lock || null,
      outbox: outbox || eventStore.outbox || null,
      deadlineStore: deadlineStore || eventStore.deadlineStore || null
    }
    : persistenceBackend === 'memory'
      ? createMemoryGameStore()
      : null);
  if (!selectedPersistence?.eventStore) {
    throw new AppError('CONFIG_INVALID', {
      message: 'A non-memory persistence backend must be loaded with createRealtimeServerAsync or injected explicitly'
    });
  }
  const resolvedEventStore = selectedPersistence.eventStore;
  const resolvedLock = lock || selectedPersistence.lock || resolvedEventStore.lock || null;
  const resolvedOutbox = outbox || selectedPersistence.outbox || resolvedEventStore.outbox || null;
  const resolvedDeadlineStore = deadlineStore
    || selectedPersistence.deadlineStore
    || resolvedEventStore.deadlineStore
    || null;
  const actors = actorStore;
  const registry = roomActorRegistry || createRoomActorRegistry({
    rooms,
    actors,
    eventStore: resolvedEventStore,
    lock: resolvedLock,
    outbox: resolvedOutbox
  });
  const wss = new WebSocketServer({
    port: resolvedPort,
    host: resolvedHost,
    maxPayload: safeConfig.WS_MAX_PAYLOAD_BYTES,
    verifyClient: ({ origin }, done) => {
      done(isAllowedOrigin(origin, allowedOrigins));
    }
  });
  let closing = false;
  let closePromise = null;
  const gateway = realtimeGateway || createRealtimeGateway({
    registry,
    clients,
    protocolVersion: PROTOCOL_VERSION,
    createEvent,
    metrics: resolvedMetrics,
    maxBufferedBytes: safeConfig.WS_MAX_BUFFERED_BYTES,
    maxQueueMessages: safeConfig.WS_MAX_QUEUE_MESSAGES,
    logger: resolvedLogger,
    reconnectGraceMs: safeConfig.WS_RECONNECT_GRACE_MS,
    onGraceExpired: ({ roomId: expiredRoomId, playerId }) => {
      resolvedMetrics.increment('ws_reconnect_grace_expired_total');
      resolvedLogger.info?.('websocket.reconnect_grace_expired', {
        roomId: expiredRoomId,
        playerId
      });
    }
  });
  const deadlines = deadlineScheduler || createRoomDeadlineScheduler({
    registry,
    deadlineStore: resolvedDeadlineStore,
    metrics: resolvedMetrics,
    logger: resolvedLogger,
    onTimeout: async ({ roomId, status, result, command }) => {
      if (status !== 'executed') return;
      const actor = await registry.recover(roomId);
      const room = actor?.room;
      const latest = result?.event || room?.events?.at(-1);
      if (!latest || !room) return;
      try {
        await gateway.broadcast(room, latest, {
          requestId: command.requestId,
          commandId: command.commandId
        });
      } catch (error) {
        resolvedLogger.warn?.('websocket.deadline_broadcast_failed', {
          roomId: room.id,
          roomVersion: latest.roomVersion ?? latest.version,
          message: error.message
        });
      }
    }
  });
  // A restarted process must re-arm active turns from their durable snapshot.
  // Recovery is best effort here; a reconnect/subscribe will retry the same
  // operation while the health surface records the underlying store failure.
  Promise.resolve(deadlines.recoverAll?.()).catch(error => {
    resolvedLogger.warn?.('room.deadline_recovery_failed', { message: error.message });
  });
  const roomService = createRoomService({
    registry,
    rooms,
    deadlines,
    logger: resolvedLogger
  });
  const api = http
    ? createRoomApiServer({
      roomService,
      supportService: resolvedSupportService,
      authService: resolvedAuthService,
      health: resolvedHealth,
      host: httpHost,
      port: httpPort,
      maxBodyBytes: safeConfig.WS_MAX_PAYLOAD_BYTES,
      logger: resolvedLogger
    })
    : null;
  resolvedHealth.register('room_store', async () => {
    const detail = typeof resolvedEventStore.health === 'function'
      ? await resolvedEventStore.health()
      : { backend: persistenceBackend };
    return { ...detail, rooms: rooms.size };
  });
  resolvedHealth.register('auth_store', () => ({
    backend: 'memory',
    sessions: resolvedAuthService.sessions?.size ?? null
  }));
  resolvedHealth.register('support_store', () => (
    typeof resolvedSupportService.health === 'function'
      ? resolvedSupportService.health()
      : { status: 'ok', backend: 'memory' }
  ));

  const heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        resolvedMetrics.increment('ws_connections_terminated_total', { reason: 'heartbeat_timeout' });
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, safeConfig.WS_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  function send(ws, message) {
    return gateway.send(ws, message);
  }

  function sendError(ws, error, requestId, commandId) {
    const normalized = asAppError(error);
    const payload = toErrorPayload(normalized, requestId || randomUUID());
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'error',
      ...payload,
      ...(commandId ? { commandId } : {})
    };
    try {
      send(ws, envelope);
    } catch (sendErrorCause) {
      resolvedLogger.warn?.('websocket.error_send_failed', { cause: sendErrorCause.message });
    }
  }

  function addClient(ws, principal, accessToken) {
    if (ws.playerId) removeClient(ws);
    ws.playerId = principal.userId;
    ws.sessionId = principal.sessionId;
    ws.principal = principal;
    ws.accessToken = accessToken;
    ws.authenticated = true;
    const connections = clients.get(principal.userId) || new Set();
    connections.add(ws);
    clients.set(principal.userId, connections);
  }

  function removeClient(ws) {
    if (!ws.playerId) return;
    gateway.disconnect(ws);
    const connections = clients.get(ws.playerId);
    if (connections) {
      connections.delete(ws);
      if (connections.size === 0) clients.delete(ws.playerId);
    }
    ws.authenticated = false;
  }

  function sendToPlayer(playerId, message) {
    return gateway.sendToPlayer(playerId, message);
  }

  function broadcastRoom(room, message) {
    // `message` is retained for compatibility with older callers. New code
    // passes the latest domain event and lets the gateway scope each snapshot
    // to the receiving player.
    if (message?.type === 'room_event' && message.payload?.latest) {
      return gateway.broadcast(room, message.payload.latest, {
        requestId: message.requestId,
        commandId: message.commandId
      });
    }
    for (const playerId of room.players.keys()) sendToPlayer(playerId, message);
    return undefined;
  }

  function roomEvent(room, latest, correlation = {}, viewerId) {
    return gateway.roomEvent(room, latest, correlation, viewerId);
  }

  function requireConnectionAuth(ws) {
    if (!ws.accessToken) throw new AppError('AUTH_REQUIRED');
    const principal = resolvedAuthService.requireAuth(ws.accessToken);
    ws.principal = principal;
    ws.playerId = principal.userId;
    ws.sessionId = principal.sessionId;
    ws.authenticated = true;
    return principal;
  }

  function parseCommand(raw) {
    const decoded = decodeIncoming(raw);
    const candidate = decoded?.protocolVersion ? decoded : adaptLegacyCommand(decoded);
    return validateCommand(candidate, { maxBytes: safeConfig.WS_MAX_PAYLOAD_BYTES });
  }

  async function handleCommand(ws, command) {
    const correlation = { requestId: command.requestId, commandId: command.commandId };
    const { type, payload = {} } = command;

    if (type === 'hello') {
      ws.deviceId = payload.deviceId;
      send(ws, createEvent('hello_ack', {
        protocolVersion: PROTOCOL_VERSION,
        serverTime: new Date().toISOString(),
        authenticated: Boolean(ws.authenticated)
      }, correlation));
      return;
    }

    if (type === 'login') {
      const session = resolvedAuthService.login(payload);
      const principal = resolvedAuthService.requireAuth(session.accessToken);
      addClient(ws, principal, session.accessToken);
      send(ws, createEvent('login_ok', session, correlation));
      return;
    }

    if (type === 'refresh') {
      const session = resolvedAuthService.refresh(payload.refreshToken);
      const principal = resolvedAuthService.requireAuth(session.accessToken);
      addClient(ws, principal, session.accessToken);
      send(ws, createEvent('refresh_ok', session, correlation));
      return;
    }

    if (type === 'auth') {
      const principal = resolvedAuthService.requireAuth(payload.accessToken);
      addClient(ws, principal, payload.accessToken);
      send(ws, createEvent('auth_ok', {
        sessionId: principal.sessionId,
        userId: principal.userId,
        displayName: principal.displayName
      }, correlation));
      return;
    }

    if (type === 'logout') {
      const accessToken = payload.accessToken || ws.accessToken;
      const result = resolvedAuthService.logout(accessToken);
      removeClient(ws);
      send(ws, createEvent('logout_ok', result, correlation));
      return;
    }

    if (type === 'ping') {
      send(ws, createEvent('pong', { serverTime: new Date().toISOString() }, correlation));
      return;
    }

    if (BUSINESS_COMMANDS.has(type)) requireConnectionAuth(ws);

    const roomId = commandRoomId(command);
    const principal = ws.principal;
    if (type === 'create_room') {
      const created = await roomService.createRoom({
        principal,
        payload,
        commandId: command.commandId,
        requestId: command.requestId
      });
      const room = registry.get(created.roomId)?.room || await registry.recover(created.roomId).then(actor => actor.room);
      // A room creator is implicitly subscribed so the first join/ready event
      // is visible on the creating device as well as to later subscribers.
      gateway.subscribe(ws, room.id, { playerId: principal.userId, allowUnseated: true });
      send(ws, createEvent('room_created', created.room, {
        ...correlation,
        roomId: room.id,
        roomVersion: room.version
      }));
      send(ws, createEvent('command_ack', {
        accepted: true,
        roomVersion: room.version,
        version: room.version,
        replay: created.replay
      }, { ...correlation, roomId: room.id, roomVersion: room.version }));
      return;
    }

    let actor = registry.get(roomId);
    // A fresh process has no in-memory room map. Recover any durable room
    // before handling subscribe or room commands so the WSS surface behaves
    // consistently after restart, not only for an explicit reconnect.
    if (!actor) actor = await registry.recover(roomId);
    if (!actor?.room) throw new AppError('ROOM_NOT_FOUND');
    const room = actor.room;

    if (type === 'subscribe') {
      const subscription = gateway.subscribe(ws, room.id, {
        playerId: principal.userId,
        allowUnseated: payload.allowUnseated === true && (principal.role === 'ADMIN' || principal.role === 'CLUB_ADMIN')
      });
      deadlines.refresh?.(room);
      send(ws, createEvent('command_ack', {
        accepted: true,
        roomVersion: subscription.roomVersion,
        snapshot: subscription.snapshot,
        subscribed: true
      }, { ...correlation, roomId: room.id, roomVersion: subscription.roomVersion }));
      return;
    }

    if (type === 'unsubscribe') {
      const result = gateway.unsubscribe(ws, room.id);
      send(ws, createEvent('command_ack', {
        accepted: true,
        subscribed: false,
        ...result
      }, { ...correlation, roomId: room.id, roomVersion: room.version }));
      return;
    }

    const beforeVersion = actor.version;
    if (type === 'reconnect') {
      const lastVersion = payload.lastRoomVersion ?? payload.lastVersion ?? command.roomVersion ?? 0;
      const sync = await gateway.sync(ws, room.id, principal.userId, lastVersion);
      gateway.subscribe(ws, room.id, { playerId: principal.userId });
      deadlines.refresh?.(actor.room);
      send(ws, { ...sync, requestId: correlation.requestId, commandId: correlation.commandId });
      return;
    } else {
      const result = await roomService.dispatch({
        roomId: room.id,
        principal,
        type,
        payload,
        commandId: command.commandId,
        requestId: command.requestId,
        roomVersion: command.roomVersion
      });
      if (type === 'join_room') gateway.subscribe(ws, room.id, { playerId: principal.userId });
      const currentRoom = actor.room;
      const afterVersion = result.roomVersion ?? actor.version;
      const ack = createEvent('command_ack', {
        accepted: result.accepted !== false,
        roomVersion: afterVersion,
        version: afterVersion,
        replay: afterVersion <= beforeVersion,
        ...(result.event?.eventId ? { eventId: result.event.eventId } : {})
      }, { ...correlation, roomId: currentRoom.id, roomVersion: afterVersion });
      send(ws, ack);
      const latest = result.event || currentRoom.events.at(-1);
      if (afterVersion > beforeVersion && latest) {
        // The command ACK is already authoritative. A transient publication
        // failure must be retried by reconnect/sync, not reported as a second
        // response for a command the actor has committed.
        try {
          await gateway.broadcast(currentRoom, latest, correlation);
        } catch (error) {
          resolvedLogger.warn?.('websocket.broadcast_failed', {
            roomId: currentRoom.id,
            roomVersion: afterVersion,
            message: error.message
          });
        }
      }
      return;
    }
  }

  wss.on('connection', ws => {
    ws.connectionId = randomUUID();
    ws.authenticated = false;
    ws.__messageTail = Promise.resolve();
    ws.on('message', raw => {
      // Preserve wire order for session/auth commands while RoomActor handles
      // cross-connection ordering per room. The queue is intentionally local
      // to this socket, so a slow client cannot stall another connection.
      ws.__messageTail = ws.__messageTail.then(() => processMessage(ws, raw));
    });
    async function processMessage(socket, raw) {
      let command;
      try {
        const key = socket.playerId || socket.connectionId;
        const quota = resolvedRateLimiter.consume(key);
        if (!quota.allowed) throw new AppError('RATE_LIMITED', { details: { retryAfterMs: quota.retryAfterMs } });
        resolvedMetrics.increment('ws_commands_total', { type: 'unknown', result: 'received' });
        command = parseCommand(raw);
        resolvedMetrics.increment('ws_commands_total', { type: command.type, result: 'validated' });
        await handleCommand(socket, command);
      } catch (error) {
        const normalized = normalizeRoomError(error);
        resolvedMetrics.increment('ws_commands_total', { type: command?.type || 'unknown', result: 'rejected' });
        sendError(socket, normalized, command?.requestId, command?.commandId);
      }
    }
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    resolvedMetrics.increment('ws_connections_total', { result: 'accepted' });
    ws.on('error', error => resolvedLogger.warn?.('websocket.error', { message: error.message }));
    ws.on('close', async () => {
      const disconnectedPlayerId = ws.playerId;
      gateway.disconnect(ws);
      removeClient(ws);
      // A user may have multiple active devices. Only mark a player offline
      // when the closing socket was their final authenticated connection.
      // During server shutdown the aggregate is deliberately left untouched:
      // the durable room snapshot already records the last committed state,
      // and dispatching presence while actors are being drained can keep a
      // close promise alive or race the next process during restart.
      if (!closing && (!disconnectedPlayerId || !clients.get(disconnectedPlayerId)?.size)) {
        for (const [roomId, room] of rooms.entries()) {
          if (!disconnectedPlayerId || !room.players.has(disconnectedPlayerId)) continue;
          // Presence changes are aggregate state. Route them through the
          // actor so a restart cannot resurrect a disconnected player from an
          // older checkpoint and concurrent close/reconnect operations remain
          // ordered under the room lock.
          // Register the grace window before awaiting the actor so a socket
          // close is immediately visible and app shutdown can clear it.
          gateway.scheduleReconnectGrace(roomId, disconnectedPlayerId);
          try {
            await registry.dispatch(roomId, {
              type: 'disconnect',
              roomId,
              commandId: randomUUID(),
              payload: { playerId: disconnectedPlayerId }
            }, { actorId: disconnectedPlayerId });
          } catch (error) {
            resolvedLogger.warn?.('websocket.disconnect_persist_failed', {
              roomId,
              playerId: disconnectedPlayerId,
              message: error.message
            });
          }
        }
      }
      resolvedMetrics.increment('ws_connections_closed_total');
    });
  });

  return {
    wss,
    rooms,
    clients,
    actors,
    registry,
    roomService,
    supportService: resolvedSupportService,
    supportRepository: resolvedSupportRepository,
    api,
    gateway,
    deadlines,
    eventStore: resolvedEventStore,
    lock: resolvedLock,
    outbox: resolvedOutbox,
    deadlineStore: resolvedDeadlineStore,
    authService: resolvedAuthService,
    health: resolvedHealth,
    metrics: resolvedMetrics,
    rateLimiter: resolvedRateLimiter,
    liveness: () => resolvedHealth.liveness(),
    readiness: () => resolvedHealth.readiness(),
    metricsText: () => resolvedMetrics.renderPrometheus(),
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      clearInterval(heartbeatTimer);
      closePromise = new Promise(resolve => {
        const finish = () => {
          Promise.resolve(gateway.close?.())
            .then(() => deadlines.close?.())
          .then(() => registry.close?.())
            .then(() => api?.close?.())
            .then(() => persistenceClose?.())
            .finally(resolve);
        };
        // `WebSocketServer.close()` waits for clients to disappear but does
        // not terminate them. Close and immediately terminate every active
        // socket so app shutdown remains bounded even with idle clients.
        for (const ws of wss.clients) {
          try {
            ws.close(1001, 'server shutting down');
          } catch (error) {
            resolvedLogger.warn?.('websocket.shutdown_close_failed', { message: error.message });
          }
          if (ws.readyState !== 3) ws.terminate();
        }
        if (wss.readyState === 0) return wss.close(finish);
        if (wss.readyState === 3) return finish();
        wss.close(finish);
      });
      return closePromise;
    }
  };
}

/**
 * Async composition entry point for configured adapters. The synchronous
 * factory remains available for injected test doubles and memory development;
 * production PostgreSQL/Redis clients are loaded only here.
 */
export async function createRealtimeServerAsync(options = {}) {
  const config = options.config || loadConfig();
  const selectedPersistence = options.persistence || (options.eventStore
    ? {
      eventStore: options.eventStore,
      lock: options.lock || options.eventStore.lock || null,
      outbox: options.outbox || options.eventStore.outbox || null,
      deadlineStore: options.deadlineStore || options.eventStore.deadlineStore || null
    }
    : await createConfiguredGamePersistence({
      config,
      pool: options.pool,
      redisClient: options.redisClient,
      lock: options.lock,
      outbox: options.outbox,
      deadlineStore: options.deadlineStore,
      eventStore: options.eventStore
    }));
  return createRealtimeServer({
    ...options,
    config,
    persistence: selectedPersistence,
    eventStore: selectedPersistence.eventStore,
    lock: options.lock || selectedPersistence.lock,
    outbox: options.outbox || selectedPersistence.outbox,
    deadlineStore: options.deadlineStore || selectedPersistence.deadlineStore,
    persistenceClose: options.persistence || options.eventStore ? options.persistenceClose : selectedPersistence.close
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const config = loadConfig();
  createRealtimeServerAsync({ config }).then(app => {
    app.wss.on('listening', () => {
      const address = app.wss.address();
      console.log(`Susong Mahjong server listening on ws://${address.address}:${address.port}`);
    });
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
