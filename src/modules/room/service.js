import { createHash, randomUUID } from 'node:crypto';

import { Room, stableCommandString } from '../../domain/room.js';
import {
  normalizeSusongConfig,
  SUSONG_SCORE_ORDER_VERSION,
  susongRule
} from '../../domain/rules/susong.js';
import { scoreSusongRound } from '../../domain/rules/susong-scoring.js';
import { AppError } from '../../shared/errors.js';

const ROOM_COMMAND_TYPES = new Set([
  'join_room',
  'leave_room',
  'ready',
  'increase_zeng',
  'choose_piao',
  'resolve_flower',
  'start_round',
  'begin_playing',
  'action',
  'settle_round',
  'next_round',
  'disband_room'
]);

function clone(value) {
  if (value === undefined || value === null) return value;
  return structuredClone(value);
}

function text(value, field, { required = true, max = 256 } = {}) {
  if (value === undefined || value === null) {
    if (!required) return null;
    throw new AppError('INVALID_ACTION', {
      details: [{ path: field, message: 'is required' }]
    });
  }
  const normalized = String(value).trim();
  if (!normalized && required) {
    throw new AppError('INVALID_ACTION', {
      details: [{ path: field, message: 'must not be blank' }]
    });
  }
  if (!normalized && !required) return null;
  if (normalized.length > max) {
    throw new AppError('INVALID_ACTION', {
      details: [{ path: field, message: `must be <= ${max} characters` }]
    });
  }
  return normalized;
}

function principalId(principal) {
  return text(principal?.userId, 'principal.userId', { max: 128 });
}

function isAdmin(principal) {
  return principal?.role === 'ADMIN' || principal?.role === 'CLUB_ADMIN';
}

function hashCommand(command, actorId) {
  return createHash('sha256').update(stableCommandString({
    type: command.type,
    actorId: actorId || null,
    payload: command.payload || {}
  })).digest('hex');
}

function commandIdOf(value) {
  return text(value || randomUUID(), 'commandId', { max: 256 });
}

function requestIdOf(value) {
  return text(value || randomUUID(), 'requestId', { max: 256 });
}

