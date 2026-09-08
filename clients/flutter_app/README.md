# 宿松麻将 Flutter POC 壳

这是 G1 的 Flutter 候选壳。默认使用 `FakeTransport` 离线演示，也可通过 `SUSONG_WSS_URL` 连接隔离的开发 WSS，用于验证共享 Dart 协议消费层、登录、大厅、房号加入、牌桌、断线同步、俱乐部楼层占位、战绩占位和纯文本客服。

## 本机验证

```bash
flutter pub get
flutter test
flutter build web --release
```

真实开发链路运行方式见 [协议消费说明](../../docs/client/PROTOCOL_CONSUMER.md)。仓库根目录执行 `npm run verify:client-real`，可自动启动内存 Node 服务并用四个真实 `dart:io` WebSocket 客户端验证登录、建房/房号加入、准备、发牌、公共状态收敛、私牌隔离和新客户端重连恢复。

当前环境若没有 Android SDK 或完整 Xcode，不能把本项目的 Web/桌面测试结果写成 Android、iOS 或 HarmonyOS 真机通过。正式 WSS、平台安全存储、推送、签名和 HarmonyOS HAP 适配仍由 `DEC-011` 与 G1 真机验收决定。

## 边界

- 验证码仅为开发期 `000000`；不接入正式短信供应商。
- Fake 网关不实现宿松麻将裁判、积分结算或钻石账本。
- 客户端没有充值、支付、提现、现金兑换或转赠路由/SDK。
- 业务 UI 依赖 `clients/dart_protocol`，平台能力必须通过独立 adapter 注入。
