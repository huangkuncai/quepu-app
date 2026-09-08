# 宿松麻将 App（第一版骨架）

> 完整产品、架构、接口、规则确认、三端发布和验收方案见：[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。
> 可执行的阶段任务、决策门和进度面板见：[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)。

这是一个跨端棋牌 App 的服务端最小骨架：房间、回合状态、事件同步、断线重连，以及宿松麻将规则注册表。

## 产品范围

- 客户端目标：Android、iOS、鸿蒙；框架待 POC 评审（ArkUI-X/ArkTS、Flutter/OpenHarmony 等候选）并共享协议层。
- 功能：登录、大厅、俱乐部（亲友圈）、积分战绩、联系客服。
- 不提供用户充值、支付、提现入口；积分仅用于每局结算。俱乐部开房消耗钻石，钻石仅由后台管理系统人工发放/调账。
- 第一版仅注册 `susong_v1`，牌型与番型待产品规则确认后补全。

## 运行

```bash
npm install
npm run dev
```

本地 PostgreSQL/Redis adapter 验证需要 Docker Desktop 或 Colima。项目已将
`pg` 与 `redis` 列为运行时依赖；启动 compose 后可用临时数据库执行完整验证，
验证结束会自动删除临时数据库。完整的环境、迁移、停机、清理和备份恢复步骤见
[OPS-101 本地环境手册](docs/deployment/LOCAL-ENV.md)：

```bash
docker compose -f infra/docker-compose.dev.yml up -d postgres redis
npm run verify:real
npm run verify:multi-instance
npm run check:mobile
```

`verify:real` 与 `verify:multi-instance` 都不会使用默认 `susong` 数据库写入测试事件；前者验证真实
PostgreSQL/Redis adapter，后者使用两个独立连接验证并发命令、连续版本、outbox 和最终
`snapshotHash` 收敛。两者都是本地开发 smoke，不替代生产进程编排、滚动重启或故障演练。
可通过
`DATABASE_URL` 和 `REDIS_URL` 覆盖连接地址。默认 compose 连接串见
[`db/README.md`](db/README.md)。

## BE-101 基线检查

BE-101 已建立模块化单体的最小边界，入口位于 `src/modules/`，配置 schema 和解析器位于 `src/config/`，统一错误码位于 `src/shared/errors.js`。这些目录目前只声明责任边界，不代表真实 Auth、宿松麻将裁判、俱乐部审批或钻石扣费已经实现；现有 `src/server.js` 和 `src/domain/*` 保持兼容。

```bash
npm run lint       # JavaScript 语法和基础风格检查
npm run typecheck  # 当前 JS 项目的导出/配置契约检查
npm run validate:contracts # OpenAPI/AsyncAPI YAML、$ref、路径和状态码契约检查
npm test           # Node 内置测试
npm run check      # 完整质量门（含协议、契约、迁移和测试）
```

复制 `.env.example` 作为本地配置起点。`AUTH_MODE=stub`、`FEATURE_REAL_RULES=false` 和 `FEATURE_REAL_DIAMONDS=false` 仅用于开发/测试；开发期验证码为 `000000`，生产安全检查会拒绝 stub 身份和未完成的真实能力。模块边界和 ADR 见 [ADR-001](docs/architecture/ADR-001-modular-monolith.md) 与 [ADR-002](docs/architecture/ADR-002-auth-session.md)。

WebSocket 默认监听 `8787`。新协议消息包括 `hello`、`login`、`auth`、`refresh`、`logout`、`ping`、`create_room`、`join_room`、`start_round`、`action`、`reconnect`；协议草案见 [docs/protocol](docs/protocol/README.md)。

BE-205 的房间 REST/BFF 与 WSS 共用 `RoomActor`，默认不额外监听 HTTP 端口；开发验收可显式开启：

```js
const app = createRealtimeServer({ http: true, httpPort: 8788 });
```

REST 前缀为 `/api/v1`（同时兼容 `/v1`），支持登录/刷新/登出、`/me`、房间创建/查询、加入、离开、准备、开始、解散和通用 `/commands`。写请求可用 `Idempotency-Key`，房间响应带 `ETag` 和 `x-room-version`；`If-Match` 会绑定到同一 RoomActor 的乐观版本。默认仍是内存/fake-staging 适配器。

需要装载 PostgreSQL（以及可选 Redis fencing lock）时，使用异步启动工厂；它不会在缺少驱动或连接配置时静默回退到内存：

```js
import { createRealtimeServerAsync } from './src/server.js';
import { loadConfig } from './src/config/index.js';

const app = await createRealtimeServerAsync({ config: loadConfig() });
```

`PERSISTENCE_BACKEND=postgres` 需要 `DATABASE_URL`，配置 `REDIS_URL` 后会创建房间 fencing lock。deadline 已有 `game_deadlines` claim/lease 适配器（Memory/PostgreSQL）；`npm run verify:real` 和 `npm run verify:multi-instance` 可重复验证真实 PG/Redis 运行、恢复和开发期双实例收敛，但生产多进程滚动重启、外部身份服务和三端真机验收仍未完成。

## 下一步

1. 汇总宿松麻将至少 20 个签字 golden cases，并用旧服样本补齐首局庄、补牌方向、花奖封顶和多三西关系边界。
2. 将生产运行时切换到已实现的 PostgreSQL（用户、俱乐部、战绩、事件日志）+ Redis（在线状态/锁）适配器，并完成多进程故障演练。
3. 增加 JWT 登录、俱乐部权限、后台钻石流水与审计日志。
4. 完成 Flutter Android/iOS 真实客户端适配，并将客服纯文本 REST 接入真实客户端；鸿蒙按当前决定暂缓，严禁把牌局裁判逻辑放在客户端。
