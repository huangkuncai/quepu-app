# 宿松麻将 Flutter POC 壳

这是 G1 的 Flutter 候选壳，当前只连接 `FakeTransport`，用于验证共享 Dart 协议消费层、登录、大厅、俱乐部楼层详情、战绩占位、纯文本客服和断线同步交互。

## 本机验证

```bash
flutter pub get
flutter test
flutter build web --release
```

当前环境若没有 Android SDK 或完整 Xcode，不能把本项目的 Web/桌面测试结果写成 Android、iOS 或 HarmonyOS 真机通过。正式 WSS、平台安全存储、推送、签名和 HarmonyOS HAP 适配仍由 `DEC-011` 与 G1 真机验收决定。

## 边界

- 验证码仅为开发期 `000000`；不接入正式短信供应商。
- Fake 网关不实现宿松麻将裁判、积分结算或钻石账本。
- 客户端没有充值、支付、提现、现金兑换或转赠路由/SDK。
- 业务 UI 依赖 `clients/dart_protocol`，平台能力必须通过独立 adapter 注入。
