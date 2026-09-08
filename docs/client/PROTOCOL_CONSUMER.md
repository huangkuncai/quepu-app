# CL-101/103 协议消费与连接核心（POC）

`clients/dart_protocol` 是不依赖 Flutter、ArkUI 或平台插件的 Dart 消费层。它现在包含 `protocol.dart` 的 envelope/reducer 和 `client.dart` 的会话控制器，验证四件事：

- command/event envelope 的版本、UUID、未知字段和 payload 基础校验；
- `roomVersion` 重复/乱序/缺口检测，缺口只触发 sync，不由客户端自行补事件；
- 连接状态 `DISCONNECTED -> CONNECTING -> AUTHENTICATING -> SYNCING -> ONLINE`、退避和维护态。
- 传输接口、登录/刷新/退出、命令 outbox、ACK 清理、断线后的重新鉴权和房间同步；token 只保存在控制器内部。
- 原生 `IoWebSocketTransport`（`dart:io`）支持 Android/iOS 等 native runtime 的 WSS 收发、请求头、非法帧关闭、并发连接去重和关闭竞态；Web 构建仍需单独 transport adapter。

运行：

```bash
cd clients/dart_protocol
dart run tool/test.dart
dart run tool/io_transport_test.dart

# 仓库根目录：真实 Node + 四个 dart:io WSS 客户端
cd ../..
npm run verify:client-real
```

Flutter 壳的 mock 联调与回归：

```bash
cd clients/flutter_app
flutter pub get
flutter test
flutter build web --release
```

Flutter 壳默认使用 `FakeTransport` 保留离线演示。Android 模拟器可用构建参数切换到本机开发 WSS：

```bash
# 终端 1：仓库根目录，仅启动开发服务
AUTH_MODE=stub FEATURE_REAL_RULES=false FEATURE_REAL_DIAMONDS=false npm start

# 终端 2：Android Emulator 中的 10.0.2.2 指向 Mac 主机
cd clients/flutter_app
flutter run -d <android-device-id> \
  --dart-define=SUSONG_ENV=local \
  --dart-define=SUSONG_WSS_URL=ws://10.0.2.2:8787 \
  --dart-define=SUSONG_REST_URL=http://10.0.2.2:8788/api/v1
```

`npm start` 同时监听开发 WSS `8787` 和 REST `8788`。`SUSONG_WSS_URL` 只接受绝对 `ws://`/`wss://`，`SUSONG_REST_URL` 只接受绝对 `http://`/`https://`；客服 Bearer token 由协议适配器逐请求读取，界面不持有原始令牌。Android 明文 HTTP/WS 仅限隔离 debug 环境；staging/release 必须使用 HTTPS/WSS。这些代码不代表 Android/iOS 真机、证书链、平台安全存储、推送或签名已经通过。

这不是最终 Flutter App，也没有牌局裁判、计分、钻石扣费、充值、支付、提现或现金兑换能力。Android/iOS/HarmonyOS 包构建仍受 [DEVICE_MATRIX.md](DEVICE_MATRIX.md) 的 SDK、真机和签名条件约束。
