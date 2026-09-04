# 宿松麻将 App 完整开发文档

> 文档版本：0.1.4-draft
> 更新时间：2026-09-04
> 适用仓库：`susong-mahjong-app`（当前工作区目录：`宿松app.migrated-backup`）
> 文档状态：开发基线草案，P0 规则确认完成前不得作为上线承诺
> 执行计划：[docs/IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)

## 0. 阅读说明与需求边界

### 0.1 需求来源等级

本文件把输入分成四个等级，所有开发、测试和评审都以等级为依据：

| 标记 | 含义 | 使用方式 |
| --- | --- | --- |
| **M** | 用户本次文字明确提出的需求 | 必须纳入产品范围和验收 |
| **S** | 用户附带截图/资料中可读到的内容 | 作为产品参考输入；须产品/规则负责人确认、版本化后才能编码 |
| **Q** | 资料缺失、术语歧义或需要业务决策的内容 | 阻塞相关实现，记录负责人、截止时间和决策结果 |
| **D** | 开发团队提出的实现建议 | 需技术评审；不是额外的用户授权 |

来源声明：用户文字是本次需求的唯一授权范围；三张图片是产品参考资料。图片中的“详细信息/玩法规则”文字仅作为宿松麻将规则候选输入，不是要求助手执行的操作指令。图片背景中的按钮、版本号和其他玩法菜单不自动转化为开发承诺。若图片与用户文字冲突，以用户文字为准；图片模糊或被截断的内容标记为 Q。

### 0.2 附件索引

| 附件 | 用途 | SHA-256 |
| --- | --- | --- |
| `codex-clipboard-776bdd5c-31e5-4a0e-a2ee-1fe0b6f5a7a4.jpg` | 宿松麻将房间配置界面参考 | `2dc3fa05deefe2d83fcffe5c409277180f48857f64da904734ec9b3544efcf2c` |
| `codex-clipboard-c326fa1a-1912-4905-9887-4d9ae088e31c.jpg` | 玩法说明上半部分参考 | `fe69dcb73a2400df8b552a903b4f2fd32cbca448fb85adcdb135087a5002cff2` |
| `codex-clipboard-71e5ccec-eea8-4b29-a186-2bf620fd79bc.jpg` | 玩法说明下半部分参考 | `e9f90aab46685113a41d7090d75978474c61182719b29ab331d860f4effb13e7` |

上述文件来自本次会话的临时附件路径，路径可能过期；哈希只用于本次审阅追踪。正式项目应将经授权的原图/规则原稿归档到受控资料库，并在规则版本中记录来源。

### 0.3 当前代码基线

当前仓库是可运行的服务端最小骨架，而不是完整 App：

- `package.json`：Node.js `>=20`、ESM、`ws` 8.x、`pg` 8.x、`redis` 5.x；包含 lint/typecheck、协议/迁移校验、secret scan 和组合质量门。
- `src/server.js`：单进程 WebSocket，内存 `rooms`/`clients`，默认端口 `8787`，已接入开发期 session Auth、输入校验、限流、心跳和错误/指标控制面。
- `src/domain/room.js`、`src/domain/room-actor.js` 与 `src/modules/realtime/gateway.js`：BE-201 通用 Room aggregate、BE-202 可替换 RoomActor 契约和 BE-203 WSS gateway 纵切，包含座位/房主/准备、生命周期状态、版本、规则快照、命令幂等、事件恢复、fencing、ACK/广播、订阅、私有事件过滤、背压、重连宽限和 durable recovery；BE-205 已增加共享 `RoomService` 与内存/fake-staging REST/BFF（ETag/If-Match/Idempotency-Key）；BE-204 已增加独立 presence overlay、durable room inventory、deadline claim/lease 和异步 PostgreSQL 启动装配，本地真实 adapter/双实例 smoke 已通过，生产滚动重启和故障演练仍未验收。
- `src/domain/rules/susong.js`：`susong_v1` 占位规则注册表。
- `clients/dart_protocol`：framework-neutral envelope/reducer、会话控制器、扩展房间命令同步和重连策略、原生 `dart:io` `IoWebSocketTransport`，以及可注入 REST transport 的纯文本 `SupportApi`；`clients/flutter_app` 是只连 FakeTransport 的本机 POC 壳，已接入 CL-201 房间桌面（座位、准备、公共状态、私牌占位和同步入口）、CL-202 命令 outbox、CL-203 连接/同步/维护/版本冲突/手动重试及前台恢复 UI，以及可注入 SupportApi 的客服表单。
- PostgreSQL migrations、Redis Compose/health、repository contract、BE-202 内存 event store/snapshot/outbox/lock、BE-204 PostgreSQL/Redis adapter、presence overlay、durable room inventory/deadline claim、BE-205 REST/BFF、BE-207 纯文本客服 REST、结构化日志、CI workflow 和基础 QA fixture 已建立；`npm run verify:real` 已在临时数据库中验证真实 PG/Redis adapter，`npm run verify:multi-instance` 已验证两个独立 PG pool/Redis client 的并发命令、连续事件/outbox 和最终 snapshotHash；正式外部 Auth、生产多进程滚动重启、后台、持久化客服仓储和完整麻将裁判仍未完成。
- `npm test` 当前 108 个测试通过（含 BE-201～207、客服鉴权/隔离/幂等/审计、BE-204 重连/deadline/presence/重启恢复、双 actor 收敛/crash-gap 与 PostgreSQL/Redis adapter 契约、OpenAPI/AsyncAPI 契约、QA-201 故障矩阵和 BE-206 重启 fixture）；默认启动仍是内存，PostgreSQL 需通过 `createRealtimeServerAsync` 显式装载，生产滚动重启和长期一致性验证仍未完成。

因此本文件既是产品需求说明，也是从现有骨架演进到可安装三端产品的实施蓝图。

### 0.4 交付物定义

本项目最终交付四类可独立验收的产物：

- 移动端安装包：Android `APK/AAB`、iOS `archive/IPA`、HarmonyOS `HAP`（及需要时的 `HSP`）。
- 服务端：版本化 REST/WSS API、规则引擎、数据库迁移、后台 API 和可观测性配置。
- 后台运营端：俱乐部审批、楼层/规则发布、钻石账本、客服和审计页面。
- 文档与数据：协议 schema、规则确认单、golden cases、隐私/用户协议、发布 manifest 和灾备手册。

“能安装”不等于“可上线”：三端安装包还必须通过真实设备、弱网、账号安全、规则结算、审计和合规门槛。

## 1. 产品目标、范围与非目标

### 1.1 产品目标

构建一个可安装在 Android、iOS 和鸿蒙设备上的亲友圈棋牌 App。首版提供宿松麻将，服务端作为唯一裁判，支持实时牌局、回合状态、断线重连、多人同步、积分制结算、俱乐部申请审批、俱乐部包厢楼层规则配置、战绩和联系客服；首版人数暂按四人实现（S/Q，需规则负责人确认），架构能够在不重写房间与同步基础设施的前提下扩展其他麻将和扑克。

当前迭代范围调整：暂不实现鸿蒙工程、构建和真机验收，先完成 Android+iOS；鸿蒙保留为后续版本，不改变共享协议、服务端和领域层设计。

