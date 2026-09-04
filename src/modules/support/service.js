import { createHash } from 'node:crypto';

import { AppError } from '../../shared/errors.js';
import {
  MemorySupportTicketRepository,
  SUPPORT_CATEGORIES,
  SUPPORT_LIMITS,
  SUPPORT_TICKET_STATUS,
  normalizeSupportText,
  supportRequestHash
} from './repository.js';

function clone(value) {
  if (value === undefined || value === null) return value;
  return structuredClone(value);
}

function principalId(principal) {
  const value = typeof principal === 'string' ? principal : principal?.userId;
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new AppError('AUTH_REQUIRED');
  }
  const normalized = String(value).trim();
  if (normalized.length > 128) throw new AppError('AUTH_INVALID');
  return normalized;
}

function normalizeIdempotencyKey(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const normalized = String(value).trim();
  if (normalized.length > SUPPORT_LIMITS.idempotencyKey) {
    throw new AppError('SUPPORT_TEXT_INVALID', {
      details: [{ path: 'idempotencyKey', message: `must be <= ${SUPPORT_LIMITS.idempotencyKey} characters` }]
    });
  }
  return normalized;
}

function normalizeTicketId(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new AppError('SUPPORT_TICKET_NOT_FOUND');
  }
  const normalized = String(value).trim();
  if (normalized.length > 128) throw new AppError('SUPPORT_TICKET_NOT_FOUND');
  return normalized;
}

function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') return 50;
  const candidate = Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > 100) {
    throw new AppError('SUPPORT_QUERY_INVALID', {
      details: [{ path: 'limit', message: 'must be an integer between 1 and 100' }]
    });
  }
  return candidate;
}

function normalizeOffset(value) {
  if (value === undefined || value === null || value === '') return 0;
  const candidate = Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > 1_000_000) {
    throw new AppError('SUPPORT_QUERY_INVALID', {
      details: [{ path: 'offset', message: 'must be a non-negative integer' }]
    });
  }
  return candidate;
}

function mapRepositoryError(error, fallback = 'SUPPORT_TEXT_INVALID') {
  if (error instanceof AppError) return error;
  const message = String(error?.message || '');
  if (/ticket was not found|ticket.*not found/i.test(message)) return new AppError('SUPPORT_TICKET_NOT_FOUND', { cause: error });
  if (/closed/i.test(message)) return new AppError('SUPPORT_TICKET_CLOSED', { cause: error });
  return new AppError(fallback, { cause: error });
}

function safeTicketState(ticket) {
  if (!ticket) return null;
  return {
    id: ticket.id,
    ownerUserId: ticket.ownerUserId,
    status: ticket.status,
    roomId: ticket.roomId || null,
    messageCount: ticket.messageCount,
    updatedAt: ticket.updatedAt,
    closedAt: ticket.closedAt || null
  };
}

/**
 * In-process support application service for development/fake-staging.
 *
 * The service deliberately has no staff/external-channel/attachment/payment
 * path.  A future persistent implementation can preserve this method
 * contract while replacing the repository.
 */
export class SupportTicketService {
  constructor({
    repository = new MemorySupportTicketRepository(),
    enabled = true,
    idFactory,
    logger
  } = {}) {
    if (!repository || typeof repository.createTicket !== 'function'
      || typeof repository.findTicketByOwner !== 'function'
      || typeof repository.listTicketsByOwner !== 'function'
      || typeof repository.appendMessage !== 'function'
      || typeof repository.closeTicket !== 'function') {
      throw new TypeError('SupportTicketService requires a ticket repository');
    }
    this.repository = repository;
    this.enabled = enabled !== false;
    this.idFactory = idFactory;
    this.logger = logger;
  }

  _assertEnabled() {
    if (!this.enabled) throw new AppError('MODULE_UNAVAILABLE');
  }

  _normalizeText(value, field, max, { required = true } = {}) {
    try {
      return normalizeSupportText(value, field, max, { required });
    } catch (error) {
      throw new AppError('SUPPORT_TEXT_INVALID', {
        details: [{ path: field, message: error.message }],
        cause: error
      });
    }
  }

  _ticket(ticketId, userId) {
    const ticket = this.repository.findTicketByOwner(ticketId, userId);
    // Do not reveal whether another user's ticket exists.
    if (!ticket) throw new AppError('SUPPORT_TICKET_NOT_FOUND');
    return ticket;
  }

  _aggregate(ticket) {
    const messages = this.repository.listMessages(ticket.id) || [];
    return {
      ...clone(ticket),
      messages: clone(messages)
    };
  }

