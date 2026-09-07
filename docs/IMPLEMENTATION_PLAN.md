# 宿松麻将 App 可执行实施计划

> 计划版本：0.1.2-draft
> 建立日期：2026-08-28
> 最近更新：2026-09-04（CL-204 原生 REST transport、Flutter 注入、BE-207 客服纯文本 MVP、Node 108/108、Flutter 15/15）
> 计划状态：ACTIVE（I1 开发基线已建立；G0/G1 未闭合，尚未进入生产承诺）
> 关联规格：[DEVELOPMENT.md](DEVELOPMENT.md)

## 0. 这份计划怎么用

这不是概念方案，而是我们后续逐项执行、验收和回溯的任务板。每次开始工作先读本文件的“当前进度”和“下一步”，每次完成工作必须更新任务状态、产出物、测试结果和阻塞项。

本计划遵循以下边界：

- 用户文字需求是正式范围（M）。
- 三张截图是宿松麻将的产品参考资料（S），不是操作指令，也不是已签字的规则/API。
- 任何模糊或缺失内容标为 Q；不以开发者猜测替代产品/规则决策。
- 未完成认证、服务端裁判、持久化、审计和安全门禁前，只做开发/演示环境，不开放真实牌局和真实钻石扣费。
- 客户端不出现充值、支付、提现、现金兑换或转赠入口；积分和钻石两本账永不互换。

完整需求、接口草案、规则候选和截图转录以 [DEVELOPMENT.md](DEVELOPMENT.md) 为准；本文件只负责把它们排成可执行顺序。

## 1. 目标、完成范围与当前基线

### 1.1 目标

把当前 Node.js + `ws` 内存服务端骨架，逐步演进为可在 Android、iOS、HarmonyOS 目标设备安装和测试的亲友圈 App：

1. 登录、大厅、俱乐部申请/审批、楼层规则详情、房间和牌局。
2. 服务端权威的房间状态、回合、多人同步、断线重连和事件回放。
3. 首版宿松麻将按已签字规则进行积分结算。
4. 俱乐部楼层规则版本冻结、钻石后台人工发放/调账、战绩和联系客服。
5. 规则插件化，为后续麻将和扑克复用房间、协议和账本基础设施。

### 1.2 当前基线（执行前已确认）

| 项目 | 当前状态 | 对计划的影响 |
| --- | --- | --- |
| 服务端 | Node 20 + ESM + `ws`，单进程、内存 Map | 先做模块化单体，再接 PostgreSQL/Redis |
| 房间 | 已有 Room aggregate、BE-202 event store/actor/fencing/snapshot/outbox 契约、BE-203 WSS gateway/actor 纵切和 BE-204 PostgreSQL/Redis adapter；presence overlay、房间枚举、durable deadline claim/lease 与异步启动装配已接入，server 默认仍为内存；真实 adapter 与双实例开发 smoke 已通过 | 继续做生产运行时切换、滚动重启/故障演练和最终一致性压测，再接宿松裁判 |
| 规则 | `susong_v1` 占位，牌组/计分不完整 | 规则签字前禁止生产结算 |
| API | OpenAPI/AsyncAPI、JSON Schema 和 Node 校验器已建立；WSS 已接入 RoomActor、ACK/广播/订阅/重连，REST/BFF fake-staging 纵切已完成并纳入 YAML/ref/状态码契约检查 | 以 schema 为唯一协议源，继续扩 REST/WSS |
| 客户端 | 已有 framework-neutral Dart 协议/连接核心、原生 `dart:io` transport 和 Flutter mock 壳；CL-203 维护/版本冲突/前台恢复 UI 已通过本机测试；尚无三端真机包 | 完成 CL-201 多客户端验收、ArkUI/平台生命周期和真实设备/签名验证 |
| 数据 | PostgreSQL migrations、Redis Compose/health、repository contract 和 MemoryRepository 已建立；运行时仍为单进程内存 | 本地开发环境可复现，生产接入 PG/Redis 仍待后续任务 |
| 测试 | 当前 108 个 Node 测试通过；Dart 协议/原生 transport/四客户端 fake 夹具脚本通过；Flutter POC 15/15 通过；`verify:real` 与 `verify:multi-instance` 均通过 | 继续增加真实进程滚动重启、弱网和平台级故障测试 |
| 仓库 | 当前实际路径为 `宿松app.migrated-backup`；分支 `codex/be-101-protocol`，尚无提交 | 后续补充分支/提交策略，不清理未跟踪文件 |

### 1.3 时间假设

下表以一个主要开发者（我们共同推进）、兼职 QA/运维/产品决策支持为假设；周数是相对 kickoff 的估算，不是对日历日期的承诺。规则确认、开发者账号、真实设备或法务意见延迟时，顺延而不压缩安全/真机验收。

## 2. 执行规则（我们俩的协作协议）

### 2.1 角色

| 角色 | 在计划中的职责 |
| --- | --- |
| `USER/PM`（用户） | 产品范围、玩法/计分、俱乐部权限、钻石策略和优先级的最终确认；提供必要账号、设备和业务资料 |
| `AI/DEV`（助手） | 代码、迁移、协议、测试、文档、脚本、诊断和可复现验证；不擅自决定 Q 项 |
| `BOTH` | 评审方案、运行验收脚本、确认 Gate、记录决策和变更 |
| `OPS/LEGAL/QA` | 若后续有对应人员，负责运营、法务、独立测试；没有时由用户指定替代人，不默认视为已批准 |

### 2.2 状态和任务编号

- `TODO`：未开始。
- `IN_PROGRESS`：当前正在做，任意时刻原则上只保留一个主任务。
- `BLOCKED`：缺少外部决策/账号/设备或发现高风险，必须写明解除条件。
- `DONE`：满足 DoD，并有测试/证据链接。
- `DEFERRED`：明确移到后续版本，不等同于完成。

任务编号约定：`DEC-*` 决策、`BE-*` 后端、`CL-*` 客户端、`QA-*` 测试、`OPS-*` 运维/发布、`DOC-*` 文档。每个 PR/变更尽量只覆盖一个任务或一组紧密任务。

### 2.3 Definition of Ready（进入开发前）

一个任务至少具备：

1. 绑定 `REQ-*`/`R-*` 编号和来源等级（M/S/Q/D）。
2. 明确输入、输出、权限、异常、幂等和回滚策略。
3. API/WS schema、数据字段或状态机已写出；至少有 3 个验收样例。
4. 依赖任务已完成，或明确使用 fake/sandbox/feature flag。
5. 指定 DRI、目标版本、风险和停止条件。

P0 Q 未签字时，任务只能产出接口、模拟器、测试夹具或关闭的 draft 功能，不得把默认值写成生产规则。

### 2.4 Definition of Done（交付前）

除非任务明确标注为文档/POC，否则必须同时具备：

- 实现代码和可回滚的迁移/配置变更。
- 服务端身份、权限、输入校验、幂等和审计。
- 单元测试、集成/契约测试，以及重复/乱序/弱网场景（适用时）。
- 日志、指标、错误处理和敏感字段脱敏。
- 本地或 staging 可复现运行命令、截图/日志/测试报告。
- 更新本计划、需求追踪矩阵、决策记录和已知限制。
- `USER/PM` 与相关规则/运营/QA 角色完成验收；未签字只能标 `DRAFT`。

### 2.5 任务卡与决策 SLA

每个任务卡除表格中的字段外，执行时补齐：`估时`、`实际耗时`、`风险`、`回滚方式`、`证据路径`。估时是容量规划，不是对工期的保证；每个小任务尽量控制在 0.5～2 个工作日、一个独立 PR 内。

决策会的默认 SLA：会后 24 小时内归档纪要和候选方案；参与者 48 小时内提出反对或补充证据；72 小时仍未收敛时升级给项目负责人。超过截止日期仍未决的事项只能使用 feature flag、sandbox、只读或假数据降级，严禁自行填默认分值、默认扣钻或默认审批。

## 3. 关键路径与并行路径

```text
G0 需求/证据/责任人确认
 ├─ W1-W2 客户端双候选 POC ───────┐
 ├─ I1 协议/Auth/DB/观测基础 ────┼─ G2 协议与实时基础冻结
 ├─ R-A 术语/牌组确认 ────────────┘
 └─ 产品/俱乐部/钻石决策

G2 → I2 Room actor/Event/WSS/重连 → G3 实时纵切
R-A → R-B 计分/边缘场景签字 → W5-W7 宿松规则裁判
产品决策 + 规则 schema → W8-W9 俱乐部/楼层/钻石
结算事件 → W10-W11 战绩/客服/后台
全部功能 → W12-W14 性能/安全/三端发布 → G5 Go/No-Go
```

