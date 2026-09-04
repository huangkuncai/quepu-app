/**
 * Runtime contract for the persistence boundary.
 *
 * The project is JavaScript-only during I1, so this module provides the
 * language-neutral method list that a PostgreSQL adapter must implement. A
 * provider can be swapped without allowing modules to reach into its tables.
 */
export const REPOSITORY_METHODS = Object.freeze([
  'createUser',
  'findUserById',
  'findUserByPhone',
  'updateUser',
  'upsertDevice',
  'findDeviceById',
  'listDevicesByUser',
  'revokeDevice',
  'createSession',
  'findSessionById',
  'findSessionByAccessTokenHash',
  'findSessionByRefreshTokenHash',
  'touchSession',
  'revokeSession',
  'claimIdempotencyKey',
  'getIdempotencyKey',
  'completeIdempotencyKey',
  'purgeExpiredIdempotencyKeys',
  'appendAuditLog',
  'listAuditLogs',
  'health'
]);

export const REPOSITORY_CONTRACT_VERSION = '1.0';

export class RepositoryError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'RepositoryError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function assertRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new TypeError('repository must be an object');
  }
  const missing = REPOSITORY_METHODS.filter(method => typeof repository[method] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(`repository is missing methods: ${missing.join(', ')}`);
  }
  return repository;
}

export function isRepositoryError(error, code) {
  return error instanceof RepositoryError && (code === undefined || error.code === code);
}
