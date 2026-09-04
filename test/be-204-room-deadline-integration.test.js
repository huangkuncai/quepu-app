import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { Room, ROOM_STATUS } from '../src/domain/room.js';
import { RoomActor } from '../src/domain/room-actor.js';
import { RoomActorRegistry } from '../src/modules/realtime/gateway.js';
import { DeadlineScheduler } from '../src/domain/deadline.js';
import { createMemoryGameStore } from '../src/infra/persistence/index.js';
import { createRealtimeServer } from '../src/server.js';
import { AuthService } from '../src/modules/auth/index.js';
import { createCommand } from '../src/protocol/index.js';
import { loadConfig } from '../src/config/index.js';

function waitForMessage(ws, predicate = () => true, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('timed out waiting for WebSocket message'));
    }, timeoutMs);
    function onMessage(raw) {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(message);
    }
    ws.on('message', onMessage);
  });
}

async function openClient(url) {
  const socket = new WebSocket(url);
  await once(socket, 'open');
  return socket;
}

async function closeClient(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  await new Promise(resolve => {
    const finish = () => {
      socket.off('close', finish);
      resolve();
    };
    socket.once('close', finish);
    socket.close();
    setTimeout(() => {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      finish();
    }, 500).unref?.();
  });
}

async function sendAndWait(socket, command, type) {
  const response = waitForMessage(socket, message => (
    message.type === type && message.commandId === command.commandId
  ));
  socket.send(JSON.stringify(command));
  return response;
}

class FakeTimers {
  constructor(now = 1_700_000_000_000) {
    this.now = now;
    this.nextId = 1;
    this.pending = new Map();
  }

  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.pending.set(id, { callback, at: this.now + delay });
    return id;
  };

  clearTimeout = id => this.pending.delete(id);

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

test('Room persists an explicit turn deadline and restores it from snapshot', () => {
  let now = 1_700_000_000_000;
  const room = new Room({
    id: 'deadline-room',
    maxPlayers: 2,
    ownerId: 'p1',
    clock: () => now,
    deadlinePolicy: {
      enabled: true,
      actionDeadlineMs: 100,
      timeoutAction: 'pass'
    }
  });
  room.join({ id: 'p1' });
  room.join({ id: 'p2' });
  const started = room.start({ actorId: 'p1', autoAdvance: true, bypassReady: true });
  assert.equal(room.status, ROOM_STATUS.PLAYING);
  assert.equal(started.event.payload.turnDeadlineAt, new Date(now + 100).toISOString());
  assert.equal(room.snapshot().round.turnDeadlineAt, started.event.payload.turnDeadlineAt);

  const restored = Room.fromSnapshot(room.snapshot(), { clock: () => now });
  assert.equal(restored.deadlinePolicy.timeoutAction, 'pass');
  assert.equal(restored.currentRound.turnDeadlineAt, room.currentRound.turnDeadlineAt);

  now += 100;
  const timedOut = restored.applyAction('p1', 'pass', {
    commandId: 'timeout-action-1',
    timeout: true,
    deadlineAt: restored.currentRound.turnDeadlineAt
  });
  assert.equal(timedOut.event.payload.timedOut, true);
  assert.equal(timedOut.event.payload.deadlineAt, new Date(now).toISOString());
  assert.equal(restored.turn, 'p2');
});

