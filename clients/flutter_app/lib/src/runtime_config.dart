import 'package:susong_protocol_client/client.dart';
import 'package:susong_protocol_client/io_transport.dart';

class AppRuntimeConfig {
  const AppRuntimeConfig._({
    required this.environment,
    required this.wssEndpoint,
  });

  factory AppRuntimeConfig.parse({
    String environment = 'demo',
    String wssUrl = '',
  }) {
    final normalizedEnvironment = environment.trim().isEmpty
        ? 'demo'
        : environment.trim();
    final normalizedUrl = wssUrl.trim();
    if (normalizedUrl.isEmpty) {
      return AppRuntimeConfig._(
        environment: normalizedEnvironment,
        wssEndpoint: null,
      );
    }
    final endpoint = Uri.tryParse(normalizedUrl);
    if (endpoint == null ||
        !endpoint.hasAuthority ||
        !const {'ws', 'wss'}.contains(endpoint.scheme)) {
      throw FormatException('SUSONG_WSS_URL must be an absolute ws/wss URL');
    }
    return AppRuntimeConfig._(
      environment: normalizedEnvironment,
      wssEndpoint: endpoint,
    );
  }

  factory AppRuntimeConfig.fromEnvironment() => AppRuntimeConfig.parse(
    environment: const String.fromEnvironment(
      'SUSONG_ENV',
      defaultValue: 'demo',
    ),
    wssUrl: const String.fromEnvironment('SUSONG_WSS_URL'),
  );

  final String environment;
  final Uri? wssEndpoint;

  bool get usesRemoteBackend => wssEndpoint != null;

  String get displayLabel =>
      usesRemoteBackend ? '$environment · ${wssEndpoint!.host}' : '离线演示环境';

  ProtocolTransport createTransport() {
    final endpoint = wssEndpoint;
    return endpoint == null
        ? throw StateError('demo transport is UI-owned')
        : IoWebSocketTransport(endpoint);
  }
}
