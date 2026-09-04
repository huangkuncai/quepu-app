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

`multi_client_acceptance.dart` 使用四个独立 `ClientSessionController` 和共享内存 fake gateway，验证登录、同房加入、事件顺序、`roomVersion`、`snapshotHash` 与断线重连收敛。真实 WSS、Android/iOS/HarmonyOS 设备、签名和平台生命周期仍需在 G1 完成。

`IoRestTransport` 基于 `dart:io`，适用于移动端原生壳，并将服务端错误映射为带 `statusCode/code/retryable` 的 `SupportApiException`；Web 壳应提供浏览器实现的 `SupportApiTransport`。