test('DeadlineScheduler dispatches a persisted RoomActor timeout and arms the next turn', async () => {
  const timers = new FakeTimers();
  const store = createMemoryGameStore();
  const room = new Room({
    id: 'deadline-actor-room',
    maxPlayers: 2,
    ownerId: 'p1',
    clock: () => timers.now,
    deadlinePolicy: {
      enabled: true,
      actionDeadlineMs: 10,
      timeoutAction: 'pass'
    }
  });
  room.join({ id: 'p1' });
  room.join({ id: 'p2' });
  room.start({ actorId: 'p1', autoAdvance: true, bypassReady: true });
  const actor = new RoomActor({ roomId: room.id, room, eventStore: store.eventStore });
  const registry = new RoomActorRegistry({
    rooms: new Map([[room.id, room]]),
    actors: new Map([[room.id, actor]]),
    eventStore: store.eventStore,
    lock: store.lock,
    outbox: store.outbox
  });
  const outcomes = [];
  const scheduler = new DeadlineScheduler({
    registry,
    clock: () => timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    idFactory: () => `test-${timers.nextId}`,
    onExpired: outcome => outcomes.push(outcome)
  });
  const scheduled = scheduler.refresh(room);
  assert.equal(scheduled.status, 'scheduled');
  await timers.advance(10);
  for (let attempt = 0; attempt < 20 && actor.room.version < 4; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(actor.room.version, 4);
  assert.equal(actor.room.turn, 'p2');
  assert.equal(actor.room.events.at(-1).payload.timedOut, true);
  assert.equal(outcomes.at(-1).status, 'executed');
  assert.equal(scheduler.refresh(actor.room).status, 'scheduled');
  scheduler.close();
});

test('DeadlineScheduler recovers persisted turn deadlines after a process restart', async () => {
  const timers = new FakeTimers();
  const store = createMemoryGameStore({ clock: () => timers.now });
  const room = new Room({
    id: 'deadline-restart-room',
    maxPlayers: 2,
    ownerId: 'p1',
    clock: () => timers.now,
    deadlinePolicy: {
      enabled: true,
      actionDeadlineMs: 10,
      timeoutAction: 'pass'
    }
  });
  const firstRegistry = new RoomActorRegistry({
    rooms: new Map([[room.id, room]]),
    eventStore: store.eventStore,
    lock: store.lock,
    outbox: store.outbox,
    actorOptions: { clock: () => timers.now }
  });
  const firstActor = firstRegistry.get(room.id);
  await firstActor.dispatch({
    type: 'join_room',
    roomId: room.id,
    commandId: 'restart-join-1',
    requestId: 'restart-request-1',
    payload: { playerId: 'p1', name: '一号', seat: 0 }
  }, { actorId: 'p1' });
  await firstActor.dispatch({
    type: 'join_room',
    roomId: room.id,
    commandId: 'restart-join-2',
    requestId: 'restart-request-2',
    payload: { playerId: 'p2', name: '二号', seat: 1 }
  }, { actorId: 'p2' });
  await firstActor.dispatch({
    type: 'start_round',
    roomId: room.id,
    commandId: 'restart-start',
    requestId: 'restart-request-3',
    payload: { autoAdvance: true, bypassReady: true }
  }, { actorId: 'p1' });
  assert.deepEqual(store.eventStore.listRooms(), [room.id]);

  const restartedRegistry = new RoomActorRegistry({
    rooms: new Map(),
    actors: new Map(),
    eventStore: store.eventStore,
    lock: store.lock,
    outbox: store.outbox,
    actorOptions: { clock: () => timers.now }
  });
  const scheduler = new DeadlineScheduler({
    registry: restartedRegistry,
    clock: () => timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    idFactory: () => `restart-deadline-${timers.nextId}`
  });
  const recovered = await scheduler.recoverAll();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].roomId, room.id);
  assert.equal(recovered[0].deadlineAt, timers.now + 10);

  await timers.advance(10);
  const restoredActor = restartedRegistry.get(room.id);
  assert.equal(restoredActor.room.turn, 'p2');
  assert.equal(restoredActor.room.events.at(-1).payload.timedOut, true);
  scheduler.close();
  await restartedRegistry.close();
  await firstRegistry.close();
});

test('WSS broadcasts an explicit timeout action to all room subscribers', async () => {
  const authService = new AuthService();
  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: '8787',
    WS_RECONNECT_GRACE_MS: '1000'
  });
  const app = createRealtimeServer({ config, authService, port: 0, host: '127.0.0.1' });
  await once(app.wss, 'listening');
  const address = app.wss.address();
  const url = `ws://127.0.0.1:${address.port}`;
  const owner = await openClient(url);
  const guest = await openClient(url);
  try {
    const loginOwner = createCommand('login', { playerId: 'deadline-owner', deviceId: 'deadline-owner-device', platform: 'android' });
    await sendAndWait(owner, loginOwner, 'login_ok');
    const loginGuest = createCommand('login', { playerId: 'deadline-guest', deviceId: 'deadline-guest-device', platform: 'android' });
    await sendAndWait(guest, loginGuest, 'login_ok');

    const created = await sendAndWait(owner, createCommand('create_room', {
      maxPlayers: 2,
      ruleSnapshot: {
        gameType: 'mahjong',
        ruleId: 'fake',
        ruleVersion: 'fake-deadline',
        deadlinePolicy: {
          enabled: true,
          actionDeadlineMs: 20,
          timeoutAction: 'pass'
        },
        config: { mode: 'sandbox' }
      }
    }), 'room_created');
    const roomId = created.roomId;
    await sendAndWait(owner, createCommand('join_room', { name: '房主' }, { roomId }), 'room_event');
    await sendAndWait(guest, createCommand('join_room', { name: '来宾' }, { roomId }), 'room_event');

    const timeoutEvent = waitForMessage(guest, message => (
      message.type === 'room_event'
      && message.payload?.latest?.payload?.timedOut === true
    ), 2000);
    await sendAndWait(owner, createCommand('start_round', {}, { roomId }), 'command_ack');
    const event = await timeoutEvent;
    assert.equal(event.payload.latest.type, 'ACTION_APPLIED');
    assert.equal(event.payload.latest.payload.timeoutAction, 'pass');
    assert.equal(event.payload.latest.payload.playerId, 'deadline-owner');
    assert.equal(event.roomVersion, 4);
    assert.equal(app.rooms.get(roomId).turn, 'deadline-guest');
  } finally {
    await closeClient(owner);
    await closeClient(guest);
    await app.close();
  }
});
