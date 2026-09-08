# G1 跨端 POC 验收模板

> 文档状态：`IN_PROGRESS`（Flutter 本机 POC 已有证据；G1 真机门仍阻塞）  
> 版本：`0.1.0-draft`  
> 关联决策：`DEC-011`、`G1`  
> 前置条件：G0 尚未完成时只能使用 mock/fake/sandbox；本表不构成框架选型或真机支持承诺。

## 1. POC 目标

在不引入正式客户端依赖和不承诺三端真机兼容的前提下，验证候选客户端技术路线能否共享协议/领域契约，并完成最小实时链路：

```text
启动 → 隐私占位页 → 假登录 → 大厅 mock → 创建/加入四人房
     → 接收公共事件与本人私有视图 → 断网/切后台
     → 回前台以 lastRoomVersion 同步 → 客服表单 stub → 安全退出
```

服务端只作为测试事件源；客户端不实现发牌、合法动作、计分或钻石扣除。若使用当前 Node 骨架，必须在隔离的开发 endpoint 上运行，并在报告中标记其缺少正式 Auth、TLS、数据库和 Redis。

## 2. 候选方案登记（不预选）

| 候选 ID | 方案 | POC 分支/提交 | 已验证平台 | 未验证风险 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `CAND-ARKUIX` | ArkUI-X/ArkTS + 平台适配层 | `TBD` | `TBD` | Bridge、推送、安全存储、客服、上架工具链 | `PLANNED` |
| `CAND-FLUTTER` | Flutter Android/iOS（HarmonyOS 暂缓） | `clients/flutter_app` | 本机 Flutter 测试、Android API 37 Emulator 开发 WSS | Android/iOS 真机、WSS 证书链、签名、后台/弱网和长期维护 | `EMULATOR_POC_PASS / G1_BLOCKED` |
| `CAND-OTHER` | 评审后新增候选（需说明理由） | `TBD` | `TBD` | `TBD` | `DEFERRED` |

候选评分只用于 G1 决策，不等同于产品承诺：

| 维度 | 权重 | 评分证据（填写链接/报告） |
| --- | ---: | --- |
| HarmonyOS 目标能力和纯鸿蒙包构建 | 30% | `TBD` |
| Android/iOS 真机稳定性 | 20% | `TBD` |
| WSS、生命周期和弱网恢复 | 20% | `TBD` |
| 安全存储、推送、客服等平台适配 | 15% | `TBD` |
| 构建签名、CI 和商店风险 | 10% | `TBD` |
| 团队交付成本和可维护性 | 5% | `TBD` |

## 3. POC 环境登记

| 字段 | 值 |
| --- | --- |
| `runId` | `POC-YYYYMMDD-XX` |
| 执行日期/时区 | `TBD` |
| 执行人/复核人 | `TBD` |
| 仓库 git SHA | `TBD` |
| 客户端构建号 | `TBD` |
| 协议版本/schema SHA | `TBD` |
| 服务端环境 | `mock` / `dev` / `staging`（勾选） |
| endpoint | `TBD`（禁止把 token 放 URL） |
| 服务端版本/配置 | `TBD` |
| 规则模式 | `fake` / `draft`；不得标为生产规则 |
| 账本模式 | `sandbox`；不得扣真实钻石 |
| 证据目录 | `artifacts/client-poc/<runId>/` |

## 4. 必测用例

状态值：`PASS`、`FAIL`、`BLOCKED`、`N/A`、`TBD`。`N/A` 必须写明原因；未执行不得写 `PASS`。

