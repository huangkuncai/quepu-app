import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:susong_app/main.dart';
import 'package:susong_app/src/fake_transport.dart';
import 'package:susong_protocol_client/support.dart';

void main() {
  testWidgets('lobby fits a compact landscape phone viewport', (tester) async {
    tester.view.physicalSize = const Size(2400, 1080);
    tester.view.devicePixelRatio = 2.625;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(const SusongApp());
    await tester.tap(find.text('进入大厅'));
    await tester.pump(const Duration(milliseconds: 180));

    expect(find.text('创建房间'), findsOneWidget);
    expect(find.text('还没有进行中的房间'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('POC login exposes the lobby and room controls', (tester) async {
    await tester.pumpWidget(const SusongApp());
    expect(find.text('宿松麻将'), findsOneWidget);
    expect(find.text('进入大厅'), findsOneWidget);

    await tester.tap(find.text('进入大厅'));
    await tester.pump(const Duration(milliseconds: 80));
    await tester.pump(const Duration(milliseconds: 80));

    expect(find.text('大厅'), findsWidgets);
    expect(find.text('创建房间'), findsOneWidget);
    expect(find.text('俱乐部'), findsOneWidget);
    expect(find.text('战绩'), findsOneWidget);
    expect(find.text('客服'), findsOneWidget);
    expect(find.text('设置'), findsOneWidget);
  });

  testWidgets('lobby joins a shared room by entered room code', (tester) async {
    final transport = FakeTransport();
    await tester.pumpWidget(SusongApp(transport: transport));
    await tester.tap(find.text('进入大厅'));
    await tester.pump(const Duration(milliseconds: 180));

    await tester.tap(find.text('加入房间'));
    await tester.pumpAndSettle();
    expect(find.text('请输入房主分享的房号'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'demo-room');
    await tester.tap(find.text('确认加入'));
    await tester.pump(const Duration(milliseconds: 80));

    final command = transport.sentMessages.lastWhere(
      (message) => message['type'] == 'join_room',
    );
    expect(command['roomId'], 'demo-room');
  });

  testWidgets('bot demo seats three robots and opens a playable table', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1542, 686);
    tester.view.devicePixelRatio = 1.5;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final transport = FakeTransport();
    await tester.pumpWidget(SusongApp(transport: transport));
    await tester.tap(find.text('进入大厅'));
    await tester.pump(const Duration(milliseconds: 180));

    expect(find.text('机器人'), findsOneWidget);
    await tester.tap(find.text('机器人'));
    await tester.pump(const Duration(milliseconds: 80));
    await tester.pump(const Duration(milliseconds: 80));
    await tester.pump(const Duration(milliseconds: 320));

    expect(find.text('房间 demo-room'), findsOneWidget);
    expect(find.text('演示玩家'), findsWidgets);
    expect(find.text('小松机器人'), findsWidgets);
    expect(find.text('小竹机器人'), findsWidgets);
    expect(find.text('小菊机器人'), findsWidgets);
    expect(find.text('已准备'), findsWidgets);
    expect(find.text('在线 4/4'), findsOneWidget);
    expect(find.text('准备 4/4'), findsOneWidget);
    expect(find.text('牌桌操作'), findsNothing);
    expect(find.textContaining('已准备'), findsWidgets);
    expect(find.text('先选择出增数量'), findsOneWidget);
    expect(find.text('开始'), findsNothing);
    expect(find.bySemanticsLabel('1万'), findsNothing);
    expect(find.text('增2'), findsOneWidget);
    await tester.tap(find.text('增2'));
    await tester.pump(const Duration(milliseconds: 80));
    expect(find.text('进行中'), findsOneWidget);
    expect(find.text('庄'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp('东南西北方位 当前方位 北')), findsOneWidget);
    expect(find.text('飘花'), findsOneWidget);
    expect(find.text('不飘·补花'), findsOneWidget);
    expect(find.text('过'), findsNothing);
    await tester.tap(find.text('不飘·补花'));
    await tester.pump(const Duration(milliseconds: 80));
    expect(find.text('进行中'), findsOneWidget);
    expect(find.bySemanticsLabel('春'), findsWidgets);
    expect(find.bySemanticsLabel('梅'), findsWidgets);
    expect(find.bySemanticsLabel('中'), findsWidgets);
    expect(find.bySemanticsLabel('发'), findsWidgets);
    expect(find.bySemanticsLabel('白'), findsWidgets);
    expect(find.text('请点击手牌出牌'), findsNothing);
    expect(find.text('自摸'), findsOneWidget);
    expect(find.textContaining('剩余 78 张'), findsOneWidget);
    expect(find.bySemanticsLabel('暗牌'), findsNWidgets(39));
    expect(find.bySemanticsLabel('1万'), findsWidgets);
    expect(
      tester.getCenter(find.bySemanticsLabel('7万').last).dx,
      lessThan(tester.getCenter(find.bySemanticsLabel('2条').last).dx),
    );
    expect(
      tester.getCenter(find.bySemanticsLabel('2条').last).dx,
      lessThan(tester.getCenter(find.bySemanticsLabel('1筒').last).dx),
    );
    await tester.tap(find.bySemanticsLabel('1万').last);
    await tester.pump(const Duration(milliseconds: 80));
    expect(find.bySemanticsLabel(RegExp('听牌提示')), findsOneWidget);
    expect(find.text('吃'), findsOneWidget);
    expect(find.textContaining('·上家'), findsNothing);
    expect(find.textContaining('·对家'), findsNothing);
    expect(find.byIcon(Icons.arrow_upward_rounded), findsWidgets);
    expect(find.text('过'), findsOneWidget);
    expect(find.textContaining('弃牌'), findsNothing);
    tester.view.devicePixelRatio = 1;
    for (final size in const [
      Size(844, 390),
      Size(1024, 768),
      Size(1366, 768),
    ]) {
      tester.view.physicalSize = size;
      await tester.pump();
      expect(find.bySemanticsLabel(RegExp('自适应牌桌')), findsOneWidget);
      expect(tester.takeException(), isNull, reason: 'viewport $size');
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('P0 club exposes floors, desks and approval-only application', (
    tester,
  ) async {
    await tester.pumpWidget(const SusongApp());
    await tester.tap(find.text('进入大厅'));
    await tester.pump(const Duration(milliseconds: 180));
    await tester.tap(find.text('俱乐部').last);
    await tester.pump();

    expect(find.text('成员状态：已通过'), findsOneWidget);
    expect(find.text('1 楼 · 宿松麻将'), findsOneWidget);
    expect(find.text('空闲 · 点击进入'), findsNWidgets(5));

    await tester.tap(find.text('申请加入其他亲友圈'));
    await tester.pumpAndSettle();
    expect(find.textContaining('客户端不能自行通过'), findsOneWidget);
    await tester.tap(find.text('提交申请'));
    await tester.pumpAndSettle();
    expect(find.text('申请待审批'), findsOneWidget);
  });

  testWidgets('support tab accepts a plain text ticket', (tester) async {
    await tester.pumpWidget(const SusongApp());
    await tester.tap(find.text('进入大厅'));
    await tester.pump(const Duration(milliseconds: 180));
    await tester.tap(find.text('客服').last);
    await tester.pump();
    await tester.enterText(find.byType(TextField), '无法进入房间');
    await tester.tap(find.text('提交工单'));
    await tester.pump();
    expect(find.text('工单已提交'), findsOneWidget);
  });

  testWidgets('support tab uses the injected REST API port', (tester) async {
    var calls = 0;
    final api = SupportApi((method, path, body, key) async {
      calls += 1;
      expect(method, 'POST');
      expect(path, '/support/tickets');
      expect(body['message'], 'REST 联调');
      expect(key, isNotEmpty);
      return {
        'data': {
          'id': 'ticket-1',
          'status': 'OPEN',
          'subject': '客户端问题',
          'messageCount': 1,
        },
      };
    });
    await tester.pumpWidget(SusongApp(supportApi: api));
    await tester.tap(find.text('进入大厅'));
    await tester.pump(const Duration(milliseconds: 180));
    await tester.tap(find.text('客服').last);
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'REST 联调');
    await tester.tap(find.text('提交工单'));
    await tester.pump();
    expect(calls, 1);
    expect(find.text('工单已提交'), findsOneWidget);
  });

  testWidgets('room page renders seats and ready state', (tester) async {
    tester.view.physicalSize = const Size(1386, 686);
    tester.view.devicePixelRatio = 1.5;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(const SusongApp());
    await tester.tap(find.text('进入大厅'));
    await tester.pump(const Duration(milliseconds: 180));
    await tester.tap(find.text('创建房间'));
    await tester.pumpAndSettle();
    expect(find.text('创建宿松麻将房'), findsOneWidget);
    expect(find.textContaining('小胡 / 大胡 / 大大胡 / 一索'), findsOneWidget);
    await tester.tap(find.text('确认创建'));
    await tester.pump(const Duration(milliseconds: 80));
    await tester.tap(find.text('进入牌桌'));
    await tester.pumpAndSettle();

    expect(find.text('房间 demo-room'), findsOneWidget);
    expect(find.text('等待加入'), findsNWidgets(4));
    expect(find.text('加入房间'), findsOneWidget);

    await tester.tap(find.text('加入房间'));
    await tester.pump(const Duration(milliseconds: 80));
    expect(find.text('演示玩家'), findsOneWidget);
    expect(find.text('空位'), findsNWidgets(3));
    expect(find.text('准备'), findsOneWidget);
    await tester.tap(find.text('准备'));
    await tester.pump(const Duration(milliseconds: 80));
    expect(find.text('取消准备'), findsOneWidget);
    expect(find.text('准备 1/4'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'room table renders server-owned hand and submits selected tile',
    (tester) async {
      tester.view.physicalSize = const Size(1024, 600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final transport = FakeTransport();
      await tester.pumpWidget(SusongApp(transport: transport));
      await tester.tap(find.text('进入大厅'));
      await tester.pump(const Duration(milliseconds: 180));
      await tester.tap(find.text('创建房间'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('确认创建'));
      await tester.pump(const Duration(milliseconds: 80));
      await tester.tap(find.text('进入牌桌'));
      await tester.pumpAndSettle();

      transport.inject({
        'protocolVersion': '1.0',
        'type': 'room_event',
        'eventId': '11111111-1111-4111-8111-111111111111',
        'roomId': 'demo-room',
        'roomVersion': 1,
        'payload': {
          'snapshot': {
            'id': 'demo-room',
            'roomId': 'demo-room',
            'ownerId': 'poc-user',
            'status': 'playing',
            'maxPlayers': 4,
            'roundNumber': 2,
            'totalRounds': 8,
            'turnPlayerId': 'poc-user',
            'players': [
              {
                'id': 'poc-user',
                'displayName': '演示玩家',
                'ready': true,
                'connected': true,
              },
            ],
            'seats': [
              {
                'seat': 0,
                'player': {
                  'id': 'poc-user',
                  'displayName': '演示玩家',
                  'ready': true,
                  'connected': true,
                },
              },
              {'seat': 1, 'player': null},
              {'seat': 2, 'player': null},
              {'seat': 3, 'player': null},
            ],
            'round': {
              'roundNumber': 2,
              'turnPhase': 'discard',
              'turnDeadlineAt': DateTime.now()
                  .subtract(const Duration(seconds: 1))
                  .toUtc()
                  .toIso8601String(),
              'wall': {'wallRemaining': 63},
              'discardsByPlayer': {
                'poc-user': ['dots-3-1', 'white_dragon-1'],
              },
              'meldsByPlayer': {
                'poc-user': [
                  {
                    'action': 'peng',
                    'tileIds': ['east-1', 'east-2', 'east-3'],
                  },
                ],
              },
              'flowerStates': {
                'poc-user': {'status': 'not_piao', 'countedFlowers': 4},
              },
              'flowerTilesByPlayer': {
                'poc-user': ['red_dragon'],
              },
              'discardedFlowerTilesByPlayer': {
                'poc-user': ['red_dragon'],
              },
              'privateHand': ['characters-1-1', 'bamboo-9-2', 'east-1'],
              'availableActions': ['discard', 'concealed_kong'],
              'kongOptions': {
                'concealed_kong': [
                  {'candidateIndex': 0, 'face': 'east'},
                ],
              },
            },
          },
        },
        'occurredAt': DateTime.now().toUtc().toIso8601String(),
      });
      await tester.pump(const Duration(milliseconds: 80));

      expect(find.bySemanticsLabel('1万'), findsWidgets);
      expect(find.bySemanticsLabel('9条'), findsOneWidget);
      expect(find.text('暗杠 东'), findsOneWidget);
      expect(find.textContaining('第 2/8 局'), findsOneWidget);
      expect(find.textContaining('剩余 63 张'), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp('东南西北方位')), findsOneWidget);
      expect(find.text('演示玩家'), findsOneWidget);
      expect(find.text('0 分'), findsOneWidget);
      expect(find.text('空位'), findsNWidgets(3));
      expect(find.text('碰'), findsNothing);
      expect(find.bySemanticsLabel('东'), findsAtLeastNWidgets(3));
      expect(
        find.byKey(const ValueKey('river-poc-user-0-dots-3-1')),
        findsOneWidget,
      );
      expect(find.bySemanticsLabel(RegExp('牌河 3筒 白 中')), findsOneWidget);
      expect(find.textContaining('弃牌'), findsNothing);
      await tester.pump(const Duration(seconds: 2));
      expect(find.bySemanticsLabel(RegExp('东南西北方位.*倒计时 0 秒')), findsOneWidget);
      await tester.tap(find.bySemanticsLabel('1万').last);
      await tester.pump(const Duration(milliseconds: 30));
      final action = transport.sentMessages.lastWhere(
        (message) => message['type'] == 'action',
      );
      expect(action['payload'], {
        'action': 'discard',
        'args': {'tileId': 'characters-1-1'},
      });
    },
  );

  testWidgets('settlement page renders only server-provided totals and trace', (
    tester,
  ) async {
    final transport = FakeTransport();
    await tester.pumpWidget(SusongApp(transport: transport));
    await tester.tap(find.text('进入大厅'));
    await tester.pump(const Duration(milliseconds: 180));
    await tester.tap(find.text('创建房间'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('确认创建'));
    await tester.pump(const Duration(milliseconds: 80));
    await tester.tap(find.text('进入牌桌'));
    await tester.pumpAndSettle();

    Map<String, dynamic> transfer(String from, int amount, int payerZeng) => {
      'from': from,
      'to': 'poc-user',
      'amount': amount,
      'tier': 'small',
      'scoreOrderVersion': 'zeng-piao-flower-sanxi-v1',
      'trace': [
        {'stage': 'winner_zeng', 'value': 4},
        {'stage': 'payer_zeng', 'value': payerZeng},
        {'stage': 'piao', 'status': 'not_piao', 'value': 0},
        {'stage': 'flower_tier', 'value': 5},
        {'stage': 'sanxi', 'multiplier': 1, 'value': amount},
      ],
    };

    transport.inject({
      'protocolVersion': '1.0',
      'type': 'room_event',
      'eventId': '22222222-2222-4222-8222-222222222222',
      'roomId': 'demo-room',
      'roomVersion': 1,
      'payload': {
        'snapshot': {
          'id': 'demo-room',
          'roomId': 'demo-room',
          'ownerId': 'poc-user',
          'status': 'settling',
          'maxPlayers': 4,
          'connectedCount': 4,
          'roundNumber': 1,
          'totalRounds': 8,
          'players': [
            {
              'id': 'poc-user',
              'displayName': '演示玩家',
              'seat': 0,
              'connected': true,
            },
            {'id': 'B', 'displayName': '玩家B', 'seat': 1, 'connected': true},
            {'id': 'C', 'displayName': '玩家C', 'seat': 2, 'connected': true},
            {'id': 'D', 'displayName': '玩家D', 'seat': 3, 'connected': true},
          ],
          'scores': {'poc-user': 45, 'B': -15, 'C': -11, 'D': -19},
          'round': {
            'roundNumber': 1,
            'settlement': {
              'scoreAuthority': 'server',
              'scoreOrderVersion': 'zeng-piao-flower-sanxi-v1',
              'outcome': 'self_draw',
              'wins': [
                {
                  'winnerId': 'poc-user',
                  'flowerCount': 4,
                  'tier': 'one_bamboo',
                  'piao': false,
                  'cappedByNoFlowerSelfDraw': false,
                  'patterns': ['seven_pairs'],
                  'gangWinCount': 1,
                },
              ],
              'deltaByPlayer': {'poc-user': 45, 'B': -15, 'C': -11, 'D': -19},
              'transfers': [
                transfer('B', 15, 6),
                transfer('C', 11, 2),
                transfer('D', 19, 10),
                {
                  'kind': 'flower_award',
                  'from': 'B',
                  'to': 'poc-user',
                  'amount': 12,
                  'scoreOrderVersion': 'zeng-piao-flower-sanxi-v1',
                  'trace': [
                    {
                      'stage': 'flower_award',
                      'count': 2,
                      'unit': 6,
                      'value': 12,
                    },
                  ],
                },
              ],
            },
          },
        },
      },
      'occurredAt': DateTime.now().toUtc().toIso8601String(),
    });
    await tester.pump(const Duration(milliseconds: 80));

    expect(find.text('第 1 局结算 · 自摸'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp('自己结算行')), findsOneWidget);
    expect(find.text('自摸'), findsOneWidget);
    expect(find.textContaining('4 朵花'), findsWidgets);
    expect(find.textContaining('一索/封顶'), findsOneWidget);
    expect(find.text('+45'), findsOneWidget);
    expect(find.text('-15'), findsOneWidget);
    expect(find.text('继续游戏'), findsOneWidget);
    await tester.tap(find.text('继续游戏'));
    await tester.pump(const Duration(milliseconds: 30));
    final nextRound = transport.sentMessages.lastWhere(
      (message) => message['type'] == 'next_round',
    );
    expect(nextRound['payload'], {'autoDeal': false});
    expect(nextRound['roomVersion'], 1);

    transport.inject({
      'protocolVersion': '1.0',
      'type': 'room_event',
      'eventId': '33333333-3333-4333-8333-333333333333',
      'roomId': 'demo-room',
      'roomVersion': 2,
      'visibility': 'player',
      'payload': {
        'snapshot': {
          'id': 'demo-room',
          'ownerId': 'poc-user',
          'status': 'finished',
          'maxPlayers': 4,
          'connectedCount': 4,
          'totalRounds': 1,
          'players': [
            {'id': 'poc-user', 'displayName': '演示玩家', 'seat': 0},
            {'id': 'B', 'displayName': '玩家B', 'seat': 1},
            {'id': 'C', 'displayName': '玩家C', 'seat': 2},
            {'id': 'D', 'displayName': '玩家D', 'seat': 3},
          ],
          'scores': {'poc-user': 45, 'B': -15, 'C': -11, 'D': -19},
          'round': {
            'roundNumber': 1,
            'settlement': {
              'outcome': 'self_draw',
              'deltaByPlayer': {'poc-user': 45, 'B': -15, 'C': -11, 'D': -19},
              'wins': <Object?>[],
              'transfers': <Object?>[],
            },
          },
        },
      },
      'occurredAt': DateTime.now().toUtc().toIso8601String(),
    });
    await tester.pump(const Duration(milliseconds: 80));
    expect(find.text('牌局结束 · 1 局'), findsOneWidget);
    expect(find.text('总成绩'), findsNWidgets(4));
    expect(find.text('自摸次数'), findsNWidgets(4));
    expect(find.text('继续游戏'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('strong-piao opening controls send only player choices', (
    tester,
  ) async {
    final transport = FakeTransport();
    await tester.pumpWidget(SusongApp(transport: transport));
    await tester.tap(find.text('进入大厅'));
    await tester.pump(const Duration(milliseconds: 180));
    await tester.tap(find.text('创建房间'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('确认创建'));
    await tester.pump(const Duration(milliseconds: 80));
    await tester.tap(find.text('进入牌桌'));
    await tester.pumpAndSettle();

    Map<String, dynamic> snapshot(Map<String, dynamic> flowerState) {
      final playing = flowerState['status'] == 'piao';
      return {
        'id': 'demo-room',
        'roomId': 'demo-room',
        'ownerId': 'poc-user',
        'status': playing ? 'playing' : 'dealing',
        'turnPlayerId': playing ? 'poc-user' : null,
        'maxPlayers': 4,
        'players': [
          {
            'id': 'poc-user',
            'displayName': '演示玩家',
            'seat': 0,
            'connected': true,
          },
        ],
        'round': {
          'roundNumber': 1,
          'turnPhase': playing ? 'discard' : null,
          'flowerStates': {'poc-user': flowerState},
          if (playing) ...{
            'privateHand': ['red_dragon-1', 'characters-1-1'],
            'availableActions': ['discard'],
            'discardsByPlayer': {'poc-user': <String>[]},
            'wall': {'wallRemaining': 83},
          },
        },
      };
    }

    void inject(int version, Map<String, dynamic> flowerState) {
      transport.inject({
        'protocolVersion': '1.0',
        'type': 'room_event',
        'eventId':
            '33333333-3333-4333-8333-${version.toString().padLeft(12, '0')}',
        'roomId': 'demo-room',
        'roomVersion': version,
        'payload': {'snapshot': snapshot(flowerState)},
        'occurredAt': DateTime.now().toUtc().toIso8601String(),
      });
    }

    inject(1, {'status': 'awaiting_piao_choice', 'pendingFlowerDiscards': 2});
    await tester.pump(const Duration(milliseconds: 80));
    expect(find.text('飘花'), findsOneWidget);
    expect(find.text('不飘·补花'), findsOneWidget);

    inject(2, {'status': 'piao', 'pendingFlowerDiscards': 0});
    await tester.pump(const Duration(milliseconds: 80));
    expect(find.textContaining('打花'), findsNothing);
    expect(find.text('手中有花，请先打一张花'), findsOneWidget);
    final messagesBeforeOrdinaryTap = transport.sentMessages.length;
    await tester.tap(find.bySemanticsLabel('1万'));
    await tester.pump(const Duration(milliseconds: 30));
    expect(transport.sentMessages, hasLength(messagesBeforeOrdinaryTap));
    expect(find.bySemanticsLabel('中'), findsOneWidget);
    await tester.tap(find.bySemanticsLabel('中'));
    await tester.pump(const Duration(milliseconds: 30));
    final discard = transport.sentMessages.lastWhere(
      (message) => message['type'] == 'action',
    );
    expect(discard['payload'], {
      'action': 'discard',
      'args': {'tileId': 'red_dragon-1'},
    });
    final passiveSnapshot = snapshot({'status': 'piao'});
    final passiveRound = passiveSnapshot['round'] as Map<String, dynamic>;
    passiveRound['availableActions'] = <String>[];
    passiveRound['availableReactions'] = ['pass'];
    transport.inject({
      'protocolVersion': '1.0',
      'type': 'room_event',
      'eventId': '33333333-3333-4333-8333-000000000003',
      'roomId': 'demo-room',
      'roomVersion': 3,
      'payload': {'snapshot': passiveSnapshot},
      'occurredAt': DateTime.now().toUtc().toIso8601String(),
    });
    await tester.pump(const Duration(milliseconds: 80));
    expect(find.text('过'), findsNothing);
    final automaticPass = transport.sentMessages.lastWhere(
      (message) =>
          message['type'] == 'action' &&
          (message['payload'] as Map?)?['action'] == 'pass',
    );
    expect(automaticPass['payload'], {'action': 'pass'});
    await tester.pump(const Duration(milliseconds: 30));
    expect(tester.takeException(), isNull);
  });

  testWidgets('connection card exposes safe disconnect and maintenance retry', (
    tester,
  ) async {
    final transport = FakeTransport();
    await tester.pumpWidget(SusongApp(transport: transport));
    await tester.tap(find.text('进入大厅'));
    await tester.pump(const Duration(milliseconds: 180));

    // Drive the transport hook directly; the button itself is deliberately
    // below the fold on a phone-sized test viewport.
    transport.simulateDisconnect();
    await tester.pump();
    expect(find.text('连接状态：已断开'), findsOneWidget);
    expect(find.text('重新连接'), findsOneWidget);

    await tester.tap(find.text('重新连接'));
    await tester.pump(const Duration(milliseconds: 180));
    expect(find.text('连接状态：在线'), findsOneWidget);

    transport.simulateMaintenance();
    await tester.pump();
    expect(find.text('连接状态：维护中'), findsOneWidget);
    expect(find.text('维护结束后重试'), findsOneWidget);
    expect(find.textContaining('牌局状态不会丢失'), findsOneWidget);

    await tester.tap(find.text('维护结束后重试'));
    await tester.pump(const Duration(milliseconds: 180));
    expect(find.text('连接状态：在线'), findsOneWidget);
  });
}
