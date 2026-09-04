import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/shared/errors.js';
import { DeadlineScheduler } from '../src/domain/deadline.js';
import { Room } from '../src/domain/room.js';

class FakeTimers {
  constructor(now = 1_700_000_000_000) {
    this.now = now;
    this.nextId = 1;
    this.pending = new Map();
    this.cleared = [];
  }

  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.pending.set(id, { callback, at: this.now + delay, delay });
    return id;
  };

  clearTimeout = id => {
    if (this.pending.delete(id)) this.cleared.push(id);
  };

  async advance(milliseconds) {
    this.now += milliseconds;
    let due = [...this.pending.entries()]
      .filter(([, timer]) => timer.at <= this.now)
      .sort((left, right) => left[1].at - right[1].at);
    while (due.length > 0) {
      for (const [id, timer] of due) {
        if (!this.pending.delete(id)) continue;
        const callbackResult = timer.callback();
        if (callbackResult?.then) await callbackResult;
        await Promise.resolve();
        await Promise.resolve();
      }
      due = [...this.pending.entries()]
        .filter(([, timer]) => timer.at <= this.now)
        .sort((left, right) => left[1].at - right[1].at);
    }
  }
}

function makeScheduler({ timers = new FakeTimers(), dispatch = async () => ({ accepted: true }), getState, onExpired } = {}) {
  return {
    timers,
    scheduler: new DeadlineScheduler({
      dispatch,
      getState,
      clock: () => timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      idFactory: () => `generated-${timers.nextId}`,
      onExpired
    })
  };
}

test('missing explicit deadline or timeout action is a no-op', () => {
  const { scheduler, timers } = makeScheduler();
  assert.equal(scheduler.schedule({ roomId: 'room-1', timeoutAction: 'pass' }), null);
  assert.equal(scheduler.schedule({ roomId: 'room-1', deadlineMs: 10 }), null);
  assert.equal(timers.pending.size, 0);
  assert.deepEqual(scheduler.list(), []);
});

test('deadlineMs dispatches the explicit action with stable guards and system context', async () => {
  const calls = [];
  const { scheduler, timers } = makeScheduler({
    dispatch: async (...args) => {
      calls.push(args);
      return { accepted: true, roomVersion: 8 };
    }
  });
  const scheduled = scheduler.schedule({
    roomId: 'room-1',
    playerId: 'p1',
    roundId: 'round-1',
    expectedRoomVersion: 7,
    deadlineMs: 100,
    deadlineId: 'deadline-1',
    timeoutAction: { action: 'pass', args: { source: 'fake-rule' } }
  });
  assert.equal(scheduled.status, 'scheduled');
  assert.equal(scheduled.deadlineAt, timers.now + 100);
  await timers.advance(99);
  assert.equal(calls.length, 0);
  await timers.advance(1);
  assert.equal(calls.length, 1);
  const [roomId, command, context] = calls[0];
  assert.equal(roomId, 'room-1');
  assert.equal(command.type, 'action');
  assert.match(command.commandId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(command.expectedRoomVersion, 7);
  assert.equal(command.roundId, 'round-1');
  assert.deepEqual(command.payload, {
    action: 'pass',
    args: { source: 'fake-rule' },
    playerId: 'p1',
    roundId: 'round-1',
    deadlineId: 'deadline-1',
    deadlineAt: new Date(1_700_000_000_100).toISOString(),
    timeout: true
  });
  assert.deepEqual(context, {
    actorId: 'p1',
    actorRole: 'SYSTEM',
    source: 'deadline',
    deadlineId: 'deadline-1',
    expectedRoomVersion: 7,
    roundId: 'round-1'
  });
  assert.equal(scheduler.get('deadline-1').status, 'executed');
  assert.equal((await scheduler.expire('deadline-1')).status, 'executed');
  assert.equal(calls.length, 1, 'an executed deadline must not dispatch twice');
});

test('deadlineAt accepts an absolute Date or ISO timestamp', async () => {
  const calls = [];
  const { scheduler, timers } = makeScheduler({ dispatch: async () => { calls.push(true); } });
  const at = new Date(timers.now + 250);
  const scheduled = scheduler.schedule({
    roomId: 'room-1',
    deadlineAt: at.toISOString(),
    timeoutAction: 'pass'
  });
  assert.equal(scheduled.deadlineAt, at.getTime());
  await timers.advance(249);
  assert.equal(calls.length, 0);
  await timers.advance(1);
  assert.equal(calls.length, 1);
});

test('version or round mismatch marks a deadline stale without dispatching', async () => {
  const calls = [];
  const { scheduler } = makeScheduler({
    getState: () => ({ roomVersion: 9, roundId: 'round-2' }),
    dispatch: async () => { calls.push(true); }
  });
  scheduler.schedule({
    roomId: 'room-1',
    deadlineId: 'stale-version',
    expectedRoomVersion: 8,
    roundId: 'round-1',
    deadlineMs: 0,
    timeoutAction: 'pass'
  });
  const result = await scheduler.expire('stale-version');
  assert.equal(result.status, 'stale');
  assert.equal(result.reason, 'VERSION_CONFLICT');
  assert.equal(calls.length, 0);
});

test('round mismatch is checked when the room version still matches', async () => {
  const calls = [];
  const { scheduler } = makeScheduler({
    getState: () => ({ room: { version: 4, currentRound: { roundId: 'round-new' } } }),
    dispatch: async () => { calls.push(true); }
  });
  scheduler.schedule({
    roomId: 'room-1',
    deadlineId: 'stale-round',
    expectedRoomVersion: 4,
    roundId: 'round-old',
    deadlineMs: 1,
    timeoutAction: 'pass'
  });
  const result = await scheduler.expire('stale-round');
  assert.equal(result.status, 'stale');
  assert.equal(result.reason, 'ROUND_CONFLICT');
  assert.equal(calls.length, 0);
});

test('dispatch VERSION_CONFLICT is recorded as stale and callback receives the outcome', async () => {
  const outcomes = [];
  const { scheduler } = makeScheduler({
    dispatch: async () => { throw new AppError('VERSION_CONFLICT'); },
    onExpired: outcome => outcomes.push(outcome)
  });
  scheduler.schedule({ roomId: 'room-1', deadlineId: 'dispatch-stale', deadlineMs: 0, timeoutAction: 'pass' });
  const result = await scheduler.expire('dispatch-stale');
  assert.equal(result.status, 'stale');
  assert.equal(result.reason, 'VERSION_CONFLICT');
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].deadlineId, 'dispatch-stale');
  assert.equal(outcomes[0].command.payload.timeout, true);
});