可并行：协议/CI/观测、客户端 POC、规则资料整理、后台页面原型、合规资料收集。不可绕过的依赖：

- 没有 Auth，禁止任何房间命令进入 staging 以外环境。
- 没有规则 A/B 签字，只能使用 fake rule 或 draft simulator。
- 没有钻石账户归属/扣费决策，只能使用 ledger sandbox，不产生真实扣费。
- 没有房间规则快照，不能开放楼层编辑或历史回放。

## 4. 决策门与出口标准

### G0：启动与证据基线（D0，半天～1 天）

出口条件：

- 每个 M 需求都有 `REQ-*`、验收条件和责任人。
- 每个 P0 Q 都有 owner、截止日期、临时降级和解除证据。
- 明确截图只作为 S 级参考；截图中的示例账号、版本号、钻石余额不进入种子数据。
- 确认当前仓库路径、分支/提交策略、开发环境和沟通节奏。
- 通过“无支付/无提现/无现金兑换”范围检查。

### G1：客户端框架 POC（W1-W2）

出口条件：ArkUI-X/ArkTS 与 Flutter/OpenHarmony（或评审替代方案）至少完成候选样例；每个候选在 1 台 Android、1 台 iPhone、1 台 Harmony 真机完成：启动、登录假接口、WSS ping/pong、四人房事件渲染、断网/切后台后同步、客服表单 stub、安全存储。记录性能、插件、签名和上架风险，形成选型 ADR；不通过时保留共享 protocol/game-state，采用双壳方案。

### GR：宿松规则签字门（W1-W3，与 I1/I2 并行）

出口条件：规则负责人对牌组、人数、动作、庄/流局、底分、花奖、出增、强飘、三西/三道、无花果、必胡/过圈、胡型、结算和边缘场景完成书面确认；生成 `ruleVersion`、配置 schema、计分表和至少 20 个 golden cases。未通过时只允许 fake/draft rule，禁止生产结算和真实钻石扣费。

### G2：协议、认证和数据基础冻结（W3-W4）

出口条件：

- OpenAPI/AsyncAPI + JSON Schema 成为唯一协议源，生成各端模型。
- access/refresh/session、WS `hello/auth`、撤销和封禁可用。
- PostgreSQL/Redis 本地环境、迁移、健康检查、日志/指标可复现。
- 未登录命令统一 `AUTH_REQUIRED`；同账号新连接不会被旧 socket 删除。
- 协议契约测试、lint/typecheck/test、依赖/密钥扫描进入 CI。

### G3：功能完成（W8，必须通过 GR 和业务决策）

出口条件：

- 已签规则的牌组、动作、计分 golden cases 100% 通过；未签部分仍被 feature flag 隔离。
- 房间实时、断线重连、规则快照、俱乐部审批、楼层版本、钻石账本、战绩、客服均有实现和测试。
- P0 需求追踪矩阵 100% 可追溯；无开放 P0 缺陷。

### G4：发布候选（W9-W11）

出口条件：多实例/重启/弱网/安全/性能/备份恢复、Android/iOS/Harmony 真机安装升级、隐私与商店材料完成；无高危安全问题，所有已知限制和回滚路径已签字。

### G5：生产 Go/No-Go（W12-W14）

必须由产品、技术、规则、运营/法务（适用时）共同签字。任一 P0 未关闭、账本无法对账、牌局回放不一致、私牌泄漏、三端无法安装或商店/合规材料缺失，结果为 `NO-GO`，停止灰度并回到对应任务。

## 5. W0：启动与决策清单（当前第一阶段）

目标：把“能开始写代码”和“必须先问清楚”的事情分开。W0 不实现完整麻将，但要让后续每个任务有明确边界。

### 5.1 必须由用户/产品确认的 DEC 任务

| ID | 决策问题 | 影响 | DRI | 状态 |
| --- | --- | --- | --- | --- |
| DEC-001 | 正式项目目录是否继续使用 `宿松app.migrated-backup`，还是迁回/重命名为 `宿松app`？ | 构建、CI、路径和发布脚本 | USER | TODO |
| DEC-002 | 登录方式（手机号验证码/游客/第三方）、实名/地区/年龄边界 | Auth、合规、客户端首屏 | USER + LEGAL | TODO |
| DEC-003 | “俱乐部申请”是创建、加入，还是两者都需要？审批主体和状态 | Club/RBAC/后台 | USER/PM | TODO |
| DEC-004 | 会长、管理员、房主、成员的权限；成员邀请、踢人、解散 | Club/Room/审计 | USER/PM | TODO |
| DEC-005 | 楼层是规则模板还是固定桌；新房间何时冻结 `ruleSnapshot`；是否允许跨楼层加入 | Floor/Room/回放 | USER/PM | TODO |
| DEC-006 | 房间访问：`MEMBERS_ONLY`、`INVITE_ONLY`、`PUBLIC_CODE`；非成员能否受邀入桌 | Join/Reconnect/隐私 | USER/PM | TODO |
| DEC-007 | 积分生命周期：每场是否从 0 开始、是否跨场累计、负分/展示/重置 | Settlement/History | USER/PM | TODO |
| DEC-008 | 钻石账户归属（个人/俱乐部）、费用承担、单价和扣费时机 | Ledger/Room/运营 | USER + OPS | TODO |
| DEC-009 | 钻石余额不足、提前解散、开局失败、首局结算失败的 reserve/consume/release/reverse 策略 | 账本一致性 | USER + OPS | TODO |
| DEC-010 | 客服首版渠道、入口、附件类型/大小/留存和 SLA | Support/隐私 | USER + OPS | TODO |
| DEC-011 | HarmonyOS 目标边界：纯鸿蒙 NEXT、旧 Android 兼容层，目标 API/设备 | 暂缓；当前迭代只验收 Android+iOS | Client/发布 | USER + CL | DEFERRED（2026-09-04） |

### 5.2 规则确认任务（截图 S 仅作输入）

| ID | 必须确定的内容 | 产出 | DRI | 状态 |
| --- | --- | --- | --- | --- |
| DEC-RULE-001 | 人数/座位、牌组构成、风/箭/花牌数量、总牌数、初始手牌 | 牌组规范和牌 ID 表 | USER + RULE | TODO |
| DEC-RULE-002 | 吃/碰/杠/补花/抢杠/胡/过，以及多家同时胡优先级 | 动作和状态机规范 | USER + RULE | TODO |
| DEC-RULE-003 | 首局庄、多家胡、流局、剩余 14 张、杠后牌墙 | 回合/庄轮转表 | USER + RULE | TODO |
| DEC-RULE-004 | 底分 1～9 是单选、多选还是候选集合；底分第二档 | 配置 schema 和 UI 选择器 | USER + RULE | CONFIRMED（参考 APK：1～9 选 4 个递增档，默认 1/2/3/4） |
| DEC-RULE-005 | 花奖、花朵、杠花、出增、飘花、三西/三道规则 | 表驱动计分表与飘花状态机 | USER + RULE | IN_PROGRESS（飘花状态、自摸不升档、双方增值与三西末级翻倍已确认） |
| DEC-RULE-006 | 无花果及“一察/一素”标准术语、数值和触发 | 术语表/测试样例 | USER + RULE | CONFIRMED（APK 原文术语为“无花果”“一索”） |
| DEC-RULE-007 | 必胡/不必胡、“过圈”、超时默认动作 | 玩家状态/超时表 | USER + RULE | TODO |
| DEC-RULE-008 | 小胡/大胡、特殊胡型、≥9、封顶、舍入、零和/系统项 | 结算规范 | USER + RULE | TODO |
| DEC-RULE-009 | 4/8/16 局、出增中途加减、房周期边界 | 房间配置和回合策略 | USER + RULE | CONFIRMED（4/8/16 局；房周期内增可加不可减） |

### 5.3 W0 产出物

- [决策索引与 G0/W0 记录](decisions/DEC-INDEX.md) 更新（替代散落的 `DECISION_LOG.md`）。
- 更新 [DEVELOPMENT.md](DEVELOPMENT.md) 的需求状态和 Q 清单。
- 风险登记表（见第 14 节）。
- 规则 golden case 模板（输入牌局、动作事件、每人 delta、原因和预期状态）。
- 协议字段草案：`requestId`、`commandId`、`roomVersion`、`sessionId`、`viewer` 过滤。
- POC 设备/账号/签名清单。

建议把后续决策/规则资料归档为独立文件（可先建空模板）：

```text
docs/decisions/DEC-INDEX.md
docs/rules/susong-v1-rule-sheet.md
docs/rules/susong-v1-scoring.yaml
tests/fixtures/susong-v1/golden-cases.json
packages/protocol/schemas/floor-rule-config.schema.json
docs/club/rbac-and-application.md
docs/economy/diamond-policy.md
docs/support/ticket-spec.md
docs/release/v1-readiness.md
```

