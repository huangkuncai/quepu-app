# 决策索引与 G0/W0 记录

> 计划版本：0.1.2-draft
> 建立日期：2026-08-28
> 最近更新：2026-09-07（用户确认采用参考 APK 8931 规则；开房配置与可验证计分边界进入代码）
> 状态：ACTIVE（I1 开发基线已建立；I2/BE-201～204、BE-206/QA-201 内存/fake-rule 纵切完成；BE-204 presence overlay、异步装配和 deadline claim/lease 基础、真实本地 PG/Redis adapter 与双实例 smoke 已完成，生产滚动重启/故障演练仍待；G0/G1 仍进行中）
> 关联计划：[IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md)
> 关联规格：[DEVELOPMENT.md](../DEVELOPMENT.md)

这份文件是产品、规则、技术和发布决策的唯一索引。实现代码不得把未确认的 `Q` 项或截图中的示例值当成生产默认值。

## 1. 记录约定

- `M`：用户明确提出的正式范围。
- `S`：截图或其他参考资料，只用于提取候选信息，不代表已签字规则。
- `Q`：目前缺少确认；只能使用 `TBD`、fake、sandbox 或 feature flag。
- `D`：开发建议；需要产品/规则负责人确认后才升级为正式决策。
- 决策状态：`TODO`、`PROPOSED`、`CONFIRMED`、`REJECTED`、`DEFERRED`。
- 每条确认必须留下日期、确认人和证据（会议纪要、消息、规则表或测试样例）。

## 2. G0 出口检查表

- [x] 正式项目目录已确认；分支和提交策略仍需补充。
- [ ] 每个 M 需求已关联 `REQ-*`、验收条件和 DRI。
- [ ] 每个 P0 `Q` 已指定 owner、截止日期、临时降级和解除证据。
- [ ] 登录的正式供应商及年龄/地区/实名边界已记录（开发期 fake auth 已确认）。
- [ ] 俱乐部申请、楼层和房间访问边界已记录（角色细则仍待确认）。
- [x] 积分账本与钻石账本隔离；首版钻石仅 sandbox、不产生真实扣费。
- [ ] 客服渠道、隐私留存和响应 SLA 已记录。
- [ ] Android、iOS、HarmonyOS 的目标设备/API 和签名条件已记录。
- [ ] 宿松规则负责人已指定；规则未签字前仅允许 fake/draft 牌局。
- [x] 已完成“无充值入口、无支付、无提现、无现金兑换”的范围检查；真实钻石仍仅 sandbox。
- [x] 基线命令、输出和已知限制已归档；三端 SDK/真机和签名仍待补齐。

## 3. 产品与平台决策登记

| ID | 决策问题 | 当前答案 | 来源 | DRI | 截止 | 状态 | 证据 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DEC-001 | 正式目录继续使用 `宿松app.migrated-backup`，还是迁移/重命名为 `宿松app`？ | 继续使用 `宿松app.migrated-backup` | M/技术 | USER | G0 | CONFIRMED | 用户确认 2026-08-28 |
| DEC-002 | 登录方式及实名、地区、年龄边界 | 开发期使用模拟手机号验证码（验证码 `000000`）；正式供应商、实名/地区/年龄边界 TBD | M/Q | USER + LEGAL | G0 | CONFIRMED（范围部分） | 用户确认 2026-08-28；ADR-002 |
| DEC-003 | 俱乐部申请是创建、加入，还是两者；审批主体和状态 | 创建俱乐部由平台审批；加入俱乐部由会长/管理员审批 | M/Q | USER/PM | G0 | CONFIRMED | 用户确认 2026-08-28 |
| DEC-004 | 会长、管理员、房主、成员的权限及邀请/踢人/解散规则 | TBD | M/Q | USER/PM | G0 | TODO | — |
| DEC-005 | 楼层模板/固定桌、`ruleSnapshot` 冻结时点、跨楼层加入 | 楼层为规则模板；创建房间时冻结 `ruleSnapshot`；跨楼层加入 TBD | M/Q | USER/PM | G0 | CONFIRMED（范围部分） | 用户确认 2026-08-28 |
| DEC-006 | 房间访问模式：`MEMBERS_ONLY`、`INVITE_ONLY`、`PUBLIC_CODE` | 仅俱乐部成员可通过房号进入 | M/Q | USER/PM | G0 | CONFIRMED（范围部分） | 用户确认 2026-08-28 |
| DEC-007 | 积分是否每场归零、是否跨场累计、负分/展示/重置方式 | 每场从 0 开始；允许负分；只用于战绩；不跨场消费 | M/Q | USER/PM | G0 | CONFIRMED | 用户确认 2026-08-28 |
| DEC-008 | 钻石归属、费用承担、单价和扣费时机 | 首版仅使用钻石 sandbox；真实归属、费用、单价和时机 TBD | M/Q | USER + OPS | G0 | CONFIRMED（边界） | 用户确认 2026-08-28 |
| DEC-009 | 钻石 reserve/consume/release/reverse 及失败处理 | 首版不产生真实扣费；账本流程先做 sandbox，细则 TBD | M/Q | USER + OPS | G0 | CONFIRMED（边界） | 用户确认 2026-08-28 |
| DEC-010 | 客服渠道、入口、附件限制、留存和 SLA | TBD | M/Q | USER + OPS | G0 | TODO | — |
| DEC-011 | HarmonyOS 目标边界（NEXT/兼容层）、API 和设备清单 | 暂缓，本迭代仅验收 Android+iOS | M/Q | USER + CL | 后续版本 | DEFERRED | 用户确认 2026-09-04 |

## 4. 宿松规则决策登记

截图中的文字和数值先登记为候选，不直接写入裁判代码。确认后应同步生成规则版本、配置 schema、计分表和 golden cases。