test('same deadlineId is idempotent, while a conflicting definition is rejected', () => {
  const { scheduler, timers } = makeScheduler();
  const options = {
    roomId: 'room-1',
    deadlineId: 'same-deadline',
    deadlineMs: 50,
    timeoutAction: 'pass'
  };
  const first = scheduler.schedule(options);
  const replay = scheduler.schedule({ ...options });
  assert.deepEqual(replay, first);
  assert.equal(timers.pending.size, 1);
  assert.throws(
    () => scheduler.schedule({ ...options, timeoutAction: 'discard' }),
    error => error.code === 'DUPLICATE_REQUEST'
  );
});

test('cancel and cancelRoom prevent pending actions; close clears all timers', () => {
  const { scheduler, timers } = makeScheduler();
  scheduler.schedule({ roomId: 'room-1', deadlineId: 'a', deadlineMs: 100, timeoutAction: 'pass' });
  scheduler.schedule({ roomId: 'room-1', deadlineId: 'b', deadlineMs: 100, timeoutAction: 'pass' });
  scheduler.schedule({ roomId: 'room-2', deadlineId: 'c', deadlineMs: 100, timeoutAction: 'pass' });
  assert.equal(scheduler.cancel('a'), true);
  assert.equal(scheduler.cancelRoom('room-1'), 1);
  assert.equal(scheduler.list({ status: 'cancelled' }).length, 2);
  scheduler.close();
  assert.equal(timers.pending.size, 0);
  assert.equal(scheduler.get('c').status, 'cancelled');
  assert.throws(() => scheduler.schedule({ roomId: 'room-2', deadlineMs: 1, timeoutAction: 'pass' }), error => error.code === 'RETRYABLE');
});

test('malformed explicit timing is rejected instead of silently scheduling', () => {
  const { scheduler } = makeScheduler();
  assert.throws(
    () => scheduler.schedule({ roomId: 'room-1', deadlineMs: -1, timeoutAction: 'pass' }),
    error => error.code === 'INVALID_ACTION'
  );
  assert.throws(
    () => scheduler.schedule({ roomId: 'room-1', deadlineAt: 'not-a-date', timeoutAction: 'pass' }),
    error => error.code === 'INVALID_ACTION'
  );
});

test('persisted turn deadline fields replay through the aggregate event stream', () => {
  const now = 1_700_000_000_000;
  const source = new Room({
    id: 'deadline-replay-room',
    maxPlayers: 2,
    ownerId: 'p1',
    clock: () => now,
    deadlinePolicy: {
      enabled: true,
      actionDeadlineMs: 100,
      timeoutAction: 'pass'
    }
  });
  source.join({ id: 'p1' });
  source.join({ id: 'p2' });
  source.start({ actorId: 'p1', autoAdvance: true, bypassReady: true });
  const startedRound = source.currentRound;
  const startedDeadline = startedRound.turnDeadlineAt;
  source.applyAction('p1', 'pass', {
    commandId: 'replay-timeout-1',
    timeout: true,
    deadlineAt: startedDeadline
  });
  const events = source.events;

  const recovered = new Room({
    id: 'deadline-replay-room',
    maxPlayers: 2,
    ownerId: 'p1',
    clock: () => now,
    ruleSnapshot: source.ruleSnapshot,
    deadlinePolicy: source.deadlinePolicy
  });
  for (const event of events) recovered.applyPersistedEvent(event);

  assert.equal(recovered.currentRound.roundId, source.currentRound.roundId);
  assert.equal(recovered.currentRound.turnStartedAt, source.currentRound.turnStartedAt);
  assert.equal(recovered.currentRound.turnDeadlineAt, source.currentRound.turnDeadlineAt);
  assert.equal(recovered.turn, source.turn);
  assert.equal(recovered.turnPlayerId, source.turnPlayerId);
  assert.equal(recovered.currentRound.turnDeadlineAt, new Date(now + 100).toISOString());
});
