import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { createRealtimeServer } from '../src/server.js';
import { loadConfig } from '../src/config/index.js';

async function startApp() {
  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: '8787',
    WS_MAX_PAYLOAD_BYTES: '262144'
  });
  const app = createRealtimeServer({
    config,
    port: 0,
    host: '127.0.0.1',
    http: true,
    httpPort: 0,
    httpHost: '127.0.0.1'
  });
  await Promise.all([
    once(app.wss, 'listening'),
    once(app.api.server, 'listening')
  ]);
  const address = app.api.server.address();
  return { app, baseUrl: `http://127.0.0.1:${address.port}/api/v1` };
}

async function stopApp(app) {
  await app.close();
}

async function json(response) {
  const body = response.status === 204 || response.status === 304 ? null : await response.json();
  return { response, body };
}

async function login(baseUrl, phone) {
  const { response, body } = await json(await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, code: '000000', deviceId: `${phone}-device`, platform: 'test' })
  }));
  assert.equal(response.status, 200);
  assert.ok(body.data.accessToken);
  return body.data;
}

function authHeaders(session, extra = {}) {
  return {
    authorization: `Bearer ${session.accessToken}`,
    'content-type': 'application/json',
    ...extra
  };
}

test('BE-205 room REST shares actor state, ETags and idempotency with the WSS path', async () => {
  const { app, baseUrl } = await startApp();
  try {
    const owner = await login(baseUrl, '13800000001');
    const guest = await login(baseUrl, '13800000002');

    const create = await json(await fetch(`${baseUrl}/rooms`, {
      method: 'POST',
      headers: authHeaders(owner, { 'idempotency-key': 'create-http-room' }),
      body: JSON.stringify({ maxPlayers: 2, ruleVersion: 'fake-http-v1' })
    }));
    assert.equal(create.response.status, 201);
    assert.equal(create.body.data.status, 'waiting');
    assert.equal(create.body.meta.roomVersion, 0);
    const roomId = create.body.data.roomId;
    assert.ok(roomId);
    assert.match(create.response.headers.get('etag'), /^"[a-f0-9]{64}"$/);

    const replay = await json(await fetch(`${baseUrl}/rooms`, {
      method: 'POST',
      headers: authHeaders(owner, { 'idempotency-key': 'create-http-room' }),
      body: JSON.stringify({ maxPlayers: 2, ruleVersion: 'fake-http-v1' })
    }));
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.meta.replay, true);
    assert.equal(replay.body.data.id, roomId);

    const firstRoom = await json(await fetch(`${baseUrl}/rooms/${roomId}`, {
      headers: { authorization: `Bearer ${owner.accessToken}` }
    }));
    assert.equal(firstRoom.response.status, 200);
    assert.equal(firstRoom.body.data.roomVersion, 0);
    const initialEtag = firstRoom.response.headers.get('etag');

    const notModified = await json(await fetch(`${baseUrl}/rooms/${roomId}`, {
      headers: {
        authorization: `Bearer ${owner.accessToken}`,
        'if-none-match': initialEtag
      }
    }));
    assert.equal(notModified.response.status, 304);
    assert.equal(notModified.body, null);

    const ownerJoin = await json(await fetch(`${baseUrl}/rooms/${roomId}/join`, {
      method: 'POST',
      headers: authHeaders(owner, { 'idempotency-key': 'join-owner' }),
      body: JSON.stringify({ name: '房主', seat: 0 })
    }));
    assert.equal(ownerJoin.response.status, 200);
    assert.equal(ownerJoin.body.data.room.roomVersion, 1);
    const ownerJoinReplay = await json(await fetch(`${baseUrl}/rooms/${roomId}/join`, {
      method: 'POST',
      headers: authHeaders(owner, { 'idempotency-key': 'join-owner' }),
      body: JSON.stringify({ name: '房主', seat: 0 })
    }));
    assert.equal(ownerJoinReplay.response.status, 200);
    assert.equal(ownerJoinReplay.body.data.replay, true);
    assert.equal(ownerJoinReplay.body.data.room.roomVersion, 1);

    const guestJoin = await json(await fetch(`${baseUrl}/rooms/${roomId}/join`, {
      method: 'POST',
      headers: authHeaders(guest, { 'idempotency-key': 'join-guest' }),
      body: JSON.stringify({ name: '来宾', seat: 1 })
    }));
    assert.equal(guestJoin.response.status, 200);
    assert.equal(guestJoin.body.data.room.roomVersion, 2);

    const stale = await json(await fetch(`${baseUrl}/rooms/${roomId}/ready`, {
      method: 'POST',
      headers: authHeaders(owner, {
        'idempotency-key': 'ready-owner-stale',
        'if-match': initialEtag
      }),
      body: JSON.stringify({ ready: true })
    }));
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.error.code, 'VERSION_CONFLICT');

    const ownerReady = await json(await fetch(`${baseUrl}/rooms/${roomId}/ready`, {
      method: 'POST',
      headers: authHeaders(owner, { 'idempotency-key': 'ready-owner' }),
      body: JSON.stringify({ ready: true, roomVersion: 2 })
    }));
    assert.equal(ownerReady.response.status, 200);
    assert.equal(ownerReady.body.data.room.roomVersion, 3);

    const guestReady = await json(await fetch(`${baseUrl}/rooms/${roomId}/ready`, {
      method: 'POST',
      headers: authHeaders(guest, { 'idempotency-key': 'ready-guest' }),
      body: JSON.stringify({ ready: true, roomVersion: 3 })
    }));
    assert.equal(guestReady.response.status, 200);
    assert.equal(guestReady.body.data.room.status, 'ready');

    const start = await json(await fetch(`${baseUrl}/rooms/${roomId}/start`, {
      method: 'POST',
      headers: authHeaders(owner, { 'idempotency-key': 'start-room' }),
      body: JSON.stringify({ roomVersion: 4 })
    }));
    assert.equal(start.response.status, 200);
    assert.equal(start.body.data.room.status, 'playing');
    assert.equal(start.body.data.room.roomVersion, 5);
  } finally {
    await stopApp(app);
  }
});

