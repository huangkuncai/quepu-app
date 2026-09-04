import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  adaptLegacyCommand,
  createCommand,
  createEvent,
  validateCommand,
  validateError
} from '../src/protocol/index.js';
import { AppError } from '../src/shared/errors.js';

test('createCommand creates a versioned room command envelope', () => {
  const command = createCommand('action', { action: 'pass' }, { roomId: 'room_1', roomVersion: 4 });
  assert.equal(command.protocolVersion, PROTOCOL_VERSION);
  assert.equal(command.type, 'action');
  assert.match(command.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(command.roomVersion, 4);
});

test('command validation rejects unknown top-level fields and unsupported versions', () => {
  const base = {
    protocolVersion: PROTOCOL_VERSION,
    type: 'hello',
    requestId: randomUUID(),
    commandId: randomUUID(),
    payload: { deviceId: 'device-1', platform: 'android', clientVersion: '0.1.0' }
  };
  assert.throws(() => validateCommand({ ...base, unexpected: true }), error => error.code === 'VALIDATION_FAILED');
  assert.throws(() => validateCommand({ ...base, protocolVersion: '2.0' }), error => error.code === 'UNSUPPORTED_VERSION');
});

test('command validation rejects oversized payloads with a stable code', () => {
  const command = createCommand('action', { action: 'discard', args: { note: 'x'.repeat(100) } });
  assert.throws(() => validateCommand(command, { maxBytes: 64 }), error => error.code === 'PAYLOAD_TOO_LARGE');
});

test('legacy development messages are adapted without silently accepting them as production envelopes', () => {
  const adapted = adaptLegacyCommand({ type: 'join_room', payload: { name: '甲' }, roomId: 'r1' });
  assert.equal(adapted.protocolVersion, PROTOCOL_VERSION);
  assert.equal(adapted.type, 'join_room');
  assert.equal(adapted.payload.name, '甲');
  assert.doesNotThrow(() => validateCommand(adapted));
});

test('event and error envelopes retain request correlation and room version', () => {
  const requestId = randomUUID();
  const event = createEvent('room_event', { kind: 'PLAYER_JOINED' }, { requestId, roomId: 'r1', roomVersion: 2 });
  assert.equal(event.requestId, requestId);
  assert.equal(event.roomVersion, 2);

  const error = {
    protocolVersion: PROTOCOL_VERSION,
    type: 'error',
    requestId,
    error: { code: 'AUTH_REQUIRED', message: 'Authentication is required', retryable: false }
  };
  assert.doesNotThrow(() => validateError(error));
});

test('invalid payloads expose AppError details for contract tests', () => {
  assert.throws(
    () => createCommand('hello', { deviceId: '', platform: 'android', clientVersion: '0.1.0' }),
    error => error instanceof AppError && error.code === 'VALIDATION_FAILED' && Array.isArray(error.details)
  );
});
