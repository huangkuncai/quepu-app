import 'dart:async';

import 'package:flutter/material.dart';
import 'package:susong_protocol_client/client.dart';
import 'package:susong_protocol_client/protocol.dart';
import 'package:susong_protocol_client/support.dart';

import 'src/fake_transport.dart';

void main() => runApp(const SusongApp());

class SusongApp extends StatefulWidget {
  const SusongApp({super.key, this.transport, this.supportApi});

  final ProtocolTransport? transport;
  final SupportApi? supportApi;

  @override
  State<SusongApp> createState() => _SusongAppState();
}

class _SusongAppState extends State<SusongApp> with WidgetsBindingObserver {
  late final ProtocolTransport _transport;
  late final ClientSessionController _client;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _transport = widget.transport ?? FakeTransport();
    _client = ClientSessionController(
      transport: _transport,
      deviceId: 'poc-device',
      platform: 'web',
    );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _client.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      // Mobile platforms may suspend or kill a background WebSocket.  The
      // controller re-authenticates and requests an authoritative snapshot;
      // no background connection is promised by this POC.
      unawaited(_client.resumeFromBackground());
    }
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '宿松麻将',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xff126e67),
          brightness: Brightness.light,
        ),
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xfff5f7f6),
        inputDecorationTheme: const InputDecorationTheme(
          border: OutlineInputBorder(),
        ),
      ),
      home: StreamBuilder<ClientSnapshot>(
        stream: _client.states,
        initialData: _client.snapshot,
        builder: (context, state) {
          final snapshot = state.data ?? _client.snapshot;
          if (!snapshot.isAuthenticated) {
            return LoginPage(client: _client, snapshot: snapshot);
          }
          return HomePage(
            client: _client,
            snapshot: snapshot,
            supportApi: widget.supportApi,
          );
        },
      ),
    );
  }
}

class LoginPage extends StatefulWidget {
  const LoginPage({required this.client, required this.snapshot, super.key});

  final ClientSessionController client;
  final ClientSnapshot snapshot;

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  late final TextEditingController _phone;
  late final TextEditingController _code;
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    _phone = TextEditingController(text: '13800000000');
    _code = TextEditingController(text: '000000');
  }

  @override
  void dispose() {
    _phone.dispose();
    _code.dispose();
    super.dispose();
  }

  Future<void> _login() async {
    if (_submitting) return;
    setState(() => _submitting = true);
    try {
      await widget.client.login(_phone.text.trim(), _code.text.trim());
    } catch (_) {
      // The controller exposes a stable error snapshot for the next frame.
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final snapshot = widget.snapshot;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(28),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 430),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Icon(Icons.grid_view_rounded, size: 52),
                  const SizedBox(height: 18),
                  Text(
                    '宿松麻将',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.headlineMedium
                        ?.copyWith(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    '亲友圈实时牌局',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodyLarge,
                  ),
                  const SizedBox(height: 34),
                  TextField(
                    controller: _phone,
                    keyboardType: TextInputType.phone,
                    decoration: const InputDecoration(
                      labelText: '手机号',
                      prefixIcon: Icon(Icons.phone_outlined),
                    ),
                  ),
                  const SizedBox(height: 14),
                  TextField(
                    controller: _code,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                      labelText: '验证码',
                      helperText: '开发环境验证码：000000',
                      prefixIcon: Icon(Icons.lock_outline),
                    ),
                  ),
                  const SizedBox(height: 22),
                  FilledButton.icon(
                    onPressed: _submitting ? null : _login,
                    icon: _submitting
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.login),
                    label: Text(_submitting ? '登录中' : '进入大厅'),
                  ),
                  if (snapshot.lastErrorMessage != null) ...[
                    const SizedBox(height: 14),
                    _ErrorBanner(snapshot: snapshot),
                  ],
                  const SizedBox(height: 30),
                  Text(
                    '当前为开发期 POC，未接入支付、充值或提现能力。',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class HomePage extends StatefulWidget {
  const HomePage({
    required this.client,
    required this.snapshot,
    this.supportApi,
    super.key,
  });

  final ClientSessionController client;
  final ClientSnapshot snapshot;
  final SupportApi? supportApi;

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    final pages = [
      LobbyTab(client: widget.client, snapshot: widget.snapshot),
      ClubTab(snapshot: widget.snapshot),
      HistoryTab(snapshot: widget.snapshot),
      SupportTab(api: widget.supportApi),
    ];
    return Scaffold(
      appBar: AppBar(
        title: Text(['大厅', '俱乐部', '战绩', '客服'][_index]),
        actions: [
          IconButton(
            tooltip: '退出登录',
            onPressed: widget.client.logout,
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: SafeArea(child: pages[_index]),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (value) => setState(() => _index = value),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.home_outlined),
            selectedIcon: Icon(Icons.home),
            label: '大厅',
          ),
          NavigationDestination(
            icon: Icon(Icons.groups_outlined),
            selectedIcon: Icon(Icons.groups),
            label: '俱乐部',
          ),
          NavigationDestination(
            icon: Icon(Icons.history_outlined),
            selectedIcon: Icon(Icons.history),
            label: '战绩',
          ),
          NavigationDestination(
            icon: Icon(Icons.support_agent_outlined),
            selectedIcon: Icon(Icons.support_agent),
            label: '客服',
          ),
        ],
      ),
    );
  }
}

