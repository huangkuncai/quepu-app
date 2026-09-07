import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { URL } from 'node:url';

import { parseBearerToken } from '../auth/index.js';
import { loadSchema, validateCommand, validateSchema } from '../../protocol/index.js';
import { AppError, asAppError, toErrorPayload } from '../../shared/errors.js';

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const ROOM_PATH_COMMANDS = Object.freeze({
  join: 'join_room',
  leave: 'leave_room',
  ready: 'ready',
  zeng: 'increase_zeng',
  start: 'start_round',
  begin: 'begin_playing',
  action: 'action',
  settle: 'settle_round',
  next: 'next_round',
  disband: 'disband_room'
});
const ROOM_PAYLOAD_SCHEMAS = Object.freeze({
  join_room: 'join-room-payload.schema.json',
  leave_room: 'leave-room-payload.schema.json',
  ready: 'ready-room-payload.schema.json',
  increase_zeng: 'increase-zeng-payload.schema.json',
  begin_playing: 'begin-playing-payload.schema.json',
  action: 'action-payload.schema.json',
  settle_round: 'settle-room-payload.schema.json',
  next_round: 'next-round-payload.schema.json',
  disband_room: 'disband-room-payload.schema.json'
});

function clone(value) {
  if (value === undefined || value === null) return value;
  return structuredClone(value);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, field, { required = true, max = 256 } = {}) {
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
    throw new AppError('INVALID_ACTION', {
      details: [{ path: field, message: `must be <= ${max} characters` }]
    });
  }
  return normalized;
}

function requestId(request, body) {
  return text(
    request.headers['x-request-id'] || body?.requestId || randomUUID(),
    'requestId',
    { max: 256 }
  );
}

function commandId(request, body, requestIdValue) {
  const header = request.headers['idempotency-key'];
  const bodyValue = body?.commandId;
  if (header && bodyValue && String(header) !== String(bodyValue)) {
    throw new AppError('INVALID_ACTION', {
      details: [{ path: 'commandId', message: 'does not match Idempotency-Key' }]
    });
  }
  return text(header || bodyValue || requestIdValue, 'commandId', { max: 256 });
}

function etag(snapshot) {
  if (!snapshot?.snapshotHash) return null;
  return `"${snapshot.snapshotHash}"`;
}

function parseIfMatch(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function sendJson(response, statusCode, body, headers = {}) {
  const content = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(content),
    ...headers
  });
  response.end(content);
}

function sendNoContent(response, headers = {}) {
  response.writeHead(204, {
    'cache-control': 'no-store',
    ...headers
  });
  response.end();
}

function sendSuccess(response, statusCode, requestIdValue, data, {
  snapshot,
  meta = {}
} = {}) {
  const headers = { 'x-request-id': requestIdValue };
  const roomEtag = etag(snapshot);
  if (roomEtag) headers.etag = roomEtag;
  if (snapshot?.roomVersion !== undefined) headers['x-room-version'] = String(snapshot.roomVersion);
  sendJson(response, statusCode, {
    requestId: requestIdValue,
    data,
    ...(Object.keys(meta).length > 0 ? { meta } : {})
  }, headers);
}

function sendError(response, error, requestIdValue) {
  const normalized = asAppError(error);
  const payload = toErrorPayload(normalized, requestIdValue || randomUUID());
  const headers = { 'x-request-id': payload.requestId };
  if (normalized.code === 'VERSION_CONFLICT') headers['cache-control'] = 'no-store';
  sendJson(response, normalized.httpStatus, payload, headers);
}

async function readBody(request, maxBytes) {
  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AppError('PAYLOAD_TOO_LARGE');
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw new AppError('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  if (total === 0) return {};
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (cause) {
    throw new AppError('INVALID_MESSAGE', { cause });
  }
  if (!isRecord(value)) throw new AppError('INVALID_MESSAGE');
  return value;
}

function routePath(pathname) {
  const match = /^\/(?:api\/)?v1(\/.*)?$/.exec(pathname);
  if (!match) return null;
  return match[1] || '/';
}

function pathSegments(pathname) {
  return pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
}

function roomPayload(body) {
  const payload = isRecord(body?.payload) ? body.payload : body;
  const value = clone(payload || {});
  for (const field of [
    'requestId',
    'commandId',
    'protocolVersion',
    'type',
    'roomId',
    'roomVersion',
    'expectedRoomVersion'
  ]) delete value[field];
  return value;
}

function commandVersion(body) {
  const value = body?.roomVersion ?? body?.expectedRoomVersion;
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 0) throw new AppError('VERSION_CONFLICT');
  return value;
}

