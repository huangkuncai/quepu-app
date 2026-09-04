import 'dart:async';
import 'dart:convert';

import '../lib/client.dart';
import '../lib/protocol.dart';

/// A framework-neutral CL-201 acceptance fixture.
///
/// The fixture intentionally lives next to the shared Dart protocol package,
/// rather than in Flutter, so the same session/reducer contract can be
/// exercised by Flutter, ArkUI-X or another shell.  It is a deterministic
/// in-process gateway; it is not a production server and does not implement
/// Mahjong rules, scoring or a diamond ledger.
Future<void> main() async {
  final gateway = _SharedRoomGateway();
  final transports = List<_LinkedTransport>.generate(
    4,
    (index) => gateway.attach('player-${index + 1}'),
  );
  final clients = List<ClientSessionController>.generate(
    transports.length,
    (index) => ClientSessionController(
      transport: transports[index],
      deviceId: 'cl201-device-${index + 1}',
      platform: 'dart-fixture',
      commandTimeout: const Duration(seconds: 2),
      retryBackoff: const Duration(milliseconds: 10),
    ),
  );

  try {
    await Future.wait(
      List<Future<void>>.generate(
        clients.length,
        (index) => clients[index].login(
          '138000000${(index + 1).toString().padLeft(2, '0')}',
          '000000',
        ),
      ),
    );
    await _drain();
    _assert(
      clients
          .every((client) => client.snapshot.phase == ConnectionPhase.online),
      'all four clients must be online after login',
    );

    await clients.first.createRoom();
    await _drain();
    const roomId = 'demo-room';
    _assert(clients.first.snapshot.roomId == roomId,
        'fixture room id changed unexpectedly');

    // All four independent controllers enter the same room.  The gateway
    // serializes these commands and broadcasts one versioned event to every
    // connected transport.
    await Future.wait(
      List<Future<String>>.generate(
        clients.length,
        (index) => clients[index].joinRoom(
          roomId,
          name: '玩家${index + 1}',
        ),
      ),
    );
    await _drain();

    final versions =
        clients.map((client) => client.snapshot.roomVersion).toList();
    final hashes = clients
        .map((client) =>
            client.snapshot.roomSnapshot?['snapshotHash']?.toString())
        .toList();
    final traces =
        transports.map((transport) => transport.roomEventVersions).toList();

    _assert(versions.every((version) => version == 4),
        'all clients must converge to roomVersion 4: $versions');
    _assert(hashes.every((hash) => hash != null && hash == hashes.first),
        'all clients must converge to one snapshotHash: $hashes');
    _assert(
      traces.every((trace) => _sameList(trace, const [1, 2, 3, 4])),
      'all clients must receive the same ordered room events: $traces',
    );
    _assert(
      clients.every((client) => client.snapshot.pendingCommandCount == 0),
      'all join commands must be acknowledged',
    );

    // A reconnecting client must recover the authoritative snapshot without
    // changing the already observed event order.
    transports[3].simulateDisconnect();
    await _drain();
    _assert(clients[3].snapshot.phase == ConnectionPhase.disconnected,
        'fourth client did not enter disconnected state');
    await clients[3].connect();
    await _drain();
    _assert(clients[3].snapshot.phase == ConnectionPhase.online,
        'fourth client did not return online');
    await clients[3].reconnectRoom(roomId);
    await _drain();
    _assert(clients[3].snapshot.roomVersion == 4,
        'reconnected client did not recover roomVersion 4');
    _assert(
      clients[3].snapshot.roomSnapshot?['snapshotHash'] == hashes.first,
      'reconnected client snapshotHash differs from peers',
    );

    final result = <String, dynamic>{
      'status': 'ok',
      'fixture': 'CL-201-multi-client',
      'clientCount': clients.length,
      'roomId': roomId,
      'roomVersion': versions.first,
      'snapshotHash': hashes.first,
      'eventVersions': traces.first,
      'reconnect': {
        'clientIndex': 3,
        'roomVersion': clients[3].snapshot.roomVersion,
        'snapshotHash': clients[3].snapshot.roomSnapshot?['snapshotHash'],
      },
      'productionBoundary':
          'in-process fake gateway only; no real WSS, device or signing evidence',
    };
    print(jsonEncode(result));
  } finally {
    for (final client in clients) {
      await client.dispose();
    }
  }
}

Future<void> _drain() => Future<void>.delayed(const Duration(milliseconds: 25));

void _assert(bool condition, String message) {
  if (!condition) throw StateError(message);
}

bool _sameList<T>(List<T> left, List<T> right) {
  if (left.length != right.length) return false;
  for (var index = 0; index < left.length; index += 1) {
    if (left[index] != right[index]) return false;
  }
  return true;
}

class _LinkedTransport implements ProtocolTransport {
  _LinkedTransport(this.gateway, this.userId);