| ID | 必须确定的内容 | 当前答案 | 来源 | DRI | 截止 | 状态 | 证据 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DEC-RULE-001 | 人数/座位、牌组、风箭花牌数量、总牌数、初始手牌 | 4 人；已编码版本化候选：108 张万/条/筒、16 风、12 箭、8 红/黑花，共 144 张；庄 14、闲 13；精确构成待旧服样本签字 | M+APK | USER + RULE | GR | CONFIRMED（部分） | 用户 2026-09-07；8931 客户端牌 ID；`be-303-susong-wall.test.js` |
| DEC-RULE-002 | 吃/碰/杠/补花/抢杠/胡/过及多家胡优先级 | 动作集确认；同时可行动作优先级待旧服样本 | M+APK | USER + RULE | GR | CONFIRMED（部分） | `MsgXYSSMJ.pb`、回放 opcode |
| DEC-RULE-003 | 首局庄、庄轮转、多家胡、流局、剩余牌墙和杠后牌 | 首局随机庄；上局最先胡者坐庄、流局连庄、剩 14 张流局、一炮多响；普通头摸、补花/杠后尾补 | M+APK+USER | USER + RULE | GR | CONFIRMED | `8931_rule.txt`、用户 2026-09-08 确认 |
| DEC-RULE-004 | 底分 1～9 的选择方式及第二档映射 | 1～9 必须选择 4 个递增档；默认 1/2/3/4；第二档用于花奖 | M+APK | USER + RULE | GR | CONFIRMED | 创建房配置及规则文本 |
| DEC-RULE-005 | 花奖、杠花、出增、飘花、三西/三道规则 | 花奖独立按第二档叠加；红/黑花分别累计对子单位；单方累计吃碰 3 次建立关系；每条三西独立额外一份；关系双方同炮双响解除 | M+APK+USER | USER + RULE | GR | CONFIRMED | `8931_rule.txt`、用户 2026-09-07～08 计分及三西样例 |
| DEC-RULE-006 | 无花果、“一察/一素”等术语、数值和触发 | APK 原文术语为“无花果”“一索”；无花果归一索且只能自摸 | M+APK | USER + RULE | GR | CONFIRMED | `8931_rule.txt` |
| DEC-RULE-007 | 必胡/不必胡、“过圈”和超时默认动作 | 必胡自动胡；过圈仅在本人摸牌后解除；倒计时归零继续等待且不代操作 | M+APK+USER | USER + RULE | GR | CONFIRMED | 创建房配置、规则文本、用户 2026-09-08 确认 |
| DEC-RULE-008 | 小胡/大胡、特殊胡型、≥9、封顶、舍入、零和 | 花数档、九类一索和杠开档确认；多条件叠加/封顶待旧服结算样本 | M+APK | USER + RULE | GR | CONFIRMED（部分） | `8931_rule.txt` |
| DEC-RULE-009 | 4/8/16 局、出增中途调整和房周期边界 | 4/8/16 局；默认 4；房周期内增可加不可减 | M+APK | USER + RULE | GR | CONFIRMED | 创建房配置及规则文本 |

## 5. 阻塞登记

所有阻塞必须可执行地写明解除条件。未决期间只能按“临时降级”运行。

| BLOCKER-ID | 影响 REQ/RULE/任务 | 缺失决策或证据 | Owner | 截止 | 临时降级 | 解除证据 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BLOCKER-G0-001 | BE-103 生产接入、CL-102～103、发布合规 | DEC-002 登录和年龄/地区/实名边界 | USER + LEGAL | G0 | fake auth；禁止生产房间 | 已确认 Auth 策略和验收样例 | OPEN |
| BLOCKER-G0-002 | R-*、BE-301～306 | `.5` 已确认红黑花、动作限制、庄家跳牌取 14 张直接先出及摸牌解过圈 | USER + RULE | GR | 已确认域使用 `8931-apk-baseline.5`；未枚举特殊场景继续 fail-closed | 规则负责人新增样例 | OPEN（范围缩小） |
| BLOCKER-G0-003 | BE-401～405、Club/Floor | DEC-003～006 俱乐部/楼层/访问权限 | USER/PM | G0 | 只读 mock 数据 | RBAC 与 ruleSnapshot schema 已确认 | OPEN |
| BLOCKER-G0-004 | BE-501～504 | DEC-008～009 钻石归属和扣费策略 | USER + OPS | G0 | ledger sandbox；不扣真实钻石 | reserve/consume/release/reverse 流程签字 | OPEN |
| BLOCKER-G0-005 | CL-102～103、OPS-301～304、G1 | Android/iOS 设备、SDK/API/签名清单（鸿蒙已暂缓） | USER + CL | G0/G1 | Dart 原生 transport 与 Flutter/FakeTransport POC 可本机验证；不生成可安装包 | Android+iOS 真机矩阵和签名条件 | OPEN |

## 6. G0 基线证据

