import 'dart:async';
import 'dart:convert';
import 'dart:io' as io;
import 'dart:typed_data';

import 'client.dart';

/// `dart:io` WebSocket adapter for Android, iOS and compatible native
/// runtimes. The browser build keeps using a separate adapter because
/// `dart:io` is intentionally unavailable on Flutter Web.
class IoWebSocketTransport implements ProtocolTransport {
  IoWebSocketTransport(
    this.endpoint, {
    Map<String, String>? headers,
    this.maxPayloadBytes = 65536,
  })  : headers = Map.unmodifiable(headers ?? const {}),
        assert(maxPayloadBytes > 0);

  final Uri endpoint;
  final Map<String, String> headers;
  final int maxPayloadBytes;
  final _messages = StreamController<Map<String, dynamic>>.broadcast();
  final _closed = StreamController<void>.broadcast();
  io.WebSocket? _socket;
  StreamSubscription<dynamic>? _socketSubscription;
  Future<void>? _connectInFlight;
  int _generation = 0;
  bool _intentionalClose = false;
  bool _closeNotified = false;
  bool _disposed = false;

  @override
  Stream<Map<String, dynamic>> get messages => _messages.stream;

  @override
  Stream<void> get closed => _closed.stream;

  @override
  bool get isConnected => _socket?.readyState == io.WebSocket.open;

  @override
  Future<void> connect() async {
    if (_disposed) throw StateError('WebSocket transport is closed');
    if (isConnected) return;
    final inFlight = _connectInFlight;
    if (inFlight != null) return inFlight;

    final future = _openSocket();
    _connectInFlight = future;
    try {
      await future;
    } finally {
      if (identical(_connectInFlight, future)) _connectInFlight = null;
    }
  }

  @override
  Future<void> send(Map<String, dynamic> message) async {
    final socket = _socket;
    if (socket == null || socket.readyState != io.WebSocket.open) {
      throw StateError('WebSocket is not connected');
    }
    final encoded = jsonEncode(message);
    if (utf8.encode(encoded).length > maxPayloadBytes) {
      throw StateError('WebSocket message exceeds maxPayloadBytes');
    }
    socket.add(encoded);
  }

  @override
  Future<void> close() async {
    if (_disposed) return;
    _disposed = true;
    _intentionalClose = true;
    _generation += 1;
    final socket = _socket;
    _socket = null;
    final subscription = _socketSubscription;
    _socketSubscription = null;
    final connecting = _connectInFlight;
    try {
      await _cancelSubscription(subscription);
      if (socket != null) {
        await _bestEffortClose(
          socket,
          io.WebSocketStatus.normalClosure,
          'client closed',
        );
      }
      // A connect can finish after dispose was requested. Wait for it to
      // release its socket before closing the stream controllers.
      if (connecting != null) {
        try {
          await connecting;
        } catch (_) {
          // The caller of connect() will receive the cancellation error;
          // disposal itself must still complete and close all streams.
        }
      }
    } finally {
      await _messages.close();
      await _closed.close();
    }
  }

  Future<void> _openSocket() async {
    _intentionalClose = false;
    _closeNotified = false;
    final generation = ++_generation;
    final socket = await io.WebSocket.connect(
      endpoint.toString(),
      headers: headers,
      // `dart:io` exposes the receive limit on the WebSocket object rather
      // than as a connect option; enforce it in `_onData` for all frame types.
    );
    if (_disposed || generation != _generation) {
      await _bestEffortClose(
        socket,
        io.WebSocketStatus.normalClosure,
        'stale socket',
      );
      throw StateError('WebSocket connect was cancelled');
    }
    _socket = socket;
    _socketSubscription = socket.listen(
      (raw) => _onData(raw, generation, socket),
      onError: (_, __) => _onSocketClosed(generation, socket),
      onDone: () => _onSocketClosed(generation, socket),
      cancelOnError: false,
    );
  }

  void _onData(Object? raw, int generation, io.WebSocket socket) {
    if (_disposed || generation != _generation || !identical(_socket, socket)) {
      return;
    }
    try {
      final decoded = raw is String
          ? jsonDecode(raw)
          : raw is Uint8List
              ? jsonDecode(utf8.decode(raw))
              : raw is List<int>
                  ? jsonDecode(utf8.decode(raw))
                  : raw;
      final frameBytes = raw is String
          ? utf8.encode(raw).length
          : raw is List<int>
              ? raw.length
              : utf8.encode(jsonEncode(raw)).length;
      if (frameBytes > maxPayloadBytes) {
        throw const FormatException('message exceeds max payload');
      }
      if (decoded is! Map) {
        throw const FormatException('message must be an object');
      }
      _messages.add(Map<String, dynamic>.from(decoded));
    } on Object {
      // A malformed frame cannot safely be interpreted as a protocol event;
      // close the connection so the controller can perform a clean resync.
      if (_detachSocket(generation, socket)) {
        // Notify synchronously so callers stop sending immediately; the
        // protocol close handshake is best effort and must not block it.
        unawaited(_bestEffortClose(
          socket,
          io.WebSocketStatus.protocolError,
          'invalid JSON',
        ));
      }
    }
  }

  bool _detachSocket(int generation, io.WebSocket socket) {
    if (generation != _generation || !identical(_socket, socket)) {
      return false;
    }
    final subscription = _socketSubscription;
    _socketSubscription = null;
    _socket = null;
    unawaited(_cancelSubscription(subscription));
    _notifyClosed();
    return true;
  }

  void _onSocketClosed(int generation, io.WebSocket socket) {
    _detachSocket(generation, socket);
  }

  Future<void> _bestEffortClose(
    io.WebSocket socket,
    int status,
    String reason,
  ) async {
    try {
      if (socket.readyState == io.WebSocket.open) {
        await socket
            .close(status, reason)
            .timeout(const Duration(seconds: 1));
      }
    } catch (_) {
      // Closing a socket is best effort. The transport has already detached
      // it from the public state and emitted `closed` where appropriate.
    }
  }

  Future<void> _cancelSubscription(
    StreamSubscription<dynamic>? subscription,
  ) async {
    if (subscription == null) return;
    try {
      await subscription.cancel();
    } catch (_) {
      // A completed socket may reject cancellation; there is nothing useful
      // for callers to do after the connection has already been detached.
    }
  }

  void _notifyClosed() {
    if (_closeNotified || _intentionalClose || _closed.isClosed) return;
    _closeNotified = true;
    _socket = null;
    _closed.add(null);
  }
}
