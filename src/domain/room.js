import { createHash, randomInt, randomUUID } from 'node:crypto';
import { AppError } from '../shared/errors.js';
import {
  createSusongFlowerState,
  evaluateSusongWin,
  flowerUnitsForMeld,
  recordSusongFlowerDraw,
  recordSusongMeldFlowers,
  resolveSusongFlowers
} from './rules/susong.js';
import { scoreSusongRound } from './rules/susong-scoring.js';
import {
  buildSusongTileSet,
  createSusongShuffledWall,
  dealSusongOpeningHands,
  drawSusongLiveTile,
  drawSusongReplacementTile,
  getSusongDiscardReactionCandidates,
  getSusongTurnKongCandidates,
  getSusongWinningHand,
  isSusongReplacementFlower,
  publicSusongWallState,
  susongTileFace,
  verifySusongSeedCommitment
} from './rules/susong-wall.js';

/**
 * Room is the framework-neutral aggregate used by the development server and
 * by the future persistent room actor. It owns lifecycle and ordering only.
 * A rule adapter may validate actions or produce a settlement payload, but
 * this aggregate never guesses a game's scoring rules.
 */

export const ROOM_STATUS = Object.freeze({
  WAITING: 'waiting',
  READY: 'ready',
  DEALING: 'dealing',
  PLAYING: 'playing',
  SETTLING: 'settling',
  NEXT_ROUND: 'next_round',
  FINISHED: 'finished',
  CANCELLED: 'cancelled'
});

// Upper-case labels are useful at adapter boundaries where the protocol uses
// enum-like values. The aggregate's wire-compatible status remains lower-case.
export const ROOM_PHASE = Object.freeze({
  WAITING: ROOM_STATUS.WAITING,
  READY: ROOM_STATUS.READY,
  DEALING: ROOM_STATUS.DEALING,
  PLAYING: ROOM_STATUS.PLAYING,
  SETTLING: ROOM_STATUS.SETTLING,
  NEXT_ROUND: ROOM_STATUS.NEXT_ROUND,
  FINISHED: ROOM_STATUS.FINISHED,
  CANCELLED: ROOM_STATUS.CANCELLED
});

export const ROOM_ACCESS_POLICY = Object.freeze({
  MEMBERS_ONLY: 'MEMBERS_ONLY',
  INVITE_ONLY: 'INVITE_ONLY',
  PUBLIC_CODE: 'PUBLIC_CODE'
});

