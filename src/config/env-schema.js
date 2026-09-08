/**
 * Environment configuration is intentionally dependency-free and machine-readable.
 * The schema is the single source for defaults, coercion and validation in the
 * modular monolith. Secrets are not defined here; they belong in a secret store.
 */
export const envSchema = Object.freeze({
  NODE_ENV: Object.freeze({
    type: 'enum',
    values: Object.freeze(['development', 'test', 'staging', 'production']),
    default: 'development'
  }),
  HOST: Object.freeze({ type: 'string', default: '127.0.0.1', minLength: 1 }),
  PORT: Object.freeze({ type: 'integer', default: 8787, min: 1, max: 65535 }),
  REST_PORT: Object.freeze({ type: 'integer', default: 8788, min: 1, max: 65535 }),
  LOG_LEVEL: Object.freeze({
    type: 'enum',
    values: Object.freeze(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
    default: 'info'
  }),
  AUTH_MODE: Object.freeze({
    type: 'enum',
    values: Object.freeze(['stub', 'external']),
    default: 'stub'
  }),
  WS_MAX_PAYLOAD_BYTES: Object.freeze({
    type: 'integer',
    default: 65536,
    min: 1024,
    max: 1048576
  }),
  WS_HEARTBEAT_INTERVAL_MS: Object.freeze({
    type: 'integer',
    default: 30000,
    min: 5000,
    max: 300000
  }),
  WS_HEARTBEAT_TIMEOUT_MS: Object.freeze({
    type: 'integer',
    default: 10000,
    min: 1000,
    max: 120000
  }),
  WS_RATE_LIMIT_PER_MINUTE: Object.freeze({
    type: 'integer',
    default: 120,
    min: 10,
    max: 10000
  }),
  WS_MAX_BUFFERED_BYTES: Object.freeze({
    type: 'integer',
    default: 1048576,
    min: 65536,
    max: 16777216
  }),
  WS_MAX_QUEUE_MESSAGES: Object.freeze({
    type: 'integer',
    default: 256,
    min: 8,
    max: 10000
  }),
  WS_RECONNECT_GRACE_MS: Object.freeze({
    type: 'integer',
    default: 120000,
    min: 1000,
    max: 3600000
  }),
  ALLOWED_ORIGINS: Object.freeze({ type: 'string', default: '' }),
  PERSISTENCE_BACKEND: Object.freeze({
    type: 'enum',
    values: Object.freeze(['memory', 'postgres']),
    default: 'memory'
  }),
  DATABASE_URL: Object.freeze({ type: 'string', default: '' }),
  REDIS_URL: Object.freeze({ type: 'string', default: '' }),
  ROOM_EVENT_RETENTION: Object.freeze({
    type: 'integer',
    default: 10000,
    min: 100,
    max: 1000000
  }),
  FEATURE_REAL_RULES: Object.freeze({ type: 'boolean', default: false }),
  FEATURE_REAL_DIAMONDS: Object.freeze({ type: 'boolean', default: false })
});

export const environmentNames = envSchema.NODE_ENV.values;