| 项目 | 结果 | 日期 | 证据/备注 |
| --- | --- | --- | --- |
| 实际工作目录 | `宿松app.migrated-backup`；当前分支 `codex/be-101-protocol`，持续提交并推送至 `origin` | 2026-09-07 | DEC-001 已确认目录；每个规则纵切独立提交并推送 |
| `npm test` | 168 个 Node 测试通过 | 2026-09-07 | `npm run check` 通过；包含 BE-201～207、BE-301～306 牌墙/连续补花/权威摸出牌/响应窗口/完整吃碰杠胡过/不必胡过圈/标准胡及 APK 所列特殊胡型/点炮自摸/必胡自动结算/14 张流局/牌守恒/私密持久化/玩家脱敏、客服、deadline、多实例收敛、真实 adapter 契约、协议和故障矩阵；`verify:real` 与 `verify:multi-instance` 已覆盖真实本地 PG/Redis，生产滚动重启/故障演练仍待 |
| 服务端启动 | `src/server.js` 可启动 WebSocket 8787（内存骨架） | 2026-08-28 | 仅开发/演示环境 |
| 数据和认证 | PostgreSQL migrations、Redis Compose/health、repository contract/MemoryRepository、开发期 session/Auth 和审计接口已建立；正式 PG/Redis/外部 Auth 未接入 | 2026-08-28 | 单进程/内存实现；不得开放真实牌局/真实扣费 |
| 客户端 | `clients/dart_protocol` 协议/连接核心、扩展命令同步、原生 `dart:io` `IoWebSocketTransport`、四客户端 fake 夹具和 `SupportApi`，以及 `clients/flutter_app` 横屏 Flutter 壳通过本机验证 | 2026-09-07 | `dart analyze`、协议/IO/multi-client/support 脚本、`flutter test`（21/21）和 Android debug APK 构建；房间桌面、命令 outbox、维护/版本冲突/前台恢复 UI、客服 REST 注入、服务端权威手牌/动作/公开牌桌及可配置原生 WSS 已接入；真实服务四客户端、Android/iOS 真机签名尚待验收，鸿蒙暂缓 |
| 房间/BE-201～205、BE-206/QA-201 | 通用 Room aggregate、内存 event store/RoomActor/fencing/snapshot/outbox、WSS gateway、重连与显式 deadline 基础、PostgreSQL/Redis adapter 契约与异步装配、presence overlay、durable room inventory、持久化 deadline claim/lease、共享 RoomService/REST/BFF 和 fake-rule 故障矩阵已覆盖状态、幂等、重启恢复、失败回滚、ACK/广播、私有事件过滤、连接替换、snapshot hash、弱网收敛和 stale deadline guard；`verify:real` 已覆盖临时数据库真实迁移/事件/快照恢复/deadline lease/Redis fencing，`verify:multi-instance` 已覆盖两个独立 actor/PG pool/Redis client 的并发写与最终 hash 收敛；业务仍为内存/fake-staging 纵切，生产滚动重启/故障演练未完成 | 2026-09-02 | `test/be-204-multi-instance.test.js`、`scripts/verify-multi-instance.mjs`、`npm run verify:real`；不代表生产房间服务或三端真机安装 |
| 质量/安全 | lint、typecheck、协议/迁移校验、secret scan、依赖高危审计、Docker Compose 配置校验通过 | 2026-08-28 | ADR-003；控制端点和日志脱敏为开发基线 |
| Git | 尚无提交；现有文件均需保留 | 2026-08-28 | 当前分支 `codex/be-101-protocol`；后续补充分支/提交策略 |

## 7. 会议/确认记录

