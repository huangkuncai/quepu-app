import { createHash, randomUUID } from 'node:crypto';

/**
 * Development/fake-staging support storage.
 *
 * This repository is intentionally process-local.  It is a small, explicit
 * port that can be replaced by a reviewed persistent adapter later without
 * changing the HTTP/service contract.  It does not store attachments or
 * forward content to an external channel.
 */

export const SUPPORT_TICKET_STATUS = Object.freeze({
  OPEN: 'OPEN',
  WAITING_USER: 'WAITING_USER',
  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED'
});

export const SUPPORT_TICKET_STATUSES = Object.freeze(
  Object.values(SUPPORT_TICKET_STATUS)
);

export const SUPPORT_CATEGORIES = Object.freeze([
  'ACCOUNT',
  'ROOM',
  'CLUB',
  'RULES',
  'OTHER'
]);

export const SUPPORT_LIMITS = Object.freeze({
  subject: 120,
  message: 2000,
  category: 32,
  roomId: 128,
  clientVersion: 64,
  closeReason: 500,
  idempotencyKey: 256
});

const ACTOR_TYPES = new Set(['USER', 'ADMIN', 'SYSTEM', 'SERVICE']);

function clone(value) {
  if (value === undefined || value === null) return value;
  return structuredClone(value);
}

function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function output(value) {
  return freeze(clone(value));
}

function id(value, field = 'id', max = 128) {
  if (value === undefined || value === null) {
    throw new TypeError(`${field} is required`);
  }
  const normalized = String(value).trim();
  if (!normalized || normalized.length > max) {
    throw new TypeError(`${field} is invalid`);
  }
  return normalized;
}

/** Count user-visible Unicode code points, rather than UTF-16 code units. */
export function textLength(value) {
  return Array.from(String(value)).length;
}

export function normalizeSupportText(value, field, max, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (!required) return null;
    throw new TypeError(`${field} is required`);
  }
  const normalized = String(value).trim();
  if (!normalized) {
    if (!required) return null;
    throw new TypeError(`${field} must not be blank`);
  }
  if (normalized.includes('\u0000') || textLength(normalized) > max) {
    throw new TypeError(`${field} exceeds ${max} characters or contains an invalid control character`);
  }
  return normalized;
}

