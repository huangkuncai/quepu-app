import 'dart:convert';

const protocolVersion = '1.0';
const supportedMajorVersion = 1;

final _uuid = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    caseSensitive: false);
final _version = RegExp(r'^([0-9]+)\.[0-9]+$');

class ProtocolException implements Exception {
  ProtocolException(this.code, this.message, [this.path = r'$']);

  final String code;
  final String message;
  final String path;

  @override
  String toString() => 'ProtocolException($code at $path): $message';
}

void _object(
    Map<String, dynamic> value, Set<String> allowed, List<String> required) {
  for (final key in value.keys) {
    if (!allowed.contains(key))
      throw ProtocolException(
          'VALIDATION_FAILED', 'unknown field', '\$.${key}');
  }
  for (final key in required) {
    if (!value.containsKey(key))
      throw ProtocolException(
          'VALIDATION_FAILED', 'required field is missing', '\$.${key}');
  }
}

String _string(dynamic value, String path,
    {int min = 1, int max = 4096, bool uuid = false}) {
  if (value is! String || value.length < min || value.length > max) {
    throw ProtocolException('VALIDATION_FAILED', 'invalid string', path);
  }
  if (uuid && !_uuid.hasMatch(value))
    throw ProtocolException('VALIDATION_FAILED', 'invalid UUID', path);
  return value;
}

int _nonNegativeInt(dynamic value, String path) {
  if (value is! int || value < 0)
    throw ProtocolException(
        'VALIDATION_FAILED', 'expected a non-negative integer', path);
  return value;
}

void assertCompatibleVersion(String value) {
  final match = _version.firstMatch(value);
  if (match == null || int.parse(match.group(1)!) != supportedMajorVersion) {
    throw ProtocolException('UNSUPPORTED_VERSION',
        'protocol major version is unsupported', r'$.protocolVersion');
  }
}

const commandTypes = <String>{
  'hello',
  'auth',
  'login',
  'refresh',
  'logout',
  'create_room',
  'join_room',
  'leave_room',
  'ready',
  'increase_zeng',
  'start_round',
  'begin_playing',
  'action',
  'settle_round',
  'next_round',
  'disband_room',
  'reconnect',
  'subscribe',
  'unsubscribe',
  'ping'
};

const eventTypes = <String>{
  'hello_ack',
  'auth_ok',
  'login_ok',
  'refresh_ok',
  'logout_ok',
  'command_ack',
  'room_created',
  'room_event',
  'room_sync',
  'pong',
  'error'
};

class CommandEnvelope {
  CommandEnvelope({
    required this.protocolVersion,
    required this.type,
    required this.requestId,
    required this.commandId,
    required this.payload,
    this.sessionId,
    this.roomId,
    this.roomVersion,
    this.clientTime,
  });

  final String protocolVersion;
  final String type;
  final String requestId;
  final String commandId;
  final Map<String, dynamic> payload;
  final String? sessionId;
  final String? roomId;
  final int? roomVersion;
  final DateTime? clientTime;

  factory CommandEnvelope.fromJson(Map<String, dynamic> value) {
    _object(value, {
      'protocolVersion',
      'type',
      'requestId',
      'commandId',
      'sessionId',
      'roomId',
      'roomVersion',
      'clientTime',
      'payload'
    }, [
      'protocolVersion',
      'type',
      'requestId',
      'commandId',
      'payload'
    ]);
    final version =
        _string(value['protocolVersion'], r'$.protocolVersion', max: 32);
    assertCompatibleVersion(version);
    final type = _string(value['type'], r'$.type', max: 64);
    if (!commandTypes.contains(type))
      throw ProtocolException(
          'VALIDATION_FAILED', 'unknown command type', r'$.type');
    final payload = value['payload'];
    if (payload is! Map)
      throw ProtocolException(
          'VALIDATION_FAILED', 'payload must be an object', r'$.payload');
    return CommandEnvelope(
      protocolVersion: version,
      type: type,
      requestId: _string(value['requestId'], r'$.requestId', uuid: true),
      commandId: _string(value['commandId'], r'$.commandId', uuid: true),
      payload: Map<String, dynamic>.from(payload),
      sessionId: value['sessionId'] == null
          ? null
          : _string(value['sessionId'], r'$.sessionId', uuid: true),
      roomId: value['roomId'] == null
          ? null
          : _string(value['roomId'], r'$.roomId', max: 64),
      roomVersion: value['roomVersion'] == null
          ? null
          : _nonNegativeInt(value['roomVersion'], r'$.roomVersion'),
      clientTime: value['clientTime'] == null
          ? null
          : DateTime.tryParse(
                  _string(value['clientTime'], r'$.clientTime', max: 64)) ??
              (throw ProtocolException(
                  'VALIDATION_FAILED', 'invalid date-time', r'$.clientTime')),
    );
  }

  Map<String, dynamic> toJson() => {
        'protocolVersion': protocolVersion,
        'type': type,
        'requestId': requestId,
        'commandId': commandId,
        if (sessionId != null) 'sessionId': sessionId,
        if (roomId != null) 'roomId': roomId,
        if (roomVersion != null) 'roomVersion': roomVersion,
        if (clientTime != null)
          'clientTime': clientTime!.toUtc().toIso8601String(),
        'payload': payload,
      };

  String encode() => jsonEncode(toJson());
}

class EventEnvelope {
  EventEnvelope({
    required this.protocolVersion,
    required this.type,
    required this.eventId,
    required this.roomVersion,
    required this.payload,
    required this.occurredAt,
    this.requestId,
    this.commandId,
    this.roomId,
    this.visibility,
  });

