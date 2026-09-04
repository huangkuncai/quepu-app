import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createRealtimeServer } from '../src/server.js';
import { RealtimeGateway } from '../src/modules/realtime/gateway.js';
import { AuthService } from '../src/modules/auth/index.js';
import { createMemoryGameStore } from '../src/infra/persistence/index.js';
import { createCommand } from '../src/protocol/index.js';
import { loadConfig } from '../src/config/index.js';

function waitForMessage(ws, predicate = () => true, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('timed out waiting for WebSocket message'));
    }, timeoutMs);
    function onMessage(raw) {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(message);
    }
    ws.on('message', onMessage);
  });
}

async function openClient(url) {
  const ws = new WebSocket(url);
  await once(ws, 'open');
  return ws;
}

async function closeClient(ws) {
  if (ws.readyState === WebSocket.CLOSED) return;
  ws.close();
  await once(ws, 'close');
}

async function createTestApp(overrides = {}) {
  const config = loadConfig({ NODE_ENV: 'test', PORT: '8787', WS_RECONNECT_GRACE_MS: '1000' });
  const app = createRealtimeServer({ config, port: 0, host: '127.0.0.1', ...overrides });
  await once(app.wss, 'listening');
  const address = app.wss.address();
  return { app, url: `ws://127.0.0.1:${address.port}` };
}

async function login(ws, playerId) {
  const command = createCommand('login', { playerId, deviceId: `${playerId}-device`, platform: 'android' });
  const response = waitForMessage(ws, message => message.type === 'login_ok');
  ws.send(JSON.stringify(command));
  return response;
}

async function sendAndWait(ws, command, type) {
  const response = waitForMessage(ws, message => message.type === type && message.commandId === command.commandId);
  ws.send(JSON.stringify(command));
  return response;
}

test('gateway bounds socket buffering and closes a slow consumer', () => {
  const closed = [];
  const sent = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 100,
    send(value) { sent.push(value); },
    close(...args) { closed.push(args); }
  };
  const gateway = new RealtimeGateway({
    registry: { get() { return null; } },
    clients: new Map(),
    createEvent: () => ({})
  });
  gateway.maxBufferedBytes = 10;
  assert.equal(gateway.send(socket, { type: 'room_event' }), false);
  assert.equal(sent.length, 0);
  assert.deepEqual(closed[0], [1013, 'backpressure']);
});

test('gateway exposes cancellable reconnect grace timers', async () => {
  const expired = [];
  const gateway = new RealtimeGateway({
    registry: { get() { return null; } },
    clients: new Map(),
    createEvent: () => ({}),
    reconnectGraceMs: 5,
    onGraceExpired: value => expired.push(value)
  });
  gateway.scheduleReconnectGrace('room-grace', 'player-grace');
  assert.equal(gateway.hasReconnectGrace('room-grace', 'player-grace'), true);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(expired, [{ roomId: 'room-grace', playerId: 'player-grace' }]);
  gateway.scheduleReconnectGrace('room-grace', 'player-grace');
  assert.equal(gateway.cancelReconnectGrace('room-grace', 'player-grace'), true);
  assert.equal(gateway.hasReconnectGrace('room-grace', 'player-grace'), false);
  gateway.close();
});