| 日期 | 参与者 | 结论 | 影响任务 | 证据 |
| --- | --- | --- | --- | --- |
| 2026-08-28 | USER/AI | 建立本索引；G0/W0 为第一执行阶段 | G0、I1 | 本文件 |
| 2026-08-28 | USER/AI | 接受推荐基线：目录、开发期 fake auth、俱乐部审批、楼层快照、成员房号、积分隔离和钻石 sandbox | BE-101、BE-102、BE-103、Club/Floor、Diamond | 本次用户确认 |
| 2026-08-28 | AI/DEV | BE-103 开发期 session/WS 鉴权完成；生产仍 fail-closed | BE-103、G2 | ADR-002、18 个测试 |
| 2026-08-28 | AI/DEV | BE-101～BE-106 开发基线完成；协议、认证、迁移/Redis 检查、安全观测、CI 和 33 个 Node 测试可复现 | BE-101～BE-106、G2 | `npm run check`、`npm run scan:secrets`、`npm audit --omit=dev --audit-level=high`、ADR-003 |
| 2026-08-28 | AI/DEV | CL-101 协议消费层 POC 完成：Dart envelope/version 校验、roomVersion 缺口同步检测、连接状态和退避 reducer | CL-101、G1 前置 | `clients/dart_protocol/tool/test.dart`；不代表最终三端框架或安装包 |
| 2026-08-28 | AI/DEV | 修复 MemoryRepository 必填 `expiresAt` 的确定性校验，并补充非法日期/时钟异常回归 | BE-104 | `test/be-104-data.test.js` 定向 7/7；生产 PG/Redis 仍待 |
| 2026-08-28 | AI/DEV | 建立 Flutter POC 壳、FakeTransport、会话控制器和断线后房间同步回归 | CL-102/103、G1 前置 | `flutter test` 5/5、`flutter build web --release`；Android/iOS/HarmonyOS 真机仍阻塞 |
| 2026-08-28 | AI/DEV | 增加四客户端实时广播、重连同步及 reducer 重复/缺口 fixture | QA-101、I2 前置 | `test/qa-101-realtime.test.js`；基础矩阵通过，延迟/丢包注入仍待 |
| 2026-08-28 | AI/DEV | BE-201 内存 Room aggregate/WSS 房间命令纵切完成；BE-202 内存 event store/RoomActor 契约随后完成；BE-203～BE-206 保持 TODO | BE-201～202、I2 | `test/be-201-room.test.js`、`test/be-202-event-store.test.js`；WSS actor、真实 PG/Redis、REST 和完整故障测试仍待 |
| 2026-08-28 | AI/DEV | CL-103 增加原生 `dart:io` `IoWebSocketTransport` 集成，扩展 leave/ready/begin_playing/settle/next/disband 命令和 room sync 消费 | CL-103、I2 前置 | `dart analyze`、`dart run tool/test.dart`、`dart run tool/io_transport_test.dart`；平台生命周期、三端真机和 WSS 证书仍阻塞 |
| 2026-08-28 | AI/DEV | BE-202 内存 event store、RoomActor、fencing、snapshot、command result、outbox 和 PostgreSQL migration 契约完成；WSS 和真实 PG/Redis 接入留给后续任务 | BE-202、I2 | `npm run check`；Node 48/48；不代表生产多实例能力 |
| 2026-08-29 | AI/DEV | BE-203 WSS gateway/RoomActor/reconnect 内存纵切完成：ACK/广播、订阅、私有事件过滤、背压、重连宽限、durable recovery 和连续版本队列 | BE-203、I2 | `npm run check`；Node 58/58；真实 PG/Redis、多实例和深度弱网验证仍待 |
| 2026-08-29 | AI/DEV | BE-204 内存重连基础、显式 deadline scheduler/Room 快照恢复/超时广播、PostgreSQL/Redis adapter 契约、presence overlay/房间枚举/异步启动装配、QA-201 延迟/丢包/乱序/重复故障矩阵和 BE-206 重启恢复 fixture 通过 | BE-204、BE-206、QA-201、I2 | `npm run check`；Node 95/95；服务端 deadline claim、多实例和三端真机仍待 |
| 2026-08-29 | AI/DEV | BE-205 共享 RoomService 与内存/fake-staging REST/BFF 通过：REST/WSS 共用 actor 状态，ETag/If-Match、Idempotency-Key、统一错误 envelope、鉴权和成员边界已覆盖 | BE-205、I2 | `test/be-205-room-http.test.js`、`npm run check`；生产 adapter、presence overlay、多实例和三端真机仍待 |
| 2026-08-29 | AI/DEV | 补齐服务关闭态/主动连接清理并完成 CL-201 Flutter 房间桌面、CL-202 命令 outbox：座位、准备状态、公共状态、私牌占位、同步入口、ACK/超时重试和断线复用 commandId | CL-201/202、I2 | `dart analyze`、`flutter test` 10/10；三端真机、生产 WSS 和多实例验收仍待 |
| 2026-08-29 | AI/DEV | BE-204 增加 PostgreSQL `listRooms`/重启 deadline 恢复测试，升级 event-store contract 版本；OpenAPI/AsyncAPI YAML、$ref、REST 状态码和 wrapper 契约纳入质量门 | BE-204、BE-205、I2 | `npm run check`；Node 95/95；真实 PG/Redis、多实例和三端真机仍待 |
| 2026-08-29 | AI/DEV | BE-204 增加 `game_deadlines` 持久化 lease 表、Memory/PostgreSQL deadline store、claim/complete/fail/cancel 端口和双 scheduler winner-only 回归；自动生成的 deadline commandId 改为稳定 UUID，server 显式装配 deadline store | BE-204、I2 | `test/be-204-deadline-store.test.js`、`npm run check`；Node 99/99；真实 PG/Redis 容器、多实例最终一致性和三端真机仍待 |
| 2026-09-02 | AI/DEV | BE-204 真实 PG/Redis adapter 与双实例 smoke 通过；双 actor 重复/并发命令、连续事件/outbox、最终 snapshotHash 和 crash-gap replay 纳入回归；CL-203 维护/版本冲突/前台恢复 UI 与 OPS-101 本地环境手册完成 | BE-204、CL-203、OPS-101、I2 | `npm run check`（Node 106/106）、`npm run verify:real`、`npm run verify:multi-instance`、Flutter 13/13、Dart protocol/IO tests；生产滚动重启、三端真机、规则和账本仍待 |
| 2026-09-04 | AI/DEV | BE-207 纯文本客服 REST 完成（用户隔离、幂等、审计、房间关联；附件/外部渠道关闭）；CL-201 四客户端 framework-neutral fake 夹具验证事件顺序、snapshotHash 与重连收敛 | BE-207、CL-201、I2 | `npm run check`（Node 108/108）、`dart run tool/multi_client_acceptance.dart`；真实 WSS/三端真机、客服持久化仓储仍待 |
| 2026-09-07 | USER/AI | 用户确认宿松麻将采用参考 APK 的 8931 规则；客户端内置规则文本、创建配置、协议和回放操作码作为证据，旧服务端独有公式继续以 golden case 解除 | DEC-RULE-001～009、BE-301～306 | `SUSONG_8931_RULE_BASELINE.md`、`be-301-susong-rule.test.js` |
| 2026-09-07 | AI/DEV | BE-301/303 新增版本化 144 张候选牌墙、稳定实体 ID、可审计洗牌、seed commitment、庄 14/闲 13 开局发牌和公共状态脱敏 | BE-301、BE-303、DEC-RULE-001/003 | `be-303-susong-wall.test.js`、`npm run check`（Node 136/136）；牌墙构成/补花方向仍待签字 |
| 2026-09-07 | AI/DEV | 候选牌墙接入 Room/RoomActor/RoomService，发牌后强制原子私密 checkpoint；玩家重连仅恢复本人手牌，公共 hash 跨玩家一致，日志屏蔽全量手牌/牌墙/seed | BE-303、BE-307、CL-301 | `be-303-susong-wall.test.js`、`be-105-observability.test.js`、`npm run check`（Node 139/139） |
| 2026-09-07 | AI/DEV | 候选补花尾部取牌、连续补花、不强飘起手自动补、强飘选择不飘自动补、飘花打花及 144 张守恒/seed 历史重放完成 | BE-303、BE-305、BE-307 | `be-303-susong-wall.test.js`、`npm run check`（Node 141/141）；方向仍为 provisional |
| 2026-09-07 | AI/DEV | 服务端权威摸牌/出牌、手牌归属、公开弃牌、摸花自动打/补、私密操作顺序重放和保留 14 张零分流局完成；私牌变更强制原子 checkpoint | BE-303、BE-304、BE-305、BE-307 | `be-303-susong-wall.test.js`、`npm run check`（Node 147/147）；响应动作优先级仍待 |
| 2026-09-07 | AI/DEV | 出牌后三家顺序响应/过牌、超时截止字段和稀疏快照事件尾恢复完成；服务端候选器可识别碰/明杠/下家吃，但未签字优先级前不执行候选动作 | BE-304、BE-307 | `be-303-susong-wall.test.js`、`npm run check`（Node 148/148） |
| 2026-09-07 | AI/DEV | 唯一合法碰牌按玩家私有投影并服务端执行：私牌减两张、最新弃牌转入公开牌组、碰牌者获得出牌权；seed/history 守恒、篡改拒绝、原子 checkpoint 和重启恢复通过 | BE-304、BE-307 | `be-303-susong-wall.test.js`、`npm run check`（Node 150/150）；胡/杠/吃优先级仍待 |
| 2026-09-07 | AI/DEV | 服务端权威明杠及杠后补牌完成：私牌减三张、弃牌生成四张公开牌组，从候选尾部补牌；碰风累计 1 花，普通/风牌明杠分别累计 1/2 花，补到花按飘状态打花或连续补花，恢复时校验牌序、守恒和私密操作历史 | BE-304、BE-305、BE-307 | `be-301-susong-rule.test.js`、`be-303-susong-wall.test.js`、`npm run check`（Node 154/154）；补牌方向 provisional，胡/吃/暗杠/巴杠优先级仍待 |
| 2026-09-07 | AI/DEV | 标准四组一对、七对、清一色、混一色与碰碰胡的服务端识别、点炮/自摸候选投影、胡优先的一炮多响收集、必胡自动结算和 RoomActor 双事件原子恢复完成；同时修复连续补花可能撞入保留 14 张的预判 | BE-304、BE-306、BE-307 | `be-303-susong-wall.test.js`、`npm run check`（Node 160/160）；三西识别、过圈和其余特殊胡型仍 fail-closed |
| 2026-09-07 | AI/DEV | 下家吃牌使用服务端候选编号完成多顺子选择；暗杠使用服务端私牌候选、普通/风牌计 2/3 花并尾部补牌，操作历史重放、守恒、篡改拒绝和 actor 重启恢复完成；巴杠候选已识别但等待抢杠胡窗口 | BE-304、BE-305、BE-307 | `be-303-susong-wall.test.js`、`npm run check`（Node 164/164）；巴杠/抢杠胡下一纵切 |
| 2026-09-07 | AI/DEV | 巴杠两阶段声明/提交完成：三家抢杠胡/过全部结束前不改私牌牌墙，抢杠成功由声明者按点炮方支付且巴杠取消；全过后升级碰牌、增量计花并尾部补牌，声明事件和最终私密状态均可恢复 | BE-304、BE-305、BE-307 | `be-303-susong-wall.test.js`、`npm run check`（Node 166/166）；过圈下一纵切 |
| 2026-09-07 | AI/DEV | 不必胡过圈状态完成：放弃合法点炮/抢杠胡后屏蔽点炮胡，自摸保留；本人实际摸牌或取得出牌权时清除，快照/事件/重启恢复一致 | BE-304、BE-305、BE-307 | `be-303-susong-wall.test.js`、`npm run check`（Node 167/167）；清除边界为 provisional，待旧服样本 |
| 2026-09-07 | AI/DEV | 全求人、天胡、地胡由服务端牌组/庄位/行牌历史识别并封顶；起手补花不破坏天胡，巴杠补牌自摸计杠开 | BE-304、BE-306、BE-307 | `be-303-susong-wall.test.js`、`npm run check`（Node 168/168）；三西仍 fail-closed |
| 2026-09-07 | AI/DEV | Flutter 横屏牌桌接入本人手牌、点选出牌和服务端动态动作面板；多候选吃/暗杠/巴杠仅回传候选编号，客户端不提交计分或牌墙事实 | CL-301、CL-202 | `flutter test`（18/18）、Flutter/Dart analyze、Dart 协议核心测试；真实 WSS/设备待验收 |
| 2026-09-07 | AI/DEV | CL-301 公开牌桌直接渲染服务端弃牌、副露、花数/飘花、行动者、牌墙和 deadline；局数来自快照而非客户端常量 | CL-301 | `flutter test`（18/18）、`dart analyze`；真实 WSS/设备待 CL-201/G1 验收 |
| 2026-09-07 | AI/DEV | Flutter 运行时可通过 dart-define 在默认离线演示和 Android/iOS 原生 WSS 之间切换；URL 仅接受绝对 ws/wss，Android release 具备联网权限且明文 WS 仅限 debug | CL-103、CL-201 | `flutter test`（21/21）、`dart analyze`、Android debug APK 实际构建；真实服务/设备仍待 |
| 2026-09-07 | AI/DEV | Android API 37 Emulator 安装配置版 APK，经 `10.0.2.2` 完成开发 WS 登录和在线大厅；实尺寸暴露的 3 处底部溢出已修复并固化 2400×1080 回归 | CL-201、G1 前置 | `flutter test`（22/22）、重新构建/安装/截图；仅 Emulator/dev WS，不代表真机/WSS |
| 2026-09-08 | AI/DEV | 权威结算叠加顺序版本化为增→飘→花档→三西；转账保留完整阶段迹线，局结果携带版本，固化 1–4/5–9/10+ 花档与自摸不升档 | BE-306、BE-307 | `be-302-susong-scoring.test.js`、`npm run check`（Node 170/170）；三西关系生成仍 fail-closed |
| 2026-09-08 | AI/DEV | 胡牌与保留 14 张流局统一走服务端结算器；结算顺序版本/迹线必须穿过回合事件、原子快照和 RoomActor 重启恢复 | BE-306、BE-307 | `be-302-susong-scoring.test.js` + `be-303-susong-wall.test.js`（48/48） |
| 2026-09-08 | AI/DEV | 重放按冻结配置/增分重算持久结算迹线；即使 delta 仍零和，阶段换序、关系错置、小计或倍数篡改也必须 fail-closed | BE-306、BE-307 | `be-302-susong-scoring.test.js` + `be-303-susong-wall.test.js`（49/49） |
| 2026-09-08 | AI/DEV | CL-302 单局结算页只读渲染服务端 delta、累计积分、胜负关系和五阶段迹线；客户端不实现计分公式 | CL-302 | `flutter test`（23/23）、`dart analyze` |
| 2026-09-08 | AI/DEV | 对已确认计分域运行固定种子 10,000 组属性回放，要求确定性、零和与逐项迹线验证全部通过；不扩大到未签三西识别 | BE-308 | `be-308-susong-properties.test.js`（2/2，0 divergence） |
| 2026-09-08 | AI/DEV | 计分顺序版本必须由服务端规则注册表写入房间冻结快照，客户端同名伪造值不得生效 | BE-302、BE-307 | `be-301-susong-rule.test.js`（12/12） |
| 2026-09-08 | AI/DEV | 最新快照恢复必须重算结算迹线并比对冻结计分版本，不得把 snapshotHash 作为唯一完整性证据 | BE-307 | `be-303-susong-wall.test.js` + `be-202-event-store.test.js`（45/45） |
| 2026-09-08 | AI/DEV | 持久房间批量验证使用两次独立恢复比对最终版本/hash/完整快照，输出房间级结构化 divergence 并可 fail-closed | BE-307 | `be-307-room-replay-verifier.test.js`（2/2） |
| 2026-09-08 | AI/DEV | 服务端赢家摘要保留特殊胡型/杠开/无花果封顶原因，CL-302 只读展示；不强飘 0 花自摸不得标成飘花 | BE-306、CL-302 | 计分/牌局 51/51；Flutter 23/23 |
| 2026-09-08 | AI/DEV | 跨局庄位由上一局服务端结算唯一确定：首个赢家坐庄、流局连庄；下一局事件携带可重算庄位，客户端覆盖和事件篡改均拒绝，RoomService 自动完成下一局私密发牌 | BE-303、BE-307 | `be-303-susong-wall.test.js`（40/40，含持久化重试/重启）；首局庄仍待样本 |
| 2026-09-08 | AI/DEV | 结算页由房主按权威 roomVersion 触发下一局并复用客户端 outbox；非房主只等待，整场结束隐藏入口 | CL-302、CL-202 | Flutter 23/23、Dart/Flutter analyze 与协议脚本通过 |
| 2026-09-08 | AI/DEV | 起手强飘客户端只提交选择/打花意图；所有起手花状态解决后，服务端以 roundId 稳定命令幂等进入正式行牌 | BE-303、BE-305、CL-301 | 服务端 41/41；Flutter 24/24、analyze 通过 |
| 2026-09-08 | USER/AI/DEV | 单方累计吃碰同一对手 3 次建立双方三西；自摸/关系内点炮/第三方点炮分别按额外一份结算；关系双方被同一炮同时胡时解除且不互付 | DEC-RULE-005、BE-304、BE-306、BE-308 | `be-302-susong-scoring.test.js`、`npm run check`（Node 184/184）；Flutter 24/24 |
| 2026-09-08 | AI/DEV | 将已确认花档、增分、多响和三西规则整理为 20 个独立 JSON golden cases，逐例重算付款、四家 delta、关系解除和审计迹线 | BE-308、QA-301 | `be-308-susong-golden.test.js`（21/21）；待规则负责人整包验收 |
| 2026-09-08 | AI/DEV | 复核 APK 规则文本、protobuf 与客户端 Lua 字段：旧客户端只消费庄位、倒计时、剩余牌、三西等服务端结果，不能证明取牌方向、过圈解除、超时动作等内部裁决 | DEC-RULE-001/002/003/007/008、QA-301 | [规则验收清单](../rules/SUSONG_RULE_ACCEPTANCE.md)；六类外部证据待 USER + RULE |
| 2026-09-08 | USER/AI/DEV | 确认随机首庄、牌墙头摸/补花杠后尾补、本人摸牌解除过圈、倒计时归零继续等待；确认花奖独立叠加且三西不含花奖、多条三西逐关系结算 | DEC-RULE-003/005/007、BE-303/305/306/308 | `npm run check`（Node 214/214）；规则版本 `8931-apk-baseline.4` |
| 2026-09-08 | USER/AI/DEV | 确认红黑花分组、飘花禁碰杠风牌、吃后禁打同牌；庄家跳牌阶段取得第 14 张并直接先出；过圈仅在本人摸牌完成后解除 | DEC-RULE-001/002/003/005/007、BE-303/305 | `be-303-susong-wall.test.js`；规则版本 `8931-apk-baseline.5` |
| 2026-09-08 | AI/DEV | 补齐多人同时抢杠胡和放弃抢杠胡过圈的直接回归：巴杠声明者逐赢家付款，过圈只在该玩家随后实际摸牌时解除 | DEC-RULE-002/003/007、BE-304/305/308 | `be-303-susong-wall.test.js`；Node 220/220 |

