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
  await Promise.all([once(app.wss, 'listening'), once(app.api.server, 'listening')]);
  const address = app.api.server.address();
  return { app, baseUrl: `http://127.0.0.1:${address.port}/api/v1` };
}

async function json(response) {
  const body = response.status === 204 || response.status === 304 ? null : await response.json();
  return { response, body };
}

async function login(baseUrl, playerId) {
  const { response, body } = await json(await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, deviceId: `${playerId}-device`, platform: 'test' })
  }));
  assert.equal(response.status, 200);
  return body.data;
}

function headers(session, extra = {}) {
  return {
    authorization: `Bearer ${session.accessToken}`,
    'content-type': 'application/json',
    ...extra
  };
}

test('BE-207 support tickets are authenticated, owner-isolated, auditable and idempotent', async () => {
  const { app, baseUrl } = await startApp();
  try {
    const owner = await login(baseUrl, 'support-owner');
    const other = await login(baseUrl, 'support-other');

    const unauthenticated = await json(await fetch(`${baseUrl}/support/tickets`));
    assert.equal(unauthenticated.response.status, 401);
    assert.equal(unauthenticated.body.error.code, 'AUTH_REQUIRED');

    const createBody = {
      subject: '房间无法进入',
      category: 'ROOM',
      message: '进入房间时提示网络错误',
      roomId: 'room-demo-1',
      clientVersion: '0.1.0-poc'
    };
    const create = await json(await fetch(`${baseUrl}/support/tickets`, {
      method: 'POST',
      headers: headers(owner, { 'idempotency-key': 'support-create-1' }),
      body: JSON.stringify(createBody)
    }));
    assert.equal(create.response.status, 201);
    assert.equal(create.body.data.status, 'OPEN');
    assert.equal(create.body.data.ownerUserId, 'support-owner');
    assert.equal(create.body.data.roomId, 'room-demo-1');
    assert.equal(create.body.data.messages.length, 1);
    const ticketId = create.body.data.id;

    const replay = await json(await fetch(`${baseUrl}/support/tickets`, {
      method: 'POST',
      headers: headers(owner, { 'idempotency-key': 'support-create-1' }),
      body: JSON.stringify(createBody)
    }));
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.meta.replay, true);
    assert.equal(replay.body.data.id, ticketId);

    const conflict = await json(await fetch(`${baseUrl}/support/tickets`, {
      method: 'POST',
      headers: headers(owner, { 'idempotency-key': 'support-create-1' }),
      body: JSON.stringify({ ...createBody, message: '另一段描述' })
    }));
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');

    const list = await json(await fetch(`${baseUrl}/support/tickets`, {
      headers: headers(owner)
    }));
    assert.equal(list.response.status, 200);
    assert.equal(list.body.data.tickets.length, 1);
    assert.equal(list.body.data.tickets[0].id, ticketId);

    const otherList = await json(await fetch(`${baseUrl}/support/tickets`, {
      headers: headers(other)
    }));
    assert.equal(otherList.response.status, 200);
    assert.equal(otherList.body.data.tickets.length, 0);

    const otherDetail = await json(await fetch(`${baseUrl}/support/tickets/${ticketId}`, {
      headers: headers(other)
    }));
    assert.equal(otherDetail.response.status, 404);
    assert.equal(otherDetail.body.error.code, 'SUPPORT_TICKET_NOT_FOUND');

    const reply = await json(await fetch(`${baseUrl}/support/tickets/${ticketId}/messages`, {
      method: 'POST',
      headers: headers(owner, { 'idempotency-key': 'support-reply-1' }),
      body: JSON.stringify({ message: '补充：重试后仍然失败' })
    }));
    assert.equal(reply.response.status, 201);
    assert.equal(reply.body.data.ticket.messageCount, 2);
    assert.equal(reply.body.data.message.authorUserId, 'support-owner');

    const replyReplay = await json(await fetch(`${baseUrl}/support/tickets/${ticketId}/messages`, {
      method: 'POST',
      headers: headers(owner, { 'idempotency-key': 'support-reply-1' }),
      body: JSON.stringify({ message: '补充：重试后仍然失败' })
    }));
    assert.equal(replyReplay.response.status, 200);
    assert.equal(replyReplay.body.meta.replay, true);
    assert.equal(replyReplay.body.data.ticket.messageCount, 2);

    const messages = await json(await fetch(`${baseUrl}/support/tickets/${ticketId}/messages`, {
      headers: headers(owner)
    }));
    assert.equal(messages.response.status, 200);
    assert.equal(messages.body.data.messages.length, 2);

    const close = await json(await fetch(`${baseUrl}/support/tickets/${ticketId}/close`, {
      method: 'POST',
      headers: headers(owner, { 'idempotency-key': 'support-close-1' }),
      body: JSON.stringify({ reason: '问题已解决' })
    }));
    assert.equal(close.response.status, 200);
    assert.equal(close.body.data.status, 'CLOSED');

    const closedReply = await json(await fetch(`${baseUrl}/support/tickets/${ticketId}/messages`, {
      method: 'POST',
      headers: headers(owner),
      body: JSON.stringify({ message: '再次追问' })
    }));
    assert.equal(closedReply.response.status, 409);
    assert.equal(closedReply.body.error.code, 'SUPPORT_TICKET_CLOSED');

    const audit = app.supportService.listAuditLogs({ resourceId: ticketId, limit: 20 });
    assert.equal(audit.length, 3);
    assert.deepEqual(audit.map(entry => entry.action).sort(), [
      'SUPPORT_MESSAGE_ADDED',
      'SUPPORT_TICKET_CLOSED',
      'SUPPORT_TICKET_CREATED'
    ].sort());
    for (const entry of audit) {
      assert.equal(entry.resourceType, 'support_ticket');
      assert.equal(entry.actorUserId, 'support-owner');
      assert.equal(Object.hasOwn(entry.metadata, 'body'), false);
    }
  } finally {
    await app.close();
  }
});

test('BE-207 support MVP rejects blank/oversized text and disabled attachment/channel fields', async () => {
  const { app, baseUrl } = await startApp();
  try {
    const owner = await login(baseUrl, 'support-validation');
    for (const body of [
      { subject: ' ', message: '描述' },
      { subject: '标题', message: 'x'.repeat(2001) },
      { subject: '标题', message: '描述', attachments: [] },
      { subject: '标题', message: '描述', channel: 'external' }
    ]) {
      const result = await json(await fetch(`${baseUrl}/support/tickets`, {
        method: 'POST',
        headers: headers(owner),
        body: JSON.stringify(body)
      }));
      assert.equal(result.response.status, 422);
      assert.equal(result.body.error.code, 'SUPPORT_TEXT_INVALID');
    }
  } finally {
    await app.close();
  }
});

