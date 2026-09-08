import 'package:susong_protocol_client/client.dart';
import 'package:susong_protocol_client/io_rest_transport.dart';
import 'package:susong_protocol_client/io_transport.dart';

class AppRuntimeConfig {
  const AppRuntimeConfig._({
    required this.environment,
    required this.wssEndpoint,
    required this.restEndpoint,
  });

  factory AppRuntimeConfig.parse({
    String environment = 'demo',
    String wssUrl = '',
    String restUrl = '',
  }) {
    final normalizedEnvironment = environment.trim().isEmpty
        ? 'demo'
        : environment.trim();
    final normalizedUrl = wssUrl.trim();
    final endpoint = normalizedUrl.isEmpty
        ? null
        : _absoluteEndpoint(normalizedUrl, const {
            'ws',
            'wss',
          }, 'SUSONG_WSS_URL');
    final normalizedRestUrl = restUrl.trim();
    final restEndpoint = normalizedRestUrl.isEmpty
        ? null
        : _absoluteEndpoint(normalizedRestUrl, const {
            'http',
            'https',
          }, 'SUSONG_REST_URL');
    if (restEndpoint != null && endpoint == null) {
      throw const FormatException(
        'SUSONG_REST_URL requires SUSONG_WSS_URL for session authentication',
      );
    }
    return AppRuntimeConfig._(
      environment: normalizedEnvironment,
      wssEndpoint: endpoint,
      restEndpoint: restEndpoint,
    );
  }

  factory AppRuntimeConfig.fromEnvironment() => AppRuntimeConfig.parse(
    environment: const String.fromEnvironment(
      'SUSONG_ENV',
      defaultValue: 'demo',
    ),
    wssUrl: const String.fromEnvironment('SUSONG_WSS_URL'),
    restUrl: const String.fromEnvironment('SUSONG_REST_URL'),
  );

  final String environment;
  final Uri? wssEndpoint;
  final Uri? restEndpoint;

  bool get usesRemoteBackend => wssEndpoint != null;
  bool get hasRestBackend => restEndpoint != null;

  String get displayLabel =>
      usesRemoteBackend ? '$environment · ${wssEndpoint!.host}' : '离线演示环境';

  ProtocolTransport createTransport() {
    final endpoint = wssEndpoint;
    return endpoint == null
        ? throw StateError('demo transport is UI-owned')
        : IoWebSocketTransport(endpoint);
  }

  IoRestTransport createRestTransport() {
    final endpoint = restEndpoint;
    return endpoint == null
        ? throw StateError('REST backend is not configured')
        : IoRestTransport(baseUrl: endpoint.toString());
  }
}

Uri _absoluteEndpoint(String value, Set<String> schemes, String variable) {
  final endpoint = Uri.tryParse(value);
  if (endpoint == null ||
      !endpoint.hasAuthority ||
      !schemes.contains(endpoint.scheme)) {
    throw FormatException(
      '$variable must be an absolute ${schemes.join('/')} URL',
    );
  }
  return endpoint;
}