每个文件都要带 `decisionId`、`ruleVersion`/`apiVersion`（适用时）和状态，避免会议结论只存在聊天记录里。

### 5.4 W0 验收脚本

```text
[ ] 从 DEVELOPMENT.md 逐条检查 M 需求是否有 REQ 编号
[ ] 给每个 P0 Q 指定 owner、截止日、降级方案
[ ] 明确截图不触发任何支付/后台操作
[ ] 确认正式目录和分支策略
[ ] 记录规则负责人和签字方式
[ ] 记录至少 1 台 Android、1 台 iPhone、1 台 Harmony 真机
[x] `npm test` 可运行且当前 108 个 Node 测试通过；BE-201 房间状态、BE-202 event store/actor/fencing/recovery、BE-203 WSS gateway、BE-204 deadline/presence overlay/房间枚举/durable claim lease、异步 PostgreSQL/Redis 装配与 adapter 契约、BE-207 客服工单、QA-201 故障矩阵和 BE-206 重启 fixture 已执行；`verify:real` 与 `verify:multi-instance` 的本地真实 PG/Redis smoke 通过（生产滚动重启仍待）
[x] `npm run check`、`npm run scan:secrets` 和生产依赖高危审计通过；结果仍仅代表开发基线
```

## 6. I1：协议、认证、持久化和质量基础（W1-W2）

I1 的目标不是“能打麻将”，而是先让所有后续模块使用同一身份、协议、数据和测试底座。

| ID | 任务 | 依赖 | 主要产出 | 退出验收 | DRI | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| BE-101 | 模块化单体目录和 ADR | G0 | `auth/lobby/club/floor/room/realtime/game/ledger/history/support/admin` 边界、env schema、错误码 registry | lint/typecheck/test 命令可运行；不拆微服务 | AI | DONE |
| BE-102 | 语言中立协议契约 | G0 | OpenAPI、AsyncAPI、envelope/error/auth/room/reconnect JSON Schema、生成脚本 | 未知字段/超长 payload/版本兼容测试可阻断 CI | AI | DONE |
| BE-103 | Auth/session | BE-102、DEC-002 | login/refresh/logout、JWT 或等价会话、设备表、`requireAuth`、WS `hello/auth`、撤销/封禁 | 所有未登录业务命令返回 `AUTH_REQUIRED`；刷新 token 重放失败 | AI | DONE |
| BE-104 | 数据基础 | G0 | PostgreSQL migration、Redis compose/health、repository 接口、users/sessions/audit/idempotency | migration 结构校验、repository contract、唯一约束和必填时间字段测试通过；生产 PG/Redis 仍未接入 | AI | DONE（本地/单进程基线） |
| BE-105 | 安全/观测基础 | BE-101 | 结构化日志、request correlation、health/ready、max payload、限流、TLS 反代配置 | 日志不含 token/牌面；优雅关闭和健康检查可演示 | AI | DONE（单进程基线） |
| BE-106 | CI/质量门 | BE-101/102 | lint/typecheck/unit/contract、依赖/密钥扫描、Docker dev/staging、覆盖率门 | CI 能阻断失败变更；当前 108 个 Node 测试、OpenAPI/AsyncAPI YAML/ref 契约及质量命令通过 | AI | DONE（基础门） |
| CL-101 | 协议消费包 | BE-102 | framework-neutral Dart envelope/版本校验、错误映射、roomVersion reducer、连接状态 reducer | Dart fixture 可解析；重复/乱序/缺口触发 sync；状态转换和退避测试通过；最终三端生成模型仍待 | AI + CL | DONE（Dart 协议 POC） |
| CL-102 | 双候选最小壳 | G0 | Flutter POC 壳（共享 Dart 包、fake 登录、mock 房间、客服 stub）已建立；ArkUI-X/ArkTS 候选和平台适配待验证 | 本机 Flutter widget/build 通过；三端 debug 包可安装仍待 SDK/真机/签名 | AI + CL | IN_PROGRESS（Flutter POC） |
| CL-103 | 连接状态机 | BE-102 | framework-neutral `ClientSessionController`、传输接口、命令 outbox、扩展房间命令同步、重连/同步策略和原生 `dart:io` WebSocket adapter 已建立；平台生命周期钩子待接入 | Dart/Flutter 重连回归和原生 transport 集成脚本通过；token 过期、网络切换和三端后台行为仍待 | AI + CL | IN_PROGRESS（核心 + native transport POC） |
| QA-101 | 测试夹具和客户端模拟器 | BE-102 | Node 四客户端 realtime fixture、Dart/Flutter reducer fixture、重复/缺口检测已建立；延迟/丢包注入待扩展 | 基础顺序/重连/重复/缺口通过；完整延迟/丢包/乱序矩阵仍待 | AI + QA | IN_PROGRESS（基础 fixture） |
| OPS-101 | 本地环境手册 | BE-104/105 | `.env.example`、Docker 启停、数据清理/恢复命令、备份/恢复边界 | 新环境按 README 可启动，不提交 secrets；开发环境健康、迁移、adapter smoke 可复现 | AI | DONE（开发/演示手册；生产 DR 仍未完成） |

### I1 十个工作日建议节奏

| 日程 | 主任务 |
| --- | --- |
| D1 | BE-101、ADR、目录和错误码 |
| D2 | BE-102 schema/AsyncAPI |
| D3 | BE-104 migration/Redis |
| D4 | BE-103 REST login/refresh/logout |
| D5 | BE-103 WS hello/auth、连接替换 |
| D6 | 权限占位、审计、DEC 复核 |
| D7 | BE-105 health/log/metrics/limits |
| D8 | BE-106 contract/security tests |
| D9 | Docker/CI/恢复演练 |
| D10 | I1 演示、修复、G2 预审 |

### I1 已完成基线证据（截至 2026-09-02）

- Node 质量门：`npm run lint`、`npm run typecheck`、`npm run validate:protocol`、`npm run validate:contracts`、`npm run validate:migrations`、`npm test`（当前 108 个测试）和组合命令 `npm run check` 均通过；`npm run scan:secrets` 与高危依赖审计通过；`npm run verify:real` 与 `npm run verify:multi-instance` 均在本地 Colima 的真实 PostgreSQL/Redis 上通过。
- 安全/依赖门：`npm run scan:secrets` 通过，`npm audit --omit=dev --audit-level=high` 未发现高危漏洞。
- 运行基线：`docker compose -f infra/docker-compose.dev.yml config --quiet` 通过；`npm start` 可在 `127.0.0.1:8787` 启动开发 WebSocket 服务。
- 客户端协议/连接 POC：在 `clients/dart_protocol` 执行 `dart analyze`、`dart run tool/test.dart`、`dart run tool/io_transport_test.dart`、`dart run tool/multi_client_acceptance.dart` 和 `dart run tool/support_test.dart` 通过；`clients/flutter_app` 的 `flutter test`（15/15）和 `dart analyze` 通过，覆盖 envelope、协议主版本、扩展房间命令同步、重复/缺口同步检测、登录、命令 outbox、ACK/超时安全重试、断线重新鉴权、房间同步、维护/版本冲突/前台恢复、房间桌面座位/准备交互和 SupportApi 注入表单。尚无三端真机安装包。
- 数据边界：MemoryRepository 的必填 `expiresAt`、非法日期和时钟异常回归测试已补齐（BE-104 定向测试 7/7）；当前会话、房间、限流和指标仍是单进程内存实现。
- 以上证据只证明开发/演示基线；Flutter 壳仍只连接 `FakeTransport`，不代表 ArkUI 工程、三端安装包、正式身份供应商、生产 PostgreSQL/Redis、多实例裁判或真实钻石账本已就绪。

### I2 已完成/进行中纵切（BE-201～BE-205、BE-206/QA-201，2026-08-29）

