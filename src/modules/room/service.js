import { createHash, randomUUID } from 'node:crypto';

import { Room, stableCommandString } from '../../domain/room.js';
import { normalizeSusongConfig, susongRule } from '../../domain/rules/susong.js';
import { AppError } from '../../shared/errors.js';

const ROOM_COMMAND_TYPES = new Set([
  'join_room',
  'leave_room',
  'ready',
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
      command.payload = { ...command.payload, autoAdvance: true, bypassReady: true };
    }
    const result = await this.registry.dispatch(actor.room.id, command, {
      actorId: principal.userId,
      commandId: command.commandId,
      requestId: command.requestId,
      expectedRoomVersion: roomVersion,
      membershipApproved: payload.membershipApproved ?? payload.isMember,
      invited: payload.invited,
      isAdmin: isAdmin(principal)
    });
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
}

export function createRoomService(options = {}) {
  return new RoomService(options);
}

export { ROOM_COMMAND_TYPES, hashCommand };
