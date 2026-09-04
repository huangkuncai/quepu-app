import test from 'node:test';
import assert from 'node:assert/strict';
import { DeadlineScheduler } from '../src/domain/deadline.js';
import {
  DEADLINE_STATUS,
  MemoryDeadlineStore,
  PostgresDeadlineStore
} from '../src/infra/persistence/index.js';

function definition(overrides = {}) {
  return {
    deadlineId: 'deadline-1',
    roomId: 'room-1',
    commandId: 'command-1',
    deadlineAt: '2026-01-01T00:00:00.000Z',
    expectedRoomVersion: 7,
    roundId: 'round-1',
    playerId: 'p1',
    timeoutAction: { type: 'action', action: 'pass' },
    ...overrides
  };
}

test('MemoryDeadlineStore claims one due deadline and rejects stale completion', () => {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const store = new MemoryDeadlineStore({ clock: () => now });
  const first = store.upsert(definition());
  assert.equal(first.status, DEADLINE_STATUS.SCHEDULED);

  const claimA = store.claim('deadline-1', { ownerId: 'worker-a', now, leaseMs: 1000 });
  assert.equal(claimA.claimed, true);
  assert.equal(claimA.leaseToken, 1);
  assert.equal(store.claim('deadline-1', { ownerId: 'worker-b', now, leaseMs: 1000 }).reason, 'LEASE_HELD');
  assert.equal(store.claim('deadline-1', { ownerId: 'worker-a', now, leaseMs: 1000 }).replayed, true);

  now += 1001;
  const claimB = store.claim('deadline-1', { ownerId: 'worker-b', now, leaseMs: 1000 });
  assert.equal(claimB.claimed, true);
  assert.ok(claimB.leaseToken > claimA.leaseToken);
  assert.throws(
    () => store.complete('deadline-1', { ownerId: 'worker-a', leaseToken: claimA.leaseToken, status: 'EXECUTED' }),
    error => error.code === 'FENCING_TOKEN_STALE'
  );
  const completed = store.complete('deadline-1', {
    ownerId: 'worker-b',
    leaseToken: claimB.leaseToken,
    status: 'EXECUTED',
    result: { roomVersion: 8 }
  });
  assert.equal(completed.status, DEADLINE_STATUS.EXECUTED);
  assert.equal(store.claim('deadline-1', { ownerId: 'worker-c', now, leaseMs: 1000 }).claimed, false);
});

test('MemoryDeadlineStore leaves a future deadline scheduled until its exact due time', () => {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const store = new MemoryDeadlineStore({ clock: () => now });
  store.upsert(definition({
    deadlineId: 'memory-not-due',
    deadlineAt: new Date(now + 100).toISOString()
  }));

  const early = store.claim('memory-not-due', { ownerId: 'worker-a', now: now + 99, leaseMs: 1000 });
  assert.equal(early.claimed, false);
  assert.equal(early.reason, 'NOT_DUE');
  assert.equal(early.record.status, DEADLINE_STATUS.SCHEDULED);
  assert.equal(early.record.attempts, 0);
  assert.equal(early.record.leaseOwner, null);

  now += 100;
  const due = store.claim('memory-not-due', { ownerId: 'worker-a', now, leaseMs: 1000 });
  assert.equal(due.claimed, true);
  assert.equal(due.record.status, DEADLINE_STATUS.CLAIMED);
  assert.equal(due.record.attempts, 1);
});

test('MemoryDeadlineStore replays terminal state without requiring a live lease', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const store = new MemoryDeadlineStore({ clock: () => now });
  store.upsert(definition({ deadlineId: 'memory-terminal' }));
  const claim = store.claim('memory-terminal', { ownerId: 'worker-a', now, leaseMs: 1000 });
  const completed = store.complete('memory-terminal', {
    ownerId: 'worker-a',
    leaseToken: claim.leaseToken,
    status: DEADLINE_STATUS.EXECUTED,
    result: { roomVersion: 8 }
  });

  const claimReplay = store.claim('memory-terminal', {
    ownerId: 'worker-b',
    now,
    leaseMs: 1000
  });
  assert.equal(claimReplay.claimed, false);
  assert.equal(claimReplay.reason, 'TERMINAL');
  assert.deepEqual(claimReplay.record, completed);
  assert.deepEqual(store.complete('memory-terminal', {
    ownerId: 'worker-b',
    leaseToken: 999,
    status: DEADLINE_STATUS.STALE
  }), completed);
  assert.deepEqual(store.cancel('memory-terminal', { reason: 'late-cancel' }), completed);
});