### 1.2 首版范围（M）

1. 登录、登出和会话管理；账号注销入口属于合规/产品建议，具体方式待确认。
2. 大厅：俱乐部入口、房间/牌局入口、客服入口；公告属于产品建议，可按评审结果纳入。
3. 俱乐部（亲友圈）：申请、审批状态、成员和角色、楼层管理。
4. 包厢楼层：结构化规则详情、启用/停用、版本化；从楼层创建的房间使用该规则快照。
5. 房间：创建、加入、座位、准备、开始、牌局操作和状态展示；房主、邀请、解散等边界按权限/规则确认后实现。
6. 实时同步：服务端权威事件、心跳、断线重连、快照和增量事件。
7. 宿松麻将首版：规则插件、发牌/补花/动作合法性/结算接口；具体分值以规则确认单为准。
8. 每局按积分结算并生成整场战绩；积分不是货币，不支持购买、提现或转赠。
9. 俱乐部开房使用钻石；钻石仅由后台人工发放/调账，客户端无充值、支付、提现或转赠入口。
10. 客服入口和工单/消息能力。
11. 后台运营：俱乐部审批、规则版本、用户处置、钻石账本、客服和审计。

### 1.3 明确非目标（首版不做）

- 用户充值积分、提现、现金兑换、玩家间积分/钻石交易。
- 客户端支付 SDK、商城、充值页或“购买钻石”路由。
- 截图中列出的“拖三”“斗地主”“摸蛋团团转”“摸蛋经典”等玩法；它们只作为未来扩展线索。
- 将牌局裁判、随机发牌、计分或钻石扣除放到客户端。
- 在规则尚未签字前承诺完整胡型、番型、封顶和特殊牌型。

## 2. 需求追踪矩阵

以下需求编号用于 PR、测试用例、验收单和发布清单。

| 编号 | 需求 | 来源 | 优先级 | 状态 | 验收摘要 |
| --- | --- | --- | --- | --- | --- |
| REQ-PLAT-001 | Android/iOS/鸿蒙均可安装、升级和运行 | M | P0 | Draft | 三端真机安装、登录、进房、重连通过 |
| REQ-PLAT-002 | 首版宿松麻将，后续可扩展麻将/扑克 | M | P0 | Draft | 新增规则插件不修改房间/同步核心 |
| REQ-ROOM-001 | 房间和回合由服务端权威管理 | M | P0 | Draft | 非法状态/动作被拒；客户端分数不被信任 |
| REQ-ROOM-002 | 断线重连后恢复牌局 | M | P0 | Draft | 手牌（仅本人）、公共牌、轮次、倒计时、积分一致 |
| REQ-ROOM-003 | 多人实时同步 | M | P0 | Draft | 事件按单调序号应用，无重复/乱序分歧（人数待确认） |
| REQ-GAME-001 | 宿松麻将按局积分结算 | M | P0 | Draft | 每局产生可追溯分录，整场累计可查 |
| REQ-ECON-001 | 积分无需充值，仅用于牌局/战绩 | M | P0 | Draft | 客户端无积分充值/提现/兑换入口 |
| REQ-ECON-002 | 俱乐部开房消耗钻石 | M | P0 | Draft | 权限和余额校验、原子扣费、幂等流水 |
| REQ-ECON-003 | 钻石仅后台人工发放/调账 | M | P0 | Draft | 客户端没有支付入口；每笔变更有审计 |
| REQ-CLUB-001 | 俱乐部必须申请并审批后才能加入/使用 | M | P0 | Draft | 待审/拒绝用户无法进入受限资源 |
| REQ-CLUB-002 | 管理员管理成员和楼层 | M | P0 | Draft | 越权请求返回 `FORBIDDEN` 并记录审计 |
| REQ-FLOOR-001 | 楼层保存规则详情，楼层房间执行这套规则 | M | P0 | Draft | 创建房间写入不可变 `ruleSnapshot` |
| REQ-SUPPORT-001 | 新增联系客服（首版至少纯文本内置工单） | M | P0（外部渠道/附件 P1） | Draft | 可从大厅、俱乐部、牌桌提交并查询工单 |
| REQ-AUTH-001 | 登录、会话、撤销和设备管理 | M+D | P0 | Proposed | access/refresh、踢旧连接、封禁可验证 |
| REQ-DATA-001 | 房间、战绩、账本可持久化 | D/P0 | P0 | Proposed | 服务重启后可恢复；事件和账本不丢 |
| REQ-SEC-001 | 只使用 HTTPS/WSS，服务端校验所有输入 | D/P0 | P0 | Proposed | 安全扫描、限流、原生握手认证/权限测试通过 |

状态说明：`Draft` 表示需求明确但尚未产品签字；`Proposed` 表示开发建议，评审通过后改为 `Confirmed`。

## 3. 用户角色与权限模型

### 3.1 角色

| 角色 | 主要能力 | 约束 |
| --- | --- | --- |
| 游客 | 查看公开版本信息、开始登录 | 不得访问俱乐部、房间或私有牌面 |
| 登录用户 | 大厅、申请加入俱乐部、加入获批房间、牌局、战绩、客服 | 不能管理俱乐部或钻石 |
| 俱乐部申请人 | 查看自己申请状态、补充资料、撤回/重新申请 | 审批通过前不能进入受限楼层 |
| 俱乐部成员 | 查看获授权楼层、加入房间、查看俱乐部战绩 | 只能使用成员可见楼层 |
| 房主 | 在授权楼层开房、邀请/开始/按规则解散 | 不能改已创建房间规则或人工改钻石 |
| 会长/俱乐部管理员 | 审批成员、分配角色、创建/编辑/停用楼层、查看俱乐部数据 | 不能发放平台钻石，不能越权查其他俱乐部 |
| 平台运营 | 审批俱乐部、处理封禁、配置全局规则版本、人工发放/调账钻石 | 强制 MFA、双人复核和全量审计 |
| 客服 | 查看分配工单、回复、标记处理状态 | 默认不接触完整牌面和钻石调账权限 |
| 审计只读 | 查看操作、账本、事件和报表 | 不得修改业务数据 |

### 3.2 俱乐部申请的两种类型

为避免“申请俱乐部”语义歧义，数据模型同时支持：

- `create`：用户申请创建俱乐部，由平台运营审批。
- `join`：用户申请加入已有俱乐部，由会长/管理员审批。

每次申请必须记录申请人、目标俱乐部（如有）、资料、状态、审批人、审批时间和拒绝原因。状态：`SUBMITTED`、`PENDING`、`APPROVED`、`REJECTED`、`CANCELLED`。

### 3.3 权限原则

服务端 RBAC/资源归属是唯一权限依据；客户端隐藏按钮不算权限控制。每一个 REST 路由、WebSocket 命令和后台操作都要执行：身份校验、俱乐部关系校验、楼层可见性校验、房间角色校验、规则状态校验和审计记录。

## 4. 产品信息架构与主要流程

### 4.1 客户端页面