const JOINABLE_STATES = new Set([ROOM_STATUS.WAITING]);
const READY_STATES = new Set([ROOM_STATUS.WAITING, ROOM_STATUS.READY]);
const STARTABLE_STATES = new Set([ROOM_STATUS.WAITING, ROOM_STATUS.READY]);
const ZENG_STATES = new Set([
  ROOM_STATUS.WAITING,
  ROOM_STATUS.READY,
  ROOM_STATUS.DEALING,
  ROOM_STATUS.PLAYING,
  ROOM_STATUS.SETTLING,
  ROOM_STATUS.NEXT_ROUND
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (value === undefined || value === null) return value;
  return structuredClone(value);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function publicClone(value) {
  return clone(value);
}

function normalizeId(value, field = 'id', { required = true, max = 128 } = {}) {
  if (value === undefined || value === null) {
    if (!required) return null;
    throw new AppError('INVALID_ACTION', { details: [{ path: field, message: 'is required' }] });
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new AppError('INVALID_ACTION', { details: [{ path: field, message: 'must be a string' }] });
  }
  const normalized = String(value).trim();
  if (!normalized && required) {
    throw new AppError('INVALID_ACTION', { details: [{ path: field, message: 'must not be blank' }] });
  }
  if (!normalized && !required) return null;
  if (normalized.length > max) {
    throw new AppError('INVALID_ACTION', { details: [{ path: field, message: `must be <= ${max} characters` }] });
  }
  return normalized;
}

function normalizeName(value, fallback) {
  const name = value === undefined || value === null ? fallback : String(value).trim();
  if (!name) return fallback;
  return name.slice(0, 64);
}

function normalizeOptions(options) {
  if (typeof options === 'string') return { commandId: options };
  return isRecord(options) ? options : {};
}

function serverSettlementDeltas(settlement, players, command) {
  if (!isRecord(settlement) || settlement.scoreAuthority !== 'server') return null;
  if (command.actorRole !== 'SYSTEM') {
    throw new AppError('INVALID_ACTION', {
      details: [{ path: 'settlement.scoreAuthority', message: 'requires SYSTEM actorRole' }]
    });
  }
  const playerIds = [...players.keys()];
  const raw = settlement.deltaByPlayer;
  if (!isRecord(raw) || Object.keys(raw).length !== playerIds.length
    || Object.keys(raw).some(playerId => !players.has(playerId))) {
    throw new AppError('INVALID_ACTION', {
      details: [{ path: 'settlement.deltaByPlayer', message: 'must contain every seated player exactly once' }]
    });
  }
  const deltas = {};
  for (const playerId of playerIds) {
    const value = raw[playerId];
    if (!Number.isSafeInteger(value)) {
      throw new AppError('INVALID_ACTION', {
        details: [{ path: `settlement.deltaByPlayer.${playerId}`, message: 'must be a safe integer' }]
      });
    }
    deltas[playerId] = value;
  }
  if (Object.values(deltas).reduce((sum, value) => sum + value, 0) !== 0) {
    throw new AppError('INVALID_ACTION', {
      details: [{ path: 'settlement.deltaByPlayer', message: 'must be zero-sum' }]
    });
  }
  if (!Array.isArray(settlement.transfers)) {
    throw new AppError('INVALID_ACTION', {
      details: [{ path: 'settlement.transfers', message: 'must be an array' }]
    });
  }
  const reconstructed = Object.fromEntries(playerIds.map(playerId => [playerId, 0]));
  for (const [index, transfer] of settlement.transfers.entries()) {
    if (!isRecord(transfer) || !players.has(transfer.from) || !players.has(transfer.to)
      || transfer.from === transfer.to || !Number.isSafeInteger(transfer.amount) || transfer.amount <= 0) {
      throw new AppError('INVALID_ACTION', {
        details: [{ path: `settlement.transfers.${index}`, message: 'contains an invalid transfer' }]
      });
    }
    reconstructed[transfer.from] -= transfer.amount;
    reconstructed[transfer.to] += transfer.amount;
  }
  if (playerIds.some(playerId => reconstructed[playerId] !== deltas[playerId])) {
    throw new AppError('INVALID_ACTION', {
      details: [{ path: 'settlement.transfers', message: 'does not reconcile with deltaByPlayer' }]
    });
  }
  return deltas;
}

function normalizeDeadlinePolicy(policy) {
  if (policy === undefined || policy === null) {
    return deepFreeze({
      enabled: false,
      actionDeadlineMs: null,
      timeoutAction: null
    });
  }
  if (!isRecord(policy)) throw new AppError('INVALID_ACTION', {
    details: [{ path: 'deadlinePolicy', message: 'must be an object' }]
  });
  const rawMs = policy.actionDeadlineMs ?? policy.turnDeadlineMs ?? policy.turnTimeoutMs;
  const actionDeadlineMs = rawMs === undefined || rawMs === null || rawMs === ''
    ? null : Number(rawMs);
  if (actionDeadlineMs !== null
    && (!Number.isSafeInteger(actionDeadlineMs) || actionDeadlineMs < 1 || actionDeadlineMs > 86_400_000)) {
    throw new AppError('INVALID_ACTION', {
      details: [{ path: 'deadlinePolicy.actionDeadlineMs', message: 'must be an integer between 1 and 86400000' }]
    });
  }
  const rawTimeoutAction = policy.timeoutAction ?? policy.defaultAction ?? null;
  let timeoutAction = rawTimeoutAction;
  if (isRecord(rawTimeoutAction)) {
    const actionName = rawTimeoutAction.action ?? rawTimeoutAction.name;
    timeoutAction = {
      action: actionName,
      ...(rawTimeoutAction.args === undefined ? {} : { args: clone(rawTimeoutAction.args) })
    };
  }
  const actionName = typeof timeoutAction === 'string' ? timeoutAction : timeoutAction?.action;
  if (timeoutAction !== null && (typeof actionName !== 'string'
    || actionName.trim().length < 1 || actionName.trim().length > 64)) {
    throw new AppError('INVALID_ACTION', {
      details: [{ path: 'deadlinePolicy.timeoutAction', message: 'must be a non-empty string of at most 64 characters' }]
    });
  }
  const normalized = {
    enabled: policy.enabled === true && actionDeadlineMs !== null && timeoutAction !== null,
    actionDeadlineMs,
    timeoutAction: timeoutAction === null
      ? null
      : (typeof timeoutAction === 'string'
        ? timeoutAction.trim()
        : { ...timeoutAction, action: timeoutAction.action.trim() })
  };
  return deepFreeze(normalized);
}

function canonical(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return JSON.stringify(String(value));
    return JSON.stringify(value);
  }
  if (seen.has(value)) throw new TypeError('cyclic command input');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = `[${value.map(item => canonical(item, seen)).join(',')}]`;
  } else {
    result = `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], seen)}`).join(',')}}`;
  }
  seen.delete(value);
  return result;
}

function hash(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function iso(clock) {
  const value = new Date(clock());
  if (Number.isNaN(value.getTime())) throw new AppError('INTERNAL_ERROR', { message: 'Room clock returned an invalid time' });
  return value.toISOString();
}

function normalizeAccessPolicy(policy, clubId) {
  if (policy === undefined || policy === null || policy === '') {
    return clubId ? ROOM_ACCESS_POLICY.MEMBERS_ONLY : ROOM_ACCESS_POLICY.PUBLIC_CODE;
  }
  const normalized = String(policy).toUpperCase();
  if (!Object.values(ROOM_ACCESS_POLICY).includes(normalized)) {
    throw new AppError('INVALID_ACTION', { details: [{ path: 'accessPolicy', message: 'is invalid' }] });
  }
  return normalized;
}

function statusError(status, fallback = 'ROOM_NOT_JOINABLE') {
  if (status === ROOM_STATUS.FINISHED) return new AppError('ROUND_FINISHED');
  if (status === ROOM_STATUS.CANCELLED) return new AppError('ROOM_NOT_JOINABLE');
  return new AppError(fallback);
}

function actionInput(action) {
  if (typeof action === 'string') return { name: action, args: undefined };
  if (!isRecord(action)) throw new AppError('INVALID_ACTION');
  const name = action.action || action.type || action.name;
  if (typeof name !== 'string') throw new AppError('INVALID_ACTION');
  return { name, args: action.args === undefined ? undefined : clone(action.args) };
}

export class Room {
  constructor({
    id,
    roomId,
    clubId = null,
    floorId = null,
    rule = 'susong_v1',
    ruleId,
    ruleVersion,
    gameType = 'mahjong',
    ruleConfig,
    ruleSnapshot,
    maxPlayers = 4,
    ownerId = null,
    accessPolicy,
    roomAccessPolicy,
    matchId,
    totalRounds,
    roundCount,
    deadlinePolicy,
    historyLimit = 2048,
    clock = () => Date.now(),
    idFactory = randomUUID,
    validateAction
  } = {}) {
    this.id = normalizeId(roomId || id, 'id', { max: 64 });
    this.roomId = this.id;
    this.clubId = clubId === null || clubId === undefined ? null : normalizeId(clubId, 'clubId', { required: false, max: 64 });
    this.floorId = floorId === null || floorId === undefined ? null : normalizeId(floorId, 'floorId', { required: false, max: 64 });
    this.maxPlayers = Number(maxPlayers);
    if (!Number.isInteger(this.maxPlayers) || this.maxPlayers < 2 || this.maxPlayers > 16) {
      throw new AppError('INVALID_ACTION', { details: [{ path: 'maxPlayers', message: 'must be an integer between 2 and 16' }] });
    }
    if (typeof clock !== 'function' || typeof idFactory !== 'function') {
      throw new TypeError('Room clock and idFactory must be functions');
    }
    if (!Number.isFinite(historyLimit) || historyLimit < 1) {
      throw new AppError('INVALID_ACTION', { details: [{ path: 'historyLimit', message: 'must be positive' }] });
    }

    this.clock = clock;
    this.idFactory = idFactory;
    this.historyLimit = Math.floor(historyLimit);
    this.validateAction = typeof validateAction === 'function' ? validateAction : null;
    this.ownerId = ownerId === null || ownerId === undefined ? null : normalizeId(ownerId, 'ownerId');
    this.accessPolicy = normalizeAccessPolicy(roomAccessPolicy || accessPolicy, this.clubId);

    const fallbackRuleVersion = ruleVersion || rule || 'unknown';
    const snapshot = ruleSnapshot === undefined ? {
      gameType,
      ruleId: ruleId || fallbackRuleVersion,
      ruleVersion: fallbackRuleVersion,
      config: ruleConfig === undefined ? {} : clone(ruleConfig)
    } : clone(ruleSnapshot);
    if (!isRecord(snapshot)) {
      throw new AppError('INVALID_ACTION', { details: [{ path: 'ruleSnapshot', message: 'must be an object' }] });
    }
    if (snapshot.gameType === undefined) snapshot.gameType = gameType;
    if (snapshot.ruleId === undefined) snapshot.ruleId = ruleId || fallbackRuleVersion;
    if (snapshot.ruleVersion === undefined) snapshot.ruleVersion = fallbackRuleVersion;
    const configuredDeadlinePolicy = deadlinePolicy
      ?? snapshot.deadlinePolicy
      ?? snapshot.config?.deadlinePolicy;
    this.deadlinePolicy = normalizeDeadlinePolicy(configuredDeadlinePolicy);
    if (snapshot.deadlinePolicy === undefined && configuredDeadlinePolicy !== undefined) {
      snapshot.deadlinePolicy = clone(this.deadlinePolicy);
    }
    this.ruleSnapshot = deepFreeze(snapshot);
    this.ruleSnapshotHash = hash(snapshot);
    // Kept as aliases for the first skeleton and for simple adapters.
    this.rule = String(this.ruleSnapshot.ruleVersion || fallbackRuleVersion);
    this.ruleId = String(this.ruleSnapshot.ruleId || this.rule);
    this.ruleVersion = String(this.ruleSnapshot.ruleVersion || this.rule);
    this.gameType = String(this.ruleSnapshot.gameType || gameType);

    this.matchId = normalizeId(matchId || this.idFactory(), 'matchId', { max: 128 });
    this.totalRounds = totalRounds ?? roundCount ?? null;
    if (this.totalRounds !== null && (!Number.isInteger(this.totalRounds) || this.totalRounds < 1)) {
      throw new AppError('INVALID_ACTION', { details: [{ path: 'totalRounds', message: 'must be a positive integer or null' }] });
    }

    this.status = ROOM_STATUS.WAITING;
    this.state = this.status;
    this.version = 0;
    this.roomVersion = 0;
    this.players = new Map();
    this.seats = Array.from({ length: this.maxPlayers }, () => null);
    this.scores = new Map();
    this.zengByPlayer = new Map();
    this.turn = null;
    this.turnPlayerId = null;
    this.currentRound = null;
    this.round = null;
    this._privateRoundState = null;
    this.roundNumber = 0;
    this.roundId = null;
    this.match = {
      id: this.matchId,
      matchId: this.matchId,
      status: this.status,
      roundNumber: 0,
      totalRounds: this.totalRounds
    };
    this._events = [];
    this._commands = new Map();
  }

  get events() {
    return Object.freeze(this._events.slice());
  }

  get eventHistory() {
    return this.events;
  }

  get owner() {
    return this.ownerId;
  }

  get readyCount() {
    return [...this.players.values()].filter(player => player.ready).length;
  }

  get connectedCount() {
    return [...this.players.values()].filter(player => player.connected).length;
  }

  _assertExpectedVersion(expectedRoomVersion) {
    if (expectedRoomVersion === undefined || expectedRoomVersion === null) return;
    if (!Number.isInteger(expectedRoomVersion) || expectedRoomVersion < 0 || expectedRoomVersion !== this.version) {
      throw new AppError('VERSION_CONFLICT', {
        details: [{ expectedRoomVersion, actualRoomVersion: this.version }]
      });
    }
  }

  _withCommand(options, fingerprint, operation) {
    const opts = normalizeOptions(options);
    const commandId = opts.commandId === undefined || opts.commandId === null
      ? null
      : normalizeId(opts.commandId, 'commandId', { max: 256 });
    const commandFingerprint = canonical(fingerprint);
    if (commandId) {
      const previous = this._commands.get(commandId);
      if (previous) {
        if (previous.fingerprint !== commandFingerprint) {
          throw new AppError('DUPLICATE_REQUEST', {
            details: [{ commandId, reason: 'commandId was already used with another request' }]
          });
        }
        return publicClone(previous.result);
      }
    }
    this._assertExpectedVersion(opts.expectedRoomVersion ?? opts.roomVersion);
    const result = operation(opts);
    if (commandId) this._commands.set(commandId, {
      fingerprint: commandFingerprint,
      result: publicClone(result),
      roomVersion: this.version
    });
    return publicClone(result);
  }

  _assertState(states, fallback = 'ROOM_NOT_JOINABLE') {
    if (!states.has(this.status)) throw statusError(this.status, fallback);
  }

  _assertOwner(actorId, options = {}) {
    if (options.isAdmin || options.admin || options.role === 'admin' || options.role === 'ADMIN'
      || options.actorRole === 'ADMIN' || options.actorRole === 'admin'
      || options.actorRole === 'CLUB_ADMIN' || options.actorRole === 'club_admin') return;
    const actor = normalizeId(actorId, 'actorId', { required: false });
    if (!actor || !this.ownerId || actor !== this.ownerId) throw new AppError('NOT_ROOM_OWNER');
  }

  _assertAccess(playerId, options = {}) {
    const actor = normalizeId(playerId, 'playerId');
    // A room created without a preassigned owner must allow its first player
    // to claim the owner seat even when the room's eventual access policy is
    // MEMBERS_ONLY/INVITE_ONLY. Subsequent joins still require evidence.
    if ((this.ownerId === null && this.players.size === 0)
      || actor === this.ownerId || options.bypassAccess || options.isAdmin || options.admin) return;
    if (this.accessPolicy === ROOM_ACCESS_POLICY.MEMBERS_ONLY) {
      const resolvedMembership = typeof options.membershipResolver === 'function'
        ? options.membershipResolver(actor, this.clubId)
        : options.isMember;
      const approved = options.membershipApproved === true
        || options.isMember === true
        || resolvedMembership === true
        || options.member === true
        || options.clubMember === true;
      if (!approved) throw new AppError('CLUB_MEMBERSHIP_REQUIRED');
    }
    if (this.accessPolicy === ROOM_ACCESS_POLICY.INVITE_ONLY) {
      if (!(options.invited === true || options.invitation === true || options.inviteToken)) {
        throw new AppError('FORBIDDEN');
      }
    }
  }

  _findSeat(seat) {
    if (seat === undefined || seat === null) return this.seats.findIndex(value => value === null);
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.maxPlayers) throw new AppError('SEAT_OCCUPIED');
    return this.seats[seat] === null ? seat : -1;
  }

  _orderedPlayers() {
    return [...this.players.values()].sort((left, right) => left.seat - right.seat);
  }

  _allReady() {
    return this.players.size === this.maxPlayers && this.readyCount === this.maxPlayers;
  }

  _setStatus(status) {
    this.status = status;
    this.state = status;
    this.match.status = status;
  }

  _append(type, payload = {}, options = {}) {
    const occurredAt = iso(this.clock);
    const version = this.version + 1;
    const event = {
      eventId: this.idFactory(),
      roomId: this.id,
      ...(payload?.matchId ? { matchId: payload.matchId } : {}),
      ...(payload?.roundId ? { roundId: payload.roundId } : {}),
      type,
      version,
      roomVersion: version,
      ...(options.requestId ? { requestId: String(options.requestId) } : {}),
      ...(options.commandId ? { commandId: String(options.commandId) } : {}),
      payload: clone(payload),
      occurredAt,
      // `at` is retained for the original development fixture.
      at: occurredAt
    };
    this.version = version;
    this.roomVersion = version;
    this._events.push(deepFreeze(event));
    while (this._events.length > this.historyLimit) this._events.shift();
    return this._events.at(-1);
  }

  /** Append a domain event. BE-202 will route this through a durable store. */
  append(type, payload = {}, metadata = {}) {
    if (typeof type !== 'string' || !type.trim()) throw new AppError('INVALID_ACTION');
    return this._append(type.trim(), payload, metadata);
  }

  _result(event, extra = {}) {
    return {
      accepted: true,
      event: event ? publicClone(event) : null,
      ...(event?.requestId ? { requestId: event.requestId } : {}),
      ...(event?.commandId ? { commandId: event.commandId } : {}),
      roomVersion: this.version,
      version: this.version,
      snapshot: this.snapshot(),
      ...extra
    };
  }

  join(player = {}, options = {}) {
    if (typeof player === 'string' || typeof player === 'number') player = { id: player };
    if (!isRecord(player)) throw new AppError('INVALID_ACTION');
    const opts = normalizeOptions(options);
    const playerId = normalizeId(player.id ?? player.userId ?? player.playerId, 'playerId');
    const name = normalizeName(player.name ?? player.displayName, `玩家${playerId.slice(0, 6)}`);
    const requestedSeat = player.seat ?? opts.seat;
    const fingerprint = { op: 'join', playerId, name, seat: requestedSeat ?? null };
    return this._withCommand(opts, fingerprint, command => {
      this._assertState(JOINABLE_STATES, 'ROOM_NOT_JOINABLE');
      this._assertAccess(playerId, command);
      if (this.players.has(playerId)) throw new AppError('DUPLICATE_REQUEST', {
        details: [{ playerId, reason: 'player is already seated' }]
      });
      if (this.players.size >= this.maxPlayers) throw new AppError('ROOM_FULL');
      const seat = this._findSeat(requestedSeat);
      if (seat < 0) throw new AppError('SEAT_OCCUPIED');
      if (this.ownerId === null) this.ownerId = playerId;
      const joinedAt = iso(this.clock);
      const record = {
        id: playerId,
        playerId,
        name,
        displayName: name,
        seat,
        ready: false,
        connected: true,
        joinedAt,
        disconnectedAt: null
      };
      this.players.set(playerId, record);
      this.seats[seat] = playerId;
      this.scores.set(playerId, 0);
      this.zengByPlayer.set(playerId, 0);
      const event = this._append('PLAYER_JOINED', {
        player: this._publicPlayer(record),
        ownerId: this.ownerId,
        seat
      }, command);
      return this._result(event, { player: this._publicPlayer(record) });
    });
  }

  _publicPlayer(player) {
    return {
      id: player.id,
      playerId: player.playerId,
      name: player.name,
      displayName: player.displayName,
      seat: player.seat,
      ready: Boolean(player.ready),
      connected: Boolean(player.connected),
      ...(player.joinedAt ? { joinedAt: player.joinedAt } : {}),
      ...(player.disconnectedAt ? { disconnectedAt: player.disconnectedAt } : {})
    };
  }

  leave(playerId, options = {}) {
    const opts = normalizeOptions(options);
    const id = normalizeId(playerId, 'playerId');
    const requestedTransfer = opts.transferOwnerTo ?? null;
    return this._withCommand(opts, {
      op: 'leave',
      playerId: id,
      transferOwnerTo: requestedTransfer
    }, command => {
      this._assertState(READY_STATES, 'ROOM_NOT_JOINABLE');
      const player = this.players.get(id);
      if (!player) throw new AppError('PLAYER_NOT_FOUND');
      if (id === this.ownerId && this.players.size > 1 && !command.transferOwnerTo) {
        throw new AppError('FORBIDDEN', { details: [{ reason: 'owner must transfer ownership or disband' }] });
      }
      // Validate the successor before mutating any aggregate collection. A
      // failed ownership transfer must leave the room exactly as it was.
      let successor = null;
      if (id === this.ownerId) {
        successor = command.transferOwnerTo
          ? normalizeId(command.transferOwnerTo, 'transferOwnerTo')
          : this._orderedPlayers().find(candidate => candidate.id !== id)?.id || null;
        if (successor && !this.players.has(successor)) throw new AppError('PLAYER_NOT_FOUND');
        if (successor === id) throw new AppError('INVALID_ACTION');
      }
      this.players.delete(id);
      this.seats[player.seat] = null;
      this.scores.delete(id);
      this.zengByPlayer.delete(id);
      if (id === this.ownerId) {
        this.ownerId = successor;
      }
      if (this.status === ROOM_STATUS.READY) this._setStatus(ROOM_STATUS.WAITING);
      const event = this._append('PLAYER_LEFT', { playerId: id, ownerId: this.ownerId }, command);
      return this._result(event, { playerId: id });
    });
  }

  setReady(playerId, ready = true, options = {}) {
    if (isRecord(ready)) {
      const command = ready;
      playerId = command.playerId ?? command.userId ?? command.actorId ?? playerId;
      options = { ...command, ...normalizeOptions(options) };
      ready = command.ready ?? true;
    }
    const opts = normalizeOptions(options);
    const id = normalizeId(playerId, 'playerId');
    if (typeof ready !== 'boolean') throw new AppError('INVALID_ACTION');
    return this._withCommand(opts, { op: 'ready', playerId: id, ready }, command => {
      this._assertState(READY_STATES, 'ROOM_NOT_JOINABLE');
      const player = this.players.get(id);
      if (!player) throw new AppError('PLAYER_NOT_FOUND');
      player.ready = ready;
      if (this._allReady()) this._setStatus(ROOM_STATUS.READY);
      else if (this.status === ROOM_STATUS.READY) this._setStatus(ROOM_STATUS.WAITING);
      const event = this._append('PLAYER_READY', {
        playerId: id,
        ready,
        readyCount: this.readyCount,
        requiredReady: this.maxPlayers,
        status: this.status
      }, command);
      return this._result(event, { playerId: id, ready });
    });
  }

  ready(playerId, ready = true, options = {}) {
    return this.setReady(playerId, ready, options);
  }

  markReady(playerId, ready = true, options = {}) {
    return this.setReady(playerId, ready, options);
  }

  increaseZeng(playerId, options = {}) {
    if (isRecord(playerId)) {
      options = { ...playerId, ...normalizeOptions(options) };
      playerId = options.playerId ?? options.userId ?? options.actorId;
    }
    const opts = normalizeOptions(options);
    const id = normalizeId(playerId, 'playerId');
    return this._withCommand(opts, { op: 'increase_zeng', playerId: id }, command => {
      if (!ZENG_STATES.has(this.status)) throw new AppError('ROUND_FINISHED');
      if (this.ruleId !== 'susong_v1') throw new AppError('INVALID_ACTION');
      if ((this.ruleSnapshot.config?.zeng ?? 0) === 0) throw new AppError('INVALID_ACTION');
      if (!this.players.has(id)) throw new AppError('PLAYER_NOT_FOUND');
      const actorId = command.actorId ?? id;
      if (actorId !== id && command.actorRole !== 'SYSTEM') throw new AppError('FORBIDDEN');
      const previous = this.zengByPlayer.get(id) || 0;
      if (!Number.isSafeInteger(previous) || previous < 0 || previous === Number.MAX_SAFE_INTEGER) {
        throw new AppError('INVALID_ACTION');
      }
      const current = previous + 1;
      this.zengByPlayer.set(id, current);
      const event = this._append('PLAYER_ZENG_INCREASED', {
        playerId: id,
        previous,
        current,
        unit: this.ruleSnapshot.config.zeng
      }, command);
      return this._result(event, { playerId: id, previous, current });
    });
  }

  _newRound(number, status, options = {}) {
    const roundId = normalizeId(options.roundId || this.idFactory(), 'roundId', { max: 128 });
    const round = {
      id: roundId,
      roundId,
      number,
      roundNumber: number,
      status,
      dealerSeat: options.dealerSeat === undefined ? null : options.dealerSeat,
      ruleSnapshotHash: this.ruleSnapshotHash,
      wall: null,
      turnPhase: null,
      discardsByPlayer: null,
      meldsByPlayer: null,
      pendingReaction: null,
      flowerStates: null,
      settlement: null,
      startedAt: null,
      endedAt: null,
      turnStartedAt: null,
      turnDeadlineAt: null
    };
    this.currentRound = round;
    this.round = round;
    this._privateRoundState = null;
    this.roundNumber = number;
    this.roundId = roundId;
    this.match.roundNumber = number;
    return round;
  }

  _firstTurn() {
    if (Number.isInteger(this.currentRound?.dealerSeat)) {
      const dealer = this._orderedPlayers().find(player => player.seat === this.currentRound.dealerSeat);
      if (dealer) return dealer.id;
    }
    return this._orderedPlayers()[0]?.id || null;
  }

  dealSusongOpeningRound(input = {}, options = {}) {
    if (!isRecord(input)) throw new AppError('INVALID_ACTION');
    const opts = normalizeOptions(options);
    const requestedDealerSeat = input.dealerSeat ?? null;
    const requestedSeed = input.seed ?? null;
    return this._withCommand(opts, {
      op: 'deal_susong_round',
      dealerSeat: requestedDealerSeat,
      seed: requestedSeed
    }, command => {
      if (command.actorRole !== 'SYSTEM') throw new AppError('FORBIDDEN');
      if (this.ruleId !== 'susong_v1' || this.status !== ROOM_STATUS.DEALING || !this.currentRound) {
        throw new AppError('INVALID_ACTION');
      }
      if (this._privateRoundState || this.currentRound.wall) throw new AppError('DUPLICATE_REQUEST');
      const players = this._orderedPlayers();
      if (players.length !== 4) throw new AppError('PLAYERS_NOT_READY');
      const dealerSeat = requestedDealerSeat === null ? randomInt(this.maxPlayers) : requestedDealerSeat;
      if (!Number.isInteger(dealerSeat) || dealerSeat < 0 || dealerSeat >= this.maxPlayers) {
        throw new AppError('INVALID_ACTION', {
          details: [{ path: 'dealerSeat', message: 'must identify one of the four seats' }]
        });
      }
      const dealer = players.find(player => player.seat === dealerSeat);
      if (!dealer) throw new AppError('INVALID_ACTION');
      let wall;
      let dealt;
      try {
        wall = createSusongShuffledWall(requestedSeed === null ? {} : { seed: requestedSeed });
        dealt = dealSusongOpeningHands({
          wall,
          playerIds: players.map(player => player.id),
          dealerId: dealer.id
        });
      } catch (cause) {
        throw new AppError('INVALID_ACTION', { cause });
      }
      const openingFlowerCountByPlayer = Object.fromEntries(players.map(player => [
        player.id,
        dealt.handsByPlayer[player.id].filter(isSusongReplacementFlower).length
      ]));
      const flowerStates = Object.fromEntries(players.map(player => [
        player.id,
        createSusongFlowerState({
          piaoMode: this.ruleSnapshot.config?.piao,
          initialFlowerCount: openingFlowerCountByPlayer[player.id]
        })
      ]));
      const publicWall = clone(publicSusongWallState(dealt));
      let privateRoundState = clone({
        roundId: this.roundId,
        privateSeedHex: wall.privateSeedHex,
        wallVersion: dealt.wallVersion,
        shuffleAlgorithm: dealt.shuffleAlgorithm,
        dealAlgorithm: dealt.dealAlgorithm,
        replacementDrawPolicy: dealt.replacementDrawPolicy,
        seedCommitment: dealt.seedCommitment,
        handsByPlayer: dealt.handsByPlayer,
        remainingWall: dealt.remainingWall,
        resolvedFlowerTilesByPlayer: Object.fromEntries(players.map(player => [player.id, []])),
        replacementHistory: [],
        turnHistory: [],
        nextPrivateOperationSequence: 1
      });
      const openingReplacementCountByPlayer = Object.fromEntries(players.map(player => [player.id, 0]));
      for (const player of players) {
        if (flowerStates[player.id].status !== 'not_piao'
          || flowerStates[player.id].pendingFlowerReplacements === 0) continue;
        const replacement = resolvePrivateSusongFlowers({
          privateState: privateRoundState,
          playerId: player.id,
          action: 'replace',
          flowerState: flowerStates[player.id]
        });
        privateRoundState = replacement.privateState;
        flowerStates[player.id] = replacement.flowerState;
        openingReplacementCountByPlayer[player.id] = replacement.resolvedCount;
        publicWall.wallRemaining = replacement.wallRemaining;
      }
      this.currentRound.dealerSeat = dealerSeat;
      this.currentRound.wall = clone(publicWall);
      this.currentRound.flowerStates = clone(flowerStates);
      this._privateRoundState = privateRoundState;
      const event = this._append('SUSONG_ROUND_DEALT', {
        matchId: this.matchId,
        roundId: this.roundId,
        roundNumber: this.roundNumber,
        dealerId: dealer.id,
        dealerSeat,
        wall: clone(publicWall),
        openingReplacementCountByPlayer,
        flowerStates: clone(flowerStates)
      }, command);
      return this._result(event, {
        dealerId: dealer.id,
        dealerSeat,
        wall: clone(publicWall),
        openingReplacementCountByPlayer,
        flowerStates: clone(flowerStates)
      });
    });
  }

  initializeSusongFlowers(openingFlowerCountByPlayer, options = {}) {
    const opts = normalizeOptions(options);
    return this._withCommand(opts, {
      op: 'initialize_susong_flowers',
      openingFlowerCountByPlayer
    }, command => {
      if (command.actorRole !== 'SYSTEM') throw new AppError('FORBIDDEN');
      if (this.ruleId !== 'susong_v1' || this.status !== ROOM_STATUS.DEALING || !this.currentRound) {
        throw new AppError('INVALID_ACTION');
      }
      if (this.currentRound.flowerStates) throw new AppError('DUPLICATE_REQUEST');
      if (!isRecord(openingFlowerCountByPlayer)
        || Object.keys(openingFlowerCountByPlayer).length !== this.players.size) {
        throw new AppError('INVALID_ACTION');
      }
      const flowerStates = {};
      try {
        for (const playerId of this.players.keys()) {
          if (!(playerId in openingFlowerCountByPlayer)) throw new TypeError('missing player');
          flowerStates[playerId] = createSusongFlowerState({
            piaoMode: this.ruleSnapshot.config?.piao,
            initialFlowerCount: openingFlowerCountByPlayer[playerId]
          });
        }
      } catch (cause) {
        throw new AppError('INVALID_ACTION', { cause });
      }
      this.currentRound.flowerStates = clone(flowerStates);
      const event = this._append('SUSONG_FLOWERS_INITIALIZED', {
        roundId: this.roundId,
        flowerStates: clone(flowerStates)
      }, command);
      return this._result(event, { flowerStates: clone(flowerStates) });
    });
  }

  chooseSusongPiao(playerId, choosesPiao, options = {}) {
    const opts = normalizeOptions(options);
    const id = normalizeId(playerId, 'playerId');
    if (typeof choosesPiao !== 'boolean') throw new AppError('INVALID_ACTION');
    return this._withCommand(opts, { op: 'choose_piao', playerId: id, choosesPiao }, command => {
      const actorId = command.actorId ?? id;
      if (actorId !== id && command.actorRole !== 'SYSTEM') throw new AppError('FORBIDDEN');
      const current = this.currentRound?.flowerStates?.[id];
      if (!current || current.status !== 'awaiting_piao_choice') throw new AppError('INVALID_ACTION');
      let next;
      let privateResolution = null;
      try {
        next = createSusongFlowerState({
          piaoMode: current.mode,
          initialFlowerCount: current.openingFlowers,
          choosesPiao
        });
        if (!choosesPiao && next.pendingFlowerReplacements > 0
          && this._privateRoundState?.roundId === this.roundId) {
          privateResolution = resolvePrivateSusongFlowers({
            privateState: this._privateRoundState,
            playerId: id,
            action: 'replace',
            flowerState: next
          });
          next = privateResolution.flowerState;
        }
      } catch (cause) {
        throw new AppError('INVALID_ACTION', { cause });
      }
      if (privateResolution) {
        this._privateRoundState = privateResolution.privateState;
        this.currentRound.wall.wallRemaining = privateResolution.wallRemaining;
        this.currentRound.wall.handCountsByPlayer[id] = privateResolution.handCount;
      }
      this.currentRound.flowerStates[id] = clone(next);
      const event = this._append('SUSONG_PIAO_CHOSEN', {
        roundId: this.roundId,
        playerId: id,
        choosesPiao,
        ...(privateResolution ? {
          resolvedCount: privateResolution.resolvedCount,
          additionalFlowerCount: privateResolution.additionalFlowerCount,
          handCount: privateResolution.handCount,
          wallRemaining: privateResolution.wallRemaining
        } : {}),
        flowerState: clone(next)
      }, command);
      return this._result(event, {
        playerId: id,
        flowerState: clone(next),
        ...(privateResolution ? {
          resolvedCount: privateResolution.resolvedCount,
          additionalFlowerCount: privateResolution.additionalFlowerCount,
          handCount: privateResolution.handCount,
          wallRemaining: privateResolution.wallRemaining
        } : {})
      });
    });
  }

  recordSusongFlowerDraw(playerId, count = 1, options = {}) {
    const opts = normalizeOptions(options);
    const id = normalizeId(playerId, 'playerId');
    return this._withCommand(opts, { op: 'record_susong_flower_draw', playerId: id, count }, command => {
      if (command.actorRole !== 'SYSTEM') throw new AppError('FORBIDDEN');
      if (this.status !== ROOM_STATUS.PLAYING) throw new AppError('ROUND_NOT_PLAYING');
      const current = this.currentRound?.flowerStates?.[id];
      if (!current) throw new AppError('INVALID_ACTION');
      let next;
      try {
        next = recordSusongFlowerDraw(current, count);
      } catch (cause) {
        throw new AppError('INVALID_ACTION', { cause });
      }
      this.currentRound.flowerStates[id] = clone(next);
      const event = this._append('SUSONG_FLOWER_DRAWN', {
        roundId: this.roundId,
        playerId: id,
        count,
        flowerState: clone(next)
      }, command);
      return this._result(event, { playerId: id, flowerState: clone(next) });
    });
  }

  resolveSusongFlower(playerId, action, options = {}) {
    const opts = normalizeOptions(options);
    const id = normalizeId(playerId, 'playerId');
    if (!['discard', 'replace'].includes(action)) throw new AppError('INVALID_ACTION');
    return this._withCommand(opts, { op: 'resolve_flower', playerId: id, action }, command => {
      const actorId = command.actorId ?? id;
      if (actorId !== id && command.actorRole !== 'SYSTEM') throw new AppError('FORBIDDEN');
      const current = this.currentRound?.flowerStates?.[id];
      if (!current) throw new AppError('INVALID_ACTION');
      let next;
      let privateResolution = null;
      try {
        if (this._privateRoundState?.roundId === this.roundId) {
          privateResolution = resolvePrivateSusongFlowers({
            privateState: this._privateRoundState,
            playerId: id,
            action,
            flowerState: current
          });
          next = privateResolution.flowerState;
        } else {
          next = resolveSusongFlowers(current, {
            discard: action === 'discard' ? 1 : 0,
            replace: action === 'replace' ? 1 : 0
          });
        }
      } catch (cause) {
        throw new AppError('INVALID_ACTION', { cause });
      }
      if (privateResolution) {
        this._privateRoundState = privateResolution.privateState;
        this.currentRound.wall.wallRemaining = privateResolution.wallRemaining;
        this.currentRound.wall.handCountsByPlayer[id] = privateResolution.handCount;
      }
      this.currentRound.flowerStates[id] = clone(next);
      const event = this._append('SUSONG_FLOWER_RESOLVED', {
        roundId: this.roundId,
        playerId: id,
        action,
        ...(privateResolution ? {
          resolvedCount: privateResolution.resolvedCount,
          additionalFlowerCount: privateResolution.additionalFlowerCount,
          handCount: privateResolution.handCount,
          wallRemaining: privateResolution.wallRemaining
        } : {}),
        flowerState: clone(next)
      }, command);
      return this._result(event, {
        playerId: id,
        flowerState: clone(next),
        ...(privateResolution ? {
          resolvedCount: privateResolution.resolvedCount,
          additionalFlowerCount: privateResolution.additionalFlowerCount,
          handCount: privateResolution.handCount,
          wallRemaining: privateResolution.wallRemaining
        } : {})
      });
    });
  }

  _setTurnDeadline() {
    if (!this.currentRound || this.status !== ROOM_STATUS.PLAYING || !this.turn
      || !this.deadlinePolicy.enabled) {
      if (this.currentRound) {
        this.currentRound.turnStartedAt = null;
        this.currentRound.turnDeadlineAt = null;
      }
      return null;
    }
    const now = this.clock();
    const nowMs = now instanceof Date
      ? now.getTime()
      : (typeof now === 'string' ? Date.parse(now) : Number(now));
    if (!Number.isFinite(nowMs)) throw new AppError('INTERNAL_ERROR', { message: 'Room clock returned an invalid time' });
    const startedAt = new Date(nowMs).toISOString();
    const deadlineAt = new Date(nowMs + this.deadlinePolicy.actionDeadlineMs).toISOString();
    this.currentRound.turnStartedAt = startedAt;
    this.currentRound.turnDeadlineAt = deadlineAt;
    return deadlineAt;
  }

  start(options = {}) {
    const legacyCall = arguments.length === 0;
    const opts = normalizeOptions(options);
    const actorId = opts.actorId ?? opts.playerId ?? opts.ownerId ?? this.ownerId;
    const autoAdvance = legacyCall || opts.autoAdvance === true || opts.immediate === true || opts.autoPlay === true;
    return this._withCommand(opts, { op: 'start', actorId: actorId || null, autoAdvance }, command => {
      this._assertState(STARTABLE_STATES, 'ROOM_NOT_JOINABLE');
      this._assertOwner(actorId, command);
      if (this.players.size !== this.maxPlayers) throw new AppError('PLAYERS_NOT_READY');
      if (!this._allReady() && !legacyCall && !command.bypassReady && !command.allowUnready) throw new AppError('PLAYERS_NOT_READY');
      if (legacyCall || command.bypassReady || command.allowUnready) {
        for (const player of this.players.values()) player.ready = true;
      }
      const round = this._newRound(1, ROOM_STATUS.DEALING, command);
      let phasePath = [ROOM_STATUS.DEALING];
      if (autoAdvance) {
        this._setStatus(ROOM_STATUS.PLAYING);
        round.status = ROOM_STATUS.PLAYING;
        round.startedAt = iso(this.clock);
        this.turn = this._firstTurn();
        this.turnPlayerId = this.turn;
        this._setTurnDeadline();
        phasePath = [ROOM_STATUS.DEALING, ROOM_STATUS.PLAYING];
      } else {
        this._setStatus(ROOM_STATUS.DEALING);
        this.turn = null;
        this.turnPlayerId = null;
      }
      const event = this._append('ROUND_STARTED', {
        matchId: this.matchId,
        roundId: round.roundId,
        roundNumber: round.roundNumber,
        status: this.status,
        phasePath,
        turn: this.turn,
        turnStartedAt: round.turnStartedAt,
        turnDeadlineAt: round.turnDeadlineAt,
        ruleId: this.ruleId,
        ruleVersion: this.ruleVersion,
        ruleSnapshotHash: this.ruleSnapshotHash
      }, command);
      return this._result(event, { matchId: this.matchId, roundId: round.roundId });
    });
  }

  startRound(options = {}) {
    return this.start(options);
  }

  beginDealing(options = {}) {
    const opts = normalizeOptions(options);
    if (this.status === ROOM_STATUS.READY) return this.start({ ...opts, autoAdvance: false });
    if (this.status === ROOM_STATUS.NEXT_ROUND) return this.beginNextRound(opts);
    if (this.status === ROOM_STATUS.DEALING) return this._result(this._events.at(-1), { matchId: this.matchId, roundId: this.roundId });
    throw statusError(this.status, 'PLAYERS_NOT_READY');
  }

  beginPlaying(options = {}) {
    const opts = normalizeOptions(options);
    const actorId = opts.actorId ?? opts.playerId ?? this.ownerId;
    return this._withCommand(opts, { op: 'begin_playing', actorId: actorId || null }, command => {
      if (this.status !== ROOM_STATUS.DEALING) throw statusError(this.status, 'ROUND_NOT_PLAYING');
      if (!this.currentRound) throw new AppError('ROUND_NOT_PLAYING');
      if (actorId && actorId !== this.ownerId && !command.isAdmin && !command.admin && command.actorRole !== 'SYSTEM') {
        throw new AppError('NOT_ROOM_OWNER');
      }
      if (this.currentRound.flowerStates) {
        const unresolved = Object.values(this.currentRound.flowerStates).some(state =>
          state.status === 'awaiting_piao_choice'
          || state.pendingFlowerDiscards > 0
          || state.pendingFlowerReplacements > 0);
        if (unresolved) throw new AppError('INVALID_ACTION', {
          details: [{ path: 'round.flowerStates', message: 'all opening flowers must be resolved before play' }]
        });
      }
      this._setStatus(ROOM_STATUS.PLAYING);
      this.currentRound.status = ROOM_STATUS.PLAYING;
      this.currentRound.startedAt = iso(this.clock);
      this.turn = this._firstTurn();
      this.turnPlayerId = this.turn;
      this.currentRound.turnPhase = 'discard';
      this.currentRound.discardsByPlayer = Object.fromEntries([...this.players.keys()].map(playerId => [playerId, []]));
      this.currentRound.meldsByPlayer = Object.fromEntries([...this.players.keys()].map(playerId => [playerId, []]));
      this._setTurnDeadline();
      const event = this._append('ROUND_PLAYING', {
        matchId: this.matchId,
        roundId: this.roundId,
        roundNumber: this.roundNumber,
        status: this.status,
        turn: this.turn,
        turnPhase: this.currentRound.turnPhase,
        discardsByPlayer: clone(this.currentRound.discardsByPlayer),
        meldsByPlayer: clone(this.currentRound.meldsByPlayer),
        turnStartedAt: this.currentRound.turnStartedAt,
        turnDeadlineAt: this.currentRound.turnDeadlineAt
      }, command);
      return this._result(event, { matchId: this.matchId, roundId: this.roundId });
    });
  }

  _advanceSusongTurn(playerId) {
    const ordered = this._orderedPlayers();
    const index = ordered.findIndex(player => player.id === playerId);
    this.turn = ordered[(index + 1) % ordered.length]?.id || null;
    this.turnPlayerId = this.turn;
    this.currentRound.turnPhase = 'draw';
    this._setTurnDeadline();
  }

  _openSusongReactionWindow(discarderId, tileId) {
    const ordered = this._orderedPlayers();
    const discarderIndex = ordered.findIndex(player => player.id === discarderId);
    if (discarderIndex < 0) throw new AppError('INVALID_ACTION');
    const responderOrder = Array.from({ length: ordered.length - 1 }, (_, offset) =>
      ordered[(discarderIndex + offset + 1) % ordered.length].id);
    this.currentRound.pendingReaction = {
      reactionId: this.idFactory(),
      discarderId,
      tileId,
      responderOrder,
      respondedPlayerIds: [],
      responsesByPlayer: {},
      responseChoicesByPlayer: {}
    };
    this.currentRound.turnPhase = 'reaction';
    this.turn = responderOrder[0] ?? null;
    this.turnPlayerId = this.turn;
    this._setTurnDeadline();
  }

  _susongReactionCandidates(playerId) {
    const pending = this.currentRound?.pendingReaction;
    const hand = this._privateRoundState?.handsByPlayer?.[playerId];
    if (!pending || !Array.isArray(hand)) return [];
    return getSusongDiscardReactionCandidates({
      hand,
      tileId: pending.tileId,
      isNextPlayer: pending.responderOrder[0] === playerId
    });
  }

  _susongAvailableReactionActions(playerId) {
    const pending = this.currentRound?.pendingReaction;
    if (!pending || this.currentRound.turnPhase !== 'reaction' || this.turn !== playerId) return [];
    const actions = ['pass'];
    const candidates = this._susongReactionCandidates(playerId);
    if (this._susongWinningCandidate(playerId, 'discard')) {
      if (this.ruleSnapshot.config?.forcedHu === true) return ['hu'];
      actions.push('hu');
    }
    const pengPlayers = pending.responderOrder.filter(id => this._susongReactionCandidates(id)
      .some(candidate => candidate.action === 'peng'));
    // Until the legacy priority rule is signed, execute only an unambiguous
    // peng claim. Competing claims remain fail-closed instead of guessing.
    if (pengPlayers.length === 1 && pengPlayers[0] === playerId) {
      if (candidates.some(candidate => candidate.action === 'exposed_kong')
        && this._canResolveSusongKong(playerId)) actions.push('exposed_kong');
      actions.push('peng');
    }
    if (pending.responderOrder[0] === playerId
      && candidates.some(candidate => candidate.action === 'chi')) actions.push('chi');
    return actions;
  }

  _susongReactionOptions(playerId) {
    if (!this._susongAvailableReactionActions(playerId).includes('chi')) return {};
    return {
      chi: this._susongReactionCandidates(playerId)
        .filter(candidate => candidate.action === 'chi')
        .map((candidate, candidateIndex) => ({ candidateIndex, sequence: [...candidate.sequence] }))
    };
  }

  _susongWinningCandidate(playerId, winSource) {
    const hand = this._privateRoundState?.handsByPlayer?.[playerId];
    const flowerState = this.currentRound?.flowerStates?.[playerId];
    const melds = this.currentRound?.meldsByPlayer?.[playerId] ?? [];
    const meldCount = melds.length;
    if (!Array.isArray(hand) || !flowerState) return null;
    const lastTurnAction = this._privateRoundState.turnHistory.at(-1)?.action ?? null;
    if (winSource === 'self_draw' && lastTurnAction
      && !['draw', 'exposed_kong', 'concealed_kong'].includes(lastTurnAction)) return null;
    const claimedTileId = winSource === 'discard'
      ? this.currentRound?.pendingReaction?.tileId ?? null
      : null;
    const shape = getSusongWinningHand({ hand, claimedTileId, meldCount, melds });
    if (!shape.winning) return null;
    const patterns = [...shape.patterns];
    if (winSource === 'self_draw' && this._privateRoundState.turnHistory.length === 0) {
      patterns.push('heavenly_win');
    }
    const gangWinCount = winSource === 'self_draw'
      && ['exposed_kong', 'concealed_kong'].includes(lastTurnAction) ? 1 : 0;
    const decision = evaluateSusongWin({ flowerState, winSource, patterns, gangWinCount });
    return decision.allowed ? { playerId, patterns, gangWinCount } : null;
  }

  _settleSusongWin({ outcome, winners, discarderId = null }, command) {
    const playerIds = this._orderedPlayers().map(player => player.id);
    let settlement;
    try {
      settlement = scoreSusongRound({
        config: this.ruleSnapshot.config,
        playerIds,
        outcome,
        discarderId,
        winners: winners.map(winner => ({
          winnerId: winner.playerId,
          flowerState: clone(this.currentRound.flowerStates[winner.playerId]),
          patterns: [...winner.patterns],
          gangWinCount: winner.gangWinCount
        })),
        zengByPlayer: Object.fromEntries(this.zengByPlayer),
        // The identifying condition for Sanxi is still unsigned. Keep this
        // draft gameplay slice at no Sanxi instead of accepting client facts.
        sanxiPairs: []
      });
    } catch (cause) {
      throw new AppError('INVALID_ACTION', { cause });
    }
    for (const [playerId, delta] of Object.entries(settlement.deltaByPlayer)) {
      this.scores.set(playerId, (this.scores.get(playerId) || 0) + delta);
    }
    this._setStatus(ROOM_STATUS.SETTLING);
    this.currentRound.status = ROOM_STATUS.SETTLING;
    this.currentRound.settlement = clone(settlement);
    this.currentRound.endedAt = iso(this.clock);
    this.currentRound.turnPhase = null;
    this.currentRound.pendingReaction = null;
    this.currentRound.turnStartedAt = null;
    this.currentRound.turnDeadlineAt = null;
    this.turn = null;
    this.turnPlayerId = null;
    const event = this._append('ROUND_SETTLING', {
      matchId: this.matchId,
      roundId: this.roundId,
      roundNumber: this.roundNumber,
      status: this.status,
      settlement: clone(settlement),
      scoreAuthority: 'server',
      scores: Object.fromEntries(this.scores),
      reason: outcome === 'self_draw' ? 'SELF_DRAW' : 'DISCARD_WIN'
    }, command);
    return this._result(event, {
      matchId: this.matchId,
      roundId: this.roundId,
      settlement: clone(settlement)
    });
  }

  _canResolveSusongKong(playerId) {
    const remainingWall = this._privateRoundState?.remainingWall;
    const flowerState = this.currentRound?.flowerStates?.[playerId];
    if (!Array.isArray(remainingWall) || !flowerState || remainingWall.length <= 14) return false;
    let wall = [...remainingWall];
    try {
      let draw = drawSusongReplacementTile(wall);
      wall = [...draw.remainingWall];
      if (flowerState.status === 'piao' || !isSusongReplacementFlower(draw.tileId)) return true;
      while (isSusongReplacementFlower(draw.tileId)) {
        draw = drawSusongReplacementTile(wall);
        wall = [...draw.remainingWall];
      }
      return true;
    } catch {
      return false;
    }
  }

  _susongTurnKongCandidates(playerId, action = null) {
    const hand = this._privateRoundState?.handsByPlayer?.[playerId];
    const melds = this.currentRound?.meldsByPlayer?.[playerId] ?? [];
    if (!Array.isArray(hand)) return [];
    const candidates = getSusongTurnKongCandidates({ hand, melds });
    return action ? candidates.filter(candidate => candidate.action === action) : candidates;
  }

  _resolveSusongConcealedKong(playerId, candidateIndex, command) {
    const candidate = this._susongTurnKongCandidates(playerId, 'concealed_kong')[candidateIndex];
    if (!candidate || !this._canResolveSusongKong(playerId)) throw new AppError('INVALID_ACTION');
    const privateState = clone(this._privateRoundState);
    const hand = privateState.handsByPlayer[playerId];
    for (const tileId of candidate.consumeTileIds) {
      const index = hand.indexOf(tileId);
      if (index < 0) throw new AppError('INVALID_ACTION');
      hand.splice(index, 1);
    }
    const isWind = ['east', 'south', 'west', 'north'].includes(candidate.face);
    const meldFlowerUnits = flowerUnitsForMeld({ kind: 'concealed_kong', isWind });
    let flowerState = recordSusongMeldFlowers(
      this.currentRound.flowerStates[playerId],
      meldFlowerUnits
    );
    const draw = drawSusongReplacementTile(privateState.remainingWall);
    privateState.remainingWall = [...draw.remainingWall];
    hand.push(draw.tileId);
    appendPrivateTurnOperation(privateState, {
      action: 'concealed_kong',
      playerId,
      consumeTileIds: [...candidate.consumeTileIds],
      replacementTileId: draw.tileId
    });
    let resolvedPrivateState = privateState;
    let replacementCount = 1;
    let flowerDisposition = null;
    if (isSusongReplacementFlower(draw.tileId)) {
      flowerState = recordSusongFlowerDraw(flowerState, 1);
      const flowerAction = flowerState.status === 'piao' ? 'discard' : 'replace';
      const resolution = resolvePrivateSusongFlowers({
        privateState,
        playerId,
        action: flowerAction,
        flowerState
      });
      resolvedPrivateState = resolution.privateState;
      flowerState = resolution.flowerState;
      if (flowerAction === 'replace') replacementCount += resolution.resolvedCount;
      flowerDisposition = flowerAction === 'discard' ? 'discarded' : 'replaced';
    }
    const meld = {
      action: 'concealed_kong',
      playerId,
      fromPlayerId: null,
      claimedTileId: null,
      tileIds: [...candidate.consumeTileIds]
    };
    this._privateRoundState = resolvedPrivateState;
    this.currentRound.meldsByPlayer[playerId].push(clone(meld));
    this.currentRound.flowerStates[playerId] = clone(flowerState);
    this.currentRound.wall.wallRemaining = resolvedPrivateState.remainingWall.length;
    this.currentRound.wall.handCountsByPlayer[playerId] = resolvedPrivateState.handsByPlayer[playerId].length;
    if (flowerDisposition === 'discarded') this._advanceSusongTurn(playerId);
    else {
      this.turn = playerId;
      this.turnPlayerId = playerId;
      this.currentRound.turnPhase = 'discard';
      this._setTurnDeadline();
    }
    const resolution = {
      ...meld,
      meldFlowerUnits,
      replacementCount,
      flowerDisposition,
      flowerState: clone(flowerState),
      wallRemaining: this.currentRound.wall.wallRemaining,
      handCount: this.currentRound.wall.handCountsByPlayer[playerId]
    };
    const event = this._append('SUSONG_KONG_RESOLVED', {
      matchId: this.matchId,
      roundId: this.roundId,
      playerId,
      resolution,
      nextTurn: this.turn,
      turnPhase: this.currentRound.turnPhase,
      turnStartedAt: this.currentRound.turnStartedAt,
      turnDeadlineAt: this.currentRound.turnDeadlineAt
    }, command);
    return this._result(event, { playerId, action: 'concealed_kong', resolution });
  }

  _canResolveSusongFlowerReplacements(remainingWall) {
    if (!Array.isArray(remainingWall)) return false;
    let wall = [...remainingWall];
    try {
      while (true) {
        const draw = drawSusongReplacementTile(wall);
        if (!isSusongReplacementFlower(draw.tileId)) return true;
        wall = [...draw.remainingWall];
      }
    } catch {
      return false;
    }
  }

  _resolveSusongClaim(pending, playerId, action, candidateIndex = 0) {
    const matchingCandidates = this._susongReactionCandidates(playerId)
      .filter(item => item.action === action);
    const candidate = matchingCandidates[candidateIndex];
    if (!candidate) throw new AppError('INVALID_ACTION');
    const privateState = clone(this._privateRoundState);
    const hand = privateState.handsByPlayer[playerId];
    for (const tileId of candidate.consumeTileIds) {
      const index = hand.indexOf(tileId);
      if (index < 0) throw new AppError('INVALID_ACTION');
      hand.splice(index, 1);
    }
    const discardPile = this.currentRound.discardsByPlayer?.[pending.discarderId];
    if (!Array.isArray(discardPile) || discardPile.at(-1) !== pending.tileId) {
      throw new AppError('INVALID_ACTION');
    }
    let flowerState = this.currentRound.flowerStates[playerId];
    let replacementCount = 0;
    let flowerDisposition = null;
    let meldFlowerUnits = 0;
    let resolvedPrivateState = privateState;
    let replacementTileId = null;
    const face = susongTileFace(pending.tileId);
    const isWind = ['east', 'south', 'west', 'north'].includes(face);
    meldFlowerUnits = action === 'chi' ? 0 : flowerUnitsForMeld({
      kind: action === 'exposed_kong' ? 'exposed_kong' : 'triplet',
      isWind
    });
    if (meldFlowerUnits > 0) {
      flowerState = recordSusongMeldFlowers(flowerState, meldFlowerUnits);
    }
    if (action === 'exposed_kong') {
      if (!this._canResolveSusongKong(playerId)) throw new AppError('INVALID_ACTION');
      const draw = drawSusongReplacementTile(privateState.remainingWall);
      privateState.remainingWall = [...draw.remainingWall];
      replacementTileId = draw.tileId;
      hand.push(draw.tileId);
      replacementCount = 1;
    }
    const meld = {
      action,
      playerId,
      fromPlayerId: pending.discarderId,
      claimedTileId: pending.tileId,
      tileIds: [...candidate.consumeTileIds, pending.tileId],
      ...(candidate.sequence ? { sequence: [...candidate.sequence] } : {})
    };
    appendPrivateTurnOperation(privateState, {
      action,
      playerId,
      discarderId: pending.discarderId,
      tileId: pending.tileId,
      consumeTileIds: [...candidate.consumeTileIds],
      ...(candidate.sequence ? { meldSequence: [...candidate.sequence] } : {}),
      ...(replacementTileId ? { replacementTileId } : {})
    });
    if (replacementTileId && isSusongReplacementFlower(replacementTileId)) {
      flowerState = recordSusongFlowerDraw(flowerState, 1);
      const flowerAction = flowerState.status === 'piao' ? 'discard' : 'replace';
      const resolution = resolvePrivateSusongFlowers({
        privateState,
        playerId,
        action: flowerAction,
        flowerState
      });
      resolvedPrivateState = resolution.privateState;
      flowerState = resolution.flowerState;
      if (flowerAction === 'replace') replacementCount += resolution.resolvedCount;
      flowerDisposition = flowerAction === 'discard' ? 'discarded' : 'replaced';
    }
    discardPile.pop();
    this._privateRoundState = resolvedPrivateState;
    const finalHand = resolvedPrivateState.handsByPlayer[playerId];
    this.currentRound.wall.handCountsByPlayer[playerId] = finalHand.length;
    this.currentRound.wall.wallRemaining = resolvedPrivateState.remainingWall.length;
    this.currentRound.flowerStates[playerId] = clone(flowerState);
    if (!isRecord(this.currentRound.meldsByPlayer)) {
      this.currentRound.meldsByPlayer = Object.fromEntries([...this.players.keys()].map(id => [id, []]));
    }
    this.currentRound.meldsByPlayer[playerId].push(clone(meld));
    this.currentRound.pendingReaction = null;
    if (action === 'exposed_kong' && flowerDisposition === 'discarded') {
      this._advanceSusongTurn(playerId);
    } else {
      this.currentRound.turnPhase = 'discard';
      this.turn = playerId;
      this.turnPlayerId = playerId;
      this._setTurnDeadline();
    }
    return {
      ...meld,
      meldFlowerUnits,
      replacementCount,
      flowerDisposition,
      flowerState: clone(flowerState),
      wallRemaining: this.currentRound.wall.wallRemaining,
      handCount: finalHand.length
    };
  }

  _respondSusongReaction(playerId, action, args, command) {
    const pending = this.currentRound?.pendingReaction;
    if (!pending || this.currentRound.turnPhase !== 'reaction'
      || pending.responderOrder[pending.respondedPlayerIds.length] !== playerId) {
      throw new AppError('INVALID_ACTION');
    }
    if (!this._susongAvailableReactionActions(playerId).includes(action)) {
      throw new AppError('INVALID_ACTION', {
        details: [{ path: 'action', message: 'reaction is not available from the authoritative hand state' }]
      });
    }
    let candidateIndex = null;
    if (action === 'chi') {
      if (!isRecord(args) || Object.keys(args).length !== 1
        || !Number.isInteger(args.candidateIndex) || args.candidateIndex < 0
        || !this._susongReactionOptions(playerId).chi?.[args.candidateIndex]) {
        throw new AppError('INVALID_ACTION');
      }
      candidateIndex = args.candidateIndex;
    } else if (args && Object.keys(args).length > 0) {
      throw new AppError('INVALID_ACTION');
    }
    if (!isRecord(pending.responsesByPlayer)) pending.responsesByPlayer = {};
    if (!isRecord(pending.responseChoicesByPlayer)) pending.responseChoicesByPlayer = {};
    pending.respondedPlayerIds.push(playerId);
    pending.responsesByPlayer[playerId] = action;
    if (candidateIndex !== null) pending.responseChoicesByPlayer[playerId] = candidateIndex;
    const complete = pending.respondedPlayerIds.length === pending.responderOrder.length;
    let resolution = null;
    if (complete) {
      const winners = pending.responderOrder
        .filter(id => pending.responsesByPlayer[id] === 'hu')
        .map(id => this._susongWinningCandidate(id, 'discard'));
      if (winners.length > 0) {
        return this._settleSusongWin({
          outcome: 'discard',
          winners,
          discarderId: pending.discarderId
        }, command);
      }
      const claimantId = pending.responderOrder.find(id =>
        ['exposed_kong', 'peng'].includes(pending.responsesByPlayer[id]))
        ?? pending.responderOrder.find(id => pending.responsesByPlayer[id] === 'chi');
      if (claimantId) {
        resolution = this._resolveSusongClaim(
          pending,
          claimantId,
          pending.responsesByPlayer[claimantId],
          pending.responseChoicesByPlayer[claimantId] ?? 0
        );
      } else {
        const discarderId = pending.discarderId;
        this.currentRound.pendingReaction = null;
        this._advanceSusongTurn(discarderId);
      }
    } else {
      this.turn = pending.responderOrder[pending.respondedPlayerIds.length];
      this.turnPlayerId = this.turn;
      this._setTurnDeadline();
    }
    const event = this._append(action === 'pass' ? 'SUSONG_REACTION_PASSED' : 'SUSONG_REACTION_CLAIMED', {
      matchId: this.matchId,
      roundId: this.roundId,
      playerId,
      action,
      reactionId: pending.reactionId,
      complete,
      resolution: clone(resolution),
      handCount: resolution ? this.currentRound.wall.handCountsByPlayer[resolution.playerId] : null,
      pendingReaction: clone(this.currentRound.pendingReaction),
      nextTurn: this.turn,
      turnPhase: this.currentRound.turnPhase,
      turnStartedAt: this.currentRound.turnStartedAt,
      turnDeadlineAt: this.currentRound.turnDeadlineAt
    }, command);
    return this._result(event, {
      playerId,
      action,
      reactionId: pending.reactionId,
      complete,
      resolution: clone(resolution),
      nextTurn: this.turn,
      turnPhase: this.currentRound.turnPhase
    });
  }

  _settleSusongWallDraw(command) {
    const players = this._orderedPlayers().map(player => player.id);
    const settlement = {
      scoreAuthority: 'server',
      outcome: 'draw',
      winnerIds: [],
      discarderId: null,
      wins: [],
      transfers: [],
      deltaByPlayer: Object.fromEntries(players.map(playerId => [playerId, 0]))
    };
    this._setStatus(ROOM_STATUS.SETTLING);
    this.currentRound.status = ROOM_STATUS.SETTLING;
    this.currentRound.settlement = clone(settlement);
    this.currentRound.endedAt = iso(this.clock);
    this.currentRound.turnPhase = null;
    this.currentRound.pendingReaction = null;
    this.currentRound.turnStartedAt = null;
    this.currentRound.turnDeadlineAt = null;
    this.turn = null;
    this.turnPlayerId = null;
    const event = this._append('ROUND_SETTLING', {
      matchId: this.matchId,
      roundId: this.roundId,
      settlement,
      scores: Object.fromEntries(this.scores),
      reason: 'WALL_RESERVED_14'
    }, command);
    return this._result(event, { settlement: clone(settlement), reason: 'WALL_RESERVED_14' });
  }

  _applySusongTurnAction(playerId, action, args, command) {
    if (!this._privateRoundState || !this.currentRound?.wall) throw new AppError('INVALID_ACTION');
    const phase = this.currentRound.turnPhase;
    if (phase === 'reaction') {
      if (!['pass', 'hu', 'peng', 'exposed_kong', 'chi'].includes(action)) {
        throw new AppError('INVALID_ACTION');
      }
      return this._respondSusongReaction(playerId, action, args, command);
    }
    if (action === 'concealed_kong') {
      if (phase !== 'discard' || !isRecord(args) || Object.keys(args).length !== 1
        || !Number.isInteger(args.candidateIndex) || args.candidateIndex < 0) {
        throw new AppError('INVALID_ACTION');
      }
      return this._resolveSusongConcealedKong(playerId, args.candidateIndex, command);
    }
    if (action === 'self_draw') {
      if (phase !== 'discard' || (args && Object.keys(args).length > 0)) throw new AppError('INVALID_ACTION');
      const winner = this._susongWinningCandidate(playerId, 'self_draw');
      if (!winner) throw new AppError('INVALID_ACTION');
      return this._settleSusongWin({ outcome: 'self_draw', winners: [winner] }, command);
    }
    if (!['draw', 'discard'].includes(action)) throw new AppError('INVALID_ACTION');
    if (action !== phase) throw new AppError('INVALID_ACTION', {
      details: [{ path: 'round.turnPhase', message: `expected ${phase}` }]
    });
    const privateState = clone(this._privateRoundState);
    const hand = privateState.handsByPlayer[playerId];
    if (!Array.isArray(hand)) throw new AppError('INVALID_ACTION');

    if (action === 'draw') {
      if (args && Object.keys(args).length > 0) throw new AppError('INVALID_ACTION');
      if (privateState.remainingWall.length <= 14) return this._settleSusongWallDraw(command);
      let draw;
      try {
        draw = drawSusongLiveTile(privateState.remainingWall);
      } catch (cause) {
        throw new AppError('INVALID_ACTION', { cause });
      }
      // A flower cannot be exposed as a playable tile. If taking the live
      // tile would leave only the reserved wall and therefore make its
      // mandatory replacement impossible, settle the draw without consuming
      // either end of the authoritative wall.
      const drawnFlowerState = isSusongReplacementFlower(draw.tileId)
        ? recordSusongFlowerDraw(this.currentRound.flowerStates[playerId], 1)
        : null;
      if (drawnFlowerState && drawnFlowerState.status !== 'piao'
        && !this._canResolveSusongFlowerReplacements(draw.remainingWall)) {
        return this._settleSusongWallDraw(command);
      }
      privateState.remainingWall = [...draw.remainingWall];
      hand.push(draw.tileId);
      appendPrivateTurnOperation(privateState, {
        action: 'draw',
        playerId,
        tileId: draw.tileId
      });
      let flowerState = this.currentRound.flowerStates[playerId];
      let flowerDisposition = null;
      let resolvedCount = 0;
      if (isSusongReplacementFlower(draw.tileId)) {
        flowerState = drawnFlowerState;
        const flowerAction = flowerState.status === 'piao' ? 'discard' : 'replace';
        const resolution = resolvePrivateSusongFlowers({
          privateState,
          playerId,
          action: flowerAction,
          flowerState
        });
        this._privateRoundState = resolution.privateState;
        flowerState = resolution.flowerState;
        flowerDisposition = flowerAction === 'discard' ? 'discarded' : 'replaced';
        resolvedCount = resolution.resolvedCount;
        if (flowerAction === 'discard') this._advanceSusongTurn(playerId);
        else {
          this.currentRound.turnPhase = 'discard';
          this._setTurnDeadline();
        }
      } else {
        this._privateRoundState = privateState;
        this.currentRound.turnPhase = 'discard';
        this._setTurnDeadline();
      }
      this.currentRound.flowerStates[playerId] = clone(flowerState);
      const finalHand = this._privateRoundState.handsByPlayer[playerId];
      this.currentRound.wall.wallRemaining = this._privateRoundState.remainingWall.length;
      this.currentRound.wall.handCountsByPlayer[playerId] = finalHand.length;
      const event = this._append('SUSONG_TILE_DRAWN', {
        matchId: this.matchId,
        roundId: this.roundId,
        playerId,
        handCount: finalHand.length,
        wallRemaining: this.currentRound.wall.wallRemaining,
        flowerDisposition,
        resolvedCount,
        flowerState: clone(flowerState),
        nextTurn: this.turn,
        turnPhase: this.currentRound.turnPhase,
        turnStartedAt: this.currentRound.turnStartedAt,
        turnDeadlineAt: this.currentRound.turnDeadlineAt
      }, command);
      return this._result(event, {
        playerId,
        action,
        handCount: finalHand.length,
        wallRemaining: this.currentRound.wall.wallRemaining,
        flowerDisposition,
        resolvedCount,
        nextTurn: this.turn,
        turnPhase: this.currentRound.turnPhase
      });
    }

    const tileId = normalizeId(args?.tileId, 'args.tileId', { max: 128 });
    if (isSusongReplacementFlower(tileId)) throw new AppError('INVALID_ACTION');
    const tileIndex = hand.indexOf(tileId);
    if (tileIndex < 0) throw new AppError('INVALID_ACTION', {
      details: [{ path: 'args.tileId', message: 'tile is not in the player hand' }]
    });
    hand.splice(tileIndex, 1);
    appendPrivateTurnOperation(privateState, { action: 'discard', playerId, tileId });
    this._privateRoundState = privateState;
    this.currentRound.discardsByPlayer[playerId].push(tileId);
    this.currentRound.wall.handCountsByPlayer[playerId] = hand.length;
    this._openSusongReactionWindow(playerId, tileId);
    const event = this._append('SUSONG_TILE_DISCARDED', {
      matchId: this.matchId,
      roundId: this.roundId,
      playerId,
      tileId,
      handCount: hand.length,
      wallRemaining: this.currentRound.wall.wallRemaining,
      pendingReaction: clone(this.currentRound.pendingReaction),
      nextTurn: this.turn,
      turnPhase: this.currentRound.turnPhase,
      turnStartedAt: this.currentRound.turnStartedAt,
      turnDeadlineAt: this.currentRound.turnDeadlineAt
    }, command);
    if (this.ruleSnapshot.config?.forcedHu === true) {
      const winners = this.currentRound.pendingReaction.responderOrder
        .map(id => this._susongWinningCandidate(id, 'discard'))
        .filter(Boolean);
      if (winners.length > 0) {
        return this._settleSusongWin({ outcome: 'discard', winners, discarderId: playerId }, command);
      }
    }
    return this._result(event, {
      playerId,
      action,
      tileId,
      handCount: hand.length,
      nextTurn: this.turn,
      turnPhase: this.currentRound.turnPhase
    });
  }

  applyAction(playerId, action, options = {}) {
    if (isRecord(playerId)) {
      const command = playerId;
      playerId = command.playerId ?? command.userId ?? command.actorId;
      action = command.action ?? command.payload ?? action;
      options = { ...command, ...normalizeOptions(options) };
    }
    const opts = normalizeOptions(options);
    const id = normalizeId(playerId, 'playerId');
    const parsed = actionInput(action);
    const name = parsed.name.trim();
    if (!name || name.length > 64) throw new AppError('INVALID_ACTION');
    const fingerprint = { op: 'action', playerId: id, action: name, args: parsed.args ?? null };
    return this._withCommand(opts, fingerprint, command => {
      if (this.status !== ROOM_STATUS.PLAYING) {
        if (this.status === ROOM_STATUS.FINISHED) throw new AppError('ROUND_FINISHED');
        throw new AppError('ROUND_NOT_PLAYING');
      }
      const player = this.players.get(id);
      if (!player) throw new AppError('PLAYER_NOT_FOUND');
      if (this.turn !== id) throw new AppError('NOT_YOUR_TURN');
      if (this.ruleId === 'susong_v1' && this._privateRoundState) {
        return this._applySusongTurnAction(id, name, parsed.args, command);
      }
      if (this.validateAction) {
        let valid = false;
        try {
          valid = this.validateAction({ action: name, args: parsed.args }, this.snapshot({ viewerId: id }));
        } catch (cause) {
          throw new AppError('INVALID_ACTION', { cause });
        }
        if (valid === false) throw new AppError('INVALID_ACTION');
      }
      const ordered = this._orderedPlayers();
      const index = ordered.findIndex(candidate => candidate.id === id);
      this.turn = ordered[(index + 1) % ordered.length]?.id || null;
      this.turnPlayerId = this.turn;
      const timedOut = command.timeout === true || command.timedOut === true;
      this._setTurnDeadline();
      const event = this._append('ACTION_APPLIED', {
        matchId: this.matchId,
        roundId: this.roundId,
        playerId: id,
        action: name,
        ...(parsed.args === undefined ? {} : { args: parsed.args }),
        nextTurn: this.turn,
        ...(timedOut ? {
          timedOut: true,
          timeoutAction: name,
          deadlineAt: command.deadlineAt || null
        } : {}),
        turnStartedAt: this.currentRound?.turnStartedAt || null,
        turnDeadlineAt: this.currentRound?.turnDeadlineAt || null
      }, command);
      return this._result(event, { playerId: id, action: name, nextTurn: this.turn });
    });
  }

  settleRound(settlement = null, options = {}) {
    let result = settlement;
    let opts = normalizeOptions(options);
    // Also accept a single command-shaped object for adapters that call
    // `settleRound({ result, commandId, actorId })`.
    if (isRecord(settlement) && Object.keys(options || {}).length === 0
      && (settlement.commandId || settlement.actorId || settlement.result !== undefined)) {
      opts = { ...settlement };
      result = settlement.result === undefined ? null : settlement.result;
      delete opts.result;
    }
    const actorId = opts.actorId ?? opts.playerId ?? this.ownerId;
    return this._withCommand(opts, { op: 'settle', actorId: actorId || null, settlement: result }, command => {
      if (this.status !== ROOM_STATUS.PLAYING) {
        if (this.status === ROOM_STATUS.FINISHED) throw new AppError('ROUND_FINISHED');
        throw new AppError('ROUND_NOT_PLAYING');
      }
      if (actorId && actorId !== this.ownerId && !command.isAdmin && !command.admin && command.actorRole !== 'SYSTEM') {
        throw new AppError('NOT_ROOM_OWNER');
      }
      const scoreDeltas = serverSettlementDeltas(result, this.players, command);
      if (scoreDeltas) {
        for (const [playerId, delta] of Object.entries(scoreDeltas)) {
          this.scores.set(playerId, (this.scores.get(playerId) || 0) + delta);
        }
      }
      this._setStatus(ROOM_STATUS.SETTLING);
      this.currentRound.status = ROOM_STATUS.SETTLING;
    this.currentRound.settlement = clone(result);
    this.currentRound.endedAt = iso(this.clock);
    this.currentRound.turnPhase = null;
    this.currentRound.pendingReaction = null;
    this.currentRound.turnStartedAt = null;
    this.currentRound.turnDeadlineAt = null;
    this.turn = null;
    this.turnPlayerId = null;
      const event = this._append('ROUND_SETTLING', {
        matchId: this.matchId,
        roundId: this.roundId,
        roundNumber: this.roundNumber,
        status: this.status,
        settlement: clone(result),
        scoreAuthority: scoreDeltas ? 'server' : 'rule-engine-pending',
        scores: Object.fromEntries(this.scores)
      }, command);
      return this._result(event, { matchId: this.matchId, roundId: this.roundId, settlement: clone(result) });
    });
  }

  settle(settlement = null, options = {}) {
    return this.settleRound(settlement, options);
  }

  nextRound(options = {}) {
    const opts = normalizeOptions(options);
    const actorId = opts.actorId ?? opts.playerId ?? this.ownerId;
    return this._withCommand(opts, { op: 'next_round', actorId: actorId || null, autoDeal: opts.autoDeal === true }, command => {
      if (this.status !== ROOM_STATUS.SETTLING) {
        if (this.status === ROOM_STATUS.FINISHED) throw new AppError('ROUND_FINISHED');
        throw new AppError('ROUND_NOT_PLAYING');
      }
      if (actorId && actorId !== this.ownerId && !command.isAdmin && !command.admin && command.actorRole !== 'SYSTEM') {
        throw new AppError('NOT_ROOM_OWNER');
      }
      const isLast = this.totalRounds !== null && this.roundNumber >= this.totalRounds;
      if (isLast) {
        this._setStatus(ROOM_STATUS.FINISHED);
        if (this.currentRound) {
          this.currentRound.turnStartedAt = null;
          this.currentRound.turnDeadlineAt = null;
        }
        const event = this._append('MATCH_FINISHED', {
          matchId: this.matchId,
          roundId: this.roundId,
          roundNumber: this.roundNumber,
          status: this.status
        }, command);
        return this._result(event, { matchId: this.matchId, finished: true });
      }
      this._setStatus(ROOM_STATUS.NEXT_ROUND);
      if (this.currentRound) {
        this.currentRound.turnStartedAt = null;
        this.currentRound.turnDeadlineAt = null;
      }
      const event = this._append('NEXT_ROUND', {
        matchId: this.matchId,
        previousRoundId: this.roundId,
        nextRoundNumber: this.roundNumber + 1,
        status: this.status
      }, command);
      const result = this._result(event, { matchId: this.matchId, finished: false });
      if (command.autoDeal) {
        const dealing = this._beginNextRound(command);
        result.event = publicClone(dealing.event);
        result.roomVersion = this.version;
        result.version = this.version;
        result.snapshot = this.snapshot();
        result.roundId = this.roundId;
      }
      return result;
    });
  }

  beginNextRound(options = {}) {
    const opts = normalizeOptions(options);
    return this._withCommand(opts, { op: 'begin_next_round', actorId: opts.actorId ?? this.ownerId }, command => {
      if (this.status !== ROOM_STATUS.NEXT_ROUND) throw statusError(this.status, 'ROUND_NOT_PLAYING');
      return this._beginNextRound(command);
    });
  }

  _beginNextRound(options = {}) {
    const round = this._newRound(this.roundNumber + 1, ROOM_STATUS.DEALING, options);
    this._setStatus(ROOM_STATUS.DEALING);
    this.turn = null;
    this.turnPlayerId = null;
    const event = this._append('ROUND_DEALING', {
      matchId: this.matchId,
      roundId: round.roundId,
      roundNumber: round.roundNumber,
      status: this.status,
      ruleSnapshotHash: this.ruleSnapshotHash
    }, options);
    return this._result(event, { matchId: this.matchId, roundId: round.roundId });
  }

  finish(options = {}) {
    const opts = normalizeOptions(options);
    const actorId = opts.actorId ?? opts.playerId ?? this.ownerId;
    return this._withCommand(opts, { op: 'finish', actorId: actorId || null }, command => {
      if (this.status === ROOM_STATUS.FINISHED) return this._result(this._events.at(-1), { matchId: this.matchId, finished: true });
      if (this.status === ROOM_STATUS.CANCELLED) throw new AppError('ROOM_NOT_JOINABLE');
      if (![ROOM_STATUS.SETTLING, ROOM_STATUS.NEXT_ROUND, ROOM_STATUS.PLAYING].includes(this.status)) {
        throw statusError(this.status, 'ROUND_NOT_PLAYING');
      }
      if (actorId && actorId !== this.ownerId && !command.isAdmin && !command.admin && command.actorRole !== 'SYSTEM') {
        throw new AppError('NOT_ROOM_OWNER');
      }
      this._setStatus(ROOM_STATUS.FINISHED);
      if (this.currentRound) {
        this.currentRound.turnStartedAt = null;
        this.currentRound.turnDeadlineAt = null;
      }
      if (this.currentRound && this.currentRound.status !== ROOM_STATUS.SETTLING) this.currentRound.status = ROOM_STATUS.FINISHED;
      const event = this._append('MATCH_FINISHED', {
        matchId: this.matchId,
        roundId: this.roundId,
        roundNumber: this.roundNumber,
        status: this.status
      }, command);
      return this._result(event, { matchId: this.matchId, finished: true });
    });
  }

  finishMatch(options = {}) {
    return this.finish(options);
  }

  cancel(actorOrOptions = {}, maybeOptions = {}) {
    const opts = typeof actorOrOptions === 'string'
      ? { ...normalizeOptions(maybeOptions), actorId: actorOrOptions }
      : normalizeOptions(actorOrOptions);
    const actorId = opts.actorId ?? opts.playerId ?? this.ownerId;
    return this._withCommand(opts, { op: 'cancel', actorId: actorId || null, reason: opts.reason || null }, command => {
      if (this.status === ROOM_STATUS.CANCELLED) throw new AppError('ROOM_NOT_JOINABLE');
      if (this.status === ROOM_STATUS.FINISHED) throw new AppError('ROUND_FINISHED');
      this._assertOwner(actorId, command);
      this._setStatus(ROOM_STATUS.CANCELLED);
      if (this.currentRound) {
        this.currentRound.turnStartedAt = null;
        this.currentRound.turnDeadlineAt = null;
      }
      const event = this._append('ROOM_CANCELLED', {
        matchId: this.matchId,
        roundId: this.roundId,
        status: this.status,
        reason: command.reason || null
      }, command);
      return this._result(event, { cancelled: true });
    });
  }

  disband(actorOrOptions = {}, maybeOptions = {}) {
    return this.cancel(actorOrOptions, maybeOptions);
  }

  disconnect(playerId, options = {}) {
    if (playerId === undefined || playerId === null) return null;
    if (isRecord(playerId)) {
      options = { ...playerId, ...normalizeOptions(options) };
      playerId = options.playerId ?? options.userId ?? options.actorId;
    }
    return this.setConnected(playerId, false, options);
  }

  /**
   * Update transport presence without advancing the room event cursor by
   * default. Presence is ephemeral connection state; callers that need an
   * auditable domain event can opt in with `emitEvent`.
   */
  setConnected(playerId, connected = true, options = {}) {
    if (playerId === undefined || playerId === null) return null;
    if (isRecord(playerId)) {
      options = { ...playerId, ...normalizeOptions(options) };
      connected = options.connected ?? connected;
      playerId = options.playerId ?? options.userId ?? options.actorId;
    }
    const id = normalizeId(playerId, 'playerId');
    const player = this.players.get(id);
    if (!player) return null;
    const nextConnected = connected === true;
    player.connected = nextConnected;
    player.disconnectedAt = nextConnected
      ? null
      : (options.at ? new Date(options.at).toISOString() : iso(this.clock));
    if (options.emitEvent === true) {
      return this._append(nextConnected ? 'PLAYER_CONNECTED' : 'PLAYER_DISCONNECTED', {
        playerId: id,
        ...(player.disconnectedAt ? { disconnectedAt: player.disconnectedAt } : {})
      }, options);
    }
    return this._publicPlayer(player);
  }

  eventsSince(lastVersion = 0) {
    if (!Number.isInteger(lastVersion) || lastVersion < 0 || lastVersion > this.version) {
      throw new AppError('VERSION_CONFLICT', {
        details: [{ lastRoomVersion: lastVersion, actualRoomVersion: this.version }]
      });
    }
    const firstVersion = this._events[0]?.version ?? this.version + 1;
    if (lastVersion < firstVersion - 1) {
      throw new AppError('VERSION_CONFLICT', {
        details: [{ lastRoomVersion: lastVersion, earliestRoomVersion: firstVersion, syncRequired: true }]
      });
    }
    return this._events.filter(event => event.version > lastVersion).map(publicClone);
  }

  reconnectSync(playerId, lastVersion = 0, options = {}) {
    let version = lastVersion;
    let opts = normalizeOptions(options);
    if (isRecord(lastVersion)) {
      opts = { ...lastVersion, ...opts };
      version = opts.lastRoomVersion ?? opts.lastVersion ?? 0;
    }
    if (isRecord(playerId)) {
      opts = { ...playerId, ...opts };
      playerId = opts.playerId ?? opts.userId ?? opts.actorId;
    }
    const id = normalizeId(playerId, 'playerId');
    const player = this.players.get(id);
    if (!player) throw new AppError('PLAYER_NOT_FOUND');
    // Membership/visibility is checked by the gateway; an already seated
    // player remains entitled to their room snapshot after a socket loss.
    this.setConnected(id, true, options);
    const events = this.eventsSince(version);
    return {
      snapshot: this.snapshot({ viewerId: id }),
      events,
      fromRoomVersion: version,
      toRoomVersion: this.version,
      roomVersion: this.version,
      syncRequired: false
    };
  }

  reconnect(playerId, lastVersion = 0, options = {}) {
    if (isRecord(playerId)) {
      const command = playerId;
      return this.reconnectSync(command.playerId ?? command.userId ?? command.actorId, command.lastRoomVersion ?? command.lastVersion ?? 0, { ...command, ...normalizeOptions(options) }).events;
    }
    return this.reconnectSync(playerId, lastVersion, options).events;
  }

  snapshot({ viewerId } = {}) {
    const players = this._orderedPlayers().map(player => this._publicPlayer(player));
    const round = this.currentRound ? {
      ...this.currentRound,
      ruleSnapshot: publicClone(this.ruleSnapshot)
    } : null;
    const base = {
      id: this.id,
      roomId: this.roomId,
      clubId: this.clubId,
      floorId: this.floorId,
      ownerId: this.ownerId,
      accessPolicy: this.accessPolicy,
      rule: this.rule,
      ruleId: this.ruleId,
      ruleVersion: this.ruleVersion,
      gameType: this.gameType,
      deadlinePolicy: publicClone(this.deadlinePolicy),
      ruleSnapshot: publicClone(this.ruleSnapshot),
      ruleSnapshotHash: this.ruleSnapshotHash,
      status: this.status,
      state: this.status,
      version: this.version,
      roomVersion: this.version,
      matchId: this.matchId,
      roundId: this.roundId,
      roundNumber: this.roundNumber,
      totalRounds: this.totalRounds,
      match: clone(this.match),
      round: round ? clone(round) : null,
      turn: this.turn,
      turnPlayerId: this.turnPlayerId,
      readyCount: this.readyCount,
      requiredReady: this.maxPlayers,
      connectedCount: this.connectedCount,
      maxPlayers: this.maxPlayers,
      seats: this.seats.map((playerId, seat) => playerId === null
        ? { seat, player: null }
        : { seat, player: players.find(player => player.id === playerId) || null }),
      players,
      scores: Object.fromEntries(this.scores),
      zengByPlayer: Object.fromEntries(this.zengByPlayer)
    };
    const result = {
      ...base,
      snapshotHash: hash(base)
    };
    const id = viewerId === undefined || viewerId === null ? null : String(viewerId);
    const privateHand = id && this.players.has(id)
      && this._privateRoundState?.roundId === this.roundId
      && Array.isArray(this._privateRoundState.handsByPlayer?.[id])
      ? clone(this._privateRoundState.handsByPlayer[id])
      : null;
    if (privateHand) result.round.privateHand = privateHand;
    if (result.round && id && id === this.turn && this.currentRound?.turnPhase === 'reaction') {
      result.round.availableReactions = this._susongAvailableReactionActions(id);
      const reactionOptions = this._susongReactionOptions(id);
      if (Object.keys(reactionOptions).length > 0) result.round.reactionOptions = reactionOptions;
    }
    if (result.round && id && id === this.turn && this.currentRound?.turnPhase === 'discard') {
      const concealedKongs = this._susongTurnKongCandidates(id, 'concealed_kong');
      result.round.availableActions = [
        'discard',
        ...(this._susongWinningCandidate(id, 'self_draw') ? ['self_draw'] : []),
        ...(concealedKongs.length > 0 && this._canResolveSusongKong(id) ? ['concealed_kong'] : [])
      ];
      if (concealedKongs.length > 0 && this._canResolveSusongKong(id)) {
        result.round.kongOptions = {
          concealed_kong: concealedKongs.map((candidate, candidateIndex) => ({
            candidateIndex,
            face: candidate.face
          }))
        };
      }
    }
    return result;
  }

  /** Full checkpoint for trusted persistence only. Never return this to a client. */
  persistenceSnapshot() {
    const current = this.snapshot();
    const base = clone(current);
    delete base.snapshotHash;
    if (this._privateRoundState) base.privateRoundState = clone(this._privateRoundState);
    return {
      ...base,
      snapshotHash: hash(base)
    };
  }

  /**
   * Rebuild an aggregate from a persisted public snapshot.  Persistence
   * adapters must treat snapshots as untrusted data: this method validates the
   * shape and copies every mutable collection before exposing the Room.
   * `events` may contain the retained history window for reconnects; the
   * aggregate version itself always comes from the snapshot.
   */
  static fromSnapshot(snapshot, options = {}) {
    if (!isRecord(snapshot)) throw new AppError('INVALID_ACTION');
    const room = new Room({
      id: snapshot.roomId || snapshot.id,
      clubId: snapshot.clubId ?? null,
      floorId: snapshot.floorId ?? null,
      rule: snapshot.ruleVersion || snapshot.rule || 'unknown',
      ruleId: snapshot.ruleId,
      ruleVersion: snapshot.ruleVersion,
      gameType: snapshot.gameType,
      ruleSnapshot: snapshot.ruleSnapshot,
      maxPlayers: snapshot.maxPlayers,
      ownerId: snapshot.ownerId ?? null,
      accessPolicy: snapshot.accessPolicy,
      matchId: snapshot.matchId,
      totalRounds: snapshot.totalRounds,
      deadlinePolicy: snapshot.deadlinePolicy,
      historyLimit: options.historyLimit ?? 2048,
      clock: options.clock,
      idFactory: options.idFactory,
      validateAction: options.validateAction
    });
    room.restoreSnapshot(snapshot, options);
    return room;
  }

  /** Compatibility alias for adapters that use `restore` as the factory. */
  static restore(snapshot, options = {}) {
    return Room.fromSnapshot(snapshot, options);
  }

  /**
   * Restore this instance in place. This is intentionally separate from event
   * replay: callers can load a checkpoint and then apply the append-only tail
   * with `applyPersistedEvent`.
   */
  restoreSnapshot(snapshot, options = {}) {
    if (!isRecord(snapshot)) throw new AppError('INVALID_ACTION');
    const version = snapshot.roomVersion ?? snapshot.version ?? 0;
    if (!Number.isInteger(version) || version < 0) {
      throw new AppError('INVALID_ACTION', { details: [{ path: 'roomVersion', message: 'must be a non-negative integer' }] });
    }
    if (snapshot.snapshotHash) {
      const candidate = clone(snapshot);
      delete candidate.snapshotHash;
      // A viewer snapshot uses the public room hash. Its private hand is a
      // per-player projection and is never accepted as an authoritative
      // persistence checkpoint.
      if (!candidate.privateRoundState && candidate.round) {
        delete candidate.round.privateHand;
      }
      if (hash(candidate) !== snapshot.snapshotHash) {
        throw new AppError('VERSION_CONFLICT', { details: [{ snapshotHash: 'mismatch' }] });
      }
    }

    // Keep constructor-established immutable rule metadata, but permit a
    // persisted snapshot to restore the exact immutable configuration.
    if (snapshot.ruleSnapshot !== undefined) {
      if (!isRecord(snapshot.ruleSnapshot)) throw new AppError('INVALID_ACTION');
      this.ruleSnapshot = deepFreeze(clone(snapshot.ruleSnapshot));
      this.ruleSnapshotHash = snapshot.ruleSnapshotHash || hash(this.ruleSnapshot);
      this.rule = String(snapshot.rule || this.ruleSnapshot.ruleVersion || this.rule);
      this.ruleId = String(snapshot.ruleId || this.ruleSnapshot.ruleId || this.ruleId);
      this.ruleVersion = String(snapshot.ruleVersion || this.ruleSnapshot.ruleVersion || this.ruleVersion);
      this.gameType = String(snapshot.gameType || this.ruleSnapshot.gameType || this.gameType);
    }
    if (snapshot.deadlinePolicy !== undefined) {
      this.deadlinePolicy = normalizeDeadlinePolicy(snapshot.deadlinePolicy);
    }
    if (snapshot.ownerId !== undefined) this.ownerId = snapshot.ownerId === null ? null : normalizeId(snapshot.ownerId, 'ownerId');
    if (snapshot.accessPolicy !== undefined) this.accessPolicy = normalizeAccessPolicy(snapshot.accessPolicy, this.clubId);
    if (snapshot.matchId !== undefined) this.matchId = normalizeId(snapshot.matchId, 'matchId', { max: 128 });
    this.roomId = this.id;
    this.status = snapshot.status || snapshot.state || ROOM_STATUS.WAITING;
    if (!Object.values(ROOM_STATUS).includes(this.status)) throw new AppError('INVALID_ACTION');
    this.state = this.status;
    this.version = version;
    this.roomVersion = version;
    this.roundNumber = Number(snapshot.roundNumber || snapshot.round?.roundNumber || 0);
    if (!Number.isInteger(this.roundNumber) || this.roundNumber < 0) throw new AppError('INVALID_ACTION');
    this.roundId = snapshot.roundId ?? snapshot.round?.roundId ?? null;
    this.totalRounds = snapshot.totalRounds ?? this.totalRounds ?? null;
    this.turn = snapshot.turn ?? snapshot.turnPlayerId ?? null;
    this.turnPlayerId = snapshot.turnPlayerId ?? this.turn;

    const players = Array.isArray(snapshot.players) ? snapshot.players : [];
    this.players = new Map();
    for (const input of players) {
      if (!isRecord(input)) throw new AppError('INVALID_ACTION');
      const id = normalizeId(input.id ?? input.playerId, 'playerId');
      const seat = input.seat;
      if (!Number.isInteger(seat) || seat < 0 || seat >= this.maxPlayers) throw new AppError('INVALID_ACTION');
      this.players.set(id, {
        id,
        playerId: id,
        name: normalizeName(input.name ?? input.displayName, `玩家${id.slice(0, 6)}`),
        displayName: normalizeName(input.displayName ?? input.name, `玩家${id.slice(0, 6)}`),
        seat,
        ready: Boolean(input.ready),
        connected: input.connected !== false,
        joinedAt: input.joinedAt || null,
        disconnectedAt: input.disconnectedAt || null
      });
    }
    this.seats = Array.from({ length: this.maxPlayers }, () => null);
    if (Array.isArray(snapshot.seats)) {
      for (let index = 0; index < Math.min(snapshot.seats.length, this.maxPlayers); index += 1) {
        const entry = snapshot.seats[index];
        const playerId = isRecord(entry) ? (entry.playerId ?? entry.player?.id) : entry;
        if (playerId !== null && playerId !== undefined) this.seats[index] = normalizeId(playerId, 'playerId');
      }
    }
    // Older snapshots only carried players; derive missing seat entries while
    // preserving explicit nulls from a newer snapshot.
    for (const player of this.players.values()) {
      if (this.seats[player.seat] === null) this.seats[player.seat] = player.id;
    }
    this.scores = new Map(Object.entries(isRecord(snapshot.scores) ? snapshot.scores : {}));
    for (const player of this.players.values()) if (!this.scores.has(player.id)) this.scores.set(player.id, 0);
    this.zengByPlayer = new Map(Object.entries(isRecord(snapshot.zengByPlayer) ? snapshot.zengByPlayer : {}));
    for (const player of this.players.values()) {
      const value = this.zengByPlayer.get(player.id) ?? 0;
      if (!Number.isSafeInteger(value) || value < 0) throw new AppError('INVALID_ACTION');
      this.zengByPlayer.set(player.id, value);
    }

    this.currentRound = snapshot.round ? clone(snapshot.round) : null;
    if (this.currentRound) {
      for (const field of ['privateHand', 'handsByPlayer', 'remainingWall', 'privateSeedHex', 'tileIds']) {
        delete this.currentRound[field];
      }
    }
    this.round = this.currentRound;
    this._privateRoundState = snapshot.privateRoundState
      ? normalizePrivateRoundState(snapshot.privateRoundState, this.players, this.currentRound)
      : null;
    this.match = isRecord(snapshot.match) ? clone(snapshot.match) : {
      id: this.matchId,
      matchId: this.matchId,
      status: this.status,
      roundNumber: this.roundNumber,
      totalRounds: this.totalRounds
    };
    this.match.id = this.match.id || this.matchId;
    this.match.matchId = this.match.matchId || this.matchId;
    this.match.status = this.status;
    this.match.roundNumber = this.roundNumber;
    this.match.totalRounds = this.totalRounds;

    const history = Array.isArray(options.events) ? options.events : [];
    this._events = history.map(event => deepFreeze(clone(event))).slice(-this.historyLimit);
    this._commands = new Map();
    return this;
  }

  /**
   * Apply one event read from the append-only store. The event must be the
   * immediate next room version; accepting gaps would make a recovered actor
   * appear healthy while silently missing game facts.
   */
  applyPersistedEvent(input) {
    if (!isRecord(input)) throw new AppError('INVALID_ACTION');
    const event = clone(input);
    const eventVersion = event.roomVersion ?? event.version;
    if (!Number.isInteger(eventVersion) || eventVersion !== this.version + 1) {
      throw new AppError('VERSION_CONFLICT', {
        details: [{ expectedRoomVersion: this.version + 1, actualRoomVersion: eventVersion }]
      });
    }
    if (event.roomId && String(event.roomId) !== this.id) throw new AppError('INVALID_ACTION');
    const payload = isRecord(event.payload) ? event.payload : {};
    const playerId = value => value === undefined || value === null ? null : normalizeId(value, 'playerId');
    switch (event.type) {
      case 'PLAYER_JOINED': {
        const source = isRecord(payload.player) ? payload.player : payload;
        const id = playerId(source.id ?? source.playerId);
        if (!id) break;
        const seat = Number(source.seat ?? payload.seat);
        if (!Number.isInteger(seat) || seat < 0 || seat >= this.maxPlayers) throw new AppError('INVALID_ACTION');
        const name = normalizeName(source.name ?? source.displayName, `玩家${id.slice(0, 6)}`);
        this.players.set(id, {
          id,
          playerId: id,
          name,
          displayName: normalizeName(source.displayName ?? source.name, name),
          seat,
          ready: Boolean(source.ready),
          connected: source.connected !== false,
          joinedAt: source.joinedAt || event.occurredAt || event.at || null,
          disconnectedAt: source.disconnectedAt || null
        });
        this.seats[seat] = id;
        if (!this.scores.has(id)) this.scores.set(id, 0);
        if (!this.zengByPlayer.has(id)) this.zengByPlayer.set(id, 0);
        if (payload.ownerId !== undefined) this.ownerId = payload.ownerId === null ? null : playerId(payload.ownerId);
        break;
      }
      case 'PLAYER_LEFT': {
        const id = playerId(payload.playerId);
        const player = id ? this.players.get(id) : null;
        if (player) {
          this.players.delete(id);
          this.seats[player.seat] = null;
          this.scores.delete(id);
          this.zengByPlayer.delete(id);
        }
        if (payload.ownerId !== undefined) this.ownerId = payload.ownerId === null ? null : playerId(payload.ownerId);
        if (this.status === ROOM_STATUS.READY) this._setStatus(ROOM_STATUS.WAITING);
        break;
      }
      case 'PLAYER_READY': {
        const id = playerId(payload.playerId);
        const player = id ? this.players.get(id) : null;
        if (player) player.ready = Boolean(payload.ready);
        if (payload.status && Object.values(ROOM_STATUS).includes(payload.status)) this._setStatus(payload.status);
        else if (this._allReady()) this._setStatus(ROOM_STATUS.READY);
        else if (this.status === ROOM_STATUS.READY) this._setStatus(ROOM_STATUS.WAITING);
        break;
      }
      case 'PLAYER_ZENG_INCREASED': {
        const id = playerId(payload.playerId);
        if (!id || !this.players.has(id)) throw new AppError('INVALID_ACTION');
        const previous = this.zengByPlayer.get(id) || 0;
        if (payload.previous !== previous || payload.current !== previous + 1) {
          throw new AppError('VERSION_CONFLICT');
        }
        this.zengByPlayer.set(id, payload.current);
        break;
      }
      case 'ROUND_STARTED': {
        const roundId = payload.roundId || this.roundId;
        this.roundId = roundId;
        this.roundNumber = Number(payload.roundNumber || this.roundNumber || 1);
        this.currentRound = {
          id: roundId,
          roundId,
          number: this.roundNumber,
          roundNumber: this.roundNumber,
          status: payload.status || ROOM_STATUS.DEALING,
          dealerSeat: null,
          ruleSnapshotHash: payload.ruleSnapshotHash || this.ruleSnapshotHash,
          wall: null,
          turnPhase: null,
          discardsByPlayer: null,
          meldsByPlayer: null,
          pendingReaction: null,
          flowerStates: null,
          settlement: null,
          startedAt: payload.status === ROOM_STATUS.PLAYING ? (event.occurredAt || event.at || null) : null,
          endedAt: null,
          turnStartedAt: payload.turnStartedAt || null,
          turnDeadlineAt: payload.turnDeadlineAt || null
        };
        this.round = this.currentRound;
        this.turn = payload.turn ?? null;
        this.turnPlayerId = this.turn;
        this._setStatus(payload.status || ROOM_STATUS.DEALING);
        this._privateRoundState = null;
        break;
      }
      case 'SUSONG_ROUND_DEALT': {
        if (!this.currentRound || !isRecord(payload.wall) || !isRecord(payload.flowerStates)) {
          throw new AppError('INVALID_ACTION');
        }
        if (!Number.isInteger(payload.dealerSeat) || payload.dealerSeat < 0 || payload.dealerSeat >= this.maxPlayers) {
          throw new AppError('INVALID_ACTION');
        }
        this.currentRound.dealerSeat = payload.dealerSeat;
        this.currentRound.wall = clone(payload.wall);
        this.currentRound.flowerStates = clone(payload.flowerStates);
        break;
      }
      case 'ROUND_PLAYING':
        this._setStatus(ROOM_STATUS.PLAYING);
        if (this.currentRound) {
          this.currentRound.status = ROOM_STATUS.PLAYING;
          this.currentRound.startedAt = this.currentRound.startedAt || event.occurredAt || event.at || null;
          this.currentRound.turnStartedAt = payload.turnStartedAt || this.currentRound.turnStartedAt || null;
          this.currentRound.turnDeadlineAt = payload.turnDeadlineAt || this.currentRound.turnDeadlineAt || null;
        }
        this.turn = payload.turn ?? this.turn;
        this.turnPlayerId = this.turn;
        this.currentRound.turnPhase = payload.turnPhase ?? this.currentRound.turnPhase;
        if (isRecord(payload.discardsByPlayer)) {
          this.currentRound.discardsByPlayer = clone(payload.discardsByPlayer);
        }
        if (isRecord(payload.meldsByPlayer)) {
          this.currentRound.meldsByPlayer = clone(payload.meldsByPlayer);
        }
        break;
      case 'SUSONG_FLOWERS_INITIALIZED': {
        if (!this.currentRound || !isRecord(payload.flowerStates)
          || Object.keys(payload.flowerStates).length !== this.players.size) {
          throw new AppError('INVALID_ACTION');
        }
        const flowerStates = {};
        try {
          for (const id of this.players.keys()) {
            if (!(id in payload.flowerStates)) throw new TypeError('missing player');
            flowerStates[id] = recordSusongFlowerDraw(payload.flowerStates[id], 0);
          }
        } catch (cause) {
          throw new AppError('INVALID_ACTION', { cause });
        }
        this.currentRound.flowerStates = clone(flowerStates);
        break;
      }
      case 'SUSONG_PIAO_CHOSEN': {
        const id = playerId(payload.playerId);
        const current = id ? this.currentRound?.flowerStates?.[id] : null;
        if (!current || current.status !== 'awaiting_piao_choice'
          || typeof payload.choosesPiao !== 'boolean' || !isRecord(payload.flowerState)) {
          throw new AppError('INVALID_ACTION');
        }
        try {
          this.currentRound.flowerStates[id] = clone(recordSusongFlowerDraw(payload.flowerState, 0));
        } catch (cause) {
          throw new AppError('INVALID_ACTION', { cause });
        }
        if (this.currentRound.wall && Number.isInteger(payload.wallRemaining)) {
          this.currentRound.wall.wallRemaining = payload.wallRemaining;
        }
        if (this.currentRound.wall?.handCountsByPlayer && Number.isInteger(payload.handCount)) {
          this.currentRound.wall.handCountsByPlayer[id] = payload.handCount;
        }
        break;
      }
      case 'SUSONG_FLOWER_DRAWN': {
        const id = playerId(payload.playerId);
        const current = id ? this.currentRound?.flowerStates?.[id] : null;
        if (!current) throw new AppError('INVALID_ACTION');
        try {
          this.currentRound.flowerStates[id] = clone(recordSusongFlowerDraw(current, payload.count));
        } catch (cause) {
          throw new AppError('INVALID_ACTION', { cause });
        }
        break;
      }
      case 'SUSONG_FLOWER_RESOLVED': {
        const id = playerId(payload.playerId);
        const current = id ? this.currentRound?.flowerStates?.[id] : null;
        if (!current || !['discard', 'replace'].includes(payload.action) || !isRecord(payload.flowerState)) {
          throw new AppError('INVALID_ACTION');
        }
        try {
          this.currentRound.flowerStates[id] = clone(recordSusongFlowerDraw(payload.flowerState, 0));
        } catch (cause) {
          throw new AppError('INVALID_ACTION', { cause });
        }
        if (this.currentRound.wall && Number.isInteger(payload.wallRemaining)) {
          this.currentRound.wall.wallRemaining = payload.wallRemaining;
        }
        if (this.currentRound.wall?.handCountsByPlayer && Number.isInteger(payload.handCount)) {
          this.currentRound.wall.handCountsByPlayer[id] = payload.handCount;
        }
        break;
      }
      case 'SUSONG_TILE_DRAWN': {
        const id = playerId(payload.playerId);
        if (!id || !this.currentRound?.wall || !Number.isInteger(payload.handCount)
          || !Number.isInteger(payload.wallRemaining)) throw new AppError('INVALID_ACTION');
        this.currentRound.wall.handCountsByPlayer[id] = payload.handCount;
        this.currentRound.wall.wallRemaining = payload.wallRemaining;
        if (isRecord(payload.flowerState)) this.currentRound.flowerStates[id] = clone(payload.flowerState);
        this.turn = payload.nextTurn ?? id;
        this.turnPlayerId = this.turn;
        this.currentRound.turnPhase = payload.turnPhase;
        this.currentRound.turnStartedAt = payload.turnStartedAt || null;
        this.currentRound.turnDeadlineAt = payload.turnDeadlineAt || null;
        break;
      }
      case 'SUSONG_TILE_DISCARDED': {
        const id = playerId(payload.playerId);
        if (!id || !this.currentRound?.wall || typeof payload.tileId !== 'string'
          || !Number.isInteger(payload.handCount)) throw new AppError('INVALID_ACTION');
        this.currentRound.wall.handCountsByPlayer[id] = payload.handCount;
        if (!isRecord(this.currentRound.discardsByPlayer)) {
          this.currentRound.discardsByPlayer = Object.fromEntries([...this.players.keys()].map(key => [key, []]));
        }
        this.currentRound.discardsByPlayer[id].push(payload.tileId);
        this.currentRound.pendingReaction = clone(payload.pendingReaction ?? null);
        this.turn = payload.nextTurn;
        this.turnPlayerId = this.turn;
        this.currentRound.turnPhase = payload.turnPhase;
        this.currentRound.turnStartedAt = payload.turnStartedAt || null;
        this.currentRound.turnDeadlineAt = payload.turnDeadlineAt || null;
        break;
      }
      case 'SUSONG_REACTION_PASSED':
      case 'SUSONG_REACTION_CLAIMED': {
        const id = playerId(payload.playerId);
        const pending = this.currentRound?.pendingReaction;
        if (!id || !pending || pending.reactionId !== payload.reactionId
          || pending.responderOrder[pending.respondedPlayerIds.length] !== id) {
          throw new AppError('INVALID_ACTION');
        }
        if (['chi', 'peng', 'exposed_kong'].includes(payload.resolution?.action)) {
          const resolution = payload.resolution;
          const claimantId = playerId(resolution.playerId);
          const discarderId = playerId(resolution.fromPlayerId);
          const discardPile = this.currentRound.discardsByPlayer?.[discarderId];
          const expectedTileCount = resolution.action === 'exposed_kong' ? 4 : 3;
          if (!claimantId || !discarderId || !Array.isArray(discardPile)
            || discardPile.at(-1) !== resolution.claimedTileId
            || !Array.isArray(resolution.tileIds) || resolution.tileIds.length !== expectedTileCount
            || !Number.isInteger(payload.handCount)) {
            throw new AppError('INVALID_ACTION');
          }
          discardPile.pop();
          if (!isRecord(this.currentRound.meldsByPlayer)) {
            this.currentRound.meldsByPlayer = Object.fromEntries([...this.players.keys()].map(key => [key, []]));
          }
          this.currentRound.meldsByPlayer[claimantId].push({
            action: resolution.action,
            playerId: claimantId,
            fromPlayerId: discarderId,
            claimedTileId: resolution.claimedTileId,
            tileIds: clone(resolution.tileIds),
            ...(Array.isArray(resolution.sequence) ? { sequence: clone(resolution.sequence) } : {})
          });
          this.currentRound.wall.handCountsByPlayer[claimantId] = payload.handCount;
          if (isRecord(resolution.flowerState)) {
            this.currentRound.flowerStates[claimantId] = clone(resolution.flowerState);
          }
          if (resolution.action === 'exposed_kong') {
            if (!Number.isInteger(resolution.wallRemaining) || !isRecord(resolution.flowerState)) {
              throw new AppError('INVALID_ACTION');
            }
            this.currentRound.wall.wallRemaining = resolution.wallRemaining;
          }
        }
        this.currentRound.pendingReaction = clone(payload.pendingReaction ?? null);
        this.turn = payload.nextTurn ?? null;
        this.turnPlayerId = this.turn;
        this.currentRound.turnPhase = payload.turnPhase;
        this.currentRound.turnStartedAt = payload.turnStartedAt || null;
        this.currentRound.turnDeadlineAt = payload.turnDeadlineAt || null;
        break;
      }
      case 'SUSONG_KONG_RESOLVED': {
        const id = playerId(payload.playerId);
        const resolution = payload.resolution;
        if (!id || !isRecord(resolution) || resolution.action !== 'concealed_kong'
          || resolution.playerId !== id || !Array.isArray(resolution.tileIds)
          || resolution.tileIds.length !== 4 || !Number.isInteger(resolution.handCount)
          || !Number.isInteger(resolution.wallRemaining) || !isRecord(resolution.flowerState)) {
          throw new AppError('INVALID_ACTION');
        }
        if (!isRecord(this.currentRound?.meldsByPlayer)) throw new AppError('INVALID_ACTION');
        this.currentRound.meldsByPlayer[id].push({
          action: resolution.action,
          playerId: id,
          fromPlayerId: null,
          claimedTileId: null,
          tileIds: clone(resolution.tileIds)
        });
        this.currentRound.wall.handCountsByPlayer[id] = resolution.handCount;
        this.currentRound.wall.wallRemaining = resolution.wallRemaining;
        this.currentRound.flowerStates[id] = clone(resolution.flowerState);
        this.turn = payload.nextTurn ?? null;
        this.turnPlayerId = this.turn;
        this.currentRound.turnPhase = payload.turnPhase;
        this.currentRound.turnStartedAt = payload.turnStartedAt || null;
        this.currentRound.turnDeadlineAt = payload.turnDeadlineAt || null;
        break;
      }
      case 'ACTION_APPLIED':
        this._setStatus(ROOM_STATUS.PLAYING);
        this.turn = payload.nextTurn ?? null;
        this.turnPlayerId = this.turn;
        if (this.currentRound) {
          this.currentRound.turnStartedAt = payload.turnStartedAt || null;
          this.currentRound.turnDeadlineAt = payload.turnDeadlineAt || null;
        }
        break;
      case 'ROUND_SETTLING':
        this._setStatus(ROOM_STATUS.SETTLING);
        if (this.currentRound) {
          this.currentRound.status = ROOM_STATUS.SETTLING;
          this.currentRound.settlement = clone(payload.settlement ?? null);
          this.currentRound.endedAt = this.currentRound.endedAt || event.occurredAt || event.at || null;
          this.currentRound.turnPhase = null;
          this.currentRound.pendingReaction = null;
          this.currentRound.turnStartedAt = null;
          this.currentRound.turnDeadlineAt = null;
        }
        this.turn = null;
        this.turnPlayerId = null;
        if (isRecord(payload.scores)) {
          const restoredScores = new Map();
          for (const id of this.players.keys()) {
            const value = payload.scores[id];
            if (!Number.isSafeInteger(value)) throw new AppError('INVALID_ACTION');
            restoredScores.set(id, value);
          }
          if (Object.keys(payload.scores).length !== restoredScores.size) throw new AppError('INVALID_ACTION');
          this.scores = restoredScores;
        }
        break;
      case 'NEXT_ROUND':
        this._setStatus(ROOM_STATUS.NEXT_ROUND);
        if (this.currentRound) {
          this.currentRound.turnStartedAt = null;
          this.currentRound.turnDeadlineAt = null;
        }
        break;
      case 'ROUND_DEALING':
        this.roundId = payload.roundId || this.roundId;
        this.roundNumber = Number(payload.roundNumber || this.roundNumber + 1);
        this.currentRound = {
          id: this.roundId,
          roundId: this.roundId,
          number: this.roundNumber,
          roundNumber: this.roundNumber,
          status: ROOM_STATUS.DEALING,
          dealerSeat: null,
          ruleSnapshotHash: payload.ruleSnapshotHash || this.ruleSnapshotHash,
          wall: null,
          turnPhase: null,
          discardsByPlayer: null,
          meldsByPlayer: null,
          pendingReaction: null,
          flowerStates: null,
          settlement: null,
          startedAt: null,
          endedAt: null,
          turnStartedAt: null,
          turnDeadlineAt: null
        };
        this.round = this.currentRound;
        this.turn = null;
        this.turnPlayerId = null;
        this._privateRoundState = null;
        this._setStatus(ROOM_STATUS.DEALING);
        break;
      case 'MATCH_FINISHED':
        this._setStatus(ROOM_STATUS.FINISHED);
        if (this.currentRound) {
          if (this.currentRound.status !== ROOM_STATUS.SETTLING) this.currentRound.status = ROOM_STATUS.FINISHED;
          this.currentRound.turnStartedAt = null;
          this.currentRound.turnDeadlineAt = null;
        }
        break;
      case 'ROOM_CANCELLED':
        this._setStatus(ROOM_STATUS.CANCELLED);
        if (this.currentRound) {
          this.currentRound.turnStartedAt = null;
          this.currentRound.turnDeadlineAt = null;
        }
        break;
      case 'PLAYER_DISCONNECTED': {
        const id = playerId(payload.playerId);
        const player = id ? this.players.get(id) : null;
        if (player) {
          player.connected = false;
          player.disconnectedAt = payload.disconnectedAt || event.occurredAt || event.at || null;
        }
        break;
      }
      case 'PLAYER_CONNECTED': {
        const id = playerId(payload.playerId);
        const player = id ? this.players.get(id) : null;
        if (player) {
          player.connected = true;
          player.disconnectedAt = null;
        }
        break;
      }
      default:
        // Unknown event types remain part of history. A newer rule/plugin can
        // enrich state on a later deployment without making old actors fail to
        // recover their version cursor.
        break;
    }
    this.version = eventVersion;
    this.roomVersion = eventVersion;
    this.match.status = this.status;
    this.match.roundNumber = this.roundNumber;
    this._events.push(deepFreeze(event));
    while (this._events.length > this.historyLimit) this._events.shift();
    return publicClone(event);
  }

  applyEvent(event) {
    return this.applyPersistedEvent(event);
  }

  publicSnapshot(options = {}) {
    return this.snapshot(options);
  }

  toJSON() {
    return this.snapshot();
  }

  /**
   * Execute a protocol/domain command using the same idempotency boundary as
   * direct aggregate methods. The WSS and future REST adapters can share it.
   */
  execute(command = {}, context = {}) {
    if (!isRecord(command)) throw new AppError('INVALID_MESSAGE');
    const payload = isRecord(command.payload) ? command.payload : command;
    const type = String(command.type || payload.type || '').toLowerCase();
    const options = {
      ...context,
      commandId: command.commandId ?? context.commandId,
      requestId: command.requestId ?? context.requestId,
      expectedRoomVersion: command.expectedRoomVersion
        ?? command.roomVersion
        ?? context.expectedRoomVersion,
      actorId: context.actorId ?? command.actorId ?? payload.actorId
    };
    switch (type) {
      case 'join':
      case 'join_room':
      case 'room.join':
        return this.join({
          id: payload.playerId ?? payload.userId ?? context.actorId,
          name: payload.name ?? payload.displayName,
          seat: payload.seat
        }, { ...payload, ...options });
      case 'leave':
      case 'leave_room':
      case 'room.leave':
        return this.leave(payload.playerId ?? context.actorId, { ...payload, ...options });
      case 'ready':
      case 'ready_room':
      case 'room.ready':
        return this.setReady(payload.playerId ?? context.actorId, payload.ready ?? true, { ...payload, ...options });
      case 'increase_zeng':
      case 'room.increase_zeng':
        return this.increaseZeng(payload.playerId ?? context.actorId, { ...payload, ...options });
      case 'initialize_susong_flowers':
        return this.initializeSusongFlowers(payload.openingFlowerCountByPlayer, { ...payload, ...options });
      case 'deal_susong_round':
        return this.dealSusongOpeningRound(payload, { ...payload, ...options });
      case 'choose_piao':
        return this.chooseSusongPiao(
          payload.playerId ?? context.actorId,
          payload.choosesPiao,
          { ...payload, ...options }
        );
      case 'record_susong_flower_draw':
        return this.recordSusongFlowerDraw(payload.playerId, payload.count ?? 1, { ...payload, ...options });
      case 'resolve_flower':
        return this.resolveSusongFlower(
          payload.playerId ?? context.actorId,
          payload.action,
          { ...payload, ...options }
        );
      case 'start':
      case 'start_round':
      case 'room.start':
        return this.start({ ...payload, ...options });
      case 'begin_dealing':
      case 'round.deal':
        return this.beginDealing({ ...payload, ...options });
      case 'begin_playing':
      case 'round.play':
        return this.beginPlaying({ ...payload, ...options });
      case 'action':
      case 'game.action':
        return this.applyAction(payload.playerId ?? context.actorId, payload.action ?? payload, {
          ...payload,
          ...options
        });
      case 'settle':
      case 'settle_round':
      case 'round.settle':
        return this.settleRound(payload.result ?? payload.settlement ?? null, { ...payload, ...options });
      case 'next_round':
      case 'round.next':
        return this.nextRound({ ...payload, ...options });
      case 'finish':
      case 'finish_match':
      case 'match.finish':
        return this.finish({ ...payload, ...options });
      case 'cancel':
      case 'disband':
      case 'disband_room':
      case 'room.disband':
        return this.cancel({ ...payload, ...options });
      case 'reconnect':
      case 'room.reconnect':
        return this.reconnectSync(payload.playerId ?? context.actorId, payload.lastRoomVersion ?? payload.lastVersion ?? options.expectedRoomVersion ?? 0, options);
      case 'disconnect':
      case 'room.disconnect':
        return this.disconnect(payload.playerId ?? context.actorId, { ...payload, ...options });
      default:
        throw new AppError('INVALID_MESSAGE');
    }
  }
}

function resolvePrivateSusongFlowers({ privateState, playerId, action, flowerState }) {
  const nextPrivate = clone(privateState);
  const hand = nextPrivate.handsByPlayer?.[playerId];
  const resolved = nextPrivate.resolvedFlowerTilesByPlayer?.[playerId];
  if (!Array.isArray(hand) || !Array.isArray(resolved) || !Array.isArray(nextPrivate.remainingWall)) {
    throw new TypeError('private flower state is incomplete');
  }
  let nextFlowerState = clone(flowerState);
  const removedTileIds = [];
  const drawnTileIds = [];

  if (action === 'discard') {
    const index = hand.findIndex(isSusongReplacementFlower);
    if (index < 0) throw new TypeError('pending flower is missing from the private hand');
    const [removed] = hand.splice(index, 1);
    resolved.push(removed);
    removedTileIds.push(removed);
    nextFlowerState = resolveSusongFlowers(nextFlowerState, { discard: 1 });
  } else {
    while (nextFlowerState.pendingFlowerReplacements > 0) {
      const index = hand.findIndex(isSusongReplacementFlower);
      if (index < 0) throw new TypeError('pending flower is missing from the private hand');
      const draw = drawSusongReplacementTile(nextPrivate.remainingWall);
      const [removed] = hand.splice(index, 1);
      resolved.push(removed);
      removedTileIds.push(removed);
      nextPrivate.remainingWall = [...draw.remainingWall];
      hand.push(draw.tileId);
      drawnTileIds.push(draw.tileId);
      nextFlowerState = resolveSusongFlowers(nextFlowerState, { replace: 1 });
      if (isSusongReplacementFlower(draw.tileId)) {
        nextFlowerState = recordSusongFlowerDraw(nextFlowerState, 1);
      }
    }
  }

  const sequence = nextPrivate.nextPrivateOperationSequence;
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TypeError('private operation sequence is invalid');
  nextPrivate.nextPrivateOperationSequence += 1;
  nextPrivate.replacementHistory.push({
    sequence,
    action,
    playerId,
    removedTileIds,
    drawnTileIds
  });
  return {
    privateState: nextPrivate,
    flowerState: nextFlowerState,
    resolvedCount: removedTileIds.length,
    additionalFlowerCount: drawnTileIds.filter(isSusongReplacementFlower).length,
    handCount: hand.length,
    wallRemaining: nextPrivate.remainingWall.length
  };
}

function appendPrivateTurnOperation(privateState, operation) {
  if (!Array.isArray(privateState.turnHistory)) throw new TypeError('private turn history is incomplete');
  const sequence = privateState.nextPrivateOperationSequence;
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TypeError('private operation sequence is invalid');
  privateState.nextPrivateOperationSequence += 1;
  privateState.turnHistory.push({ sequence, ...operation });
}

function normalizePrivateRoundState(input, players, round) {
  if (!isRecord(input) || !round || input.roundId !== round.roundId) {
    throw new AppError('INVALID_ACTION', {
      details: [{ path: 'privateRoundState', message: 'must match the current round' }]
    });
  }
  const playerIds = [...players.keys()];
  if (!isRecord(input.handsByPlayer)
    || Object.keys(input.handsByPlayer).length !== playerIds.length
    || !Array.isArray(input.remainingWall)) {
    throw new AppError('INVALID_ACTION');
  }
  const handsByPlayer = {};
  const resolvedFlowerTilesByPlayer = {};
  for (const playerId of playerIds) {
    if (!Array.isArray(input.handsByPlayer[playerId])) throw new AppError('INVALID_ACTION');
    handsByPlayer[playerId] = input.handsByPlayer[playerId].map(value => String(value));
    const resolved = input.resolvedFlowerTilesByPlayer?.[playerId] ?? [];
    if (!Array.isArray(resolved)) throw new AppError('INVALID_ACTION');
    resolvedFlowerTilesByPlayer[playerId] = resolved.map(value => String(value));
  }
  const remainingWall = input.remainingWall.map(value => String(value));
  const replacementHistory = clone(input.replacementHistory ?? []);
  const turnHistory = clone(input.turnHistory ?? []);
  if (!Array.isArray(replacementHistory) || !Array.isArray(turnHistory)) throw new AppError('INVALID_ACTION');
  if (replacementHistory.some(operation => !Number.isSafeInteger(operation?.sequence))) {
    if (turnHistory.length > 0) throw new AppError('INVALID_ACTION');
    replacementHistory.forEach((operation, index) => { operation.sequence = index + 1; });
  }
  const operations = [
    ...replacementHistory.map(operation => ({ kind: 'flower', ...operation })),
    ...turnHistory.map(operation => ({ kind: 'turn', ...operation }))
  ].sort((left, right) => left.sequence - right.sequence);
  if (operations.some((operation, index) => operation.sequence !== index + 1)) {
    throw new AppError('INVALID_ACTION', {
      details: [{ path: 'privateRoundState', message: 'private operation sequence must be contiguous' }]
    });
  }
  const nextPrivateOperationSequence = input.nextPrivateOperationSequence ?? operations.length + 1;
  if (!Number.isSafeInteger(nextPrivateOperationSequence)
    || nextPrivateOperationSequence !== operations.length + 1) throw new AppError('INVALID_ACTION');
  const publicDiscards = Object.fromEntries(playerIds.map(playerId => {
    const values = round.discardsByPlayer?.[playerId] ?? [];
    if (!Array.isArray(values)) throw new AppError('INVALID_ACTION');
    return [playerId, values.map(value => String(value))];
  }));
  const publicMelds = Object.fromEntries(playerIds.map(playerId => {
    const values = round.meldsByPlayer?.[playerId] ?? [];
    if (!Array.isArray(values)) throw new AppError('INVALID_ACTION');
    return [playerId, clone(values)];
  }));
  const publicMeldTileIds = Object.values(publicMelds).flatMap(melds => melds.flatMap(meld => {
    const expectedTileCount = ['exposed_kong', 'concealed_kong'].includes(meld?.action) ? 4 : 3;
    if (!isRecord(meld) || !['chi', 'peng', 'exposed_kong', 'concealed_kong'].includes(meld.action)
      || !Array.isArray(meld.tileIds) || meld.tileIds.length !== expectedTileCount) {
      throw new AppError('INVALID_ACTION');
    }
    return meld.tileIds.map(value => String(value));
  }));
  const allTileIds = [
    ...Object.values(handsByPlayer).flat(),
    ...Object.values(resolvedFlowerTilesByPlayer).flat(),
    ...Object.values(publicDiscards).flat(),
    ...publicMeldTileIds,
    ...remainingWall
  ];
  const allowedTileIds = new Set(buildSusongTileSet().map(tile => tile.id));
  if (allTileIds.length !== 144
    || new Set(allTileIds).size !== 144
    || allTileIds.some(tileId => !allowedTileIds.has(tileId))) {
    throw new AppError('INVALID_ACTION', {
      details: [{ path: 'privateRoundState', message: 'must conserve the 144-tile wall' }]
    });
  }
  const publicWall = round.wall;
  if (!isRecord(publicWall)
    || publicWall.seedCommitment !== input.seedCommitment
    || publicWall.wallRemaining !== remainingWall.length
    || !verifySusongSeedCommitment(input.privateSeedHex, input.seedCommitment)) {
    throw new AppError('INVALID_ACTION', {
      details: [{ path: 'privateRoundState', message: 'does not match the public wall commitment' }]
    });
  }
  for (const playerId of playerIds) {
    if (publicWall.handCountsByPlayer?.[playerId] !== handsByPlayer[playerId].length) {
      throw new AppError('INVALID_ACTION', {
        details: [{ path: `privateRoundState.handsByPlayer.${playerId}`, message: 'does not match the public count' }]
      });
    }
  }
  const orderedPlayers = [...players.values()].sort((left, right) => left.seat - right.seat);
  const dealer = orderedPlayers.find(player => player.seat === round.dealerSeat);
  try {
    const expectedWall = createSusongShuffledWall({ seed: input.privateSeedHex });
    const expectedDeal = dealSusongOpeningHands({
      wall: expectedWall,
      playerIds: orderedPlayers.map(player => player.id),
      dealerId: dealer?.id
    });
    const replayHands = clone(expectedDeal.handsByPlayer);
    let replayWall = [...expectedDeal.remainingWall];
    const replayResolved = Object.fromEntries(playerIds.map(playerId => [playerId, []]));
    const replayDiscards = Object.fromEntries(playerIds.map(playerId => [playerId, []]));
    const replayMelds = Object.fromEntries(playerIds.map(playerId => [playerId, []]));
    for (const operation of operations) {
      if (!isRecord(operation) || !playerIds.includes(operation.playerId)) {
        throw new TypeError('invalid private operation history');
      }
      if (operation.kind === 'flower') {
        if (!['discard', 'replace'].includes(operation.action)
          || !Array.isArray(operation.removedTileIds)
          || !Array.isArray(operation.drawnTileIds)) {
          throw new TypeError('invalid private flower history');
        }
        if (operation.action === 'discard' && operation.drawnTileIds.length !== 0) {
          throw new TypeError('discard history cannot draw a replacement');
        }
        if (operation.action === 'replace'
          && operation.removedTileIds.length !== operation.drawnTileIds.length) {
          throw new TypeError('replacement history must pair every removed and drawn tile');
        }
        for (let index = 0; index < operation.removedTileIds.length; index += 1) {
          const removed = String(operation.removedTileIds[index]);
          const handIndex = replayHands[operation.playerId].indexOf(removed);
          if (handIndex < 0 || !isSusongReplacementFlower(removed)) {
            throw new TypeError('flower history removes an unavailable tile');
          }
          replayHands[operation.playerId].splice(handIndex, 1);
          replayResolved[operation.playerId].push(removed);
          if (operation.action === 'replace') {
            const drawn = String(operation.drawnTileIds[index]);
            if (replayWall.at(-1) !== drawn || replayWall.length <= 14) {
              throw new TypeError('flower history draws outside the candidate tail');
            }
            replayWall.pop();
            replayHands[operation.playerId].push(drawn);
          }
        }
      } else if (operation.action === 'draw') {
        const drawn = String(operation.tileId);
        if (replayWall[0] !== drawn || replayWall.length <= 14) {
          throw new TypeError('turn history draws outside the live wall');
        }
        replayWall.shift();
        replayHands[operation.playerId].push(drawn);
      } else if (operation.action === 'discard') {
        const discarded = String(operation.tileId);
        const handIndex = replayHands[operation.playerId].indexOf(discarded);
        if (handIndex < 0 || isSusongReplacementFlower(discarded)) {
          throw new TypeError('turn history discards an unavailable tile');
        }
        replayHands[operation.playerId].splice(handIndex, 1);
        replayDiscards[operation.playerId].push(discarded);
      } else if (operation.action === 'concealed_kong') {
        if (!Array.isArray(operation.consumeTileIds) || operation.consumeTileIds.length !== 4) {
          throw new TypeError('concealed kong history must consume four private tiles');
        }
        const candidate = getSusongTurnKongCandidates({
          hand: replayHands[operation.playerId],
          melds: replayMelds[operation.playerId]
        }).find(item => item.action === 'concealed_kong'
          && canonical(item.consumeTileIds) === canonical(operation.consumeTileIds));
        if (!candidate) throw new TypeError('concealed kong history consumes unavailable private tiles');
        for (const tileId of operation.consumeTileIds) {
          const handIndex = replayHands[operation.playerId].indexOf(tileId);
          if (handIndex < 0) throw new TypeError('concealed kong tile is unavailable');
          replayHands[operation.playerId].splice(handIndex, 1);
        }
        const replacementTileId = String(operation.replacementTileId);
        if (replayWall.at(-1) !== replacementTileId || replayWall.length <= 14) {
          throw new TypeError('concealed kong history draws outside the candidate tail');
        }
        replayWall.pop();
        replayHands[operation.playerId].push(replacementTileId);
        replayMelds[operation.playerId].push({
          action: 'concealed_kong',
          playerId: operation.playerId,
          fromPlayerId: null,
          claimedTileId: null,
          tileIds: [...operation.consumeTileIds]
        });
      } else if (['chi', 'peng', 'exposed_kong'].includes(operation.action)) {
        const discarded = String(operation.tileId);
        const discarderId = String(operation.discarderId);
        const consumeCount = operation.action === 'exposed_kong' ? 3 : 2;
        if (!playerIds.includes(discarderId)
          || replayDiscards[discarderId].at(-1) !== discarded
          || !Array.isArray(operation.consumeTileIds)
          || operation.consumeTileIds.length !== consumeCount) {
          throw new TypeError('claim history does not match the latest discard');
        }
        const discarderIndex = orderedPlayers.findIndex(player => player.id === discarderId);
        const nextPlayerId = orderedPlayers[(discarderIndex + 1) % orderedPlayers.length]?.id;
        const candidate = getSusongDiscardReactionCandidates({
          hand: replayHands[operation.playerId],
          tileId: discarded,
          isNextPlayer: nextPlayerId === operation.playerId
        }).find(item => item.action === operation.action
          && canonical(item.consumeTileIds) === canonical(operation.consumeTileIds));
        if (!candidate || canonical(candidate.consumeTileIds) !== canonical(operation.consumeTileIds)) {
          throw new TypeError('claim history consumes unavailable private tiles');
        }
        for (const tileId of operation.consumeTileIds) {
          const handIndex = replayHands[operation.playerId].indexOf(tileId);
          if (handIndex < 0) throw new TypeError('peng tile is unavailable');
          replayHands[operation.playerId].splice(handIndex, 1);
        }
        replayDiscards[discarderId].pop();
        if (operation.action === 'exposed_kong') {
          const replacementTileId = String(operation.replacementTileId);
          if (replayWall.at(-1) !== replacementTileId || replayWall.length <= 14) {
            throw new TypeError('exposed kong history draws outside the candidate tail');
          }
          replayWall.pop();
          replayHands[operation.playerId].push(replacementTileId);
        }
        replayMelds[operation.playerId].push({
          action: operation.action,
          playerId: operation.playerId,
          fromPlayerId: discarderId,
          claimedTileId: discarded,
          tileIds: [...operation.consumeTileIds, discarded],
          ...(candidate.sequence ? { sequence: [...candidate.sequence] } : {})
        });
      } else {
        throw new TypeError('invalid private turn history');
      }
    }
    if (canonical(replayHands) !== canonical(handsByPlayer)
      || canonical(replayWall) !== canonical(remainingWall)
      || canonical(replayResolved) !== canonical(resolvedFlowerTilesByPlayer)
      || canonical(replayDiscards) !== canonical(publicDiscards)
      || canonical(replayMelds) !== canonical(publicMelds)
      || expectedDeal.wallVersion !== input.wallVersion
      || expectedDeal.shuffleAlgorithm !== input.shuffleAlgorithm
      || expectedDeal.dealAlgorithm !== input.dealAlgorithm
      || expectedDeal.replacementDrawPolicy !== input.replacementDrawPolicy) {
      throw new TypeError('deal replay mismatch');
    }
  } catch (cause) {
    throw new AppError('INVALID_ACTION', {
      cause,
      details: [{ path: 'privateRoundState', message: 'does not replay from its committed seed' }]
    });
  }
  return clone({
    roundId: input.roundId,
    privateSeedHex: input.privateSeedHex,
    wallVersion: input.wallVersion,
    shuffleAlgorithm: input.shuffleAlgorithm,
    dealAlgorithm: input.dealAlgorithm,
    replacementDrawPolicy: input.replacementDrawPolicy,
    seedCommitment: input.seedCommitment,
    handsByPlayer,
    remainingWall,
    resolvedFlowerTilesByPlayer,
    replacementHistory,
    turnHistory,
    nextPrivateOperationSequence
  });
}

export { canonical as stableCommandString };
