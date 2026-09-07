import 'package:flutter_test/flutter_test.dart';
import 'package:susong_app/src/runtime_config.dart';
import 'package:susong_protocol_client/io_transport.dart';

void main() {
  test('empty WSS setting keeps the app in offline demo mode', () {
    final config = AppRuntimeConfig.parse();

    expect(config.usesRemoteBackend, isFalse);
    expect(config.displayLabel, '离线演示环境');
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
}