1. 启动/版本检查；隐私同意按合规方案实施。
2. 登录与账号安全（手机号/验证码或其他方案待确认）。
3. 大厅：我的俱乐部、最近牌局、客服；公告属于产品建议，可按评审结果纳入。
4. 俱乐部列表与详情：申请、成员、楼层、房间。
5. 申请中心：创建/加入申请、状态和拒绝原因。
6. 楼层详情：游戏类型、局数、底分、出增、强飘、必胡、说明文本、开放状态。
7. 房间大厅：房间号、座位、准备、邀请、开始/解散提示、钻石扣费提示。
8. 牌桌：手牌、公共牌、可行动作、倒计时和玩家连接状态；聊天、观战、托管等属于 P1/Q，是否首版开放待定。
9. 结算：单局明细、累计积分、花/杠/特殊项明细、整场结果。
10. 战绩：按时间、俱乐部、房间、玩家筛选；详情和回放（回放为 P1）。
11. 客服：工单、消息、附件、处理状态。
12. 设置：通知、隐私、版本、规则说明；账号注销按合规流程设计，具体入口待确认。

管理员端还必须提供独立的俱乐部管理页面：申请审批、成员角色、楼层新增/编辑/停用、规则版本发布和历史版本查询。管理员按钮只改善体验，最终权限仍由后台 API/RBAC 强制执行。

### 4.2 核心用户流程

```text
启动 → 隐私同意 → 登录 → 大厅
                         ├─ 申请加入/创建俱乐部 → 待审 → 通过/拒绝
                         ├─ 进入俱乐部 → 选择楼层 → 查看规则详情
                         ├─ 创建房间 → 校验成员/钻石 → 房间等待
                         └─ 客服 → 新建工单 → 回复/关闭

房间等待 → 入座/准备 → 房主开始 → 发牌 → 回合动作循环
          → 胡牌/流局 → 服务端积分结算 → 下一局
          → 达到局数 → 整场战绩 → 房间结束
```

### 4.3 房间规则冻结

楼层编辑产生新的 `FloorRuleVersion`，不能覆盖历史版本。创建房间时将 `gameType`、`ruleId`、`ruleVersion` 和完整结构化配置复制为不可变 `ruleSnapshot`。已创建或已开始的房间不受楼层后续编辑影响；停用楼层禁止新开房，但历史房间和战绩仍可查询。

## 5. 三端客户端技术方案

### 5.1 不可变的共同边界

无论最终选择何种 UI 框架，必须共享以下协议与领域契约：

- `packages/protocol`：以 OpenAPI/AsyncAPI + JSON Schema 为语言中立的唯一真源，生成 Dart、Kotlin、Swift、ArkTS 和 TypeScript 类型/校验器。
- `packages/game-state`：事件 reducer、快照校验、重放显示逻辑；不得成为裁判。
- `packages/assets`：牌面、图标、字体和多语言资源。
- `native-adapters`：安全存储、网络状态、生命周期、推送、分享和客服跳转。

服务端权威计算牌局、随机种子、合法动作、积分和钻石；客户端只渲染服务端快照/事件并提交意图。

### 5.2 框架选型决策门

建议先做 2 周 POC，再锁定 UI 框架：

| 方案 | 优点 | 风险 | 适用判断 |
| --- | --- | --- | --- |
| ArkUI-X/ArkTS | 鸿蒙能力和适配路径优先 | Android/iOS 生态与插件需验证 | 鸿蒙是硬约束时首选候选 |
| Flutter + OpenHarmony 方案 | Android/iOS 成熟、UI 开发效率高 | 鸿蒙分支/插件维护和上架风险 | 团队 Flutter 经验强时候选 |
| React Native + RNOH | TypeScript 复用度高 | 鸿蒙原生模块与版本漂移 | JS 团队可做备选 |
| Cocos + 原生壳 | 牌桌动画和性能强 | 大厅、俱乐部、客服双栈复杂 | 仅在重动画需求确认后评估 |

POC 硬验收：三端签名安装、登录、进入四人房、WSS 收发事件、前后台切换重连、客服表单、规则详情展示。POC 未通过时保留“Android+iOS 共享 UI + 鸿蒙独立壳”的降级方案，但继续复用同一协议和领域包。

技术选型评分建议（权重可在评审中调整）：鸿蒙原生能力 30%、Android/iOS 成熟度 20%、实时牌桌性能 15%、推送/客服/日志 SDK 15%、团队学习与招聘 10%、CI/上架风险 10%。鸿蒙真机安装和 AppGallery 构建是硬门槛，不能仅凭“框架声称跨端”作决定。最终锁定的 ArkUI-X/ArkTS 或其他 SDK 版本必须写入 release manifest，并定期做兼容性回归。

### 5.3 生命周期与网络

移动系统可能挂起或杀死后台 WebSocket，不能承诺后台长连接。切后台时保存 session 和 `lastRoomVersion`，回前台使用 access token 重连并请求快照/增量。心跳建议 30 秒；重连退避为 1/2/4/8/16/30 秒并加入随机抖动。服务端回合计时不因客户端后台而暂停。

平台能力通过适配器抽象：

- Android：Keystore、FCM（仅适用设备）及厂商推送降级、Play/App Bundle 或目标地区的 APK/厂商渠道包。
- iOS：Keychain、APNs、TestFlight/App Store。
- 鸿蒙：安全存储、Huawei Push、HAP/HSP、AppGallery Connect。

三端都要支持安全区、刘海、横竖屏策略、深色模式、字体缩放和无障碍基础能力。
纯鸿蒙原生目标（`OHOS_NATIVE`）与旧系统 Android 兼容层（`OHOS_ANDROID_COMPAT`）分开验收；APK 能在兼容层运行不等于完成纯鸿蒙支持。目标 API/设备基线由发布前锁定并写入 manifest。WebSocket/TLS、推送、安全存储、文件上传等鸿蒙插件逐项做真机 POC；平台判断集中在 adapter/bridge，业务层不散落条件分支。不承诺离线牌局，回前台先完成同步再恢复操作；客户端时钟只用于显示，超时由服务端裁判。

## 6. 后端总体架构

### 6.1 逻辑组件

```text
移动端
  ├─ HTTPS REST ── API Gateway ── Auth / Lobby / Club / History / Support
  └─ WSS ─────── Realtime Gateway ── Room Actor / Rule Engine / Settlement
                                      ├─ Redis：在线、短期状态、锁、发布订阅
                                      └─ PostgreSQL：事实数据、事件、账本、审计

后台 Web ── Admin API ── RBAC/MFA ── Club / Diamond / Rule / Support / Audit
对象存储/CDN：头像、客服附件、静态资源（敏感附件私有桶）
观测：日志、指标、链路、错误追踪和告警
```

### 6.2 服务边界

- **Auth Service**：账号、设备、access/refresh、撤销和封禁。
- **Lobby Service**：公告、可见俱乐部/楼层和配置下发。
- **Club Service**：申请审批、成员角色、楼层和规则版本。
- **Room Service**：房间生命周期、座位、准备、解散、钻石计费意图。
- **Realtime Gateway**：WSS 连接、心跳、订阅、ACK、同步和广播过滤。
- **Game/Rule Engine**：牌局状态机、合法动作、随机发牌、回放、结算。
- **Ledger Service**：积分结果分录和钻石账本；所有写入幂等。
- **History Service**：战绩查询、聚合和回放。
- **Support Service**：客服工单和消息。
- **Admin Service**：后台权限、运营操作和审计。

