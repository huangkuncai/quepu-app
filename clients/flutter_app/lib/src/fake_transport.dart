import 'dart:async';

import 'package:susong_protocol_client/client.dart';

/// Deterministic in-process gateway for the G1 POC. It mirrors the envelope
/// shapes of the Node development server and intentionally has no billing or
/// real-rule behavior.
class FakeTransport implements ProtocolTransport {
  final _messages = StreamController<Map<String, dynamic>>.broadcast();
  final _closed = StreamController<void>.broadcast();
  final _history = <Map<String, dynamic>>[];
  final sentMessages = <Map<String, dynamic>>[];
  bool emitCommandAcks = true;
  int failNextSends = 0;
  bool _connected = false;
  String? _roomId;
  int _roomVersion = 0;
  Map<String, dynamic> _room = _emptyRoom();

  @override
  Stream<Map<String, dynamic>> get messages => _messages.stream;

  @override
  Stream<void> get closed => _closed.stream;

  @override
  bool get isConnected => _connected;

  @override
  Future<void> connect() async {
    _connected = true;
  }

  @override
  Future<void> send(Map<String, dynamic> message) async {
    if (!_connected) throw StateError('fake transport is disconnected');
    sentMessages.add(Map<String, dynamic>.from(message));
    if (failNextSends > 0) {
      failNextSends -= 1;
      throw StateError('injected fake transport failure');
    }
    final type = message['type']?.toString();
    final commandId = message['commandId']?.toString();
    final requestId = message['requestId']?.toString();
    final payload = message['payload'] is Map
        ? Map<String, dynamic>.from(message['payload'] as Map)
        : <String, dynamic>{};
    await Future<void>.delayed(const Duration(milliseconds: 12));
    switch (type) {
      case 'hello':
        _emit(
          _event(
            'hello_ack',
            {
              'protocolVersion': '1.0',
              'serverTime': DateTime.now().toUtc().toIso8601String(),
              'authenticated': false,
            },
            requestId: requestId,
            commandId: commandId,
          ),
        );
      case 'login':
        _emit(
          _event(
            'login_ok',
            {
              'accessToken': 'poc-access-token',
              'refreshToken': 'poc-refresh-token',
              'sessionId': newProtocolId(),
              'expiresIn': 900,
              'user': {'id': 'poc-user', 'displayName': '演示玩家'},
            },
            requestId: requestId,
            commandId: commandId,
          ),
        );
      case 'auth':
        _emit(
          _event(
            'auth_ok',
            {
              'sessionId': 'poc-session',
              'userId': 'poc-user',
              'displayName': '演示玩家',
            },
            requestId: requestId,
            commandId: commandId,
          ),
        );
      case 'refresh':
        _emit(
          _event(
            'refresh_ok',
            {
              'accessToken': 'poc-access-token-2',
              'refreshToken': 'poc-refresh-token-2',
              'sessionId': 'poc-session',
              'expiresIn': 900,
              'user': {'id': 'poc-user', 'displayName': '演示玩家'},
            },
            requestId: requestId,
            commandId: commandId,
          ),
        );
      case 'logout':
        _emit(
          _event(
            'logout_ok',
            {'sessionId': 'poc-session'},
            requestId: requestId,
            commandId: commandId,
          ),
        );
      case 'ping':
        _emit(
          _event(
            'pong',
            {'serverTime': DateTime.now().toUtc().toIso8601String()},
            requestId: requestId,
            commandId: commandId,
          ),
        );
      case 'create_room':
        _roomId = 'demo-room';
        _roomVersion = 0;
        _room = _emptyRoom(
          Map<String, dynamic>.from(
            (payload['ruleConfig'] as Map?) ?? const <String, dynamic>{},
          ),
        );
        _history.clear();
        _emit(
          _event(
            'room_created',
            _room,
            requestId: requestId,
            commandId: commandId,
            roomId: _roomId,
          ),
        );
        _emitCommandAck(requestId, commandId, _roomId, _roomVersion);
      case 'join_room':
        final roomId = message['roomId']?.toString() ?? _roomId;
        if (roomId == null) {
          _emit(_error('ROOM_NOT_FOUND', '演示房间不存在', requestId, commandId));
          return;
        }
        _roomId = roomId;
        _roomVersion += 1;
        final players = List<Map<String, dynamic>>.from(
          (_room['players'] as List?) ?? const [],
        );
        if (!players.any((player) => player['id'] == 'poc-user')) {
          final occupiedSeats = players
              .map((player) => player['seat'])
              .whereType<int>()
              .toSet();
          final seat = List<int>.generate(4, (index) => index).firstWhere(
            (index) => !occupiedSeats.contains(index),
            orElse: () => 0,
          );
          players.add({
            'id': 'poc-user',
            'name': payload['name'] ?? '演示玩家',
            'seat': seat,
            'connected': true,
          });
        }
        _room = {
          ..._room,
          'players': players,
          'ownerId': _room['ownerId'] ?? 'poc-user',
          'connectedCount': players
              .where((player) => player['connected'] == true)
              .length,
          'version': _roomVersion,
          'roomVersion': _roomVersion,
        };
        _emitRoomEvent(requestId, commandId, 'PLAYER_JOINED');
      case 'ready':
        if (_roomId == null) {
          _emit(_error('ROOM_NOT_FOUND', '演示房间不存在', requestId, commandId));
          return;
        }
        final readyPlayer = payload['playerId']?.toString() ?? 'poc-user';
        final readyPlayers = List<Map<String, dynamic>>.from(
          (_room['players'] as List?) ?? const [],
        );
        final readyIndex = readyPlayers.indexWhere(
          (player) => player['id']?.toString() == readyPlayer,
        );
        if (readyIndex < 0) {
          _emit(_error('PLAYER_NOT_FOUND', '演示玩家尚未入座', requestId, commandId));
          return;
        }
        final isReady = payload['ready'] != false;
        readyPlayers[readyIndex] = {
          ...readyPlayers[readyIndex],
          'ready': isReady,
        };
        _roomVersion += 1;
        final everyoneReady =
            readyPlayers.isNotEmpty &&
            readyPlayers.every((player) => player['ready'] == true);
        _room = {
          ..._room,
          'players': readyPlayers,
          'readyCount': readyPlayers
              .where((player) => player['ready'] == true)
              .length,
          'status': everyoneReady ? 'ready' : 'waiting',
          'version': _roomVersion,
          'roomVersion': _roomVersion,
        };
        _emitRoomEvent(requestId, commandId, 'PLAYER_READY');
      case 'action':
        if (_roomId == null) {
          _emit(_error('ROOM_NOT_FOUND', '演示房间不存在', requestId, commandId));
          return;
        }
        _roomVersion += 1;
        _room = {
          ..._room,
          'version': _roomVersion,
          'roomVersion': _roomVersion,
        };
        _emitRoomEvent(requestId, commandId, 'ACTION_APPLIED');
      case 'start_round':
        _roomVersion += 1;
        _room = {
          ..._room,
          'status': 'playing',
          'version': _roomVersion,
          'roomVersion': _roomVersion,
          'turn': 'poc-user',
        };
        _emitRoomEvent(requestId, commandId, 'ROUND_STARTED');
      case 'reconnect':
        if (_roomId == null) {
          _emit(_error('ROOM_NOT_FOUND', '演示房间不存在', requestId, commandId));
          return;
        }
        _emit(
          _event(
            'room_sync',
            {'snapshot': _room, 'events': _history},
            requestId: requestId,
            commandId: commandId,
            roomId: _roomId,
            roomVersion: _roomVersion,
            visibility: 'player',
          ),
        );
      default:
        _emit(_error('INVALID_MESSAGE', '演示网关不支持此命令', requestId, commandId));
    }
  }

