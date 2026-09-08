import 'dart:async';
import 'dart:convert';

import '../lib/client.dart';
import '../lib/io_transport.dart';
import '../lib/protocol.dart';

Future<void> main(List<String> args) async {
  if (args.length != 1) {
    throw ArgumentError(
        'usage: dart run tool/real_backend_acceptance.dart ws://host:port');
  }
  final endpoint = Uri.parse(args.single);
  if (!endpoint.hasAuthority ||
      !const {'ws', 'wss'}.contains(endpoint.scheme)) {
    throw ArgumentError.value(
        args.single, 'endpoint', 'must be an absolute ws/wss URL');
  }

  final phones = List<String>.generate(4, (index) => '1380000010${index + 1}');
  final clients = List<ClientSessionController>.generate(
    4,
    (index) => _client(endpoint, 'real-device-${index + 1}'),
  );
  ClientSessionController? replacement;

  try {
    await Future.wait(List<Future<void>>.generate(
      clients.length,
      (index) => clients[index].login(phones[index], '000000'),
    ));
    await _waitUntil(
      () => clients.every((client) =>
          client.snapshot.phase == ConnectionPhase.online &&
          client.snapshot.isAuthenticated),
      'four real WSS clients did not authenticate',
    );

    await clients.first.createRoom(ruleConfig: const {
      'rounds': 4,
      'scoreTiers': [1, 2, 3, 4],
      'zeng': 1,
      'piao': 'optional',
      'forcedHu': false,
    });
    await _waitUntil(
      () => clients.first.snapshot.roomId != null,
      'owner did not receive the created room',
    );
    final roomId = clients.first.snapshot.roomId!;

    await clients.first.joinRoom(roomId, name: '真实联调玩家1');
    await _waitUntil(
      () =>
          (clients.first.snapshot.roomSnapshot?['players'] as List?)?.length ==
          1,
      'owner did not enter the created room',
    );

    for (var index = 1; index < clients.length; index += 1) {
      await clients[index].joinRoom(
        roomId,
        name: '真实联调玩家${index + 1}',
      );
      await _waitUntil(
        () =>
            (clients.first.snapshot.roomSnapshot?['players'] as List?)
                ?.length ==
            index + 1,
        'owner did not observe player ${index + 1} joining',
      );
      try {
        await _waitUntil(
          () =>
              clients[index].snapshot.phase == ConnectionPhase.online &&
              clients[index].snapshot.roomVersion ==
                  clients.first.snapshot.roomVersion,
          'joining client ${index + 1} did not complete initial sync',
        );
      } catch (_) {
        final state = clients[index].snapshot;
        throw StateError(
          'joining client ${index + 1} did not sync: '
          '${jsonEncode({
                'phase': state.phase.name,
                'roomId': state.roomId,
                'version': state.roomVersion,
                'error': state.lastErrorCode,
                'message': state.lastErrorMessage,
                'pending': state.pendingCommandCount,
                'pendingTypes': clients[index]
                    .pendingCommands
                    .map((command) => command['type'])
                    .toList(),
              })}',
        );
      }
    }
    await _waitForConvergence(clients, expectedPlayers: 4);

    await Future.wait(clients.map((client) => client.setReady(roomId)));
    await _waitUntil(
      () => clients.every((client) {
        final room = client.snapshot.roomSnapshot;
        return room != null &&
            (room['readyCount'] == 4 || room['status'] == 'ready');
      }),
      'four clients did not converge on ready state',
    );

    await clients.first.startRound(roomId);
    await _waitUntil(
      () => clients.every((client) {
        final room = client.snapshot.roomSnapshot;
        return room != null &&
            const {'dealing', 'playing'}.contains(room['status']) &&
            (room['currentRound'] is Map || room['round'] is Map);
      }),
      'server-owned Susong round did not reach dealing/playing state',
    );
    await _waitForConvergence(clients, expectedPlayers: 4);

    final versions =
        clients.map((client) => client.snapshot.roomVersion).toList();
    final hashes = clients
        .map((client) =>
            client.snapshot.roomSnapshot?['snapshotHash']?.toString())
        .toList();
    _expect(
        hashes.first != null && hashes.every((hash) => hash == hashes.first),
        'viewer snapshots did not share one public snapshot hash: $hashes');
    for (final client in clients) {
      final room = client.snapshot.roomSnapshot!;
      _expect(_privateHand(room) != null,
          'a seated viewer did not receive their own private hand');
      for (final forbidden in const [
        '_privateRoundState',
        'handsByPlayer',
        'wall',
        'seed',
      ]) {
        _expect(!room.containsKey(forbidden),
            'viewer snapshot leaked private field $forbidden');
      }
    }

    final replacedUserId = clients[3].snapshot.userId;
    final replacedHand = _privateHand(clients[3].snapshot.roomSnapshot!)!;
    await clients[3].dispose();
    replacement = _client(endpoint, 'real-device-4-replacement');
    await replacement.login(phones[3], '000000');
    await _waitUntil(
      () =>
          replacement!.snapshot.phase == ConnectionPhase.online &&
          replacement.snapshot.isAuthenticated,
      'replacement client did not authenticate',
    );
    _expect(replacement.snapshot.userId == replacedUserId,
        'same development account did not recover the same player id');

    await replacement.reconnectRoom(roomId);
    await _waitUntil(
      () =>
          replacement!.snapshot.phase == ConnectionPhase.online &&
          replacement.snapshot.roomId == roomId &&
          replacement.snapshot.roomVersion >= versions.first &&
          replacement.snapshot.syncRequired == false,
      'replacement client did not complete authoritative room sync',
    );
    final replacementRoom = replacement.snapshot.roomSnapshot!;
    _expect(
      const ListEquality().equals(
        _privateHand(replacementRoom)!,
        replacedHand,
      ),
      'replacement client did not recover the same private hand',
    );

    print(jsonEncode({
      'status': 'ok',
      'fixture': 'CL-201-real-wss-four-client',
      'endpoint': '${endpoint.scheme}://${endpoint.host}:${endpoint.port}',
      'clientCount': 4,
      'roomId': roomId,
      'roomVersion': replacement.snapshot.roomVersion,
      'snapshotHash': replacementRoom['snapshotHash'],
      'roundStatus': replacementRoom['status'],
      'privateHandRecovered': true,
      'productionBoundary':
          'loopback development server with stub auth and memory persistence',
    }));
  } finally {
    if (replacement != null) await replacement.dispose();
    for (var index = 0; index < clients.length - 1; index += 1) {
      await clients[index].dispose();
    }
  }
}

