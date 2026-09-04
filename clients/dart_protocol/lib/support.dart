import 'client.dart';

/// Framework-neutral client contract for the plain-text support MVP.
///
/// UI shells provide [SupportApiTransport] (REST, fake or native).  This
/// package deliberately has no HTTP dependency so Flutter, ArkUI and native
/// shells can share validation and response mapping.
typedef SupportApiTransport = Future<Map<String, dynamic>> Function(
  String method,
  String path,
  Map<String, dynamic> body,
  String idempotencyKey,
);

class SupportTicket {
  const SupportTicket({
    required this.id,
    required this.status,
    required this.subject,
    required this.messageCount,
    this.roomId,
    this.updatedAt,
  });

  factory SupportTicket.fromJson(Map<String, dynamic> json) => SupportTicket(
        id: _requiredString(json['id'], 'id'),
        status: _requiredString(json['status'], 'status'),
        subject: _requiredString(json['subject'], 'subject'),
        messageCount:
            json['messageCount'] is int ? json['messageCount'] as int : 0,
        roomId: json['roomId']?.toString(),
        updatedAt: json['updatedAt']?.toString(),
      );

  final String id;
  final String status;
  final String subject;
  final int messageCount;
  final String? roomId;
  final String? updatedAt;
}

class SupportMessage {
  const SupportMessage({
    required this.id,
    required this.ticketId,
    required this.body,
    required this.authorType,
    this.createdAt,
  });

  factory SupportMessage.fromJson(Map<String, dynamic> json) => SupportMessage(
        id: _requiredString(json['id'], 'id'),
        ticketId: _requiredString(json['ticketId'], 'ticketId'),
        body: _requiredString(json['body'], 'body'),
        authorType: _requiredString(json['authorType'], 'authorType'),
        createdAt: json['createdAt']?.toString(),
      );

  final String id;
  final String ticketId;
  final String body;
  final String authorType;
  final String? createdAt;
}

class SupportApi {
  SupportApi(this._transport);

  final SupportApiTransport _transport;

  Future<SupportTicket> createTicket({
    required String subject,
    required String message,
    String category = 'OTHER',
    String? roomId,
    String? clientVersion,
    String? idempotencyKey,
  }) async {
    _text(subject, 'subject', 120);
    _text(message, 'message', 2000);
    final response = await _transport(
        'POST',
        '/support/tickets',
        {
          'subject': subject.trim(),
          'message': message.trim(),
          'category': category,
          if (roomId != null && roomId.trim().isNotEmpty)
            'roomId': roomId.trim(),
          if (clientVersion != null && clientVersion.trim().isNotEmpty)
            'clientVersion': clientVersion.trim(),
        },
        idempotencyKey ?? newProtocolId());
    return SupportTicket.fromJson(_data(response));
  }

  Future<List<SupportTicket>> listTickets() async {
    final response =
        await _transport('GET', '/support/tickets', {}, newProtocolId());
    final data = _data(response);
    final items = data['tickets'] ?? data['items'];
    if (items is! List)
      throw const FormatException('support tickets must be a list');
    return items
        .whereType<Map>()
        .map((item) => SupportTicket.fromJson(Map<String, dynamic>.from(item)))
        .toList(growable: false);
  }

  Future<List<SupportMessage>> listMessages(String ticketId) async {
    _text(ticketId, 'ticketId', 128);
    final response = await _transport('GET',
        '/support/tickets/${ticketId.trim()}/messages', {}, newProtocolId());
    final data = _data(response);
    final items = data['messages'];
    if (items is! List)
      throw const FormatException('support messages must be a list');
    return items
        .whereType<Map>()
        .map((item) => SupportMessage.fromJson(Map<String, dynamic>.from(item)))
        .toList(growable: false);
  }

  Future<SupportMessage> reply(
    String ticketId,
    String message, {
    String? idempotencyKey,
  }) async {
    _text(ticketId, 'ticketId', 128);
    _text(message, 'message', 2000);
    final response = await _transport(
      'POST',
      '/support/tickets/${ticketId.trim()}/messages',
      {'message': message.trim()},
      idempotencyKey ?? newProtocolId(),
    );
    final data = _data(response)['message'];
    if (data is! Map) throw const FormatException('support reply is missing');
    return SupportMessage.fromJson(Map<String, dynamic>.from(data));
  }

  Future<SupportTicket> close(String ticketId, {String? reason}) async {
    _text(ticketId, 'ticketId', 128);
    final response = await _transport(
      'POST',
      '/support/tickets/${ticketId.trim()}/close',
      {if (reason != null && reason.trim().isNotEmpty) 'reason': reason.trim()},
      newProtocolId(),
    );
    return SupportTicket.fromJson(_data(response));
  }
}

Map<String, dynamic> _data(Map<String, dynamic> response) {
  final data = response['data'];
  if (data is! Map)
    throw const FormatException('support response data is missing');
  return Map<String, dynamic>.from(data);
}

String _requiredString(dynamic value, String field) {
  if (value is! String || value.trim().isEmpty) {
    throw FormatException('support $field is missing');
  }
  return value;
}

void _text(String value, String field, int max) {
  if (value.trim().isEmpty ||
      value.contains('\u0000') ||
      value.trim().runes.length > max) {
    throw FormatException('support $field is invalid');
  }
}
