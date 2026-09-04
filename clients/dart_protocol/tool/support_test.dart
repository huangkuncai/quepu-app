import 'dart:async';

import '../lib/support.dart';

Future<void> main() async {
  final calls = <String>[];
  final api = SupportApi((method, path, body, key) async {
    calls.add('$method $path $key');
    if (path == '/support/tickets') {
      if (method == 'POST') {
        return {
          'data': {
            'id': 'ticket-1',
            'status': 'OPEN',
            'subject': body['subject'],
            'messageCount': 1,
          }
        };
      }
      return {
        'data': {'tickets': <Map<String, dynamic>>[]}
      };
    }
    if (path.endsWith('/messages')) {
      if (method == 'POST') {
        return {
          'data': {
            'message': {
              'id': 'message-1',
              'ticketId': 'ticket-1',
              'body': body['message'],
              'authorType': 'USER',
            }
          }
        };
      }
      return {
        'data': {'messages': <Map<String, dynamic>>[]}
      };
    }
    return {
      'data': {
        'id': 'ticket-1',
        'status': 'CLOSED',
        'subject': '测试',
        'messageCount': 1,
      }
    };
  });

  final ticket = await api.createTicket(
    subject: '测试',
    message: '无法进入房间',
    idempotencyKey: 'support-1',
  );
  assert(ticket.id == 'ticket-1' && calls.first.contains('support-1'));
  final reply = await api.reply('ticket-1', '补充信息', idempotencyKey: 'reply-1');
  assert(reply.body == '补充信息');
  await api.listMessages('ticket-1');
  await api.listTickets();
  await api.close('ticket-1');
  var rejected = false;
  try {
    await api.createTicket(subject: '测试', message: '\u0000');
  } on FormatException {
    rejected = true;
  }
  assert(rejected);
  print('support api: mapping, idempotency and plain-text validation passed');
}
