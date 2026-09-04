# BE-102 协议契约（Draft）

本目录是客户端、服务端和测试共用的语言中立协议源。当前只冻结传输外壳和开发期房间命令；业务规则、认证提供商和真实钻石流程仍由后续决策门控制。

## 文件

- `openapi.yaml`：REST/BFF 路由草案。
- `asyncapi.yaml`：WebSocket 命令与事件频道草案。
- `../../schemas/protocol/`：JSON Schema；客户端可据此生成 Dart、Swift、Kotlin、ArkTS 或 TypeScript 模型。
- `../../src/protocol/`：Node 端校验器和兼容适配器。

## Envelope 约定

每个新命令包含 `protocolVersion`、`type`、`requestId`、`commandId` 和对象型 `payload`。房间命令可带 `roomId`、`roomVersion` 和 `sessionId`。服务端事件使用 `eventId`、单调递增的 `roomVersion` 和 `occurredAt`；私有牌面必须通过 `visibility=player` 的 viewer-scoped 序列化发送。

牌局快照中的 `round.turnStartedAt`/`round.turnDeadlineAt`（RFC3339）由服务端写入并在重连时恢复，客户端只用于展示倒计时。超时动作只有在规则快照明确包含 `deadlinePolicy.enabled=true`、`actionDeadlineMs` 和 `timeoutAction` 时才会由服务端调度；未配置时不自动猜测动作。默认路径仍使用单进程本地 timer；Memory/PostgreSQL `DeadlineStore` 已提供持久化 claim/lease/fencing 适配器，并由 `npm run verify:real` 与 `npm run verify:multi-instance` 做开发 smoke。生产 worker supervision、滚动重启和故障演练未完成前，不得据此放开生产多实例能力。

当前协议支持主版本 `1`（例如 `1.0`、`1.1`）。客户端只能依赖自己声明支持的字段；未知顶层字段会被拒绝，payload 具体字段由对应命令 schema 校验。超过服务端 `WS_MAX_PAYLOAD_BYTES` 的消息返回 `PAYLOAD_TOO_LARGE`。

## 兼容策略

仓库最初的开发骨架使用 `login`、`create_room`、`join_room` 等下划线消息，且没有 ID。`adaptLegacyCommand` 会在开发适配层补齐协议版本和 UUID，再进入统一 handler；生产 WSS 只接受完整 envelope。不会把旧消息格式直接扩展成第二套业务协议。

## 明确不包含

- 不在客户端执行麻将裁判或结算。
- 不提供充值、支付、提现、现金兑换或转赠路由。
- 不把积分和钻石放入同一本账，也不在 BE-102 默认任何未确认规则数值。

## 校验命令

```bash
npm run lint
npm run typecheck
npm test
npm run check
```