test('two schedulers sharing a durable store dispatch a deadline once', async () => {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const timers = [];
  const setTimeout = (callback, delay) => {
    const timer = { callback, at: now + delay, cancelled: false };
    timers.push(timer);
    return timer;
  };
  const clearTimeout = timer => { if (timer) timer.cancelled = true; };
  const store = new MemoryDeadlineStore({ clock: () => now });
  const calls = [];
  const dispatch = async (roomId, command, context) => {
    calls.push({ roomId, command, context });
    return { accepted: true, roomVersion: 8 };
  };
  const schedulerA = new DeadlineScheduler({
    dispatch,
    deadlineStore: store,
    workerId: 'worker-a',
    clock: () => now,
    setTimeout,
    clearTimeout,
    idFactory: () => 'unused-a'
  });
  const schedulerB = new DeadlineScheduler({
    dispatch,
    deadlineStore: store,
    workerId: 'worker-b',
    clock: () => now,
    setTimeout,
    clearTimeout,
    idFactory: () => 'unused-b'
  });
  const options = {
    roomId: 'room-1',
    deadlineId: 'deadline-shared',
    deadlineMs: 0,
    expectedRoomVersion: 7,
    roundId: 'round-1',
    playerId: 'p1',
    timeoutAction: 'pass'
  };
  const scheduledA = schedulerA.schedule(options);
  const scheduledB = schedulerB.schedule(options);
  assert.match(scheduledA.commandId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(scheduledB.commandId, scheduledA.commandId);
  now += 1;
  for (const timer of timers) {
    if (!timer.cancelled && timer.at <= now) await timer.callback();
  }
  assert.equal(calls.length, 1);
  const outcomes = [schedulerA.get('deadline-shared'), schedulerB.get('deadline-shared')];
  assert.equal(outcomes.filter(item => item.status === 'executed').length, 1);
  assert.equal(outcomes.filter(item => item.status === 'skipped').length, 1);
  assert.equal(store.get('deadline-shared').status, DEADLINE_STATUS.EXECUTED);
  schedulerA.close();
  schedulerB.close();
});

test('a scheduler retries after another worker lease expires and does not spin before due time', async () => {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const timers = [];
  const setTimeout = (callback, delay) => {
    const timer = { callback, at: now + delay, cancelled: false };
    timers.push(timer);
    return timer;
  };
  const clearTimeout = timer => { if (timer) timer.cancelled = true; };
  const store = new MemoryDeadlineStore({ clock: () => now });
  const options = {
    roomId: 'room-1',
    deadlineId: 'deadline-retry',
    commandId: 'command-retry',
    deadlineMs: 100,
    timeoutAction: 'pass'
  };
  const scheduler = new DeadlineScheduler({
    dispatch: async () => ({ accepted: true }),
    deadlineStore: store,
    workerId: 'worker-b',
    leaseMs: 50,
    clock: () => now,
    setTimeout,
    clearTimeout,
    idFactory: () => 'unused'
  });
  scheduler.schedule(options);
  await Promise.resolve();
  await Promise.resolve();
  now += 100;
  const persisted = store.get('deadline-retry');
  const held = store.claim('deadline-retry', { ownerId: 'worker-a', now, leaseMs: 50 });
  assert.equal(held.claimed, true);
  const waiting = await scheduler.expire('deadline-retry');
  assert.equal(waiting.status, 'scheduled');
  assert.equal(waiting.reason, 'LEASE_HELD');
  assert.equal(timers.filter(timer => !timer.cancelled).length, 1);
  assert.equal(persisted.status, DEADLINE_STATUS.SCHEDULED);

  now += 50;
  const retryTimer = timers.find(timer => !timer.cancelled && timer.at <= now);
  await retryTimer.callback();
  assert.equal(scheduler.get('deadline-retry').status, 'executed');
  assert.equal(store.get('deadline-retry').status, DEADLINE_STATUS.EXECUTED);
  scheduler.close();
});

class ScriptedDeadlinePool {
  constructor() {
    this.rows = new Map();
    this.calls = [];
  }

  row(deadlineId) {
    const row = this.rows.get(deadlineId);
    return row ? structuredClone(row) : undefined;
  }

  async query(text, values = []) {
    this.calls.push({ text, values });
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK' || text === 'SELECT 1') return { rows: [] };
    if (/INSERT INTO game_deadlines/.test(text)) {
      const [deadlineId, roomId, commandId, deadlineAt, expectedRoomVersion, roundId, playerId, action, fingerprint, createdAt, updatedAt] = values;
      if (!this.rows.has(deadlineId)) {
        this.rows.set(deadlineId, {
          deadline_id: deadlineId,
          room_id: roomId,
          command_id: commandId,
          deadline_at: deadlineAt,
          expected_room_version: expectedRoomVersion,
          round_id: roundId,
          player_id: playerId,
          timeout_action_json: JSON.parse(action),
          fingerprint,
          status: 'SCHEDULED',
          attempts: 0,
          lease_owner: null,
          lease_token: null,
          lease_expires_at: null,
          claimed_at: null,
          completed_at: null,
          reason: null,
          result_json: null,
          error_json: null,
          created_at: createdAt,
          updated_at: updatedAt
        });
      }
      return { rows: [this.row(deadlineId)] };
    }
    if (/FROM game_deadlines/.test(text) && text.includes('ORDER BY')) {
      return { rows: [...this.rows.values()].map(row => structuredClone(row)) };
    }
    if (/FROM game_deadlines/.test(text)) {
      const row = this.row(values[0]);
      return { rows: row ? [row] : [] };
    }
    if (/SET status = 'CLAIMED'/.test(text)) {
      const [deadlineId, owner, token, expires, claimedAt] = values;
      const row = this.rows.get(deadlineId);
      row.status = 'CLAIMED';
      row.attempts += 1;
      row.lease_owner = owner;
      row.lease_token = token;
      row.lease_expires_at = expires;
      row.claimed_at = claimedAt;
      row.updated_at = claimedAt;
      return { rows: [this.row(deadlineId)] };
    }
    if (/SET status = \$2/.test(text)) {
      const [deadlineId, status, completedAt, reason, result, error] = values;
      const row = this.rows.get(deadlineId);
      row.status = status;
      row.completed_at = completedAt;
      row.updated_at = completedAt;
      row.reason = reason;
      row.result_json = result === null ? null : JSON.parse(result);
      row.error_json = error === null ? null : JSON.parse(error);
      row.lease_owner = null;
      row.lease_token = null;
      row.lease_expires_at = null;
      return { rows: [this.row(deadlineId)] };
    }
    if (/SET status = 'CANCELLED'/.test(text)) {
      const [deadlineId, reason, completedAt] = values;
      const row = this.rows.get(deadlineId);
      row.status = 'CANCELLED';
      row.reason = reason;
      row.completed_at = completedAt;
      row.updated_at = completedAt;
      row.lease_owner = null;
      row.lease_token = null;
      row.lease_expires_at = null;
      return { rows: [this.row(deadlineId)] };
    }
    return { rows: [] };
  }

  async connect() {
    return { query: this.query.bind(this), release() {} };
  }
}

test('PostgresDeadlineStore uses row locks and persists completion state', async () => {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const pool = new ScriptedDeadlinePool();
  const store = new PostgresDeadlineStore({ pool, clock: () => now });
  await store.upsert(definition());
  const claim = await store.claim('deadline-1', { ownerId: 'worker-a', now, leaseMs: 1000 });
  assert.equal(claim.claimed, true);
  await store.complete('deadline-1', { ownerId: 'worker-a', leaseToken: claim.leaseToken, status: 'EXECUTED', result: { ok: true } });
  assert.equal((await store.get('deadline-1')).status, DEADLINE_STATUS.EXECUTED);
  assert.ok(pool.calls.some(call => /FOR UPDATE/.test(call.text)));
  assert.equal(pool.calls.filter(call => call.text === 'BEGIN').length, 2);
  assert.equal(pool.calls.filter(call => call.text === 'COMMIT').length, 2);
});

test('PostgresDeadlineStore reports NOT_DUE without claiming a future deadline', async () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const pool = new ScriptedDeadlinePool();
  const store = new PostgresDeadlineStore({ pool, clock: () => now });
  await store.upsert(definition({
    deadlineId: 'postgres-not-due',
    deadlineAt: new Date(now + 100).toISOString()
  }));

  const result = await store.claim('postgres-not-due', {
    ownerId: 'worker-a',
    now: now + 99,
    leaseMs: 1000
  });
  assert.equal(result.claimed, false);
  assert.equal(result.reason, 'NOT_DUE');
  assert.equal(result.record.status, DEADLINE_STATUS.SCHEDULED);
  assert.equal(result.record.attempts, 0);
  assert.equal(pool.calls.some(call => /SET status = 'CLAIMED'/.test(call.text)), false);
});

