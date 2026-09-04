import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createRealtimeServer } from '../src/server.js';
import { createMemoryGameStore } from '../src/infra/persistence/index.js';
import { AuthService } from '../src/modules/auth/index.js';
import { createCommand } from '../src/protocol/index.js';
import { loadConfig } from '../src/config/index.js';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

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
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  await new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      ws.off('close', finish);
      resolve();
    };
    ws.once('close', finish);
    try {
      ws.close();
    } catch {
      finish();
    }
    setTimeout(() => {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      finish();
    }, 500).unref?.();
  });
}

async function createTestApp(overrides = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: '8787',
    WS_RECONNECT_GRACE_MS: '1000'
  });
  const app = createRealtimeServer({
    config,
    port: 0,
    host: '127.0.0.1',
    ...overrides
  });
  await once(app.wss, 'listening');
  const address = app.wss.address();
  return { app, url: `ws://127.0.0.1:${address.port}` };
}

async function login(ws, playerId, deviceId = `${playerId}-device`) {
  const command = createCommand('login', { playerId, deviceId, platform: 'android' });
  ws.send(JSON.stringify(command));
  return waitForMessage(ws, message => message.type === 'login_ok');
}

async function sendAndWait(ws, command, type) {
  ws.send(JSON.stringify(command));
  return waitForMessage(ws, message => message.type === type && message.commandId === command.commandId);
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail('timed out waiting for condition');
}

/**
 * A deterministic server-to-client fault shim. It sits at the gateway send
 * boundary so ACKs and persistence still use the normal WSS path while the
 * selected room-event stream can be delayed, dropped, reordered, or copied.
 */
class FaultInjector {
  constructor({ gateway, targetPlayerId, plan = {} }) {
    this.gateway = gateway;
    this.targetPlayerId = targetPlayerId;
    this.plan = plan;
    this.originalSend = null;
    this.pending = new Set();
    this.deliveries = [];
  }

  install() {
    if (this.originalSend) return this;
    this.originalSend = this.gateway.send;
    this.gateway.send = (socket, message) => {
      if (socket?.playerId !== this.targetPlayerId || message?.type !== 'room_event') {
        return this.originalSend.call(this.gateway, socket, message);
      }
      const roomVersion = message.roomVersion;
      const rule = this.plan[roomVersion] || {};
      if (rule.drop === true) {
        this.deliveries.push({ roomVersion, kind: 'dropped' });
        // The network accepted the frame but lost it after leaving the server.
        return true;
      }
      const copies = rule.duplicate === true ? 2 : 1;
      const baseDelay = Number.isFinite(rule.delayMs) ? rule.delayMs : 0;
      for (let copy = 0; copy < copies; copy += 1) {
        const deliveryDelay = Math.max(0, baseDelay + copy);
        const timer = setTimeout(() => {
          this.pending.delete(timer);
          this.deliveries.push({ roomVersion, kind: 'delivered', copy, delayMs: deliveryDelay });
          this.originalSend.call(this.gateway, socket, message);
        }, deliveryDelay);
        timer.unref?.();
        this.pending.add(timer);
      }
      return true;
    };
    return this;
  }

  async flush() {
    if (this.pending.size === 0) return;
    // The plans are intentionally small and bounded. Polling the pending set
    // keeps this helper deterministic without exposing timer handles to tests.
    await waitUntil(() => this.pending.size === 0, 1000);
    // `ws.send` completes synchronously at the server boundary, while the
    // peer's `message` callback is delivered on a later libuv turn.
    await delay(10);
  }

  restore() {
    if (!this.originalSend) return;
    for (const timer of this.pending) clearTimeout(timer);
    this.pending.clear();
    this.gateway.send = this.originalSend;
    this.originalSend = null;
  }
}

class RoomReducerFixture {
  constructor({ roomVersion = 0, snapshot = null } = {}) {
    this.roomVersion = roomVersion;
    this.snapshot = snapshot;
    this.appliedVersions = [];
    this.duplicateVersions = [];
    this.gaps = [];
    this.syncRequired = false;
  }

  applyRoomEvent(message) {
    const version = message.roomVersion;
    if (version <= this.roomVersion) {
      this.duplicateVersions.push(version);
      return 'duplicate';
    }
    if (version > this.roomVersion + 1) {
      this.gaps.push({ expected: this.roomVersion + 1, actual: version });
      this.syncRequired = true;
      return 'sync_required';
    }
    this.roomVersion = version;
    this.snapshot = message.payload?.snapshot || this.snapshot;
    this.appliedVersions.push(version);
    this.syncRequired = false;
    return 'applied';
  }