  final String protocolVersion;
  final String type;
  final String eventId;
  final int roomVersion;
  final Map<String, dynamic> payload;
  final DateTime occurredAt;
  final String? requestId;
  final String? commandId;
  final String? roomId;
  final String? visibility;

  factory EventEnvelope.fromJson(Map<String, dynamic> value) {
    _object(value, {
      'protocolVersion',
      'type',
      'eventId',
      'requestId',
      'commandId',
      'roomId',
      'roomVersion',
      'visibility',
      'payload',
      'occurredAt'
    }, [
      'protocolVersion',
      'type',
      'eventId',
      'roomVersion',
      'payload',
      'occurredAt'
    ]);
    final version =
        _string(value['protocolVersion'], r'$.protocolVersion', max: 32);
    assertCompatibleVersion(version);
    final type = _string(value['type'], r'$.type', max: 64);
    if (!eventTypes.contains(type))
      throw ProtocolException(
          'VALIDATION_FAILED', 'unknown event type', r'$.type');
    final payload = value['payload'];
    if (payload is! Map)
      throw ProtocolException(
          'VALIDATION_FAILED', 'payload must be an object', r'$.payload');
    final occurred = DateTime.tryParse(
        _string(value['occurredAt'], r'$.occurredAt', max: 64));
    if (occurred == null)
      throw ProtocolException(
          'VALIDATION_FAILED', 'invalid date-time', r'$.occurredAt');
    final visibility = value['visibility'];
    if (visibility != null &&
        !{'public', 'player', 'admin'}.contains(visibility)) {
      throw ProtocolException(
          'VALIDATION_FAILED', 'invalid visibility', r'$.visibility');
    }
    return EventEnvelope(
      protocolVersion: version,
      type: type,
      eventId: _string(value['eventId'], r'$.eventId', uuid: true),
      roomVersion: _nonNegativeInt(value['roomVersion'], r'$.roomVersion'),
      payload: Map<String, dynamic>.from(payload),
      occurredAt: occurred,
      requestId: value['requestId'] == null
          ? null
          : _string(value['requestId'], r'$.requestId', uuid: true),
      commandId: value['commandId'] == null
          ? null
          : _string(value['commandId'], r'$.commandId', uuid: true),
      roomId: value['roomId'] == null
          ? null
          : _string(value['roomId'], r'$.roomId', max: 64),
      visibility: visibility as String?,
    );
  }
}

enum ApplyResult { applied, duplicate, syncRequired }

class RoomStateReducer {
  int roomVersion = -1;
  Map<String, dynamic>? snapshot;
  bool syncRequired = false;
  final List<EventEnvelope> appliedEvents = [];

  ApplyResult apply(EventEnvelope event) {
    if (event.roomVersion <= roomVersion) return ApplyResult.duplicate;
    if (event.roomVersion > roomVersion + 1) {
      syncRequired = true;
      return ApplyResult.syncRequired;
    }
    final candidate = event.payload['snapshot'];
    if (candidate is Map) snapshot = Map<String, dynamic>.from(candidate);
    roomVersion = event.roomVersion;
    appliedEvents.add(event);
    syncRequired = false;
    return ApplyResult.applied;
  }

  void applySync(Map<String, dynamic> syncPayload) {
    final candidate = syncPayload['snapshot'];
    if (candidate is! Map)
      throw ProtocolException(
          'VALIDATION_FAILED', 'sync snapshot is required', r'$.snapshot');
    snapshot = Map<String, dynamic>.from(candidate);
    final version = snapshot!['roomVersion'] ?? snapshot!['version'];
    roomVersion = _nonNegativeInt(version, r'$.snapshot.roomVersion');
    syncRequired = false;
  }
}

enum ConnectionPhase {
  disconnected,
  connecting,
  authenticating,
  syncing,
  online,
  maintenance
}

class ConnectionStateMachine {
  ConnectionPhase phase = ConnectionPhase.disconnected;
  int attempts = 0;

  void transition(ConnectionPhase next) {
    const allowed = <ConnectionPhase, Set<ConnectionPhase>>{
      ConnectionPhase.disconnected: {
        ConnectionPhase.connecting,
        ConnectionPhase.maintenance
      },
      ConnectionPhase.connecting: {
        ConnectionPhase.authenticating,
        ConnectionPhase.disconnected,
        ConnectionPhase.maintenance
      },
      ConnectionPhase.authenticating: {
        ConnectionPhase.syncing,
        ConnectionPhase.online,
        ConnectionPhase.disconnected,
        ConnectionPhase.maintenance
      },
      ConnectionPhase.syncing: {
        ConnectionPhase.online,
        ConnectionPhase.disconnected,
        ConnectionPhase.maintenance
      },
      ConnectionPhase.online: {
        ConnectionPhase.disconnected,
        ConnectionPhase.syncing,
        ConnectionPhase.maintenance,
      },
      ConnectionPhase.maintenance: {
        ConnectionPhase.disconnected,
        ConnectionPhase.connecting
      },
    };
    if (!allowed[phase]!.contains(next)) {
      throw ProtocolException('STATE_INVALID', 'invalid connection transition',
          '\$.${phase.name}->${next.name}');
    }
    phase = next;
    if (next == ConnectionPhase.online) attempts = 0;
  }

  Duration nextBackoff(
      {Duration base = const Duration(milliseconds: 250),
      Duration maximum = const Duration(seconds: 30)}) {
    attempts += 1;
    final multiplier = 1 << (attempts - 1).clamp(0, 16);
    final delay = base * multiplier;
    return delay > maximum ? maximum : delay;
  }
}