function timestamp(value, field, clock) {
  const date = new Date(value === undefined || value === null ? clock() : value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${field} is invalid`);
  return date.toISOString();
}

function mapKey(scope, key) {
  return `${scope}\u0000${key}`;
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export function supportRequestHash(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function assertStatus(value) {
  if (!SUPPORT_TICKET_STATUSES.includes(value)) {
    throw new TypeError('status is invalid');
  }
  return value;
}

function normalizeTicketInput(input = {}, clock) {
  const ownerUserId = id(input.ownerUserId ?? input.userId, 'ownerUserId');
  const subject = normalizeSupportText(
    input.subject ?? '联系客服',
    'subject',
    SUPPORT_LIMITS.subject
  );
  const category = String(input.category || 'OTHER').trim().toUpperCase();
  if (!SUPPORT_CATEGORIES.includes(category)) throw new TypeError('category is invalid');
  const roomId = normalizeSupportText(input.roomId, 'roomId', SUPPORT_LIMITS.roomId, { required: false });
  const clientVersion = normalizeSupportText(
    input.clientVersion,
    'clientVersion',
    SUPPORT_LIMITS.clientVersion,
    { required: false }
  );
  const now = timestamp(input.createdAt, 'createdAt', clock);
  return {
    id: id(input.id ?? randomUUID(), 'id'),
    ownerUserId,
    // `userId` is retained as a read-only compatibility alias for simple
    // clients; authorization always uses ownerUserId internally.
    userId: ownerUserId,
    subject,
    category,
    roomId,
    clientVersion,
    status: assertStatus(input.status || SUPPORT_TICKET_STATUS.OPEN),
    createdAt: now,
    updatedAt: timestamp(input.updatedAt ?? now, 'updatedAt', clock),
    closedAt: input.closedAt === undefined || input.closedAt === null
      ? null
      : timestamp(input.closedAt, 'closedAt', clock),
    lastMessageAt: input.lastMessageAt === undefined || input.lastMessageAt === null
      ? null
      : timestamp(input.lastMessageAt, 'lastMessageAt', clock),
    messageCount: Number.isInteger(input.messageCount) && input.messageCount >= 0
      ? input.messageCount
      : 0
  };
}

/**
 * In-memory ticket/message repository.  All returned values are cloned and
 * frozen, preventing a transport handler from mutating stored state.
 */
export class MemorySupportTicketRepository {
  constructor({ clock = () => Date.now(), idFactory = randomUUID } = {}) {
    this.clock = clock;
    this.idFactory = idFactory;
    this.tickets = new Map();
    this.messages = new Map();
    this.idempotency = new Map();
    this.auditLogs = [];
    this.nextAuditId = 1;
  }

  createTicket(input = {}) {
    const normalized = normalizeTicketInput({
      ...input,
      id: input.id ?? this.idFactory()
    }, this.clock);
    if (this.tickets.has(normalized.id)) throw new TypeError('ticket id already exists');
    const ticket = { ...normalized };
    this.tickets.set(ticket.id, ticket);
    this.messages.set(ticket.id, []);
    if (input.message !== undefined && input.message !== null) {
      this.appendMessage({
        ticketId: ticket.id,
        authorUserId: ticket.ownerUserId,
        authorType: 'USER',
        body: input.message,
        createdAt: input.createdAt
      });
    }
    // Appending the initial message updates messageCount/lastMessageAt; read
    // the ticket again so the create response is self-consistent.
    return output(this.tickets.get(ticket.id));
  }

  findTicketById(ticketId) {
    const ticket = this.tickets.get(id(ticketId, 'ticketId'));
    return ticket ? output(ticket) : null;
  }

  /** Return a ticket only when it belongs to the supplied owner. */
  findTicketByOwner(ticketId, ownerUserId) {
    const ticket = this.tickets.get(id(ticketId, 'ticketId'));
    const owner = id(ownerUserId, 'ownerUserId');
    if (!ticket || ticket.ownerUserId !== owner) return null;
    return output(ticket);
  }

  listTicketsByOwner(ownerUserId, { status, limit = 50, offset = 0 } = {}) {
    const owner = id(ownerUserId, 'ownerUserId');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('limit is invalid');
    if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) throw new TypeError('offset is invalid');
    if (status !== undefined && status !== null) assertStatus(status);
    const all = [...this.tickets.values()]
      .filter(ticket => ticket.ownerUserId === owner && (status === undefined || ticket.status === status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    return all.slice(offset, offset + limit).map(output);
  }

  listMessages(ticketId) {
    const ticket = this.tickets.get(id(ticketId, 'ticketId'));
    if (!ticket) return null;
    return (this.messages.get(ticket.id) || []).map(output);
  }

  appendMessage({ ticketId, authorUserId, authorType = 'USER', body, createdAt, id: messageId } = {}) {
    const normalizedTicketId = id(ticketId, 'ticketId');
    const ticket = this.tickets.get(normalizedTicketId);
    if (!ticket) throw new TypeError('ticket was not found');
    const author = id(authorUserId, 'authorUserId');
    if (!ACTOR_TYPES.has(authorType)) throw new TypeError('authorType is invalid');
    const text = normalizeSupportText(body, 'body', SUPPORT_LIMITS.message);
    const occurredAt = timestamp(createdAt, 'createdAt', this.clock);
    const message = {
      id: id(messageId ?? this.idFactory(), 'messageId'),
      ticketId: normalizedTicketId,
      authorUserId: author,
      authorType,
      body: text,
      createdAt: occurredAt
    };
    const list = this.messages.get(normalizedTicketId) || [];
    if (list.some(existing => existing.id === message.id)) throw new TypeError('message id already exists');
    list.push(message);
    this.messages.set(normalizedTicketId, list);
    const next = {
      ...ticket,
      updatedAt: occurredAt,
      lastMessageAt: occurredAt,
      messageCount: list.length
    };
    this.tickets.set(normalizedTicketId, next);
    return output(message);
  }

  closeTicket(ticketId, { closedAt } = {}) {
    const normalizedTicketId = id(ticketId, 'ticketId');
    const ticket = this.tickets.get(normalizedTicketId);
    if (!ticket) return null;
    if (ticket.status === SUPPORT_TICKET_STATUS.CLOSED) return output(ticket);
    const at = timestamp(closedAt, 'closedAt', this.clock);
    const next = {
      ...ticket,
      status: SUPPORT_TICKET_STATUS.CLOSED,
      closedAt: at,
      updatedAt: at
    };
    this.tickets.set(normalizedTicketId, next);
    return output(next);
  }

  getIdempotency({ scope, key } = {}) {
    if (scope === undefined || key === undefined) return null;
    const record = this.idempotency.get(mapKey(id(scope, 'scope', 512), id(key, 'key', SUPPORT_LIMITS.idempotencyKey)));
    return record ? output(record) : null;
  }

  saveIdempotency({ scope, key, requestHash, result, statusCode, createdAt } = {}) {
    const normalizedScope = id(scope, 'scope', 512);
    const normalizedKey = id(key, 'key', SUPPORT_LIMITS.idempotencyKey);
    const hash = id(requestHash, 'requestHash', 128);
    const record = {
      scope: normalizedScope,
      key: normalizedKey,
      requestHash: hash,
      result: clone(result),
      statusCode: Number.isInteger(statusCode) ? statusCode : 200,
      createdAt: timestamp(createdAt, 'createdAt', this.clock)
    };
    this.idempotency.set(mapKey(normalizedScope, normalizedKey), record);
    return output(record);
  }

  appendAuditLog({
    actorUserId = null,
    actorType = 'USER',
    action,
    resourceType = 'support_ticket',
    resourceId = null,
    requestId = null,
    reason = null,
    before = null,
    after = null,
    metadata = {},
    createdAt
  } = {}) {
    if (actorUserId !== null && actorUserId !== undefined) id(actorUserId, 'actorUserId');
    if (!ACTOR_TYPES.has(actorType)) throw new TypeError('actorType is invalid');
    const record = {
      id: this.nextAuditId++,
      actorUserId: actorUserId === null || actorUserId === undefined ? null : String(actorUserId),
      actorType,
      action: id(action, 'action', 128),
      resourceType: id(resourceType, 'resourceType', 128),
      resourceId: resourceId === null || resourceId === undefined ? null : id(resourceId, 'resourceId', 256),
      requestId: requestId === null || requestId === undefined ? null : id(requestId, 'requestId', 256),
      reason: reason === null || reason === undefined ? null : normalizeSupportText(reason, 'reason', SUPPORT_LIMITS.closeReason, { required: false }),
      before: clone(before),
      after: clone(after),
      metadata: clone(metadata || {}),
      createdAt: timestamp(createdAt, 'createdAt', this.clock)
    };
    this.auditLogs.push(record);
    return output(record);
  }

  listAuditLogs({ resourceType, resourceId, limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('limit is invalid');
    return this.auditLogs
      .filter(record => (resourceType === undefined || record.resourceType === resourceType)
        && (resourceId === undefined || record.resourceId === resourceId))
      .slice(-limit)
      .reverse()
      .map(output);
  }

  health() {
    return Object.freeze({ status: 'ok', backend: 'memory', tickets: this.tickets.size });
  }

  clear() {
    this.tickets.clear();
    this.messages.clear();
    this.idempotency.clear();
    this.auditLogs.length = 0;
    this.nextAuditId = 1;
  }
}

// Friendly aliases for callers that use the shorter ticket naming.
export const MemoryTicketRepository = MemorySupportTicketRepository;
export function createMemorySupportTicketRepository(options) {
  return new MemorySupportTicketRepository(options);
}