test('WSS subscribe/ACK filters unseated viewers and persists actor events', async () => {
  const { app, url } = await createTestApp();
  const owner = await openClient(url);
  const guest = await openClient(url);
  try {
    await login(owner, 'owner-1');
    await login(guest, 'guest-1');
    const created = await sendAndWait(owner, createCommand('create_room', { maxPlayers: 2 }), 'room_created');
    const roomId = created.roomId;
    assert.equal(app.eventStore.getSnapshot(roomId).roomVersion, 0);

    const deniedSubscribe = createCommand('subscribe', {}, { roomId });
    guest.send(JSON.stringify(deniedSubscribe));
    const denied = await waitForMessage(guest, message => message.type === 'error' && message.commandId === deniedSubscribe.commandId);
    assert.equal(denied.error.code, 'FORBIDDEN');

    const ownerSubscribe = createCommand('subscribe', {}, { roomId });
    const subscribed = await sendAndWait(owner, ownerSubscribe, 'command_ack');
    assert.equal(subscribed.payload.subscribed, true);
    assert.equal(subscribed.payload.snapshot.roomVersion, 0);

    const ownerJoin = createCommand('join_room', { name: '房主' }, { roomId });
    const ownerAckPromise = waitForMessage(owner, message => message.type === 'command_ack' && message.commandId === ownerJoin.commandId);
    const ownerEventPromise = waitForMessage(owner, message => message.type === 'room_event' && message.commandId === ownerJoin.commandId);
    owner.send(JSON.stringify(ownerJoin));
    const [ownerAck, ownerEvent] = await Promise.all([ownerAckPromise, ownerEventPromise]);
    assert.equal(ownerEvent.roomVersion, 1);
    assert.equal(ownerAck.payload.accepted, true);
    assert.equal(app.eventStore.getLatestVersion(roomId), 1);

    const guestJoin = createCommand('join_room', { name: '来宾' }, { roomId });
    const guestEvent = await sendAndWait(guest, guestJoin, 'room_event');
    assert.equal(guestEvent.roomVersion, 2);
    assert.equal(guestEvent.payload.snapshot.players.length, 2);
    assert.equal(app.rooms.get(roomId).version, 2);
    assert.equal(app.actors.get(roomId).room, app.rooms.get(roomId));
  } finally {
    await closeClient(owner);
    await closeClient(guest);
    await app.close();
  }
});

test('same commandId replay returns ACK without a duplicate room event', async () => {
  const { app, url } = await createTestApp();
  const owner = await openClient(url);
  try {
    await login(owner, 'replay-owner');
    const created = await sendAndWait(owner, createCommand('create_room', { maxPlayers: 2 }), 'room_created');
    const roomId = created.roomId;
    const join = createCommand('join_room', { name: '重试' }, { roomId });
    await sendAndWait(owner, join, 'room_event');
    const duplicate = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        owner.off('message', onMessage);
        resolve(false);
      }, 40);
      function onMessage(raw) {
        const message = JSON.parse(raw.toString());
        if (message.commandId !== join.commandId) return;
        if (message.type === 'room_event') {
          clearTimeout(timer);
          owner.off('message', onMessage);
          reject(new Error('replayed command emitted room_event'));
        }
        if (message.type === 'command_ack') {
          clearTimeout(timer);
          owner.off('message', onMessage);
          resolve(message);
        }
      }
      owner.on('message', onMessage);
    });
    owner.send(JSON.stringify(join));
    const ack = await duplicate;
    assert.equal(ack.payload.replay, true);
    assert.equal(app.eventStore.getLatestVersion(roomId), 1);
  } finally {
    await closeClient(owner);
    await app.close();
  }
});

test('create_room commandId is durable and retries return the original room', async () => {
  const shared = createMemoryGameStore();
  const authService = new AuthService();
  const first = await createTestApp({
    authService,
    eventStore: shared.eventStore,
    lock: shared.lock,
    outbox: shared.outbox
  });
  const firstSocket = await openClient(first.url);
  let command;
  let roomId;
  try {
    await login(firstSocket, 'create-retry');
    command = createCommand('create_room', { maxPlayers: 2 });
    const created = await sendAndWait(firstSocket, command, 'room_created');
    roomId = created.roomId;
    const firstResult = shared.eventStore.getCommandResult(roomId, command.commandId);
    assert.equal(firstResult.result.roomId, roomId);
  } finally {
    await closeClient(firstSocket);
    await first.app.close();
  }

  const second = await createTestApp({
    authService,
    roomStore: new Map(),
    actorStore: new Map(),
    eventStore: shared.eventStore,
    lock: shared.lock,
    outbox: shared.outbox
  });
  const replacement = await openClient(second.url);
  try {
    await login(replacement, 'create-retry');
    const messages = [];
    const replayDone = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for create replay')), 2000);
      const onMessage = raw => {
        const message = JSON.parse(raw.toString());
        if (message.commandId !== command.commandId) return;
        messages.push(message);
        if (messages.some(item => item.type === 'room_created')
          && messages.some(item => item.type === 'command_ack')) {
          clearTimeout(timer);
          replacement.off('message', onMessage);
          resolve();
        }
      };
      replacement.on('message', onMessage);
    });
    replacement.send(JSON.stringify(command));
    await replayDone;
    const createdAgain = messages.find(message => message.type === 'room_created');
    const replayAck = messages.find(message => message.type === 'command_ack');
    assert.equal(createdAgain.roomId, roomId);
    assert.equal(replayAck.payload.replay, true);
    assert.deepEqual(shared.eventStore.listRooms(), [roomId]);
  } finally {
    await closeClient(replacement);
    await second.app.close();
  }
});

