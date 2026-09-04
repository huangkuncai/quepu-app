import 'dart:convert';
import 'dart:io';

import '../lib/io_rest_transport.dart';

Future<void> main() async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  String? auth;
  String? idempotency;
  server.listen((request) async {
    auth = request.headers.value(HttpHeaders.authorizationHeader);
    idempotency = request.headers.value('idempotency-key');
    await request.drain<void>();
    final failed = request.uri.path.endsWith('/error');
    request.response
      ..statusCode = failed ? HttpStatus.unprocessableEntity : HttpStatus.ok
      ..headers.contentType = ContentType.json
      ..write(jsonEncode(failed
          ? {
              'error': {
                'code': 'SUPPORT_TEXT_INVALID',
                'message': 'text invalid',
                'retryable': false,
              }
            }
          : {
              'data': {'tickets': []}
            }));
    await request.response.close();
  });
  final transport = IoRestTransport(
    baseUrl: 'http://${server.address.host}:${server.port}/api/v1',
    accessToken: 'access-test',
  );
  try {
    final response = await transport.call(
      'GET',
      '/support/tickets',
      const {},
      'request-test',
    );
    assert(response['data'] is Map);
    assert(auth == 'Bearer access-test');
    assert(idempotency == 'request-test');
    try {
      await transport.call('GET', '/error', const {}, 'request-error');
      assert(false);
    } on SupportApiException catch (error) {
      assert(error.statusCode == 422 && error.code == 'SUPPORT_TEXT_INVALID');
    }
    print('dart io REST transport: auth, headers and JSON response passed');
  } finally {
    await transport.close();
    await server.close(force: true);
  }
}