class LobbyTab extends StatelessWidget {
  const LobbyTab({required this.client, required this.snapshot, super.key});

  final ClientSessionController client;
  final ClientSnapshot snapshot;

  Future<void> _run(
    Future<String> Function() operation,
    BuildContext context,
  ) async {
    try {
      await operation();
    } catch (_) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('操作未发送，请检查连接状态')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final room = snapshot.roomSnapshot;
    final players = room?['players'];
    final playerCount = players is List ? players.length : 0;
    final connected = snapshot.phase == ConnectionPhase.online;
    return ListView(
      padding: const EdgeInsets.fromLTRB(18, 12, 18, 24),
      children: [
        _ConnectionCard(snapshot: snapshot, client: client),
        const SizedBox(height: 14),
        Text('快速开始', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(
              child: FilledButton.icon(
                onPressed: connected
                    ? () => _run(client.createRoom, context)
                    : null,
                icon: const Icon(Icons.add_box_outlined),
                label: const Text('创建演示房'),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: OutlinedButton.icon(
                onPressed: snapshot.roomId == null
                    ? null
                    : () => _run(
                        () => client.joinRoom(snapshot.roomId!),
                        context,
                      ),
                icon: const Icon(Icons.login),
                label: const Text('加入房间'),
              ),
            ),
          ],
        ),
        const SizedBox(height: 18),
        Text('当前房间', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 10),
        if (room == null)
          const _EmptyState(
            icon: Icons.table_restaurant_outlined,
            title: '还没有进行中的房间',
            message: '创建演示房后可验证公共事件和断线同步。',
          )
        else ...[
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          '房号 ${snapshot.roomId}',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                      ),
                      Chip(label: Text('版本 ${snapshot.roomVersion}')),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text('规则：${room['rule'] ?? 'susong_v1'}'),
                  Text('状态：${room['status'] ?? 'waiting'} · $playerCount/4 人'),
                  const SizedBox(height: 14),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      FilledButton.tonalIcon(
                        onPressed: () => Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (_) => RoomPage(client: client),
                          ),
                        ),
                        icon: const Icon(Icons.table_restaurant),
                        label: const Text('进入牌桌'),
                      ),
                      OutlinedButton.icon(
                        onPressed: () => _run(
                          () => client.joinRoom(snapshot.roomId!),
                          context,
                        ),
                        icon: const Icon(Icons.person_add_alt_1),
                        label: const Text('加入'),
                      ),
                      OutlinedButton.icon(
                        onPressed: () => _run(
                          () => client.action(snapshot.roomId!, 'pass'),
                          context,
                        ),
                        icon: const Icon(Icons.touch_app_outlined),
                        label: const Text('模拟动作'),
                      ),
                      OutlinedButton.icon(
                        onPressed: () => _run(
                          () => client.reconnectRoom(snapshot.roomId!),
                          context,
                        ),
                        icon: const Icon(Icons.sync),
                        label: const Text('同步'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 10),
          FilledButton.tonalIcon(
            onPressed: connected ? () => client.sendCommand('ping', {}) : null,
            icon: const Icon(Icons.wifi_tethering),
            label: const Text('发送心跳'),
          ),
        ],
        const SizedBox(height: 18),
        OutlinedButton.icon(
          onPressed: client.transport is FakeTransport
              ? (client.transport as FakeTransport).simulateDisconnect
              : null,
          icon: const Icon(Icons.signal_wifi_connected_no_internet_4),
          label: const Text('模拟断线'),
        ),
      ],
    );
  }
}

