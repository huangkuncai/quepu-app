# ADR-002：BE-103 会话与 WebSocket 鉴权

- 状态：Accepted for development/staging only
- 日期：2026-08-28
- 范围：BE-103；不代表正式短信、实名或生产身份服务已经上线

## 决策

1. 开发期使用 `AuthService` 内存适配器和固定验证码 `000000`，支持手机号登录；为保持最初骨架可运行，允许 `playerId` 作为明确标记的 legacy stub 登录输入。
2. access/refresh token 使用随机 opaque 值；服务端只保存 SHA-256 哈希。refresh token 每次轮换，旧 token 立即失效；检测到旧 refresh token 重放时撤销整条 session。
3. session 绑定 `userId`、`deviceId`、`platform`，支持同一账号多个设备。连接索引为 `userId -> Set<WebSocket>`，关闭旧 socket 时只移除该 socket。
4. `hello`、`login`、`refresh`、`ping` 可在未鉴权连接上调用；`auth` 成功后，`create_room`、`join_room`、`start_round`、`action`、`reconnect` 必须经过 `requireAuth`。
5. 未鉴权业务命令统一返回协议错误 `AUTH_REQUIRED`；过期、撤销、封禁和 refresh 重放不暴露 token 是否存在的内部细节。
6. `AUTH_MODE=stub` 不能通过生产安全检查。BE-103 之后必须接入审查过的外部身份提供商、持久化 session/revocation、风控和实名/年龄/地区策略，才可进入 G4/G5。

## 已验证行为

- 固定验证码错误、缺失 token、过期 token、登出和封禁都有稳定错误码。
- refresh rotation 后旧 access/refresh token 均不能继续使用。
- 两个设备同时登录同一账号，任一连接关闭不会删除另一个连接的索引。
- WebSocket command 先通过版本化 envelope/schema 校验，再进入鉴权和房间 handler。

## 未解决事项

- DEC-002 的正式登录供应商、实名/地区/年龄边界仍为 TBD。
- 当前 session 和 token 仅驻留内存，进程重启会使全部开发会话失效；BE-104/BE-105 前不得用于真实用户。
- 当前登录不发送真实短信，也不提供充值、支付、提现或现金兑换能力。
