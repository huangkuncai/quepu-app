import 'package:flutter_test/flutter_test.dart';
import 'package:susong_app/src/runtime_config.dart';
import 'package:susong_protocol_client/io_transport.dart';
import 'package:susong_protocol_client/io_rest_transport.dart';

void main() {
  test('empty WSS setting keeps the app in offline demo mode', () {
    final config = AppRuntimeConfig.parse();

    expect(config.usesRemoteBackend, isFalse);
    expect(config.hasRestBackend, isFalse);
    expect(config.displayLabel, '离线演示环境');
  });

  test('absolute REST setting creates the native REST adapter', () async {
    final config = AppRuntimeConfig.parse(
      environment: 'development',
      wssUrl: 'ws://10.0.2.2:8787',
      restUrl: 'http://10.0.2.2:8788/api/v1',
    );

    expect(config.hasRestBackend, isTrue);
    final transport = config.createRestTransport();
    expect(transport, isA<IoRestTransport>());
    await transport.close();
  });

  test('absolute WSS setting creates the native WebSocket adapter', () {
    final config = AppRuntimeConfig.parse(
      environment: 'staging',
      wssUrl: 'wss://staging.example.com/ws',
    );

    expect(config.usesRemoteBackend, isTrue);
    expect(config.displayLabel, 'staging · staging.example.com');
    expect(config.createTransport(), isA<IoWebSocketTransport>());
  });

  test('HTTP endpoints cannot be mistaken for WebSocket endpoints', () {
    expect(
      () => AppRuntimeConfig.parse(wssUrl: 'https://example.com/ws'),
      throwsFormatException,
    );
  });

  test('WebSocket endpoints cannot be mistaken for REST endpoints', () {
    expect(
      () => AppRuntimeConfig.parse(restUrl: 'ws://example.com/api/v1'),
      throwsFormatException,
    );
  });

  test('REST cannot be configured without the authenticating WSS session', () {
    expect(
      () => AppRuntimeConfig.parse(restUrl: 'https://example.com/api/v1'),
      throwsFormatException,
    );
  });
}