class RoomPage extends StatelessWidget {
  const RoomPage({required this.client, super.key});

  final ClientSessionController client;

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<ClientSnapshot>(
      stream: client.states,
      initialData: client.snapshot,
      builder: (context, state) {
        final snapshot = state.data ?? client.snapshot;
        final room = snapshot.roomSnapshot;
        return Scaffold(
          appBar: AppBar(
            title: Text('房间 ${snapshot.roomId ?? '—'}'),
            actions: [
              IconButton(
                tooltip: '同步房间',
                onPressed: snapshot.roomId == null
                    ? null
                    : () => _run(
                        () => client.reconnectRoom(snapshot.roomId!),
                        context,
                      ),
                icon: const Icon(Icons.sync),
              ),
            ],
          ),
          body: room == null
              ? const _EmptyState(
                  icon: Icons.table_restaurant_outlined,
                  title: '房间状态暂不可用',
                  message: '返回大厅后重新进入房间。',
                )
              : _RoomTable(client: client, snapshot: snapshot, room: room),
        );
      },
    );
  }

  Future<void> _run(
    Future<String> Function() operation,
    BuildContext context,
  ) async {
    try {
      await operation();
    } catch (_) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('操作未发送，请检查连接状态')));
      }
    }
  }
}

class _RoomTable extends StatelessWidget {
  const _RoomTable({
    required this.client,
    required this.snapshot,
    required this.room,
  });

  final ClientSessionController client;
  final ClientSnapshot snapshot;
  final Map<String, dynamic> room;

  @override
  Widget build(BuildContext context) {
    final roomId = snapshot.roomId;
    if (roomId == null) return const SizedBox.shrink();
    final seats = _roomSeats(room);
    final players = _roomPlayers(room);
    final current = _findPlayer(players, snapshot.userId);
    final status = room['status']?.toString() ?? 'waiting';
    final ready = current?['ready'] == true;
    final isOwner =
        room['ownerId'] == null ||
        room['ownerId']?.toString() == snapshot.userId;
    final canReady =
        current != null && (status == 'waiting' || status == 'ready');
    final canStart =
        current != null &&
        isOwner &&
        (status == 'waiting' || status == 'ready');
    final connected = snapshot.phase == ConnectionPhase.online;
    final maxPlayers = _positiveInt(room['maxPlayers']) ?? seats.length;
    return ListView(
      padding: const EdgeInsets.fromLTRB(18, 14, 18, 28),
      children: [
        _RoomStatusStrip(
          status: _roomStatusLabel(status),
          version: snapshot.roomVersion,
          connected:
              _positiveInt(room['connectedCount']) ??
              players.where((player) => player['connected'] == true).length,
          maxPlayers: maxPlayers,
          ready:
              _positiveInt(room['readyCount']) ??
              players.where((player) => player['ready'] == true).length,
        ),
        const SizedBox(height: 18),
        Row(
          children: [
            Text('座位', style: Theme.of(context).textTheme.titleLarge),
            const Spacer(),
            Text(
              '${players.length}/$maxPlayers',
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ],
        ),
        const SizedBox(height: 10),
        GridView.builder(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          itemCount: seats.length,
          gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: 2,
            mainAxisSpacing: 10,
            crossAxisSpacing: 10,
            childAspectRatio: 1.35,
          ),
          itemBuilder: (context, index) => _SeatTile(
            seat: index,
            player: seats[index],
            ownerId: room['ownerId']?.toString(),
          ),
        ),
        const SizedBox(height: 18),
        Text('牌桌操作', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 10),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            if (current == null)
              FilledButton.icon(
                onPressed: connected
                    ? () => _run(() => client.joinRoom(roomId), context)
                    : null,
                icon: const Icon(Icons.person_add_alt_1),
                label: const Text('加入房间'),
              ),
            if (canReady)
              FilledButton.tonalIcon(
                onPressed: connected
                    ? () => _run(
                        () => client.setReady(roomId, ready: !ready),
                        context,
                      )
                    : null,
                icon: Icon(ready ? Icons.undo : Icons.check_circle_outline),
                label: Text(ready ? '取消准备' : '准备'),
              ),
            if (canStart)
              FilledButton.icon(
                onPressed: connected
                    ? () => _run(() => client.startRound(roomId), context)
                    : null,
                icon: const Icon(Icons.play_arrow),
                label: const Text('开始演示局'),
              ),
            if (status == 'playing')
              OutlinedButton.icon(
                onPressed: connected
                    ? () => _run(() => client.action(roomId, 'pass'), context)
                    : null,
                icon: const Icon(Icons.touch_app_outlined),
                label: const Text('模拟动作'),
              ),
            OutlinedButton.icon(
              onPressed: connected
                  ? () => _run(() => client.reconnectRoom(roomId), context)
                  : null,
              icon: const Icon(Icons.sync),
              label: const Text('同步状态'),
            ),
          ],
        ),
        const SizedBox(height: 18),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.visibility_off_outlined),
          title: const Text('我的手牌'),
          subtitle: const Text('牌面将在规则裁判接入后显示'),
          trailing: const Chip(label: Text('占位')),
        ),
        if (snapshot.lastErrorMessage != null) ...[
          const SizedBox(height: 8),
          _ErrorBanner(snapshot: snapshot),
        ],
      ],
    );
  }

  Future<void> _run(
    Future<String> Function() operation,
    BuildContext context,
  ) async {
    try {
      await operation();
    } catch (_) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('操作未发送，请检查连接状态')));
      }
    }
  }
}