- `src/domain/room.js` 已提供通用 Room aggregate：固定座位、房主、访问策略、ready、`WAITING → READY → DEALING → PLAYING → SETTLING → NEXT_ROUND/FINISHED/CANCELLED`、幂等 `commandId`、`expectedRoomVersion`、不可变 `ruleSnapshot`/hash、事件窗口和 reconnect sync。
- `src/modules/room/service.js` 与 `src/modules/room/http.js` 已完成 BE-205 内存/fake-staging REST/BFF：REST 与 WSS 共用 RoomActor/RoomService，支持 create/get/join/leave/ready/start/disband、ETag/If-Match、`Idempotency-Key`、统一错误 envelope 和鉴权/成员边界；生产数据库和多实例仍待。
- WSS 已接入 `leave_room`、`ready`、`begin_playing`、`settle_round`、`next_round`、`disband_room`；旧开发协议的 `start_round` 仅在 fake 流显式 auto-advance，不代表生产放宽准备校验。
- `test/be-201-room.test.js` 覆盖状态、权限、版本、幂等、快照、结算占位和 history window；BE-202 已补可替换内存事件存储、actor/fencing、重启恢复和 PostgreSQL schema，真实 adapter smoke 已纳入 `verify:real`，生产多实例仍留给后续任务。
- `test/be-202-event-store.test.js` 覆盖 append-only 连续版本、snapshot/hash、持久 command result、outbox、fencing、actor 串行、重启恢复和失败回滚；这些是内存 adapter 契约，不代表生产 PostgreSQL/Redis 已接入。
- `src/modules/realtime/gateway.js` 和 `src/server.js` 已完成 BE-203 WSS gateway 纵切：按房间复用 RoomActor，持久化成功后发送 `command_ack`，成功事件才广播，支持订阅/取消订阅、viewer-scoped 私有事件过滤、背压关闭、旧连接隔离、重连宽限、durable recovery、连续 `roomVersion` 广播队列和 late subscription live-feed cursor。
- `test/be-203-gateway.test.js` 及 QA-101 realtime fixture 已覆盖背压、权限、ACK/replay、重连/事件窗口、durable recovery、多设备、并发广播、私有事件过滤和 grace timer；BE-203 使用内存/单进程 adapter。
- BE-204 已具备基础 snapshot/delta reconnect：通过 actor 恢复并持久化独立 presence overlay，读取快照时按版本合并并重算 `snapshotHash`，返回事件窗口和 `syncRequired`，支持重连宽限；显式 `deadlineAt/deadlineMs + timeoutAction` 的服务端 deadline 已接入 storage-agnostic `DeadlineStore`，Memory/PostgreSQL claim/lease 适配器和 `game_deadlines` 迁移已补齐，调度器在 dispatch 前要求唯一租约。`npm run verify:real` 已在临时 PostgreSQL 数据库和 Redis 容器通过迁移、事件/快照恢复、deadline 租约接管和 fencing smoke；生产多实例服务、故障演练和最终一致性仍待深化。
- `test/qa-201-fault-injection.test.js` 已覆盖延迟、丢包、乱序和重复事件后的同步收敛，`BE-206` 重启 fixture 已验证 durable stream 与同一时刻 snapshot hash 一致；`BE-204` 新增了房间枚举后恢复 persisted turn deadline、共享 deadline store 唯一 claim、NOT_DUE 重试和租约接管的测试；`test/be-204-multi-instance.test.js` 与 `scripts/verify-multi-instance.mjs` 验证两个独立 actor/PG pool/Redis client 的幂等、并发、连续版本、outbox 和最终 snapshotHash；`test/be-207-support.test.js` 验证客服纯文本鉴权、隔离、幂等、审计和输入边界；当前所有 Node 测试 108/108 通过。

## 7. I2：房间实时纵切（W3-W4；最近验收 2026-09-04）

I2 使用确定性的 fake rule，不等待完整宿松计分；目标是证明四个已认证客户端能可靠地建房、同步和恢复。

| ID | 任务 | 依赖 | 主要产出 | 退出验收 | DRI | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| BE-201 | Room aggregate/状态机 | I1、DEC-004/005/006 | room/match/round/seat/player/ready、owner、访问策略；WAITING→READY→DEALING→PLAYING→SETTLING→NEXT_ROUND/FINISHED/CANCELLED | 非法状态、越权、重复 join/start 返回稳定错误码；BE-201 7 个用例通过 | AI | DONE（内存/fake-rule 纵切） |
| BE-202 | Event store + actor | BE-201 | append-only `game_events`、`(room_id,room_version)` 唯一、snapshot、Redis lock/fencing、outbox | 并发 start 只成功一次；重启可恢复；同 commandId 同结果 | AI | DONE（内存契约/actor；PG/Redis 接入待后续） |
| BE-203 | WSS gateway | BE-102/201 | subscribe、广播过滤、ACK/error、ping/pong、背压、连接替换、RoomActor 持久化边界、durable recovery | 四连接事件有序无重复；私牌不广播；旧 socket 不删新 session；成功写入才 ACK/广播 | AI | DONE（内存/单进程纵切） |
| BE-204 | Snapshot/delta reconnect | BE-202/203 | `lastRoomVersion`、snapshotHash、事件窗口、sync_required、重连宽限、显式服务端 deadline、presence overlay、PG/Redis adapter 装配、durable room inventory、deadline claim/lease | 丢包/乱序/重复/重启后同一时刻 hash 一致；房间枚举后能恢复并重新 arm deadline；同一 deadline 只能由一个租约执行；stale deadline 不得推进新回合；生产 adapter 事务和多实例验证通过 | AI | IN_PROGRESS（真实 adapter 与双实例开发 smoke 已通过；生产滚动重启/故障演练和长期压测待） |
| BE-205 | Room REST/BFF | BE-201 | room create/get/join/leave/ready/start/disband、ETag/If-Match/version、`Idempotency-Key` | REST 与 WS 命令权限和结果一致；错误 envelope、成员边界和重试幂等通过 | AI | DONE（内存/fake-staging；生产 adapter/多实例仍待） |
| BE-206 | 纵切故障测试 | 全部 I2 | fake rule + 四客户端 + fault injection + restart test | 基础房间可演示；尚不开放真实钻石/麻将计分 | AI + QA | DONE（fake-rule 基础） |
| CL-201 | 房间导航/桌面 beta | CL-101/103、BE-203 | 房间列表、座位、准备、公共状态、私牌占位、错误提示 | 4 个实例显示同一 roomVersion | AI + CL | IN_PROGRESS（4 客户端 framework-neutral fake 夹具通过；真实 WSS/设备验收待） |
| CL-202 | 命令 outbox/幂等 | CL-103、BE-204 | commandId 队列、ACK 后移除、超时安全重试 | 重试不产生重复事件；同步中禁操作 | AI + CL | DONE（Flutter/fake-staging POC） |
| CL-203 | 重连 UI | BE-204 | 连接状态、同步中、维护、版本冲突和手动重试 | 前后台/杀进程回前台可恢复 | AI + CL | DONE（Flutter 本机 POC；真实设备前后台/杀进程验收属于 G1） |
| QA-201 | 四客户端验收脚本 | 全部 I2 | 自动化/录屏脚本和事件对比器 | 顺序、版本、快照 hash、私有字段检查通过 | AI + QA | DONE（基础故障矩阵） |
| BE-207 | 客服纯文本 MVP | BE-103、DEC-010（渠道可先 TBD） | 工单创建/列表/详情/回复/关闭、房间号关联、基础审计 | 大厅/俱乐部/牌桌入口可用；纯文本首版不被外部渠道阻塞 | AI | DONE（内存/fake-staging；无附件/外部渠道） |
| CL-204 | 客服纯文本入口 | BE-207 | 三端客服入口、工单表单、状态和失败重试 | 未登录可看 FAQ/入口；登录后可提交并查询自己的工单 | AI + CL | IN_PROGRESS（共享 Dart SupportApi、原生 IoRestTransport 与 Flutter 注入已通过；真实端到端/三端适配待） |

### I2 十个工作日建议节奏

| 日程 | 主任务 |
| --- | --- |
| D1 | 状态枚举、room aggregate |
| D2 | seat/join/leave/ready/owner |
| D3 | start/disband、match/round 持久化 |
| D4 | event append/snapshot |
| D5 | actor/fencing/idempotency |
| D6 | WSS subscribe/broadcast/ACK |
| D7 | heartbeat/backpressure/connection replacement |
| D8 | snapshot/delta/reconnect/deadline |
| D9 | 四客户端故障和重启测试 |
| D10 | staging 演示、性能基线、G3 预审 |

## 8. 宿松麻将规则实现（W5-W7，必须在规则签字后进入生产）

### 8.1 规则任务