function stableSystemCommandId(namespace, sourceId) {
  const bytes = createHash('sha256').update(`${namespace}:${sourceId}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function susongOpeningResolved(room) {
  const states = Object.values(room.currentRound?.flowerStates ?? {});
  return states.length === room.players.size && states.length > 0 && states.every(state =>
    state?.status !== 'awaiting_piao_choice'
    && state?.pendingFlowerDiscards === 0
    && state?.pendingFlowerReplacements === 0);
}

function roomSnapshot(room, viewerId) {
  return clone(room.snapshot({ viewerId }));
}

/**
 * Shared room application service used by the WSS and REST adapters.
 *
 * It intentionally owns no transport concerns. Every mutating operation goes
 * through RoomActorRegistry, so REST cannot create a second ordering or
 * persistence path beside WebSocket commands.
 */
export class RoomService {
  constructor({ registry, rooms = new Map(), deadlines, idFactory = randomUUID, logger } = {}) {
    if (!registry || typeof registry.dispatch !== 'function') {
      throw new TypeError('RoomService requires a room actor registry');
    }
    this.registry = registry;
    this.rooms = rooms;
    this.deadlines = deadlines;
    this.idFactory = idFactory;
    this.logger = logger;
  }

  _assertPrincipal(principal) {
    principalId(principal);
    return principal;
  }

  async _actor(roomId) {
    const id = text(roomId, 'roomId', { max: 128 });
    const actor = this.registry.get(id) || await this.registry.recover(id);
    if (!actor?.room) throw new AppError('ROOM_NOT_FOUND');
    return actor;
  }

  _canView(room, principal, { membershipApproved = false, invited = false } = {}) {
    const userId = principalId(principal);
    if (isAdmin(principal) || room.ownerId === userId || room.players.has(userId)) return true;
    if (room.accessPolicy === 'PUBLIC_CODE') return true;
    if (room.accessPolicy === 'INVITE_ONLY' && invited === true) return true;
    if (room.accessPolicy === 'MEMBERS_ONLY' && membershipApproved === true) return true;
    return false;
  }

  async getRoom({ roomId, principal, membershipApproved = false, invited = false } = {}) {
    this._assertPrincipal(principal);
    const actor = await this._actor(roomId);
    if (!this._canView(actor.room, principal, { membershipApproved, invited })) {
      throw new AppError('FORBIDDEN');
    }
    return {
      room: roomSnapshot(actor.room, principal.userId),
      roomVersion: actor.version,
      replay: false
    };
  }

  /**
   * Read the authoritative room state for transport preconditions. This is an
   * internal adapter hook; callers must still apply their own viewer policy
   * before returning the snapshot to a client.
   */
  async currentRoom({ roomId } = {}) {
    const actor = await this._actor(roomId);
    return {
      room: roomSnapshot(actor.room),
      roomVersion: actor.version
    };
  }

  async createRoom({ principal, payload = {}, commandId, requestId } = {}) {
    this._assertPrincipal(principal);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new AppError('INVALID_ACTION');
    }
    const command = {
      type: 'create_room',
      commandId: commandIdOf(commandId),
      requestId: requestIdOf(requestId),
      payload: clone(payload)
    };
    const actorId = principal.userId;
    const requestHash = hashCommand(command, actorId);
    const prior = await this.registry.findCommandResult?.(command.commandId);
    if (prior) {
      if (prior.requestHash !== requestHash) throw new AppError('DUPLICATE_REQUEST');
      const priorRoomId = prior.result?.roomId || prior.roomId;
      if (!priorRoomId) throw new AppError('VERSION_CONFLICT');
      const actor = await this._actor(priorRoomId);
      return {
        room: roomSnapshot(actor.room, actorId),
        roomVersion: actor.version,
        roomId: actor.room.id,
        replay: true,
        commandId: command.commandId,
        requestId: command.requestId
      };
    }

    const roomId = text(String(this.idFactory()).slice(0, 8), 'roomId', { max: 64 });
    const requestedRuleId = payload.ruleId
      || payload.ruleSnapshot?.ruleId
      || payload.ruleVersion
      || payload.ruleSnapshot?.ruleVersion
      || 'susong_v1';
    let ruleSnapshot = payload.ruleSnapshot;
    let totalRounds = payload.totalRounds || payload.roundCount;
    let maxPlayers = payload.maxPlayers || 4;
    if (requestedRuleId === susongRule.id) {
      try {
        const config = normalizeSusongConfig(ruleSnapshot?.config ?? payload.ruleConfig);
        ruleSnapshot = {
          gameType: 'mahjong',
          ruleId: susongRule.id,
          ruleVersion: susongRule.version,
          scoreOrderVersion: SUSONG_SCORE_ORDER_VERSION,
          config
        };
        totalRounds = config.rounds;
        maxPlayers = susongRule.players;
      } catch (error) {
        throw new AppError('INVALID_ACTION', {
          details: [{ path: 'ruleConfig', message: error.message }]
        });
      }
    }
    const room = new Room({
      id: roomId,
      clubId: payload.clubId || null,
      floorId: payload.floorId || null,
      rule: payload.ruleVersion || 'susong_v1',
      ruleId: payload.ruleId,
      ruleVersion: payload.ruleVersion,
      gameType: payload.gameType,
      ruleConfig: payload.ruleConfig,
      ruleSnapshot,
      accessPolicy: payload.accessPolicy || payload.roomAccessPolicy,
      totalRounds,
      deadlinePolicy: payload.deadlinePolicy,
      ownerId: actorId,
      maxPlayers
    });
    this.rooms.set(roomId, room);
    this.registry.register(room, roomId);
    const snapshot = roomSnapshot(room, actorId);
    try {
      await this.registry.initialize(roomId, snapshot, {
        commandId: command.commandId,
        requestHash,
        result: {
          accepted: true,
          roomId,
          roomVersion: room.version,
          version: room.version,
          snapshot
        }
      });
    } catch (error) {
      this.registry.delete(roomId);
      throw error;
    }
    this.deadlines?.refresh?.(room);
    return {
      room: snapshot,
      roomId,
      roomVersion: room.version,
      replay: false,
      commandId: command.commandId,
      requestId: command.requestId
    };
  }

  async dispatch({ roomId, principal, type, payload = {}, commandId, requestId, roomVersion } = {}) {
    this._assertPrincipal(principal);
    const normalizedType = text(type, 'type', { max: 64 }).toLowerCase();
    if (!ROOM_COMMAND_TYPES.has(normalizedType)) throw new AppError('INVALID_ACTION');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new AppError('INVALID_ACTION');
    }
    const actor = await this._actor(roomId);
    if (normalizedType === 'settle_round' && actor.room.ruleId === susongRule.id) {
      throw new AppError('INVALID_ACTION', {
        details: [{
          path: 'type',
          message: 'Susong settlement is authored by the server rule engine'
        }]
      });
    }
    const command = {
      protocolVersion: '1.0',
      type: normalizedType,
      roomId: actor.room.id,
      commandId: commandIdOf(commandId),
      requestId: requestIdOf(requestId),
      ...(roomVersion === undefined || roomVersion === null ? {} : { roomVersion }),
      payload: clone(payload)
    };
    const beforeVersion = actor.version;
    if (normalizedType === 'start_round') {
      command.payload = {
        ...command.payload,
        autoAdvance: actor.room.ruleId !== susongRule.id,
        bypassReady: true
      };
    } else if (normalizedType === 'next_round' && actor.room.ruleId === susongRule.id) {
      // A Susong next-round command is one server-owned lifecycle transition:
      // select the dealer from the previous settlement, open the round, then
      // deal from a fresh private wall. Clients cannot split or override it.
      command.payload = { ...command.payload, autoDeal: true };
    }
    let result = await this.registry.dispatch(actor.room.id, command, {
      actorId: principal.userId,
      commandId: command.commandId,
      requestId: command.requestId,
      expectedRoomVersion: roomVersion,
      membershipApproved: payload.membershipApproved ?? payload.isMember,
      invited: payload.invited,
      isAdmin: isAdmin(principal)
    });
    if (normalizedType === 'start_round' && actor.room.ruleId === susongRule.id) {
      result = await this._dispatchSusongSystem({
        roomId: actor.room.id,
        type: 'deal_susong_round',
        payload: {},
        commandId: stableSystemCommandId('susong:deal', command.commandId),
        requestId: command.requestId,
        roomVersion: result.roomVersion ?? actor.version
      });
    } else if (normalizedType === 'next_round'
      && actor.room.ruleId === susongRule.id
      && actor.room.status === 'dealing') {
      result = await this._dispatchSusongSystem({
        roomId: actor.room.id,
        type: 'deal_susong_round',
        payload: {},
        commandId: stableSystemCommandId('susong:deal-next', command.commandId),
        requestId: command.requestId,
        roomVersion: result.roomVersion ?? actor.version
      });
    }
    if (actor.room.ruleId === susongRule.id
      && actor.room.status === 'dealing'
      && susongOpeningResolved(actor.room)) {
      result = await this._dispatchSusongSystem({
        roomId: actor.room.id,
        type: 'begin_playing',
        payload: {},
        // The round ID makes concurrent final flower resolutions converge on
        // one durable transition instead of racing separate system commands.
        commandId: stableSystemCommandId('susong:begin-playing', actor.room.roundId),
        requestId: command.requestId,
        roomVersion: result.roomVersion ?? actor.version
      });
    }
    const currentRoom = actor.room;
    this.deadlines?.refresh?.(currentRoom);
    const afterVersion = result.roomVersion ?? actor.version;
    return {
      ...clone(result),
      room: roomSnapshot(currentRoom, principal.userId),
      snapshot: roomSnapshot(currentRoom, principal.userId),
      roomId: currentRoom.id,
      roomVersion: afterVersion,
      version: afterVersion,
      replay: afterVersion <= beforeVersion,
      commandId: command.commandId,
      requestId: command.requestId
    };
  }

  /** Internal rule-engine entry point; it is intentionally not mounted on REST/WSS. */
  async settleSusongRound({ roomId, facts = {}, commandId, requestId, roomVersion } = {}) {
    const actor = await this._actor(roomId);
    if (actor.room.ruleId !== susongRule.id) throw new AppError('INVALID_ACTION');
    const players = [...actor.room.players.values()]
      .sort((left, right) => left.seat - right.seat)
      .map(player => player.id);
    const scoringFacts = clone(facts);
    if ((scoringFacts.outcome ?? scoringFacts.winSource) !== 'draw') {
      const flowerStates = actor.room.currentRound?.flowerStates;
      if (!flowerStates) throw new AppError('INVALID_ACTION', {
        details: [{ path: 'round.flowerStates', message: 'authoritative flower state is not initialized' }]
      });
      if (Array.isArray(scoringFacts.winners)) {
        scoringFacts.winners = scoringFacts.winners.map(winner => {
          const playerId = winner.winnerId ?? winner.playerId;
          if (!flowerStates[playerId]) throw new AppError('INVALID_ACTION');
          return { ...winner, flowerState: clone(flowerStates[playerId]) };
        });
      } else {
        if (!flowerStates[scoringFacts.winnerId]) throw new AppError('INVALID_ACTION');
        scoringFacts.flowerState = clone(flowerStates[scoringFacts.winnerId]);
      }
    }
    const settlement = scoreSusongRound({
      ...scoringFacts,
      config: actor.room.ruleSnapshot.config,
      playerIds: players,
      zengByPlayer: Object.fromEntries(actor.room.zengByPlayer)
    });
    const command = {
      protocolVersion: '1.0',
      type: 'settle_round',
      roomId: actor.room.id,
      commandId: commandIdOf(commandId),
      requestId: requestIdOf(requestId),
      ...(roomVersion === undefined || roomVersion === null ? {} : { roomVersion }),
      payload: { result: settlement }
    };
    const result = await this.registry.dispatch(actor.room.id, command, {
      actorId: 'system:susong-rule-engine',
      actorRole: 'SYSTEM',
      commandId: command.commandId,
      requestId: command.requestId,
      expectedRoomVersion: roomVersion
    });
    this.deadlines?.refresh?.(actor.room);
    return {
      ...clone(result),
      room: roomSnapshot(actor.room),
      snapshot: roomSnapshot(actor.room),
      roomId: actor.room.id,
      roomVersion: result.roomVersion ?? actor.version,
      version: result.roomVersion ?? actor.version,
      commandId: command.commandId,
      requestId: command.requestId
    };
  }

  async initializeSusongRoundFlowers({
    roomId,
    openingFlowerCountByPlayer,
    commandId,
    requestId,
    roomVersion
  } = {}) {
    return this._dispatchSusongSystem({
      roomId,
      type: 'initialize_susong_flowers',
      payload: { openingFlowerCountByPlayer: clone(openingFlowerCountByPlayer) },
      commandId,
      requestId,
      roomVersion
    });
  }

  async dealSusongRound({ roomId, seed, dealerSeat, commandId, requestId, roomVersion } = {}) {
    return this._dispatchSusongSystem({
      roomId,
      type: 'deal_susong_round',
      payload: {
        ...(seed === undefined ? {} : { seed }),
        ...(dealerSeat === undefined ? {} : { dealerSeat })
      },
      commandId,
      requestId,
      roomVersion
    });
  }

  async recordSusongRoundFlowerDraw({
    roomId,
    playerId,
    count = 1,
    commandId,
    requestId,
    roomVersion
  } = {}) {
    return this._dispatchSusongSystem({
      roomId,
      type: 'record_susong_flower_draw',
      payload: { playerId, count },
      commandId,
      requestId,
      roomVersion
    });
  }

  async _dispatchSusongSystem({ roomId, type, payload, commandId, requestId, roomVersion }) {
    const actor = await this._actor(roomId);
    if (actor.room.ruleId !== susongRule.id) throw new AppError('INVALID_ACTION');
    const command = {
      protocolVersion: '1.0',
      type,
      roomId: actor.room.id,
      commandId: commandIdOf(commandId),
      requestId: requestIdOf(requestId),
      ...(roomVersion === undefined || roomVersion === null ? {} : { roomVersion }),
      payload
    };
    const result = await this.registry.dispatch(actor.room.id, command, {
      actorId: 'system:susong-rule-engine',
      actorRole: 'SYSTEM',
      commandId: command.commandId,
      requestId: command.requestId,
      expectedRoomVersion: roomVersion
    });
    this.deadlines?.refresh?.(actor.room);
    return {
      ...clone(result),
      room: roomSnapshot(actor.room),
      snapshot: roomSnapshot(actor.room),
      roomId: actor.room.id,
      roomVersion: result.roomVersion ?? actor.version,
      version: result.roomVersion ?? actor.version,
      commandId: command.commandId,
      requestId: command.requestId
    };
  }
}

export function createRoomService(options = {}) {
  return new RoomService(options);
}

export { ROOM_COMMAND_TYPES, hashCommand };