class _RoomStatusStrip extends StatelessWidget {
  const _RoomStatusStrip({
    required this.status,
    required this.version,
    required this.connected,
    required this.maxPlayers,
    required this.ready,
  });

  final String status;
  final int version;
  final int connected;
  final int maxPlayers;
  final int ready;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        child: Wrap(
          spacing: 18,
          runSpacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.circle, size: 10, color: colors.primary),
                const SizedBox(width: 8),
                Text(
                  status,
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
              ],
            ),
            Text('版本 $version'),
            Text('在线 $connected/$maxPlayers'),
            Text('准备 $ready/$maxPlayers'),
          ],
        ),
      ),
    );
  }
}

class _SeatTile extends StatelessWidget {
  const _SeatTile({
    required this.seat,
    required this.player,
    required this.ownerId,
  });

  final int seat;
  final Map<String, dynamic>? player;
  final String? ownerId;

  @override
  Widget build(BuildContext context) {
    final occupied = player != null;
    final name = occupied ? _playerName(player!) : '等待加入';
    final online = player?['connected'] == true;
    final ready = player?['ready'] == true;
    final isOwner = occupied && player!['id']?.toString() == ownerId;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(
                  '座位 ${seat + 1}',
                  style: Theme.of(context).textTheme.labelLarge,
                ),
                const Spacer(),
                Icon(
                  online ? Icons.wifi : Icons.wifi_off,
                  size: 16,
                  color: online ? Colors.green : Colors.grey,
                ),
              ],
            ),
            const Spacer(),
            Text(
              name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 4),
            if (occupied)
              Row(
                children: [
                  Icon(
                    ready ? Icons.check_circle : Icons.hourglass_empty,
                    size: 15,
                    color: ready ? Colors.green : Colors.grey,
                  ),
                  const SizedBox(width: 4),
                  Text(ready ? '已准备' : '未准备'),
                  if (isOwner) ...[
                    const SizedBox(width: 8),
                    const Icon(Icons.star, size: 15),
                    const SizedBox(width: 3),
                    const Text('房主'),
                  ],
                ],
              )
            else
              Text('空位', style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
      ),
    );
  }
}

