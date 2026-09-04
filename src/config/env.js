import { AppError } from '../shared/errors.js';
import { envSchema } from './env-schema.js';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function parseValue(name, rawValue, definition) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return definition.default;
  }

  if (definition.type === 'string') {
    const value = String(rawValue);
    if (definition.minLength && value.length < definition.minLength) {
      throw new Error(`${name} must not be empty`);
    }
    return value;
  }

  if (definition.type === 'enum') {
    const value = String(rawValue);
    if (!definition.values.includes(value)) {
      throw new Error(`${name} must be one of: ${definition.values.join(', ')}`);
    }
    return value;
  }

  if (definition.type === 'integer') {
    const value = Number(rawValue);
    if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
    if (value < definition.min || value > definition.max) {
      throw new Error(`${name} must be between ${definition.min} and ${definition.max}`);
    }
    return value;
  }

  if (definition.type === 'boolean') {
    const value = String(rawValue).toLowerCase();
    if (TRUE_VALUES.has(value)) return true;
    if (FALSE_VALUES.has(value)) return false;
    throw new Error(`${name} must be a boolean`);
  }

  throw new Error(`${name} has unsupported schema type ${definition.type}`);
}

/**
 * Parse and validate a plain environment object. Unknown variables are ignored
 * so platform/secret-manager variables can coexist with application settings.
 */
export function parseEnv(rawEnv = process.env) {
  const values = {};
  const problems = [];

  for (const [name, definition] of Object.entries(envSchema)) {
    try {
      values[name] = parseValue(name, rawEnv[name], definition);
    } catch (error) {
      problems.push(error.message);
    }
  }

  if (values.WS_HEARTBEAT_TIMEOUT_MS >= values.WS_HEARTBEAT_INTERVAL_MS) {
    problems.push('WS_HEARTBEAT_TIMEOUT_MS must be less than WS_HEARTBEAT_INTERVAL_MS');
  }

  if (problems.length > 0) {
    throw new AppError('CONFIG_INVALID', { details: problems });
  }

  return Object.freeze({
    ...values,
    featureFlags: Object.freeze({
      realRules: values.FEATURE_REAL_RULES,
      realDiamonds: values.FEATURE_REAL_DIAMONDS
    })
  });
}

/**
 * Production is intentionally fail-closed until a real authentication provider
 * and the corresponding security review are wired in. The current skeleton can
 * still be run in development/test/staging with AUTH_MODE=stub.
 */
export function assertProductionSafe(config) {
  const problems = [];
  if (config.NODE_ENV === 'production' && config.AUTH_MODE !== 'external') {
    problems.push('AUTH_MODE=external is required in production');
  }
  if (config.NODE_ENV === 'production' && config.FEATURE_REAL_RULES !== true) {
    problems.push('FEATURE_REAL_RULES must be enabled explicitly in production');
  }
  if (config.NODE_ENV === 'production' && config.FEATURE_REAL_DIAMONDS !== true) {
    problems.push('FEATURE_REAL_DIAMONDS must be enabled explicitly in production');
  }
  if (problems.length > 0) throw new AppError('CONFIG_INVALID', { details: problems });
  return config;
}

export const loadConfig = parseEnv;
