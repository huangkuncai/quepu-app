import { randomUUID } from 'node:crypto';
import { AppError } from '../shared/errors.js';
import { assertSchema, loadSchema, validateSchema } from './validator.js';

export const PROTOCOL_VERSION = '1.0';
export const SUPPORTED_MAJOR_VERSIONS = Object.freeze([1]);
export const DEFAULT_MAX_PAYLOAD_BYTES = 65536;

export const COMMAND_TYPES = Object.freeze([
  'hello',
  'auth',
  'login',
  'refresh',
  'logout',
  'create_room',
  'join_room',
  'leave_room',
  'ready',
  'start_round',
  'begin_playing',
  'action',
  'settle_round',
  'next_round',
  'disband_room',
  'reconnect',
  'subscribe',
  'unsubscribe',
  'ping'
]);

export const EVENT_TYPES = Object.freeze([
  'hello_ack',
  'auth_ok',
  'login_ok',
  'refresh_ok',
  'logout_ok',
  'command_ack',
  'room_created',
  'room_event',
  'room_sync',
  'pong',
  'error'
]);

const PAYLOAD_SCHEMAS = Object.freeze({
  hello: 'hello-payload.schema.json',
  auth: 'auth-payload.schema.json',
  login: 'login-payload.schema.json',
  refresh: 'refresh-payload.schema.json',
  logout: 'logout-payload.schema.json',
  create_room: 'create-room-payload.schema.json',
  join_room: 'join-room-payload.schema.json',
  leave_room: 'leave-room-payload.schema.json',
  ready: 'ready-room-payload.schema.json',
  begin_playing: 'begin-playing-payload.schema.json',
  action: 'action-payload.schema.json',
  settle_round: 'settle-room-payload.schema.json',
  next_round: 'next-round-payload.schema.json',
  disband_room: 'disband-room-payload.schema.json',
  reconnect: 'reconnect-payload.schema.json',
  subscribe: 'subscribe-payload.schema.json',
  unsubscribe: 'subscribe-payload.schema.json'
});

function parseRawMessage(raw) {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch (cause) {
      throw new AppError('INVALID_MESSAGE', { cause });
    }
  }
  if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
    try {
      return JSON.parse(Buffer.from(raw).toString('utf8'));
    } catch (cause) {
      throw new AppError('INVALID_MESSAGE', { cause });
    }
  }
  return raw;
}

function assertPayloadSize(value, maxBytes) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (cause) {
    throw new AppError('INVALID_MESSAGE', { cause });
  }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    throw new AppError('PAYLOAD_TOO_LARGE');
  }
}

export function assertCompatibleVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+$/.test(version)) {
    throw new AppError('UNSUPPORTED_VERSION');
  }
  const major = Number(version.split('.')[0]);
  if (!SUPPORTED_MAJOR_VERSIONS.includes(major)) throw new AppError('UNSUPPORTED_VERSION');
  return version;
}

export function validateCommand(raw, { maxBytes = DEFAULT_MAX_PAYLOAD_BYTES } = {}) {
  const value = parseRawMessage(raw);
  assertPayloadSize(value, maxBytes);
  assertCompatibleVersion(value?.protocolVersion);
  assertSchema(value, 'command-envelope.schema.json');
  if (PAYLOAD_SCHEMAS[value.type]) assertSchema(value.payload, PAYLOAD_SCHEMAS[value.type]);
  return value;
}

export function validateEvent(value) {
  assertCompatibleVersion(value?.protocolVersion);
  return assertSchema(value, 'event-envelope.schema.json');
}

export function validateError(value) {
  assertCompatibleVersion(value?.protocolVersion);
  return assertSchema(value, 'error-envelope.schema.json');
}

export function createCommand(type, payload = {}, fields = {}) {
  if (!COMMAND_TYPES.includes(type)) throw new AppError('INVALID_MESSAGE');
  const command = {
    protocolVersion: fields.protocolVersion || PROTOCOL_VERSION,
    type,
    requestId: fields.requestId || randomUUID(),
    commandId: fields.commandId || randomUUID(),
    ...(fields.sessionId ? { sessionId: fields.sessionId } : {}),
    ...(fields.roomId ? { roomId: fields.roomId } : {}),
    ...(fields.roomVersion !== undefined ? { roomVersion: fields.roomVersion } : {}),
    ...(fields.clientTime ? { clientTime: fields.clientTime } : {}),
    payload
  };
  return validateCommand(command);
}

export function createEvent(type, payload = {}, fields = {}) {
  if (!EVENT_TYPES.includes(type)) throw new AppError('INVALID_MESSAGE');
  const event = {
    protocolVersion: fields.protocolVersion || PROTOCOL_VERSION,
    type,
    eventId: fields.eventId || randomUUID(),
    ...(fields.requestId ? { requestId: fields.requestId } : {}),
    ...(fields.commandId ? { commandId: fields.commandId } : {}),
    ...(fields.roomId ? { roomId: fields.roomId } : {}),
    roomVersion: fields.roomVersion === undefined ? 0 : fields.roomVersion,
    ...(fields.visibility ? { visibility: fields.visibility } : {}),
    payload,
    occurredAt: fields.occurredAt || new Date().toISOString()
  };
  return validateEvent(event);
}

/**
 * The first server skeleton used messages without protocol IDs. This adapter
 * keeps those development clients usable while making every new command
 * conform to the versioned envelope before it reaches a handler.
 */
export function adaptLegacyCommand(message, fields = {}) {
  const value = parseRawMessage(message);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('INVALID_MESSAGE');
  return {
    protocolVersion: value.protocolVersion || PROTOCOL_VERSION,
    type: value.type,
    requestId: value.requestId || fields.requestId || randomUUID(),
    commandId: value.commandId || fields.commandId || randomUUID(),
    ...(value.sessionId || fields.sessionId ? { sessionId: value.sessionId || fields.sessionId } : {}),
    ...(value.roomId || fields.roomId ? { roomId: value.roomId || fields.roomId } : {}),
    ...(value.roomVersion !== undefined || fields.roomVersion !== undefined
      ? { roomVersion: value.roomVersion ?? fields.roomVersion }
      : {}),
    ...(value.clientTime ? { clientTime: value.clientTime } : {}),
    payload: value.payload || {}
  };
}

export { loadSchema, validateSchema };