test('registry rebuilds a room from a durable store when roomStore is empty', async () => {
  const shared = createMemoryGameStore();
  const authService = new AuthService();
  const first = await createTestApp({
    authService,
    eventStore: shared.eventStore,
    lock: shared.lock,
    outbox: shared.outbox
  });
  const firstSocket = await openClient(first.url);
  let roomId;
  try {
    await login(firstSocket, 'durable-owner');
    const created = await sendAndWait(firstSocket, createCommand('create_room', { maxPlayers: 2 }), 'room_created');
    roomId = created.roomId;
    await sendAndWait(firstSocket, createCommand('join_room', { name: '恢复' }, { roomId }), 'room_event');
  } finally {
    await closeClient(firstSocket);
    await first.app.close();
  }

  const second = await createTestApp({
    authService,
    roomStore: new Map(),
    actorStore: new Map(),
    eventStore: shared.eventStore,
    lock: shared.lock,
    outbox: shared.outbox
  });
  const replacement = await openClient(second.url);
  try {
    await login(replacement, 'durable-owner');
    const reconnect = createCommand('reconnect', { lastRoomVersion: 0 }, { roomId, roomVersion: 0 });
    const sync = await sendAndWait(replacement, reconnect, 'room_sync');
    assert.equal(sync.payload.snapshot.roomVersion, 1);
    assert.equal(second.app.rooms.get(roomId).players.has('durable-owner'), true);
    assert.equal(second.app.actors.has(roomId), true);
  } finally {
    await closeClient(replacement);
    await second.app.close();
  }
});

test('reconnect returns durable delta and marks syncRequired when history is truncated', async () => {
  const { app, url } = await createTestApp();
  const owner = await openClient(url);
  try {
    await login(owner, 'owner-sync');
    const created = await sendAndWait(owner, createCommand('create_room', { maxPlayers: 2 }), 'room_created');
    const roomId = created.roomId;
    await sendAndWait(owner, createCommand('join_room', { name: '房主' }, { roomId }), 'room_event');
    await app.registry.dispatch(roomId, createCommand('join_room', {
      name: '同步测试'
    }, { roomId }), { actorId: 'other-sync' });

    const fresh = createCommand('reconnect', { lastRoomVersion: 0 }, { roomId, roomVersion: 0 });
    const fullSync = await sendAndWait(owner, fresh, 'room_sync');
    assert.equal(fullSync.payload.snapshotHash, fullSync.payload.snapshot.snapshotHash);
    assert.equal(fullSync.payload.syncRequired, false);
    assert.deepEqual(fullSync.payload.events.map(event => event.roomVersion), [1, 2]);

    const stream = app.eventStore.events.get(roomId);
    app.eventStore.events.set(roomId, stream.slice(-1));
    const stale = createCommand('reconnect', { lastRoomVersion: 0 }, { roomId, roomVersion: 0 });
    const staleSync = await sendAndWait(owner, stale, 'room_sync');
    assert.equal(staleSync.payload.syncRequired, true);
    assert.deepEqual(staleSync.payload.events, []);
    assert.equal(staleSync.payload.snapshot.roomVersion, 2);
  } finally {
    await closeClient(owner);
    await app.close();
  }
});

test('closing one of two device sockets does not mark the player disconnected', async () => {
  const { app, url } = await createTestApp();
  const first = await openClient(url);
  const second = await openClient(url);
  try {
    await login(first, 'multi-device');
    await login(second, 'multi-device');
    const created = await sendAndWait(first, createCommand('create_room', { maxPlayers: 2 }), 'room_created');
    const roomId = created.roomId;
    await sendAndWait(first, createCommand('join_room', { name: '多端' }, { roomId }), 'room_event');
    await closeClient(first);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(app.rooms.get(roomId).players.get('multi-device').connected, true);
    assert.equal(app.gateway.hasReconnectGrace(roomId, 'multi-device'), false);
  } finally {
    if (first.readyState !== WebSocket.CLOSED) await closeClient(first);
    await closeClient(second);
    await app.close();
  }
});

