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
  bool _botDemoPending = false;
  String? _roomId;
  int _roomVersion = 0;
  int _botDiscardRound = 0;
  Map<String, dynamic> _room = _emptyRoom();

  @override
  Stream<Map<String, dynamic>> get messages => _messages.stream;

  @override
  Stream<void> get closed => _closed.stream;

  @override
  bool get isConnected => _connected;

  /// Arms the next locally-created room as a four-seat visual bot demo.
  /// This never crosses the protocol boundary and is unavailable to a real
  /// backend, so production rooms cannot accidentally acquire fake players.
  void enableBotDemo() {
    _botDemoPending = true;
  }

  /// Selects the local player's opening zeng count in the offline bot demo.
  Future<String> chooseBotDemoZeng(int count) async {
    if (!_connected || _room['demoMode'] != 'bots' || count < 0 || count > 5) {
      throw StateError('bot demo is not awaiting a zeng choice');
    }
    final round = Map<String, dynamic>.from(
      (_room['round'] as Map?) ?? const <String, dynamic>{},
    );
    if (round['openingStage'] != 'choose_zeng') {
      throw StateError('bot demo is not awaiting a zeng choice');
    }
    _roomVersion += 1;
    final dealtRound = _botDemoDealtRound();
    _room = {
      ..._room,
      'version': _roomVersion,
      'roomVersion': _roomVersion,
      'zengByPlayer': {
        'poc-user': count,
        'bot-east': 2,
        'bot-north': 1,
        'bot-west': 3,
      },
      'status': 'playing',
      'turnPlayerId': 'poc-user',
      'round': dealtRound,
    };
    final requestId = newProtocolId();
    final commandId = newProtocolId();
    _emitRoomEvent(requestId, commandId, 'BOT_DEMO_ZENG_CHOSEN');
    return commandId;
  }

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
        _botDiscardRound = 0;
        _room = _emptyRoom(
          Map<String, dynamic>.from(
            (payload['ruleConfig'] as Map?) ?? const <String, dynamic>{},
          ),
        );
        if (_botDemoPending) {
          _room = {
            ..._room,
            'demoMode': 'bots',
            'players': _botPlayers(),
            'connectedCount': 3,
            'readyCount': 3,
          };
        }
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
          'players': _botDemoPending
              ? players
                    .map((player) => {...player, 'ready': true})
                    .toList(growable: false)
              : players,
          'ownerId': _room['ownerId'] ?? 'poc-user',
          'connectedCount': players
              .where((player) => player['connected'] == true)
              .length,
          'version': _roomVersion,
          'roomVersion': _roomVersion,
        };
        if (_botDemoPending) {
          _room = {
            ..._room,
            'status': 'ready',
            'readyCount': 4,
            'turnPlayerId': null,
            'roundNumber': 1,
            'round': _botDemoPreStartRound(),
          };
          _botDemoPending = false;
        }
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
      case 'choose_piao':
        if (!_handleBotDemoPiao(payload['choosesPiao'] == true)) {
          _emit(_error('INVALID_ACTION', '当前不能选择飘花', requestId, commandId));
          return;
        }
        _roomVersion += 1;
        _room = {
          ..._room,
          'version': _roomVersion,
          'roomVersion': _roomVersion,
        };
        _emitRoomEvent(requestId, commandId, 'SUSONG_PIAO_CHOSEN');
      case 'resolve_flower':
        if (!_handleBotDemoFlower(payload['action']?.toString())) {
          _emit(_error('INVALID_ACTION', '当前没有待处理的花牌', requestId, commandId));
          return;
        }
        _roomVersion += 1;
        _room = {
          ..._room,
          'version': _roomVersion,
          'roomVersion': _roomVersion,
        };
        _emitRoomEvent(requestId, commandId, 'SUSONG_FLOWER_RESOLVED');
      case 'action':
        if (_roomId == null) {
          _emit(_error('ROOM_NOT_FOUND', '演示房间不存在', requestId, commandId));
          return;
        }
        _roomVersion += 1;
        if (_room['demoMode'] == 'bots') {
          final action = payload['action']?.toString();
          if (action == 'discard' && payload['args'] is Map) {
            _advanceBotDemo((payload['args'] as Map)['tileId']?.toString());
          } else if (action == 'self_draw' && _settleBotDemoSelfDraw()) {
            // The deterministic local demo uses the same server-shaped
            // settlement envelope as an authoritative room.
          } else if (!_resolveBotDemoReaction(action)) {
            _emit(_error('INVALID_ACTION', '当前动作不可用', requestId, commandId));
            return;
          }
        }
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

  void _advanceBotDemo(String? tileId) {
    if (tileId == null) return;
    final round = Map<String, dynamic>.from(
      (_room['round'] as Map?) ?? const <String, dynamic>{},
    );
    final hand = List<String>.from(
      (round['privateHand'] as List?) ?? const <String>[],
    );
    if (!hand.remove(tileId)) return;
    final discards = <String, dynamic>{
      ...Map<String, dynamic>.from(
        (round['discardsByPlayer'] as Map?) ?? const <String, dynamic>{},
      ),
    };
    void appendDiscard(String playerId, String discarded) {
      discards[playerId] = [
        ...((discards[playerId] as List?) ?? const []),
        discarded,
      ];
    }

    appendDiscard('poc-user', tileId);
    appendDiscard('bot-east', _botEastDiscards[_botDiscardRound % 3]);
    appendDiscard('bot-north', _botNorthDiscards[_botDiscardRound % 3]);
    final upstreamDiscard = _botDiscardRound.isEven
        ? 'characters-1-4'
        : 'dots-6-4';
    appendDiscard('bot-west', upstreamDiscard);
    _botDiscardRound += 1;
    final wall = Map<String, dynamic>.from(
      (round['wall'] as Map?) ?? const <String, dynamic>{},
    );
    final isChiWindow =
        upstreamDiscard == 'characters-1-4' &&
        hand.contains('characters-2-1') &&
        hand.contains('characters-3-1');
    final matchingDots = hand
        .where((candidate) => candidate.startsWith('dots-6-'))
        .length;
    final isPengWindow = upstreamDiscard == 'dots-6-4' && matchingDots >= 2;
    final reactions = isChiWindow
        ? <String>['chi', 'pass']
        : isPengWindow
        ? <String>[if (matchingDots >= 3) 'exposed_kong', 'peng', 'pass']
        : <String>['pass'];
    // The local discard lets the deterministic demo advance the three robot
    // turns. Their piao decisions and flower replacements become public only
    // now; they were intentionally hidden while only the dealer had the turn.
    final flowerStates = Map<String, dynamic>.from(
      (round['flowerStates'] as Map?) ?? const <String, dynamic>{},
    );
    final flowerTiles = Map<String, dynamic>.from(
      (round['flowerTilesByPlayer'] as Map?) ?? const <String, dynamic>{},
    );
    flowerStates['bot-east'] = {'status': 'not_piao', 'countedFlowers': 2};
    flowerStates['bot-north'] = {'status': 'not_piao', 'countedFlowers': 0};
    flowerStates['bot-west'] = {'status': 'not_piao', 'countedFlowers': 3};
    flowerTiles['bot-east'] = ['red_dragon', 'red_flower-2'];
    flowerTiles['bot-north'] = <String>[];
    flowerTiles['bot-west'] = [
      'white_dragon',
      'black_flower-3',
      'green_dragon',
    ];
    final melds = Map<String, dynamic>.from(
      (round['meldsByPlayer'] as Map?) ?? const <String, dynamic>{},
    );
    melds.putIfAbsent(
      'bot-east',
      () => [
        {
          'action': 'peng',
          'tileIds': ['dots-3-1', 'dots-3-2', 'dots-3-3'],
        },
      ],
    );
    melds.putIfAbsent(
      'bot-north',
      () => [
        {
          'action': 'chi',
          'tileIds': ['bamboo-3-1', 'bamboo-4-1', 'bamboo-5-1'],
        },
      ],
    );
    melds.putIfAbsent(
      'bot-west',
      () => [
        {
          'action': 'concealed_kong',
          'tileIds': ['east-1', 'east-2', 'east-3', 'east-4'],
        },
      ],
    );
    final handCounts = Map<String, dynamic>.from(
      (wall['handCountsByPlayer'] as Map?) ?? const <String, dynamic>{},
    );
    handCounts.addAll({'bot-east': 10, 'bot-north': 10, 'bot-west': 10});
    _room = {
      ..._room,
      'turnPlayerId': 'poc-user',
      'round': {
        ...round,
        'privateHand': hand,
        'discardsByPlayer': discards,
        'turnPhase': 'reaction',
        'pendingReaction': {
          'discarderId': 'bot-west',
          'tileId': upstreamDiscard,
        },
        'availableActions': <String>[],
        'availableReactions': reactions,
        'flowerStates': flowerStates,
        'flowerTilesByPlayer': flowerTiles,
        'meldsByPlayer': melds,
        'reactionOptions': isChiWindow
            ? {
                'chi': [
                  {
                    'candidateIndex': 0,
                    'sequence': [
                      'characters-1',
                      'characters-2',
                      'characters-3',
                    ],
                  },
                ],
              }
            : <String, dynamic>{},
        'wall': {
          ...wall,
          'handCountsByPlayer': handCounts,
          'wallRemaining': ((wall['wallRemaining'] as int? ?? 83) - 3).clamp(
            14,
            144,
          ),
        },
      },
    };
  }

  bool _resolveBotDemoReaction(String? action) {
    final round = Map<String, dynamic>.from(
      (_room['round'] as Map?) ?? const <String, dynamic>{},
    );
    final reactions = List<String>.from(
      (round['availableReactions'] as List?) ?? const <String>[],
    );
    if (action == null || !reactions.contains(action)) return false;
    final hand = List<String>.from(
      (round['privateHand'] as List?) ?? const <String>[],
    );
    final discards = Map<String, dynamic>.from(
      (round['discardsByPlayer'] as Map?) ?? const <String, dynamic>{},
    );
    final pending = Map<String, dynamic>.from(
      (round['pendingReaction'] as Map?) ?? const <String, dynamic>{},
    );
    final discarded = pending['tileId']?.toString();
    final discarderId = pending['discarderId']?.toString();
    final melds = Map<String, dynamic>.from(
      (round['meldsByPlayer'] as Map?) ?? const <String, dynamic>{},
    );
    final wall = Map<String, dynamic>.from(
      (round['wall'] as Map?) ?? const <String, dynamic>{},
    );
    var wallRemaining = wall['wallRemaining'] as int? ?? 83;

    if (action == 'pass') {
      final drawnTile = _botDrawTiles[_botDiscardRound % _botDrawTiles.length];
      final flowerStates = Map<String, dynamic>.from(
        (round['flowerStates'] as Map?) ?? const <String, dynamic>{},
      );
      final flowerTiles = Map<String, dynamic>.from(
        (round['flowerTilesByPlayer'] as Map?) ?? const <String, dynamic>{},
      );
      final flowerState = Map<String, dynamic>.from(
        (flowerStates['poc-user'] as Map?) ?? const <String, dynamic>{},
      );
      wallRemaining -= 1;
      if (_isBotDemoFlower(drawnTile) && flowerState['status'] == 'not_piao') {
        hand.add(
          _botReplacementTiles[_botDiscardRound % _botReplacementTiles.length],
        );
        wallRemaining -= 1;
        flowerStates['poc-user'] = {
          ...flowerState,
          'drawnFlowers': (flowerState['drawnFlowers'] as int? ?? 0) + 1,
          'countedFlowers': (flowerState['countedFlowers'] as int? ?? 0) + 1,
        };
        flowerTiles['poc-user'] = [
          ...((flowerTiles['poc-user'] as List?) ?? const []),
          _botDemoPublicFlower(drawnTile),
        ];
      } else if (!_isBotDemoFlower(drawnTile)) {
        hand.add(drawnTile);
      }
      _room = {
        ..._room,
        'round': {
          ...round,
          'privateHand': hand,
          'flowerStates': flowerStates,
          'flowerTilesByPlayer': flowerTiles,
          'turnPhase': 'discard',
          'pendingReaction': null,
          'availableActions': _botDemoTurnActions(hand, melds),
          'availableReactions': <String>[],
          'reactionOptions': <String, dynamic>{},
          'wall': {...wall, 'wallRemaining': wallRemaining.clamp(14, 144)},
        },
      };
      return true;
    }

    final consumed = <String>[];
    if (action == 'chi') {
      consumed.addAll(['characters-2-1', 'characters-3-1']);
    } else if (action == 'peng') {
      consumed.addAll(hand.where((tile) => tile.startsWith('dots-6-')).take(2));
    } else if (action == 'exposed_kong') {
      consumed.addAll(hand.where((tile) => tile.startsWith('dots-6-')).take(3));
    }
    if (discarded == null || consumed.any((tile) => !hand.remove(tile))) {
      return false;
    }
    if (action == 'exposed_kong') {
      hand.add(
        _botReplacementTiles[_botDiscardRound % _botReplacementTiles.length],
      );
      wallRemaining -= 1;
    }
    if (discarderId != null && discards[discarderId] is List) {
      final river = List<String>.from(discards[discarderId] as List);
      river.remove(discarded);
      discards[discarderId] = river;
    }
    melds['poc-user'] = [
      ...((melds['poc-user'] as List?) ?? const []),
      {
        'action': action,
        'tileIds': [...consumed, discarded],
      },
    ];
    final localMelds = (melds['poc-user'] as List?)?.length ?? 0;
    _room = {
      ..._room,
      'round': {
        ...round,
        'privateHand': hand,
        'discardsByPlayer': discards,
        'meldsByPlayer': melds,
        'turnPhase': 'discard',
        'pendingReaction': null,
        'availableActions': _botDemoTurnActions(hand, melds, localMelds),
        'availableReactions': <String>[],
        'reactionOptions': <String, dynamic>{},
        'wall': {...wall, 'wallRemaining': wallRemaining.clamp(14, 144)},
      },
    };
    return true;
  }

  bool _handleBotDemoPiao(bool choosesPiao) {
    if (_room['demoMode'] != 'bots' || _room['status'] != 'playing') {
      return false;
    }
    final round = Map<String, dynamic>.from(
      (_room['round'] as Map?) ?? const <String, dynamic>{},
    );
    if (round['openingStage'] != 'choose_piao') return false;
    final flowerStates = Map<String, dynamic>.from(
      (round['flowerStates'] as Map?) ?? const <String, dynamic>{},
    );
    final flowerTiles = Map<String, dynamic>.from(
      (round['flowerTilesByPlayer'] as Map?) ?? const <String, dynamic>{},
    );
    final current = Map<String, dynamic>.from(
      (flowerStates['poc-user'] as Map?) ?? const <String, dynamic>{},
    );
    final openingFlowers = current['openingFlowers'] as int? ?? 0;
    if (choosesPiao) {
      flowerStates['poc-user'] = {
        ...current,
        'status': 'piao',
        'countedFlowers': 0,
        'pendingFlowerDiscards': openingFlowers,
        'pendingFlowerReplacements': 0,
      };
      _room = {
        ..._room,
        'round': {
          ...round,
          'openingStage': 'discard_piao_flowers',
          'turnPhase': 'opening_choice',
          'flowerStates': flowerStates,
        },
      };
      return true;
    }

    final hand = List<String>.from(
      (round['privateHand'] as List?) ?? const <String>[],
    );
    final removed = hand.where(_isBotDemoFlower).toList(growable: false);
    hand.removeWhere(_isBotDemoFlower);
    hand.addAll(_botReplacementTiles.take(removed.length));
    final wall = Map<String, dynamic>.from(
      (round['wall'] as Map?) ?? const <String, dynamic>{},
    );
    final remaining = (wall['wallRemaining'] as int? ?? 83) - removed.length;
    flowerStates['poc-user'] = {
      ...current,
      'status': 'not_piao',
      'countedFlowers': removed.length,
      'pendingFlowerDiscards': 0,
      'pendingFlowerReplacements': 0,
    };
    flowerTiles['poc-user'] = removed
        .map(_botDemoPublicFlower)
        .toList(growable: false);
    _room = {
      ..._room,
      'status': 'playing',
      'turnPlayerId': 'poc-user',
      'round': {
        ...round,
        'openingStage': null,
        'turnPhase': 'discard',
        'privateHand': hand,
        'availableActions': _botDemoTurnActions(hand, round['meldsByPlayer']),
        'flowerStates': flowerStates,
        'flowerTilesByPlayer': flowerTiles,
        'wall': {...wall, 'wallRemaining': remaining.clamp(14, 144)},
      },
    };
    return true;
  }

  bool _handleBotDemoFlower(String? action) {
    if (_room['demoMode'] != 'bots' || action != 'discard') return false;
    final round = Map<String, dynamic>.from(
      (_room['round'] as Map?) ?? const <String, dynamic>{},
    );
    if (round['openingStage'] != 'discard_piao_flowers') return false;
    final flowerStates = Map<String, dynamic>.from(
      (round['flowerStates'] as Map?) ?? const <String, dynamic>{},
    );
    final flowerTiles = Map<String, dynamic>.from(
      (round['flowerTilesByPlayer'] as Map?) ?? const <String, dynamic>{},
    );
    final current = Map<String, dynamic>.from(
      (flowerStates['poc-user'] as Map?) ?? const <String, dynamic>{},
    );
    final pending = current['pendingFlowerDiscards'] as int? ?? 0;
    if (pending <= 0) return false;
    final hand = List<String>.from(
      (round['privateHand'] as List?) ?? const <String>[],
    );
    final flowerIndex = hand.indexWhere(_isBotDemoFlower);
    if (flowerIndex < 0) return false;
    final removedFlower = hand.removeAt(flowerIndex);
    final nextPending = pending - 1;
    flowerStates['poc-user'] = {
      ...current,
      'pendingFlowerDiscards': nextPending,
    };
    flowerTiles['poc-user'] = [
      ...((flowerTiles['poc-user'] as List?) ?? const []),
      _botDemoPublicFlower(removedFlower),
    ];
    _room = {
      ..._room,
      'status': 'playing',
      'turnPlayerId': 'poc-user',
      'round': {
        ...round,
        'openingStage': nextPending == 0 ? null : 'discard_piao_flowers',
        'turnPhase': nextPending == 0 ? 'discard' : 'opening_choice',
        'privateHand': hand,
        'availableActions': nextPending == 0 ? ['discard'] : <String>[],
        'flowerStates': flowerStates,
        'flowerTilesByPlayer': flowerTiles,
      },
    };
    return true;
  }

  bool _settleBotDemoSelfDraw() {
    final round = Map<String, dynamic>.from(
      (_room['round'] as Map?) ?? const <String, dynamic>{},
    );
    if (!(List<String>.from(
      (round['availableActions'] as List?) ?? const <String>[],
    )).contains('self_draw')) {
      return false;
    }
    const deltas = {
      'poc-user': 15,
      'bot-east': -5,
      'bot-north': -5,
      'bot-west': -5,
    };
    const scoreOrderVersion = 'zeng-piao-flower-sanxi-v1';
    final transfers = ['bot-east', 'bot-north', 'bot-west']
        .map(
          (payerId) => {
            'kind': 'win',
            'from': payerId,
            'to': 'poc-user',
            'amount': 5,
            'tier': 'small',
            'scoreOrderVersion': scoreOrderVersion,
            'trace': const [
              {'stage': 'winner_zeng', 'value': 0},
              {'stage': 'payer_zeng', 'value': 0},
              {'stage': 'piao', 'status': 'not_piao', 'value': 0},
              {'stage': 'flower_tier', 'value': 5},
              {'stage': 'sanxi', 'multiplier': 1, 'value': 5},
            ],
          },
        )
        .toList();
    _room = {
      ..._room,
      'status': 'settling',
      'turnPlayerId': null,
      'scores': deltas,
      'round': {
        ...round,
        'turnPhase': null,
        'availableActions': <String>[],
        'settlement': {
          'outcome': 'self_draw',
          'winnerIds': ['poc-user'],
          'deltaByPlayer': deltas,
          'scoreOrderVersion': scoreOrderVersion,
          'wins': [
            {
              'winnerId': 'poc-user',
              'tier': 'small',
              'flowerCount':
                  ((round['flowerStates'] as Map?)?['poc-user']
                      as Map?)?['countedFlowers'] ??
                  0,
              'piao': false,
              'gangWinCount': 0,
            },
          ],
          'transfers': transfers,
          'releasedSanxiPairs': <List<String>>[],
        },
      },
    };
    return true;
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

  static List<Map<String, dynamic>> _botPlayers() => [
    {
      'id': 'bot-east',
      'displayName': '小松机器人',
      'seat': 1,
      'ready': true,
      'connected': true,
    },
    {
      'id': 'bot-north',
      'displayName': '小竹机器人',
      'seat': 2,
      'ready': true,
      'connected': true,
    },
    {
      'id': 'bot-west',
      'displayName': '小菊机器人',
      'seat': 3,
      'ready': true,
      'connected': true,
    },
  ];

  static Map<String, dynamic> _botDemoPreStartRound() => {
    'roundNumber': 1,
    'openingStage': 'choose_zeng',
    'turnPhase': null,
    'dealerSeat': null,
    'privateHand': <String>[],
    'availableActions': <String>[],
    'availableReactions': <String>[],
  };

  static Map<String, dynamic> _botDemoDealtRound() => {
    'roundNumber': 1,
    'openingStage': 'choose_piao',
    'turnPhase': 'opening_choice',
    'dealerSeat': 0,
    'turnDeadlineAt': DateTime.now()
        .subtract(const Duration(seconds: 1))
        .toUtc()
        .toIso8601String(),
    'wall': {
      'wallRemaining': 83,
      'handCountsByPlayer': {
        'poc-user': 14,
        'bot-east': 13,
        'bot-north': 13,
        'bot-west': 13,
      },
    },
    'discardsByPlayer': <String, dynamic>{
      'poc-user': <String>[],
      'bot-east': <String>[],
      'bot-north': <String>[],
      'bot-west': <String>[],
    },
    'meldsByPlayer': <String, dynamic>{},
    'flowerStates': {
      'poc-user': {
        'status': 'awaiting_piao_choice',
        'openingFlowers': 5,
        'countedFlowers': 0,
        'pendingFlowerDiscards': 5,
        'pendingFlowerReplacements': 0,
      },
      'bot-east': {'status': 'not_activated', 'countedFlowers': 0},
      'bot-north': {'status': 'not_activated', 'countedFlowers': 0},
      'bot-west': {'status': 'not_activated', 'countedFlowers': 0},
    },
    'flowerTilesByPlayer': {
      'poc-user': <String>[],
      'bot-east': <String>[],
      'bot-north': <String>[],
      'bot-west': <String>[],
    },
    'privateHand': [
      'characters-1-1',
      'characters-2-1',
      'characters-3-1',
      'characters-5-1',
      'characters-6-1',
      'characters-7-1',
      'bamboo-2-1',
      'bamboo-2-2',
      'dots-6-1',
      'red_dragon-1',
      'green_dragon-1',
      'white_dragon-1',
      'red_flower-1',
      'black_flower-1',
    ],
    'availableActions': <String>[],
    'availableReactions': <String>[],
  };

  static const _botEastDiscards = ['east-4', 'bamboo-1-4', 'dots-9-4'];

  static const _botNorthDiscards = ['south-3', 'west-3', 'north-3'];

  static const _botDrawTiles = ['dots-2-4', 'characters-9-4', 'green_dragon-4'];

  static const _botReplacementTiles = [
    'dots-1-2',
    'dots-2-2',
    'dots-3-2',
    'dots-6-2',
    'dots-6-3',
  ];

  static bool _isBotDemoFlower(String tileId) => const {
    'red_dragon',
    'green_dragon',
    'white_dragon',
    'red_flower',
    'black_flower',
  }.contains(tileId.replaceFirst(RegExp(r'-\d+$'), ''));

  static String _botDemoPublicFlower(String tileId) =>
      RegExp(r'^(red|black)_flower-[1-4]$').hasMatch(tileId)
      ? tileId
      : tileId.replaceFirst(RegExp(r'-\d+$'), '');

  static List<String> _botDemoTurnActions(
    List<String> hand,
    Object? rawMelds, [
    int? knownMeldCount,
  ]) {
    final melds = rawMelds is Map ? rawMelds['poc-user'] : null;
    final meldCount = knownMeldCount ?? (melds is List ? melds.length : 0);
    return ['discard', if (_isBotDemoWinningHand(hand, meldCount)) 'self_draw'];
  }

  static bool _isBotDemoWinningHand(List<String> hand, int meldCount) {
    final faces = hand
        .where((tile) => !_isBotDemoFlower(tile))
        .map((tile) => tile.replaceFirst(RegExp(r'-\d+$'), ''))
        .toList(growable: false);
    final required = (4 - meldCount) * 3 + 2;
    if (faces.length != required) return false;
    final counts = <String, int>{};
    for (final face in faces) {
      counts[face] = (counts[face] ?? 0) + 1;
    }
    if (meldCount == 0 &&
        counts.length == 7 &&
        counts.values.every((count) => count == 2)) {
      return true;
    }
    for (final pair in counts.keys.toList(growable: false)) {
      if ((counts[pair] ?? 0) < 2) continue;
      final remaining = Map<String, int>.from(counts);
      remaining[pair] = remaining[pair]! - 2;
      if (_consumeBotDemoMelds(remaining)) return true;
    }
    return false;
  }

  static bool _consumeBotDemoMelds(Map<String, int> counts) {
    final face = counts.keys.cast<String?>().firstWhere(
      (candidate) => (counts[candidate] ?? 0) > 0,
      orElse: () => null,
    );
    if (face == null) return true;
    if ((counts[face] ?? 0) >= 3) {
      final triplet = Map<String, int>.from(counts);
      triplet[face] = triplet[face]! - 3;
      if (_consumeBotDemoMelds(triplet)) return true;
    }
    final suited = RegExp(r'^(characters|bamboo|dots)-(\d)$').firstMatch(face);
    final value = int.tryParse(suited?.group(2) ?? '');
    if (suited != null && value != null && value <= 7) {
      final next = '${suited.group(1)}-${value + 1}';
      final after = '${suited.group(1)}-${value + 2}';
      if ((counts[next] ?? 0) > 0 && (counts[after] ?? 0) > 0) {
        final sequence = Map<String, int>.from(counts);
        sequence[face] = sequence[face]! - 1;
        sequence[next] = sequence[next]! - 1;
        sequence[after] = sequence[after]! - 1;
        if (_consumeBotDemoMelds(sequence)) return true;
      }
    }
    return false;
  }
}