首阶段可以合并为一个 Node.js 部署单元，但代码边界和数据库表边界按上述模块划分；不得继续依赖进程内 Map 作为事实来源。

### 6.3 并发与一致性

同一房间使用单 actor/分片串行处理，或使用带 fencing token 的分布式锁；同一 `roomId` 任意时刻只能有一个权威写入者。命令带 `commandId` 和 `expectedRoomVersion`，数据库/事件存储和账本操作使用事务或 outbox。多实例部署时不可依赖 sticky session 保证正确性，只能优化连接路由。

## 7. 通用游戏/规则引擎抽象

### 7.1 核心接口

```ts
interface GameDefinition<Config, State, Action, Settlement> {
  id: string;                 // e.g. susong
  version: string;            // e.g. susong_v1.0.0
  playerCount: number | Range;
  configSchema: JsonSchema;
  createGame(input: { seed: string; config: Config; players: Player[] }): State;
  legalActions(state: State, playerId: string): LegalAction[];
  applyAction(state: State, action: Action): ApplyResult<State>;
  resolveRound(state: State): RoundResolution;
  scoreRound(resolution: RoundResolution): Settlement;
  isTerminal(state: State): boolean;
  serialize(state: State): PublicAndPrivateViews;
  restore(snapshot: Snapshot): State;
}
```

通用基础设施只依赖接口，不依赖“麻将”字段。新增其他麻将或扑克时只需新增插件、配置 schema、牌桌视图和测试向量。

### 7.2 配置分层

- 房间级：`roundCount`、`baseScore`、`increment`、`strongFloat`、`mandatoryWin`、计费策略。
- 牌局级：`dealerSeat`、牌墙、局号、随机种子承诺、规则算法版本。
- 玩家级：`incrementChoice`、花/飘状态、过圈状态、座位和连接状态。

规则配置必须通过 JSON Schema 校验，发布后不可变；变更使用新版本和迁移函数。规则插件不得读取 UI 文本来决定计分。

## 8. 宿松麻将首版规则基线

本节把截图可读内容记录下来，但除非标记为 M/Confirmed，否则只能进入规则确认单，不能直接上线。

### 8.1 截图中可读的候选配置（S）

| 字段 | 截图内容 | 当前处理 |
| --- | --- | --- |
| 游戏局数 | 4、8、16 局；示例高亮 16 | `roundCount` 枚举候选，待确认 |
| 底分 | 1～9 分；画面同时勾选 5、6、7、8 | 多选/单选语义不明，禁止假设；待确认 UI 和 schema |
| 出增分数 | 不出增、1、2、3、5 分；示例选 2 | 统一字段名为 `increment`，待确认触发与上限 |
| 强飘 | 强飘/不强飘；示例不强飘 | `strongFloat` 布尔候选，定义待确认 |
| 必胡 | 必胡/不必胡；示例必胡 | `mandatoryWin` 布尔候选，过圈语义待确认 |
| 钻石 | 示例显示消耗 `×6` | 仅示例，不是固定价格；计费策略待确认 |
| 扣费说明 | 开始游戏后第一局结算后扣除；提前解散不扣除 | S，需确认适用范围和失败策略 |

### 8.2 玩法候选规则表

| 规则 ID | 候选内容（S） | 必须确认的实现问题 |
| --- | --- | --- |
| R-001 | 上一局最先胡牌者为庄；流局沿用上一局庄 | 首局庄、多家同时胡时如何定义 |
| R-002 | 红中、发财、白板、红花、黑花为花牌，抓到后补花 | 牌组数量、补花来源、连续补花和牌墙变化 |
| R-003 | 有花奖时其他三家扣分；按底分第二档，可累加；花奖者点炮取消，流局取消 | 每朵/每档公式、扣分分配、叠加顺序 |
| R-004 | 无花果不能胡他人，只能自摸；无花果点炮记“一察/一素”（截图字样待核） | 术语和数值、补花后是否解除 |
| R-005 | 三西/三道时两个输赢关系翻倍，胡其他玩家也跟放冲者扣 | 识别条件、翻倍对象、与一炮多响关系 |
| R-006 | 放冲者一人扣；一冲 2/3 家同时扣；自摸其他三家扣 | 多家胡是全额还是分摊、是否可配置 |
| R-007 | 不出增时默认可有花奖；出增档位时不出增者无花奖 | 出增选择者、是否仍可胡、影响项 |
| R-008 | 同一房周期内可以加增，不能减少增 | 加增窗口、上限、是否全员同意、历史局不追溯 |
| R-009 | 明杠 1 朵花、暗杠 2 朵；碰风 1 朵；明杠风 2 朵；暗杠风 3 朵 | 风牌定义、重复计算、杠/补花顺序 |
| R-010 | 剩余 14 张仍无人胡为流局，不计分；流局取消花奖 | 14 张口径、杠后牌墙、是否保留杠分 |
| R-011 | 必胡时他人点炮自动胡；不必胡可选择任一玩家牌或自摸，但必须过圈 | 过圈状态、超时默认、抢杠/海底等边缘动作 |
| R-012 | 小胡 1～4 朵花，大胡 5～9 朵花 | 9 朵以上、完整胡型、封顶和分值 |

### 8.3 P0 规则确认清单

在以下问题有书面决策前，规则引擎只能做模拟/测试，不得宣称生产可玩：

1. 牌组构成：万/条/筒、风牌、箭牌、红/黑花各几张，总牌数和四人初始手牌。
2. 底分的单选/多选语义、底分第二档的具体值或倍率。
3. 小胡、大胡、特殊胡型、无花果“一察/一素”和封顶的完整分值表。
4. 花奖、花朵、杠分、出增、强飘、三西的触发、叠加和舍入顺序。
5. 点炮、一炮多响、自摸、抢杠胡、杠上花/炮、海底和流局处理。
6. 庄家首局、连庄、多家同时胡和流局后的轮转。
7. 必胡“过圈”的精确定义、超时默认动作和托管规则。
8. 房间局数结束条件、负分限制、提前解散、断线和异常退出结算。
9. 钻石计费时机；截图的 `×6` 是否只是示例；余额不足、扣费失败、重试和退款。
10. “俱乐部需要申请”是创建申请、加入申请，还是两者都要；审批主体和管理员边界。
11. 俱乐部房间是否允许非成员受邀入桌；建议将 `roomAccessPolicy` 设计为 `MEMBERS_ONLY`、`INVITE_ONLY` 或 `PUBLIC_CODE`，并在加入、重连、观战和审计中统一执行。普通大厅房（如未来开放）与俱乐部房的规则来源和钻石计费必须分开。
12. 积分生命周期：每场是否从 0 开始、是否跨场累计、是否允许负分、展示范围和重置周期；无论决策为何，积分都不可购买、提现、转赠或兑换。
13. 截图未明确“吃（chi）”是否允许；当前代码中的 `chi` 只是占位动作，不能当作宿松麻将规则事实。
14. 楼层是规则模板、自动开空桌，还是管理员预建固定桌；房间号/邀请码、同时房间数、回收和跨楼层加入策略。

### 8.4 结算接口（先抽象后落公式）