  applySync(message) {
    const snapshot = message.payload?.snapshot;
    assert.ok(snapshot && Number.isInteger(snapshot.roomVersion));
    this.snapshot = structuredClone(snapshot);
    this.roomVersion = snapshot.roomVersion;
    this.syncRequired = false;
  }
}

async function setupFourClients({ app, url, inboxes }) {
  const clients = await Promise.all([1, 2, 3, 4].map(() => openClient(url)));
  clients.forEach((ws, index) => {
    inboxes[index] = [];
    ws.on('message', raw => inboxes[index].push(JSON.parse(raw.toString())));
  });
  await Promise.all(clients.map((ws, index) => login(ws, `qa-player-${index + 1}`, `qa-device-${index + 1}`)));
  const created = await sendAndWait(clients[0], createCommand('create_room', { maxPlayers: 4 }), 'room_created');
  const roomId = created.roomId;
  for (let index = 0; index < clients.length; index += 1) {
    const join = createCommand('join_room', { name: `QA玩家${index + 1}` }, { roomId });
    await sendAndWait(clients[index], join, 'room_event');
  }
  await waitUntil(() => app.rooms.get(roomId)?.version === 4);
  return { clients, roomId };
}

function baselineReducer(inbox) {
  const events = inbox
    .filter(message => message.type === 'room_event' && message.roomVersion <= 4)
    .sort((left, right) => left.roomVersion - right.roomVersion);
  // A client that subscribes after the first three joins is intentionally
  // seeded from its current room snapshot. The fault matrix starts after the
  // four-client baseline, so it must not pretend those historical frames were
  // received on the wire.
  const latest = events.at(-1);
  assert.equal(latest?.roomVersion, 4);
  return new RoomReducerFixture({
    roomVersion: latest.roomVersion,
    snapshot: latest.payload?.snapshot
  });
}

test('QA-201 fault matrix converges after delayed, dropped, reordered and duplicated events', async () => {
  const { app, url } = await createTestApp();
  const inboxes = [];
  let clients = [];
  let roomId;
  let injector;
  try {
    ({ clients, roomId } = await setupFourClients({ app, url, inboxes }));
    const target = clients[3];
    const reducer = baselineReducer(inboxes[3]);
    injector = new FaultInjector({
      gateway: app.gateway,
      targetPlayerId: 'qa-player-4',
      plan: {
        // v7 and v8 arrive before the delayed v5; v6 is lost entirely.
        5: { delayMs: 60 },
        6: { drop: true },
        7: { delayMs: 5, duplicate: true },
        8: { delayMs: 15 }
      }
    }).install();
    const started = await sendAndWait(
      clients[0],
      createCommand('start_round', {}, { roomId }),
      'room_event'
    );
    assert.equal(started.roomVersion, 5);
    const actionOne = await sendAndWait(
      clients[0],
      createCommand('action', { action: 'pass' }, { roomId, roomVersion: 5 }),
      'room_event'
    );
    assert.equal(actionOne.roomVersion, 6);
    const actionTwo = await sendAndWait(
      clients[1],
      createCommand('action', { action: 'pass' }, { roomId, roomVersion: 6 }),
      'room_event'
    );
    assert.equal(actionTwo.roomVersion, 7);
    const actionThree = await sendAndWait(
      clients[2],
      createCommand('action', { action: 'pass' }, { roomId, roomVersion: 7 }),
      'room_event'
    );
    assert.equal(actionThree.roomVersion, 8);

    await injector.flush();
    const injectedEvents = inboxes[3]
      .filter(message => message.type === 'room_event' && message.roomVersion > 4)
      .map(message => message.roomVersion);
    assert.deepEqual(injectedEvents, [7, 7, 8, 5]);
    assert.deepEqual(injector.deliveries.filter(item => item.kind === 'dropped').map(item => item.roomVersion), [6]);

    const outcomes = inboxes[3]
      .filter(message => message.type === 'room_event' && message.roomVersion > 4)
      .map(message => reducer.applyRoomEvent(message));
    assert.deepEqual(outcomes, ['sync_required', 'sync_required', 'sync_required', 'applied']);
    assert.deepEqual(reducer.duplicateVersions, []);
    assert.ok(reducer.gaps.length >= 1);

    const reconnect = createCommand(
      'reconnect',
      { lastRoomVersion: reducer.roomVersion },
      { roomId, roomVersion: reducer.roomVersion }
    );
    const sync = await sendAndWait(target, reconnect, 'room_sync');
    assert.equal(sync.payload.syncRequired, false);
    assert.deepEqual(sync.payload.events.map(event => event.roomVersion), [6, 7, 8]);
    reducer.applySync(sync);
    const duplicateFrame = inboxes[3].find(
      message => message.type === 'room_event' && message.roomVersion === 7
    );
    assert.equal(reducer.applyRoomEvent(duplicateFrame), 'duplicate');
    assert.deepEqual(reducer.duplicateVersions, [7]);
    const authoritative = app.rooms.get(roomId).snapshot({ viewerId: 'qa-player-4' });
    assert.equal(reducer.roomVersion, authoritative.roomVersion);
    assert.equal(reducer.snapshot.snapshotHash, authoritative.snapshotHash);
  } finally {
    injector?.restore();
    for (const ws of clients) await closeClient(ws);
    await app.close();
  }
});

