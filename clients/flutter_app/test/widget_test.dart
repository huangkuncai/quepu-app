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

    expect(find.text('创建演示房'), findsOneWidget);
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
    expect(find.text('创建演示房'), findsOneWidget);
    expect(find.text('俱乐部'), findsOneWidget);
    expect(find.text('战绩'), findsOneWidget);
    expect(find.text('客服'), findsOneWidget);
    expect(find.text('设置'), findsOneWidget);
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
    expect(find.text('已记录到演示工单'), findsOneWidget);
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
    expect(find.text('已记录到演示工单'), findsOneWidget);
  });

  testWidgets('room page renders seats and ready state', (tester) async {
    await tester.pumpWidget(const SusongApp());
    await tester.tap(find.text('进入大厅'));
    await tester.pump(const Duration(milliseconds: 180));
    await tester.tap(find.text('创建演示房'));
    await tester.pumpAndSettle();
    expect(find.text('创建宿松麻将房'), findsOneWidget);
    expect(find.textContaining('小胡 / 大胡 / 大大胡 / 一索'), findsOneWidget);
    await tester.tap(find.text('确认创建'));
    await tester.pump(const Duration(milliseconds: 80));
    await tester.tap(find.text('进入牌桌'));
    await tester.pumpAndSettle();

    expect(find.text('房间 demo-room'), findsOneWidget);
    expect(find.text('座位 1'), findsOneWidget);
    expect(find.text('座位 4'), findsOneWidget);
    await tester.drag(find.byType(ListView).last, const Offset(0, -420));
    await tester.pump();
    expect(find.text('加入房间'), findsOneWidget);

    await tester.tap(find.text('加入房间'));
    await tester.pump(const Duration(milliseconds: 80));
    expect(find.text('准备'), findsOneWidget);
    await tester.tap(find.text('准备'));
    await tester.pump(const Duration(milliseconds: 80));
    expect(find.text('取消准备'), findsOneWidget);
    await tester.drag(find.byType(ListView).last, const Offset(0, 420));
    await tester.pump();
    expect(find.text('准备 1/4'), findsOneWidget);
  });

  testWidgets(
    'room table renders server-owned hand and submits selected tile',
    (tester) async {
      final transport = FakeTransport();
      await tester.pumpWidget(SusongApp(transport: transport));
      await tester.tap(find.text('进入大厅'));
      await tester.pump(const Duration(milliseconds: 180));
      await tester.tap(find.text('创建演示房'));
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
                'seat': 0,
                'ready': true,
                'connected': true,
              },
            ],
            'round': {
              'roundNumber': 2,
              'turnPhase': 'discard',
              'turnDeadlineAt': DateTime.now()
                  .add(const Duration(seconds: 20))
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

      expect(find.text('1万'), findsOneWidget);
      expect(find.text('9条'), findsOneWidget);
      expect(find.text('暗杠 东'), findsOneWidget);
      expect(find.text('第 2/8 局'), findsOneWidget);
      expect(find.text('剩余 63 张'), findsOneWidget);
      expect(find.textContaining('待出牌'), findsOneWidget);
      expect(find.textContaining('演示玩家 · 花 4'), findsOneWidget);
      expect(find.textContaining('副露 碰东东东'), findsOneWidget);
      expect(find.textContaining('弃牌 3筒 白'), findsOneWidget);
      await tester.tap(find.text('1万'));
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
    await tester.tap(find.text('创建演示房'));
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
              ],
            },
          },
        },
      },
      'occurredAt': DateTime.now().toUtc().toIso8601String(),
    });
    await tester.pump(const Duration(milliseconds: 80));

    expect(find.text('单局结算 · 自摸'), findsOneWidget);
    expect(find.text('服务端计分明细'), findsOneWidget);
    expect(find.text('zeng-piao-flower-sanxi-v1'), findsOneWidget);
    expect(find.textContaining('演示玩家 一索/封顶 / 4 花 / 杠开×1 / 七对'), findsOneWidget);
    expect(find.text('+45'), findsOneWidget);
    expect(find.text('-15'), findsOneWidget);
    expect(find.textContaining('玩家B → 演示玩家  15 分'), findsOneWidget);
    expect(find.textContaining('赢家增 4  →  付款家增 6'), findsOneWidget);
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