```ts
type RoundSettlement = {
  matchId: string;
  roundId: string;
  ruleId: string;
  ruleVersion: string;
  handCategory?: 'small_win' | 'big_win' | 'draw';
  winMode?: 'self_draw' | 'discard' | 'draw';
  legs: Array<{
    winnerIds: string[];
    payerIds: string[];
    deltaByPlayer: Record<string, number>;
    reasons: Array<{ code: string; units: number; value: number }>;
  }>;
  deltaByPlayer: Record<string, number>;
  algorithmVersion: string;
};
```

服务端根据牌局状态重算结果，绝不接受客户端上传的分数。首版默认检查 `Σ deltaByPlayer = 0`；若规则确实产生系统项，必须显式记录系统账户和原因。流局记录 `roundStatus=draw`、分数变化为 0，花奖是否保留杠分需规则确认。纠错只能追加反向分录并审计，不能修改历史分录。

## 9. 房间、回合与状态机

### 9.1 状态

```text
LOBBY/WAITING
  → READY
  → DEALING
  → PLAYING
  → ROUND_SETTLING
  → NEXT_ROUND ──(未达到局数)──> DEALING
  → FINISHED

任意可解散状态 ──> CANCELLED/DISBANDED
```

每个状态转移由服务端校验，并生成不可变事件。房间包含 `roomId`，整场包含 `matchId`，每局包含 `roundId`；每局保存 `dealerSeat`、规则快照、随机种子承诺、牌墙状态、回合截止时间和事件序号。

### 9.2 关键命令

| 命令 | 状态 | 权限/校验 |
| --- | --- | --- |
| `room.join` | WAITING | 已登录、满足 `roomAccessPolicy`、楼层授权、空座位 |
| `room.leave` | WAITING/READY | 非开始状态或规则允许退出 |
| `room.ready` | WAITING/READY | 本人座位、未封禁、状态合法 |
| `room.start` | READY | 房主、人数/准备数满足、楼层有效、计费策略可执行 |
| `game.action` | PLAYING | 本人回合、动作 schema、牌面合法、版本匹配 |
| `room.disband` | WAITING/PLAYING | 房主/管理员及解散规则；触发退款/不扣费策略 |
| `room.reconnect` | 任意 | access/session、房间访问策略、`lastRoomVersion` 校验 |

### 9.3 断线策略

socket 关闭后标记 `disconnectedAt`，建议保留 60～120 秒宽限；是否托管、跳过、自动出牌或解散由规则配置和产品确认决定。回合倒计时由服务端继续。宽限结束后生成 `PLAYER_TIMEOUT` 事件，不直接删除历史玩家。

## 10. 实时协议（WSS）

### 10.1 统一消息封装

客户端命令：

```json
{
  "v": 1,
  "requestId": "req_01J...",
  "commandId": "cmd_01J...",
  "sessionId": "ses_01J...",
  "type": "game.action",
  "roomId": "rm_7f3a2c1d",
  "expectedRoomVersion": 128,
  "clientSeq": 42,
  "payload": { "action": "discard", "tile": "wan_5" }
}
```

连接建立后先发送 `hello/auth` 首帧，或使用受保护的 Authorization 握手头。服务端验证 access token、设备和 session 后才允许订阅房间。重连 token 只在短期窗口内有效并可轮换；token 不进入 URL、日志或邀请链接。

服务端事件：

```json
{
  "v": 1,
  "type": "room.event",
  "eventId": "evt_01J...",
  "roomId": "rm_7f3a2c1d",
  "matchId": "mt_...",
  "roundId": "rd_...",
  "roomVersion": 129,
  "serverTime": "2026-08-28T10:00:00.000Z",
  "event": "ACTION_ACCEPTED",
  "payload": {}
}
```

### 10.2 ACK、错误和同步

- 成功命令返回 `command_ack(requestId, commandId, accepted, roomVersion)`；不再另设语义不同的 `eventVersion`。
- 同一 `commandId` 重试必须返回同一结果，不得重复出牌、结算或扣钻。
- 版本过旧返回 `VERSION_CONFLICT`，客户端重新请求快照。
- 事件缺口、事件窗口过期或新版本不兼容时返回 `sync_required`，顺序为：鉴权 → 快照 → 增量事件 → 客户端 ACK。
- 公共状态与私有牌面分离；手牌、摸牌等敏感信息只发给对应玩家。

文档统一使用 `roomVersion` 作为房间级单调版本；若存储层使用 `game_events.seq`，它必须就是该房间的同一序列，禁止维护两个语义不同但容易混淆的版本号。快照包含 `roomVersion`、`snapshotHash` 和生成时间；客户端校验 hash 后再应用增量。

建议错误码：`AUTH_REQUIRED`、`AUTH_INVALID`、`AUTH_EXPIRED`、`FORBIDDEN`、`CLUB_MEMBERSHIP_REQUIRED`、`CLUB_APPLICATION_PENDING`、`FLOOR_NOT_FOUND`、`RULE_VERSION_UNSUPPORTED`、`DIAMOND_INSUFFICIENT`、`ROOM_NOT_FOUND`、`ROOM_FULL`、`ROOM_NOT_JOINABLE`、`SEAT_OCCUPIED`、`NOT_ROOM_OWNER`、`NOT_YOUR_TURN`、`INVALID_ACTION`、`VERSION_CONFLICT`、`DUPLICATE_REQUEST`、`RECONNECT_TOKEN_INVALID`、`ROUND_FINISHED`、`RATE_LIMITED`、`RETRYABLE`、`INTERNAL_ERROR`。

### 10.3 心跳与连接安全

使用 `ping/pong` 和服务端超时检测；token 不放 URL，WSS 握手使用短时 access token。原生客户端可能不发送浏览器 `Origin`，因此采用设备会话/握手签名和受信任客户端标识校验，不能简单依赖 Origin 白名单。限制单消息大小、每用户连接数、命令频率和广播队列；配置 TLS、反向代理超时、背压和优雅下线。

## 11. REST API v1 草案

API 前缀：`/api/v1`；所有写请求带 `Idempotency-Key` 或 `requestId`。响应统一包含 `requestId`、`data` 或 `error`。

### 11.1 认证与用户

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/auth/otp/send` | 发送验证码（供应商待定） |
| POST | `/auth/login` | 登录并返回 access/refresh |
| POST | `/auth/refresh` | 刷新 access token |
| POST | `/auth/logout` | 撤销当前会话 |
| GET | `/me` | 当前用户与权限 |
| POST | `/me/deletion-request` | 发起异步账号注销流程（冷静期/留存策略由合规方案确定） |
| GET | `/rules` | 可见规则及版本 |

### 11.2 俱乐部、楼层和房间

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/clubs/applications` | 创建/加入申请 |
| GET | `/clubs/applications` | 我的申请 |
| GET | `/clubs` | 我加入/可见俱乐部 |
| GET | `/clubs/:clubId` | 俱乐部详情 |
| POST | `/clubs/:clubId/members/apply` | 申请加入 |
| POST | `/clubs/:clubId/members/:userId/approve` | 管理员通过 |
| POST | `/clubs/:clubId/members/:userId/reject` | 管理员拒绝并填写原因 |
| PATCH | `/clubs/:clubId/members/:userId/role` | 调整成员角色 |
| GET/POST | `/clubs/:clubId/floors` | 查询/新增楼层 |
| PATCH | `/clubs/:clubId/floors/:floorId` | 创建新规则版本并编辑元数据 |
| POST | `/clubs/:clubId/floors/:floorId/disable` | 停用楼层 |
| GET | `/clubs/:clubId/floors/:floorId/rule-versions` | 规则版本历史 |
| POST | `/rooms` | 按楼层创建房间并执行权限/计费策略 |
| GET | `/rooms/:roomId` | 房间公共快照 |
| POST | `/rooms/:roomId/join` | 加入/选座 |
| POST | `/rooms/:roomId/leave` | 离开 |
| POST | `/rooms/:roomId/ready` | 准备 |
| POST | `/rooms/:roomId/start` | 开始（WS 也可用） |
| POST | `/rooms/:roomId/disband` | 申请/执行解散 |

