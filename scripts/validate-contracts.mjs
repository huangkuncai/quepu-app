import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
const documents = [
  { relativePath: 'docs/protocol/openapi.yaml', kind: 'openapi', version: '3.1.0' },
  { relativePath: 'docs/protocol/asyncapi.yaml', kind: 'asyncapi', version: '2.6.0' }
];
const operationMethods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

function fail(relativePath, message) {
  throw new Error(`contract ${relativePath}: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveJsonPointer(document, pointer) {
  if (pointer === '' || pointer === '#') return document;
  if (!pointer.startsWith('#/')) return undefined;
  return pointer.slice(2).split('/').reduce((value, segment) => {
    if (value === undefined || value === null) return undefined;
    const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
    return value[key];
  }, document);
}

function validateReferences(value, document, relativePath, currentFile, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (typeof value.$ref === 'string') {
    const reference = value.$ref;
    const [targetPath, fragment = ''] = reference.split('#', 2);
    if (!targetPath) {
      if (resolveJsonPointer(document, fragment ? `#${fragment}` : '#') === undefined) {
        fail(relativePath, `unresolved local $ref ${reference}`);
      }
    } else {
      const targetFile = resolve(dirname(currentFile), targetPath);
      if (!existsSync(targetFile)) fail(relativePath, `missing external $ref ${reference}`);
      if (fragment) {
        const external = parseDocument(readFileSync(targetFile, 'utf8')).toJS();
        if (resolveJsonPointer(external, `#${fragment}`) === undefined) {
          fail(relativePath, `unresolved external $ref ${reference}`);
        }
      }
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) validateReferences(item, document, relativePath, currentFile, seen);
  } else {
    for (const child of Object.values(value)) validateReferences(child, document, relativePath, currentFile, seen);
  }
}

function dereferenceLocal(value, document, relativePath, label) {
  if (!isRecord(value) || typeof value.$ref !== 'string') return value;
  const resolved = resolveJsonPointer(document, value.$ref);
  if (resolved === undefined) fail(relativePath, `${label} has unresolved local $ref ${value.$ref}`);
  return resolved;
}

function operationAt(document, relativePath, path, method) {
  const pathItem = document.paths?.[path];
  if (!isRecord(pathItem)) fail(relativePath, `required path is missing: ${path}`);
  const operation = pathItem[method];
  if (!isRecord(operation)) fail(relativePath, `required operation is missing: ${method.toUpperCase()} ${path}`);
  return operation;
}

function assertResponse(document, relativePath, operation, status, expectedSchema) {
  const key = String(status);
  if (!Object.hasOwn(operation.responses || {}, key)) {
    fail(relativePath, `${operation.operationId} must declare response ${key}`);
  }
  const response = dereferenceLocal(operation.responses[key], document, relativePath, `${operation.operationId} ${key}`);
  if (!isRecord(response) || typeof response.description !== 'string') {
    fail(relativePath, `${operation.operationId} response ${key} needs a description`);
  }
  if (!expectedSchema) return response;
  const media = response.content?.['application/json'];
  const schema = media?.schema;
  if (!isRecord(schema)) fail(relativePath, `${operation.operationId} response ${key} needs an application/json schema`);
  if (schema.$ref !== expectedSchema) {
    fail(relativePath, `${operation.operationId} response ${key} must reference ${expectedSchema}`);
  }
  return response;
}

function assertWrapper(document, relativePath, schemaName, dataRef) {
  const schema = document.components?.schemas?.[schemaName];
  if (!isRecord(schema) || !Array.isArray(schema.allOf)) {
    fail(relativePath, `${schemaName} must extend ApiResponse with allOf`);
  }
  if (!schema.allOf.some(item => item?.$ref === '#/components/schemas/ApiResponse')) {
    fail(relativePath, `${schemaName} must include the ApiResponse wrapper`);
  }
  const dataSchema = schema.allOf
    .map(item => item?.properties?.data)
    .find(item => item !== undefined);
  if (dataRef && dataSchema?.$ref !== dataRef) {
    fail(relativePath, `${schemaName}.data must reference ${dataRef}`);
  }
}