| ID | 任务 | 依赖 | 主要产出 | 验收 |
| --- | --- | --- | --- | --- |
| BE-301 | 牌组、牌 ID、CSPRNG/seed | DEC-RULE-001 | 牌组表、服务端随机、seed hash/算法版本 | 牌数/手牌/补花守恒，未结束牌墙不泄露；IN_PROGRESS（8931 客户端牌类/花牌 ID 已提取，精确牌墙待牌局样本） |
| BE-302 | `GameDefinition` + config schema | BE-102、DEC-RULE-001/004 | `susong` 插件、schema、版本注册 | 未知规则/配置拒绝；房间保存版本快照；IN_PROGRESS（`8931-apk-baseline.3` 配置、飘花状态机和服务端计分核心已实现） |
| BE-303 | 发牌、补花、牌墙、庄轮转 | DEC-RULE-002/003 | round state、dealer、wall、deadline | 固定 seed 重现；流局边界正确 |
| BE-304 | 动作合法性和优先级 | BE-303、DEC-RULE-002/007 | draw/discard/chi/peng/gang/hu/pass（以签字动作集为准） | 非回合/非法牌/过期动作拒绝 |
| BE-305 | 花/杠/增/飘/过圈状态 | DEC-RULE-005/006/007/009 | 玩家状态字段和事件 | 术语只使用已确认枚举；IN_PROGRESS（服务端飘花状态转换与胡牌资格纯规则已完成，待接入完整牌局状态） |
| BE-306 | 结算和两级积分账本 | DEC-RULE-004/005/008 | `RoundSettlement`、原因明细、累计战绩、零和/系统项策略 | 服务端重算；幂等；流局和多响样例通过；IN_PROGRESS（单赢家自摸计分、审计明细、三西关系翻倍和零和校验已实现） |
| BE-307 | 回放/确定性验证器 | BE-301~306 | 规则版本 + seed + event replay、snapshot hash | 历史规则重放不变，divergence 告警 |
| BE-308 | golden/property/fuzz tests | BE-301~307 | 至少 20 个签字 golden cases、属性测试和模糊测试 | 10,000 次回放 0 divergence（阈值最终确认） |
| CL-301 | 牌桌牌面和动作面板 | BE-302/304 | 手牌、公共牌、花/杠、可行动作、deadline | 只渲染服务端状态，不上传分数/牌墙 |
| CL-302 | 单局/整场结算页 | BE-306 | 每人 delta、原因、累计、规则版本 | 与服务端结果完全一致 |
| QA-301 | 规则验收包 | DEC-RULE 全部 | 牌局输入、事件、预期分数和截图/日志 | 规则负责人签字，未签项不进 production flag |

### 8.2 规则实现硬门禁

如果牌组、人数、底分第二档、花奖/出增/强飘/三西/无花果/过圈、钻石扣费或多家胡仍有未决项：

- 可以继续做接口、动画、fake rule、回放框架和测试夹具。
- 不得把 `susong_v1` 标为 production-ready。
- 不得在客户端帮助页把截图候选写成“最终规则”。
- 不得产生真实钻石扣费或不可逆账本操作。

## 9. 俱乐部、楼层和钻石账本（W8-W9）

### 9.1 俱乐部/楼层

| ID | 任务 | 依赖 | 主要产出 | 验收 | DRI | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| BE-401 | Club/application/membership/RBAC | BE-103、DEC-003/004 | create/join application、成员状态、OWNER/ADMIN/OPERATOR/MEMBER | 待审/拒绝不可进；审批幂等、拒绝有原因、有审计 | AI | TODO |
| BE-402 | Floor + immutable rule versions | BE-302、DEC-005 | draft→review→publish→disable、结构化 config + displayDescription | 发布后不可变；软停用；历史可查 | AI | TODO |
| BE-403 | 房间从楼层创建 | BE-201/402 | floorId、ruleId/version、完整 ruleSnapshot/hash | 编辑楼层不影响等待/进行中/历史房间 | AI | TODO |
| BE-407 | Club/Floor 集成测试 | BE-401~403 | 申请→审批→入会→选楼层→开房→改版脚本 | 越权、跨楼层、重启恢复全绿 | AI + QA | TODO |
| CL-401 | 成员/申请/楼层页面 | BE-401/402 | 申请状态、拒绝原因、楼层列表/详情 | 待审用户看不到受限房间；无支付文案 | AI + CL | IN_PROGRESS（横屏演示 UI、申请待审、楼层/6 桌与规则详情已完成；生产 API/RBAC 待） |
| CL-402 | 管理员楼层页面 | BE-401/402 | 新增/编辑/停用/发布规则版本、权限提示 | 客户端按钮与服务端权限一致 | AI + CL | TODO |

### 9.2 钻石账本

| ID | 任务 | 依赖 | 主要产出 | 验收 | DRI | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| BE-404 | diamond account + ledger | DEC-008/009、BE-104 | `ownerType=user` 或 `club` 可配置、追加式 ledger、余额约束 | 余额不负；before/delta/after/operator/reason 完整 | AI | TODO |
| BE-405 | 后台 grant/adjust 双审 | BE-404、MFA 方案 | 后台人工发放/调账、审批、审计 | 普通客户端无权限；重复请求只一笔流水 | AI | TODO |
| BE-406 | reserve/consume/release/reverse | BE-202/306/404 | `billing_intent` 状态机、事务/outbox、对账任务 | 并发开房不超扣；首局重试不重复；解散策略正确 | AI | TODO |
| BE-408 | 账本故障演练 | BE-404~406 | 余额不足、服务重启、outbox 重试、冲正报告 | 账本重放余额一致；无悬挂负数 | AI + QA | TODO |
| CL-403 | 钻石只读状态 | BE-404 | diamondBalance/hold/consumed 展示 | 无支付 SDK、充值/提现/转赠路由、深链和文案 | AI + CL | IN_PROGRESS（大厅只读“后台发放”状态已完成；真实余额/冻结/消耗 API 待） |
| QA-401 | 无支付入口扫描 | CL-403、BE-405 | 路由/依赖/文案/商店截图 grep 检查 | `payment/recharge/withdraw/cashout/transfer` 不出现在客户端能力 | AI + QA | TODO |

### 9.3 推荐计费状态机（在 DEC-009 确认前仅 sandbox）

```text
PLANNED → RESERVED → CONSUMED
    └──────────────→ RELEASED（未开局/提前解散，按签字策略）
CONSUMED ──────────→ REVERSED（经审批的纠错）
任意失败 ───────────→ FAILED（可重试但不重复扣）
```

同一 `billingIntentId`/幂等键只能有一个最终变更；客户端只显示服务端结果。

## 10. 战绩、客服和后台（客服纯文本 MVP：W4-W5；完整能力：W10-W11）

联系客服是用户明确要求的首版能力（M/P0）。为了不阻塞实时牌局，先交付不带附件和外链的纯文本内置工单；附件、外部客服渠道、复杂 SLA 和运营报表留在 W10-W11 的增强包。

| ID | 任务 | 依赖 | 主要产出 | 验收 | DRI | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| BE-501 | Match/round/history 查询 | BE-306 | 分页、筛选、权限脱敏、规则版本和 snapshot hash | 用户只能看授权记录；结果与账本一致 | AI | TODO |
| BE-502 | 回放 API | BE-307 | 私牌过滤、规则版本锁定、回放校验 | 历史规则升级不改变结果 | AI | TODO |
| BE-503 | Support ticket/message（纯文本 MVP） | BE-103、DEC-010 | 工单状态、回复、room/match 关联 | 大厅/俱乐部/牌桌均可提交；状态流转可审计；W4/W5 可演示 | AI | TODO |
| BE-504 | 附件安全 | BE-503、隐私决策 | MIME/大小校验、病毒扫描、私有桶、短期签名 URL、留存 | 无越权下载；日志无敏感字段 | AI | TODO |
| BE-505 | Admin moderation/audit | BE-401/405 | 用户封禁、审批、审计查询/导出、注销匿名化 | 审计不可篡改；最小权限 | AI | TODO |
| CL-501 | 战绩/回放页面 | BE-501/502 | 单局、整场、规则详情、回放入口 | 私牌按 viewer 过滤；无未确认规则说明 | AI + CL | IN_PROGRESS（横屏入口与安全空状态已完成；正式结算/历史 API 待） |
| CL-502 | 客服入口和工单 | BE-503/504 | 新建、消息、状态；附件仅在合规决策后开启 | 失败可重试；敏感信息脱敏；纯文本 MVP 不得延期 | AI + CL | TODO |
| CL-503 | 账号/隐私设置 | DEC-002、BE-103/505 | 会话、注销申请、隐私和用户协议 | 注销走异步冷静期/留存流程 | AI + CL | TODO |

客服渠道未决定时，先交付纯文本内置工单（M/P0）；附件和外链保持关闭，不阻塞基础牌局开发。

## 11. 三端 POC、联调与发布计划（W1-W14）

### 11.1 W1-W2 POC

1. 记录 HarmonyOS NEXT 原生目标与旧 Android 兼容层是否同时支持；实际 API/设备版本写入设备清单，不在计划里硬编码会过期版本。
2. 建立 ArkUI-X/ArkTS 与 Flutter/OpenHarmony（或替代方案）最小壳。
3. 三端完成：冷启动→假登录→大厅→四人 fake room→WSS→断网/后台→`lastRoomVersion` sync→客服 stub。
4. 逐项验证网络/TLS、WebSocket、推送、安全存储、文件上传、生命周期和安全区；插件缺口记录到 ADR。
5. 构建 Android debug/AAB、iOS archive/TestFlight 内部包、Harmony HAP（及需要时 HSP），签名只在受保护环境。

