import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:susong_protocol_client/client.dart';
import 'package:susong_protocol_client/io_rest_transport.dart';
import 'package:susong_protocol_client/protocol.dart';
import 'package:susong_protocol_client/support.dart';

import 'src/fake_transport.dart';
import 'src/runtime_config.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await SystemChrome.setPreferredOrientations(const [
    DeviceOrientation.landscapeLeft,
    DeviceOrientation.landscapeRight,
  ]);
  runApp(SusongApp(runtimeConfig: AppRuntimeConfig.fromEnvironment()));
}

class SusongApp extends StatefulWidget {
  const SusongApp({
    super.key,
    this.transport,
    this.supportApi,
    this.runtimeConfig,
  });

  final ProtocolTransport? transport;
  final SupportApi? supportApi;
  final AppRuntimeConfig? runtimeConfig;

  @override
  State<SusongApp> createState() => _SusongAppState();
}

class _SusongAppState extends State<SusongApp> with WidgetsBindingObserver {
  late final ProtocolTransport _transport;
  late final ClientSessionController _client;
  late final AppRuntimeConfig _runtimeConfig;
  IoRestTransport? _restTransport;
  SupportApi? _supportApi;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _runtimeConfig = widget.runtimeConfig ?? AppRuntimeConfig.parse();
    _transport =
        widget.transport ??
        (_runtimeConfig.usesRemoteBackend
            ? _runtimeConfig.createTransport()
            : FakeTransport());
    _client = ClientSessionController(
      transport: _transport,
      deviceId: 'poc-device',
      platform: defaultTargetPlatform.name,
    );
    _supportApi = widget.supportApi;
    if (_supportApi == null && _runtimeConfig.hasRestBackend) {
      _restTransport = _runtimeConfig.createRestTransport();
      _supportApi = SupportApi(_restTransport!.forSession(_client));
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    final restTransport = _restTransport;
    if (restTransport != null) unawaited(restTransport.close());
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
          seedColor: const Color(0xff0a705a),
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xff063f36),
        cardTheme: CardThemeData(
          color: const Color(0xff163f38).withValues(alpha: 0.96),
          elevation: 5,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(18),
            side: const BorderSide(color: Color(0x55755a2b)),
          ),
        ),
        inputDecorationTheme: const InputDecorationTheme(
          border: OutlineInputBorder(),
          filled: true,
          fillColor: Color(0xfff8f2df),
        ),
      ),
      home: StreamBuilder<ClientSnapshot>(
        stream: _client.states,
        initialData: _client.snapshot,
        builder: (context, state) {
          final snapshot = state.data ?? _client.snapshot;
          if (!snapshot.isAuthenticated) {
            return LoginPage(
              client: _client,
              snapshot: snapshot,
              backendLabel: _runtimeConfig.displayLabel,
            );
          }
          return HomePage(
            client: _client,
            snapshot: snapshot,
            supportApi: _supportApi,
          );
        },
      ),
    );
  }
}

class LoginPage extends StatefulWidget {
  const LoginPage({
    required this.client,
    required this.snapshot,
    required this.backendLabel,
    super.key,
  });

