import 'dart:convert';
import 'dart:io';

import 'client.dart';
import 'support.dart';

class SupportApiException implements Exception {
  const SupportApiException(this.statusCode, this.code, this.message,
      {this.retryable = false});

  final int statusCode;
  final String code;
  final String message;
  final bool retryable;

  @override
  String toString() => 'SupportApiException($statusCode, $code): $message';
}

/// Native REST transport for Android/iOS/Harmony-compatible Dart shells.
/// Flutter Web should provide a browser transport instead of importing this
/// file because `dart:io` is unavailable there.
class IoRestTransport {
  IoRestTransport({
    required String baseUrl,
    this.accessToken,
    HttpClient? client,
  })  : baseUri = Uri.parse(baseUrl.endsWith('/') ? baseUrl : '$baseUrl/'),
        _client = client ?? HttpClient();

  final Uri baseUri;
  final String? accessToken;
  final HttpClient _client;

  SupportApiTransport get call => _send;

  /// Binds REST authorization to a live protocol session. The token is read
  /// for each request so refresh/logout cannot leave this adapter with stale
  /// credentials, and UI widgets never receive the raw token.
  SupportApiTransport forSession(ClientSessionController session) =>
      (method, path, body, idempotencyKey) => session.runAuthorized(
            (token) => _send(
              method,
              path,
              body,
              idempotencyKey,
              authorizationToken: token,
            ),
          );

  Future<Map<String, dynamic>> _send(String method, String path,
      Map<String, dynamic> body, String idempotencyKey,
      {String? authorizationToken}) async {
    final uri =
        baseUri.resolve(path.startsWith('/') ? path.substring(1) : path);
    final request = await _client.openUrl(method, uri);
    request.headers.contentType = ContentType.json;
    request.headers.set('accept', 'application/json');
    request.headers.set('x-request-id', idempotencyKey);
    request.headers.set('idempotency-key', idempotencyKey);
    final token = authorizationToken ?? accessToken;
    if (token != null && token.trim().isNotEmpty) {
      request.headers
          .set(HttpHeaders.authorizationHeader, 'Bearer ${token.trim()}');
    }
    if (method != 'GET' && method != 'HEAD') request.write(jsonEncode(body));
    final response = await request.close();
    final text = await utf8.decoder.bind(response).join();
    final decoded = text.isEmpty ? <String, dynamic>{} : jsonDecode(text);
    if (decoded is! Map)
      throw const FormatException('REST response must be an object');
    final result = Map<String, dynamic>.from(decoded);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final error = result['error'];
      final code = error is Map ? error['code']?.toString() : null;
      final message = error is Map ? error['message']?.toString() : null;
      final retryable = error is Map && error['retryable'] == true;
      throw SupportApiException(
        response.statusCode,
        code ?? 'HTTP_${response.statusCode}',
        message ?? 'support REST request failed',
        retryable: retryable,
      );
    }
    return result;
  }

  Future<void> close() async {
    _client.close(force: true);
  }
}
