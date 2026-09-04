import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  createRealtimeServer,
  createRealtimeServerAsync
} from '../src/server.js';
import { loadConfig } from '../src/config/index.js';
import {
  createMemoryGameStore,
  MemoryDeadlineStore
} from '../src/infra/persistence/index.js';

class EmptyPool {
  constructor() {
    this.ended = false;
  }

  async query() {
    return { rows: [] };
  }

  async connect() {
    return {
      query: async () => ({ rows: [] }),
      release() {}
    };
  }

  async end() {
    this.ended = true;
  }
}

function postgresConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    PORT: '8787',
    PERSISTENCE_BACKEND: 'postgres',
    DATABASE_URL: 'postgresql://test.invalid/susong'
  });
}

test('synchronous server factory fails closed for an unmounted non-memory backend', () => {
  assert.throws(
    () => createRealtimeServer({ config: postgresConfig(), port: 0, host: '127.0.0.1' }),
    error => error.code === 'CONFIG_INVALID'
      && /createRealtimeServerAsync/.test(error.message)
  );
});

test('async server factory mounts configured PostgreSQL persistence and closes owned pool', async () => {
  const pool = new EmptyPool();
  const app = await createRealtimeServerAsync({
    config: postgresConfig(),
    pool,
    port: 0,
    host: '127.0.0.1'
  });
  try {
    await once(app.wss, 'listening');
    assert.equal(app.eventStore.constructor.name, 'PostgresGameEventStore');
    assert.equal(app.outbox.constructor.name, 'PostgresOutbox');
    assert.equal(app.deadlineStore.constructor.name, 'PostgresDeadlineStore');
    assert.equal(app.deadlines.deadlineStore, app.deadlineStore);
    const readiness = await app.readiness();
    assert.equal(readiness.status, 'ready');
  } finally {
    await app.close();
  }
  assert.equal(pool.ended, true);
});

test('synchronous server mounts an explicitly injected deadline store on its scheduler', async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: '8787',
    PERSISTENCE_BACKEND: 'memory'
  });
  const persistence = createMemoryGameStore();
  const explicitDeadlineStore = new MemoryDeadlineStore();
  const app = createRealtimeServer({
    config,
    eventStore: persistence.eventStore,
    lock: persistence.lock,
    outbox: persistence.outbox,
    deadlineStore: explicitDeadlineStore,
    port: 0,
    host: '127.0.0.1'
  });
  try {
    await once(app.wss, 'listening');
    assert.equal(app.deadlineStore, explicitDeadlineStore);
    assert.equal(app.deadlines.deadlineStore, explicitDeadlineStore);
    assert.notEqual(app.eventStore.deadlineStore, explicitDeadlineStore);
  } finally {
    await app.close();
  }
});