| ID | 场景与步骤 | 预期 | 严重级别 | 状态 | 证据/缺陷 |
| --- | --- | --- | --- | --- | --- |
| `POC-001` | 冷安装并启动；检查包名、版本、隐私占位页、安全区 | 启动成功；无崩溃；不请求非必要权限 | P0 | `TBD` | `TBD` |
| `POC-002` | 假登录→保存 session→重启→安全退出 | session 可恢复/撤销；日志不含 token | P0 | `TBD` | `TBD` |
| `POC-003` | 建立 WSS（或隔离 dev WS）并完成 ping/pong、hello/auth | 连接状态可观测；错误可显示 | P0 | `TBD` | `TBD` |
| `POC-004` | 四个客户端实例进入同一 mock 房间 | 公共事件均到达；玩家视图隔离 | P0 | `TBD` | `TBD` |
| `POC-005` | 接收 snapshot + 增量事件；故意跳过一个 `roomVersion` | 检测缺口并请求 sync；不自行补事件 | P0 | `TBD` | `TBD` |
| `POC-006` | 相同 `commandId` 提交两次 | 只显示一次 ACK/一次事件；无重复动作 | P0 | `TBD` | `TBD` |
| `POC-007` | 非回合/非法 payload/过期 version | 显示明确错误；客户端不改变权威状态 | P0 | `TBD` | `TBD` |
| `POC-008` | Wi-Fi 断开 30s 后恢复；切 Wi-Fi↔蜂窝 | 自动退避重连并以 `lastRoomVersion` 同步 | P0 | `TBD` | `TBD` |
| `POC-009` | 前台→后台 60s→前台；锁屏；系统回收或用户杀进程后重启 | 不承诺后台长连接；回前台/重启先同步，服务端 deadline 不暂停 | P0 | `TBD` | `TBD` |
| `POC-010` | 网络高延迟/丢包/乱序/重复事件注入 | reducer 幂等且最终状态与服务端一致 | P0 | `TBD` | `TBD` |
| `POC-011` | mock 大厅→俱乐部待审状态→楼层详情 | 待审用户不能进入受限房间；只读规则详情可展示 | P1 | `TBD` | `TBD` |
| `POC-012` | mock 客服表单（文本、版本、roomId 可选）提交/失败重试 | 表单可提交；敏感字段脱敏；失败可重试 | P1 | `TBD` | `TBD` |
| `POC-013` | 查看 diamondBalance/预占状态 mock | 只读显示；无充值、支付、提现、兑换、转赠入口或 SDK | P0 | `TBD` | `TBD` |
| `POC-014` | 无效证书/过期 token/服务端维护事件 | 安全失败并给出可恢复提示；不降级到明文 WS | P0 | `TBD` | `TBD` |
| `POC-015` | 横竖屏/刘海/字体放大/深色模式/基础无障碍 | 无关键控件遮挡或不可操作 | P1 | `TBD` | `TBD` |
| `POC-016` | CI 重复构建 debug 包并记录 manifest | 构建可复现；包含 git SHA、协议版本和构建号 | P1 | `TBD` | `TBD` |

### 4.1 POC 性能记录

指标是建议门槛，不是已承诺 SLO；若未达标，记录设备、网络和采样方式后由 G1 评审决定。

| 指标 | 建议门槛 | 实测 | 测量方法/证据 |
| --- | ---: | ---: | --- |
| 冷启动到可交互 | ≤ 2s（普通网络/目标中端） | `TBD` | `TBD` |
| 重连并完成同步 | ≤ 3s（普通网络） | `TBD` | `TBD` |
| 房间事件端到端 P95 | ≤ 200ms（staging） | `TBD` | `TBD` |
| 牌桌滚动/动画 | 目标 55–60 FPS，需注明设备 | `TBD` | `TBD` |
| 内存峰值/持续 30 分钟 | 不发生 OOM 或明显增长 | `TBD` | `TBD` |
| POC 崩溃/ANR | 0 个 P0 复现 | `TBD` | `TBD` |

## 5. 平台差异与适配器检查

业务层不得散落平台判断；每项由 `native-adapters` 提供接口和 fake 实现。未支持能力必须写降级行为。

| 能力 | Android | iOS | HarmonyOS | 降级/证据 |
| --- | --- | --- | --- | --- |
| 安全存储 session | `TBD`（Keystore） | `TBD`（Keychain） | `TBD`（安全存储） | 失败时不落明文；`TBD` |
| 网络状态/生命周期 | `TBD` | `TBD` | `TBD` | 前后台均触发 sync；`TBD` |
| 推送（非敏感提醒） | FCM/HMS 按渠道 | APNs | Huawei Push | 无推送不影响牌局；`TBD` |
| 客服附件/分享 | `TBD` | `TBD` | `TBD` | 私有存储、大小/MIME 校验；`TBD` |
| 深链/邀请 | App Links | Universal Links | 目标能力待定 | URL 只含一次性 opaque token；`TBD` |
| 横竖屏/安全区/无障碍 | `TBD` | `TBD` | `TBD` | 不以单一模拟器结论替代真机；`TBD` |