test('gateway serializes concurrent room publications without duplicate versions', async () => {
  const published = [];
  const listeners = new Set();
  const store = {
    getEvents: async (_roomId, { afterVersion, throughVersion }) => {
      await new Promise(resolve => setTimeout(resolve, afterVersion === 0 ? 5 : 0));
      return [1, 2, 3]
        .filter(roomVersion => roomVersion > afterVersion && roomVersion <= throughVersion)
        .map(roomVersion => ({ roomId: 'room-1', roomVersion, version: roomVersion, eventId: `event-${roomVersion}`, type: 'TEST' }));
    }
  };
  const room = {
    id: 'room-1',
    version: 3,
    players: new Map([['p1', {}]]),
    snapshot: () => ({ roomVersion: 3, players: [] })
  };
  const registry = {
    get: () => ({ eventStore: store, room }),
  };
  const socket = {
    readyState: 1,
    playerId: 'p1',
    send(value, callback) {
      const message = JSON.parse(value);
      published.push([message.roomVersion, message.payload.latest.roomVersion]);
      callback?.();
    }
  };
  listeners.add(socket);
  const gateway = new RealtimeGateway({ registry, createEvent: (_type, payload, fields) => ({
    type: 'room_event', payload, roomVersion: fields.roomVersion
  }) });
  gateway.subscribers.set('room-1', listeners);
  await Promise.all([
    gateway.broadcast(room, { roomVersion: 2, version: 2, eventId: 'event-2', type: 'TEST' }),
    gateway.broadcast(room, { roomVersion: 3, version: 3, eventId: 'event-3', type: 'TEST' })
  ]);
  assert.deepEqual(published, [[1, 1], [2, 2], [3, 3]]);
});

test('viewer-scoped broadcasts strip private hand fields for other players', async () => {
  const received = new Map();
  const room = {
    id: 'room-private',
    version: 0,
    ownerId: 'p1',
    players: new Map([['p1', {}], ['p2', {}]]),
    snapshot: ({ viewerId } = {}) => ({ roomVersion: 0, viewerId })
  };
  const registry = { get: () => ({ room, eventStore: { getEvents: async () => [] } }) };
  const gateway = new RealtimeGateway({
    registry,
    createEvent: (type, payload, fields) => ({ type, payload, ...fields, roomVersion: fields.roomVersion })
  });
  for (const playerId of ['p1', 'p2']) {
    const socket = {
      readyState: 1,
      playerId,
      send(value, callback) {
        received.set(playerId, JSON.parse(value));
        callback?.();
      }
    };
    gateway.subscribe(socket, room.id, { playerId });
  }
  const latest = {
    roomId: room.id,
    roomVersion: 1,
    version: 1,
    eventId: 'evt-private',
    type: 'PRIVATE_HAND_UPDATED',
    payload: {
      privateForPlayerId: 'p1',
      privatePayload: { hand: ['wan_1'] },
      hand: ['wan_1']
    }
  };
  await gateway.broadcast(room, latest);
  assert.equal(received.get('p1').visibility, 'player');
  assert.deepEqual(received.get('p1').payload.latest.payload.privatePayload, { hand: ['wan_1'] });
  assert.equal('privatePayload' in received.get('p2').payload.latest.payload, false);
  assert.equal('hand' in received.get('p2').payload.latest.payload, false);
});

test('late subscriptions start at the current live-feed cursor', () => {
  const room = {
    id: 'room-1',
    version: 3,
    ownerId: 'p1',
    players: new Map([['p1', {}]]),
    snapshot: () => ({ roomVersion: 3, players: [] })
  };
  const registry = { get: () => ({ room }) };
  const gateway = new RealtimeGateway({
    registry,
    createEvent: () => ({})
  });
  const socket = { readyState: 1, playerId: 'p1' };
  const subscription = gateway.subscribe(socket, room.id, { playerId: 'p1' });
  assert.equal(subscription.roomVersion, 3);
  assert.equal(gateway.broadcastVersions.get(room.id), 3);
});