List<Map<String, dynamic>> _roomPlayers(Map<String, dynamic> room) {
  final raw = room['players'];
  if (raw is! List) return const [];
  return raw
      .whereType<Map>()
      .map((value) => Map<String, dynamic>.from(value))
      .toList(growable: false);
}

List<Map<String, dynamic>?> _roomSeats(Map<String, dynamic> room) {
  final rawSeats = room['seats'];
  if (rawSeats is List && rawSeats.isNotEmpty) {
    return rawSeats
        .map((raw) {
          if (raw is! Map) return null;
          final player = raw['player'];
          return player is Map ? Map<String, dynamic>.from(player) : null;
        })
        .toList(growable: false);
  }
  final maxPlayers = _positiveInt(room['maxPlayers']) ?? 4;
  final seats = List<Map<String, dynamic>?>.filled(maxPlayers, null);
  for (final player in _roomPlayers(room)) {
    final seat = player['seat'];
    if (seat is int && seat >= 0 && seat < seats.length) seats[seat] = player;
  }
  return seats;
}

Map<String, dynamic>? _findPlayer(
  List<Map<String, dynamic>> players,
  String? playerId,
) {
  if (playerId == null) return null;
  for (final player in players) {
    if (player['id']?.toString() == playerId ||
        player['playerId']?.toString() == playerId) {
      return player;
    }
  }
  return null;
}

String _playerName(Map<String, dynamic> player) {
  return player['displayName']?.toString() ??
      player['name']?.toString() ??
      player['id']?.toString() ??
      '玩家';
}

int? _positiveInt(Object? value) {
  return value is int && value > 0 ? value : null;
}

String _roomStatusLabel(String status) {
  const labels = {
    'waiting': '等待中',
    'ready': '已准备',
    'dealing': '发牌中',
    'playing': '进行中',
    'settling': '结算中',
    'next_round': '下一局',
    'finished': '已结束',
    'cancelled': '已解散',
  };
  return labels[status] ?? status;
}

class ClubTab extends StatelessWidget {
  const ClubTab({required this.snapshot, super.key});

  final ClientSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(18, 12, 18, 24),
      children: [
        const _SectionTitle(title: '我的俱乐部', subtitle: '申请和楼层规则由服务端审批控制'),
        Card(
          child: ListTile(
            leading: const CircleAvatar(child: Icon(Icons.groups)),
            title: const Text('宿松亲友圈演示俱乐部'),
            subtitle: const Text('成员状态：待审核 · 仅成员可按房号进入'),
            trailing: IconButton(
              tooltip: '查看楼层',
              onPressed: () => _showFloor(context),
              icon: const Icon(Icons.chevron_right),
            ),
          ),
        ),
        const SizedBox(height: 16),
        const _SectionTitle(title: '楼层规则', subtitle: '创建房间时冻结规则快照'),
        Card(
          child: ListTile(
            leading: const Icon(Icons.layers_outlined),
            title: const Text('宿松麻将 · 积分场'),
            subtitle: Text(
              '规则版本 susong_v1 · 当前房间版本 ${snapshot.roomVersion < 0 ? '-' : snapshot.roomVersion}',
            ),
            onTap: () => _showFloor(context),
          ),
        ),
      ],
    );
  }

  void _showFloor(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (context) => const SafeArea(
        child: Padding(
          padding: EdgeInsets.fromLTRB(24, 0, 24, 28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '楼层详情',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
              ),
              SizedBox(height: 12),
              Text('宿松麻将 · 积分结算 · 规则快照在开房时锁定'),
              SizedBox(height: 6),
              Text('当前为 POC 占位规则，未开放真实牌局和钻石扣除。'),
            ],
          ),
        ),
      ),
    );
  }
}

class HistoryTab extends StatelessWidget {
  const HistoryTab({required this.snapshot, super.key});

  final ClientSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(18, 12, 18, 24),
      children: [
        const _SectionTitle(title: '战绩', subtitle: '积分只用于每局结果展示，不是消费余额'),
        Card(
          child: ListTile(
            leading: const Icon(Icons.scoreboard_outlined),
            title: const Text('暂无已完成牌局'),
            subtitle: Text(
              '当前连接房间版本：${snapshot.roomVersion < 0 ? '—' : snapshot.roomVersion}',
            ),
          ),
        ),
      ],
    );
  }
}