## 8. 变更记录

| 版本 | 日期 | 变更 | 操作人 |
| --- | --- | --- | --- |
| 0.1.0 | 2026-08-28 | 创建 G0 决策、阻塞和基线证据模板 | AI/DEV |
| 0.1.1 | 2026-08-28 | 登记用户接受的推荐基线；保留未决细节为 TBD | AI/DEV + USER |
| 0.1.2 | 2026-08-28 | 登记 BE-103 session 和 WebSocket 鉴权证据 | AI/DEV |
| 0.1.3 | 2026-08-28 | 登记 BE-104 数据、BE-105 安全观测和 BE-106 CI 质量门证据 | AI/DEV |
| 0.1.4 | 2026-08-28 | 登记 33 个 Node 测试、CL-101 Dart 协议消费 POC、MemoryRepository 时间字段修复及 G1 工具链限制 | AI/DEV |
| 0.1.5 | 2026-08-28 | 登记 Flutter POC 壳、FakeTransport 和 CL-103 framework-neutral 重连核心；保留三端真机阻塞 | AI/DEV |
| 0.1.6 | 2026-08-28 | 登记 QA-101 四客户端 realtime/reconnect 与 reducer 缺口/重复 fixture；保留完整弱网矩阵阻塞 | AI/DEV |
| 0.1.7 | 2026-08-28 | 登记 BE-201 房间聚合完成、当前 `npm test` 40/40、CL-103 原生 `dart:io` transport 与扩展命令同步证据；保留 BE-202+、三端真机、规则和生产限制 | AI/DEV |
| 0.1.8 | 2026-08-29 | 登记 BE-202 内存 event store/RoomActor 契约和 Node 48/48；保留 WSS、真实 PG/Redis、多实例和三端真机限制 | AI/DEV |
| 0.1.9 | 2026-08-29 | 登记 BE-203 WSS gateway/RoomActor/reconnect 内存纵切和 Node 58/58；保留真实 PG/Redis、多实例、深度弱网和三端真机限制 | AI/DEV |
| 0.1.10 | 2026-08-29 | 登记 BE-204 重连基础、QA-201/BE-206 故障与重启 fixture 和 Node 68/68；保留生产 PG/Redis、多实例、服务端 deadline 和三端真机限制 | AI/DEV |
| 0.1.11 | 2026-08-29 | 登记服务关闭态/主动连接清理、CL-201 Flutter 房间桌面首版和 Flutter 6/6 widget 验收；保留生产 adapter、服务端 deadline、多实例和三端真机限制 | AI/DEV |
| 0.1.12 | 2026-08-29 | 登记 BE-204 显式 deadline 的内存/fake-staging scheduler、Room 回合 deadline 快照/恢复、超时事件广播和 Node 81/81；保留生产 PG/Redis deadline、多实例和三端真机限制 | AI/DEV |
| 0.1.13 | 2026-08-29 | 登记 BE-205 共享 RoomService 与内存/fake-staging HTTP API（ETag/If-Match/Idempotency-Key、鉴权和成员边界）；登记 BE-204 PostgreSQLGameEventStore/PostgresOutbox、RedisFencingLock adapter 基础和 Node 89/89；保留默认路径、presence overlay、持久化 deadline、多实例和三端真机限制 | AI/DEV |
| 0.1.14 | 2026-08-29 | 登记 BE-204 独立 `game_presence` overlay、RoomActor 恢复/快照 hash 合并、PostgreSQL/内存读写和 `createRealtimeServerAsync` 配置装配；登记 CL-202 ACK/超时/断线命令 outbox 与 Flutter 9/9；保留持久化 deadline、多实例和三端真机限制 | AI/DEV |
| 0.1.15 | 2026-08-29 | 登记 PostgreSQL `listRooms`/重启 deadline 恢复测试、升级 event-store contract 版本、OpenAPI/AsyncAPI YAML/ref/REST 契约门和 Node 95/95；保留生产 deadline claim、多实例、真实 PG/Redis 与三端真机限制 | AI/DEV |
| 0.1.16 | 2026-08-29 | 登记 `game_deadlines` migration、Memory/PostgreSQL deadline claim/lease store、双 scheduler winner-only/NOT_DUE 重试测试、稳定 UUID commandId 和 Node 99/99；保留真实 PG/Redis 多实例和三端真机限制 | AI/DEV |
| 0.1.17 | 2026-08-29 | 增加 `pg`/`redis` 运行依赖、`npm run verify:real` 临时数据库 smoke、deadline 边界/装配测试；质量门更新为 Node 104/104；真实 adapter 已验证，生产多实例和三端真机仍待 | AI/DEV |
| 0.1.18 | 2026-09-02 | 登记真实双实例收敛/crash-gap、CL-203 重连 UI、OPS-101 手册和 Node 106/106、Flutter 13/13；保留生产故障演练、G1、规则/俱乐部/钻石门禁 | AI/DEV |
| 0.1.20 | 2026-09-04 | 登记 BE-207 客服纯文本 REST、CL-201 四客户端 fake 夹具和共享 Dart `SupportApi`；保留真实 REST/设备联调、客服持久化、G1、规则/俱乐部/钻石门禁 | AI/DEV |
| 0.1.21 | 2026-09-07 | 登记 BE-301/303 版本化候选牌墙、可审计洗牌、开局发牌和脱敏边界；保留精确牌墙与补花方向规则门禁 | AI/DEV |
| 0.1.22 | 2026-09-07 | 登记 Room 私密牌墙 checkpoint、按玩家手牌投影、公共 snapshotHash 和重启恢复校验 | AI/DEV |
| 0.1.23 | 2026-09-07 | 登记服务端连续补花、起手自动补花、飘花打花、牌守恒及补花历史确定性恢复 | AI/DEV |
| 0.1.24 | 2026-09-07 | 登记权威摸出牌、手牌归属、摸花自动处理、私密回放/checkpoint 与保留 14 张流局 | AI/DEV |
| 0.1.25 | 2026-09-07 | 登记三家顺序响应/过牌窗口、重启恢复与服务端碰/明杠/吃候选识别 | AI/DEV |
| 0.1.26 | 2026-09-07 | 登记服务端权威碰牌、按玩家私有候选投影、公开牌组、操作历史守恒与原子恢复 | AI/DEV |
| 0.1.27 | 2026-09-07 | 登记服务端权威明杠、普通/风牌杠花、杠后尾部补牌、补到花连续处理及确定性恢复 | AI/DEV |
| 0.1.28 | 2026-09-07 | 登记服务端标准胡/七对/清混一色/碰碰胡、自摸/点炮、一炮多响收集、必胡自动结算、actor 原子恢复和补花保留墙边界修复 | AI/DEV |
| 0.1.29 | 2026-09-07 | 登记服务端权威下家吃牌、多顺子候选编号、暗杠花数/尾部补牌和私密确定性恢复；巴杠候选暂不执行，等待抢杠胡窗口 | AI/DEV |
| 0.1.30 | 2026-09-07 | 登记巴杠两阶段抢杠窗口、全过后提交补牌、抢杠取消与声明者支付，以及事件/私密状态确定性恢复 | AI/DEV |
| 0.1.31 | 2026-09-07 | 登记不必胡过圈阻断、本人回合清除及持久化恢复；清除边界版本化为 provisional | AI/DEV |
| 0.1.32 | 2026-09-07 | 登记全求人、天胡、地胡的权威历史识别及巴杠开花边界修复 | AI/DEV |
| 0.1.33 | 2026-09-07 | 登记 CL-301 权威手牌、出牌及吃碰杠胡动作面板和候选参数透传 | AI/DEV |
| 0.1.34 | 2026-09-07 | 登记 CL-301 公开弃牌、副露、花数、牌墙、当前行动者与 deadline 倒计时 | AI/DEV |
| 0.1.35 | 2026-09-07 | 登记 Flutter 可配置原生 WSS 运行时、登录环境标识、Android 联网权限与 debug-only 明文 WS 边界 | AI/DEV |
| 0.1.36 | 2026-09-07 | 登记 Android API 37 Emulator 开发 WS 登录、在线大厅、紧凑横屏溢出修复与可复核截图 | AI/DEV |
| 0.1.37 | 2026-09-08 | 登记 `zeng-piao-flower-sanxi-v1` 权威结算迹线、花档边界及自摸不升档 golden cases | AI/DEV |
| 0.1.38 | 2026-09-08 | 登记结算版本/迹线的房间事件、持久快照与重启恢复闭环，保留 14 张流局改为共用权威结算入口 | AI/DEV |
| 0.1.39 | 2026-09-08 | 登记权威结算迹线重算验证和篡改拒绝，BE-307 进入 IN_PROGRESS | AI/DEV |
| 0.1.40 | 2026-09-08 | 登记 CL-302 只读服务端单局结算页，整场汇总继续依赖 BE-501 | AI/DEV |
| 0.1.41 | 2026-09-08 | 登记 BE-308 已确认计分域 10,000 组确定性属性回放，正式 golden 签字仍待未决规则 | AI/DEV |
| 0.1.42 | 2026-09-08 | 登记服务端 `scoreOrderVersion` 房间快照冻结与客户端覆盖拒绝 | AI/DEV |
| 0.1.43 | 2026-09-08 | 登记最新持久快照的结算迹线重算与篡改拒绝 | AI/DEV |
| 0.1.44 | 2026-09-08 | 登记 BE-307 持久房间批量双恢复验证器与机器可读 divergence 报告 | AI/DEV |
| 0.1.45 | 2026-09-08 | 登记权威结算原因摘要与 CL-302 只读原因展示 | AI/DEV |
| 0.1.46 | 2026-09-08 | 登记 BE-303 首个赢家坐庄/流局连庄、庄位事件重放校验和下一局服务端自动发牌 | AI/DEV |
| 0.1.47 | 2026-09-08 | 登记 CL-302 房主下一局入口、roomVersion 并发保护和 outbox 重试闭环 | AI/DEV |
| 0.1.48 | 2026-09-08 | 登记起手强飘交互和花状态全解决后的服务端幂等自动开打 | AI/DEV |
| 0.1.49 | 2026-09-08 | 登记三西形成、三类付款、一炮双响解除、权威恢复审计和客户端只读提示 | USER/AI/DEV |
| 0.1.50 | 2026-09-08 | 登记 20 个机器可执行宿松计分 golden cases 与验收状态 | AI/DEV |
| 0.1.51 | 2026-09-08 | 登记规则纵切完成审计、APK 证据边界及剩余六类外部确认项 | AI/DEV |
| 0.1.52 | 2026-09-08 | 登记 `.4` 行牌边界、独立花奖与多重三西服务端纵切 | USER/AI/DEV |
| 0.1.53 | 2026-09-08 | 登记 CL-302 花奖独立转账的只读结算展示 | AI/DEV |
| 0.1.54 | 2026-09-08 | 登记 `.5` 红黑花分组、飘花风牌限制和吃后限制 | USER/AI/DEV |
| 0.1.55 | 2026-09-08 | 登记多人抢杠胡与放弃抢杠胡进入过圈的直接回归证据，并同步修正已确认首庄/取牌方向与红黑花决策状态 | AI/DEV |

## 9. 用户回复模板（可只回复已确定项）

```text
DEC-001 项目目录：继续使用 / 迁移到 ______
DEC-002 登录：______；实名/地区/年龄：______
DEC-003 俱乐部申请：创建 / 加入 / 两者；审批者：______
DEC-004 角色权限：______
DEC-005 楼层形态与 ruleSnapshot 冻结时点：______
DEC-006 房间访问：成员 / 邀请 / 房号 / 组合：______
DEC-007 积分生命周期：______
DEC-008～009 钻石：______（未定可写 sandbox）
DEC-010 客服渠道与 SLA：______
DEC-011 三端目标设备/API：______
规则负责人：______；规则确认截止：______
```
