import 'dart:convert';

import '../lib/protocol.dart';

void expect(bool condition, String message) {
  if (!condition) throw StateError(message);
}

String id(int value) =>
    '${value.toRadixString(16).padLeft(8, '0')}-1111-4111-8111-111111111111';

void main() {
  final command = CommandEnvelope.fromJson({
    'protocolVersion': '1.1',
    'type': 'join_room',
    'requestId': id(1),
    'commandId': id(2),
    'payload': {'name': 'player'},
  });
  expect(jsonDecode(command.encode())['type'] == 'join_room',
      'command round trip failed');

  for (final type in [
    'leave_room',
    'ready',
    'begin_playing',
    'settle_round',
    'next_round',
    'disband_room',
  ]) {
    final extended = CommandEnvelope.fromJson({
      'protocolVersion': '1.0',
      'type': type,
      'requestId': id(type.hashCode & 0xff),
      'commandId': id((type.hashCode + 1) & 0xff),
      'payload': <String, dynamic>{},
    });
    expect(extended.type == type, 'extended command was rejected: $type');
  }

  try {
    CommandEnvelope.fromJson({...command.toJson(), 'unknown': true});
    throw StateError('unknown field was accepted');
  } on ProtocolException catch (error) {
    expect(error.code == 'VALIDATION_FAILED', 'wrong validation error');
  }

  final reducer = RoomStateReducer();
  EventEnvelope event(int version) => EventEnvelope.fromJson({
        'protocolVersion': '1.0',
        'type': 'room_event',
        'eventId': id(version + 10),
        'roomVersion': version,
        'payload': {
          'snapshot': {'roomVersion': version}
        },
        'occurredAt': '2026-08-28T00:00:00Z',
      });
  expect(reducer.apply(event(0)) == ApplyResult.applied, 'first event failed');
  expect(reducer.apply(event(0)) == ApplyResult.duplicate,
      'duplicate event applied');
  expect(reducer.apply(event(2)) == ApplyResult.syncRequired,
      'gap was not detected');
  reducer.applySync({
    'snapshot': {'roomVersion': 2}
  });
  expect(reducer.roomVersion == 2 && !reducer.syncRequired,
      'sync did not recover');

  final state = ConnectionStateMachine();
  state.transition(ConnectionPhase.connecting);
  state.transition(ConnectionPhase.authenticating);
  state.transition(ConnectionPhase.online);
  expect(state.nextBackoff().inMilliseconds == 250, 'backoff mismatch');

  try {
    CommandEnvelope.fromJson({...command.toJson(), 'protocolVersion': '2.0'});
    throw StateError('unsupported version was accepted');
  } on ProtocolException catch (error) {
    expect(error.code == 'UNSUPPORTED_VERSION', 'wrong version error');
  }
  print(
      'dart protocol: envelope, gap detection, state machine and version tests passed');
}
