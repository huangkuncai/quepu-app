import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createRealtimeServer } from '../src/server.js';
import { createCommand, createEvent } from '../src/protocol/index.js';
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

async function createTestApp() {
  const config = loadConfig({ NODE_ENV: 'test', PORT: '8787' });
  const app = createRealtimeServer({ config, port: 0, host: '127.0.0.1' });
  await once(app.wss, 'listening');
  const address = app.wss.address();
  return { app, url: `ws://127.0.0.1:${address.port}` };
}

async function login(ws, playerId, deviceId) {
  const command = createCommand('login', { playerId, deviceId, platform: 'android' });
  ws.send(JSON.stringify(command));
  return waitForMessage(ws, message => message.type === 'login_ok');
}

async function sendAndWait(ws, command, type) {
  ws.send(JSON.stringify(command));
  return waitForMessage(ws, message => message.type === type && message.commandId === command.commandId);
}

class EventReducerFixture {
  constructor() {
    this.version = -1;
    this.snapshot = null;
    this.syncRequired = false;
  }

  apply(event) {
    if (event.roomVersion <= this.version) return 'duplicate';
    if (event.roomVersion > this.version + 1) {
      this.syncRequired = true;
      return 'sync_required';
    }
    this.version = event.roomVersion;
    this.snapshot = event.payload.snapshot || this.snapshot;
    this.syncRequired = false;
    return 'applied';
  }

  applySync(payload) {
    this.snapshot = payload.snapshot;
    this.version = this.snapshot.roomVersion ?? this.snapshot.version;
    this.syncRequired = false;
  }
}

test('four authenticated clients receive an ordered public room snapshot and reconnect sync', async () => {
  const { app, url } = await createTestApp();
  const clients = await Promise.all([1, 2, 3, 4].map(index => openClient(url)));
  const inboxes = clients.map(ws => {
    const inbox = [];
    ws.on('message', raw => inbox.push(JSON.parse(raw.toString())));
    return inbox;
  });
  try {
    const sessions = await Promise.all(clients.map((ws, index) => login(ws, `player-${index + 1}`, `device-${index + 1}`)));
    const create = createCommand('create_room', {
      maxPlayers: 4,
      ruleId: 'fake-1',
      ruleVersion: 'fake-1'
    });
    const created = await sendAndWait(clients[0], create, 'room_created');
    const roomId = created.roomId;
    assert.ok(roomId);

    for (let index = 0; index < clients.length; index += 1) {
      const join = createCommand('join_room', { name: `玩家${index + 1}` }, { roomId });
      await sendAndWait(clients[index], join, 'room_event');
    }
    await new Promise(resolve => setTimeout(resolve, 10));
    for (const inbox of inboxes) {
      const latest = inbox.filter(message => message.type === 'room_event').at(-1);
      assert.equal(latest.roomVersion, 4);
      assert.equal(latest.payload.snapshot.players.length, 4);
      assert.equal('hand' in latest.payload.snapshot, false);
    }

    const start = createCommand('start_round', {}, { roomId });
    const started = await sendAndWait(clients[0], start, 'room_event');
    assert.equal(started.payload.snapshot.status, 'playing');
    assert.equal(started.roomVersion, 5);
    const action = createCommand('action', { action: 'pass' }, { roomId, roomVersion: 5 });
    const actionEvent = await sendAndWait(clients[0], action, 'room_event');
    assert.equal(actionEvent.roomVersion, 6);

    await closeClient(clients[3]);
    const nextAction = createCommand('action', { action: 'pass' }, { roomId, roomVersion: 6 });
    await sendAndWait(clients[1], nextAction, 'room_event');

    const replacement = await openClient(url);
    try {
      const replacementLogin = await login(replacement, 'player-4', 'device-4b');
      assert.notEqual(replacementLogin.payload.sessionId, sessions[3].payload.sessionId);
      const reconnect = createCommand('reconnect', { lastRoomVersion: 4 }, { roomId, roomVersion: 4 });
      const sync = await sendAndWait(replacement, reconnect, 'room_sync');
      assert.equal(sync.payload.snapshot.roomVersion, 7);
      assert.equal(sync.payload.events.length, 3);
      assert.deepEqual(sync.payload.events.map(event => event.version), [5, 6, 7]);
    } finally {
      await closeClient(replacement);
    }
  } finally {
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.CLOSED) await closeClient(ws);
    }
    await app.close();
  }
});

test('client reducer fixture detects gaps and ignores duplicate/out-of-order events', () => {
  const event = version => createEvent('room_event', {
    snapshot: { roomVersion: version, status: version < 3 ? 'waiting' : 'playing' }
  }, { roomId: 'room-1', roomVersion: version });
  const reducer = new EventReducerFixture();
  assert.equal(reducer.apply(event(0)), 'applied');
  assert.equal(reducer.apply(event(0)), 'duplicate');
  assert.equal(reducer.apply(event(2)), 'sync_required');
  reducer.applySync({ snapshot: { roomVersion: 2 } });
  assert.equal(reducer.apply(event(1)), 'duplicate');
  assert.equal(reducer.version, 2);
  assert.equal(reducer.syncRequired, false);
});