### 11.2 W3-W8 业务联调

- W3：连接状态机、协议生成、导航壳、fake adapter。
- W4：Auth、大厅、申请状态、楼层只读、客服纯文本 MVP 入口和 API。
- W5：房间桌面、座位/准备/开始、事件 outbox、重连。
- W6：宿松牌桌和结算（仅已确认规则）；积分战绩。
- W7：管理员楼层、规则版本、钻石只读/账本 sandbox。
- W8：客服、回放、重启恢复、协议/UI 文案冻结。

### 11.3 W9-W12 系统测试和商店预审

- W9：多实例 actor/fencing、弱网/乱序/重复/重启、10k 回放、API/WSS fuzz。
- W10：完整三端设备矩阵、无障碍、深色/安全区、推送和深链。
- W11：Android 内测/封闭测试、iOS TestFlight、AppGallery Connect 内测，真实亲友圈试用。
- W12：后端兼容版本、WAF/LB/Redis/PG、监控/备份/值班/回滚，提交 Go/No-Go。
- W13-W14：若 G5 未通过，仅修复阻塞项和灰度，不新增范围；通过后再逐步放量。

### 11.4 设备与网络验收矩阵

设备具体型号/API 在 W1 登记；以下是能力覆盖而非固定型号：

| 平台 | 最小验收集 | 必测场景 |
| --- | --- | --- |
| Android | ARM64 低/中/高端；有/无 GMS、常见国产 ROM | APK/AAB 安装升级、权限、Wi-Fi/蜂窝切换、后台恢复 |
| iOS | 项目 min、latest-1、latest；小屏/标准屏 | TestFlight、Keychain、APNs、锁屏/杀进程/重连 |
| Harmony | HarmonyOS NEXT 低/中/高档真机；模拟器仅辅助 | HAP/HSP、纯鸿蒙权限/推送/安全存储；兼容层 APK 单独标记 |
| 通用 | 好网、延迟、丢包、无网、代理、服务器滚动发布 | 前台/后台 30s/30min、deadline、snapshot/delta、重复命令 |

每台设备的 P0 流程：冷安装→隐私同意→登录/刷新→大厅→申请/楼层→建/入四人房→准备/开始→至少两局→断网 30 秒→切后台/锁屏→恢复→结算/战绩→客服→登出/注销申请→升级安装。保存 build SHA、设备/OS、日志、录屏和复现率。

## 12. CI/CD、环境和发布产物

### 12.1 CI 必经流水线

```text
format/lint/typecheck
→ unit/property/golden tests
→ OpenAPI/AsyncAPI contract tests
→ dependency/secret/license scan
→ Docker build + migration check
→ Android build → iOS archive → Harmony build
→ artifact signing/SBOM/checksum/manifest
→ staging smoke → 人工批准生产
```

每次发布 manifest 至少包含：git SHA、协议版本、规则包版本、客户端 min/max 版本、API/WSS endpoint、构建号、产物 SHA-256、签名/环境和已知限制。后端先兼容相邻两个协议版本。

### 12.2 环境约定

`dev`、`staging`、`prod` 分离数据库、Redis、密钥、包名、推送和对象存储。PostgreSQL 是事实来源，Redis 只放在线状态、短期缓存、锁/发布订阅；不把进程内 Map 或 Redis 当唯一账本。

运行时版本由 CI 锁定为受支持的 Node.js LTS（当前项目声明 `>=20`，具体 Node 20/22 矩阵在 W1 记录）；开发机的 Node v24 不视为生产基线。PostgreSQL、Redis、短信/OTP、对象存储、推送和监控供应商均通过 adapter + fake provider 隔离，版本与服务地区写入 release manifest。

### 12.3 回滚

- 后端：保留上一镜像和数据库向前兼容迁移；停止接新连接、通知维护、持久化房间、回滚镜像。
- 客户端：保留上一可安装包和 release manifest；通过版本检查/feature flag 关闭问题功能。
- 规则：新规则版本只影响新房间；历史房间使用旧 snapshot，不能回滚覆盖历史结果。
- 账本：不删除流水；错误使用 `REVERSED` 反向分录并保留审批证据。

## 13. 验收包与证据要求

每个任务至少附一种可复核证据：测试命令输出、API/WS fixture、数据库迁移日志、设备录屏、截图、指标面板、审计查询或发布 manifest。仅“接口返回 200”不算完成。

### 13.1 P0 必测案例

- 同一 `commandId` 重试只产生一个事件、一次结算、一次扣钻。
- 两个并发 `start` 只有一个成功，另一个得到稳定的重复/版本错误。
- 未登录、非成员、非房主、非回合玩家、非法牌、旧版本和余额不足均被拒绝。
- 断线、乱序、丢包、杀进程后，快照+增量恢复；本人手牌可见、他人手牌不可见。
- 新 socket 建立后，旧 socket close 不会删除新连接映射。
- 服务重启、多实例和 outbox 重试不重复结算/扣钻。
- 楼层发布新版本不改变已有房间和历史回放。
- 四人积分按签字规则守恒；流局和系统项按规则显式记录。
- 客户端路由、深链、依赖、文案、商店截图均无充值/支付/提现/现金兑换/转赠能力。
- 俱乐部申请、审批、楼层变更、钻石操作、客服查看/下载均有操作者、时间、原因和前后值审计。

### 13.2 建议性能门槛（需压测确认）

首屏 ≤ 2 秒、重连同步 ≤ 3 秒、房间事件 P95 ≤ 200ms、无异常会话率 ≥ 99.5%、10,000 次回放 0 divergence、RPO ≤ 5 分钟、RTO ≤ 30 分钟。未压测前只作为目标，不作为已达成事实。

## 14. 风险登记与处理策略

| ID | 风险 | 概率/影响 | 处理 | 触发时动作 | 状态 |
| --- | --- | --- | --- | --- | --- |
| RISK-001 | 规则/术语未决 | 高/高 | 指定规则负责人；先 fake/draft | GR 规则门未过，禁生产结算 | OPEN |
| RISK-002 | 钻石归属/扣费未决 | 中/高 | 可配置 ownerType + sandbox reserve | 禁真实扣费，保留 ledger fixture | OPEN |
| RISK-003 | DB/outbox 双写不一致 | 中/高 | PG 事务为真相、outbox 重试/对账 | 停止结算写入并人工核对 | OPEN |
| RISK-004 | 多实例同房竞态 | 中/高 | actor + fencing + 条件版本写 | 故障注入并回到 BE-202 | OPEN |
| RISK-005 | 移动后台杀 WSS | 高/中 | 服务端 deadline，前台 token 重连 | 不承诺后台长连接 | OPEN |
| RISK-006 | 私牌/敏感日志泄漏 | 中/高 | viewer-scoped serializer、日志 allowlist | 立即关闭相关功能并清理日志 | OPEN |
| RISK-007 | 旧 socket 误删新 session | 中/高 | connectionId 比对后才 delete | 加入回归测试，阻断发布 | OPEN |
| RISK-008 | 事件无限增长 | 中/中 | 定期 snapshot、保留/归档策略 | 监控内存并限流 | OPEN |
| RISK-009 | 规则升级破坏回放 | 中/高 | immutable ruleVersion + snapshot hash | 阻断版本发布，跑 replay verifier | OPEN |
| RISK-010 | 商店/棋牌/隐私合规变化 | 中/高 | 法务门禁、无支付文案、定期复核 | `NO-GO`，不以技术猜测代替法律意见 | OPEN |
| RISK-011 | OTP/推送供应商延迟 | 中/中 | provider adapter + fake provider | 使用降级/关闭非核心推送 | OPEN |
| RISK-012 | 迁移/签名/设备不可用 | 中/高 | additive migration、备份、设备预约 | 顺延，不压缩恢复演练 | OPEN |

统一阻塞格式：

```text
BLOCKER-ID | 影响 REQ/RULE | 缺失决策/证据 | owner | 截止 | 临时降级 | 解除证据
```

## 15. 进度面板与变更记录

### 15.1 当前进度（截至 2026-09-07）

