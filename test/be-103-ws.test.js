import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createRealtimeServer } from '../src/server.js';
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

async function createTestApp() {
  const config = loadConfig({ NODE_ENV: 'test', PORT: '8787', WS_MAX_PAYLOAD_BYTES: '65536' });
  const app = createRealtimeServer({ config, port: 0, host: '127.0.0.1' });
  await once(app.wss, 'listening');
  const address = app.wss.address();
  return { app, url: `ws://127.0.0.1:${address.port}` };
}

test('unauthenticated business commands are rejected before room lookup', async () => {
  const { app, url } = await createTestApp();
  const ws = await openClient(url);
  try {
    const command = createCommand('create_room', {});
    ws.send(JSON.stringify(command));
    const response = await waitForMessage(ws);
    assert.equal(response.type, 'error');
    assert.equal(response.error.code, 'AUTH_REQUIRED');
    assert.equal(response.requestId, command.requestId);
  } finally {
    await closeClient(ws);
    await app.close();
  }
});

test('login, room commands and multiple-device close handling use the same session gate', async () => {
  const { app, url } = await createTestApp();
  const first = await openClient(url);
  const second = await openClient(url);
  try {
    const login = createCommand('login', { playerId: 'player-1', deviceId: 'one', platform: 'android' });
    first.send(JSON.stringify(login));
    const firstLogin = await waitForMessage(first, message => message.type === 'login_ok');
    second.send(JSON.stringify(createCommand('login', { playerId: 'player-1', deviceId: 'two', platform: 'ios' })));
    const secondLogin = await waitForMessage(second, message => message.type === 'login_ok');
    assert.notEqual(firstLogin.payload.sessionId, secondLogin.payload.sessionId);
    assert.equal(app.clients.get('player-1').size, 2);

    const create = createCommand('create_room', { maxPlayers: 4 });
    second.send(JSON.stringify(create));
    const created = await waitForMessage(second, message => message.type === 'room_created');
    const roomId = created.roomId;
    assert.ok(roomId);

    second.send(JSON.stringify(createCommand('join_room', { name: '玩家一' }, { roomId })));
    const joined = await waitForMessage(second, message => message.type === 'room_event');
    assert.equal(joined.payload.snapshot.players.length, 1);

    await closeClient(first);
    for (let attempt = 0; attempt < 20 && app.clients.get('player-1')?.size !== 1; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(app.clients.get('player-1').size, 1);
    assert.doesNotThrow(() => app.authService.requireAuth(secondLogin.payload.accessToken));
  } finally {
    if (first.readyState !== WebSocket.CLOSED) await closeClient(first);
    if (second.readyState !== WebSocket.CLOSED) await closeClient(second);
    await app.close();
  }
});