### 11.3 战绩、客服和后台

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/me/matches` | 我的牌局分页 |
| GET | `/matches/:matchId` | 整场结果和单局分录 |
| GET | `/matches/:matchId/replay` | 回放事件（P1、权限过滤） |
| GET | `/clubs/:clubId/records` | 俱乐部战绩 |
| POST | `/support/tickets` | 提交客服工单 |
| GET | `/support/tickets` | 我的工单 |
| GET/POST | `/support/tickets/:id/messages` | 查看/回复工单 |
| POST | `/admin/diamonds/grants` | 后台人工发放（禁止客户端调用） |
| POST | `/admin/diamonds/adjustments` | 后台调账/冲正 |
| GET | `/admin/diamonds/ledger` | 钻石流水 |
| POST | `/admin/clubs/:id/approve` | 平台审批俱乐部 |
| POST | `/admin/rule-versions` | 发布规则版本 |
| GET | `/admin/audit` | 审计查询 |

产品和代码中统一使用 `grantDiamonds`/`adjustDiamonds`，不注册 `payment`、`recharge`、`withdraw`、`cashout`、`transfer` 等客户端路由。

## 12. 数据模型与账本

### 12.1 核心表

```text
users
sessions / devices
clubs / club_members / club_applications
floors / floor_rule_versions
rooms / room_players
matches / rounds / round_participants
game_events / game_snapshots
round_settlements / match_results
score_ledger
diamond_accounts / diamond_ledger
support_tickets / support_messages
admin_audit_logs / outbox_messages
```

关键约束：

- 所有业务主键使用不可猜测 ID；外部房间号与内部 ID 分离。
- `floor_rule_versions` 发布后不可变；房间保存完整 `rule_snapshot`。
- `game_events` 以 `(room_id, room_version)` 唯一；事件追加写，不覆盖。
- `score_ledger` 与 `diamond_ledger` 分开，禁止互相兑换。
- `score_ledger` 是牌局结果分录，不是平台钱包余额：积分只在本场/俱乐部战绩中展示，不可购买、提现、转赠、兑换或用于支付非牌局服务。
- `diamond_ledger` 必须有 `operator_id`、`approval_id`、`reason`、`before_balance`、`delta`、`after_balance`、`idempotency_key`、时间和关联房间/俱乐部。
- 纠错用反向流水，不删除、不原地修改。

### 12.2 钻石计费流程

建议流程（最终时机由 Q 决策）：

1. 创建房间时校验房间所属楼层、成员权限和预计费用。
2. 开始游戏前以 `billing_intent` 原子**预占（reserve）**费用，防止并发多开房间超扣；不在客户端扣费。
3. 第一局结算成功后，以幂等键将预占转为 **consume**；截图中的“首局结算后扣除”是 S，需确认。
4. 提前解散或开局失败按已确认策略 **release/冲正**；余额不足时阻止开始或进入待处理状态，不能产生负余额。
5. 向房间成员广播扣费结果，但不广播后台操作细节。

`billing_intent` 状态建议为 `CREATED → RESERVED → CONSUMED`，异常路径为 `RELEASED`/`REVERSED`；每次转移带同一幂等键、房间/局号和账本事务引用。

截图中的 `×6` 仅为示例配置，不能写成固定单价。后台发放/调账需要双人复核、MFA、操作原因和完整审计；客户端只读余额和消耗记录。

钻石归属和费用承担必须在 Q 清单中锁定：推荐数据模型支持 `ownerType=user|club`，但不在未确认前写死。数据流必须能回答：谁发起、谁审批、从哪个账户扣、扣了多少、余额前后值、关联哪一局、失败如何重试、提前解散如何冲正。管理员不能通过普通客户端接口代扣或改账。

## 13. 战绩、回放与可观测性

每局保存：规则 ID/版本、规则快照 hash、玩家座位、动作事件、结算明细、累计积分、服务器时间和算法版本。回放读取事件并按版本重放，权限过滤私有牌面；规则升级不能改变历史结果。

发牌随机数使用服务端 CSPRNG；可采用“服务器先提交 seed hash、牌局结束后公布 seed/算法版本”的可审计承诺方案，但不得向客户端泄露未结束牌局的牌墙。回放校验 seed、规则版本、事件序列和快照 hash，发现 divergence 时阻断自动出具结果并告警。

核心指标建议：

- WSS 连接数、认证失败率、房间事件 P50/P95 延迟。
- 重连成功率、同步快照耗时、事件缺口和重复命令率。
- 非法动作率、房间版本冲突、结算零和失败数。
- 钻石账本不平衡、扣费失败/重试、客服首响和关闭时长。
- 崩溃率、ANR、首屏耗时、三端安装/升级失败率。

## 14. 客服功能

### 14.1 客户端

大厅、俱乐部和牌桌均提供“联系客服”。提交表单包含问题类型、描述、房间号/局号（可选）、客户端版本和附件；敏感信息脱敏。客户端展示工单状态：`OPEN`、`ASSIGNED`、`WAITING_USER`、`RESOLVED`、`CLOSED`。

### 14.2 后台

客服可以分配、回复、添加内部备注、关联房间事件并升级给运营/技术；所有查看和下载附件操作写审计。首版建议内置工单，外部电话/企业微信/在线客服渠道作为可插拔配置，避免依赖支付或第三方交易页面。附件须校验 MIME/大小、病毒扫描后进入私有对象存储，使用短期签名 URL 和留存期限；不得在工单或分析 SDK 中采集完整牌面、手机号、token 等非必要敏感信息。

## 15. 安全、反作弊与合规门槛

- 仅 HTTPS/WSS；密钥放 Secret Manager，禁止提交仓库。
- access token 短时有效，refresh token 轮换并可按设备撤销；管理员强制 MFA。
- 校验 JSON Schema、浏览器 Origin/原生设备握手、消息大小、频率、房间权限和版本；限流、WAF、IP/设备风控按法务确认实施。
- 随机数、发牌、动作合法性、计分和钻石全部服务端执行；客户端上传的分数、牌墙和胜负结果一律不信任。
- 支持同账号多设备策略（建议新登录踢旧连接或旧连接只读），避免旧 socket 关闭误删新会话。
- 敏感牌面只发给对应玩家；日志不得记录完整手牌、验证码或 token。
- 提供举报、封禁、申诉、账号注销、隐私政策、用户协议和数据删除/导出流程。
- 账号注销采用异步申请、冷静期、会话撤销和可审计的数据删除/匿名化流程；不能用一次 `DELETE /me` 直接绕过账务、战绩和法定留存要求。
- “不提供充值”不等于自动合规：钻石仍是虚拟道具。上线前由法务核验实名、未成年人/防沉迷、个人信息保护、网络游戏运营/出版、APP 备案、商店政策及适用牌照；文案不得出现现金赌博、提现或现金奖励暗示。本段仅是上线前评审清单，不构成法律意见或合规结论。

## 16. 部署、环境与发布

### 16.1 环境

`dev`、`staging`、`prod` 使用独立数据库、Redis、密钥、包名和推送配置。后端 Node 20 容器化，前置 API Gateway/反向代理，在 443 提供 HTTPS/WSS。PostgreSQL 为事实来源，Redis 仅存在线状态、短期房间状态、锁和发布订阅。

本地开发环境按 [OPS-101 本地环境手册](deployment/LOCAL-ENV.md) 操作：复制
`.env.example`，用 Docker Desktop/Colima 启动 `infra/docker-compose.dev.yml` 的
PostgreSQL/Redis，按序应用迁移，并通过 `npm run verify:real` 在临时数据库中验证真实
adapter。手册同时给出明确的 stop/down、卷清理和隔离数据库备份/恢复命令；备份文件
默认放在 `.local-backups/`（已加入 `.gitignore`）。这些步骤只证明开发/演示基线，
不替代生产密钥管理、异地备份、恢复审批或 RPO/RTO 演练。

在同一环境中可进一步运行 `npm run verify:multi-instance`，它使用两个独立的
PostgreSQL pool 和 Redis client，验证重复命令幂等、并发房间写入、连续
`roomVersion`、outbox 数量及 actor/durable `snapshotHash` 收敛。该脚本是开发 smoke，
不等同于生产进程编排、滚动重启或故障演练。

### 16.2 高可用与灾备

优雅下线顺序：停止新连接 → 通知客户端维护事件 → 持久化/迁移房间 actor → 关闭进程。事件采用 outbox；数据库定期备份并演练恢复。初始建议目标 RPO ≤ 5 分钟、RTO ≤ 30 分钟，正式数值由业务确认。

### 16.3 CI/CD

```text
lint/typecheck → server unit/property tests → protocol contract tests
→ rule replay/golden cases → dependency/secret scan → Docker build
→ Android AAB → iOS archive/TestFlight → Harmony HAP/HSP
→ artifact signing/SBOM/checksum → staging smoke → 人工批准生产
```

签名证书、Provisioning Profile、Huawei/Google 密钥只能在受保护 CI runner 中使用。每次发布生成 manifest：git SHA、协议版本、客户端最小版本、规则包版本、API endpoint、构建号和产物校验和。生产灰度建议 5%→25%→100%，后端至少兼容相邻两个协议版本。

### 16.4 三端发布验收

- Android：ARM64 低/中/高端设备，基线 API 和最新两版；AAB 内测后再生产。
- iOS：基线 iOS 与最新两版、近两代 iPhone/iPad；TestFlight 后提交商店。
- 鸿蒙：HarmonyOS NEXT 目标 API 的主流真机/模拟器，HAP/HSP 和 AppGallery Connect 内测；是否兼容旧鸿蒙或另发 APK 由评审决定。

## 17. 测试与验收标准

### 17.1 自动化测试层级

1. 规则单元测试：牌组、补花、吃碰杠胡、花朵、庄、流局、每种结算腿。
2. 属性测试：四人分数守恒、动作合法性、事件序号单调、同命令幂等、规则快照不可变。
3. Golden cases：规则负责人签字后的逐条结算样例，固定随机种子和预期事件/分数。
4. 协议契约测试：REST/WS schema、错误码、客户端生成类型和版本兼容。
5. 集成测试：PostgreSQL/Redis、事务 outbox、服务重启恢复、多实例同房串行。
6. 弱网测试：丢包、延迟、乱序、重复、Wi-Fi/蜂窝切换、锁屏、杀进程、滚动发布。
7. 安全测试：越权、重放、限流、Origin、敏感牌面泄漏、后台账本双审。
8. 三端 UI/真机测试：安装升级、深色模式、安全区、无障碍、推送和客服附件。

### 17.2 P0 验收案例

- 同一 `commandId` 重复提交只产生一个事件、一次结算和一次扣钻。
- 两个并发 `room.start` 仅一个成功，另一个返回版本冲突或重复结果。
- 旧 `expectedRoomVersion`、非法牌、非回合玩家、非成员和余额不足均被拒绝。
- 断线后以 `lastRoomVersion` 恢复完整公共状态和本人手牌，不重复扣分。
- 新 socket 建立后，旧 socket 的 close 事件不能删除新会话映射。
- 服务重启后房间/回合/战绩可从持久化数据恢复。
- 楼层规则发布新版本后，进行中房间仍使用原 `ruleSnapshot`；历史回放结果不变。
- 四人积分按规则守恒；流局产生 0 分（若最终规则另有系统项则显式记录）。
- 客户端所有页面、深链和接口均不存在充值、支付、提现、现金兑换或转赠入口。
- 俱乐部申请、审批、楼层编辑、钻石发放和客服处理均能查到操作者、时间、原因和前后值。

### 17.3 建议初始 SLO（可调整）

普通网络首屏 ≤ 2 秒；重连同步 ≤ 3 秒；房间事件 P95 ≤ 200 ms；无异常会话率 ≥ 99.5%；10,000 次规则回放 0 divergence；正式阈值需压测和运营评审确认。

## 18. 里程碑与实施顺序

| 阶段 | 周期建议 | 交付物 | 退出条件 |
| --- | --- | --- | --- |
| M0 规则/协议/客户端 POC | 1～2 周 | P0 规则确认单、JSON Schema、三端框架 POC | 三端安装、WSS、前后台重连通过 |
| M1 账号/大厅/实时骨架 | 3～4 周 | Auth、Lobby、Room actor、快照/增量、基础牌桌 | 四人房弱网同步和重连通过 |
| M2 宿松麻将裁判 | 4～6 周 | 完整牌组、动作、结算、golden cases、回放 | 规则负责人签字，规则测试全绿 |
| M3 俱乐部/楼层/钻石/战绩/客服 | 3～4 周 | 审批、RBAC、楼层版本、双账本、工单 | 越权、幂等和审计验收通过 |
| M4 三端发布与合规 | 2～3 周 | 压测、灾备、商店包、隐私和法务材料 | 真机矩阵、灰度和上线门槛通过 |

建议首批工程任务：

1. 已将 WSS 房间命令接入 BE-202 `RoomActor`，统一持久化成功后的 ACK/广播；BE-204 已具备 snapshot/delta reconnect、`sync_required`、重连宽限、snapshot hash、显式 deadline、durable room inventory、`DeadlineStore` claim/lease、presence overlay 和异步 PostgreSQL/Redis 装配，Flutter POC 已完成 CL-202 outbox 与 CL-203 重连 UI；BE-207 纯文本客服 REST 已完成；`npm run verify:real`、`npm run verify:multi-instance` 已通过真实本地 PG/Redis smoke，下一步是生产滚动重启/故障演练、CL-201 真实 WSS/设备验收和 CL-204 REST 联调。
2. 已建立 OpenAPI/AsyncAPI YAML 解析、引用、状态码和 wrapper 契约测试；后续继续生成 `packages/protocol` 各端模型。
3. 完成 Auth、Club、Floor、Diamond Ledger 的数据库迁移。
4. 与规则负责人完成 P0 规则确认及 golden cases。
5. 在 fake-rule 聚合之上接入真实宿松 Rule Engine，用已签字动作/牌型替换当前占位式 `applyAction` 轮转。

## 19. 当前骨架与目标系统差距

| 当前实现 | 风险 | 目标改造 |
| --- | --- | --- |
| 进程内 WSS `rooms/clients` | 已接入内存 RoomActor；异步工厂可装载 PostgreSQL/Redis，deadline 已有持久化 claim/lease，真实 adapter smoke 已通过，但重启/多实例服务仍未完成验证 | 完成 presence 多实例一致性、最终 snapshot hash、重启和故障演练 |
| `login` 接受任意 playerId | 冒用账号、旧连接竞态 | OTP/会话/JWT/设备撤销 |
| 未登录也可建房/操作 | 完全越权 | 中间件鉴权和资源 RBAC |
| BE-202/203 内存 event store/RoomActor/WSS 契约 | 已验证恢复/幂等/回滚、ACK/广播、私牌过滤和连接替换，但仍是单进程 adapter | PostgreSQL 条件版本写 + Redis fencing + 多实例故障验证 |
| fake-rule `applyAction` 仍为占位轮转 | 不能判宿松牌型、不能正式结算 | 已签字规则后的 Rule Engine + action schema |
| 无 round/wall/dealer/deadline | 无法实现完整麻将 | 每局实体、牌墙和服务端计时器 |
| 内存事件窗口非持久事实来源 | 进程重启后无法回放/恢复 | PostgreSQL 事件存储、快照和保留策略 |
| `ruleRegistry` 未接入 | 任意字符串规则 | 规则版本注册、schema 和插件接口 |
| 无分数/钻石账本 | 无法审计和恢复 | 两本追加式账本、幂等事务 |
| 无 TLS/限流/心跳/监控 | 不能生产部署 | Gateway、安全基线和观测 |

## 20. 决策记录与待确认清单

### 20.1 必须先决（P0）

- 牌组、人数、首局庄、完整胡牌和计分公式。
- 花奖/出增/强飘/三西/无花果/过圈的定义和叠加顺序。
- 底分单选还是多选；截图勾选 5/6/7/8 的真实含义。
- 钻石费用、扣费时机、截图 `×6` 是否为示例、提前解散和余额不足策略。
- 俱乐部创建申请与加入申请的审批主体、管理员层级和楼层权限。
- 登录方式、实名/地区/年龄和未成年人策略（由产品与法务确认）。

### 20.2 可并行确认（P1）

- 客服渠道（内置工单、在线客服、电话或企业微信）。
- 是否支持回放、观战、托管、换桌、聊天、邀请链接和推送。
- 同账号多设备策略、断线宽限时长和超时默认动作。
- 客户端框架最终选择及 HarmonyOS 兼容版本。

### 20.3 后续增强（P2）

- 排行榜、分享、活动、运营报表、多语言、更多麻将和扑克。

### 20.4 决策记录模板

每个 Q 项在进入实现前填写一行，并将对应 golden case 加入版本库：

| 决策编号 | 需求/规则 ID | 决策内容 | 负责人/日期 | 生效版本 | 示例输入/输出 | 回归用例 |
| --- | --- | --- | --- | --- | --- | --- |
| DEC-____ | R-___ / REQ-___ | TBD | TBD | TBD | TBD | TEST-___ |

每项 Q 都要在决策表中补充：决策编号、负责人、日期、规则版本、示例输入/输出和回归测试用例。未决策项在客户端显示为“规则待确认”，不能由客户端自行解释。

## 附录 A：截图内容转录（仅 S，不是已签规则）

### A.1 配置弹窗

可读内容包括：游戏局数 4/8/16；选择底分 1～9；出增分数“不出增/1/2/3/5”；是否强飘“强飘/不强飘”；是否必胡“必胡/不必胡”；示例画面显示 16 局、出增 2 分、不强飘、必胡，并显示消耗钻石 `×6`。注释写有“开始游戏后第一局结算后扣除，提前解散不扣除钻石”。

“底分”画面同时高亮 5、6、7、8，无法确认是多选、残留勾选还是截图状态异常；不能直接实现为固定单选或固定多选。

### A.2 玩法说明

截图可读的候选文字：


1. 上一局最先胡牌者为庄；流局上一局庄家继续坐庄。
2. 红中、发财、白板、红花、黑花均为花牌，抓到后可发花（补花）；有花奖时其他三家扣分，花奖按底分第二档记分，可累加；花奖者放冲取消花奖；流局取消花奖。
3. 无花果（没有花牌）不能胡其他人的牌，只能自摸；无花果放冲即为“一察/一素”（截图术语/数值待核对）。
4. 三西（三道）时两个输赢关系翻倍，胡了其他玩家也要跟放冲者一起扣分。
5. 放冲者一人扣分；一冲 2 或 3 家同时扣分；自摸时其他三家同时扣分。
6. 选择“不出增”默认都可以有花奖；选择出增大小后，不出增者无花奖。
7. 中途可以加增，不能减少增（限一次开房周期）。
8. 明杠算 1 朵花，暗杠算 2 朵花；碰风牌（含手上）算 1 朵花；明杠风牌算 2 朵花；暗杠风牌算 3 朵花。
9. 剩 14 张牌仍无人胡为流局，不计分。
10. 必胡模式下他人点炮系统默认自动胡；不必胡模式下可选择胡任意玩家的牌或自摸，但必须“过圈”。
11. 胡牌类型候选：小胡为 1～4 朵花，大胡为 5～9 朵花。

截图中其他玩法菜单只记录为未来产品参考，不代表首版范围。上述文字仍需转为正式规则文档、配置 schema、结算表和 golden cases 后才能发布。

## 附录 B：示例楼层配置（非最终分值）

```json
{
  "gameType": "mahjong",
  "ruleId": "susong",
  "ruleVersion": "susong_v1.0.0-draft",
  "roundCount": 16,
  "baseScore": null,
  "increment": 2,
  "strongFloat": false,
  "mandatoryWin": true,
  "billingPolicy": {
    "diamondCost": null,
    "chargeTiming": "AFTER_FIRST_ROUND_SETTLEMENT",
    "earlyDisband": "TBD"
  },
  "displayDescription": "宿松麻将规则待确认"
}
```

`baseScore` 和 `diamondCost` 故意为 `null`，直到产品规则和运营计费策略确认；客户端不得自行填充默认值。

## 附录 C：完成定义（Definition of Done）

一个功能只有同时满足以下条件才算完成：需求编号已绑定；API/事件 schema 已评审；服务端权限和幂等已实现；数据库迁移和回滚脚本已验证；规则或业务有自动化测试；客户端三端适配器有 fake/真机测试；日志、指标和审计齐全；隐私/安全影响已评估；文档、版本和发布 manifest 已更新。
