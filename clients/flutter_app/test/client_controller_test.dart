import 'package:flutter_test/flutter_test.dart';
import 'package:susong_protocol_client/client.dart';
import 'package:susong_protocol_client/protocol.dart';

import 'package:susong_app/src/fake_transport.dart';

bool _isReplacementFlower(String tileId) => const {
  'red_dragon',
  'green_dragon',
  'white_dragon',
  'red_flower',
  'black_flower',
}.contains(tileId.replaceFirst(RegExp(r'-\d+$'), ''));

void main() {
  test('session authorization is scoped to the request callback', () async {
    final client = ClientSessionController(
      transport: FakeTransport(),
      deviceId: 'auth-adapter-device',
      platform: 'android',
    );
    expect(
      () => client.runAuthorized((_) async => true),
      throwsA(isA<StateError>()),
    );
    await client.login('13800000000', '000000');
    await Future<void>.delayed(const Duration(milliseconds: 30));
    final authorized = await client.runAuthorized((token) async {
      expect(token, isNotEmpty);
      return true;
    });
    expect(authorized, isTrue);
    await client.dispose();
  });

  test(
    'game action forwards only the selected server candidate arguments',
    () async {
      final transport = FakeTransport();
      final client = ClientSessionController(
        transport: transport,
        deviceId: 'test-device',
        platform: 'android',
      );
      await client.login('13800000000', '000000');
      await Future<void>.delayed(const Duration(milliseconds: 30));
      await client.createRoom();
      await Future<void>.delayed(const Duration(milliseconds: 30));

      await client.action('demo-room', 'chi', args: {'candidateIndex': 1});
      final message = transport.sentMessages.lastWhere(
        (entry) => entry['type'] == 'action',
      );
      expect(message['payload'], {
        'action': 'chi',
        'args': {'candidateIndex': 1},
      });
      await client.dispose();
    },
  );

  test('session controller recovers a room after transport loss', () async {
    final transport = FakeTransport();
    final client = ClientSessionController(
      transport: transport,
      deviceId: 'test-device',
      platform: 'web',
    );

    await client.login('13800000000', '000000');
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(client.snapshot.phase, ConnectionPhase.online);

    await client.createRoom();
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(client.snapshot.roomId, 'demo-room');
    expect(client.snapshot.roomVersion, 0);
    expect(client.snapshot.pendingCommandCount, 0);

    await client.joinRoom('demo-room');
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(client.snapshot.roomVersion, 1);

    transport.simulateDisconnect();
    await Future<void>.delayed(const Duration(milliseconds: 1));
    expect(client.snapshot.phase, ConnectionPhase.disconnected);

    await client.connect();
    await Future<void>.delayed(const Duration(milliseconds: 60));
    expect(client.snapshot.phase, ConnectionPhase.online);
    await client.reconnectRoom('demo-room');
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(client.snapshot.roomVersion, 1);
    expect(client.snapshot.syncRequired, isFalse);

    await client.dispose();
  });

  test(
    'local bot demo runs zeng, piao and automatic flower replacement',
    () async {
      final transport = FakeTransport()..enableBotDemo();
      final client = ClientSessionController(
        transport: transport,
        deviceId: 'bot-demo-device',
        platform: 'android',
      );

      await client.login('13800000000', '000000');
      await Future<void>.delayed(const Duration(milliseconds: 30));
      await client.createRoom();
      await client.joinRoom('demo-room');
      await Future<void>.delayed(const Duration(milliseconds: 30));

      var room = client.snapshot.roomSnapshot!;
      expect(room['status'], 'ready');
      expect(room['readyCount'], 4);
      expect(room['connectedCount'], 4);
      expect((room['players'] as List), hasLength(4));
      expect(((room['round'] as Map)['privateHand'] as List), isEmpty);
      expect((room['round'] as Map)['openingStage'], 'choose_zeng');

      await transport.chooseBotDemoZeng(2);
      await Future<void>.delayed(const Duration(milliseconds: 30));
      room = client.snapshot.roomSnapshot!;
      expect((room['zengByPlayer'] as Map)['poc-user'], 2);
      expect((room['round'] as Map)['openingStage'], 'choose_piao');
      expect(room['status'], 'playing');
      expect(room['turnPlayerId'], 'poc-user');
      final beforePiaoRound = room['round'] as Map;
      final beforePiaoHand = List<String>.from(
        beforePiaoRound['privateHand'] as List,
      );
      expect(beforePiaoHand, hasLength(14));
      expect(beforePiaoHand.where(_isReplacementFlower), hasLength(5));
      expect(
        (beforePiaoRound['flowerTilesByPlayer'] as Map).values.expand(
          (value) => value as List,
        ),
        isEmpty,
      );
      expect(
        ((beforePiaoRound['flowerStates'] as Map)['bot-east'] as Map)['status'],
        'not_activated',
      );

      await client.choosePiao('demo-room', false);
      await Future<void>.delayed(const Duration(milliseconds: 30));
      room = client.snapshot.roomSnapshot!;
      expect(room['status'], 'playing');
      final openedRound = room['round'] as Map;
      final openedHand = List<String>.from(openedRound['privateHand'] as List);
      expect(openedHand, hasLength(14));
      expect(openedHand.any(_isReplacementFlower), isFalse);
      expect(
        ((openedRound['flowerStates'] as Map)['poc-user']
            as Map)['countedFlowers'],
        5,
      );
      expect((openedRound['wall'] as Map)['wallRemaining'], 78);
      expect(openedRound['availableActions'], contains('self_draw'));

      await client.action(
        'demo-room',
        'discard',
        args: const {'tileId': 'characters-1-1'},
      );
      await Future<void>.delayed(const Duration(milliseconds: 30));
      final advancedRound = client.snapshot.roomSnapshot!['round'] as Map;
      expect((advancedRound['privateHand'] as List), hasLength(13));
      expect(
        (advancedRound['discardsByPlayer'] as Map)['poc-user'],
        contains('characters-1-1'),
      );
      expect(
        (advancedRound['flowerTilesByPlayer'] as Map)['bot-east'],
        isNotEmpty,
      );
      expect(advancedRound['turnPhase'], 'reaction');
      expect(advancedRound['availableReactions'], containsAll(['chi', 'pass']));
      expect((advancedRound['reactionOptions'] as Map)['chi'], isNotEmpty);
      expect((advancedRound['wall'] as Map)['wallRemaining'], 75);

      await client.action('demo-room', 'pass');
      await Future<void>.delayed(const Duration(milliseconds: 30));
      final afterChiPass = client.snapshot.roomSnapshot!['round'] as Map;
      expect((afterChiPass['privateHand'] as List), hasLength(14));
      expect(afterChiPass['availableActions'], contains('discard'));
      expect((afterChiPass['wall'] as Map)['wallRemaining'], 74);

      await client.action(
        'demo-room',
        'discard',
        args: const {'tileId': 'characters-2-1'},
      );
      await Future<void>.delayed(const Duration(milliseconds: 30));
      final pengRound = client.snapshot.roomSnapshot!['round'] as Map;
      expect(
        pengRound['availableReactions'],
        containsAll(['exposed_kong', 'peng', 'pass']),
      );
      expect((pengRound['wall'] as Map)['wallRemaining'], 71);

      await client.action('demo-room', 'pass');
      await Future<void>.delayed(const Duration(milliseconds: 30));
      final flowerDrawRound = client.snapshot.roomSnapshot!['round'] as Map;
      final flowerDrawHand = List<String>.from(
        flowerDrawRound['privateHand'] as List,
      );
      expect(flowerDrawHand, hasLength(14));
      expect(flowerDrawHand.any(_isReplacementFlower), isFalse);
      expect(
        ((flowerDrawRound['flowerStates'] as Map)['poc-user']
            as Map)['countedFlowers'],
        6,
      );
      expect((flowerDrawRound['wall'] as Map)['wallRemaining'], 69);
      expect(
        (flowerDrawRound['flowerTilesByPlayer'] as Map)['poc-user'],
        containsAll([
          'red_dragon',
          'green_dragon',
          'white_dragon',
          'red_flower-1',
          'black_flower-1',
        ]),
      );
      await client.dispose();
    },
  );

  test('local bot demo offers and settles a valid self draw', () async {
    final transport = FakeTransport()..enableBotDemo();
    final client = ClientSessionController(
      transport: transport,
      deviceId: 'bot-demo-win-device',
      platform: 'android',
    );

    await client.login('13800000000', '000000');
    await Future<void>.delayed(const Duration(milliseconds: 30));
    await client.createRoom();
    await client.joinRoom('demo-room');
    await Future<void>.delayed(const Duration(milliseconds: 30));
    await transport.chooseBotDemoZeng(2);
    await Future<void>.delayed(const Duration(milliseconds: 30));
    await client.choosePiao('demo-room', false);
    await Future<void>.delayed(const Duration(milliseconds: 30));

    await client.action('demo-room', 'self_draw');
    await Future<void>.delayed(const Duration(milliseconds: 30));
    final room = client.snapshot.roomSnapshot!;
    final settlement = (room['round'] as Map)['settlement'] as Map;
    expect(room['status'], 'settling');
    expect(settlement['outcome'], 'self_draw');
    expect(settlement['winnerIds'], ['poc-user']);
    expect(settlement['transfers'], hasLength(3));
    expect((settlement['deltaByPlayer'] as Map)['poc-user'], 15);

    await client.nextRound('demo-room');
    await Future<void>.delayed(const Duration(milliseconds: 30));
    final nextRoom = client.snapshot.roomSnapshot!;
    final nextRound = nextRoom['round'] as Map;
    expect(nextRoom['status'], 'ready');
    expect(nextRound['roundNumber'], 2);
    expect(nextRound['openingStage'], 'choose_zeng');
    expect(nextRound['settlement'], isNull);
    expect((nextRoom['scores'] as Map)['poc-user'], 15);

    await transport.chooseBotDemoZeng(1);
    await Future<void>.delayed(const Duration(milliseconds: 30));
    final dealtNextRound = client.snapshot.roomSnapshot!['round'] as Map;
    expect(dealtNextRound['roundNumber'], 2);
    expect(dealtNextRound['openingStage'], 'choose_piao');

    await client.dispose();
  });

  test(
    'fresh controller adopts room id from an authoritative room sync',
    () async {
      final transport = FakeTransport();
      final client = ClientSessionController(
        transport: transport,
        deviceId: 'replacement-device',
        platform: 'android',
      );
      await client.login('13800000004', '000000');
      await Future<void>.delayed(const Duration(milliseconds: 30));

      transport.inject({
        'protocolVersion': '1.0',
        'type': 'room_sync',
        'eventId': newProtocolId(),
        'roomId': 'recovered-room',
        'roomVersion': 3,
        'visibility': 'player',
        'payload': {
          'snapshot': {
            'id': 'recovered-room',
            'roomVersion': 3,
            'version': 3,
            'snapshotHash': 'authoritative-hash',
          },
          'events': const [],
          'snapshotHash': 'authoritative-hash',
          'fromRoomVersion': 0,
          'toRoomVersion': 3,
          'syncRequired': false,
        },
        'occurredAt': DateTime.now().toUtc().toIso8601String(),
      });
      await Future<void>.delayed(const Duration(milliseconds: 10));

      expect(client.snapshot.roomId, 'recovered-room');
      expect(client.snapshot.roomVersion, 3);
      expect(client.snapshot.syncRequired, isFalse);
      await client.dispose();
    },
  );

  test(
    'business commands are blocked until online and gaps request sync',
    () async {
      final transport = FakeTransport();
      final client = ClientSessionController(
        transport: transport,
        deviceId: 'test-device',
        platform: 'web',
      );

      await expectLater(client.createRoom(), throwsA(isA<ProtocolException>()));
      await client.login('13800000000', '000000');
      await Future<void>.delayed(const Duration(milliseconds: 30));
      await client.createRoom();
      await Future<void>.delayed(const Duration(milliseconds: 30));

      transport.inject({
        'protocolVersion': '1.0',
        'type': 'room_event',
        'eventId': newProtocolId(),
        'roomId': 'demo-room',
        'roomVersion': 3,
        'payload': {
          'snapshot': {'roomVersion': 3},
        },
        'occurredAt': DateTime.now().toUtc().toIso8601String(),
      });
      await Future<void>.delayed(const Duration(milliseconds: 60));
      expect(client.snapshot.phase, ConnectionPhase.online);
      expect(client.snapshot.syncRequired, isFalse);
      expect(client.snapshot.roomVersion, 0);

      await client.dispose();
    },
  );

  test('idempotent room command remains in outbox across disconnect', () async {
    final transport = FakeTransport();
    final client = ClientSessionController(
      transport: transport,
      deviceId: 'test-device',
      platform: 'web',
    );
    await client.login('13800000000', '000000');
    await Future<void>.delayed(const Duration(milliseconds: 30));

    final pendingCreate = client.createRoom();
    transport.simulateDisconnect();
    await pendingCreate;
    expect(client.snapshot.pendingCommandCount, 1);

    await client.connect();
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(client.snapshot.phase, ConnectionPhase.online);
    expect(client.snapshot.roomId, 'demo-room');
    expect(client.snapshot.pendingCommandCount, 0);

    await client.dispose();
  });

  test(
    'room events do not ACK commands and timeout retry keeps commandId',
    () async {
      final transport = FakeTransport()..emitCommandAcks = false;
      final client = ClientSessionController(
        transport: transport,
        deviceId: 'test-device',
        platform: 'web',
        commandTimeout: const Duration(milliseconds: 20),
        retryBackoff: const Duration(milliseconds: 2),
      );

      await client.login('13800000000', '000000');
      await Future<void>.delayed(const Duration(milliseconds: 30));
      await client.createRoom();
      await Future<void>.delayed(const Duration(milliseconds: 30));

      final commandId = await client.joinRoom('demo-room');
      expect(client.snapshot.pendingCommandCount, 1);
      await Future<void>.delayed(const Duration(milliseconds: 45));

      final attempts = transport.sentMessages
          .where((message) => message['type'] == 'join_room')
          .toList();
      expect(attempts.length, greaterThanOrEqualTo(2));
      expect(attempts.map((message) => message['commandId']).toSet(), {
        commandId,
      });
      expect(client.snapshot.pendingCommandCount, 1);

      await client.dispose();
    },
  );

  test(
    'disconnect keeps replayable commands and reconnect reuses envelope',
    () async {
      final transport = FakeTransport()..emitCommandAcks = false;
      final client = ClientSessionController(
        transport: transport,
        deviceId: 'test-device',
        platform: 'web',
      );

      await client.login('13800000000', '000000');
      await Future<void>.delayed(const Duration(milliseconds: 30));
      await client.createRoom();
      await Future<void>.delayed(const Duration(milliseconds: 30));
      final commandId = await client.joinRoom('demo-room');

      transport.simulateDisconnect();
      await Future<void>.delayed(const Duration(milliseconds: 5));
      expect(client.snapshot.pendingCommandCount, 1);

      await client.connect();
      await Future<void>.delayed(const Duration(milliseconds: 90));
      final attempts = transport.sentMessages
          .where((message) => message['type'] == 'join_room')
          .toList();
      expect(attempts.length, greaterThanOrEqualTo(2));
      expect(attempts.map((message) => message['commandId']).toSet(), {
        commandId,
      });

      await client.dispose();
    },
  );

  test(
    'transport failure leaves the command queued for a safe retry',
    () async {
      final transport = FakeTransport()..emitCommandAcks = false;
      final client = ClientSessionController(
        transport: transport,
        deviceId: 'test-device',
        platform: 'web',
        retryBackoff: const Duration(milliseconds: 5),
      );

      await client.login('13800000000', '000000');
      await Future<void>.delayed(const Duration(milliseconds: 30));
      await client.createRoom();
      await Future<void>.delayed(const Duration(milliseconds: 30));
      transport.failNextSends = 1;
      final command = client.joinRoom('demo-room');
      await expectLater(command, throwsA(isA<StateError>()));
      expect(client.snapshot.pendingCommandCount, 1);

      await Future<void>.delayed(const Duration(milliseconds: 35));
      final attempts = transport.sentMessages
          .where((message) => message['type'] == 'join_room')
          .toList();
      expect(attempts.length, greaterThanOrEqualTo(2));
      expect(
        attempts.map((message) => message['commandId']).toSet(),
        hasLength(1),
      );

      await client.dispose();
    },
  );

  test(
    'ordinary commands are rejected while room synchronization is active',
    () async {
      final transport = FakeTransport();
      final client = ClientSessionController(
        transport: transport,
        deviceId: 'test-device',
        platform: 'web',
      );

      await client.login('13800000000', '000000');
      await Future<void>.delayed(const Duration(milliseconds: 30));
      await client.createRoom();
      await Future<void>.delayed(const Duration(milliseconds: 30));
      transport.inject({
        'protocolVersion': '1.0',
        'type': 'room_event',
        'eventId': newProtocolId(),
        'roomId': 'demo-room',
        'roomVersion': 3,
        'payload': {
          'snapshot': {'roomVersion': 3},
        },
        'occurredAt': DateTime.now().toUtc().toIso8601String(),
      });
      await Future<void>.delayed(Duration.zero);
      expect(client.snapshot.phase, ConnectionPhase.syncing);
      await expectLater(
        client.action('demo-room', 'pass'),
        throwsA(isA<ProtocolException>()),
      );

      await client.dispose();
    },
  );

  test(
    'maintenance pauses the outbox and manual retry reconnects safely',
    () async {
      final transport = FakeTransport();
      final client = ClientSessionController(
        transport: transport,
        deviceId: 'test-device',
        platform: 'web',
      );

      await client.login('13800000000', '000000');
      await Future<void>.delayed(const Duration(milliseconds: 30));
      await client.createRoom();
      await Future<void>.delayed(const Duration(milliseconds: 30));

      // Keep a command pending so maintenance must pause, rather than drop,
      // an operation that may already have reached the server.
      transport.emitCommandAcks = false;
      final commandId = await client.joinRoom('demo-room');
      await Future<void>.delayed(const Duration(milliseconds: 20));
      transport.simulateMaintenance();
      await Future<void>.delayed(const Duration(milliseconds: 5));

      expect(client.snapshot.phase, ConnectionPhase.maintenance);
      expect(client.snapshot.pendingCommandCount, 1);
      expect(client.pendingCommands.single['commandId'], commandId);

      await client.retryConnection();
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(client.snapshot.phase, ConnectionPhase.online);
      expect(client.snapshot.pendingCommandCount, 1);

      await client.dispose();
    },
  );

  test(
    'version conflict triggers sync and refreshes the queued command version',
    () async {
      final transport = FakeTransport();
      final client = ClientSessionController(
        transport: transport,
        deviceId: 'test-device',
        platform: 'web',
      );

      await client.login('13800000000', '000000');
      await Future<void>.delayed(const Duration(milliseconds: 30));
      await client.createRoom();
      await Future<void>.delayed(const Duration(milliseconds: 30));
      await client.joinRoom('demo-room');
      await Future<void>.delayed(const Duration(milliseconds: 20));
      transport.emitCommandAcks = false;
      final commandId = await client.action('demo-room', 'pass');
      await Future<void>.delayed(const Duration(milliseconds: 20));
      transport.simulateVersionConflict(commandId: commandId);
      await Future<void>.delayed(const Duration(milliseconds: 100));

      expect(client.snapshot.phase, ConnectionPhase.online);
      expect(client.snapshot.hasVersionConflict, isTrue);
      expect(client.snapshot.pendingCommandCount, 1);
      final pending = client.pendingCommands.single;
      final before = pending['roomVersion'];
      expect(before, 1);

      // Explicit retry clears the conflict marker and preserves commandId,
      // while binding the envelope to the freshly synchronized room version.
      await client.retryCommand(commandId);
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(client.pendingCommands.single['commandId'], commandId);
      expect(client.pendingCommands.single['roomVersion'], 2);

      await client.dispose();
    },
  );

  test('foreground resume requests an authoritative room sync', () async {
    final transport = FakeTransport();
    final client = ClientSessionController(
      transport: transport,
      deviceId: 'test-device',
      platform: 'web',
    );

    await client.login('13800000000', '000000');
    await Future<void>.delayed(const Duration(milliseconds: 30));
    await client.createRoom();
    await Future<void>.delayed(const Duration(milliseconds: 30));
    await client.joinRoom('demo-room');
    await Future<void>.delayed(const Duration(milliseconds: 30));
    final reconnectCount = transport.sentMessages
        .where((message) => message['type'] == 'reconnect')
        .length;

    await client.resumeFromBackground();
    await Future<void>.delayed(const Duration(milliseconds: 60));
    expect(client.snapshot.phase, ConnectionPhase.online);
    expect(client.snapshot.syncRequired, isFalse);
    expect(
      transport.sentMessages
          .where((message) => message['type'] == 'reconnect')
          .length,
      greaterThan(reconnectCount),
    );

    await client.dispose();
  });
}