test('BE-206 restart recovers a dropped stream with room_sync and matching snapshotHash', async () => {
  const shared = createMemoryGameStore();
  const authService = new AuthService();
  const first = await createTestApp({
    authService,
    eventStore: shared.eventStore,
    lock: shared.lock,
    outbox: shared.outbox
  });
  const inboxes = [];
  let clients = [];
  let roomId;
  let injector;
  try {
    ({ clients, roomId } = await setupFourClients({ app: first.app, url: first.url, inboxes }));
    const reducer = baselineReducer(inboxes[3]);
    injector = new FaultInjector({
      gateway: first.app.gateway,
      targetPlayerId: 'qa-player-4',
      plan: { 5: { drop: true }, 6: { delayMs: 20 } }
    }).install();
    await sendAndWait(
      clients[0],
      createCommand('start_round', {}, { roomId }),
      'room_event'
    );
    await sendAndWait(
      clients[0],
      createCommand('action', { action: 'pass' }, { roomId, roomVersion: 5 }),
      'room_event'
    );
    await injector.flush();
    const delayed = inboxes[3].find(message => message.type === 'room_event' && message.roomVersion === 6);
    assert.ok(delayed);
    assert.equal(reducer.applyRoomEvent(delayed), 'sync_required');
    assert.equal(reducer.roomVersion, 4);

    injector.restore();
    for (const ws of clients) await closeClient(ws);
    clients = [];
    await first.app.close();
    // The close handler persists the final connection overlay at the same
    // game version. Capture the checkpoint after shutdown so the restart
    // assertion includes those durable presence flags as well.
    const durableSnapshot = shared.eventStore.getSnapshot(roomId);
    assert.equal(durableSnapshot.roomVersion, 6);

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
      await login(replacement, 'qa-player-4', 'qa-device-4-restart');
      const reconnect = createCommand(
        'reconnect',
        { lastRoomVersion: reducer.roomVersion },
        { roomId, roomVersion: reducer.roomVersion }
      );
      const sync = await sendAndWait(replacement, reconnect, 'room_sync');
      assert.equal(sync.payload.syncRequired, false);
      assert.deepEqual(sync.payload.events.map(event => event.roomVersion), [5, 6]);
      assert.equal(sync.payload.snapshot.roomVersion, 6);
      assert.equal(sync.payload.snapshotHash, sync.payload.snapshot.snapshotHash);
      // Compare against the durable snapshot at the same point in time. The
      // presence overlay may have changed while the replacement socket came
      // back, so a pre-reconnect checkpoint is not a valid hash oracle.
      const durableAfterReconnect = shared.eventStore.getSnapshot(roomId);
      assert.equal(sync.payload.snapshotHash, durableAfterReconnect.snapshotHash);
      assert.equal(second.app.rooms.get(roomId).players.has('qa-player-4'), true);
      reducer.applySync(sync);
      assert.equal(reducer.snapshot.snapshotHash, durableAfterReconnect.snapshotHash);
      assert.equal(reducer.roomVersion, 6);
    } finally {
      await closeClient(replacement);
      await second.app.close();
    }
  } finally {
    injector?.restore();
    for (const ws of clients) await closeClient(ws);
    await first.app.close();
  }
});
