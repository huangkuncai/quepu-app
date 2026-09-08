import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { parseEnv } from '../src/config/env.js';
import { createRealtimeServerAsync } from '../src/server.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const dartRoot = resolve(repositoryRoot, 'clients/dart_protocol');
const config = parseEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  AUTH_MODE: 'stub',
  PERSISTENCE_BACKEND: 'memory'
});

const app = await createRealtimeServerAsync({
  config,
  host: '127.0.0.1',
  port: 0
});

try {
  if (!app.wss.address()) await once(app.wss, 'listening');
  const address = app.wss.address();
  if (!address || typeof address === 'string') {
    throw new Error('real client verifier could not resolve the WSS address');
  }
  const endpoint = `ws://127.0.0.1:${address.port}`;
  const child = spawn(
    'dart',
    ['run', 'tool/real_backend_acceptance.dart', endpoint],
    { cwd: dartRoot, stdio: 'inherit' }
  );
  const [code, signal] = await once(child, 'exit');
  if (code !== 0) {
    throw new Error(`real client verifier failed (${signal || `exit ${code}`})`);
  }
} finally {
  await app.close();
}