## 6. G1 决策门

### 6.1 必须满足的出口条件

- 每个候选至少在一台 Android、一台 iPhone、一台 HarmonyOS 真机完成 P0 用例 `POC-001`～`POC-010`、`POC-013`、`POC-014`。
- 若真机、开发者账号或签名材料尚未提供，状态必须为 `BLOCKED`；模拟器结果可以用于发现问题，但不能写成 G1 通过。
- 所有 P0 用例为 `PASS`，无开放 P0/P1 阻塞；性能差异和未支持原生能力有书面风险接受人。
- 共享协议/schema、事件 reducer、session/重连契约已经可以独立于 UI 框架测试。
- 形成候选评分、成本/风险、插件清单、上架路径和降级方案，由 `USER/PM`、客户端负责人、QA 签字。

### 6.2 决策结果模板

| 项目 | 结果 |
| --- | --- |
| 选定主方案 | `TBD`（不在本模板预填） |
| 选定版本/SDK | `TBD` |
| 共享协议/领域包 | `TBD` |
| HarmonyOS 目标 | `TBD`（纯鸿蒙 HAP / 兼容层 APK / 两者） |
| 保留降级方案 | `TBD` |
| 未解决风险与 owner | `TBD` |
| 预计进入 G2 日期 | `TBD` |
| USER/PM 签字 | `TBD` |
| 客户端负责人签字 | `TBD` |
| QA 签字 | `TBD` |

### 6.3 不通过时的动作

1. 保留已验证的 JSON Schema、协议测试、事件 reducer 和适配器接口。
2. 只替换 UI/平台壳，不迁移未验证的业务逻辑或规则裁判。
3. 将失败原因、设备/SDK、复现步骤和下一次验证条件记入风险登记；重新执行受影响用例。
4. G1 未通过前，继续使用 mock/fake/sandbox，不接入真实钻石、真实用户或生产牌局。

## 7. 证据目录模板

```text
artifacts/client-poc/<runId>/
  manifest.json          # gitSha/buildNumber/protocolVersion/endpoint
  device.json            # 对应 DEVICE_MATRIX 的 deviceId
  install-upgrade.mp4
  reconnect.mp4
  logs/                  # 已脱敏；禁止 token/验证码/完整私牌
  network/               # 仅保留必要元数据；敏感 payload 脱敏
  screenshots/
  performance.json
  defects.md
  signoff.md
```

## 8. 运行记录（每次新增一行，不覆盖历史）

| runId | 候选 | deviceId | 日期 | git SHA | 用例范围 | 结果 | 证据 | 复核人 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `POC-20260907-01` | Flutter Android | `Medium_Phone` Emulator / API 37 | 2026-09-07 | `d054a91` + layout fix | debug APK 安装、横屏启动、dev WS 登录/在线、2400×1080 布局 | `PASS (EMULATOR ONLY)` | [大厅截图](evidence/POC-20260907-01/android-emulator-wss-lobby.png) | AI/DEV |
| `POC-20260908-02` | Dart real WSS harness | 4 个 host Dart 进程 | 2026-09-08 | 当前分支 | 建房/加入/准备/发牌、版本/hash、私牌隔离、替换客户端恢复 | `PASS (LOOPBACK ONLY)` | `npm run verify:client-real` | AI/DEV |

当前本机证据（不替代真机记录）：`clients/flutter_app` 执行 `flutter test` 26/26、`dart analyze` 和 Android debug APK 构建通过；Android API 37 Emulator 已经开发 WS 登录。真实 Node WSS loopback 四客户端已完成房间全流程、权威版本/hash、私牌隔离与断线替换恢复。当前未连接 production/staging WSS，也未完成 Android/iOS 四真机弱网和签名验收；`G1_BLOCKED` 保持不变，鸿蒙暂缓。