class SupportTab extends StatefulWidget {
  const SupportTab({this.api, super.key});

  final SupportApi? api;

  @override
  State<SupportTab> createState() => _SupportTabState();
}

class _SupportTabState extends State<SupportTab> {
  final _controller = TextEditingController();
  bool _sent = false;
  bool _submitting = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_controller.text.trim().isEmpty) return;
    if (_submitting) return;
    setState(() => _submitting = true);
    try {
      if (widget.api != null) {
        await widget.api!.createTicket(
          subject: '客户端问题',
          message: _controller.text,
          clientVersion: '0.1.0-poc',
        );
      }
      if (mounted) {
        setState(() => _sent = true);
        _controller.clear();
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('提交失败，请稍后重试')));
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(18, 12, 18, 24),
      children: [
        const _SectionTitle(title: '联系客服', subtitle: '首版使用内置纯文本工单'),
        TextField(
          controller: _controller,
          maxLines: 5,
          maxLength: 500,
          decoration: const InputDecoration(
            labelText: '请描述遇到的问题',
            alignLabelWithHint: true,
            prefixIcon: Icon(Icons.chat_bubble_outline),
          ),
        ),
        const SizedBox(height: 10),
        FilledButton.icon(
          onPressed: _submit,
          icon: const Icon(Icons.send),
          label: Text(_submitting ? '提交中' : '提交工单'),
        ),
        if (_sent) ...[
          const SizedBox(height: 14),
          const Card(
            child: ListTile(
              leading: Icon(Icons.check_circle_outline),
              title: Text('已记录到演示工单'),
              subtitle: Text('正式环境将关联账号、房间号和客户端版本。'),
            ),
          ),
        ],
      ],
    );
  }
}

class _ConnectionCard extends StatelessWidget {
  const _ConnectionCard({required this.snapshot, required this.client});

  final ClientSnapshot snapshot;
  final ClientSessionController client;

  Future<void> _retry(BuildContext context) async {
    try {
      await client.retryConnection();
    } catch (_) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('重连失败，请稍后再试')));
      }
    }
  }

  Future<void> _retryPending(BuildContext context) async {
    try {
      await client.retryPendingCommands(includeBlocked: true);
    } catch (_) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('操作重试失败，请先确认连接已恢复')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final phase = snapshot.phase;
    final label = _connectionLabel(phase);
    final online = phase == ConnectionPhase.online;
    final recovering = snapshot.isRecovering;
    final maintenance = snapshot.isMaintenance;
    final conflict = snapshot.hasVersionConflict;
    final canReconnect =
        phase == ConnectionPhase.disconnected ||
        maintenance ||
        (phase == ConnectionPhase.syncing && snapshot.roomId != null);
    final canRetryPending =
        online && conflict && snapshot.pendingCommandCount > 0;
    final subtitle = _connectionDescription(snapshot);
    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
        child: Column(
          children: [
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(
                _connectionIcon(phase),
                color: _connectionColor(context, phase),
              ),
              title: Text('连接状态：$label'),
              subtitle: Text(subtitle),
              trailing: snapshot.pendingCommandCount == 0
                  ? null
                  : Badge(label: Text('${snapshot.pendingCommandCount}')),
            ),
            if (recovering) ...[
              const LinearProgressIndicator(minHeight: 3),
              const SizedBox(height: 10),
            ],
            if (maintenance)
              _ConnectionNotice(
                icon: Icons.build_circle_outlined,
                message: '服务正在维护，牌局状态不会丢失；请在维护结束后手动重试。',
                color: Theme.of(context).colorScheme.tertiaryContainer,
              ),
            if (conflict)
              _ConnectionNotice(
                icon: Icons.sync_problem_outlined,
                message: '房间版本已更新，已完成同步后再重试待处理操作。',
                color: Theme.of(context).colorScheme.errorContainer,
              ),
            if (canReconnect || canRetryPending) ...[
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerRight,
                child: Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  alignment: WrapAlignment.end,
                  children: [
                    if (canReconnect)
                      OutlinedButton.icon(
                        onPressed: () => _retry(context),
                        icon: Icon(
                          maintenance ? Icons.schedule : Icons.refresh,
                        ),
                        label: Text(
                          maintenance
                              ? '维护结束后重试'
                              : (phase == ConnectionPhase.syncing
                                    ? '重新同步'
                                    : '重新连接'),
                        ),
                      ),
                    if (canRetryPending)
                      FilledButton.tonalIcon(
                        onPressed: () => _retryPending(context),
                        icon: const Icon(Icons.replay),
                        label: const Text('重试待处理操作'),
                      ),
                  ],
                ),
              ),
            ],
            if (snapshot.lastErrorMessage != null && !maintenance && !conflict)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: _ErrorBanner(snapshot: snapshot),
              ),
          ],
        ),
      ),
    );
  }
}

