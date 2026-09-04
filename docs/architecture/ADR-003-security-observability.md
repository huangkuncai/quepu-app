# ADR-003：BE-105/BE-106 安全、观测与质量门

- 状态：Accepted for development/staging baseline
- 日期：2026-08-28
- 范围：WebSocket 网关、控制面和 CI；生产发布仍需 G4/G5 审核

## 决策

1. WebSocket 帧使用 `WS_MAX_PAYLOAD_BYTES` 限制；每个连接使用固定窗口限流，规模化部署时替换为 Redis 限流器。
2. 浏览器 `Origin` 必须精确匹配 `ALLOWED_ORIGINS`；原生 Android/iOS/HarmonyOS 握手可省略 `Origin`。公网 TLS 由反向代理终止，应用端口只绑定内网/本机。
3. 网关使用 ping/pong 心跳和服务端超时；断开时只清理当前 connection，不影响同账号其他设备。事件/命令计数以 Prometheus 文本格式输出。
4. 结构化日志统一通过脱敏 logger，token、验证码、Authorization、私牌和牌墙字段永不落日志。请求关联 ID 进入日志和协议错误响应。
5. `/healthz`、`/readyz`、`/metrics` 只绑定独立控制端口，不与公网 WSS 混用；readiness 的关键依赖失败返回 503。
6. 每次变更必须通过 `npm run check`、协议/迁移校验、单测和 secret scan；CI 使用 Node 20 LTS，生产依赖扫描为高危即失败。

## 已验证证据

- `npm run check`：语法/导出、协议 schema、迁移结构和当前 108 个 Node 测试通过。
- `npm run scan:secrets`：未发现高置信度凭据模式。
- `docker compose -f infra/docker-compose.dev.yml config --quiet`：PostgreSQL/Redis 开发配置有效。
- `npm start`：WebSocket 服务可在 `127.0.0.1:8787` 启动。
- BE-201 的内存 Room aggregate、BE-202 内存 event store/RoomActor/fencing/snapshot/outbox 契约、BE-203 WSS gateway/actor/reconnect 纵切、BE-204 重连基础、QA-201 故障矩阵和 BE-206 重启 fixture 测试通过；`npm run verify:real` 已验证真实 PostgreSQL/Redis adapter，`npm run verify:multi-instance` 已验证两个独立连接下的开发期并发收敛；生产进程编排、滚动重启和故障演练仍未完成。
- CL-103 的 framework-neutral 客户端、原生 `dart:io` `IoWebSocketTransport` 和扩展房间命令同步 POC 通过；三端真机、平台生命周期和生产 WSS 仍未验收。

## 未解决事项

- 当前限流、会话、WSS 房间 registry 和指标均为单进程内存实现；BE-202/203/204 已提供可替换的内存 actor/event-store/WSS/reconnect 契约，PostgreSQL 条件版本写、Redis fencing 和开发期双实例 smoke 已验证，但生产多进程故障验证仍属于 BE-204 深化与生产适配。
- 控制端口、真实域名、证书、WAF、告警阈值和 staging secret 由 OPS 在 G4 前配置。