test('BE-205 room REST enforces authentication, membership and command envelope errors', async () => {
  const { app, baseUrl } = await startApp();
  try {
    const unauthenticated = await json(await fetch(`${baseUrl}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxPlayers: 2 })
    }));
    assert.equal(unauthenticated.response.status, 401);
    assert.equal(unauthenticated.body.error.code, 'AUTH_REQUIRED');

    const owner = await login(baseUrl, '13800000003');
    const guest = await login(baseUrl, '13800000004');
    const create = await json(await fetch(`${baseUrl}/rooms`, {
      method: 'POST',
      headers: authHeaders(owner, { 'idempotency-key': 'member-room' }),
      body: JSON.stringify({ maxPlayers: 2, clubId: 'club-a', accessPolicy: 'MEMBERS_ONLY' })
    }));
    assert.equal(create.response.status, 201);
    const roomId = create.body.data.roomId;

    const forbidden = await json(await fetch(`${baseUrl}/rooms/${roomId}`, {
      headers: { authorization: `Bearer ${guest.accessToken}` }
    }));
    assert.equal(forbidden.response.status, 403);
    assert.equal(forbidden.body.error.code, 'FORBIDDEN');

    const invalidCommand = await json(await fetch(`${baseUrl}/rooms/${roomId}/commands`, {
      method: 'POST',
      headers: authHeaders(owner, { 'idempotency-key': 'invalid-command' }),
      body: JSON.stringify({
        protocolVersion: '1.0',
        type: 'ready',
        payload: { ready: true }
      })
    }));
    assert.equal(invalidCommand.response.status, 422);
    assert.equal(invalidCommand.body.error.code, 'VALIDATION_FAILED');
  } finally {
    await stopApp(app);
  }
});