test('replaying a persisted command ACK does not publish a duplicate room event', async () => {
  const { app, url } = await createTestApp();
  const owner = await openClient(url);
  try {
    await login(owner, 'replay-owner');
    const created = await sendAndWait(owner, createCommand('create_room', { maxPlayers: 2 }), 'room_created');
    const command = createCommand('join_room', { name: '重试房主' }, { roomId: created.roomId });
    await sendAndWait(owner, command, 'room_event');

    let duplicateEvents = 0;
    const onMessage = raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'room_event' && message.commandId === command.commandId) duplicateEvents += 1;
    };
    owner.on('message', onMessage);
    const ackPromise = waitForMessage(owner, message => (
      message.type === 'command_ack' && message.commandId === command.commandId
    ));
    owner.send(JSON.stringify(command));
    const ack = await ackPromise;
    await new Promise(resolve => setTimeout(resolve, 25));
    owner.off('message', onMessage);
    assert.equal(ack.payload.replay, true);
    assert.equal(duplicateEvents, 0);
    assert.equal(app.eventStore.getLatestVersion(created.roomId), 1);
  } finally {
    await closeClient(owner);
    await app.close();
  }
});

test('a restarted gateway recovers a durable room with an empty room store', async () => {
  const first = await createTestApp();
  const owner = await openClient(first.url);
  let roomId;
  try {
    await login(owner, 'restart-owner');
    const created = await sendAndWait(owner, createCommand('create_room', { maxPlayers: 2 }), 'room_created');
    roomId = created.roomId;
    await sendAndWait(owner, createCommand('join_room', { name: '持久化房主' }, { roomId }), 'room_event');
  } finally {
    await closeClient(owner);
    await first.app.close();
  }

  const second = await createTestApp({ eventStore: first.app.eventStore });
  const replacement = await openClient(second.url);
  try {
    await login(replacement, 'restart-owner');
    const subscribe = createCommand('subscribe', {}, { roomId });
    const ack = await sendAndWait(replacement, subscribe, 'command_ack');
    assert.equal(ack.payload.snapshot.roomId, roomId);
    assert.equal(ack.payload.snapshot.roomVersion, 1);
    assert.ok(second.app.rooms.get(roomId));
    assert.equal(second.app.rooms.get(roomId).players.has('restart-owner'), true);
  } finally {
    await closeClient(replacement);
    await second.app.close();
  }
});

test('closing the app clears reconnect grace timers', async () => {
  const { app, url } = await createTestApp();
  const owner = await openClient(url);
  try {
    await login(owner, 'close-owner');
    const created = await sendAndWait(owner, createCommand('create_room', { maxPlayers: 2 }), 'room_created');
    await sendAndWait(owner, createCommand('join_room', { name: '关闭测试' }, { roomId: created.roomId }), 'room_event');
    await closeClient(owner);
    // The peer close frame can be observed before the server's close handler;
    // give that handler a turn to remove the final connection and schedule
    // the configured grace timer.
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(app.gateway.hasReconnectGrace(created.roomId, 'close-owner'), true);
    await app.close();
    assert.equal(app.gateway.hasReconnectGrace(created.roomId, 'close-owner'), false);
  } finally {
    if (owner.readyState !== WebSocket.CLOSED) await closeClient(owner);
    await app.close();
  }
});

test('app close terminates active sockets and is idempotent', async () => {
  const { app, url } = await createTestApp();
  const owner = await openClient(url);
  try {
    await login(owner, 'shutdown-owner');
    const created = await sendAndWait(owner, createCommand('create_room', { maxPlayers: 2 }), 'room_created');
    const roomId = created.roomId;
    await sendAndWait(owner, createCommand('join_room', { name: '关闭态' }, { roomId }), 'room_event');
    const closed = once(owner, 'close');
    await Promise.race([
      app.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('app.close timed out')), 1000))
    ]);
    await closed;
    assert.equal(owner.readyState, WebSocket.CLOSED);
    // Shutdown must not append a business presence event after the durable
    // room state has been handed off to the next process.
    assert.equal(app.eventStore.getSnapshot(roomId).players[0].connected, true);
    await app.close();
  } finally {
    if (owner.readyState !== WebSocket.CLOSED) owner.terminate();
    await app.close();
  }
});