  void simulateDisconnect() {
    if (!_connected) return;
    _connected = false;
    _closed.add(null);
  }

  /// Test hook for the CL-203 maintenance banner.  A real gateway would send
  /// the same error envelope during a rolling drain or scheduled outage.
  void simulateMaintenance({
    String code = 'SERVICE_MAINTENANCE',
    String message = '演示服务维护中，请稍后重试',
  }) {
    if (!_connected) return;
    _emit(_error(code, message, null, null, retryable: true));
  }

  /// Test hook for a stale expected room version.  The command remains in the
  /// controller outbox so the UI can explicitly retry it after synchronization.
  void simulateVersionConflict({String? commandId, String? roomId}) {
    if (!_connected) return;
    final selected =
        commandId ??
        sentMessages
            .lastWhere(
              (message) => message['roomId'] != null,
              orElse: () => <String, dynamic>{},
            )['commandId']
            ?.toString();
    _emit(
      _error(
        'VERSION_CONFLICT',
        '演示房间版本已更新，请同步后重试',
        null,
        selected,
        roomId: roomId ?? _roomId,
        retryable: true,
      ),
    );
  }

  /// Test hook for duplicate, delayed or out-of-order server events.
  void inject(Map<String, dynamic> message) => _emit(message);

  @override
  Future<void> close() async {
    _connected = false;
    await _messages.close();
    await _closed.close();
  }

