import 'dart:async';
import 'dart:math' as math;

import 'protocol.dart';

/// A platform-neutral transport boundary. Flutter, ArkUI-X and a future
/// native client can provide their own WebSocket implementation without
/// moving protocol or reconnect policy into the UI layer.
abstract interface class ProtocolTransport {
  Stream<Map<String, dynamic>> get messages;

  Stream<void> get closed;

  bool get isConnected;

  Future<void> connect();

  Future<void> send(Map<String, dynamic> message);

  Future<void> close();
}

String newProtocolId([math.Random? random]) {
  final source = random ?? math.Random.secure();
  final bytes = List<int>.generate(16, (_) => source.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final hex =
      bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
      '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

class ClientSnapshot {
  const ClientSnapshot({
    required this.phase,
    required this.attempts,
    required this.roomVersion,
    required this.syncRequired,
    required this.pendingCommandCount,
    this.sessionId,
    this.userId,
    this.displayName,
    this.roomId,
    this.lastErrorCode,
    this.lastErrorMessage,
    this.roomSnapshot,
  });

  factory ClientSnapshot.initial() => const ClientSnapshot(
        phase: ConnectionPhase.disconnected,
        attempts: 0,
        roomVersion: -1,
        syncRequired: false,
        pendingCommandCount: 0,
      );

  final ConnectionPhase phase;
  final int attempts;
  final String? sessionId;
  final String? userId;
  final String? displayName;
  final String? roomId;
  final int roomVersion;
  final bool syncRequired;
  final int pendingCommandCount;
  final String? lastErrorCode;
  final String? lastErrorMessage;
  final Map<String, dynamic>? roomSnapshot;

  bool get isAuthenticated => sessionId != null && userId != null;

  /// Whether the transport is in one of the handshake/recovery phases.  The
  /// UI uses this rather than reaching into the controller's private state.
  bool get isRecovering =>
      phase == ConnectionPhase.connecting ||
      phase == ConnectionPhase.authenticating ||
      phase == ConnectionPhase.syncing;

  bool get isMaintenance => phase == ConnectionPhase.maintenance;

  bool get hasVersionConflict => lastErrorCode == 'VERSION_CONFLICT';

  ClientSnapshot copyWith({
    ConnectionPhase? phase,
    int? attempts,
    String? sessionId,
    bool clearSession = false,
    String? userId,
    bool clearUser = false,
    String? displayName,
    bool clearDisplayName = false,
    String? roomId,
    bool clearRoom = false,
    int? roomVersion,
    bool? syncRequired,
    int? pendingCommandCount,
    String? lastErrorCode,
    String? lastErrorMessage,
    bool clearError = false,
    Map<String, dynamic>? roomSnapshot,
    bool clearRoomSnapshot = false,
  }) {
    return ClientSnapshot(
      phase: phase ?? this.phase,
      attempts: attempts ?? this.attempts,
      sessionId: clearSession ? null : (sessionId ?? this.sessionId),
      userId: clearUser ? null : (userId ?? this.userId),
      displayName: clearDisplayName ? null : (displayName ?? this.displayName),
      roomId: clearRoom ? null : (roomId ?? this.roomId),
      roomVersion: roomVersion ?? this.roomVersion,
      syncRequired: syncRequired ?? this.syncRequired,
      pendingCommandCount: pendingCommandCount ?? this.pendingCommandCount,
      lastErrorCode: clearError ? null : (lastErrorCode ?? this.lastErrorCode),
      lastErrorMessage:
          clearError ? null : (lastErrorMessage ?? this.lastErrorMessage),
      roomSnapshot:
          clearRoomSnapshot ? null : (roomSnapshot ?? this.roomSnapshot),
    );
  }
}

/// An outbox entry keeps the original envelope stable while a command is
/// retried. The server uses `commandId` as the idempotency key, so retries
/// must never construct a second envelope with a new command id.
class _PendingCommand {
  _PendingCommand({
    required this.message,
    required this.createdAt,
  }) : lastSentAt = null;

  final Map<String, dynamic> message;
  final DateTime createdAt;
  DateTime? lastSentAt;
  int attempts = 0;
  bool sending = false;
  // A stale room version must not cause an automatic retry loop.  The entry
  // stays in the outbox so the user can explicitly retry it after the fresh
  // snapshot has been applied.
  bool blockedByVersionConflict = false;
  // A maintenance response is also an explicit user-retry boundary.  Keeping
  // this bit on the entry prevents a reconnect handshake from blindly
  // replaying a command while the service is still draining.
  bool blockedByMaintenance = false;
  Timer? timeoutTimer;
  Timer? retryTimer;

  String get commandId => message['commandId'] as String;
  String get type => message['type']?.toString() ?? '';

  void cancelTimers() {
    timeoutTimer?.cancel();
    timeoutTimer = null;
    retryTimer?.cancel();
    retryTimer = null;
  }
}

/// Session, command idempotency and room synchronization policy shared by
/// every client shell. It intentionally stores tokens privately and exposes
/// only identity/status to UI observers.
class ClientSessionController {
  ClientSessionController({
    required ProtocolTransport transport,
    required this.deviceId,
    required this.platform,
    this.clientVersion = '0.1.0-poc',
    math.Random? random,
    this.commandTimeout = const Duration(seconds: 8),
    this.retryBackoff = const Duration(milliseconds: 250),
    DateTime Function()? clock,
    Timer Function(Duration, void Function())? timerFactory,
  })  : _transport = transport,
        _random = random ?? math.Random.secure(),
        _clock = clock ?? DateTime.now,
        _timerFactory = timerFactory ?? Timer.new {
    _messagesSubscription = _transport.messages.listen(_handleMessage);
    _closedSubscription = _transport.closed.listen((_) {
      if (!_intentionalClose) _markDisconnected();
    });
  }

  final ProtocolTransport _transport;
  final String deviceId;
  final String platform;
  final String clientVersion;
  final Duration commandTimeout;
  final Duration retryBackoff;
  final math.Random _random;
  final DateTime Function() _clock;
  final Timer Function(Duration, void Function()) _timerFactory;
  final ConnectionStateMachine _connection = ConnectionStateMachine();
  final RoomStateReducer _room = RoomStateReducer();
  final StreamController<ClientSnapshot> _states = StreamController.broadcast();
  final Map<String, _PendingCommand> _pending = {};
  late final StreamSubscription<Map<String, dynamic>> _messagesSubscription;
  late final StreamSubscription<void> _closedSubscription;

  ClientSnapshot _snapshot = ClientSnapshot.initial();
  String? _accessToken;
  String? _refreshToken;
  bool _intentionalClose = false;
  bool _disposed = false;

  Stream<ClientSnapshot> get states => _states.stream;
  ClientSnapshot get snapshot => _snapshot;
  ProtocolTransport get transport => _transport;
  Map<String, dynamic>? get roomSnapshot => _room.snapshot;

  /// A read-only view of queued envelopes, useful for diagnostics and tests.
  /// The returned maps are copies so callers cannot mutate an in-flight
  /// command and accidentally change its idempotency identity.
  List<Map<String, dynamic>> get pendingCommands => List.unmodifiable(
        _pending.values
            .map((entry) => Map<String, dynamic>.from(entry.message))
            .toList(growable: false),
      );

  Future<void> connect() async {
    if (_disposed || _connection.phase != ConnectionPhase.disconnected) return;
    _intentionalClose = false;
    _transition(ConnectionPhase.connecting);
    try {
      await _transport.connect();
      _transition(ConnectionPhase.authenticating);
      await sendCommand('hello', {
        'deviceId': deviceId,
        'platform': platform,
        'clientVersion': clientVersion,
      });
      if (_accessToken != null) {
        await sendCommand('auth', {'accessToken': _accessToken});
      }
    } catch (error) {
      _setError('TRANSPORT_UNAVAILABLE', error.toString());
      _markDisconnected();
    }
  }

  /// Put the session into a server-maintenance state.  Maintenance is kept
  /// separate from a transport disconnect so the UI can tell the player that
  /// retrying later is safe, while queued idempotent commands remain intact.
  void enterMaintenance({
    String code = 'SERVICE_MAINTENANCE',
    String message = '服务维护中，请稍后重试',
  }) {
    if (_disposed) return;
    for (final entry in _pending.values) {
      if (_replayableCommandTypes.contains(entry.type)) {
        entry.blockedByMaintenance = true;
        entry.cancelTimers();
      }
    }
    _setError(code, message);
    if (_connection.phase == ConnectionPhase.maintenance) {
      _emit();
      return;
    }
    _transition(ConnectionPhase.maintenance);
  }

  /// Leave maintenance and start a fresh hello/auth handshake.  The method is
  /// intentionally explicit: a maintenance response must never trigger a
  /// tight reconnect loop in the background.
  Future<void> retryConnection() async {
    if (_disposed) return;

    for (final entry in _pending.values) {
      entry.blockedByVersionConflict = false;
      entry.blockedByMaintenance = false;
      _refreshRoomVersionForRetry(entry);
    }

    if (_connection.phase == ConnectionPhase.maintenance) {
      _snapshot = _snapshot.copyWith(clearError: true);
      _transition(ConnectionPhase.disconnected);
    }

    if (_connection.phase == ConnectionPhase.disconnected) {
      await connect();
      return;
    }

    final roomId = _snapshot.roomId;
    if (_snapshot.syncRequired && roomId != null) {
      if (_connection.phase == ConnectionPhase.online) {
        _transition(ConnectionPhase.syncing);
      }
      await reconnectRoom(roomId);
      return;
    }

    if (_connection.phase == ConnectionPhase.syncing && roomId != null) {
      await reconnectRoom(roomId);
      return;
    }

    if (_connection.phase == ConnectionPhase.online) {
      await _replayPendingCommands();
    }
  }

  /// Called by a platform shell when it becomes active again.  We do not
  /// promise a background WebSocket; the foreground transition always checks
  /// the transport and asks the server for an authoritative room snapshot.
  Future<void> resumeFromBackground() async {
    if (_disposed || _connection.phase == ConnectionPhase.maintenance) return;
    // A lifecycle callback can arrive during cold startup.  Do not create a
    // socket before the user has authenticated; login remains an explicit UI
    // action in the POC.
    if (!_snapshot.isAuthenticated && _accessToken == null) return;
    final roomId = _snapshot.roomId;
    if (_connection.phase == ConnectionPhase.disconnected) {
      await connect();
      return;
    }
    if (roomId != null && _connection.phase == ConnectionPhase.online) {
      _transition(ConnectionPhase.syncing);
      try {
        await reconnectRoom(roomId);
      } catch (error) {
        _setError('TRANSPORT_UNAVAILABLE', error.toString());
        _emit();
      }
      return;
    }
    if (_connection.phase == ConnectionPhase.syncing && roomId != null) {
      try {
        await reconnectRoom(roomId);
      } catch (error) {
        _setError('TRANSPORT_UNAVAILABLE', error.toString());
        _emit();
      }
    }
  }

  Future<void> login(String phone, String code) async {
    if (_connection.phase == ConnectionPhase.disconnected) await connect();
    await sendCommand('login', {
      'phone': phone,
      'code': code,
      'deviceId': deviceId,
      'platform': platform,
    });
  }

  Future<void> refresh() async {
    final token = _refreshToken;
    if (token == null) {
      _setError('AUTH_REQUIRED', 'No refresh session is available');
      return;
    }
    if (_connection.phase == ConnectionPhase.disconnected) await connect();
    await sendCommand('refresh', {'refreshToken': token});
  }

  Future<void> logout() async {
    if (_accessToken != null && _transport.isConnected) {
      await sendCommand('logout', {'accessToken': _accessToken});
    }
    _accessToken = null;
    _refreshToken = null;
    _clearPending();
    _snapshot = _snapshot.copyWith(
      clearSession: true,
      clearUser: true,
      clearDisplayName: true,
      clearRoom: true,
      clearRoomSnapshot: true,
      roomVersion: -1,
      pendingCommandCount: 0,
      clearError: true,
    );
    _room.reset();
    if (_connection.phase != ConnectionPhase.disconnected) {
      _transition(ConnectionPhase.disconnected);
    } else {
      _emit();
    }
  }

  Future<String> createRoom(
      {String? clubId,
      String? floorId,
      String ruleVersion = 'susong_v1',
      Map<String, dynamic>? ruleConfig}) {
    return sendCommand('create_room', {
      'clubId': clubId,
      'floorId': floorId,
      'ruleVersion': ruleVersion,
      if (ruleConfig != null)
        'ruleConfig': Map<String, dynamic>.from(ruleConfig),
      'maxPlayers': 4,
    });
  }

  Future<String> joinRoom(String roomId, {String? name}) {
    return sendCommand(
      'join_room',
      {'name': name ?? _snapshot.displayName ?? '玩家'},
      roomId: roomId,
    );
  }

  Future<String> leaveRoom(String roomId, {String? transferOwnerTo}) {
    return sendCommand(
      'leave_room',
      {
        if (transferOwnerTo != null) 'transferOwnerTo': transferOwnerTo,
      },
      roomId: roomId,
    );
  }

  Future<String> setReady(String roomId, {bool ready = true}) {
    return sendCommand(
      'ready',
      {'ready': ready},
      roomId: roomId,
    );
  }

  Future<String> startRound(String roomId) =>
      sendCommand('start_round', {}, roomId: roomId);

  Future<String> beginPlaying(String roomId) =>
      sendCommand('begin_playing', {}, roomId: roomId);

  Future<String> increaseZeng(String roomId) => sendCommand(
        'increase_zeng',
        const {},
        roomId: roomId,
        roomVersion: _room.roomVersion < 0 ? null : _room.roomVersion,
      );

  Future<String> action(String roomId, String action) => sendCommand(
        'action',
        {'action': action},
        roomId: roomId,
        roomVersion: _room.roomVersion < 0 ? null : _room.roomVersion,
      );

  Future<String> settleRound(
    String roomId, {
    Map<String, dynamic>? settlement,
  }) {
    return sendCommand(
      'settle_round',
      {if (settlement != null) 'settlement': settlement},
      roomId: roomId,
    );
  }

  Future<String> nextRound(String roomId, {bool autoDeal = false}) {
    return sendCommand(
      'next_round',
      {'autoDeal': autoDeal},
      roomId: roomId,
    );
  }

  Future<String> disbandRoom(String roomId, {String? reason}) {
    return sendCommand(
      'disband_room',
      {if (reason != null) 'reason': reason},
      roomId: roomId,
    );
  }

  Future<String> reconnectRoom(String roomId) async {
    if (_connection.phase == ConnectionPhase.disconnected) await connect();
    if (_connection.phase == ConnectionPhase.online) {
      _snapshot = _snapshot.copyWith(syncRequired: true);
      _transition(ConnectionPhase.syncing);
    }
    return sendCommand(
      'reconnect',
      {'lastRoomVersion': math.max(0, _room.roomVersion)},
      roomId: roomId,
      roomVersion: math.max(0, _room.roomVersion),
    );
  }

  Duration nextReconnectDelay() => _connection.nextBackoff();

  Future<String> sendCommand(
    String type,
    Map<String, dynamic> payload, {
    String? roomId,
    int? roomVersion,
  }) async {
    if (_disposed) throw StateError('client controller is disposed');
    const sessionCommands = {
      'hello',
      'auth',
      'login',
      'refresh',
      'logout',
      'ping',
    };
    final canSendBusinessCommand = _connection.phase ==
            ConnectionPhase.online ||
        (type == 'reconnect' && _connection.phase == ConnectionPhase.syncing);
    if (!sessionCommands.contains(type) && !canSendBusinessCommand) {
      throw ProtocolException(
        'STATE_INVALID',
        'business commands are disabled until the connection is online',
        r'$.connectionPhase',
      );
    }
    final now = _clock().toUtc();
    final command = CommandEnvelope(
      protocolVersion: protocolVersion,
      type: type,
      requestId: newProtocolId(_random),
      commandId: newProtocolId(_random),
      payload: Map<String, dynamic>.from(payload),
      roomId: roomId,
      roomVersion: roomVersion,
      clientTime: now,
    );
    final entry = _PendingCommand(
      message: command.toJson(),
      createdAt: now,
    );
    _pending[command.commandId] = entry;
    _emit();
    try {
      await _sendPending(entry, propagateError: true);
    } catch (error) {
      _setError('TRANSPORT_UNAVAILABLE', error.toString());
      _emit();
      rethrow;
    }
    return command.commandId;
  }

  /// Retries one queued command when the current connection phase allows it.
  /// The original envelope, including `commandId` (and `requestId`), is sent
  /// again. A command that is already being sent is left untouched so callers
  /// cannot create concurrent duplicate requests.
  Future<bool> retryCommand(String commandId) async {
    if (_disposed) return false;
    final entry = _pending[commandId];
    if (entry == null) return false;
    entry.blockedByVersionConflict = false;
    entry.blockedByMaintenance = false;
    _refreshRoomVersionForRetry(entry);
    if (!_canReplayEntry(entry)) return false;
    _snapshot = _snapshot.copyWith(clearError: true);
    _emit();
    try {
      return await _sendPending(entry, propagateError: true);
    } catch (_) {
      return false;
    }
  }

  /// Replays every queued command allowed by the current phase. Returns the
  /// number of transport sends that completed; ACKs may remove entries while
  /// this method is running, and are intentionally not counted separately.
  Future<int> retryPendingCommands({bool includeBlocked = false}) {
    if (includeBlocked) {
      for (final entry in _pending.values) {
        entry.blockedByVersionConflict = false;
        entry.blockedByMaintenance = false;
        _refreshRoomVersionForRetry(entry);
      }
      _snapshot = _snapshot.copyWith(clearError: true);
      _emit();
    }
    return _replayPendingCommands();
  }

  void _refreshRoomVersionForRetry(_PendingCommand entry) {
    final roomId = entry.message['roomId']?.toString();
    if (roomId == null || roomId != _snapshot.roomId) return;
    if (!entry.message.containsKey('roomVersion')) return;
    if (_room.roomVersion < 0) return;
    entry.message['roomVersion'] = _room.roomVersion;
  }

  void _handleMessage(Map<String, dynamic> message) {
    if (_disposed) return;
    final type = message['type'];

    if (type == 'error') {
      _handleErrorMessage(message);
      return;
    }

    EventEnvelope event;
    try {
      event = EventEnvelope.fromJson(message);
    } on ProtocolException catch (error) {
      _setError(error.code, error.message);
      _emit();
      return;
    }

    // A room event can carry the originating commandId for correlation, but
    // it is a broadcast notification rather than an acknowledgement. Only a
    // protocol response that explicitly completes a command removes it.
    if (_successfulResponseTypes.contains(event.type) &&
        event.commandId != null) {
      _completePending(event.commandId!);
    }

    final payload = event.payload;
    switch (event.type) {
      case 'hello_ack':
        if (_connection.phase == ConnectionPhase.authenticating &&
            _accessToken == null) {
          // A login that was interrupted by a disconnect can be replayed once
          // the fresh hello handshake has completed.
          unawaited(_replayPendingCommands());
          _emit();
        }
      case 'login_ok':
      case 'refresh_ok':
        _acceptSession(payload);
      case 'auth_ok':
        _acceptPrincipal(payload);
      case 'logout_ok':
        _accessToken = null;
        _refreshToken = null;
        _transition(ConnectionPhase.disconnected);
      case 'room_created':
        _acceptRoomSnapshot(payload, event.roomId);
      case 'room_event':
        _applyRoomEvent(event);
      case 'room_sync':
        _applyRoomSync(event);
      case 'pong':
      case 'command_ack':
        _emit();
      default:
        _emit();
    }
  }

  void _handleErrorMessage(Map<String, dynamic> message) {
    final error = message['error'];
    final code = error is Map ? error['code']?.toString() : 'INVALID_MESSAGE';
    final detail =
        error is Map ? error['message']?.toString() : 'Invalid server error';
    final commandId = message['commandId'];
    final retryable = error is Map && error['retryable'] == true;
    final pendingEntry = commandId is String ? _pending[commandId] : null;
    // VERSION_CONFLICT and maintenance are intentionally retained in the
    // outbox: the user can retry with a fresh snapshot / after the service is
    // available. Other non-retryable errors are terminal for that command.
    final keepForManualRetry = pendingEntry != null &&
        _replayableCommandTypes.contains(pendingEntry.type) &&
        (code == 'VERSION_CONFLICT' || _isMaintenanceCode(code));
    if (commandId is String && !retryable && !keepForManualRetry) {
      _completePending(commandId);
    }
    _setError(code ?? 'INVALID_MESSAGE', detail ?? 'Request failed');
    if (code == 'VERSION_CONFLICT') {
      // The command was not accepted against the authoritative version. Keep
      // it visible to the user for an explicit retry, but prevent the timeout
      // worker from replaying the same stale expectedRoomVersion forever.
      if (commandId is String) {
        final entry = pendingEntry;
        if (entry != null) {
          entry.blockedByVersionConflict = true;
          entry.cancelTimers();
        }
      }
      final roomId = message['roomId']?.toString() ?? _snapshot.roomId;
      if (roomId != null &&
          _transport.isConnected &&
          _connection.phase == ConnectionPhase.online) {
        _snapshot = _snapshot.copyWith(syncRequired: true);
        _transition(ConnectionPhase.syncing);
        unawaited(_requestRoomSync(roomId));
      } else {
        _emit();
      }
      return;
    }
    if (_isMaintenanceCode(code)) {
      enterMaintenance(
        code: code ?? 'SERVICE_MAINTENANCE',
        message: detail ?? '服务维护中，请稍后重试',
      );
      return;
    }
    // Retryable application errors stay in the outbox for a later sync or
    // explicit retry. VERSION_CONFLICT is handled above to avoid an automatic
    // loop with a stale room version.
    _emit();
  }

  static const _maintenanceCodes = <String>{
    'MAINTENANCE',
    'SERVICE_MAINTENANCE',
    'SERVER_MAINTENANCE',
    'SERVICE_UNAVAILABLE',
    'SERVER_DRAINING',
  };

  static bool _isMaintenanceCode(String? code) =>
      code != null && _maintenanceCodes.contains(code);

  static const _successfulResponseTypes = <String>{
    'hello_ack',
    'auth_ok',
    'login_ok',
    'refresh_ok',
    'logout_ok',
    'command_ack',
    'room_created',
    'room_sync',
    'pong',
  };

  static const _replayableCommandTypes = <String>{
    'login',
    'refresh',
    'logout',
    'create_room',
    'join_room',
    'leave_room',
    'ready',
    'increase_zeng',
    'start_round',
    'begin_playing',
    'action',
    'settle_round',
    'next_round',
    'disband_room',
    'reconnect',
    'subscribe',
    'unsubscribe',
  };

  bool _canReplayEntry(_PendingCommand entry) {
    if (!_transport.isConnected) return false;
    if (!_replayableCommandTypes.contains(entry.type)) return false;
    if (entry.blockedByVersionConflict || entry.blockedByMaintenance) {
      return false;
    }
    switch (_connection.phase) {
      case ConnectionPhase.authenticating:
        return entry.type == 'login' || entry.type == 'refresh';
      case ConnectionPhase.online:
        return true;
      case ConnectionPhase.syncing:
        return entry.type == 'reconnect';
      case ConnectionPhase.disconnected:
      case ConnectionPhase.connecting:
      case ConnectionPhase.maintenance:
        return false;
    }
  }

  Future<bool> _sendPending(
    _PendingCommand entry, {
    required bool propagateError,
  }) async {
    if (_disposed || _pending[entry.commandId] != entry) return false;
    if (entry.sending) return false;
    if (!_transport.isConnected) {
      final error = StateError('protocol transport is disconnected');
      if (propagateError) throw error;
      return false;
    }

    entry.sending = true;
    entry.attempts += 1;
    entry.lastSentAt = _clock().toUtc();
    entry.retryTimer?.cancel();
    entry.retryTimer = null;
    entry.timeoutTimer?.cancel();
    entry.timeoutTimer = null;
    try {
      // Do not clone or rebuild the envelope here. Reusing this exact map
      // keeps the commandId stable across every retry.
      await _transport.send(entry.message);
      if (_pending[entry.commandId] == entry) _scheduleTimeout(entry);
      return true;
    } catch (error) {
      if (_pending[entry.commandId] == entry) {
        _setError('TRANSPORT_UNAVAILABLE', error.toString());
        if (_transport.isConnected) _scheduleRetry(entry);
        _emit();
      }
      if (propagateError) rethrow;
      return false;
    } finally {
      entry.sending = false;
    }
  }

  void _scheduleTimeout(_PendingCommand entry) {
    if (_disposed || _pending[entry.commandId] != entry) return;
    final timeout = commandTimeout <= Duration.zero
        ? const Duration(milliseconds: 1)
        : commandTimeout;
    entry.timeoutTimer = _timerFactory(timeout, () {
      entry.timeoutTimer = null;
      if (_disposed || _pending[entry.commandId] != entry) return;
      _setError('COMMAND_TIMEOUT', 'command ${entry.commandId} timed out');
      _emit();
      if (_canReplayEntry(entry)) {
        unawaited(_sendPending(entry, propagateError: false));
      }
    });
  }

  void _scheduleRetry(_PendingCommand entry) {
    if (_disposed || _pending[entry.commandId] != entry) return;
    if (entry.retryTimer != null || !_canReplayEntry(entry)) return;
    final delay = retryBackoff <= Duration.zero
        ? const Duration(milliseconds: 1)
        : retryBackoff;
    entry.retryTimer = _timerFactory(delay, () {
      entry.retryTimer = null;
      if (_disposed || _pending[entry.commandId] != entry) return;
      unawaited(_sendPending(entry, propagateError: false));
    });
  }

  void _completePending(String commandId) {
    final entry = _pending.remove(commandId);
    if (entry == null) return;
    entry.cancelTimers();
  }

  void _clearPending() {
    for (final entry in _pending.values) {
      entry.cancelTimers();
    }
    _pending.clear();
  }

  void _acceptSession(Map<String, dynamic> payload) {
    final access = payload['accessToken'];
    final refresh = payload['refreshToken'];
    final session = payload['sessionId'];
    final user = payload['user'];
    if (access is! String || refresh is! String || session is! String) {
      _setError('INVALID_MESSAGE', 'login response is missing session fields');
      _emit();
      return;
    }
    _accessToken = access;
    _refreshToken = refresh;
    _snapshot = _snapshot.copyWith(
      sessionId: session,
      userId: user is Map ? user['id']?.toString() : null,
      displayName: user is Map ? user['displayName']?.toString() : null,
      clearError: true,
    );
    _resumeAfterAuthentication();
  }

  void _acceptPrincipal(Map<String, dynamic> payload) {
    final session = payload['sessionId'];
    final user = payload['userId'];
    if (session is! String || user is! String) {
      _setError('INVALID_MESSAGE', 'auth response is missing principal fields');
      _emit();
      return;
    }
    _snapshot = _snapshot.copyWith(
      sessionId: session,
      userId: user,
      displayName: payload['displayName']?.toString(),
      clearError: true,
    );
    _resumeAfterAuthentication();
  }

  void _resumeAfterAuthentication() {
    final roomId = _snapshot.roomId;
    if (_snapshot.syncRequired && roomId != null) {
      _transition(ConnectionPhase.syncing);
      final hasReconnect = _pending.values.any(
        (entry) =>
            entry.type == 'reconnect' && entry.message['roomId'] == roomId,
      );
      if (hasReconnect) {
        unawaited(_replayPendingCommands());
      } else {
        unawaited(_requestRoomSync(roomId));
      }
      return;
    }
    _transition(ConnectionPhase.online);
    unawaited(_replayPendingCommands());
  }

  Future<void> _requestRoomSync(String roomId) async {
    try {
      await reconnectRoom(roomId);
    } catch (error) {
      _setError('TRANSPORT_UNAVAILABLE', error.toString());
      _emit();
    }
  }

  void _acceptRoomSnapshot(Map<String, dynamic> payload, String? eventRoomId) {
    final id = eventRoomId ?? payload['id']?.toString();
    if (id == null) {
      _setError('INVALID_MESSAGE', 'room_created response is missing room id');
      _emit();
      return;
    }
    try {
      _room.applySync({'snapshot': payload});
    } on ProtocolException catch (error) {
      _setError(error.code, error.message);
      _emit();
      return;
    }
    _snapshot = _snapshot.copyWith(
      roomId: id,
      roomVersion: _room.roomVersion,
      roomSnapshot: _room.snapshot,
      clearError: true,
    );
    _emit();
  }

  void _applyRoomEvent(EventEnvelope event) {
    final result = _room.apply(event);
    if (event.roomId != null) {
      _snapshot = _snapshot.copyWith(roomId: event.roomId);
    }
    if (result == ApplyResult.syncRequired) {
      _snapshot = _snapshot.copyWith(
          syncRequired: true, roomVersion: _room.roomVersion);
      if (_connection.phase == ConnectionPhase.online) {
        _transition(ConnectionPhase.syncing);
      }
      final id = _snapshot.roomId;
      if (id != null) unawaited(reconnectRoom(id));
    } else {
      _snapshot = _snapshot.copyWith(
        syncRequired: _room.syncRequired,
        roomVersion: _room.roomVersion,
        roomSnapshot: _room.snapshot,
      );
    }
    _emit();
  }

  void _applyRoomSync(EventEnvelope event) {
    var gapDetected = false;
    try {
      _room.applySync(event.payload);
      final events = event.payload['events'];
      if (events is List) {
        for (final raw in events) {
          // The current Node skeleton's history entries are audit-shaped
          // (`version/type/payload`) rather than protocol deltas. The snapshot
          // remains authoritative; only apply entries that already carry a
          // versioned event envelope so we never invent state from metadata.
          if (raw is Map && raw['roomVersion'] is int) {
            final candidate = Map<String, dynamic>.from(raw);
            candidate['protocolVersion'] ??= protocolVersion;
            candidate['type'] ??= 'room_event';
            candidate['eventId'] ??= newProtocolId(_random);
            candidate['roomVersion'] ??= raw['version'];
            candidate['roomId'] ??= _snapshot.roomId;
            candidate['payload'] ??= <String, dynamic>{};
            candidate['occurredAt'] ??=
                DateTime.now().toUtc().toIso8601String();
            final parsed = EventEnvelope.fromJson(candidate);
            final result = _room.apply(parsed);
            if (result == ApplyResult.syncRequired) gapDetected = true;
          }
        }
      }
    } on ProtocolException catch (error) {
      _setError(error.code, error.message);
      _emit();
      return;
    }
    final preserveManualConflict =
        _snapshot.lastErrorCode == 'VERSION_CONFLICT';
    _snapshot = _snapshot.copyWith(
      roomVersion: _room.roomVersion,
      roomSnapshot: _room.snapshot,
      syncRequired: gapDetected || _room.syncRequired,
      clearError:
          !(gapDetected || _room.syncRequired) && !preserveManualConflict,
    );
    if (gapDetected || _room.syncRequired) {
      _setError('SYNC_REQUIRED', 'room sync response still has a version gap');
      _emit();
    } else if (_connection.phase == ConnectionPhase.syncing) {
      _transition(ConnectionPhase.online);
      unawaited(_replayPendingCommands());
    } else {
      _emit();
    }
  }

  void _transition(ConnectionPhase next) {
    if (_connection.phase == next) {
      _emit();
      return;
    }
    try {
      _connection.transition(next);
    } on ProtocolException catch (error) {
      _setError(error.code, error.message);
      _emit();
      return;
    }
    _snapshot = _snapshot.copyWith(
      phase: _connection.phase,
      attempts: _connection.attempts,
      pendingCommandCount: _pending.length,
    );
    _emit();
  }

  void _markDisconnected() {
    // Keep only commands that are safe to replay after a fresh handshake.
    // Ephemeral hello/auth/ping envelopes are regenerated by `connect` and
    // must not survive as stale queue entries.
    _pending.removeWhere((_, entry) {
      entry.cancelTimers();
      return !_replayableCommandTypes.contains(entry.type);
    });
    // A room may continue advancing while this client is offline. Marking the
    // snapshot stale ensures the next handshake enters SYNCING before queued
    // business commands are replayed.
    if (_snapshot.roomId != null) {
      _snapshot = _snapshot.copyWith(syncRequired: true);
      _room.syncRequired = true;
    }
    if (_connection.phase != ConnectionPhase.disconnected) {
      _transition(ConnectionPhase.disconnected);
    } else {
      _snapshot = _snapshot.copyWith(
        phase: ConnectionPhase.disconnected,
        pendingCommandCount: _pending.length,
      );
      _emit();
    }
  }

  bool _replayInFlight = false;

  Future<int> _replayPendingCommands() async {
    if (_disposed || !_transport.isConnected || _replayInFlight) return 0;
    if (_connection.phase != ConnectionPhase.online &&
        _connection.phase != ConnectionPhase.authenticating &&
        _connection.phase != ConnectionPhase.syncing) {
      return 0;
    }
    _replayInFlight = true;
    var sent = 0;
    try {
      final commands = _pending.values.toList(growable: false);
      // A reconnect must be sent before ordinary room commands when both are
      // queued. This lets the server establish the latest room version first.
      commands.sort((left, right) {
        if (left.type == right.type) return 0;
        if (left.type == 'reconnect') return -1;
        if (right.type == 'reconnect') return 1;
        return 0;
      });
      for (final entry in commands) {
        if (!_canReplayEntry(entry)) continue;
        final completed = await _sendPending(entry, propagateError: false);
        if (completed) sent += 1;
        if (!_transport.isConnected) break;
      }
    } finally {
      _replayInFlight = false;
    }
    return sent;
  }

  void _setError(String code, String message) {
    _snapshot =
        _snapshot.copyWith(lastErrorCode: code, lastErrorMessage: message);
  }

  void _emit() {
    if (!_states.isClosed) {
      _snapshot = _snapshot.copyWith(pendingCommandCount: _pending.length);
      _states.add(_snapshot);
    }
  }

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _intentionalClose = true;
    _clearPending();
    await _messagesSubscription.cancel();
    await _closedSubscription.cancel();
    await _transport.close();
    await _states.close();
  }
}

extension on RoomStateReducer {
  void reset() {
    roomVersion = -1;
    snapshot = null;
    syncRequired = false;
    appliedEvents.clear();
  }
}