| 范围 | 状态 | 当前任务 | 下一出口 |
| --- | --- | --- | --- |
| 文档基线 | DONE | DEVELOPMENT.md、IMPLEMENTATION_PLAN.md、[DEC-INDEX.md](decisions/DEC-INDEX.md) | 用户确认 G0 决策 |
| G0 | IN_PROGRESS | 已登记推荐基线；正式登录/规则/设备等细节仍待确认 | G0 checklist 全勾 |
| I1 | IN_PROGRESS | BE-101～BE-106 已完成（开发/单进程基线）；CL-101 已完成；CL-102 Flutter POC 与 CL-103 framework-neutral 核心/原生 transport 已完成本机验证；OPS-101 开发环境手册已完成；ArkUI/平台生命周期和真实设备仍待 | G2 预审 |
| G1 | IN_PROGRESS | Android/iOS 工具链预检已通过，Android debug APK 已构建；Android/iOS 真机矩阵和发布签名仍待，鸿蒙暂缓 | Android/iOS 真机与签名验收 |
| I2 | IN_PROGRESS | BE-201～BE-205 已完成（业务纵切仍为内存/fake-staging）；BE-204 PG/Redis adapter、presence overlay、异步启动装配、snapshot/delta、重连、显式 deadline 和 durable claim/lease 已完成，`verify:real` 与 `verify:multi-instance` 本地真实容器 smoke 通过，生产滚动重启/故障演练仍待；BE-207 纯文本客服 REST 已完成；CL-201 Flutter 房间桌面、四客户端 fake 验收夹具、CL-202 命令 outbox、CL-203 重连 UI 本机 POC 已完成；真实 WSS/设备验收和 CL-204 REST 联调待 | G3 实时纵切 |
| 宿松规则 | IN_PROGRESS | 用户已确认采用参考 APK 8931 规则；开房配置、花数/胡型/杠开边界已编码，旧服务端叠加公式和优先级仍缺牌局样本 | ≥20 个旧 App 结算/回放 golden cases |
| Club/Floor | BLOCKED | 依赖 DEC-003～006 | G2 + schema |
| Diamond | BLOCKED | 依赖 DEC-008～009 | 计费决策会 |
| History/Support | IN_PROGRESS | BE-207 纯文本工单 REST 已完成并通过 2 个集成用例；CL-204 共享 Dart SupportApi 与 Flutter 注入已完成，真实 REST/三端联调待 | G3 |
| 三端发布 | TODO | 等 G1 POC | G4/G5 |

### 15.2 每次工作结束更新

```text
日期：2026-09-04
本次完成：BE-101～BE-106 开发基线、BE-201 内存 Room aggregate、BE-202 内存 event store/RoomActor/fencing/snapshot/outbox 契约、BE-203 WSS gateway/actor/reconnect 纵切、BE-204 内存重连和显式 deadline 基础、PostgreSQL/Redis adapter、presence overlay 与异步启动装配、durable `DeadlineStore` claim/lease、BE-205 共享 RoomService/REST/BFF（ETag/If-Match/Idempotency-Key）、BE-206/QA-201 fake-rule 故障矩阵、服务关闭态和主动连接清理；增加 `pg`/`redis` 运行依赖和 `npm run verify:real`、`npm run verify:multi-instance` 临时数据库/双实例验证脚本，完成真实迁移、事件/快照恢复、deadline 租约接管、Redis fencing、双 actor 连续版本与最终 snapshotHash smoke；补充 RoomActor crash-gap 相关回归；完成 BE-207 纯文本客服 REST（用户隔离、幂等、审计、房间关联）与 CL-201 四客户端 framework-neutral fake 验收夹具；当前 108 个 Node 测试、完整 npm 质量门、secret scan、Docker/Colima 配置检查通过；CL-101/103 Dart 核心、扩展命令同步与原生 transport POC、Flutter POC 壳、CL-201 房间桌面、CL-202 命令 outbox 和 CL-203 维护/版本冲突/前台恢复 UI 本机验证；OPS-101 本地环境/备份恢复边界手册完成
未完成：BE-204 生产滚动重启、故障演练和长期最终一致性压测，CL-201 真实 WSS/设备验收，ArkUI-X/ArkTS 候选、平台生命周期、CL-204 真实 REST 联调，生产级外部 Auth、规则裁判、真机/签名 POC 仍待执行
新增限制：Flutter 壳目前只连接 FakeTransport；当前无 Android SDK、完整 Xcode 或 HarmonyOS 工具链，不能声称三端可安装；DEVICE_MATRIX.md、POC_ACCEPTANCE.md 保持 PLANNED/TBD
新增阻塞：BLOCKER-ID / owner / 截止
需求或规则变更：DEC-ID / 影响范围
下一步：在 `verify:real`/`verify:multi-instance` 基础上做真实多进程滚动重启、租约接管、备份恢复和最终一致性压测；完成 CL-201 真实 WSS/设备验收与 CL-204 REST 联调。继续使用 fake/staging，不开放真实牌局、规则结算或钻石扣费
```

### 15.3 变更控制

任何会改变 API、规则、账本、权限、数据迁移或发布包的变更，都要：

1. 写明受影响的 `REQ-*`、`R-*`、任务和版本。
2. 先更新 schema/决策记录，再改实现；紧急修复也要事后补记录。
3. 增量迁移优先，禁止无审批删除账本/事件或覆盖规则历史。
4. 重新运行受影响的 golden、契约、弱网和安全测试。
5. 通过对应 Gate 后才允许扩大 feature flag 或发布范围。

### 15.4 计划变更记录