  final _SharedRoomGateway gateway;
  final String userId;
  final StreamController<Map<String, dynamic>> _messages =
      StreamController<Map<String, dynamic>>.broadcast();
  final StreamController<void> _closed = StreamController<void>.broadcast();
  final List<int> roomEventVersions = <int>[];
  bool _connected = false;

  @override
  Stream<Map<String, dynamic>> get messages => _messages.stream;

  @override
  Stream<void> get closed => _closed.stream;

  @override
  bool get isConnected => _connected;

  @override
  Future<void> connect() async {
    if (_messages.isClosed) throw StateError('fixture transport is closed');
    _connected = true;
  }

  @override
  Future<void> send(Map<String, dynamic> message) async {
    if (!_connected) throw StateError('fixture transport is disconnected');
    await gateway.dispatch(this, Map<String, dynamic>.from(message));
  }

  /// Simulates a network drop while keeping the transport reusable for a
  /// later connect.  `ClientSessionController.dispose` performs final close.
  void simulateDisconnect() {
    if (!_connected) return;
    _connected = false;
    if (!_closed.isClosed) _closed.add(null);
  }

  void deliver(Map<String, dynamic> message) {
    if (!_connected || _messages.isClosed) return;
    final copy = _deepCopy(message);
    if (copy['type'] == 'room_event' && copy['roomVersion'] is int) {
      roomEventVersions.add(copy['roomVersion'] as int);
    }
    _messages.add(copy);
  }

  @override
  Future<void> close() async {
    if (!_connected && _messages.isClosed) return;
    _connected = false;
    gateway.detach(this);
    if (!_closed.isClosed) await _closed.close();
    if (!_messages.isClosed) await _messages.close();
  }
}

class _SharedRoomGateway {
  final Set<_LinkedTransport> _transports = <_LinkedTransport>{};
  final List<Map<String, dynamic>> _history = <Map<String, dynamic>>[];
  final List<Map<String, dynamic>> _players = <Map<String, dynamic>>[];
  int _roomVersion = 0;
  bool _roomCreated = false;

  _LinkedTransport attach(String userId) {
    final transport = _LinkedTransport(this, userId);
    _transports.add(transport);
    return transport;
  }

  void detach(_LinkedTransport transport) => _transports.remove(transport);

  Future<void> dispatch(
    _LinkedTransport sender,
    Map<String, dynamic> message,
  ) async {
    final type = message['type']?.toString();
    final requestId = message['requestId']?.toString();
    final commandId = message['commandId']?.toString();
    switch (type) {
      case 'hello':
        sender.deliver(_event(
          'hello_ack',
          {
            'protocolVersion': '1.0',
            'serverTime': DateTime.now().toUtc().toIso8601String(),
            'authenticated': false,
          },
          requestId: requestId,
          commandId: commandId,
        ));
      case 'login':
        sender.deliver(_event(
          'login_ok',
          {
            'accessToken': 'fixture-access-${sender.userId}',
            'refreshToken': 'fixture-refresh-${sender.userId}',
            'sessionId': _sessionId(sender.userId),
            'expiresIn': 900,
            'user': {'id': sender.userId, 'displayName': sender.userId},
          },
          requestId: requestId,
          commandId: commandId,
        ));
      case 'auth':
        sender.deliver(_event(
          'auth_ok',
          {
            'sessionId': _sessionId(sender.userId),
            'userId': sender.userId,
            'displayName': sender.userId,
          },
          requestId: requestId,
          commandId: commandId,
        ));
      case 'create_room':
        _roomCreated = true;
        _roomVersion = 0;
        _history.clear();
        _players.clear();
        final snapshot = _snapshot();
        sender.deliver(_event(
          'room_created',
          snapshot,
          requestId: requestId,
          commandId: commandId,
          roomId: 'demo-room',
          roomVersion: 0,
        ));
        sender.deliver(_event(
          'command_ack',
          {'accepted': true, 'roomVersion': 0, 'version': 0},
          requestId: requestId,
          commandId: commandId,
          roomId: 'demo-room',
          roomVersion: 0,
        ));
      case 'join_room':
        if (!_roomCreated) {
          sender.deliver(_error(
            'ROOM_NOT_FOUND',
            'fixture room has not been created',
            requestId,
            commandId,
          ));
          return;
        }
        if (_players.every((player) => player['id'] != sender.userId)) {
          final payload = message['payload'];
          final name = payload is Map ? payload['name']?.toString() : null;
          _players.add({
            'id': sender.userId,
            'name': name ?? sender.userId,
            'connected': true,
            'ready': false,
          });
        }
        _roomVersion += 1;
        _broadcastRoomEvent(
          'PLAYER_JOINED',
          sender: sender,
          requestId: requestId,
          commandId: commandId,
        );
      case 'reconnect':
        if (!_roomCreated) {
          sender.deliver(_error(
            'ROOM_NOT_FOUND',
            'fixture room has not been created',
            requestId,
            commandId,
          ));
          return;
        }
        sender.deliver(_event(
          'room_sync',
          {
            'snapshot': _snapshot(),
            'events': _history.map(_deepCopy).toList(growable: false),
            'snapshotHash': _snapshot()['snapshotHash'],
          },
          requestId: requestId,
          commandId: commandId,
          roomId: 'demo-room',
          roomVersion: _roomVersion,
          visibility: 'player',
        ));
      default:
        sender.deliver(_error(
          'INVALID_MESSAGE',
          'fixture gateway does not support $type',
          requestId,
          commandId,
        ));
    }
  }

