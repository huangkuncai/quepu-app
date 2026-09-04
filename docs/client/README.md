# 客户端 G1 POC 资料包

> 状态：`IN_PROGRESS`（Flutter 本机 POC 已建立；不表示三端真机能力已经确认）  
> 关联决策：`DEC-011`、`G1`  
> 关联文档：[DEVELOPMENT.md](../DEVELOPMENT.md)、[IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md)、[决策索引](../decisions/DEC-INDEX.md)

本目录用于记录 Android、iOS、HarmonyOS 的跨平台技术验证。当前已建立 `clients/flutter_app` 的 Flutter POC 壳和共享 Dart 协议核心；它只使用 FakeTransport，不能替代 ArkUI-X/ArkTS 候选、三端工具链、设备日志和签名安装验收。所有待确认内容保留为 `TBD`，由执行人以实际构建、设备日志和录屏补齐。

## 使用边界

- 当前仓库的 Node.js + `ws` 服务端仍是开发骨架。未经 TLS、认证、持久化和安全评审，不得把本地 `ws://localhost:8787` 暴露给真实用户或作为生产 endpoint。
- POC 可使用假登录、mock 俱乐部/楼层和 sandbox 账本；不产生真实积分结算或钻石扣费。
- 框架候选至少记录 ArkUI-X/ArkTS 与 Flutter + OpenHarmony 方案，但本目录不预选任何一个。若候选未通过，仍必须复用共享协议和领域契约，不能把 POC 代码当成正式业务实现。
- “通过”只对记录的设备、系统版本、构建号和测试范围有效，不外推到未测试设备。

## 文档索引

| 文件 | 用途 |
| --- | --- |
| [POC_ACCEPTANCE.md](POC_ACCEPTANCE.md) | G1 POC 范围、用例、判定、证据和框架决策门 |
| [DEVICE_MATRIX.md](DEVICE_MATRIX.md) | Android/iOS/HarmonyOS 设备、系统、网络和生命周期登记 |

## 填写规则

1. 每次测试先登记 `runId`、日期、执行人、git SHA、构建号、协议版本和 endpoint 环境。
2. `PASS` 必须附日志/录屏/截图或自动化报告路径；只有“未执行”写 `TBD`，不能用空白代替。
3. `FAIL` 要记录最小复现步骤、影响范围、严重级别、临时规避和责任人；P0/P1 失败阻断 G1。
4. 设备或系统版本变更时，新建运行记录，不覆盖旧证据。
5. G1 结束后由 `USER/PM`、客户端负责人和 QA 在 POC 验收表签字；签字前状态保持 `PLANNED` 或 `IN_PROGRESS`。