function assertRestContract(document, relativePath) {
  const components = document.components;
  if (!isRecord(components) || !isRecord(components.schemas)) {
    fail(relativePath, 'components.schemas must be present');
  }

  const apiResponse = components.schemas.ApiResponse;
  if (!isRecord(apiResponse) || !Array.isArray(apiResponse.required)
    || !apiResponse.required.includes('requestId') || !apiResponse.required.includes('data')) {
    fail(relativePath, 'ApiResponse must require requestId and data');
  }
  assertWrapper(document, relativePath, 'AuthSessionResponse', '#/components/schemas/AuthSession');
  assertWrapper(document, relativePath, 'HealthResponse', '#/components/schemas/Health');
  assertWrapper(document, relativePath, 'CurrentUserResponse', '#/components/schemas/CurrentUser');
  assertWrapper(document, relativePath, 'RoomResponse', '#/components/schemas/Room');
  const roomCommandResponse = components.schemas.RoomCommandResponse;
  assertWrapper(document, relativePath, 'RoomCommandResponse');
  const commandData = roomCommandResponse?.allOf?.map(item => item?.properties?.data)
    .find(item => item !== undefined);
  if (!Array.isArray(commandData?.required)
    || !['accepted', 'room', 'roomVersion'].every(field => commandData.required.includes(field))) {
    fail(relativePath, 'RoomCommandResponse.data must require accepted, room and roomVersion');
  }

  const health = components.schemas.Health;
  if (!Array.isArray(health?.required) || !health.required.includes('checkedAt')
    || health.properties?.protocolVersion !== undefined) {
    fail(relativePath, 'Health must match the liveness payload (status + checkedAt)');
  }
  const authSession = components.schemas.AuthSession;
  if (!Array.isArray(authSession?.required) || !authSession.required.includes('user')) {
    fail(relativePath, 'AuthSession must include user');
  }
  const loginRequest = components.schemas.LoginRequest;
  if (!Array.isArray(loginRequest?.oneOf) || loginRequest.oneOf.length !== 2
    || !loginRequest.oneOf.some(item => item?.required?.join(',') === 'phone,code')
    || !loginRequest.oneOf.some(item => item?.required?.join(',') === 'playerId')) {
    fail(relativePath, 'LoginRequest must support phone/code and playerId forms');
  }

  const login = operationAt(document, relativePath, '/v1/auth/login', 'post');
  const refresh = operationAt(document, relativePath, '/v1/auth/refresh', 'post');
  assertResponse(document, relativePath, login, 200, '#/components/schemas/AuthSessionResponse');
  assertResponse(document, relativePath, refresh, 200, '#/components/schemas/AuthSessionResponse');

  const createRoom = operationAt(document, relativePath, '/v1/rooms', 'post');
  assertResponse(document, relativePath, createRoom, 200, '#/components/schemas/RoomResponse');
  assertResponse(document, relativePath, createRoom, 201, '#/components/schemas/RoomResponse');

  const getRoom = operationAt(document, relativePath, '/v1/rooms/{roomId}', 'get');
  assertResponse(document, relativePath, getRoom, 200, '#/components/schemas/RoomResponse');
  const notModified = assertResponse(document, relativePath, getRoom, 304);
  if (notModified.content !== undefined) fail(relativePath, 'GET room 304 must not include a response body');

  const commands = operationAt(document, relativePath, '/v1/rooms/{roomId}/commands', 'post');
  if (Object.hasOwn(commands.responses, '202')) fail(relativePath, 'room commands must not advertise 202');
  assertResponse(document, relativePath, commands, 200, '#/components/schemas/RoomCommandResponse');
  for (const status of [401, 403, 404, 409, 413, 422, 426]) assertResponse(document, relativePath, commands, status);

  for (const commandPath of ['begin', 'action', 'settle', 'next']) {
    const operation = operationAt(document, relativePath, `/v1/rooms/{roomId}/${commandPath}`, 'post');
    assertResponse(document, relativePath, operation, 200, '#/components/schemas/RoomCommandResponse');
  }
}