test('PostgresDeadlineStore reclaims an expired lease and fences the previous worker', async () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const pool = new ScriptedDeadlinePool();
  const store = new PostgresDeadlineStore({ pool, clock: () => now });
  await store.upsert(definition({ deadlineId: 'postgres-lease-recovery' }));

  const first = await store.claim('postgres-lease-recovery', {
    ownerId: 'worker-a',
    now,
    leaseMs: 100
  });
  assert.equal(first.claimed, true);
  const held = await store.claim('postgres-lease-recovery', {
    ownerId: 'worker-b',
    now: now + 99,
    leaseMs: 100
  });
  assert.equal(held.claimed, false);
  assert.equal(held.reason, 'LEASE_HELD');

  const recovered = await store.claim('postgres-lease-recovery', {
    ownerId: 'worker-b',
    now: now + 100,
    leaseMs: 100
  });
  assert.equal(recovered.claimed, true);
  assert.ok(recovered.leaseToken > first.leaseToken);
  await assert.rejects(
    store.complete('postgres-lease-recovery', {
      ownerId: 'worker-a',
      leaseToken: first.leaseToken,
      status: DEADLINE_STATUS.EXECUTED
    }),
    error => error.code === 'FENCING_TOKEN_STALE'
  );

  const completed = await store.complete('postgres-lease-recovery', {
    ownerId: 'worker-b',
    leaseToken: recovered.leaseToken,
    status: DEADLINE_STATUS.EXECUTED,
    result: { roomVersion: 8 }
  });
  const replay = await store.complete('postgres-lease-recovery', {
    ownerId: 'worker-c',
    leaseToken: 999,
    status: DEADLINE_STATUS.STALE
  });
  assert.deepEqual(replay, completed);
  assert.equal((await store.claim('postgres-lease-recovery', {
    ownerId: 'worker-c',
    now: now + 100,
    leaseMs: 100
  })).reason, 'TERMINAL');
});