| 版本 | 日期 | 变更 | 证据/影响 |
| --- | --- | --- | --- |
| 0.1.0 | 2026-08-28 | 建立 G0/W0、I1～I2、规则、俱乐部/楼层、账本和三端发布任务板 | 初始执行基线 |
| 0.1.1 | 2026-08-28 | 登记 BE-101～BE-106 完成、33 个 Node 测试和开发安全边界 | `npm run check`、迁移/协议校验、CI、ADR-003 |
| 0.1.2 | 2026-08-28 | 登记 CL-101 framework-neutral Dart 协议消费与连接状态 reducer POC | `clients/dart_protocol/tool/test.dart`；不代表三端可安装 |
| 0.1.3 | 2026-08-28 | 记录 MemoryRepository 必填时间字段修复、G1 工具链/设备限制及 CL-102 下一步 | BE-104 定向测试 7/7；`DEVICE_MATRIX.md`/`POC_ACCEPTANCE.md` 仍为 PLANNED/TBD |
| 0.1.4 | 2026-08-28 | 建立 Flutter POC 壳、FakeTransport 和客户端会话/重连回归 | `flutter test` 5/5；`flutter build web --release`；不代表三端真机通过 |
| 0.1.5 | 2026-08-28 | 增加 QA-101 四客户端 realtime/reconnect 与 reducer 缺口/重复 fixture | `npm test` 33/33；弱网延迟/丢包矩阵仍待 |
| 0.1.6 | 2026-08-28 | 完成 BE-201 内存 Room aggregate/WSS 命令纵切；扩展协议 schema；增加原生 `dart:io` transport 集成与生命周期回归 | `npm test` 39/39；Dart analyze、transport script、Flutter 5/5；BE-202 持久化和三端真机仍待 |
| 0.1.7 | 2026-08-28 | 更新当前质量快照为 40/40；明确 BE-201 已完成、BE-202 及后续 I2 任务待执行；补记 CL-103 原生 transport 和扩展命令同步证据 | `npm test` 40/40；`dart analyze`、两个 Dart POC、Flutter 5/5；三端真机、规则和生产能力仍受限 |
| 0.1.8 | 2026-08-28 | 完成 BE-202 内存 event store、RoomActor、fencing、snapshot、command result、outbox 和 PostgreSQL 迁移契约；补持久化失败回滚/恢复测试 | `npm run check`；Node 48/48；仍未接真实 PostgreSQL/Redis 或多实例部署 |
| 0.1.9 | 2026-08-29 | 完成 BE-203 WSS gateway/RoomActor 内存纵切：ACK/广播、订阅、私有事件过滤、背压、重连宽限、durable recovery 和连续版本队列；质量门更新为 Node 58/58 | `npm run check`；生产 PostgreSQL/Redis、多实例、深度弱网与三端真机仍待 |
| 0.1.10 | 2026-08-29 | 完成 BE-204 内存重连基础、QA-201 延迟/丢包/乱序/重复故障矩阵和 BE-206 重启恢复 fixture；质量门更新为 Node 68/68；补齐 WSS 网关环境参数 | `npm run check`；服务端 deadline、生产 PostgreSQL/Redis、多实例、三端真机仍待 |
| 0.1.11 | 2026-08-29 | 补齐服务关闭态、主动终止连接和 close 幂等；开始 CL-201 Flutter 房间桌面，增加座位/准备状态 widget 验收；质量门更新为 Flutter 6/6、Node 68/68 | `flutter test`、`dart analyze`、`npm run check`；生产 adapter、服务端 deadline、多实例和三端真机仍待 |
| 0.1.12 | 2026-08-29 | 完成 BE-204 显式 deadline 的内存/fake-staging scheduler、Room 回合 deadline 快照/恢复和超时事件广播；质量门更新为 Node 81/81 | `npm run check`；生产 PostgreSQL/Redis deadline、多实例和三端真机仍待 |
| 0.1.13 | 2026-08-29 | 完成 BE-205 共享 RoomService 与内存/fake-staging HTTP API（ETag/If-Match/`Idempotency-Key`、鉴权和成员边界）；增加 BE-204 PostgreSQLGameEventStore/PostgresOutbox、RedisFencingLock 和动态客户端加载器；质量门更新为 Node 89/89 | `npm run check`；adapter 尚未挂载 server 默认路径，presence overlay、持久化 deadline、多实例和三端真机仍待 |
| 0.1.14 | 2026-08-29 | 完成 BE-204 独立 `game_presence` overlay、RoomActor 恢复/快照 hash 合并、PostgreSQL/内存读写、`createRealtimeServerAsync` 配置装配；完成 CL-202 ACK/超时/断线命令 outbox 与 Flutter 回归；质量门更新为 Node 92/92、Flutter 9/9 | `npm run check`、presence/启动装配测试、Dart/Flutter POC；持久化 deadline、真实多实例、三端真机和 G1 仍待 |
| 0.1.15 | 2026-08-29 | 完成 BE-204 `game_deadlines` migration、Memory/PostgreSQL deadline store、claim/lease/complete 端口、双 scheduler winner-only 回归和稳定 UUID commandId；质量门更新为 Node 99/99，README/数据库手册补充契约与迁移命令 | `npm run check`、`test/be-204-deadline-store.test.js`；真实 PG/Redis 容器、多实例最终一致性和三端真机仍待 |
| 0.1.16 | 2026-08-29 | 增加 `pg`/`redis` 运行依赖和 `npm run verify:real` 临时数据库验证脚本；补齐 deadline `NOT_DUE`、租约接管、终态重放和 server 装配边界测试；Colima + PostgreSQL/Redis 真实 smoke 通过；质量门更新为 Node 104/104 | `npm run verify:real`、`npm run check`；生产多实例最终一致性、三端真机和 G1 仍待 |
| 0.1.18 | 2026-09-02 | 增加 `verify:multi-instance` 双独立 PG pool/Redis client smoke，覆盖重复命令、并发房间写、连续版本、outbox 和 actor/durable snapshotHash；修复 crash-gap replay 的持久相关字段；完成 CL-203 维护/版本冲突/前台恢复 UI 与 13/13 Flutter 回归；完成 OPS-101 本地环境手册并校正 Colima `--cpus`、PostgreSQL maintenance DB 命令 | `npm run check`（Node 106/106）、`npm run verify:real`、`npm run verify:multi-instance`、Flutter 13/13、Dart protocol/IO tests；生产滚动重启、三端真机、规则/账本仍待 |
| 0.1.19 | 2026-09-04 | 完成 BE-207 纯文本客服 REST（鉴权、用户隔离、幂等、审计、房间关联；附件/外部渠道关闭），新增 CL-201 四客户端 framework-neutral fake 验收夹具并验证重连收敛 | `npm run check`（Node 108/108）、`dart run tool/multi_client_acceptance.dart`；真实 WSS/三端设备、持久化客服仓储仍待 |
| 0.1.20 | 2026-09-04 | 新增共享 Dart `SupportApi` 与可注入 REST transport，覆盖客服工单创建/列表/消息/关闭和纯文本边界验证；Flutter 仍使用 fake transport，未宣称真实端到端联调 | `dart analyze`、`dart run tool/support_test.dart`、`npm run check`、`npm run verify:multi-instance` |
| 0.1.21 | 2026-09-04 | Flutter 客服页支持注入 `SupportApi`，新增 REST port widget 回归；默认仍为演示模式 | `flutter test`（15/15）、`dart analyze`；真实 REST/设备联调仍待 |
| 0.1.22 | 2026-09-04 | 新增 `dart:io` 原生 `IoRestTransport` 与本地 HTTP server 回归，验证 Bearer、幂等键和 JSON 响应 | `dart run tool/io_rest_transport_test.dart`；Web transport 和真实 staging 联调仍待 |
| 0.1.23 | 2026-09-04 | 新增 `npm run check:mobile` Android+iOS 工具链预检，明确当前缺 Android SDK、完整 Xcode 和 CocoaPods；鸿蒙保持 deferred | 预检输出 `status: blocked`；不自动安装 SDK 或生成签名 |

## 16. 我们下一次具体做什么

下一次执行从 **I2 → BE-204/CL-201/CL-204** 开始，顺序如下：

1. 复核 [DEC-INDEX.md](decisions/DEC-INDEX.md) 中仍未决的 DEC-002/004/010/011 及 DEC-RULE-001～009；未决项继续指定 owner、截止日和 sandbox 降级，不填猜测默认值。
2. 已完成：`BE-101`～`BE-106` 模块、协议、认证、数据、安全观测和 CI 开发基线；保留单进程/内存实现的生产限制。
3. 已完成：`CL-101` framework-neutral Dart 协议消费层和 reducer POC；其证据与运行命令见第 6 节和 [客户端协议消费说明](client/PROTOCOL_CONSUMER.md)。
4. 已完成 BE-201 内存 Room aggregate 和新房间命令 schema/WSS 接入；其 fake-rule、单进程和客户端自报 membership 边界不作为生产授权。
5. 已完成 BE-202：append-only event store、actor/fencing、snapshot/outbox 和持久化 commandId 结果；当前是可替换内存 adapter，PostgreSQL/Redis 只完成迁移/端口契约，尚未运行接入。
6. 已完成 BE-203：WSS gateway 已接入 RoomActor，具备成功写入后 ACK/广播、订阅、私有事件过滤、背压、连接替换和重连宽限；BE-204 已完成内存 snapshot/delta、显式 deadline、presence overlay、PG/Redis adapter 契约、异步默认装配和持久化 deadline claim/lease 基础，`verify:real` 与 `verify:multi-instance` 已在真实本地 PG/Redis 上通过，继续做真实多进程滚动重启、故障演练、备份恢复和长期最终一致性压测。
7. 已完成 BE-205：REST/BFF 与 WSS 共用 `RoomService`/RoomActor，提供 ETag/If-Match、`Idempotency-Key`、统一错误 envelope 和成员/鉴权边界；当前为内存/fake-staging，不代表生产 PG/Redis 或多实例能力。
8. QA-201/BE-206 基础延迟、丢包、乱序、重复和重启故障矩阵已通过；CL-201 四客户端 framework-neutral fake 夹具已验证版本/hash/重连收敛，下一步补真实 WSS/设备验收；BE-207 纯文本客服 REST 已完成，CL-204 真实 REST 联调与三端适配待完成。继续记录 DEC-011，SDK/真机未就绪前不得把 G1 标为通过。

如果用户尚未准备好规则或钻石决策，我们仍可完成 I1/I2 的协议、认证、fake rule、同步和客户端 POC；但相关功能会保持 `DRAFT/SANDBOX`，不会暗中采用截图默认值。

## 附录 A：用户回复用决策模板

用户可以直接复制下面格式回复；不需要一次回答所有问题：

```text
DEC-001 项目目录：继续使用 / 迁移到 ______
DEC-002 登录：______；实名/地区/年龄：______
DEC-003 俱乐部申请：创建 / 加入 / 两者；审批者：______
DEC-004 角色权限：______
DEC-005 楼层形态与 ruleSnapshot 冻结时点：______
DEC-006 房间访问：MEMBERS_ONLY / INVITE_ONLY / PUBLIC_CODE；说明：______
DEC-007 积分生命周期：______
DEC-008 钻石归属与扣费主体/费用：______
DEC-009 reserve/consume/release 策略：______
DEC-010 客服首版渠道与附件：______
DEC-011 HarmonyOS 目标：______

DEC-RULE-001 牌组/人数：______
DEC-RULE-002 动作：______
DEC-RULE-003 庄/流局/多胡：______
DEC-RULE-004 底分语义：______
DEC-RULE-005 已确认：单笔=`花档分 + 赢家增×增单价 + 付款者增×增单价`，自摸不升档，三西关系最后翻倍；待确认三西额外付款与多响组合：______
DEC-RULE-006 无花果术语与数值：______
DEC-RULE-007 必胡/过圈/超时：______
DEC-RULE-008 胡型/封顶/结算：______
DEC-RULE-009 局数/中途加增：______
```

## 附录 B：完成后的扩展顺序

首版稳定后，新增游戏必须按以下顺序，不得复制宿松麻将专用字段到基础房间层：

1. 新增 `GameDefinition`、配置 schema、规则版本和 golden cases。
2. 增加牌桌 renderer/动作映射和私有状态过滤。
3. 复用 Room actor、WSS、snapshot/delta、History、Support 和审计。
4. 通过协议兼容、回放一致性、权限和性能 Gate 后再开放楼层。
