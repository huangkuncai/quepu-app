import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../shared/errors.js';

const schemaDirectory = fileURLToPath(new URL('../../schemas/protocol/', import.meta.url));
const schemaCache = new Map();

function loadSchemaFile(fileName) {
  if (!schemaCache.has(fileName)) {
    const path = join(schemaDirectory, basename(fileName));
    schemaCache.set(fileName, JSON.parse(readFileSync(path, 'utf8')));
  }
  return schemaCache.get(fileName);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function typeMatches(type, value) {
  if (Array.isArray(type)) return type.some(candidate => typeMatches(candidate, value));
  if (type === 'null') return value === null;
  if (type === 'object') return isObject(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function formatMatches(format, value) {
  if (format === 'uuid') {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }
  if (format === 'date-time') {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && /T/.test(value);
  }
  return true;
}

function resolveRef(ref) {
  const fileName = ref.startsWith('https://susong.local/schemas/protocol/')
    ? ref.slice('https://susong.local/schemas/protocol/'.length)
    : ref;
  return loadSchemaFile(fileName);
}

function pushIssue(issues, path, message) {
  issues.push({ path: path || '$', message });
}

function validateNode(schema, value, path, issues) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.$ref) {
    validateNode(resolveRef(schema.$ref), value, path, issues);
    return;
  }

  if (schema.const !== undefined && value !== schema.const) {
    pushIssue(issues, path, `must equal ${JSON.stringify(schema.const)}`);
    return;
  }
  if (schema.enum && !schema.enum.some(item => Object.is(item, value))) {
    pushIssue(issues, path, `must be one of ${schema.enum.join(', ')}`);
    return;
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(candidate => {
      const childIssues = [];
      validateNode(candidate, value, path, childIssues);
      return childIssues.length === 0;
    });
    if (matches.length !== 1) pushIssue(issues, path, 'must match exactly one schema');
  }
  if (schema.anyOf) {
    const matches = schema.anyOf.some(candidate => {
      const childIssues = [];
      validateNode(candidate, value, path, childIssues);
      return childIssues.length === 0;
    });
    if (!matches) pushIssue(issues, path, 'must match at least one schema');
  }

  if (schema.type && !typeMatches(schema.type, value)) {
    pushIssue(issues, path, `must be ${Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type}`);
    return;
  }
  if (schema.format && !formatMatches(schema.format, value)) pushIssue(issues, path, `must match format ${schema.format}`);

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) pushIssue(issues, path, `length must be >= ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) pushIssue(issues, path, `length must be <= ${schema.maxLength}`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) pushIssue(issues, path, 'has an invalid format');
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) pushIssue(issues, path, `must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) pushIssue(issues, path, `must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) pushIssue(issues, path, `length must be >= ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) pushIssue(issues, path, `length must be <= ${schema.maxItems}`);
    if (schema.items) value.forEach((item, index) => validateNode(schema.items, item, `${path}[${index}]`, issues));
  }
  if (isObject(value)) {
    for (const name of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) pushIssue(issues, `${path}.${name}`, 'is required');
    }
    const properties = schema.properties || {};
    for (const [name, child] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, name)) validateNode(child, value[name], `${path}.${name}`, issues);
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, name)) pushIssue(issues, `${path}.${name}`, 'is not allowed');
      }
    } else if (isObject(schema.additionalProperties)) {
      for (const [name, childValue] of Object.entries(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, name)) validateNode(schema.additionalProperties, childValue, `${path}.${name}`, issues);
      }
    }
  }
}

export function loadSchema(fileName) {
  return loadSchemaFile(fileName);
}

export function validateSchema(value, schemaOrFile) {
  const schema = typeof schemaOrFile === 'string' ? loadSchemaFile(schemaOrFile) : schemaOrFile;
  const issues = [];
  validateNode(schema, value, '$', issues);
  return issues;
}

export function assertSchema(value, schemaOrFile, code = 'VALIDATION_FAILED') {
  const issues = validateSchema(value, schemaOrFile);
  if (issues.length > 0) throw new AppError(code, { details: issues });
  return value;
}