  _audit({ actorUserId, action, ticketId, requestId, before, after, metadata = {}, reason = null }) {
    if (typeof this.repository.appendAuditLog !== 'function') return;
    try {
      this.repository.appendAuditLog({
        actorUserId,
        actorType: 'USER',
        action,
        resourceType: 'support_ticket',
        resourceId: ticketId,
        requestId: requestId || null,
        reason,
        // Bodies are intentionally excluded from audit records.  Metadata is
        // limited to IDs/statuses so logs do not become a second message store.
        before: safeTicketState(before),
        after: safeTicketState(after),
        metadata
      });
    } catch (error) {
      // Audit must not make a successfully committed support mutation appear
      // to fail in this fake adapter; surface the issue to local logs.
      this.logger?.warn?.('support.audit_failed', { message: error.message, ticketId, action });
    }
  }

  async _idempotent({ operation, userId, key, requestId, input, run }) {
    const normalizedKey = normalizeIdempotencyKey(key || requestId);
    if (!normalizedKey || typeof this.repository.getIdempotency !== 'function'
      || typeof this.repository.saveIdempotency !== 'function') {
      return { ...(await run()), replay: false };
    }
    const scope = `support:${operation}:${userId}`;
    const requestHash = supportRequestHash(input);
    const prior = this.repository.getIdempotency({ scope, key: normalizedKey });
    if (prior) {
      if (prior.requestHash !== requestHash) throw new AppError('IDEMPOTENCY_CONFLICT');
      return { ...clone(prior.result), replay: true, statusCode: 200 };
    }
    const result = await run();
    const statusCode = result.statusCode || 200;
    this.repository.saveIdempotency({
      scope,
      key: normalizedKey,
      requestHash,
      result: { ...clone(result), replay: false },
      statusCode
    });
    return { ...result, replay: false, statusCode };
  }

  async createTicket({
    principal,
    subject,
    category = 'OTHER',
    message,
    description,
    roomId,
    clientVersion,
    idempotencyKey,
    requestId
  } = {}) {
    this._assertEnabled();
    const userId = principalId(principal);
    const normalizedSubject = this._normalizeText(subject ?? '联系客服', 'subject', SUPPORT_LIMITS.subject);
    const normalizedMessage = this._normalizeText(message ?? description, 'message', SUPPORT_LIMITS.message);
    const normalizedCategory = String(category || 'OTHER').trim().toUpperCase();
    if (!SUPPORT_CATEGORIES.includes(normalizedCategory)) {
      throw new AppError('SUPPORT_TEXT_INVALID', {
        details: [{ path: 'category', message: 'unsupported category' }]
      });
    }
    const normalizedRoomId = this._normalizeText(roomId, 'roomId', SUPPORT_LIMITS.roomId, { required: false });
    const normalizedClientVersion = this._normalizeText(
      clientVersion,
      'clientVersion',
      SUPPORT_LIMITS.clientVersion,
      { required: false }
    );
    const input = {
      subject: normalizedSubject,
      category: normalizedCategory,
      message: normalizedMessage,
      roomId: normalizedRoomId,
      clientVersion: normalizedClientVersion
    };
    return this._idempotent({
      operation: 'create',
      userId,
      key: idempotencyKey,
      requestId,
      input,
      run: async () => {
        let ticket;
        try {
          ticket = this.repository.createTicket({
            ownerUserId: userId,
            subject: normalizedSubject,
            category: normalizedCategory,
            roomId: normalizedRoomId,
            clientVersion: normalizedClientVersion,
            message: normalizedMessage
          });
        } catch (error) {
          throw mapRepositoryError(error);
        }
        const aggregate = this._aggregate(ticket);
        this._audit({
          actorUserId: userId,
          action: 'SUPPORT_TICKET_CREATED',
          ticketId: ticket.id,
          requestId,
          after: ticket,
          metadata: { category: ticket.category, roomId: ticket.roomId || null }
        });
        return { ticket: aggregate, statusCode: 201 };
      }
    });
  }