function validateOpenApi(document, relativePath) {
  if (document.openapi !== '3.1.0') fail(relativePath, `expected openapi 3.1.0, got ${document.openapi}`);
  if (!isRecord(document.info) || typeof document.info.title !== 'string') fail(relativePath, 'info.title is required');
  if (!isRecord(document.paths) || Object.keys(document.paths).length === 0) fail(relativePath, 'paths must not be empty');
  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!path.startsWith('/')) fail(relativePath, `path must start with /: ${path}`);
    if (!isRecord(pathItem)) fail(relativePath, `path item is not an object: ${path}`);
    const dereference = parameter => parameter?.$ref
      ? resolveJsonPointer(document, parameter.$ref)
      : parameter;
    const pathParameters = (Array.isArray(pathItem.parameters) ? pathItem.parameters : []).map(dereference);
    const pathNames = new Set(pathParameters
      .filter(parameter => parameter?.in === 'path')
      .map(parameter => parameter.name));
    for (const parameter of pathParameters) {
      if (parameter?.in === 'path' && parameter.required !== true) fail(relativePath, `path parameter ${parameter.name} must be required`);
    }
    const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
    for (const method of Object.keys(pathItem).filter(key => operationMethods.has(key))) {
      const operation = pathItem[method];
      if (!isRecord(operation) || typeof operation.operationId !== 'string' || !operation.operationId) {
        fail(relativePath, `${method.toUpperCase()} ${path} needs operationId`);
      }
      if (!isRecord(operation.responses) || Object.keys(operation.responses).length === 0) {
        fail(relativePath, `${operation.operationId} needs at least one response`);
      }
      const parameters = [
        ...pathParameters,
        ...(Array.isArray(operation.parameters) ? operation.parameters : []).map(dereference)
      ];
      const operationNames = new Set(parameters
        .filter(parameter => parameter?.in === 'path')
        .map(parameter => parameter.name));
      for (const name of placeholders) {
        if (!pathNames.has(name) && !operationNames.has(name)) {
          fail(relativePath, `${operation.operationId} does not declare path parameter ${name}`);
        }
      }
    }
  }
  assertRestContract(document, relativePath);
}

function validateAsyncApi(document, relativePath) {
  if (document.asyncapi !== '2.6.0') fail(relativePath, `expected asyncapi 2.6.0, got ${document.asyncapi}`);
  if (!isRecord(document.info) || typeof document.info.title !== 'string') fail(relativePath, 'info.title is required');
  if (!isRecord(document.channels) || Object.keys(document.channels).length === 0) fail(relativePath, 'channels must not be empty');
  if (!isRecord(document.components?.messages) || Object.keys(document.components.messages).length === 0) {
    fail(relativePath, 'components.messages must not be empty');
  }
}

for (const entry of documents) {
  const absolutePath = resolve(root, entry.relativePath);
  const source = readFileSync(absolutePath, 'utf8');
  const parsed = parseDocument(source, { prettyErrors: true, strict: true });
  if (parsed.errors.length > 0) fail(entry.relativePath, parsed.errors.map(error => error.message).join('; '));
  const document = parsed.toJS();
  if (!isRecord(document)) fail(entry.relativePath, 'root document must be an object');
  if (entry.kind === 'openapi') validateOpenApi(document, entry.relativePath);
  else validateAsyncApi(document, entry.relativePath);
  validateReferences(document, document, entry.relativePath, absolutePath);
}

console.log(`contracts: ${documents.length} OpenAPI/AsyncAPI YAML documents parsed and references resolved`);