function validateRoomPayload(type, payload) {
  const schemaFile = ROOM_PAYLOAD_SCHEMAS[type];
  if (!schemaFile) return;
  const issues = validateSchema(payload, loadSchema(schemaFile));
  if (issues.length > 0) throw new AppError('VALIDATION_FAILED', { details: issues });
}

function supportPayload(body) {
  const payload = isRecord(body?.payload) ? body.payload : body;
  const value = clone(payload || {});
  // The support MVP is deliberately plain text only.  Reject fields which
  // would silently imply an attachment or an external support channel rather
  // than accepting and dropping them.
  const forbidden = [
    'attachment',
    'attachments',
    'file',
    'files',
    'channel',
    'externalChannel',
    'externalUrl',
    'payment',
    'recharge',
    'withdraw',
    'cashout'
  ];
  for (const field of forbidden) {
    if (Object.hasOwn(value, field)) {
      throw new AppError('SUPPORT_TEXT_INVALID', {
        details: [{ path: field, message: 'attachments and external channels are disabled in the MVP' }]
      });
    }
  }
  for (const field of ['requestId', 'commandId', 'idempotencyKey', 'protocolVersion', 'type']) delete value[field];
  return value;
}

function supportIdempotencyKey(request, body) {
  const header = request.headers['idempotency-key'];
  const bodyValue = body?.idempotencyKey || body?.commandId;
  if (header && bodyValue && String(header) !== String(bodyValue)) {
    throw new AppError('SUPPORT_TEXT_INVALID', {
      details: [{ path: 'idempotencyKey', message: 'does not match Idempotency-Key' }]
    });
  }
  return header || bodyValue || null;
}

async function handleSupportRoute({
  request,
  response,
  segments,
  parsed,
  requestBody,
  requestIdValue,
  principal,
  supportService
}) {
  if (segments[0] !== 'support') return false;
  if (!supportService) throw new AppError('MODULE_UNAVAILABLE');
  if (segments[1] !== 'tickets') throw new AppError('NOT_FOUND');

  if (segments.length === 2) {
    if (request.method === 'POST') {
      const body = supportPayload(requestBody);
      const result = await supportService.createTicket({
        principal,
        subject: body.subject ?? body.title,
        category: body.category,
        message: body.message ?? body.description,
        roomId: body.roomId,
        clientVersion: body.clientVersion,
        idempotencyKey: supportIdempotencyKey(request, requestBody),
        requestId: requestIdValue
      });
      const ticket = result.ticket;
      return sendSuccess(response, result.statusCode || (result.replay ? 200 : 201), requestIdValue, ticket, {
        meta: { ticketId: ticket.id, replay: result.replay === true }
      });
    }
    if (request.method === 'GET') {
      const result = await supportService.listTickets({
        principal,
        status: parsed.searchParams.get('status') || undefined,
        limit: parsed.searchParams.get('limit') || undefined,
        offset: parsed.searchParams.get('offset') || undefined
      });
      return sendSuccess(response, 200, requestIdValue, result);
    }
    throw new AppError('INVALID_MESSAGE');
  }

  const ticketId = text(segments[2], 'ticketId', { max: 128 });
  if (segments.length === 3 && request.method === 'GET') {
    const ticket = await supportService.getTicket({ principal, ticketId });
    return sendSuccess(response, 200, requestIdValue, ticket);
  }

  if (segments.length === 4 && segments[3] === 'messages') {
    if (request.method === 'GET') {
      const result = await supportService.listMessages({ principal, ticketId });
      return sendSuccess(response, 200, requestIdValue, result);
    }
    if (request.method === 'POST') {
      const body = supportPayload(requestBody);
      const result = await supportService.replyTicket({
        principal,
        ticketId,
        message: body.message ?? body.body,
        idempotencyKey: supportIdempotencyKey(request, requestBody),
        requestId: requestIdValue
      });
      return sendSuccess(response, result.statusCode || (result.replay ? 200 : 201), requestIdValue, {
        ticket: result.ticket,
        message: result.message,
        replay: result.replay === true
      }, { meta: { ticketId, replay: result.replay === true } });
    }
    throw new AppError('INVALID_MESSAGE');
  }

  if (segments.length === 4 && (segments[3] === 'close' || segments[3] === 'resolve')
    && request.method === 'POST') {
    const body = supportPayload(requestBody);
    const result = await supportService.closeTicket({
      principal,
      ticketId,
      reason: body.reason,
      idempotencyKey: supportIdempotencyKey(request, requestBody),
      requestId: requestIdValue
    });
    return sendSuccess(response, result.statusCode || 200, requestIdValue, result.ticket, {
      meta: { ticketId, replay: result.replay === true, alreadyClosed: result.alreadyClosed === true }
    });
  }

  // A concise alias is useful for mobile clients and remains the same command
  // as POST /messages; both paths share the exact idempotency scope.
  if (segments.length === 4 && segments[3] === 'reply' && request.method === 'POST') {
    const body = supportPayload(requestBody);
    const result = await supportService.replyTicket({
      principal,
      ticketId,
      message: body.message ?? body.body,
      idempotencyKey: supportIdempotencyKey(request, requestBody),
      requestId: requestIdValue
    });
    return sendSuccess(response, result.statusCode || (result.replay ? 200 : 201), requestIdValue, {
      ticket: result.ticket,
      message: result.message,
      replay: result.replay === true
    }, { meta: { ticketId, replay: result.replay === true } });
  }

  throw new AppError('NOT_FOUND');
}

