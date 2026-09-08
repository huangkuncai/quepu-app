# 宿松协议客户端 POC

该目录提供与 UI 框架无关的 Dart 协议、连接状态机和重连 reducer。所有脚本均为本地开发/演示验证，不代表生产服务或三端真机验收。

```text
dart analyze
dart run tool/test.dart
dart run tool/io_transport_test.dart
dart run tool/multi_client_acceptance.dart
dart run tool/support_test.dart
dart run tool/io_rest_transport_test.dart
```

`multi_client_acceptance.dart` 使用四个独立 `ClientSessionController` 和共享内存 fake gateway，验证登录、同房加入、事件顺序、`roomVersion`、`snapshotHash` 与断线重连收敛。

仓库根目录的 `npm run verify:client-real` 会启动真实 Node 内存开发服务并执行 `real_backend_acceptance.dart`，用四条真实 `dart:io` WebSocket 连接验证建房、房号加入、准备、服务端发牌、私牌隔离和替换客户端同步恢复。该证据仍是 loopback/stub-auth/memory，不替代 Android/iOS 真机、WSS 证书、签名和平台生命周期验收。

`IoRestTransport` 基于 `dart:io`，适用于移动端原生壳，并将服务端错误映射为带 `statusCode/code/retryable` 的 `SupportApiException`；Web 壳应提供浏览器实现的 `SupportApiTransport`。