  void _broadcastRoomEvent(
    String eventType, {
    required _LinkedTransport sender,
    String? requestId,
    String? commandId,
  }) {
    final snapshot = _snapshot();
    final event = _event(
      'room_event',
      {
        'snapshot': snapshot,
        'latest': {
          'type': eventType,
          'version': _roomVersion,
          'roomVersion': _roomVersion,
        },
      },
      requestId: requestId,
      commandId: commandId,
      roomId: 'demo-room',
      roomVersion: _roomVersion,
    );
    _history.add(_deepCopy(event));
    for (final transport in _transports) {
      transport.deliver(event);
    }
    // ACK is sent only to the command origin.  The room event itself remains
    // a broadcast and never completes another client's outbox entry.
    if (commandId != null && requestId != null) {
      sender.deliver(_event(
        'command_ack',
        {
          'accepted': true,
          'roomVersion': _roomVersion,
          'version': _roomVersion,
        },
        requestId: requestId,
        commandId: commandId,
        roomId: 'demo-room',
        roomVersion: _roomVersion,
      ));
    }
  }

  Map<String, dynamic> _snapshot() {
    final value = <String, dynamic>{
      'id': 'demo-room',
      'rule': 'susong_v1',
      'status': 'waiting',
      'version': _roomVersion,
      'roomVersion': _roomVersion,
      'turn': null,
      'players': _players.map(_deepCopy).toList(growable: false),
      'scores': {
        for (final player in _players) player['id'].toString(): 0,
      },
    };
    value['snapshotHash'] = _stableHash(value);
    return value;
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
      'eventId': _eventId(type, roomVersion, _history.length),
      if (requestId != null) 'requestId': requestId,
      if (commandId != null) 'commandId': commandId,
      if (roomId != null) 'roomId': roomId,
      'roomVersion': roomVersion,
      if (visibility != null) 'visibility': visibility,
      'payload': payload,
      'occurredAt': DateTime.now().toUtc().toIso8601String(),
    };
  }

  Map<String, dynamic> _error(
    String code,
    String message,
    String? requestId,
    String? commandId,
  ) {
    return {
      'protocolVersion': '1.0',
      'type': 'error',
      'requestId':
          requestId ?? _eventId('error', _roomVersion, _history.length),
      if (commandId != null) 'commandId': commandId,
      if (_roomCreated) 'roomId': 'demo-room',
      'error': {'code': code, 'message': message, 'retryable': false},
    };
  }

  static String _sessionId(String userId) =>
      '00000000-0000-4000-8000-${userId.hashCode.abs().toRadixString(16).padLeft(12, '0').substring(0, 12)}';

  static String _eventId(String type, int version, int sequence) {
    final seed = (type.hashCode.abs() + version * 97 + sequence * 193) & 0xffff;
    return '00000000-0000-4000-8000-${seed.toRadixString(16).padLeft(12, '0')}';
  }
}

/// Canonical JSON plus FNV-1a gives the fixture a stable, dependency-free
/// snapshot hash.  Production adapters use SHA-256; this hash is only for
/// convergence assertions in the local acceptance test.
String _stableHash(Map<String, dynamic> value) {
  final canonical = jsonEncode(_canonical(value));
  var hash = 0xcbf29ce484222325;
  for (final codeUnit in canonical.codeUnits) {
    hash ^= codeUnit;
    hash = (hash * 0x100000001b3) & 0xffffffffffffffff;
  }
  return hash.toRadixString(16).padLeft(16, '0');
}

dynamic _canonical(dynamic value) {
  if (value is Map) {
    final keys = value.keys.map((key) => key.toString()).toList()..sort();
    return <String, dynamic>{
      for (final key in keys) key: _canonical(value[key]),
    };
  }
  if (value is Iterable) return value.map(_canonical).toList(growable: false);
  return value;
}

Map<String, dynamic> _deepCopy(Map<String, dynamic> value) =>
    jsonDecode(jsonEncode(value)) as Map<String, dynamic>;
