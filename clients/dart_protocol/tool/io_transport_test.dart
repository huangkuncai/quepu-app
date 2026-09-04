import 'dart:async';
import 'dart:convert';
import 'dart:io' as io;

import '../lib/io_transport.dart';

void expect(bool condition, String message) {
  if (!condition) throw StateError(message);
}

Future<void> main() async {
  final server = await io.HttpServer.bind(io.InternetAddress.loopbackIPv4, 0);
  final sockets = <io.WebSocket>[];
  var deviceHeader = '';
  final requests = server.listen((request) async {
    if (request.uri.path == '/slow') {
      await Future<void>.delayed(const Duration(milliseconds: 80));
    }
    if (request.uri.path != '/socket' && request.uri.path != '/slow') {
      request.response.statusCode = io.HttpStatus.notFound;
      await request.response.close();
      return;
    }
    deviceHeader = request.headers.value('x-device') ?? '';
    final socket = await io.WebSocketTransformer.upgrade(request);
    sockets.add(socket);
    socket.listen(
      (raw) {
        if (raw is! String) return;
        final message = jsonDecode(raw);
        if (message is! Map) return;
        switch (message['type']) {
          case 'echo':
            socket.add(jsonEncode({'type': 'echo_ack', 'value': message['value']}));
          case 'bad':
            socket.add('this is not json');
          case 'close':
            unawaited(socket.close(io.WebSocketStatus.normalClosure, 'server closed'));
        }
      },
      onError: (_, __) {},
    );
  });

  final transport = IoWebSocketTransport(
    Uri.parse('ws://127.0.0.1:${server.port}/socket'),
    headers: const {'x-device': 'transport-test'},
  );
  try {
    final firstMessage = transport.messages.first;
    await Future.wait([transport.connect(), transport.connect()]);
    expect(transport.isConnected, 'transport did not connect');
    await transport.send({'type': 'echo', 'value': 7});
    final message = await firstMessage.timeout(const Duration(seconds: 2));
    expect(message['type'] == 'echo_ack', 'text frame was not decoded');
    expect(message['value'] == 7, 'decoded payload changed');
    expect(deviceHeader == 'transport-test', 'custom headers were not sent');

    final malformedClosed = transport.closed.first;
    await transport.send({'type': 'bad'});
    await malformedClosed.timeout(const Duration(seconds: 2));
    expect(!transport.isConnected, 'malformed frame kept socket open');

    // A remote close starts a fresh lifecycle and must still notify once.
    await transport.connect();
    final remoteClosed = transport.closed.first;
    await transport.send({'type': 'close'});
    await remoteClosed.timeout(const Duration(seconds: 2));
    expect(!transport.isConnected, 'remote close did not clear socket');

    // Dispose racing with a pending handshake must surface cancellation to
    // the caller rather than reporting a successful, disconnected connection.
    final slowTransport = IoWebSocketTransport(
      Uri.parse('ws://127.0.0.1:${server.port}/slow'),
    );
    var cancelled = false;
    final pendingConnect = slowTransport.connect().then<void>(
      (_) {},
      onError: (_, __) {
        cancelled = true;
      },
    );
    await Future<void>.delayed(const Duration(milliseconds: 10));
    await slowTransport.close();
    await pendingConnect;
    expect(cancelled, 'pending connect did not report cancellation');
  } finally {
    await transport.close();
    for (final socket in sockets) {
      if (socket.readyState == io.WebSocket.open) {
        await socket.close(io.WebSocketStatus.normalClosure, 'test finished');
      }
    }
    await requests.cancel();
    await server.close(force: true);
  }
  print('dart io transport: connect, headers, frames and close tests passed');
}