ClientSessionController _client(Uri endpoint, String deviceId) {
  final transport = IoWebSocketTransport(endpoint);
  return ClientSessionController(
    transport: transport,
    deviceId: deviceId,
    platform: 'android',
    commandTimeout: const Duration(seconds: 3),
    retryBackoff: const Duration(milliseconds: 50),
  );
}

Future<void> _waitForConvergence(
  List<ClientSessionController> clients, {
  required int expectedPlayers,
}) async {
  try {
    await _waitUntil(() {
      final versions =
          clients.map((client) => client.snapshot.roomVersion).toSet();
      final rooms =
          clients.map((client) => client.snapshot.roomSnapshot).toList();
      return versions.length == 1 &&
          rooms.every((room) =>
              room != null &&
              room['players'] is List &&
              (room['players'] as List).length == expectedPlayers);
    }, 'clients did not converge on one room version');
  } catch (_) {
    final diagnostics = clients
        .map((client) => {
              'phase': client.snapshot.phase.name,
              'roomId': client.snapshot.roomId,
              'version': client.snapshot.roomVersion,
              'players':
                  (client.snapshot.roomSnapshot?['players'] as List?)?.length,
              'error': client.snapshot.lastErrorCode,
              'message': client.snapshot.lastErrorMessage,
            })
        .toList();
    throw StateError('clients did not converge: ${jsonEncode(diagnostics)}');
  }
}

Future<void> _waitUntil(
  bool Function() condition,
  String message, {
  Duration timeout = const Duration(seconds: 5),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) throw StateError(message);
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
}

void _expect(bool condition, String message) {
  if (!condition) throw StateError(message);
}

List<Object?>? _privateHand(Map<String, dynamic> room) {
  final round = room['currentRound'] is Map
      ? room['currentRound'] as Map
      : room['round'] is Map
          ? room['round'] as Map
          : null;
  final hand = room['privateHand'] ?? round?['privateHand'];
  return hand is List ? List<Object?>.from(hand) : null;
}

class ListEquality {
  const ListEquality();

  bool equals(List<Object?> left, List<Object?> right) {
    if (left.length != right.length) return false;
    for (var index = 0; index < left.length; index += 1) {
      if (left[index] != right[index]) return false;
    }
    return true;
  }
}