  void _emitRoomEvent(String? requestId, String? commandId, String eventType) {
    final event = {
      'version': _roomVersion,
      'type': eventType,
      'payload': {'snapshot': _room},
      'at': DateTime.now().toUtc().toIso8601String(),
    };
    _history.add(event);
    _emit(
      _event(
        'room_event',
        {'snapshot': _room, 'latest': event},
        requestId: requestId,
        commandId: commandId,
        roomId: _roomId,
        roomVersion: _roomVersion,
      ),
    );
    _emitCommandAck(requestId, commandId, _roomId, _roomVersion);
  }

  void _emitCommandAck(
    String? requestId,
    String? commandId,
    String? roomId,
    int roomVersion,
  ) {
    if (commandId == null || !emitCommandAcks) return;
    _emit(
      _event(
        'command_ack',
        {'accepted': true, 'roomVersion': roomVersion, 'version': roomVersion},
        requestId: requestId,
        commandId: commandId,
        roomId: roomId,
        roomVersion: roomVersion,
      ),
    );
  }

  void _emit(Map<String, dynamic> message) {
    if (_connected && !_messages.isClosed) _messages.add(message);
  }

  Map<String, dynamic> _event(
    String type,
    Map<String, dynamic> payload, {
    String? requestId,
    String? commandId,
    String? roomId,
    int roomVersion = 0,
    String? visibility,
  }) {
    return {
      'protocolVersion': '1.0',
      'type': type,
      'eventId': newProtocolId(),
      ...?(requestId == null ? null : {'requestId': requestId}),
      ...?(commandId == null ? null : {'commandId': commandId}),
      ...?(roomId == null ? null : {'roomId': roomId}),
      'roomVersion': roomVersion,
      ...?(visibility == null ? null : {'visibility': visibility}),
      'payload': payload,
      'occurredAt': DateTime.now().toUtc().toIso8601String(),
    };
  }

  Map<String, dynamic> _error(
    String code,
    String message,
    String? requestId,
    String? commandId, {
    String? roomId,
    bool retryable = false,
  }) {
    return {
      'protocolVersion': '1.0',
      'type': 'error',
      'requestId': requestId ?? newProtocolId(),
      ...?(commandId == null ? null : {'commandId': commandId}),
      ...?(roomId == null ? null : {'roomId': roomId}),
      'error': {'code': code, 'message': message, 'retryable': retryable},
    };
  }

  static Map<String, dynamic> _emptyRoom([
    Map<String, dynamic> ruleConfig = const {},
  ]) => {
    'id': 'demo-room',
    'clubId': null,
    'rule': 'susong_v1',
    'ruleVersion': '8931-apk-baseline.3',
    'ruleConfig': {
      'rounds': ruleConfig['rounds'] ?? 4,
      'scoreTiers': ruleConfig['scoreTiers'] ?? [1, 2, 3, 4],
      'zeng': ruleConfig['zeng'] ?? 1,
      'piao': ruleConfig['piao'] ?? 'optional',
      'forcedHu': ruleConfig['forcedHu'] ?? false,
    },
    'totalRounds': ruleConfig['rounds'] ?? 4,
    'status': 'waiting',
    'maxPlayers': 4,
    'version': 0,
    'roomVersion': 0,
    'turn': null,
    'players': <Map<String, dynamic>>[],
    'scores': <String, dynamic>{},
  };
}