  final ClientSessionController client;
  final ClientSnapshot snapshot;
  final String backendLabel;

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
      body: _GameBackdrop(
        child: SafeArea(
          child: LayoutBuilder(
            builder: (context, constraints) => SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  minHeight: constraints.maxHeight - 48,
                ),
                child: Row(
                  children: [
                    const Expanded(flex: 6, child: _LoginBrandPanel()),
                    const SizedBox(width: 28),
                    Expanded(
                      flex: 4,
                      child: Card(
                        color: const Color(0xfff8f2df),
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              Text(
                                widget.backendLabel,
                                textAlign: TextAlign.center,
                                style: const TextStyle(
                                  color: Color(0xff4d6d64),
                                  fontSize: 12,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                              const SizedBox(height: 8),
                              Text(
                                '账号登录',
                                style: Theme.of(context).textTheme.headlineSmall
                                    ?.copyWith(
                                      color: const Color(0xff173d35),
                                      fontWeight: FontWeight.w800,
                                    ),
                              ),
                              const SizedBox(height: 18),
                              TextField(
                                controller: _phone,
                                keyboardType: TextInputType.phone,
                                style: const TextStyle(
                                  color: Color(0xff173d35),
                                ),
                                decoration: const InputDecoration(
                                  labelText: '手机号',
                                  prefixIcon: Icon(Icons.phone_outlined),
                                ),
                              ),
                              const SizedBox(height: 12),
                              TextField(
                                controller: _code,
                                keyboardType: TextInputType.number,
                                style: const TextStyle(
                                  color: Color(0xff173d35),
                                ),
                                decoration: const InputDecoration(
                                  labelText: '验证码',
                                  helperText: '开发环境验证码：000000',
                                  prefixIcon: Icon(Icons.lock_outline),
                                ),
                              ),
                              const SizedBox(height: 18),
                              FilledButton.icon(
                                onPressed: _submitting ? null : _login,
                                icon: _submitting
                                    ? const SizedBox(
                                        width: 18,
                                        height: 18,
                                        child: CircularProgressIndicator(
                                          strokeWidth: 2,
                                        ),
                                      )
                                    : const Icon(Icons.login),
                                label: Text(_submitting ? '登录中' : '进入大厅'),
                              ),
                              if (snapshot.lastErrorMessage != null) ...[
                                const SizedBox(height: 12),
                                _ErrorBanner(snapshot: snapshot),
                              ],
                              const SizedBox(height: 14),
                              const Text(
                                '无充值、支付或提现入口 · 积分仅用于牌局结算',
                                textAlign: TextAlign.center,
                                style: TextStyle(
                                  color: Color(0xff53665f),
                                  fontSize: 12,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _LoginBrandPanel extends StatelessWidget {
  const _LoginBrandPanel();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 28),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: const Color(0xffffcf68),
              borderRadius: BorderRadius.circular(22),
            ),
            child: const Icon(
              Icons.grid_view_rounded,
              color: Color(0xff17483d),
              size: 48,
            ),
          ),
          const SizedBox(height: 20),
          Text(
            '宿松麻将',
            style: Theme.of(context).textTheme.displaySmall?.copyWith(
              color: const Color(0xffffe4a3),
              fontWeight: FontWeight.w900,
              letterSpacing: 3,
            ),
          ),
          const SizedBox(height: 8),
          const Text(
            '亲友圈 · 横屏实时牌局',
            style: TextStyle(fontSize: 20, color: Colors.white),
          ),
          const SizedBox(height: 20),
          const Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              _FeatureChip(icon: Icons.sync, label: '断线重连'),
              _FeatureChip(icon: Icons.groups_2_outlined, label: '多人同步'),
              _FeatureChip(icon: Icons.layers_outlined, label: '楼层规则'),
              _FeatureChip(icon: Icons.scoreboard_outlined, label: '积分战绩'),
            ],
          ),
          const SizedBox(height: 20),
          const Text('P0 开发演示版', style: TextStyle(color: Color(0xffb6d8cd))),
        ],
      ),
    );
  }
}

class _FeatureChip extends StatelessWidget {
  const _FeatureChip({required this.icon, required this.label});
  final IconData icon;
  final String label;
  @override
  Widget build(BuildContext context) =>
      Chip(avatar: Icon(icon, size: 18), label: Text(label));
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
    final keyboardVisible = MediaQuery.viewInsetsOf(context).bottom > 0;
    final pages = [
      LobbyTab(client: widget.client, snapshot: widget.snapshot),
      ClubTab(snapshot: widget.snapshot),
      HistoryTab(snapshot: widget.snapshot),
      SupportTab(api: widget.supportApi),
      SettingsTab(onLogout: widget.client.logout),
    ];
    return Scaffold(
      body: _GameBackdrop(
        child: SafeArea(
          child: Column(
            children: [
              if (!keyboardVisible)
                _LobbyTopBar(
                  snapshot: widget.snapshot,
                  onLogout: widget.client.logout,
                ),
              Expanded(child: pages[_index]),
              if (!keyboardVisible)
                _GameNavigation(
                  index: _index,
                  onChanged: (value) => setState(() => _index = value),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _LobbyTopBar extends StatelessWidget {
  const _LobbyTopBar({required this.snapshot, required this.onLogout});
  final ClientSnapshot snapshot;
  final VoidCallback onLogout;
  @override
  Widget build(BuildContext context) {
    return Container(
      height: 72,
      margin: const EdgeInsets.fromLTRB(14, 10, 14, 0),
      padding: const EdgeInsets.symmetric(horizontal: 18),
      decoration: BoxDecoration(
        color: const Color(0xdd123d38),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0x88efd58c)),
      ),
      child: Row(
        children: [
          const CircleAvatar(
            backgroundColor: Color(0xffffd66f),
            child: Icon(Icons.person, color: Color(0xff18443a)),
          ),
          const SizedBox(width: 10),
          Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                snapshot.displayName ?? '宿松玩家',
                style: const TextStyle(fontWeight: FontWeight.w800),
              ),
              Text(
                'ID ${snapshot.userId ?? '—'}',
                style: const TextStyle(fontSize: 12, color: Color(0xffc8ddd7)),
              ),
            ],
          ),
          const SizedBox(width: 24),
          const _TopMetric(
            icon: Icons.diamond_outlined,
            label: '钻石',
            value: '后台发放',
          ),
          const Spacer(),
          const Text(
            '宿松麻将',
            style: TextStyle(
              fontSize: 24,
              color: Color(0xffffdc82),
              fontWeight: FontWeight.w900,
              letterSpacing: 2,
            ),
          ),
          const Spacer(),
          IconButton(
            tooltip: '公告',
            onPressed: () {},
            icon: const Icon(Icons.campaign_outlined),
          ),
          IconButton(
            tooltip: '退出登录',
            onPressed: onLogout,
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
    );
  }
}

class _TopMetric extends StatelessWidget {
  const _TopMetric({
    required this.icon,
    required this.label,
    required this.value,
  });
  final IconData icon;
  final String label;
  final String value;
  @override
  Widget build(BuildContext context) => Row(
    children: [
      Icon(icon, size: 20, color: const Color(0xff8bded2)),
      const SizedBox(width: 7),
      Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: const TextStyle(fontSize: 11, color: Color(0xffb7d2cb)),
          ),
          Text(value, style: const TextStyle(fontWeight: FontWeight.w700)),
        ],
      ),
    ],
  );
}

class _GameNavigation extends StatelessWidget {
  const _GameNavigation({required this.index, required this.onChanged});
  final int index;
  final ValueChanged<int> onChanged;
  static const items = [
    (Icons.home_outlined, '大厅'),
    (Icons.groups_outlined, '俱乐部'),
    (Icons.history_outlined, '战绩'),
    (Icons.support_agent_outlined, '客服'),
    (Icons.settings_outlined, '设置'),
  ];
  @override
  Widget build(BuildContext context) => Container(
    height: 66,
    margin: const EdgeInsets.fromLTRB(14, 0, 14, 10),
    decoration: BoxDecoration(
      color: const Color(0xee102e2a),
      borderRadius: BorderRadius.circular(18),
      border: Border.all(color: const Color(0x557fd0ba)),
    ),
    child: Row(
      children: List.generate(
        items.length,
        (i) => Expanded(
          child: InkWell(
            onTap: () => onChanged(i),
            borderRadius: BorderRadius.circular(18),
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 160),
              margin: const EdgeInsets.all(6),
              decoration: BoxDecoration(
                color: i == index
                    ? const Color(0xffd29b3d)
                    : Colors.transparent,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(items[i].$1, size: 22),
                  const SizedBox(height: 2),
                  Text(
                    items[i].$2,
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  );
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

  Future<void> _showCreateRoom(BuildContext context) async {
    var rounds = 4;
    var zeng = 1;
    var strongPiao = false;
    var forcedHu = false;
    final scoreTiers = <int>{1, 2, 3, 4};
    final config = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setModalState) => AlertDialog(
          title: const Text('创建宿松麻将房'),
          content: SizedBox(
            width: 620,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: DropdownButtonFormField<int>(
                          initialValue: rounds,
                          decoration: const InputDecoration(labelText: '游戏局数'),
                          items: const [4, 8, 16]
                              .map(
                                (value) => DropdownMenuItem(
                                  value: value,
                                  child: Text('$value 局'),
                                ),
                              )
                              .toList(),
                          onChanged: (value) =>
                              setModalState(() => rounds = value ?? rounds),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: DropdownButtonFormField<int>(
                          initialValue: zeng,
                          decoration: const InputDecoration(labelText: '出增分数'),
                          items: const [0, 1, 2, 3, 5]
                              .map(
                                (value) => DropdownMenuItem(
                                  value: value,
                                  child: Text(value == 0 ? '不出增' : '$value 分'),
                                ),
                              )
                              .toList(),
                          onChanged: (value) =>
                              setModalState(() => zeng = value ?? zeng),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  const Text(
                    '选择四档底分（依次对应小胡 / 大胡 / 大大胡 / 一索）',
                    style: TextStyle(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 6),
                  Wrap(
                    spacing: 7,
                    children: [
                      for (var value = 1; value <= 9; value++)
                        FilterChip(
                          label: Text('$value 分'),
                          selected: scoreTiers.contains(value),
                          onSelected: (selected) => setModalState(() {
                            if (selected && scoreTiers.length < 4) {
                              scoreTiers.add(value);
                            }
                            if (!selected) scoreTiers.remove(value);
                          }),
                        ),
                    ],
                  ),
                  if (scoreTiers.length != 4)
                    const Text(
                      '必须且只能选择四档底分',
                      style: TextStyle(color: Colors.orangeAccent),
                    ),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('强飘'),
                    subtitle: const Text('关闭时为不强飘'),
                    value: strongPiao,
                    onChanged: (value) =>
                        setModalState(() => strongPiao = value),
                  ),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('必胡'),
                    subtitle: const Text('点炮可胡时由服务端自动胡牌'),
                    value: forcedHu,
                    onChanged: (value) => setModalState(() => forcedHu = value),
                  ),
                  const Text(
                    '积分仅用于本场结算；本页面没有充值或支付入口。',
                    style: TextStyle(fontSize: 12),
                  ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: scoreTiers.length == 4
                  ? () => Navigator.pop(context, {
                      'rounds': rounds,
                      'scoreTiers': scoreTiers.toList()..sort(),
                      'zeng': zeng,
                      'piao': strongPiao ? 'strong' : 'optional',
                      'forcedHu': forcedHu,
                    })
                  : null,
              child: const Text('确认创建'),
            ),
          ],
        ),
      ),
    );
    if (config != null && context.mounted) {
      await _run(() => client.createRoom(ruleConfig: config), context);
    }
  }

  Future<void> _showJoinRoom(BuildContext context) async {
    final roomId = await showDialog<String>(
      context: context,
      builder: (context) =>
          _JoinRoomDialog(initialRoomId: snapshot.roomId ?? ''),
    );
    if (roomId != null && context.mounted) {
      await _run(() => client.joinRoom(roomId), context);
    }
  }

  Future<void> _startBotDemo(BuildContext context) async {
    final transport = client.transport;
    if (transport is! FakeTransport) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('机器人试玩仅在离线演示模式开放')));
      return;
    }
    transport.enableBotDemo();
    try {
      await client.createRoom(
        ruleVersion: '8931-apk-baseline.6',
        ruleConfig: const {
          'rounds': 4,
          'scoreTiers': [1, 2, 3, 4],
          'zeng': 1,
          'piao': 'optional',
          'forcedHu': false,
        },
      );
      await client.joinRoom('demo-room');
      if (context.mounted) {
        await Navigator.of(context).push(
          MaterialPageRoute<void>(builder: (_) => RoomPage(client: client)),
        );
      }
    } catch (_) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('机器人房间创建失败，请重试')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final room = snapshot.roomSnapshot;
    final players = room?['players'];
    final playerCount = players is List ? players.length : 0;
    final connected = snapshot.phase == ConnectionPhase.online;
    return Padding(
      padding: const EdgeInsets.all(14),
      child: Row(
        children: [
          Expanded(
            flex: 5,
            child: Column(
              children: [
                Expanded(child: _PromoPanel(connected: connected)),
                const SizedBox(height: 12),
                _ConnectionCard(snapshot: snapshot, client: client),
              ],
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            flex: 6,
            child: Column(
              children: [
                Expanded(
                  child: Row(
                    children: [
                      Expanded(
                        child: _LobbyActionCard(
                          color: const Color(0xffdf843b),
                          icon: Icons.add_box_outlined,
                          title: '创建房间',
                          subtitle: '宿松麻将 · 积分制',
                          onTap: connected
                              ? () => _showCreateRoom(context)
                              : null,
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: _LobbyActionCard(
                          color: const Color(0xffbe4161),
                          icon: Icons.login,
                          title: '加入房间',
                          subtitle: '输入或使用当前房号',
                          onTap: connected
                              ? () => _showJoinRoom(context)
                              : null,
                        ),
                      ),
                      if (client.transport is FakeTransport) ...[
                        const SizedBox(width: 12),
                        Expanded(
                          child: _LobbyActionCard(
                            color: const Color(0xff397d9c),
                            icon: Icons.smart_toy_outlined,
                            title: '机器人',
                            subtitle: '3 人 · 出增后开局',
                            onTap: connected
                                ? () => _startBotDemo(context)
                                : null,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                Expanded(
                  child: room == null
                      ? const _EmptyState(
                          icon: Icons.table_restaurant_outlined,
                          title: '还没有进行中的房间',
                          message: '创建房间后可邀请好友，并验证多人同步与断线重连。',
                        )
                      : _CurrentRoomCard(
                          client: client,
                          snapshot: snapshot,
                          room: room,
                          playerCount: playerCount,
                          run: (operation) => _run(operation, context),
                        ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _JoinRoomDialog extends StatefulWidget {
  const _JoinRoomDialog({required this.initialRoomId});

  final String initialRoomId;

  @override
  State<_JoinRoomDialog> createState() => _JoinRoomDialogState();
}

class _JoinRoomDialogState extends State<_JoinRoomDialog> {
  late final TextEditingController _controller;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.initialRoomId);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final roomId = _controller.text.trim();
    if (roomId.isNotEmpty) Navigator.pop(context, roomId);
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('加入房间'),
    content: TextField(
      controller: _controller,
      autofocus: true,
      maxLength: 64,
      textInputAction: TextInputAction.done,
      decoration: const InputDecoration(
        labelText: '房号',
        hintText: '请输入房主分享的房号',
        prefixIcon: Icon(Icons.numbers),
      ),
      onSubmitted: (_) => _submit(),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('取消'),
      ),
      FilledButton(onPressed: _submit, child: const Text('确认加入')),
    ],
  );
}

class _PromoPanel extends StatelessWidget {
  const _PromoPanel({required this.connected});
  final bool connected;
  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(24),
    decoration: BoxDecoration(
      gradient: const LinearGradient(
        colors: [Color(0xff217c72), Color(0xff17473f)],
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
      ),
      borderRadius: BorderRadius.circular(20),
      border: Border.all(color: const Color(0x88f4d980)),
    ),
    child: ListView(
      children: [
        const Row(
          children: [
            Icon(Icons.campaign_outlined, color: Color(0xffffd873)),
            SizedBox(width: 8),
            Text(
              '公告',
              style: TextStyle(
                color: Color(0xffffdf8c),
                fontWeight: FontWeight.w800,
              ),
            ),
          ],
        ),
        const SizedBox(height: 18),
        const Text(
          '好友相聚\n公平竞技',
          style: TextStyle(
            fontSize: 30,
            height: 1.15,
            color: Colors.white,
            fontWeight: FontWeight.w900,
          ),
        ),
        const SizedBox(height: 10),
        const Text(
          '首版聚焦宿松麻将，后续规则通过统一游戏模块接入。',
          style: TextStyle(color: Color(0xffcce4de)),
        ),
        const SizedBox(height: 18),
        Row(
          children: [
            Icon(
              connected ? Icons.cloud_done : Icons.cloud_off,
              size: 18,
              color: connected
                  ? const Color(0xff8de2a6)
                  : const Color(0xffffa8a8),
            ),
            const SizedBox(width: 7),
            Text(connected ? '大厅服务在线' : '大厅服务未连接'),
          ],
        ),
      ],
    ),
  );
}

class _LobbyActionCard extends StatelessWidget {
  const _LobbyActionCard({
    required this.color,
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });
  final Color color;
  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) => Material(
    color: onTap == null ? color.withValues(alpha: 0.45) : color,
    borderRadius: BorderRadius.circular(20),
    elevation: 5,
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(20),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.all(9),
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.18),
                shape: BoxShape.circle,
              ),
              child: Icon(icon, size: 26),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 12,
                      color: Color(0xfff5eee3),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

class _CurrentRoomCard extends StatelessWidget {
  const _CurrentRoomCard({
    required this.client,
    required this.snapshot,
    required this.room,
    required this.playerCount,
    required this.run,
  });
  final ClientSessionController client;
  final ClientSnapshot snapshot;
  final Map<String, dynamic> room;
  final int playerCount;
  final Future<void> Function(Future<String> Function()) run;
  @override
  Widget build(BuildContext context) => Card(
    margin: EdgeInsets.zero,
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Row(
        children: [
          const CircleAvatar(
            radius: 28,
            backgroundColor: Color(0xff15705e),
            child: Icon(Icons.table_restaurant, color: Colors.white),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '房号 ${snapshot.roomId}',
                  style: const TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  '宿松麻将 · ${room['status'] ?? 'waiting'} · $playerCount/4 人',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: Color(0xffc4d9d3)),
                ),
                Text(
                  '规则快照 ${room['rule'] ?? 'susong_v1'} · v${snapshot.roomVersion}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Color(0xffa9c4bd),
                    fontSize: 12,
                  ),
                ),
                Text(
                  _susongConfigSummary(room['ruleConfig']),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Color(0xffa9c4bd),
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ),
          Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              FilledButton.icon(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => RoomPage(client: client),
                  ),
                ),
                icon: const Icon(Icons.arrow_forward),
                label: const Text('进入牌桌'),
              ),
              const SizedBox(height: 6),
              TextButton.icon(
                onPressed: () =>
                    run(() => client.reconnectRoom(snapshot.roomId!)),
                icon: const Icon(Icons.sync, size: 18),
                label: const Text('同步'),
              ),
            ],
          ),
        ],
      ),
    ),
  );
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
            backgroundColor: const Color(0xff0c332d),
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
          body: _GameBackdrop(
            child: room == null
                ? const _EmptyState(
                    icon: Icons.table_restaurant_outlined,
                    title: '房间状态暂不可用',
                    message: '返回大厅后重新进入房间。',
                  )
                : SafeArea(
                    minimum: const EdgeInsets.fromLTRB(4, 0, 4, 4),
                    child: _ResponsiveRoomCanvas(
                      child: _RoomTable(
                        client: client,
                        snapshot: snapshot,
                        room: room,
                      ),
                    ),
                  ),
          ),
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

class _ResponsiveRoomCanvas extends StatelessWidget {
  const _ResponsiveRoomCanvas({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final viewport = Size(constraints.maxWidth, constraints.maxHeight);
      final viewportAspect = viewport.height == 0
          ? 2.0
          : viewport.width / viewport.height;
      // A game table behaves more predictably as one scalable coordinate
      // system than as dozens of independently clamped widgets. Phones use a
      // wide 960×430 canvas; squarer tablets receive extra vertical room.
      final referenceSize = viewportAspect >= 1.75
          ? const Size(960, 430)
          : const Size(960, 540);
      return Semantics(
        label:
            '自适应牌桌 ${referenceSize.width.toInt()}×${referenceSize.height.toInt()}',
        container: true,
        child: ColoredBox(
          color: const Color(0xff063c31),
          child: Center(
            child: FittedBox(
              fit: BoxFit.contain,
              clipBehavior: Clip.hardEdge,
              child: SizedBox.fromSize(size: referenceSize, child: child),
            ),
          ),
        ),
      );
    },
  );
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
    final isBotDemo = room['demoMode'] == 'bots';
    final ready = current?['ready'] == true;
    final isOwner =
        room['ownerId'] == null ||
        room['ownerId']?.toString() == snapshot.userId;
    final canReady =
        current != null &&
        !isBotDemo &&
        (status == 'waiting' || status == 'ready');
    final canStart =
        current != null &&
        isOwner &&
        !isBotDemo &&
        (status == 'waiting' || status == 'ready');
    final connected = snapshot.phase == ConnectionPhase.online;
    final maxPlayers = _positiveInt(room['maxPlayers']) ?? seats.length;
    final readyCount =
        _positiveInt(room['readyCount']) ??
        players.where((player) => player['ready'] == true).length;
    final connectedCount =
        _positiveInt(room['connectedCount']) ??
        players.where((player) => player['connected'] == true).length;
    final round = _dynamicMap(room['round']);
    final openingStage = round?['openingStage']?.toString();
    final settlement = _dynamicMap(round?['settlement']);
    final flowerStates = _dynamicMap(round?['flowerStates']);
    final currentFlowerState = _dynamicMap(flowerStates?[snapshot.userId]);
    final awaitsPiaoChoice =
        currentFlowerState?['status']?.toString() == 'awaiting_piao_choice' &&
        (isBotDemo
            ? status == 'playing' &&
                  room['turnPlayerId']?.toString() == snapshot.userId
            : status == 'dealing');
    final awaitsBotZengChoice =
        openingStage == 'choose_zeng' && client.transport is FakeTransport;
    final minimumZeng =
        _intValue(_dynamicMap(room['zengByPlayer'])?[snapshot.userId]) ?? 0;
    final privateHand = _stringValues(round?['privateHand']);
    final mustDiscardFlower =
        currentFlowerState?['status']?.toString() == 'piao' &&
        privateHand.any(_isSusongFlowerTileId);
    final availableActions = _stringValues(round?['availableActions']);
    final availableReactions = _stringValues(round?['availableReactions']);
    final hasAuthoritativeActions =
        availableActions.isNotEmpty || availableReactions.isNotEmpty;
    final onlyPassiveReaction =
        availableReactions.length == 1 && availableReactions.single == 'pass';
    if (settlement != null && (status == 'settling' || status == 'finished')) {
      return _RoomSettlementTable(
        client: client,
        room: room,
        round: round!,
        settlement: settlement,
        players: players,
        snapshot: snapshot,
      );
    }
    final controls = <Widget>[
      if (current == null)
        FilledButton.icon(
          onPressed: connected
              ? () => _run(() => client.joinRoom(roomId), context)
              : null,
          icon: const Icon(Icons.person_add_alt_1, size: 17),
          label: const Text('加入房间'),
        ),
      if (canReady)
        FilledButton.tonalIcon(
          onPressed: connected
              ? () =>
                    _run(() => client.setReady(roomId, ready: !ready), context)
              : null,
          icon: Icon(ready ? Icons.undo : Icons.check_circle_outline, size: 17),
          label: Text(ready ? '取消准备' : '准备'),
        ),
      if (canStart)
        FilledButton.icon(
          onPressed: connected
              ? () => _run(() => client.startRound(roomId), context)
              : null,
          icon: const Icon(Icons.play_arrow, size: 17),
          label: const Text('开始'),
        ),
      if (awaitsBotZengChoice)
        _BotZengChoice(
          enabled: connected,
          minimum: minimumZeng,
          onSelected: (count) => _run(
            () => (client.transport as FakeTransport).chooseBotDemoZeng(count),
            context,
          ),
        )
      else if (awaitsPiaoChoice) ...[
        FilledButton.icon(
          onPressed: connected
              ? () => _run(() => client.choosePiao(roomId, true), context)
              : null,
          icon: const Icon(Icons.local_florist, size: 17),
          label: const Text('飘花'),
        ),
        FilledButton.tonalIcon(
          onPressed: connected
              ? () => _run(() => client.choosePiao(roomId, false), context)
              : null,
          icon: const Icon(Icons.layers_outlined, size: 17),
          label: const Text('不飘·补花'),
        ),
      ],
      if (onlyPassiveReaction)
        _AutomaticPass(
          key: ValueKey('auto-pass-${snapshot.roomVersion}'),
          onPass: () => _run(() => client.action(roomId, 'pass'), context),
        )
      else if (hasAuthoritativeActions)
        _AuthoritativeActionButtons(
          client: client,
          roomId: roomId,
          round: round!,
          connected: connected,
          run: (operation) => _run(operation, context),
        ),
    ];
    return Stack(
      children: [
        Positioned.fill(
          child: _MahjongTableSurface(
            room: room,
            round: round,
            seats: seats,
            status: status,
            roomVersion: snapshot.roomVersion,
            connectedCount: connectedCount,
            maxPlayers: maxPlayers,
            readyCount: readyCount,
            privateHand: privateHand,
            canDiscard: connected && availableActions.contains('discard'),
            mustDiscardFlower: mustDiscardFlower,
            controls: controls,
            ownerId: room['ownerId']?.toString(),
            dealerSeat: _intValue(round?['dealerSeat']),
            onDiscard: (tileId) => _run(
              () => client.action(roomId, 'discard', args: {'tileId': tileId}),
              context,
            ),
          ),
        ),
        if (snapshot.lastErrorMessage != null)
          Positioned(
            left: 12,
            right: 12,
            bottom: 8,
            child: _ErrorBanner(snapshot: snapshot),
          ),
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

class _BotZengChoice extends StatelessWidget {
  const _BotZengChoice({
    required this.enabled,
    required this.minimum,
    required this.onSelected,
  });

  final bool enabled;
  final int minimum;
  final ValueChanged<int> onSelected;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    decoration: BoxDecoration(
      color: const Color(0xe6203c35),
      borderRadius: BorderRadius.circular(10),
      border: Border.all(color: const Color(0xffffd369)),
    ),
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            '先选择出增数量',
            style: TextStyle(
              color: Color(0xffffd369),
              fontSize: 12,
              fontWeight: FontWeight.w800,
            ),
          ),
          if (minimum > 0)
            Text(
              '本局最低增$minimum（不能低于上局）',
              style: const TextStyle(color: Color(0xffc6e0da), fontSize: 9),
            ),
          const SizedBox(height: 5),
          Wrap(
            spacing: 5,
            children: [
              for (var count = 0; count <= 5; count += 1)
                FilledButton.tonal(
                  onPressed: enabled && count >= minimum
                      ? () => onSelected(count)
                      : null,
                  style: FilledButton.styleFrom(
                    visualDensity: VisualDensity.compact,
                    minimumSize: const Size(42, 32),
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    disabledBackgroundColor: const Color(0x553f514c),
                    disabledForegroundColor: const Color(0x887f918c),
                  ),
                  child: Text(count == 0 ? '不出增' : '增$count'),
                ),
            ],
          ),
        ],
      ),
    ),
  );
}

class _MahjongTableSurface extends StatelessWidget {
  const _MahjongTableSurface({
    required this.room,
    required this.round,
    required this.seats,
    required this.status,
    required this.roomVersion,
    required this.connectedCount,
    required this.maxPlayers,
    required this.readyCount,
    required this.privateHand,
    required this.canDiscard,
    required this.mustDiscardFlower,
    required this.controls,
    required this.ownerId,
    required this.dealerSeat,
    required this.onDiscard,
  });

  final Map<String, dynamic> room;
  final Map<String, dynamic>? round;
  final List<Map<String, dynamic>?> seats;
  final String status;
  final int roomVersion;
  final int connectedCount;
  final int maxPlayers;
  final int readyCount;
  final List<String> privateHand;
  final bool canDiscard;
  final bool mustDiscardFlower;
  final List<Widget> controls;
  final String? ownerId;
  final int? dealerSeat;
  final ValueChanged<String> onDiscard;

  Map<String, dynamic>? _seat(int index) =>
      index >= 0 && index < seats.length ? seats[index] : null;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final width = constraints.maxWidth;
      final height = constraints.maxHeight;
      final compact = height < 390;
      final badgeWidth = (width * 0.10).clamp(92.0, 120.0).toDouble();
      final badgeHeight = compact ? 48.0 : 52.0;
      final handHeight = compact ? 56.0 : 64.0;
      final scores = _dynamicMap(room['scores']) ?? const {};
      final sideLaneWidth = (width * 0.07).clamp(64.0, 82.0).toDouble();
      final riverWidth = (width * 0.09).clamp(104.0, 132.0).toDouble();
      final tablePlayers = seats.whereType<Map<String, dynamic>>().toList(
        growable: false,
      );
      final orderedPrivateHand = [...privateHand]..sort(_compareMahjongTileIds);
      final localPlayerId = _seat(0)?['id']?.toString();
      final meldsByPlayer = _dynamicMap(round?['meldsByPlayer']);
      final localMelds =
          localPlayerId != null && meldsByPlayer?[localPlayerId] is List
          ? List<Object?>.from(meldsByPlayer![localPlayerId] as List).length
          : 0;
      final waitingFaces = _susongWaitingFaces(privateHand, localMelds);
      final wallRemaining = _intValue(
        _dynamicMap(round?['wall'])?['wallRemaining'],
      );
      final playing = const {
        'dealing',
        'playing',
        'settling',
        'finished',
      }.contains(status);

      return ClipRect(
        child: DecoratedBox(
          decoration: const BoxDecoration(
            gradient: RadialGradient(
              center: Alignment.center,
              radius: 1.05,
              colors: [Color(0xff188765), Color(0xff07503f)],
            ),
          ),
          child: Stack(
            children: [
              const Positioned.fill(
                child: IgnorePointer(
                  child: Center(
                    child: Opacity(
                      opacity: 0.08,
                      child: Icon(
                        Icons.local_florist,
                        size: 260,
                        color: Color(0xffffe4a3),
                      ),
                    ),
                  ),
                ),
              ),
              Positioned(
                left: 8,
                top: 7,
                child: ConstrainedBox(
                  constraints: BoxConstraints(maxWidth: width * 0.38),
                  child: _RoomStatusStrip(
                    status: _roomStatusLabel(status),
                    version: roomVersion,
                    connected: connectedCount,
                    maxPlayers: maxPlayers,
                    ready: readyCount,
                    showReady: !playing,
                  ),
                ),
              ),
              if (wallRemaining != null)
                Positioned(
                  left: 10,
                  top: compact ? 45 : 51,
                  child: _RemainingTilesBadge(
                    remaining: wallRemaining,
                    roundNumber: _intValue(round?['roundNumber']),
                    totalRounds: _intValue(room['totalRounds']),
                  ),
                ),
              Positioned(
                top: 6,
                left: (width - badgeWidth) / 2,
                width: badgeWidth,
                height: badgeHeight,
                child: _SeatTile(
                  seat: 2,
                  player: _seat(2),
                  ownerId: ownerId,
                  playing: playing,
                  isDealer: dealerSeat == 2,
                  score: _intValue(scores[_seat(2)?['id']?.toString()]) ?? 0,
                ),
              ),
              Positioned(
                left: 7,
                top: (height - badgeHeight) * 0.43,
                width: badgeWidth,
                height: badgeHeight,
                child: _SeatTile(
                  seat: 3,
                  player: _seat(3),
                  ownerId: ownerId,
                  playing: playing,
                  isDealer: dealerSeat == 3,
                  score: _intValue(scores[_seat(3)?['id']?.toString()]) ?? 0,
                ),
              ),
              Positioned(
                right: 7,
                top: (height - badgeHeight) * 0.43,
                width: badgeWidth,
                height: badgeHeight,
                child: _SeatTile(
                  seat: 1,
                  player: _seat(1),
                  ownerId: ownerId,
                  playing: playing,
                  isDealer: dealerSeat == 1,
                  score: _intValue(scores[_seat(1)?['id']?.toString()]) ?? 0,
                ),
              ),
              Positioned(
                left: 7,
                bottom: 6,
                width: badgeWidth,
                height: badgeHeight,
                child: _SeatTile(
                  seat: 0,
                  player: _seat(0),
                  ownerId: ownerId,
                  playing: playing,
                  isDealer: dealerSeat == 0,
                  score: _intValue(scores[_seat(0)?['id']?.toString()]) ?? 0,
                ),
              ),
              Positioned(
                top: badgeHeight + 4,
                right: width * 0.10,
                width: width * 0.22,
                height: compact ? 38 : 44,
                child: _PublicTilesLane(
                  player: _seat(2),
                  players: tablePlayers,
                  round: round,
                  vertical: false,
                ),
              ),
              Positioned(
                top: badgeHeight + 4,
                left: width * 0.32,
                right: width * 0.32,
                height: 28,
                child: _OpponentHandLane(
                  player: _seat(2),
                  round: round,
                  vertical: false,
                ),
              ),
              Positioned(
                left: badgeWidth + 3,
                top: height * 0.29,
                width: 25,
                height: height * 0.35,
                child: _OpponentHandLane(
                  player: _seat(3),
                  round: round,
                  vertical: true,
                ),
              ),
              Positioned(
                right: badgeWidth + 3,
                top: height * 0.29,
                width: 25,
                height: height * 0.35,
                child: _OpponentHandLane(
                  player: _seat(1),
                  round: round,
                  vertical: true,
                ),
              ),
              Positioned(
                left: badgeWidth + 32,
                top: height * 0.35,
                width: sideLaneWidth,
                height: height * 0.30,
                child: _PublicTilesLane(
                  player: _seat(3),
                  players: tablePlayers,
                  round: round,
                  vertical: true,
                ),
              ),
              Positioned(
                right: badgeWidth + 32,
                top: height * 0.35,
                width: sideLaneWidth,
                height: height * 0.30,
                child: _PublicTilesLane(
                  player: _seat(1),
                  players: tablePlayers,
                  round: round,
                  vertical: true,
                ),
              ),
              Positioned(
                left: badgeWidth + 10,
                bottom: handHeight + 8,
                width: width * 0.29,
                height: compact ? 40 : 46,
                child: _PublicTilesLane(
                  player: _seat(0),
                  players: tablePlayers,
                  round: round,
                  vertical: false,
                ),
              ),
              Positioned(
                left: (width - riverWidth) / 2,
                width: riverWidth,
                top: badgeHeight + 20,
                height: compact ? 64 : 76,
                child: _DiscardRiver(
                  player: _seat(2),
                  round: round,
                  vertical: false,
                ),
              ),
              Positioned(
                left: badgeWidth + sideLaneWidth + 48,
                top: height * 0.35,
                width: riverWidth * 0.72,
                height: compact ? 92 : 112,
                child: _DiscardRiver(
                  player: _seat(3),
                  round: round,
                  vertical: true,
                ),
              ),
              Positioned(
                right: badgeWidth + sideLaneWidth + 48,
                top: height * 0.35,
                width: riverWidth * 0.72,
                height: compact ? 92 : 112,
                child: _DiscardRiver(
                  player: _seat(1),
                  round: round,
                  vertical: true,
                ),
              ),
              Positioned(
                left: (width - riverWidth) / 2,
                width: riverWidth,
                bottom: handHeight + 8,
                height: compact ? 64 : 76,
                child: _DiscardRiver(
                  player: _seat(0),
                  round: round,
                  vertical: false,
                ),
              ),
              Positioned(
                left: width * 0.43,
                right: width * 0.43,
                top: height * 0.35,
                height: compact ? 82 : 92,
                child: _TableCenterMark(
                  room: room,
                  round: round,
                  status: status,
                ),
              ),
              if (controls.isNotEmpty)
                Positioned(
                  right: badgeWidth + 18,
                  bottom: handHeight + 9,
                  child: ConstrainedBox(
                    constraints: BoxConstraints(maxWidth: width * 0.42),
                    child: Wrap(
                      alignment: WrapAlignment.end,
                      spacing: 6,
                      runSpacing: 5,
                      children: controls,
                    ),
                  ),
                ),
              if (waitingFaces.isNotEmpty)
                Positioned(
                  left: badgeWidth + sideLaneWidth + 82,
                  bottom: handHeight + 8,
                  child: _TingHint(waitingFaces: waitingFaces),
                ),
              if (privateHand.isNotEmpty)
                Positioned(
                  left: badgeWidth + 15,
                  right: 9,
                  bottom: 5,
                  height: handHeight,
                  child: ListView.separated(
                    scrollDirection: Axis.horizontal,
                    itemCount: orderedPrivateHand.length,
                    separatorBuilder: (_, _) => const SizedBox(width: 3),
                    itemBuilder: (context, index) {
                      final tileId = orderedPrivateHand[index];
                      return _MahjongTile(
                        tileId: tileId,
                        enabled:
                            canDiscard &&
                            (!mustDiscardFlower ||
                                _isSusongFlowerTileId(tileId)),
                        onTap: () => onDiscard(tileId),
                      );
                    },
                  ),
                ),
              if (canDiscard && mustDiscardFlower)
                Positioned(
                  right: 12,
                  bottom: handHeight + 8,
                  child: const Text(
                    '手中有花，请先打一张花',
                    style: TextStyle(
                      color: Color(0xffffd369),
                      fontSize: 12,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
            ],
          ),
        ),
      );
    },
  );
}

class _AutomaticPass extends StatefulWidget {
  const _AutomaticPass({required this.onPass, super.key});

  final Future<void> Function() onPass;

  @override
  State<_AutomaticPass> createState() => _AutomaticPassState();
}

class _AutomaticPassState extends State<_AutomaticPass> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) widget.onPass();
    });
  }

  @override
  Widget build(BuildContext context) => const SizedBox.shrink();
}

class _TableCenterMark extends StatelessWidget {
  const _TableCenterMark({
    required this.room,
    required this.round,
    required this.status,
  });

  final Map<String, dynamic> room;
  final Map<String, dynamic>? round;
  final String status;

  @override
  Widget build(BuildContext context) {
    final phase = round?['turnPhase']?.toString();
    final turnPlayerId = room['turnPlayerId']?.toString();
    final turnPlayer = _roomPlayers(room)
        .where((player) => player['id']?.toString() == turnPlayerId);
    final turnSeat = turnPlayer.isEmpty
        ? null
        : _intValue(turnPlayer.first['seat']);
    final activeWind = switch (turnSeat) {
      2 => '东',
      3 => '南',
      1 => '西',
      0 => '北',
      _ => null,
    };
    return Center(
      child: _WindCompass(
        phase: phase ?? status,
        deadlineAt: round?['turnDeadlineAt']?.toString(),
        activeWind: activeWind,
      ),
    );
  }
}

class _RemainingTilesBadge extends StatelessWidget {
  const _RemainingTilesBadge({
    required this.remaining,
    required this.roundNumber,
    required this.totalRounds,
  });

  final int remaining;
  final int? roundNumber;
  final int? totalRounds;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
    decoration: BoxDecoration(
      color: const Color(0xd92b443d),
      borderRadius: BorderRadius.circular(7),
      border: Border.all(color: const Color(0x5577dfc1)),
    ),
    child: Text(
      '第 ${roundNumber ?? '—'}/${totalRounds ?? '—'} 局  ·  剩余 $remaining 张',
      style: const TextStyle(
        color: Color(0xffffe4a3),
        fontSize: 10,
        fontWeight: FontWeight.w800,
      ),
    ),
  );
}

class _WindCompass extends StatefulWidget {
  const _WindCompass({
    required this.phase,
    required this.deadlineAt,
    required this.activeWind,
  });

  final String phase;
  final String? deadlineAt;
  final String? activeWind;

  @override
  State<_WindCompass> createState() => _WindCompassState();
}

class _WindCompassState extends State<_WindCompass> {
  Timer? _timer;
  Timer? _pulseTimer;
  bool _pulseOn = true;

  @override
  void initState() {
    super.initState();
    _pulseTimer = Timer.periodic(const Duration(milliseconds: 650), (_) {
      if (mounted) setState(() => _pulseOn = !_pulseOn);
    });
    _restart();
  }

  @override
  void didUpdateWidget(covariant _WindCompass oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.deadlineAt != widget.deadlineAt) _restart();
  }

  void _restart() {
    _timer?.cancel();
    if (DateTime.tryParse(widget.deadlineAt ?? '') == null) return;
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _pulseTimer?.cancel();
    super.dispose();
  }

  Widget _wind(String wind, TextStyle style) {
    if (widget.activeWind != wind) return Text(wind, style: style);
    return Opacity(
      opacity: _pulseOn ? 1 : 0.35,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: const Color(0x55ffd369),
          borderRadius: BorderRadius.circular(4),
          boxShadow: const [BoxShadow(color: Color(0xaaffd369), blurRadius: 7)],
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 3, vertical: 1),
          child: Text(wind, style: style),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final deadline = DateTime.tryParse(widget.deadlineAt ?? '');
    final seconds = deadline?.difference(DateTime.now()).inSeconds.clamp(0, 99);
    const windStyle = TextStyle(
      color: Color(0xffffe4a3),
      fontSize: 11,
      fontWeight: FontWeight.w900,
    );
    return Semantics(
      label:
          '东南西北方位${widget.activeWind == null ? '' : ' 当前方位 ${widget.activeWind}'} 倒计时 ${seconds ?? 0} 秒',
      child: Container(
        width: 72,
        height: 72,
        decoration: BoxDecoration(
          color: const Color(0xe620302c),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: const Color(0xffffd369), width: 1.2),
          boxShadow: const [
            BoxShadow(
              color: Color(0x66000000),
              blurRadius: 5,
              offset: Offset(0, 2),
            ),
          ],
        ),
        child: Stack(
          alignment: Alignment.center,
          children: [
            Positioned(top: 3, child: _wind('东', windStyle)),
            Positioned(left: 4, child: _wind('南', windStyle)),
            Positioned(right: 4, child: _wind('西', windStyle)),
            Positioned(bottom: 3, child: _wind('北', windStyle)),
            Container(
              width: 28,
              height: 28,
              alignment: Alignment.center,
              decoration: const BoxDecoration(
                color: Color(0xff101a18),
                shape: BoxShape.circle,
              ),
              child: Text(
                '${seconds ?? 0}',
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 15,
                  fontWeight: FontWeight.w900,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _TingHint extends StatelessWidget {
  const _TingHint({required this.waitingFaces});

  final List<String> waitingFaces;

  @override
  Widget build(BuildContext context) => Semantics(
    label: '听牌提示 ${waitingFaces.map(_mahjongFaceLabel).join('、')}',
    child: Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
      decoration: BoxDecoration(
        color: const Color(0xd9213c35),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: const Color(0xffffd369)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text(
            '听',
            style: TextStyle(
              color: Color(0xffffd369),
              fontSize: 16,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(width: 5),
          for (final face in waitingFaces.take(7)) ...[
            _MiniMahjongTile(tileId: '$face-9'),
            const SizedBox(width: 2),
          ],
          if (waitingFaces.length > 7)
            Text(
              '+${waitingFaces.length - 7}',
              style: const TextStyle(color: Colors.white, fontSize: 10),
            ),
        ],
      ),
    ),
  );
}

class _PublicTilesLane extends StatelessWidget {
  const _PublicTilesLane({
    required this.player,
    required this.players,
    required this.round,
    required this.vertical,
  });

  final Map<String, dynamic>? player;
  final List<Map<String, dynamic>> players;
  final Map<String, dynamic>? round;
  final bool vertical;

  @override
  Widget build(BuildContext context) {
    final playerId =
        player?['id']?.toString() ?? player?['playerId']?.toString();
    if (playerId == null) return const SizedBox.shrink();
    final melds = _dynamicMap(round?['meldsByPlayer']);
    final flowerTiles = _dynamicMap(round?['flowerTilesByPlayer']);
    final discardedFlowerTiles = _dynamicMap(
      round?['discardedFlowerTilesByPlayer'],
    );
    final meldValues = melds?[playerId] is List
        ? List<Object?>.from(melds![playerId] as List)
        : const <Object?>[];
    final discardedFlowerValues = _stringValues(discardedFlowerTiles?[playerId])
        .toSet();
    final flowerTileValues = _stringValues(flowerTiles?[playerId])
        .where((tile) => !discardedFlowerValues.contains(tile))
        .toList();
    return ClipRect(
      child: Align(
        alignment: Alignment.topLeft,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: const Color(0x18000000),
            borderRadius: BorderRadius.circular(4),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 3),
            child: SingleChildScrollView(
              scrollDirection: vertical ? Axis.vertical : Axis.horizontal,
              child: Flex(
                direction: vertical ? Axis.vertical : Axis.horizontal,
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final raw in meldValues) ...[
                    _PublicMeld(
                      meld: _dynamicMap(raw) ?? const {},
                      player: player!,
                      players: players,
                      vertical: vertical,
                    ),
                    SizedBox(width: vertical ? 0 : 5, height: vertical ? 4 : 0),
                  ],
                  if (flowerTileValues.isNotEmpty)
                    Flex(
                      direction: vertical ? Axis.vertical : Axis.horizontal,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        for (final tileId in flowerTileValues)
                          Padding(
                            padding: EdgeInsets.only(
                              right: vertical ? 0 : 1,
                              bottom: vertical ? 1 : 0,
                            ),
                            child: _MiniFlowerTile(tileId: tileId),
                          ),
                      ],
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

class _PublicMeld extends StatelessWidget {
  const _PublicMeld({
    required this.meld,
    required this.player,
    required this.players,
    required this.vertical,
  });

  final Map<String, dynamic> meld;
  final Map<String, dynamic> player;
  final List<Map<String, dynamic>> players;
  final bool vertical;

  @override
  Widget build(BuildContext context) {
    final action = meld['action']?.toString() ?? '';
    final tiles = _stringValues(meld['tileIds']);
    final concealed = action == 'concealed_kong';
    final providerDirection = _meldProviderDirection(player, meld, players);
    final providerSeat = _meldProviderSeat(meld, players);
    final claimedTileId = meld['claimedTileId']?.toString();
    final claimedIndex = !concealed && tiles.isNotEmpty
        ? tiles.indexWhere((tile) => tile == claimedTileId)
        : -1;
    final resolvedClaimedIndex = claimedIndex >= 0
        ? claimedIndex
        : (!concealed && providerDirection != null ? tiles.length - 1 : -1);
    final claimedTile = resolvedClaimedIndex >= 0
        ? tiles[resolvedClaimedIndex]
        : null;
    final displayTiles = [...tiles];
    if (claimedTile != null) {
      displayTiles.removeAt(resolvedClaimedIndex);
      final insertAt = switch (providerDirection) {
        '上家' => 0,
        '对家' => displayTiles.length ~/ 2,
        _ => displayTiles.length,
      };
      displayTiles.insert(insertAt, claimedTile);
    }
    final tileWidgets = <Widget>[
      for (var index = 0; index < displayTiles.length; index += 1)
        Padding(
          padding: EdgeInsets.only(
            right: vertical ? 0 : 1,
            bottom: vertical ? 1 : 0,
          ),
          child: concealed && index == 1
              ? const _MiniMahjongBack()
              : _MeldMiniTile(
                  tileId: displayTiles[index],
                  providerDirection: displayTiles[index] == claimedTile
                      ? providerDirection
                      : null,
                  providerSeat: displayTiles[index] == claimedTile
                      ? providerSeat
                      : null,
                ),
        ),
    ];
    return Flex(
      direction: vertical ? Axis.vertical : Axis.horizontal,
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: tileWidgets,
    );
  }
}

class _MeldMiniTile extends StatelessWidget {
  const _MeldMiniTile({
    required this.tileId,
    this.providerDirection,
    this.providerSeat,
  });

  final String tileId;
  final String? providerDirection;
  final int? providerSeat;

  @override
  Widget build(BuildContext context) => Stack(
    alignment: Alignment.center,
    children: [
      _MiniMahjongTile(tileId: tileId),
      if (providerDirection != null && providerSeat != null)
        IgnorePointer(
          child: Semantics(
            label:
                '副露来源 $providerDirection，箭头指向${_seatScreenDirection(providerSeat!)}',
            child: RotatedBox(
              quarterTurns: switch (providerSeat) {
                0 => 2,
                1 => 1,
                2 => 0,
                3 => 3,
                _ => 0,
              },
              child: const Icon(
                Icons.arrow_upward_rounded,
                size: 15,
                color: Color(0xff18a54b),
                shadows: [Shadow(color: Colors.white, blurRadius: 2)],
              ),
            ),
          ),
        ),
    ],
  );
}

class _OpponentHandLane extends StatelessWidget {
  const _OpponentHandLane({
    required this.player,
    required this.round,
    required this.vertical,
  });

  final Map<String, dynamic>? player;
  final Map<String, dynamic>? round;
  final bool vertical;

  @override
  Widget build(BuildContext context) {
    final playerId = player?['id']?.toString();
    if (playerId == null) return const SizedBox.shrink();
    final wall = _dynamicMap(round?['wall']);
    final counts = _dynamicMap(wall?['handCountsByPlayer']);
    final count = (_intValue(counts?[playerId]) ?? 13).clamp(0, 14);
    if (count == 0) return const SizedBox.shrink();
    final tiles = List<Widget>.generate(
      count,
      (_) => Padding(
        padding: EdgeInsets.only(
          right: vertical ? 0 : 1,
          bottom: vertical ? 1 : 0,
        ),
        child: RotatedBox(
          quarterTurns: vertical ? 1 : 0,
          child: const _MiniMahjongBack(),
        ),
      ),
    );
    return FittedBox(
      alignment: Alignment.center,
      fit: BoxFit.contain,
      child: vertical
          ? Column(mainAxisSize: MainAxisSize.min, children: tiles)
          : Row(mainAxisSize: MainAxisSize.min, children: tiles),
    );
  }
}

class _DiscardRiver extends StatelessWidget {
  const _DiscardRiver({
    required this.player,
    required this.round,
    required this.vertical,
  });

  final Map<String, dynamic>? player;
  final Map<String, dynamic>? round;
  final bool vertical;

  @override
  Widget build(BuildContext context) {
    final playerId =
        player?['id']?.toString() ?? player?['playerId']?.toString();
    final discards = _dynamicMap(round?['discardsByPlayer']);
    final discardedFlowers = _dynamicMap(
      round?['discardedFlowerTilesByPlayer'],
    );
    final tiles = [
      ..._stringValues(discards?[playerId]),
      ..._stringValues(discardedFlowers?[playerId]),
    ];
    if (playerId == null || tiles.isEmpty) return const SizedBox.shrink();
    return Semantics(
      container: true,
      label: '牌河 ${tiles.map(_mahjongFaceLabel).join(' ')}',
      child: Align(
        alignment: Alignment.center,
        child: Wrap(
          direction: vertical ? Axis.vertical : Axis.horizontal,
          alignment: WrapAlignment.center,
          spacing: 1,
          runSpacing: 1,
          children: [
            for (var index = 0; index < tiles.length; index += 1)
              _MiniMahjongTile(
                key: ValueKey('river-$playerId-$index-${tiles[index]}'),
                tileId: tiles[index],
                highlighted: index == tiles.length - 1,
              ),
          ],
        ),
      ),
    );
  }
}

class _MiniMahjongTile extends StatelessWidget {
  const _MiniMahjongTile({
    required this.tileId,
    this.highlighted = false,
    super.key,
  });

  final String tileId;
  final bool highlighted;

  @override
  Widget build(BuildContext context) => Container(
    width: 24,
    height: 30,
    alignment: Alignment.center,
    decoration: BoxDecoration(
      color: const Color(0xfffff8df),
      borderRadius: BorderRadius.circular(3),
      border: Border.all(
        color: highlighted ? const Color(0xffffd369) : const Color(0xffb59a58),
        width: highlighted ? 1.5 : 0.7,
      ),
    ),
    child: Semantics(
      label: _mahjongFaceLabel(tileId),
      excludeSemantics: true,
      child: _MahjongFaceArt(tileId: tileId, compact: true),
    ),
  );
}

class _MiniFlowerTile extends StatelessWidget {
  const _MiniFlowerTile({required this.tileId});

  final String tileId;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: 17,
    height: 22,
    child: Semantics(
      label: _mahjongFaceLabel(tileId),
      image: true,
      excludeSemantics: true,
      child: _MahjongFaceArt(tileId: tileId, compact: true),
    ),
  );
}

class _MiniMahjongBack extends StatelessWidget {
  const _MiniMahjongBack();

  @override
  Widget build(BuildContext context) => Semantics(
    label: '暗牌',
    image: true,
    child: Image.asset(
      'assets/mahjong/apk_tiles/back.png',
      width: 24,
      height: 30,
      fit: BoxFit.fill,
      filterQuality: FilterQuality.high,
    ),
  );
}

class _RoomSettlementTable extends StatelessWidget {
  const _RoomSettlementTable({
    required this.client,
    required this.room,
    required this.round,
    required this.settlement,
    required this.players,
    required this.snapshot,
  });

  final ClientSessionController client;
  final Map<String, dynamic> room;
  final Map<String, dynamic> round;
  final Map<String, dynamic> settlement;
  final List<Map<String, dynamic>> players;
  final ClientSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    final deltas = _dynamicMap(settlement['deltaByPlayer']) ?? const {};
    final scores = _dynamicMap(room['scores']) ?? const {};
    final transfers = settlement['transfers'] is List
        ? List<Object?>.from(settlement['transfers'] as List)
        : const <Object?>[];
    final wins = settlement['wins'] is List
        ? List<Object?>.from(settlement['wins'] as List)
        : const <Object?>[];
    final releasedSanxiPairs = settlement['releasedSanxiPairs'] is List
        ? List<Object?>.from(settlement['releasedSanxiPairs'] as List)
        : const <Object?>[];
    final outcome = switch (settlement['outcome']?.toString()) {
      'self_draw' => '自摸',
      'discard' => '点炮',
      'draw' => '流局',
      _ => '已结算',
    };
    final roomId = room['id']?.toString() ?? room['roomId']?.toString();
    final roomStatus = room['status']?.toString();
    final isOwner = room['ownerId']?.toString() == snapshot.userId;
    final connected = snapshot.phase == ConnectionPhase.online;
    final roundNumber = _intValue(round['roundNumber']) ?? 0;
    final totalRounds = _intValue(room['totalRounds']);
    final isFinalRound = totalRounds != null && roundNumber >= totalRounds;
    final isMatchFinished = roomStatus == 'finished';
    final orderedPlayers = [...players]
      ..sort(
        isMatchFinished
            ? (left, right) {
                final leftId =
                    left['id']?.toString() ?? left['playerId']?.toString();
                final rightId =
                    right['id']?.toString() ?? right['playerId']?.toString();
                final scoreComparison = (_intValue(scores[rightId]) ?? 0)
                    .compareTo(_intValue(scores[leftId]) ?? 0);
                return scoreComparison != 0
                    ? scoreComparison
                    : (_intValue(left['seat']) ?? 0).compareTo(
                        _intValue(right['seat']) ?? 0,
                      );
              }
            : (left, right) => (_intValue(left['seat']) ?? 0).compareTo(
                _intValue(right['seat']) ?? 0,
              ),
      );
    final useReferenceSettlementLayout =
        room['gameType']?.toString() != '__legacy_settlement_layout__';
    if (useReferenceSettlementLayout) {
      final canAdvance =
          roomStatus == 'settling' &&
          isOwner &&
          connected &&
          roomId != null &&
          snapshot.pendingCommandCount == 0;
      return isMatchFinished
          ? _MatchSettlementView(
              room: room,
              round: round,
              players: orderedPlayers,
              scores: scores,
              deltas: deltas,
              snapshot: snapshot,
            )
          : _SingleRoundSettlementView(
              room: room,
              round: round,
              settlement: settlement,
              players: orderedPlayers,
              deltas: deltas,
              scores: scores,
              outcome: outcome,
              snapshot: snapshot,
              buttonLabel: isFinalRound ? '查看总计' : '继续游戏',
              onNext: canAdvance
                  ? () => _run(() => client.nextRound(roomId), context)
                  : null,
            );
    }
    return LayoutBuilder(
      builder: (context, constraints) => ListView(
        padding: const EdgeInsets.all(12),
        children: [
          SizedBox(
            height: constraints.maxHeight - 24,
            child: Column(
              children: [
                _RoomStatusStrip(
                  status: isMatchFinished ? '全场结算 · 总计' : '单局结算 · $outcome',
                  version: snapshot.roomVersion,
                  connected: _positiveInt(room['connectedCount']) ?? 0,
                  maxPlayers: _positiveInt(room['maxPlayers']) ?? 4,
                  ready: _positiveInt(room['readyCount']) ?? 0,
                  showReady: false,
                ),
                const SizedBox(height: 10),
                Expanded(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Expanded(
                        flex: 5,
                        child: Card(
                          margin: EdgeInsets.zero,
                          child: Padding(
                            padding: const EdgeInsets.all(14),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                Row(
                                  children: [
                                    Expanded(
                                      child: Text(
                                        isMatchFinished
                                            ? '全场总计'
                                            : '第 ${roundNumber == 0 ? '—' : roundNumber} 局积分',
                                        style: const TextStyle(
                                          color: Color(0xffffe4a3),
                                          fontSize: 18,
                                          fontWeight: FontWeight.w900,
                                        ),
                                      ),
                                    ),
                                    if (roomStatus == 'settling' && isOwner)
                                      FilledButton.icon(
                                        onPressed:
                                            connected &&
                                                roomId != null &&
                                                snapshot.pendingCommandCount ==
                                                    0
                                            ? () => _run(
                                                () => client.nextRound(roomId),
                                                context,
                                              )
                                            : null,
                                        icon: const Icon(Icons.skip_next),
                                        label: Text(
                                          isFinalRound ? '查看总计' : '开始下一局',
                                        ),
                                      )
                                    else
                                      Text(
                                        roomStatus == 'finished'
                                            ? '本场已结束'
                                            : '等待房主开始下一局',
                                        style: const TextStyle(
                                          color: Color(0xffaec8c1),
                                          fontSize: 12,
                                        ),
                                      ),
                                  ],
                                ),
                                const SizedBox(height: 8),
                                Expanded(
                                  child: ListView.separated(
                                    itemCount: orderedPlayers.length,
                                    separatorBuilder: (_, _) =>
                                        const Divider(height: 1),
                                    itemBuilder: (context, index) {
                                      final player = orderedPlayers[index];
                                      final playerId =
                                          player['id']?.toString() ??
                                          player['playerId']?.toString() ??
                                          '';
                                      final delta =
                                          _intValue(deltas[playerId]) ?? 0;
                                      final total =
                                          _intValue(scores[playerId]) ?? 0;
                                      final shownScore = isMatchFinished
                                          ? total
                                          : delta;
                                      return ListTile(
                                        dense: true,
                                        leading: CircleAvatar(
                                          child: Text('${index + 1}'),
                                        ),
                                        title: Text(_playerName(player)),
                                        subtitle: Text(
                                          isMatchFinished
                                              ? '本局 ${delta > 0 ? '+$delta' : '$delta'} 分'
                                              : '累计 $total 分',
                                        ),
                                        trailing: Text(
                                          shownScore > 0
                                              ? '+$shownScore'
                                              : '$shownScore',
                                          style: TextStyle(
                                            color: shownScore > 0
                                                ? const Color(0xffffd369)
                                                : shownScore < 0
                                                ? const Color(0xffff8d78)
                                                : const Color(0xffc6e0da),
                                            fontSize: 22,
                                            fontWeight: FontWeight.w900,
                                          ),
                                        ),
                                      );
                                    },
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        flex: 6,
                        child: Card(
                          margin: EdgeInsets.zero,
                          child: Padding(
                            padding: const EdgeInsets.all(14),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                const Text(
                                  '服务端计分明细',
                                  style: TextStyle(
                                    color: Color(0xffffe4a3),
                                    fontSize: 18,
                                    fontWeight: FontWeight.w900,
                                  ),
                                ),
                                Text(
                                  settlement['scoreOrderVersion']?.toString() ??
                                      '未提供迹线版本',
                                  style: const TextStyle(
                                    color: Color(0xffaec8c1),
                                    fontSize: 11,
                                  ),
                                ),
                                if (wins.isNotEmpty) ...[
                                  const SizedBox(height: 4),
                                  Text(
                                    wins
                                        .map(_dynamicMap)
                                        .whereType<Map<String, dynamic>>()
                                        .map(
                                          (win) => _settlementWinReason(
                                            win,
                                            players,
                                          ),
                                        )
                                        .join('  ·  '),
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                      color: Color(0xffffd369),
                                      fontSize: 11,
                                    ),
                                  ),
                                ],
                                if (releasedSanxiPairs.isNotEmpty) ...[
                                  const SizedBox(height: 4),
                                  Text(
                                    '一炮多响 · 已解除三西：${releasedSanxiPairs.map((pair) {
                                      final ids = pair is List ? pair : const [];
                                      if (ids.length != 2) return '未知关系';
                                      return '${_settlementPlayerName(players, ids[0]?.toString())} ↔ ${_settlementPlayerName(players, ids[1]?.toString())}';
                                    }).join('、')}',
                                    style: const TextStyle(
                                      color: Color(0xffffb98d),
                                      fontSize: 11,
                                      fontWeight: FontWeight.w700,
                                    ),
                                  ),
                                ],
                                const SizedBox(height: 8),
                                Expanded(
                                  child: transfers.isEmpty
                                      ? const Center(child: Text('流局·本局积分不变'))
                                      : ListView.separated(
                                          itemCount: transfers.length,
                                          separatorBuilder: (_, _) =>
                                              const SizedBox(height: 7),
                                          itemBuilder: (context, index) {
                                            final transfer =
                                                _dynamicMap(transfers[index]) ??
                                                const {};
                                            return _SettlementTransferCard(
                                              transfer: transfer,
                                              players: players,
                                            );
                                          },
                                        ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
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
            .showSnackBar(const SnackBar(content: Text('下一局未发送，请检查连接状态')));
      }
    }
  }
}

class _SingleRoundSettlementView extends StatelessWidget {
  const _SingleRoundSettlementView({
    required this.room,
    required this.round,
    required this.settlement,
    required this.players,
    required this.deltas,
    required this.scores,
    required this.outcome,
    required this.snapshot,
    required this.buttonLabel,
    required this.onNext,
  });

  final Map<String, dynamic> room;
  final Map<String, dynamic> round;
  final Map<String, dynamic> settlement;
  final List<Map<String, dynamic>> players;
  final Map<String, dynamic> deltas;
  final Map<String, dynamic> scores;
  final String outcome;
  final ClientSnapshot snapshot;
  final String buttonLabel;
  final VoidCallback? onNext;

  @override
  Widget build(BuildContext context) {
    final wins = settlement['wins'] is List
        ? List<Object?>.from(settlement['wins'] as List)
              .map(_dynamicMap)
              .whereType<Map<String, dynamic>>()
              .toList(growable: false)
        : const <Map<String, dynamic>>[];
    final winners = {
      ..._stringValues(settlement['winnerIds']),
      ...wins.map((win) => win['winnerId']?.toString()).whereType<String>(),
    };
    final revealed =
        _dynamicMap(settlement['revealedHandsByPlayer']) ?? const {};
    final flowers = _dynamicMap(round['flowerStates']) ?? const {};
    final flowerTiles = _dynamicMap(round['flowerTilesByPlayer']) ?? const {};
    final melds = _dynamicMap(round['meldsByPlayer']) ?? const {};
    final awards =
        _dynamicMap(settlement['flowerAwardCountByPlayer']) ?? const {};
    final zeng = _dynamicMap(room['zengByPlayer']) ?? const {};
    final roundNumber = _intValue(round['roundNumber']);
    return ColoredBox(
      color: const Color(0xff345f55),
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 8, 14, 8),
          child: Column(
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      '第 ${roundNumber ?? '—'} 局结算 · $outcome',
                      style: const TextStyle(
                        color: Color(0xffffe4a3),
                        fontSize: 21,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                  ),
                  Text(
                    '累计分已同步至服务端',
                    style: TextStyle(
                      color: Colors.white.withValues(alpha: 0.72),
                      fontSize: 11,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 7),
              Expanded(
                child: ListView.separated(
                  itemCount: players.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 5),
                  itemBuilder: (context, index) {
                    final player = players[index];
                    final playerId =
                        player['id']?.toString() ??
                        player['playerId']?.toString() ??
                        '';
                    final isSelf = playerId == snapshot.userId;
                    final isWinner = winners.contains(playerId);
                    final win = wins.cast<Map<String, dynamic>?>().firstWhere(
                      (item) => item?['winnerId']?.toString() == playerId,
                      orElse: () => null,
                    );
                    final flowerState = _dynamicMap(flowers[playerId]);
                    final flowerCount =
                        _intValue(flowerState?['countedFlowers']) ??
                        _intValue(win?['flowerCount']) ??
                        0;
                    final hand = _stringValues(revealed[playerId]);
                    final playerMelds = melds[playerId] is List
                        ? List<Object?>.from(melds[playerId] as List)
                        : const <Object?>[];
                    return _SettlementPlayerRow(
                      player: player,
                      isSelf: isSelf,
                      isWinner: isWinner,
                      outcomeBadge: isWinner
                          ? (settlement['outcome'] == 'self_draw' ? '自摸' : '胡')
                          : null,
                      delta: _intValue(deltas[playerId]) ?? 0,
                      total: _intValue(scores[playerId]) ?? 0,
                      zeng: _intValue(zeng[playerId]) ?? 0,
                      flowerCount: flowerCount,
                      flowerAwardCount: _intValue(awards[playerId]) ?? 0,
                      tier: win?['tier']?.toString(),
                      hand: hand,
                      melds: playerMelds,
                      flowers: _stringValues(flowerTiles[playerId]),
                    );
                  },
                ),
              ),
              const SizedBox(height: 7),
              if (onNext != null)
                FilledButton.icon(
                  onPressed: onNext,
                  icon: const Icon(Icons.play_arrow),
                  label: Text(buttonLabel),
                  style: FilledButton.styleFrom(
                    backgroundColor: const Color(0xffffb51b),
                    foregroundColor: const Color(0xff543100),
                    minimumSize: const Size(190, 44),
                  ),
                )
              else
                const Text(
                  '等待房主继续游戏',
                  style: TextStyle(color: Color(0xffd3e6df)),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SettlementPlayerRow extends StatelessWidget {
  const _SettlementPlayerRow({
    required this.player,
    required this.isSelf,
    required this.isWinner,
    required this.outcomeBadge,
    required this.delta,
    required this.total,
    required this.zeng,
    required this.flowerCount,
    required this.flowerAwardCount,
    required this.tier,
    required this.hand,
    required this.melds,
    required this.flowers,
  });

  final Map<String, dynamic> player;
  final bool isSelf;
  final bool isWinner;
  final String? outcomeBadge;
  final int delta;
  final int total;
  final int zeng;
  final int flowerCount;
  final int flowerAwardCount;
  final String? tier;
  final List<String> hand;
  final List<Object?> melds;
  final List<String> flowers;

  @override
  Widget build(BuildContext context) {
    final meldTiles = melds
        .map(_dynamicMap)
        .whereType<Map<String, dynamic>>()
        .expand((meld) => _stringValues(meld['tileIds']))
        .toList(growable: false);
    final tierLabel =
        const {
          'small': '小胡',
          'big': '大胡',
          'double_big': '大大胡',
          'one_bamboo': '一索/封顶',
        }[tier] ??
        '';
    return Semantics(
      label: isSelf ? '自己结算行' : '${_playerName(player)}结算行',
      child: Container(
        height: 91,
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
        decoration: BoxDecoration(
          color: isSelf ? const Color(0xffffd2c2) : const Color(0xfffff4d8),
          borderRadius: BorderRadius.circular(9),
          border: Border.all(
            color: isWinner ? const Color(0xffffa726) : const Color(0xffc8b886),
            width: isWinner ? 1.7 : 0.8,
          ),
        ),
        child: Row(
          children: [
            SizedBox(
              width: 84,
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  CircleAvatar(
                    radius: 18,
                    backgroundColor: const Color(0xff0d6b55),
                    child: Text('${(_intValue(player['seat']) ?? 0) + 1}'),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    _playerName(player),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: isSelf
                          ? const Color(0xffba3e2d)
                          : const Color(0xff583d22),
                      fontSize: 11,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '花奖 $flowerAwardCount  增 $zeng  $flowerCount 朵花${tierLabel.isEmpty ? '' : '  $tierLabel'}',
                    style: const TextStyle(
                      color: Color(0xff7a4d24),
                      fontSize: 11,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Expanded(
                    child: ListView(
                      scrollDirection: Axis.horizontal,
                      children: [
                        for (final tile in meldTiles) ...[
                          _MiniMahjongTile(tileId: tile),
                          const SizedBox(width: 1),
                        ],
                        if (meldTiles.isNotEmpty) const SizedBox(width: 5),
                        for (final tile in hand) ...[
                          _MiniMahjongTile(tileId: tile),
                          const SizedBox(width: 1),
                        ],
                        if (flowers.isNotEmpty) const SizedBox(width: 7),
                        for (final tile in flowers) ...[
                          _MiniFlowerTile(tileId: tile),
                          const SizedBox(width: 1),
                        ],
                      ],
                    ),
                  ),
                ],
              ),
            ),
            SizedBox(
              width: 74,
              child: FittedBox(
                fit: BoxFit.scaleDown,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text(
                      delta > 0 ? '+$delta' : '$delta',
                      style: TextStyle(
                        color: delta >= 0
                            ? const Color(0xffc8491d)
                            : const Color(0xff176aa4),
                        fontSize: 25,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    Text(
                      '总计 $total',
                      style: const TextStyle(
                        color: Color(0xff765b42),
                        fontSize: 10,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            SizedBox(
              width: 62,
              child: Center(
                child: Text(
                  outcomeBadge ?? '',
                  style: const TextStyle(
                    color: Color(0xff9f5b05),
                    fontSize: 21,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MatchSettlementView extends StatelessWidget {
  const _MatchSettlementView({
    required this.room,
    required this.round,
    required this.players,
    required this.scores,
    required this.deltas,
    required this.snapshot,
  });

  final Map<String, dynamic> room;
  final Map<String, dynamic> round;
  final List<Map<String, dynamic>> players;
  final Map<String, dynamic> scores;
  final Map<String, dynamic> deltas;
  final ClientSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    final stats = _dynamicMap(room['matchStatsByPlayer']) ?? const {};
    final topScore = players
        .map((player) => _intValue(scores[player['id']?.toString()]) ?? 0)
        .fold<int>(-0x7fffffff, (best, score) => score > best ? score : best);
    return ColoredBox(
      color: const Color(0xff426c63),
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            children: [
              Text(
                '牌局结束 · ${room['totalRounds'] ?? '—'} 局',
                style: const TextStyle(
                  color: Color(0xffffe8b0),
                  fontSize: 24,
                  fontWeight: FontWeight.w900,
                ),
              ),
              const SizedBox(height: 12),
              Expanded(
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (var index = 0; index < players.length; index++) ...[
                      if (index > 0) const SizedBox(width: 9),
                      Expanded(
                        child: _MatchPlayerCard(
                          player: players[index],
                          isSelf:
                              players[index]['id']?.toString() ==
                              snapshot.userId,
                          isWinner:
                              (_intValue(
                                    scores[players[index]['id']?.toString()],
                                  ) ??
                                  0) ==
                              topScore,
                          score:
                              _intValue(
                                scores[players[index]['id']?.toString()],
                              ) ??
                              0,
                          lastDelta:
                              _intValue(
                                deltas[players[index]['id']?.toString()],
                              ) ??
                              0,
                          stats:
                              _dynamicMap(
                                stats[players[index]['id']?.toString()],
                              ) ??
                              const {},
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 10),
              Text(
                '房间号：${room['id'] ?? room['roomId'] ?? '—'}  ·  总成绩以服务端为准',
                style: const TextStyle(color: Color(0xffe5f0ec), fontSize: 12),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _MatchPlayerCard extends StatelessWidget {
  const _MatchPlayerCard({
    required this.player,
    required this.isSelf,
    required this.isWinner,
    required this.score,
    required this.lastDelta,
    required this.stats,
  });

  final Map<String, dynamic> player;
  final bool isSelf;
  final bool isWinner;
  final int score;
  final int lastDelta;
  final Map<String, dynamic> stats;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: isSelf ? const Color(0xffffd5c9) : const Color(0xfffff6df),
      borderRadius: BorderRadius.circular(11),
      border: Border.all(
        color: isWinner ? const Color(0xffffad19) : const Color(0xffccb98a),
        width: isWinner ? 2 : 1,
      ),
    ),
    child: Column(
      children: [
        CircleAvatar(
          radius: 26,
          backgroundColor: const Color(0xff16705b),
          child: Text('${(_intValue(player['seat']) ?? 0) + 1}'),
        ),
        const SizedBox(height: 5),
        Text(
          _playerName(player),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(
            color: Color(0xff9f3928),
            fontWeight: FontWeight.w900,
          ),
        ),
        if (isWinner)
          const Text(
            '大赢家',
            style: TextStyle(
              color: Color(0xffd67a00),
              fontWeight: FontWeight.w900,
            ),
          ),
        const Divider(),
        _MatchStatLine(
          label: '自摸次数',
          value: _intValue(stats['selfDrawCount']) ?? 0,
        ),
        _MatchStatLine(
          label: '接炮次数',
          value: _intValue(stats['discardWinCount']) ?? 0,
        ),
        _MatchStatLine(
          label: '放炮次数',
          value: _intValue(stats['dealInCount']) ?? 0,
        ),
        _MatchStatLine(
          label: '花奖个数',
          value: _intValue(stats['flowerAwardCount']) ?? 0,
        ),
        const Spacer(),
        Text(
          '末局 ${lastDelta > 0 ? '+$lastDelta' : '$lastDelta'}',
          style: const TextStyle(color: Color(0xff80674e), fontSize: 11),
        ),
        const Text(
          '总成绩',
          style: TextStyle(
            color: Color(0xff8a4f20),
            fontSize: 15,
            fontWeight: FontWeight.w800,
          ),
        ),
        Text(
          score > 0 ? '+$score' : '$score',
          style: TextStyle(
            color: score >= 0
                ? const Color(0xffd04a1a)
                : const Color(0xff176aa4),
            fontSize: 32,
            fontWeight: FontWeight.w900,
          ),
        ),
      ],
    ),
  );
}

class _MatchStatLine extends StatelessWidget {
  const _MatchStatLine({required this.label, required this.value});

  final String label;
  final int value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 4),
    child: Row(
      children: [
        Expanded(
          child: Text(
            label,
            style: const TextStyle(color: Color(0xff765333), fontSize: 12),
          ),
        ),
        Text(
          '$value',
          style: const TextStyle(
            color: Color(0xff765333),
            fontWeight: FontWeight.w900,
          ),
        ),
      ],
    ),
  );
}

class _SettlementTransferCard extends StatelessWidget {
  const _SettlementTransferCard({
    required this.transfer,
    required this.players,
  });

  final Map<String, dynamic> transfer;
  final List<Map<String, dynamic>> players;

  @override
  Widget build(BuildContext context) {
    final from = transfer['from']?.toString();
    final to = transfer['to']?.toString();
    final trace = transfer['trace'] is List
        ? List<Object?>.from(transfer['trace'] as List)
        : const <Object?>[];
    final labels = trace.map(_dynamicMap).whereType<Map<String, dynamic>>().map(
      (stage) {
        return switch (stage['stage']?.toString()) {
          'winner_zeng' => '赢家增 ${stage['value'] ?? 0}',
          'payer_zeng' => '付款家增 ${stage['value'] ?? 0}',
          'piao' => stage['status'] == 'piao' ? '飘花' : '不飘花',
          'flower_tier' => '花档 ${stage['value'] ?? 0}',
          'flower_award' =>
            '花奖 ×${stage['count'] ?? 0}（第二档 ${stage['unit'] ?? 0}）',
          'sanxi' when stage['sanxiShare'] == 1 && stage['regularShare'] == 0 =>
            '三西加付 ×1',
          'sanxi' when stage['sanxiShare'] == 1 =>
            '三西叠加 ×${stage['multiplier'] ?? 2}',
          'sanxi' => '无三西 ×${stage['multiplier'] ?? 1}',
          _ => stage['stage']?.toString() ?? '未知阶段',
        };
      },
    ).toList();
    return DecoratedBox(
      decoration: BoxDecoration(
        color: const Color(0x33000000),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: const Color(0x337fffff)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '${transfer['kind'] == 'flower_award' ? '花奖 · ' : ''}${_settlementPlayerName(players, from)} → ${_settlementPlayerName(players, to)}  ${transfer['amount'] ?? 0} 分',
              style: const TextStyle(
                color: Color(0xffffd369),
                fontWeight: FontWeight.w900,
              ),
            ),
            const SizedBox(height: 3),
            Text(
              labels.isEmpty ? '服务端未下发迹线' : labels.join('  →  '),
              style: const TextStyle(color: Color(0xffd4e8e2), fontSize: 11),
            ),
          ],
        ),
      ),
    );
  }
}

String _settlementPlayerName(
  List<Map<String, dynamic>> players,
  String? playerId,
) {
  final player = _findPlayer(players, playerId);
  return player == null ? (playerId ?? '—') : _playerName(player);
}

String _settlementWinReason(
  Map<String, dynamic> win,
  List<Map<String, dynamic>> players,
) {
  final player = _settlementPlayerName(players, win['winnerId']?.toString());
  final tier =
      const {
        'small': '小胡',
        'big': '大胡',
        'double_big': '大大胡',
        'one_bamboo': '一索/封顶',
      }[win['tier']?.toString()] ??
      win['tier']?.toString() ??
      '胡牌';
  final details = <String>[
    '$player $tier',
    '${_intValue(win['flowerCount']) ?? 0} 花',
  ];
  if (win['cappedByNoFlowerSelfDraw'] == true) details.add('无花果自摸封顶');
  final gangWinCount = _intValue(win['gangWinCount']) ?? 0;
  if (gangWinCount > 0) details.add('杠开×$gangWinCount');
  details.addAll(
    _stringValues(win['patterns']).map(
      (pattern) =>
          const {
            'seven_pairs': '七对',
            'pure_one_suit': '清一色',
            'mixed_one_suit': '混一色',
            'all_triplets': '碰碰胡',
            'all_from_others': '全求人',
            'heavenly_win': '天胡',
            'earthly_win': '地胡',
            'robbing_kong': '抢杠胡',
          }[pattern] ??
          pattern,
    ),
  );
  return details.join(' / ');
}

// Kept temporarily for settlement/replay layout comparison while the live
// table uses the spatial lanes above.
// ignore: unused_element
class _RoundPublicBoard extends StatelessWidget {
  const _RoundPublicBoard({
    required this.room,
    required this.round,
    required this.players,
    required this.status,
  });

  final Map<String, dynamic> room;
  final Map<String, dynamic>? round;
  final List<Map<String, dynamic>> players;
  final String status;

  @override
  Widget build(BuildContext context) {
    final state = round;
    final wall = _dynamicMap(state?['wall']);
    final roundNumber = _intValue(
      state?['roundNumber'] ?? state?['number'] ?? room['roundNumber'],
    );
    final totalRounds = _intValue(room['totalRounds']);
    final phase = state?['turnPhase']?.toString();
    final turnPlayerId = room['turnPlayerId']?.toString();
    final discards = _dynamicMap(state?['discardsByPlayer']) ?? const {};
    final melds = _dynamicMap(state?['meldsByPlayer']) ?? const {};
    final flowers = _dynamicMap(state?['flowerStates']) ?? const {};
    final orderedPlayers = [...players]
      ..sort(
        (left, right) => (_intValue(left['seat']) ?? 0).compareTo(
          _intValue(right['seat']) ?? 0,
        ),
      );
    final roundLabel = roundNumber == null
        ? _roomStatusLabel(status)
        : '第 $roundNumber/${totalRounds ?? '—'} 局';

    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxHeight < 80) {
          return Center(
            child: Text(
              '宿松麻将 · $roundLabel',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 16,
                color: Color(0xffffe4a3),
                fontWeight: FontWeight.w900,
              ),
            ),
          );
        }
        return Padding(
          padding: const EdgeInsets.all(10),
          child: Column(
            children: [
              const Text(
                '宿松麻将',
                style: TextStyle(
                  fontSize: 20,
                  color: Color(0xffffe4a3),
                  fontWeight: FontWeight.w900,
                ),
              ),
              const SizedBox(height: 3),
              Wrap(
                alignment: WrapAlignment.center,
                spacing: 10,
                runSpacing: 2,
                children: [
                  Text(
                    roundLabel,
                    style: const TextStyle(color: Color(0xffc6e0da)),
                  ),
                  if (wall?['wallRemaining'] is int)
                    Text(
                      '剩余 ${wall!['wallRemaining']} 张',
                      style: const TextStyle(color: Color(0xffc6e0da)),
                    ),
                  if (phase != null)
                    _TurnCountdown(
                      phase: phase,
                      deadlineAt: state?['turnDeadlineAt']?.toString(),
                    ),
                ],
              ),
              if (orderedPlayers.isNotEmpty) ...[
                const SizedBox(height: 7),
                Expanded(
                  child: ListView.separated(
                    padding: EdgeInsets.zero,
                    itemCount: orderedPlayers.length,
                    separatorBuilder: (_, _) => const SizedBox(height: 4),
                    itemBuilder: (context, index) {
                      final player = orderedPlayers[index];
                      final playerId =
                          player['id']?.toString() ??
                          player['playerId']?.toString();
                      return _RoundPlayerPublicState(
                        player: player,
                        isTurn: playerId != null && playerId == turnPlayerId,
                        discards: _stringValues(discards[playerId]),
                        melds: melds[playerId] is List
                            ? List<Object?>.from(melds[playerId] as List)
                            : const [],
                        flowerState: _dynamicMap(flowers[playerId]),
                      );
                    },
                  ),
                ),
              ],
            ],
          ),
        );
      },
    );
  }
}

class _RoundPlayerPublicState extends StatelessWidget {
  const _RoundPlayerPublicState({
    required this.player,
    required this.isTurn,
    required this.discards,
    required this.melds,
    required this.flowerState,
  });

  final Map<String, dynamic> player;
  final bool isTurn;
  final List<String> discards;
  final List<Object?> melds;
  final Map<String, dynamic>? flowerState;

  @override
  Widget build(BuildContext context) {
    final flowerCount = _intValue(flowerState?['countedFlowers']) ?? 0;
    final piao = flowerState?['status'] == 'piao' ? ' · 飘花' : '';
    final meldLabels = melds
        .map(_dynamicMap)
        .whereType<Map<String, dynamic>>()
        .map((meld) {
          final action = _gameActionLabel(meld['action']?.toString() ?? '副露');
          final tiles = _stringValues(meld['tileIds'])
              .map(_mahjongFaceLabel)
              .join('');
          return '$action$tiles';
        })
        .join(' / ');
    final discardLabels = discards.map(_mahjongFaceLabel).join(' ');
    return DecoratedBox(
      decoration: BoxDecoration(
        color: isTurn ? const Color(0x5569d7ae) : const Color(0x33000000),
        borderRadius: BorderRadius.circular(7),
        border: Border.all(
          color: isTurn ? const Color(0xffffd369) : const Color(0x337fffff),
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '${isTurn ? '▶ ' : ''}${_playerName(player)} · 花 $flowerCount$piao',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                color: Color(0xffffe4a3),
                fontWeight: FontWeight.w700,
                fontSize: 11,
              ),
            ),
            Text(
              '副露 ${meldLabels.isEmpty ? '—' : meldLabels}  ·  弃牌 ${discardLabels.isEmpty ? '—' : discardLabels}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: Color(0xffd4e8e2), fontSize: 10),
            ),
          ],
        ),
      ),
    );
  }
}

class _TurnCountdown extends StatefulWidget {
  const _TurnCountdown({required this.phase, required this.deadlineAt});

  final String phase;
  final String? deadlineAt;

  @override
  State<_TurnCountdown> createState() => _TurnCountdownState();
}

class _TurnCountdownState extends State<_TurnCountdown> {
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _startTicker();
  }

  @override
  void didUpdateWidget(covariant _TurnCountdown oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.deadlineAt != widget.deadlineAt) _startTicker();
  }

  void _startTicker() {
    _timer?.cancel();
    if (DateTime.tryParse(widget.deadlineAt ?? '') == null) return;
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final deadline = DateTime.tryParse(widget.deadlineAt ?? '');
    final seconds = deadline
        ?.difference(DateTime.now())
        .inSeconds
        .clamp(0, 999);
    return Text(
      '${_turnPhaseLabel(widget.phase)}${seconds == null ? '' : ' $seconds 秒'}',
      style: const TextStyle(color: Color(0xffffd369)),
    );
  }
}

String _turnPhaseLabel(String phase) =>
    const {
      'opening_choice': '请选择飘花',
      'draw': '待摸牌',
      'discard': '待出牌',
      'reaction': '待响应',
    }[phase] ??
    phase;

class _AuthoritativeActionButtons extends StatelessWidget {
  const _AuthoritativeActionButtons({
    required this.client,
    required this.roomId,
    required this.round,
    required this.connected,
    required this.run,
  });

  final ClientSessionController client;
  final String roomId;
  final Map<String, dynamic> round;
  final bool connected;
  final Future<void> Function(Future<String> Function()) run;

  @override
  Widget build(BuildContext context) {
    final actions = _stringValues(round['availableActions']);
    final reactions = _stringValues(round['availableReactions']);
    final reactionOptions = _dynamicMap(round['reactionOptions']) ?? const {};
    final kongOptions = _dynamicMap(round['kongOptions']) ?? const {};
    final buttons = <Widget>[];

    for (final action in reactions.where((value) => value != 'chi')) {
      buttons.add(_button(action, const {}));
    }
    final chiOptions = reactionOptions['chi'];
    if (reactions.contains('chi') && chiOptions is List) {
      for (final raw in chiOptions.whereType<Map>()) {
        final option = Map<String, dynamic>.from(raw);
        final index = option['candidateIndex'];
        final sequence = _stringValues(option['sequence']);
        if (index is int) {
          buttons.add(_chiButton(index, sequence));
        }
      }
    }
    for (final action in actions.where(
      (value) => !['discard', 'concealed_kong', 'added_kong'].contains(value),
    )) {
      buttons.add(_button(action, const {}));
    }
    for (final action in const ['concealed_kong', 'added_kong']) {
      final options = kongOptions[action];
      if (!actions.contains(action) || options is! List) continue;
      for (final raw in options.whereType<Map>()) {
        final option = Map<String, dynamic>.from(raw);
        final index = option['candidateIndex'];
        if (index is int) {
          buttons.add(
            _button(action, {
              'candidateIndex': index,
            }, suffix: _mahjongFaceLabel(option['face']?.toString() ?? '')),
          );
        }
      }
    }
    return Wrap(spacing: 6, runSpacing: 6, children: buttons);
  }

  Widget _button(
    String action,
    Map<String, dynamic> args, {
    String suffix = '',
  }) {
    final label =
        '${_gameActionLabel(action)}${suffix.isEmpty ? '' : ' $suffix'}';
    return FilledButton.tonal(
      onPressed: connected
          ? () => run(() => client.action(roomId, action, args: args))
          : null,
      style: FilledButton.styleFrom(
        visualDensity: VisualDensity.compact,
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      ),
      child: Text(label),
    );
  }

  Widget _chiButton(int candidateIndex, List<String> sequence) {
    return FilledButton.tonal(
      onPressed: connected
          ? () => run(
              () => client.action(
                roomId,
                'chi',
                args: {'candidateIndex': candidateIndex},
              ),
            )
          : null,
      style: FilledButton.styleFrom(
        visualDensity: VisualDensity.compact,
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 4),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text('吃'),
          const SizedBox(width: 4),
          for (final face in sequence) ...[
            _MiniMahjongTile(tileId: '$face-9'),
            const SizedBox(width: 1),
          ],
        ],
      ),
    );
  }
}

class _MahjongTile extends StatelessWidget {
  const _MahjongTile({
    required this.tileId,
    required this.enabled,
    required this.onTap,
  });

  final String tileId;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Material(
    color: enabled ? const Color(0xfffff8df) : const Color(0xffc8c4b8),
    borderRadius: BorderRadius.circular(7),
    elevation: enabled ? 4 : 1,
    child: InkWell(
      onTap: enabled ? onTap : null,
      borderRadius: BorderRadius.circular(7),
      child: Container(
        width: 42,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(7),
          border: Border.all(color: const Color(0xffb59a58)),
        ),
        child: Semantics(
          label: _mahjongFaceLabel(tileId),
          button: enabled,
          excludeSemantics: true,
          child: Padding(
            padding: const EdgeInsets.all(3),
            child: _MahjongFaceArt(tileId: tileId),
          ),
        ),
      ),
    ),
  );
}

class _MahjongFaceArt extends StatelessWidget {
  const _MahjongFaceArt({required this.tileId, this.compact = false});

  final String tileId;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final code = _apkMahjongFaceCode(tileId);
    if (code == null) return Text(_mahjongFaceLabel(tileId));
    const root = 'assets/mahjong/apk_tiles';
    return Stack(
      fit: StackFit.expand,
      alignment: Alignment.center,
      children: [
        Image.asset('$root/base.png', fit: BoxFit.fill),
        Padding(
          padding: EdgeInsets.fromLTRB(
            compact ? 4 : 6,
            compact ? 3 : 5,
            compact ? 4 : 6,
            compact ? 5 : 8,
          ),
          child: Image.asset(
            '$root/face_$code.png',
            fit: BoxFit.contain,
            filterQuality: FilterQuality.high,
          ),
        ),
      ],
    );
  }
}

int? _apkMahjongFaceCode(String tileId) {
  final face = _mahjongLogicalFace(tileId);
  final suited = RegExp(r'^(characters|bamboo|dots)-(\d)$').firstMatch(face);
  if (suited != null) {
    final rank = int.parse(suited.group(2)!);
    return switch (suited.group(1)) {
      'bamboo' => 10 + rank,
      'dots' => 20 + rank,
      'characters' => 30 + rank,
      _ => null,
    };
  }
  final honor = const {
    'east': 41,
    'south': 42,
    'west': 43,
    'north': 44,
    'red_dragon': 45,
    'green_dragon': 46,
    'white_dragon': 47,
  }[face];
  if (honor != null) return honor;
  final copy = int.tryParse(tileId.split('-').last);
  if (face == 'red_flower') {
    return const {1: 199, 2: 215, 3: 231, 4: 247}[copy] ?? 199;
  }
  if (face == 'black_flower') {
    return const {1: 200, 2: 216, 3: 232, 4: 248}[copy] ?? 200;
  }
  return null;
}

String _gameActionLabel(String action) =>
    const {
      'draw': '摸牌',
      'pass': '过',
      'hu': '胡',
      'self_draw': '自摸',
      'chi': '吃',
      'peng': '碰',
      'exposed_kong': '明杠',
      'concealed_kong': '暗杠',
      'added_kong': '巴杠',
    }[action] ??
    action;

String _mahjongFaceLabel(String tileId) {
  final face = _mahjongLogicalFace(tileId);
  final flowerCopy = int.tryParse(tileId.split('-').last);
  if (face == 'red_flower') {
    return const {1: '春', 2: '夏', 3: '秋', 4: '冬'}[flowerCopy] ?? '红花';
  }
  if (face == 'black_flower') {
    return const {1: '梅', 2: '兰', 3: '竹', 4: '菊'}[flowerCopy] ?? '黑花';
  }
  final suited = RegExp(r'^(characters|bamboo|dots)-(\d)$').firstMatch(face);
  if (suited != null) {
    final suffix = const {
      'characters': '万',
      'bamboo': '条',
      'dots': '筒',
    }[suited.group(1)];
    return '${suited.group(2)}$suffix';
  }
  return const {
        'east': '东',
        'south': '南',
        'west': '西',
        'north': '北',
        'red_dragon': '中',
        'green_dragon': '发',
        'white_dragon': '白',
        'red_flower': '红花',
        'black_flower': '黑花',
      }[face] ??
      face;
}

String _mahjongLogicalFace(String tileId) {
  final suited = RegExp(r'^(characters|bamboo|dots)-([1-9])-\d+$')
      .firstMatch(tileId);
  if (suited != null) return '${suited.group(1)}-${suited.group(2)}';
  final honor = RegExp(
    r'^(east|south|west|north|red_dragon|green_dragon|white_dragon|red_flower|black_flower)-\d+$',
  ).firstMatch(tileId);
  return honor?.group(1) ?? tileId;
}

bool _isSusongFlowerTileId(String tileId) => const {
  'red_dragon',
  'green_dragon',
  'white_dragon',
  'red_flower',
  'black_flower',
}.contains(_mahjongLogicalFace(tileId));

List<String> _susongWaitingFaces(List<String> hand, int meldCount) {
  final faces = hand
      .map(_mahjongLogicalFace)
      .where(
        (face) => !const {
          'red_dragon',
          'green_dragon',
          'white_dragon',
          'red_flower',
          'black_flower',
        }.contains(face),
      )
      .toList(growable: false);
  if (meldCount < 0 ||
      meldCount > 4 ||
      faces.length != (4 - meldCount) * 3 + 1) {
    return const [];
  }
  final candidates = <String>[
    for (final family in const ['characters', 'bamboo', 'dots'])
      for (var value = 1; value <= 9; value++) '$family-$value',
    'east',
    'south',
    'west',
    'north',
  ];
  final currentCounts = <String, int>{};
  for (final face in faces) {
    currentCounts[face] = (currentCounts[face] ?? 0) + 1;
  }
  return candidates
      .where((candidate) {
        if ((currentCounts[candidate] ?? 0) >= 4) return false;
        return _isStandardWinningFaces([...faces, candidate], meldCount);
      })
      .toList(growable: false);
}

bool _isStandardWinningFaces(List<String> faces, int meldCount) {
  if (faces.length != (4 - meldCount) * 3 + 2) return false;
  final counts = <String, int>{};
  for (final face in faces) {
    counts[face] = (counts[face] ?? 0) + 1;
  }
  if (meldCount == 0 &&
      counts.length == 7 &&
      counts.values.every((count) => count == 2)) {
    return true;
  }
  for (final pair in counts.keys.toList(growable: false)) {
    if ((counts[pair] ?? 0) < 2) continue;
    final remaining = Map<String, int>.from(counts);
    remaining[pair] = remaining[pair]! - 2;
    if (_consumeWinningMeldFaces(remaining)) return true;
  }
  return false;
}

bool _consumeWinningMeldFaces(Map<String, int> counts) {
  String? face;
  for (final candidate in counts.keys) {
    if ((counts[candidate] ?? 0) > 0) {
      face = candidate;
      break;
    }
  }
  if (face == null) return true;
  if ((counts[face] ?? 0) >= 3) {
    final triplet = Map<String, int>.from(counts);
    triplet[face] = triplet[face]! - 3;
    if (_consumeWinningMeldFaces(triplet)) return true;
  }
  final suited = RegExp(r'^(characters|bamboo|dots)-(\d)$').firstMatch(face);
  final value = int.tryParse(suited?.group(2) ?? '');
  if (suited != null && value != null && value <= 7) {
    final next = '${suited.group(1)}-${value + 1}';
    final after = '${suited.group(1)}-${value + 2}';
    if ((counts[next] ?? 0) > 0 && (counts[after] ?? 0) > 0) {
      final sequence = Map<String, int>.from(counts);
      sequence[face] = sequence[face]! - 1;
      sequence[next] = sequence[next]! - 1;
      sequence[after] = sequence[after]! - 1;
      if (_consumeWinningMeldFaces(sequence)) return true;
    }
  }
  return false;
}

int _compareMahjongTileIds(String left, String right) {
  final leftKey = _mahjongSortKey(left);
  final rightKey = _mahjongSortKey(right);
  for (var index = 0; index < leftKey.length; index += 1) {
    final comparison = leftKey[index].compareTo(rightKey[index]);
    if (comparison != 0) return comparison;
  }
  return left.compareTo(right);
}

List<int> _mahjongSortKey(String tileId) {
  final face = _mahjongLogicalFace(tileId);
  final suited = RegExp(r'^(characters|bamboo|dots)-(\d)$').firstMatch(face);
  if (suited != null) {
    final family = const {'characters': 0, 'bamboo': 1, 'dots': 2};
    return [
      family[suited.group(1)]!,
      int.parse(suited.group(2)!),
      int.tryParse(tileId.split('-').last) ?? 0,
    ];
  }
  const honors = {
    'east': 0,
    'south': 1,
    'west': 2,
    'north': 3,
    'red_dragon': 4,
    'green_dragon': 5,
    'white_dragon': 6,
    'red_flower': 7,
    'black_flower': 8,
  };
  return [
    face == 'red_flower' || face == 'black_flower' ? 4 : 3,
    honors[face] ?? 99,
    int.tryParse(tileId.split('-').last) ?? 0,
  ];
}

String? _meldProviderDirection(
  Map<String, dynamic> claimant,
  Map<String, dynamic> meld,
  List<Map<String, dynamic>> players,
) {
  final providerId = meld['fromPlayerId']?.toString();
  if (providerId == null || providerId.isEmpty) return null;
  final claimantSeat = _intValue(claimant['seat']);
  final provider = players.cast<Map<String, dynamic>?>().firstWhere(
    (candidate) =>
        candidate?['id']?.toString() == providerId ||
        candidate?['playerId']?.toString() == providerId,
    orElse: () => null,
  );
  final providerSeat = _intValue(provider?['seat']);
  if (claimantSeat == null || providerSeat == null) return null;
  return switch ((providerSeat - claimantSeat) % 4) {
    3 => '上家',
    2 => '对家',
    1 => '下家',
    _ => null,
  };
}

int? _meldProviderSeat(
  Map<String, dynamic> meld,
  List<Map<String, dynamic>> players,
) {
  final providerId = meld['fromPlayerId']?.toString();
  if (providerId == null || providerId.isEmpty) return null;
  final provider = players.cast<Map<String, dynamic>?>().firstWhere(
    (candidate) =>
        candidate?['id']?.toString() == providerId ||
        candidate?['playerId']?.toString() == providerId,
    orElse: () => null,
  );
  return _intValue(provider?['seat']);
}

String _seatScreenDirection(int seat) => switch (seat) {
  0 => '下',
  1 => '右',
  2 => '上',
  3 => '左',
  _ => '未知',
};

class _RoomStatusStrip extends StatelessWidget {
  const _RoomStatusStrip({
    required this.status,
    required this.version,
    required this.connected,
    required this.maxPlayers,
    required this.ready,
    required this.showReady,
  });

  final String status;
  final int version;
  final int connected;
  final int maxPlayers;
  final int ready;
  final bool showReady;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
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
            if (showReady) Text('准备 $ready/$maxPlayers'),
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
    required this.playing,
    required this.score,
    this.isDealer = false,
  });

  final int seat;
  final Map<String, dynamic>? player;
  final String? ownerId;
  final bool playing;
  final int score;
  final bool isDealer;

  @override
  Widget build(BuildContext context) {
    final occupied = player != null;
    final name = occupied ? _playerName(player!) : '等待加入';
    final online = player?['connected'] == true;
    final isOwner = occupied && player!['id']?.toString() == ownerId;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: const Color(0xcc103f37),
        borderRadius: BorderRadius.circular(9),
        border: Border.all(
          color: isOwner ? const Color(0xffffd369) : const Color(0x5579b7a7),
        ),
        boxShadow: const [BoxShadow(color: Colors.black26, blurRadius: 5)],
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 3),
        child: Row(
          children: [
            CircleAvatar(
              radius: 15,
              backgroundColor: occupied
                  ? const Color(0xff2d806d)
                  : const Color(0xff49615b),
              child: Text(
                occupied ? name.characters.first : '${seat + 1}',
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 12,
                  fontWeight: FontWeight.w900,
                ),
              ),
            ),
            const SizedBox(width: 4),
            Expanded(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      if (isDealer) ...[
                        DecoratedBox(
                          decoration: BoxDecoration(
                            color: const Color(0xffffd369),
                            borderRadius: BorderRadius.circular(3),
                          ),
                          child: const Padding(
                            padding: EdgeInsets.symmetric(horizontal: 2),
                            child: Text(
                              '庄',
                              style: TextStyle(
                                color: Color(0xff573a00),
                                fontSize: 8,
                                fontWeight: FontWeight.w900,
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(width: 2),
                      ],
                      Expanded(
                        child: Text(
                          name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontWeight: FontWeight.w800,
                            fontSize: 10,
                          ),
                        ),
                      ),
                      Icon(
                        online ? Icons.wifi : Icons.wifi_off,
                        size: 9,
                        color: online ? const Color(0xff69d7ae) : Colors.grey,
                      ),
                    ],
                  ),
                  Text(
                    occupied ? '$score 分' : '空位',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: occupied
                          ? const Color(0xffffe4a3)
                          : const Color(0xffa8beb8),
                      fontSize: 9,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ],
              ),
            ),
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

Map<String, dynamic>? _dynamicMap(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : null;

List<String> _stringValues(Object? value) => value is List
    ? value.map((entry) => entry.toString()).toList(growable: false)
    : const [];

List<Map<String, dynamic>?> _roomSeats(Map<String, dynamic> room) {
  final rawSeats = room['seats'];
  final maxPlayers =
      _positiveInt(room['maxPlayers']) ??
      (rawSeats is List && rawSeats.isNotEmpty ? rawSeats.length : 4);
  final seats = List<Map<String, dynamic>?>.filled(maxPlayers, null);
  if (rawSeats is List) {
    for (var index = 0; index < rawSeats.length; index += 1) {
      final raw = rawSeats[index];
      if (raw is! Map) continue;
      final seat = _intValue(raw['seat']) ?? index;
      if (seat < 0 || seat >= seats.length) continue;
      final nested = raw['player'];
      if (nested is Map) {
        seats[seat] = {...Map<String, dynamic>.from(nested), 'seat': seat};
      } else if (raw['id'] != null || raw['playerId'] != null) {
        seats[seat] = {...Map<String, dynamic>.from(raw), 'seat': seat};
      }
    }
  }
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

int? _intValue(Object? value) => value is int ? value : null;

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

class ClubTab extends StatefulWidget {
  const ClubTab({required this.snapshot, super.key});

  final ClientSnapshot snapshot;

  @override
  State<ClubTab> createState() => _ClubTabState();
}

class _ClubTabState extends State<ClubTab> {
  int _floor = 0;
  bool _applicationSubmitted = false;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(14),
      child: Row(
        children: [
          SizedBox(
            width: 230,
            child: Column(
              children: [
                Card(
                  margin: EdgeInsets.zero,
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        const CircleAvatar(
                          radius: 30,
                          backgroundColor: Color(0xffffce68),
                          child: Icon(
                            Icons.groups_2,
                            color: Color(0xff17443b),
                            size: 32,
                          ),
                        ),
                        const SizedBox(height: 10),
                        const Text(
                          '宿松亲友圈',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.w900,
                          ),
                        ),
                        const Text(
                          'ID 827867 · 开发演示',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            color: Color(0xffb8cec7),
                            fontSize: 12,
                          ),
                        ),
                        const SizedBox(height: 12),
                        const Chip(
                          avatar: Icon(Icons.verified_user_outlined, size: 16),
                          label: Text('成员状态：已通过'),
                        ),
                        OutlinedButton.icon(
                          onPressed: () => _showApplication(context),
                          icon: const Icon(Icons.person_add_alt_1),
                          label: Text(
                            _applicationSubmitted ? '申请待审批' : '申请加入其他亲友圈',
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 10),
                Expanded(
                  child: Card(
                    margin: EdgeInsets.zero,
                    child: ListView(
                      children: [
                        const ListTile(
                          dense: true,
                          leading: Icon(Icons.layers_outlined),
                          title: Text('切换楼层'),
                        ),
                        for (var i = 0; i < 2; i++)
                          ListTile(
                            selected: _floor == i,
                            selectedTileColor: const Color(0x335fcab0),
                            leading: CircleAvatar(child: Text('${i + 1}')),
                            title: Text(i == 0 ? '宿松麻将' : '备用楼层'),
                            subtitle: Text(i == 0 ? '积分场 · 6 桌' : '暂未配置'),
                            onTap: () => setState(() => _floor = i),
                          ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: _floor == 0
                ? Column(
                    children: [
                      _ClubHeader(onDetails: () => _showFloor(context)),
                      const SizedBox(height: 12),
                      Expanded(
                        child: GridView.builder(
                          itemCount: 6,
                          gridDelegate:
                              const SliverGridDelegateWithFixedCrossAxisCount(
                                crossAxisCount: 3,
                                mainAxisSpacing: 10,
                                crossAxisSpacing: 10,
                                childAspectRatio: 1.7,
                              ),
                          itemBuilder: (context, index) => _ClubDesk(
                            number: index + 1,
                            occupied: index == 0,
                            onTap: () => ScaffoldMessenger.of(context)
                                .showSnackBar(
                                  SnackBar(
                                    content: Text(
                                      index == 0
                                          ? '1 号桌已有 1 位玩家'
                                          : '包厢开房将在俱乐部服务接入后启用',
                                    ),
                                  ),
                                ),
                          ),
                        ),
                      ),
                    ],
                  )
                : const _EmptyState(
                    icon: Icons.layers_clear_outlined,
                    title: '备用楼层尚未配置',
                    message: '管理员可在管理端新增楼层并配置固定规则。',
                  ),
          ),
        ],
      ),
    );
  }

  void _showApplication(BuildContext context) {
    showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('申请加入亲友圈'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const TextField(
              decoration: InputDecoration(
                labelText: '亲友圈 ID',
                prefixIcon: Icon(Icons.tag),
              ),
            ),
            const SizedBox(height: 12),
            const Text('提交后由亲友圈管理员审批，客户端不能自行通过。'),
            if (_applicationSubmitted)
              const Padding(
                padding: EdgeInsets.only(top: 10),
                child: Chip(
                  avatar: Icon(Icons.hourglass_top, size: 16),
                  label: Text('当前状态：待审批'),
                ),
              ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: _applicationSubmitted
                ? null
                : () {
                    setState(() => _applicationSubmitted = true);
                    Navigator.pop(context);
                  },
            child: const Text('提交申请'),
          ),
        ],
      ),
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
              Text('8 局 · 4 人 · 楼层开房规则一致'),
              SizedBox(height: 6),
              Text('采用参考 APK 8931 规则基线；未能从旧服务端恢复的叠加公式暂不启用。'),
            ],
          ),
        ),
      ),
    );
  }
}

class _ClubHeader extends StatelessWidget {
  const _ClubHeader({required this.onDetails});
  final VoidCallback onDetails;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
    decoration: BoxDecoration(
      color: const Color(0xdd173d37),
      borderRadius: BorderRadius.circular(16),
      border: Border.all(color: const Color(0x88efd58c)),
    ),
    child: Row(
      children: [
        const Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '1 楼 · 宿松麻将',
                style: TextStyle(
                  fontSize: 19,
                  color: Color(0xffffdc82),
                  fontWeight: FontWeight.w900,
                ),
              ),
              Text(
                '包厢模式：积分 · 在线 1/24',
                style: TextStyle(color: Color(0xffc2d7d1)),
              ),
            ],
          ),
        ),
        TextButton.icon(
          onPressed: onDetails,
          icon: const Icon(Icons.info_outline),
          label: const Text('规则详情'),
        ),
        const SizedBox(width: 8),
        FilledButton.tonalIcon(
          onPressed: null,
          icon: Icon(Icons.rocket_launch_outlined),
          label: Text('快速开始'),
        ),
      ],
    ),
  );
}

class _ClubDesk extends StatelessWidget {
  const _ClubDesk({
    required this.number,
    required this.occupied,
    required this.onTap,
  });
  final int number;
  final bool occupied;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Material(
    color: const Color(0xff245d51),
    borderRadius: BorderRadius.circular(18),
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(18),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 76,
              height: 44,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: const Color(0xff168c70),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: const Color(0xffffd46b), width: 2),
              ),
              child: Text(
                '$number',
                style: const TextStyle(
                  fontSize: 21,
                  fontWeight: FontWeight.w900,
                ),
              ),
            ),
            const SizedBox(height: 8),
            Text(
              occupied ? '1/4 人 · 等待中' : '空闲 · 点击进入',
              style: const TextStyle(fontSize: 12),
            ),
          ],
        ),
      ),
    ),
  );
}

String _susongConfigSummary(Object? value) {
  final config = value is Map ? value : const <String, dynamic>{};
  final rounds = config['rounds'] ?? 4;
  final tiers = config['scoreTiers'] is List
      ? (config['scoreTiers'] as List).join('/')
      : '1/2/3/4';
  final zeng = config['zeng'] ?? 1;
  final piao = config['piao'] == 'strong' ? '强飘' : '不强飘';
  final hu = config['forcedHu'] == true ? '必胡' : '不必胡';
  return '$rounds 局 · 底分 $tiers · 增 $zeng · $piao · $hu';
}

class HistoryTab extends StatelessWidget {
  const HistoryTab({required this.snapshot, super.key});

  final ClientSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(14),
      child: Row(
        children: [
          SizedBox(
            width: 240,
            child: Card(
              margin: EdgeInsets.zero,
              child: Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(
                      Icons.scoreboard_outlined,
                      size: 38,
                      color: Color(0xffffd369),
                    ),
                    const SizedBox(height: 14),
                    const Text(
                      '我的战绩',
                      style: TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    const SizedBox(height: 6),
                    const Text(
                      '积分仅表示每局输赢结果，不是余额，也不能充值或兑换。',
                      style: TextStyle(color: Color(0xffbed2cc)),
                    ),
                    const Spacer(),
                    Text(
                      '房间版本 ${snapshot.roomVersion < 0 ? '—' : snapshot.roomVersion}',
                    ),
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(width: 14),
          const Expanded(
            child: _EmptyState(
              icon: Icons.history_toggle_off,
              title: '暂无已完成牌局',
              message: '牌局结算后，这里将展示总分、单局明细与规则快照。',
            ),
          ),
        ],
      ),
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
        _controller.clear();
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('工单已提交')));
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
    final keyboardVisible = MediaQuery.viewInsetsOf(context).bottom > 0;
    return Padding(
      padding: EdgeInsets.all(keyboardVisible ? 4 : 14),
      child: Row(
        children: [
          if (!keyboardVisible) ...[
            const Expanded(
              flex: 4,
              child: Card(
                margin: EdgeInsets.zero,
                child: Padding(
                  padding: EdgeInsets.all(22),
                  child: SingleChildScrollView(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Icon(
                          Icons.support_agent,
                          size: 46,
                          color: Color(0xffffd369),
                        ),
                        SizedBox(height: 14),
                        Text(
                          '联系客服',
                          style: TextStyle(
                            fontSize: 24,
                            fontWeight: FontWeight.w900,
                          ),
                        ),
                        SizedBox(height: 8),
                        Text(
                          '提交问题时请写明房号、发生时间和具体操作。正式环境会自动关联账号与客户端版本。',
                          style: TextStyle(color: Color(0xffc0d6cf)),
                        ),
                        SizedBox(height: 20),
                        Text('P0 支持方式：应用内文字工单', style: TextStyle(fontSize: 12)),
                      ],
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 14),
          ],
          Expanded(
            flex: keyboardVisible ? 1 : 6,
            child: Card(
              margin: EdgeInsets.zero,
              child: Padding(
                padding: EdgeInsets.all(keyboardVisible ? 6 : 18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _controller,
                        maxLines: null,
                        expands: true,
                        maxLength: 500,
                        buildCounter: keyboardVisible
                            ? (
                                context, {
                                required currentLength,
                                required isFocused,
                                required maxLength,
                              }) => const SizedBox.shrink()
                            : null,
                        style: const TextStyle(color: Color(0xff173d35)),
                        decoration: const InputDecoration(
                          labelText: '请描述遇到的问题',
                          alignLabelWithHint: true,
                          prefixIcon: Icon(Icons.chat_bubble_outline),
                        ),
                      ),
                    ),
                    SizedBox(height: keyboardVisible ? 2 : 8),
                    FilledButton.icon(
                      onPressed: _submit,
                      style: keyboardVisible
                          ? FilledButton.styleFrom(
                              visualDensity: VisualDensity.compact,
                            )
                          : null,
                      icon: const Icon(Icons.send),
                      label: Text(_submitting ? '提交中' : '提交工单'),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class SettingsTab extends StatefulWidget {
  const SettingsTab({required this.onLogout, super.key});
  final VoidCallback onLogout;
  @override
  State<SettingsTab> createState() => _SettingsTabState();
}

class _SettingsTabState extends State<SettingsTab> {
  bool _music = true;
  bool _sound = true;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(14),
    child: Row(
      children: [
        const SizedBox(
          width: 240,
          child: Card(
            margin: EdgeInsets.zero,
            child: Padding(
              padding: EdgeInsets.all(22),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    Icons.settings_outlined,
                    size: 44,
                    color: Color(0xffffd369),
                  ),
                  SizedBox(height: 14),
                  Text(
                    '设置',
                    style: TextStyle(fontSize: 24, fontWeight: FontWeight.w900),
                  ),
                  SizedBox(height: 8),
                  Text(
                    '当前版本 1.0.0 P0\nAndroid / iOS 横屏模式',
                    style: TextStyle(color: Color(0xffbfd4ce)),
                  ),
                  Spacer(),
                  Text('不包含充值、提现、兑换或转赠能力', style: TextStyle(fontSize: 12)),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(width: 14),
        Expanded(
          child: Card(
            margin: EdgeInsets.zero,
            child: ListView(
              padding: const EdgeInsets.all(12),
              children: [
                SwitchListTile(
                  value: _music,
                  onChanged: (value) => setState(() => _music = value),
                  secondary: const Icon(Icons.music_note_outlined),
                  title: const Text('背景音乐'),
                ),
                SwitchListTile(
                  value: _sound,
                  onChanged: (value) => setState(() => _sound = value),
                  secondary: const Icon(Icons.volume_up_outlined),
                  title: const Text('游戏音效'),
                ),
                const ListTile(
                  leading: Icon(Icons.screen_rotation_outlined),
                  title: Text('屏幕方向'),
                  subtitle: Text('已锁定横屏，支持左右旋转'),
                ),
                const ListTile(
                  leading: Icon(Icons.privacy_tip_outlined),
                  title: Text('隐私与权限'),
                  subtitle: Text('首版不申请通讯录、后台定位或后台录音权限'),
                ),
                const Divider(),
                ListTile(
                  leading: const Icon(Icons.logout),
                  title: const Text('退出登录'),
                  onTap: widget.onLogout,
                ),
              ],
            ),
          ),
        ),
      ],
    ),
  );
}

class _GameBackdrop extends StatelessWidget {
  const _GameBackdrop({required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) => DecoratedBox(
    decoration: const BoxDecoration(
      gradient: LinearGradient(
        colors: [Color(0xff0a5c50), Color(0xff073b35), Color(0xff102f2c)],
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
      ),
    ),
    child: Stack(
      fit: StackFit.expand,
      children: [
        Positioned(
          right: -100,
          top: -130,
          child: Container(
            width: 420,
            height: 420,
            decoration: const BoxDecoration(
              shape: BoxShape.circle,
              color: Color(0x0fffd76b),
            ),
          ),
        ),
        Positioned(
          left: -120,
          bottom: -160,
          child: Container(
            width: 460,
            height: 460,
            decoration: const BoxDecoration(
              shape: BoxShape.circle,
              color: Color(0x1028b89b),
            ),
          ),
        ),
        child,
      ],
    ),
  );
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
    return LayoutBuilder(
      builder: (context, constraints) {
        final compact = constraints.maxHeight < 150;
        return Card(
          child: Padding(
            padding: EdgeInsets.all(compact ? 12 : 26),
            child: compact
                ? Row(
                    children: [
                      Icon(icon, size: 34),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: Theme.of(context).textTheme.titleMedium,
                            ),
                            const SizedBox(height: 3),
                            Text(
                              message,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ],
                        ),
                      ),
                    ],
                  )
                : Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(icon, size: 42),
                      const SizedBox(height: 10),
                      Text(
                        title,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 4),
                      Text(message, textAlign: TextAlign.center),
                    ],
                  ),
          ),
        );
      },
    );
  }
}