/**
 * HTTP/BFF adapter for the room service. It deliberately contains no room
 * mutation logic of its own; all writes delegate to RoomService and therefore
 * share RoomActor ordering, command idempotency and optimistic versions with
 * WebSocket clients.
 */
export function createRoomApiServer({
  roomService,
  authService,
  supportService,
  health,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  host = '127.0.0.1',
  port = 0,
  logger
} = {}) {
  if (!roomService || typeof roomService.createRoom !== 'function'
    || typeof roomService.getRoom !== 'function' || typeof roomService.dispatch !== 'function') {
    throw new TypeError('roomService is required');
  }
  if (!authService || typeof authService.requireAuth !== 'function') {
    throw new TypeError('authService is required');
  }
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024) {
    throw new TypeError('maxBodyBytes must be at least 1024');
  }

  const server = createServer(async (request, response) => {
    let requestBody = {};
    let requestIdValue = request.headers['x-request-id'] || randomUUID();
    try {
      requestBody = request.method === 'GET' || request.method === 'HEAD'
        ? {}
        : await readBody(request, maxBodyBytes);
      requestIdValue = requestId(request, requestBody);
      const parsed = new URL(request.url || '/', 'http://localhost');
      const path = routePath(parsed.pathname);
      if (!path) return sendJson(response, 404, { requestId: requestIdValue, error: {
        code: 'NOT_FOUND', message: 'Resource was not found', retryable: false
      } }, { 'x-request-id': requestIdValue });

      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-headers': 'authorization, content-type, idempotency-key, if-match, x-request-id',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-max-age': '600'
        });
        return response.end();
      }

      if (path === '/health' && request.method === 'GET') {
        const data = typeof health?.liveness === 'function'
          ? health.liveness()
          : { status: 'ok' };
        return sendSuccess(response, 200, requestIdValue, data);
      }
      if (path === '/ready' && request.method === 'GET') {
        const data = typeof health?.readiness === 'function'
          ? await health.readiness()
          : { status: 'ready' };
        return sendSuccess(response, data.status === 'ready' ? 200 : 503, requestIdValue, data);
      }

      if (path === '/auth/login' && request.method === 'POST') {
        const session = authService.login(requestBody);
        return sendSuccess(response, 200, requestIdValue, session);
      }
      if (path === '/auth/refresh' && request.method === 'POST') {
        const session = authService.refresh(requestBody.refreshToken);
        return sendSuccess(response, 200, requestIdValue, session);
      }

      const token = parseBearerToken(request.headers.authorization);
      const principal = authService.requireAuth(token);
      if (path === '/auth/logout' && request.method === 'POST') {
        authService.logout(token);
        return sendNoContent(response, { 'x-request-id': requestIdValue });
      }
      if (path === '/me' && request.method === 'GET') {
        return sendSuccess(response, 200, requestIdValue, {
          id: principal.userId,
          displayName: principal.displayName,
          sessionId: principal.sessionId,
          deviceId: principal.deviceId,
          platform: principal.platform
        });
      }

      const segments = pathSegments(path);
      if (segments[0] === 'support') {
        return await handleSupportRoute({
          request,
          response,
          segments,
          parsed,
          requestBody,
          requestIdValue,
          principal,
          supportService
        });
      }
      if (segments[0] !== 'rooms') throw new AppError('NOT_FOUND');
      if (segments.length === 1 && request.method === 'POST') {
        const createResult = await roomService.createRoom({
          principal,
          payload: roomPayload(requestBody),
          commandId: commandId(request, requestBody, requestIdValue),
          requestId: requestIdValue
        });
        return sendSuccess(response, createResult.replay ? 200 : 201, requestIdValue, createResult.room, {
          snapshot: createResult.room,
          meta: {
            roomId: createResult.roomId,
            roomVersion: createResult.roomVersion,
            replay: createResult.replay
          }
        });
      }
      if (segments.length < 2) throw new AppError('NOT_FOUND');
      const roomId = text(segments[1], 'roomId', { max: 128 });
      if (segments.length === 2 && request.method === 'GET') {
        const result = await roomService.getRoom({ roomId, principal });
        const currentEtag = etag(result.room);
        const matches = parseIfMatch(request.headers['if-none-match']);
        if (matches?.includes('*') || (currentEtag && matches?.includes(currentEtag))) {
          response.writeHead(304, {
            etag: currentEtag,
            'x-request-id': requestIdValue,
            'x-room-version': String(result.roomVersion),
            'cache-control': 'no-store'
          });
          return response.end();
        }
        return sendSuccess(response, 200, requestIdValue, result.room, {
          snapshot: result.room,
          meta: { roomVersion: result.roomVersion }
        });
      }

      if (request.method !== 'POST') throw new AppError('INVALID_MESSAGE');
      let type;
      let payload;
      let expectedVersion = commandVersion(requestBody);
      if (segments.length === 3 && ROOM_PATH_COMMANDS[segments[2]]) {
        type = ROOM_PATH_COMMANDS[segments[2]];
        payload = roomPayload(requestBody);
      } else if (segments.length === 3 && segments[2] === 'commands') {
        type = text(requestBody.type, 'type', { max: 64 });
        payload = isRecord(requestBody.payload) ? clone(requestBody.payload) : {};
        expectedVersion = requestBody.roomVersion ?? expectedVersion;
        validateCommand({
          protocolVersion: requestBody.protocolVersion,
          type,
          requestId: requestIdValue,
          commandId: commandId(request, requestBody, requestIdValue),
          roomId,
          ...(expectedVersion === undefined ? {} : { roomVersion: expectedVersion }),
          payload
        }, { maxBytes: maxBodyBytes });
      } else {
        throw new AppError('NOT_FOUND');
      }

      validateRoomPayload(type, payload);

      const current = await roomService.currentRoom({ roomId });
      const currentEtag = etag(current.room);
      const ifMatch = parseIfMatch(request.headers['if-match']);
      if (ifMatch && !ifMatch.includes('*') && (!currentEtag || !ifMatch.includes(currentEtag))) {
        throw new AppError('VERSION_CONFLICT');
      }
      // An ETag precondition is also an optimistic command precondition. If a
      // caller did not repeat the numeric version in JSON, bind the command to
      // the version represented by the matched ETag before dispatching.
      if (ifMatch && expectedVersion === undefined) expectedVersion = current.roomVersion;
      const result = await roomService.dispatch({
        roomId,
        principal,
        type,
        payload,
        commandId: commandId(request, requestBody, requestIdValue),
        requestId: requestIdValue,
        roomVersion: expectedVersion
      });
      return sendSuccess(response, 200, requestIdValue, {
        accepted: result.accepted !== false,
        room: result.room,
        roomVersion: result.roomVersion,
        replay: result.replay,
        ...(result.event ? { event: result.event } : {})
      }, {
        snapshot: result.room,
        meta: { roomId, roomVersion: result.roomVersion, replay: result.replay }
      });
    } catch (error) {
      logger?.warn?.('room_api.request_failed', {
        method: request.method,
        url: request.url,
        requestId: requestIdValue,
        code: error?.code || 'INTERNAL_ERROR',
        message: error?.message
      });
      return sendError(response, error, requestIdValue);
    }
  });

  server.listen(port, host);
  return {
    server,
    roomService,
    supportService,
    close: () => new Promise(resolve => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    })
  };
}

export { ROOM_PATH_COMMANDS, etag };
