const definitions = {
  AUTH_REQUIRED: { httpStatus: 401, message: 'Authentication is required', retryable: false },
  AUTH_INVALID: { httpStatus: 401, message: 'Authentication is invalid', retryable: false },
  AUTH_EXPIRED: { httpStatus: 401, message: 'Authentication has expired', retryable: true },
  OTP_INVALID: { httpStatus: 401, message: 'Verification code is invalid', retryable: false },
  FORBIDDEN: { httpStatus: 403, message: 'Operation is not permitted', retryable: false },
  CLUB_MEMBERSHIP_REQUIRED: { httpStatus: 403, message: 'Approved club membership is required', retryable: false },
  CLUB_APPLICATION_PENDING: { httpStatus: 403, message: 'Club application is pending', retryable: false },
  FLOOR_NOT_FOUND: { httpStatus: 404, message: 'Floor was not found', retryable: false },
  RULE_VERSION_UNSUPPORTED: { httpStatus: 422, message: 'Rule version is unsupported', retryable: false },
  DIAMOND_INSUFFICIENT: { httpStatus: 409, message: 'Insufficient diamonds', retryable: false },
  // Persistence/actor boundary errors are public so clients and gateway
  // adapters can distinguish a retryable lease race from an internal fault.
  UNIQUE_VIOLATION: { httpStatus: 409, message: 'A unique resource already exists', retryable: false },
  IDEMPOTENCY_CONFLICT: { httpStatus: 409, message: 'Idempotency key conflicts with an earlier request', retryable: false },
  LOCK_BUSY: { httpStatus: 409, message: 'Room is currently owned by another actor', retryable: true },
  LOCK_NOT_HELD: { httpStatus: 409, message: 'Room actor lease is not held', retryable: true },
  LOCK_EXPIRED: { httpStatus: 409, message: 'Room actor lease has expired', retryable: true },
  FENCING_TOKEN_REQUIRED: { httpStatus: 409, message: 'A fencing token is required', retryable: true },
  FENCING_TOKEN_STALE: { httpStatus: 409, message: 'Room actor lease is stale', retryable: true },
  NOT_FOUND: { httpStatus: 404, message: 'Resource was not found', retryable: false },
  CONFLICT: { httpStatus: 409, message: 'Resource state conflicts with the request', retryable: true },
  VALIDATION_ERROR: { httpStatus: 422, message: 'Persistence input is invalid', retryable: false },
  ROOM_NOT_FOUND: { httpStatus: 404, message: 'Room was not found', retryable: false },
  ROOM_FULL: { httpStatus: 409, message: 'Room is full', retryable: false },
  ROOM_NOT_JOINABLE: { httpStatus: 409, message: 'Room is not joinable', retryable: false },
  SEAT_OCCUPIED: { httpStatus: 409, message: 'Seat is occupied', retryable: false },
  NOT_ROOM_OWNER: { httpStatus: 403, message: 'Room owner permission is required', retryable: false },
  NOT_YOUR_TURN: { httpStatus: 409, message: 'It is not your turn', retryable: false },
  INVALID_ACTION: { httpStatus: 422, message: 'Action is invalid', retryable: false },
  VERSION_CONFLICT: { httpStatus: 409, message: 'State version is stale', retryable: true },
  DUPLICATE_REQUEST: { httpStatus: 409, message: 'Request was already processed', retryable: false },
  RECONNECT_TOKEN_INVALID: { httpStatus: 401, message: 'Reconnect token is invalid', retryable: false },
  ROUND_FINISHED: { httpStatus: 409, message: 'Round has finished', retryable: false },
  PLAYER_NOT_FOUND: { httpStatus: 404, message: 'Player was not found', retryable: false },
  PLAYERS_NOT_READY: { httpStatus: 409, message: 'Players are not ready', retryable: false },
  ROUND_NOT_PLAYING: { httpStatus: 409, message: 'Round is not playing', retryable: false },
  // Development/fake-staging support MVP errors.  These codes deliberately
  // stay separate from room errors so a client can render a useful support
  // state without coupling itself to the room state machine.
  SUPPORT_TICKET_NOT_FOUND: { httpStatus: 404, message: 'Support ticket was not found', retryable: false },
  SUPPORT_TICKET_CLOSED: { httpStatus: 409, message: 'Support ticket is closed', retryable: false },
  SUPPORT_TEXT_INVALID: { httpStatus: 422, message: 'Support text is invalid', retryable: false },
  SUPPORT_QUERY_INVALID: { httpStatus: 422, message: 'Support query is invalid', retryable: false },
  RATE_LIMITED: { httpStatus: 429, message: 'Too many requests', retryable: true },
  RETRYABLE: { httpStatus: 503, message: 'Temporary service failure', retryable: true },
  INVALID_MESSAGE: { httpStatus: 400, message: 'Message is invalid', retryable: false },
  PAYLOAD_TOO_LARGE: { httpStatus: 413, message: 'Message payload is too large', retryable: false },
  VALIDATION_FAILED: { httpStatus: 422, message: 'Request validation failed', retryable: false },
  UNSUPPORTED_VERSION: { httpStatus: 426, message: 'Protocol version is unsupported', retryable: false },
  CONFIG_INVALID: { httpStatus: 500, message: 'Server configuration is invalid', retryable: false },
  MODULE_UNAVAILABLE: { httpStatus: 503, message: 'Module is not available yet', retryable: true },
  NOT_IMPLEMENTED: { httpStatus: 501, message: 'Operation is not implemented yet', retryable: false },
  INTERNAL_ERROR: { httpStatus: 500, message: 'Internal server error', retryable: false }
};

export const ERROR_CODES = Object.freeze(
  Object.fromEntries(Object.keys(definitions).map(code => [code, code]))
);

export const ERROR_REGISTRY = Object.freeze(
  Object.fromEntries(
    Object.entries(definitions).map(([code, definition]) => [code, Object.freeze({ code, ...definition })])
  )
);

export function getErrorDefinition(code) {
  return ERROR_REGISTRY[code] || ERROR_REGISTRY.INTERNAL_ERROR;
}

export class AppError extends Error {
  constructor(code, { cause, details, message } = {}) {
    const definition = getErrorDefinition(code);
    super(message || definition.message, cause ? { cause } : undefined);
    this.name = 'AppError';
    this.code = ERROR_REGISTRY[code] ? code : 'INTERNAL_ERROR';
    this.httpStatus = definition.httpStatus;
    this.retryable = definition.retryable;
    if (details !== undefined) this.details = details;
  }
}

export function asAppError(error, fallbackCode = 'INTERNAL_ERROR') {
  if (error instanceof AppError) return error;
  return new AppError(fallbackCode, { cause: error });
}

/** Convert an internal error to the stable transport shape. */
export function toErrorPayload(error, requestId) {
  const normalized = asAppError(error);
  const payload = {
    requestId,
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable
    }
  };
  if (normalized.code === 'CONFIG_INVALID' && normalized.details) {
    payload.error.details = normalized.details;
  }
  return payload;
}