test('presence changes survive actor recovery without advancing roomVersion', async () => {
  const shared = createMemoryGameStore();
  const authService = new AuthService();
  const first = await createTestApp({
    authService,
    eventStore: shared.eventStore,
    lock: shared.lock,
    outbox: shared.outbox
  });
  const owner = await openClient(first.url);
  let roomId;
  try {
    await login(owner, 'presence-owner');
    const created = await sendAndWait(owner, createCommand('create_room', { maxPlayers: 2 }), 'room_created');
    roomId = created.roomId;
    await sendAndWait(owner, createCommand('join_room', { name: '在线状态' }, { roomId }), 'room_event');
    await closeClient(owner);
    await new Promise(resolve => setTimeout(resolve, 40));
    const offline = shared.eventStore.getPresence(roomId);
    assert.equal(offline.roomVersion, 1);
    assert.equal(offline.presence['presence-owner'].connected, false);
  } finally {
    if (owner.readyState !== WebSocket.CLOSED) await closeClient(owner);
    await first.app.close();
  }

  const second = await createTestApp({
    authService,
    roomStore: new Map(),
    actorStore: new Map(),
    eventStore: shared.eventStore,
    lock: shared.lock,
    outbox: shared.outbox
  });
  const replacement = await openClient(second.url);
  try {
    await login(replacement, 'presence-owner');
    const reconnect = createCommand('reconnect', { lastRoomVersion: 1 }, { roomId, roomVersion: 1 });
    const sync = await sendAndWait(replacement, reconnect, 'room_sync');
    assert.equal(sync.payload.snapshot.roomVersion, 1);
    assert.equal(sync.payload.snapshot.players[0].connected, true);
    assert.equal(shared.eventStore.getPresence(roomId).presence['presence-owner'].connected, true);
  } finally {
    await closeClient(replacement);
    await second.app.close();
  }
});

test('private-only events emit redacted placeholders to preserve viewer cursors', async () => {
  const received = new Map([['p1', []], ['p2', []]]);
  const room = {
    id: 'room-private-only',
    version: 0,
    ownerId: 'p1',
    players: new Map([['p1', {}], ['p2', {}]]),
    snapshot: ({ viewerId } = {}) => ({ roomVersion: 0, viewerId })
  };
  const registry = { get: () => ({ room, eventStore: { getEvents: async () => [] } }) };
  const gateway = new RealtimeGateway({
    registry,
    createEvent: (type, payload, fields) => ({ type, payload, ...fields, roomVersion: fields.roomVersion })
  });
  for (const playerId of ['p1', 'p2']) {
    const socket = {
      readyState: 1,
      playerId,
      send(value, callback) {
        received.get(playerId).push(JSON.parse(value));
        callback?.();
      }
    };
    gateway.subscribe(socket, room.id, { playerId });
  }
  await gateway.broadcast(room, {
    roomId: room.id,
    roomVersion: 1,
    version: 1,
    eventId: 'evt-private-only',
    type: 'PRIVATE_HAND_UPDATED',
    payload: {
      privateForPlayerId: 'p1',
      privateOnly: true,
      privatePayload: { hand: ['wan_1'] },
      hand: ['wan_1']
    }
  });
  await gateway.broadcast(room, {
    roomId: room.id,
    roomVersion: 2,
    version: 2,
    eventId: 'evt-public',
    type: 'PUBLIC_STATE_UPDATED',
    payload: { status: 'playing' }
  });
  assert.deepEqual(received.get('p2').map(message => message.roomVersion), [1, 2]);
  assert.deepEqual(received.get('p2')[0].payload.latest.payload, { redacted: true });
  assert.equal(received.get('p1')[0].visibility, 'player');
  assert.deepEqual(received.get('p1')[0].payload.latest.payload.privatePayload, { hand: ['wan_1'] });
});

test('registry single-flights concurrent durable room recovery', async () => {
  const shared = createMemoryGameStore();
  const source = await createTestApp({
    eventStore: shared.eventStore,
    lock: shared.lock,
    outbox: shared.outbox
  });
  const owner = await openClient(source.url);
  let roomId;
  try {
    await login(owner, 'recovery-owner');
    const created = await sendAndWait(owner, createCommand('create_room', { maxPlayers: 2 }), 'room_created');
    roomId = created.roomId;
  } finally {
    await closeClient(owner);
    await source.app.close();
  }
  const registry = new (source.app.registry.constructor)({
    rooms: new Map(),
    actors: new Map(),
    eventStore: shared.eventStore,
    lock: shared.lock,
    outbox: shared.outbox
  });
  const actors = await Promise.all([registry.recover(roomId), registry.recover(roomId), registry.recover(roomId)]);
  assert.equal(new Set(actors).size, 1);
  assert.equal(registry.actors.size, 1);
  await registry.close();
});