class _ConnectionNotice extends StatelessWidget {
  const _ConnectionNotice({
    required this.icon,
    required this.message,
    required this.color,
  });

  final IconData icon;
  final String message;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const SizedBox(width: 2),
          Icon(icon, size: 18),
          const SizedBox(width: 8),
          Expanded(child: Text(message)),
        ],
      ),
    );
  }
}

String _connectionLabel(ConnectionPhase phase) {
  switch (phase) {
    case ConnectionPhase.disconnected:
      return '已断开';
    case ConnectionPhase.connecting:
      return '连接中';
    case ConnectionPhase.authenticating:
      return '验证中';
    case ConnectionPhase.syncing:
      return '同步中';
    case ConnectionPhase.online:
      return '在线';
    case ConnectionPhase.maintenance:
      return '维护中';
  }
}

String _connectionDescription(ClientSnapshot snapshot) {
  if (snapshot.phase == ConnectionPhase.online) {
    return snapshot.userId == null
        ? '已连接，等待登录'
        : '用户 ${snapshot.displayName ?? snapshot.userId}';
  }
  if (snapshot.phase == ConnectionPhase.syncing) {
    final version = snapshot.roomVersion < 0 ? '—' : snapshot.roomVersion;
    return '正在恢复房间状态（本地版本 $version）';
  }
  if (snapshot.phase == ConnectionPhase.maintenance) {
    return snapshot.lastErrorMessage ?? '服务维护中，请稍后重试';
  }
  if (snapshot.phase == ConnectionPhase.disconnected) {
    return '网络连接已断开，房间状态将在重连后同步';
  }
  return snapshot.lastErrorMessage ?? '正在建立安全连接';
}

IconData _connectionIcon(ConnectionPhase phase) {
  switch (phase) {
    case ConnectionPhase.online:
      return Icons.cloud_done;
    case ConnectionPhase.syncing:
      return Icons.sync;
    case ConnectionPhase.maintenance:
      return Icons.build_circle_outlined;
    case ConnectionPhase.connecting:
    case ConnectionPhase.authenticating:
      return Icons.cloud_queue;
    case ConnectionPhase.disconnected:
      return Icons.cloud_off;
  }
}

Color _connectionColor(BuildContext context, ConnectionPhase phase) {
  final colors = Theme.of(context).colorScheme;
  switch (phase) {
    case ConnectionPhase.online:
      return Colors.green.shade700;
    case ConnectionPhase.syncing:
    case ConnectionPhase.connecting:
    case ConnectionPhase.authenticating:
      return colors.primary;
    case ConnectionPhase.maintenance:
      return colors.tertiary;
    case ConnectionPhase.disconnected:
      return colors.error;
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.snapshot});

  final ClientSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    return Card(
      color: Theme.of(context).colorScheme.errorContainer,
      child: ListTile(
        leading: const Icon(Icons.error_outline),
        title: Text(snapshot.lastErrorCode ?? '操作失败'),
        subtitle: Text(snapshot.lastErrorMessage ?? ''),
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle({required this.title, required this.subtitle});

  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 4),
          Text(subtitle, style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({
    required this.icon,
    required this.title,
    required this.message,
  });

  final IconData icon;
  final String title;
  final String message;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(26),
        child: Column(
          children: [
            Icon(icon, size: 42),
            const SizedBox(height: 10),
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(message, textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }
}