  async listTickets({ principal, status, limit, offset = 0 } = {}) {
    this._assertEnabled();
    const userId = principalId(principal);
    const normalizedLimit = normalizeLimit(limit);
    const normalizedOffset = normalizeOffset(offset);
    let normalizedStatus;
    if (status !== undefined && status !== null && String(status).trim() !== '') {
      normalizedStatus = String(status).trim().toUpperCase();
      if (!Object.values(SUPPORT_TICKET_STATUS).includes(normalizedStatus)) {
        throw new AppError('SUPPORT_QUERY_INVALID', {
          details: [{ path: 'status', message: 'unsupported status' }]
        });
      }
    }
    try {
      const tickets = this.repository.listTicketsByOwner(userId, {
        status: normalizedStatus,
        limit: normalizedLimit,
        offset: normalizedOffset
      });
      const nextOffset = tickets.length === normalizedLimit ? normalizedOffset + tickets.length : null;
      return {
        tickets: clone(tickets),
        // `items` keeps the response convenient for generic list components.
        items: clone(tickets),
        nextOffset,
        totalReturned: tickets.length
      };
    } catch (error) {
      throw mapRepositoryError(error, 'SUPPORT_QUERY_INVALID');
    }
  }

  async getTicket({ principal, ticketId } = {}) {
    this._assertEnabled();
    const userId = principalId(principal);
    const ticket = this._ticket(normalizeTicketId(ticketId), userId);
    return this._aggregate(ticket);
  }

  async listMessages({ principal, ticketId } = {}) {
    const ticket = await this.getTicket({ principal, ticketId });
    return { ticketId: ticket.id, messages: ticket.messages };
  }

  async replyTicket({ principal, ticketId, message, body, idempotencyKey, requestId } = {}) {
    this._assertEnabled();
    const userId = principalId(principal);
    const normalizedTicketId = normalizeTicketId(ticketId);
    const normalizedMessage = this._normalizeText(message ?? body, 'message', SUPPORT_LIMITS.message);
    const input = { ticketId: normalizedTicketId, message: normalizedMessage };
    return this._idempotent({
      operation: 'reply',
      userId,
      key: idempotencyKey,
      requestId,
      input,
      run: async () => {
        const before = this._ticket(normalizedTicketId, userId);
        if (before.status === SUPPORT_TICKET_STATUS.CLOSED) {
          throw new AppError('SUPPORT_TICKET_CLOSED');
        }
        let added;
        try {
          added = this.repository.appendMessage({
            ticketId: normalizedTicketId,
            authorUserId: userId,
            authorType: 'USER',
            body: normalizedMessage
          });
        } catch (error) {
          throw mapRepositoryError(error, 'SUPPORT_TICKET_CLOSED');
        }
        const after = this._ticket(normalizedTicketId, userId);
        this._audit({
          actorUserId: userId,
          action: 'SUPPORT_MESSAGE_ADDED',
          ticketId: normalizedTicketId,
          requestId,
          before,
          after,
          metadata: { messageId: added.id }
        });
        return {
          ticket: this._aggregate(after),
          message: clone(added),
          statusCode: 201
        };
      }
    });
  }

  async closeTicket({ principal, ticketId, reason, idempotencyKey, requestId } = {}) {
    this._assertEnabled();
    const userId = principalId(principal);
    const normalizedTicketId = normalizeTicketId(ticketId);
    const normalizedReason = this._normalizeText(reason, 'reason', SUPPORT_LIMITS.closeReason, { required: false });
    const input = { ticketId: normalizedTicketId, reason: normalizedReason };
    return this._idempotent({
      operation: 'close',
      userId,
      key: idempotencyKey,
      requestId,
      input,
      run: async () => {
        const before = this._ticket(normalizedTicketId, userId);
        if (before.status === SUPPORT_TICKET_STATUS.CLOSED) {
          return { ticket: this._aggregate(before), statusCode: 200, alreadyClosed: true };
        }
        let after;
        try {
          after = this.repository.closeTicket(normalizedTicketId);
        } catch (error) {
          throw mapRepositoryError(error);
        }
        if (!after) throw new AppError('SUPPORT_TICKET_NOT_FOUND');
        this._audit({
          actorUserId: userId,
          action: 'SUPPORT_TICKET_CLOSED',
          ticketId: normalizedTicketId,
          requestId,
          before,
          after,
          reason: normalizedReason,
          metadata: { reasonProvided: Boolean(normalizedReason) }
        });
        return { ticket: this._aggregate(after), statusCode: 200 };
      }
    });
  }

  listAuditLogs(options = {}) {
    return typeof this.repository.listAuditLogs === 'function'
      ? this.repository.listAuditLogs(options)
      : [];
  }

  health() {
    return typeof this.repository.health === 'function'
      ? this.repository.health()
      : { status: 'ok', backend: 'memory' };
  }
}

export function createSupportTicketService(options = {}) {
  return new SupportTicketService(options);
}

// Short aliases make the port discoverable for callers that call it simply
// `SupportService` while preserving the explicit ticket name in docs.
export const SupportService = SupportTicketService;
export const createSupportService = createSupportTicketService;

