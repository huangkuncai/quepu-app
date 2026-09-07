import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:susong_app/main.dart';
import 'package:susong_app/src/fake_transport.dart';
import 'package:susong_protocol_client/support.dart';

void main() {
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
