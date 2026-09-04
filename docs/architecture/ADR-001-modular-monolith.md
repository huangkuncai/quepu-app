# ADR-001：BE-101 模块化单体骨架

- 状态：Accepted for development baseline
- 日期：2026-08-28
- 范围：后端 BE-101；不代表真实认证、麻将裁判或钻石业务已经上线

## 背景

当前仓库只有一个 `ws` 入口和进程内房间 Map。后续需要同时支持 Android、iOS、鸿蒙客户端，以及登录、大厅、俱乐部、楼层、房间实时同步、规则插件、战绩、客服和后台。直接继续堆叠在 `src/server.js` 会让权限、协议、规则和账本边界互相耦合；现在拆成微服务又会在认证、事件一致性和部署尚未稳定时引入额外网络故障。

## 决策

1. 第一阶段采用模块化单体。代码边界固定为 `auth`、`lobby`、`club`、`floor`、`room`、`realtime`、`game`、`ledger`、`history`、`support`、`admin`。
2. 每个模块先只提供边界元数据和未来入口，不在 BE-101 偷渡真实业务。现有 `src/server.js` 和 `src/domain/*` 保持兼容，后续任务通过适配器逐步迁移。
3. 所有运行配置从 `src/config/env-schema.js` 的单一 schema 解析；未知环境变量允许存在，但应用配置必须有类型、默认值和范围校验。秘密不进入 schema、`.env.example` 或仓库。
4. 所有跨模块错误使用 `src/shared/errors.js` 的稳定错误码 registry；传输层只输出安全的 `{requestId,error:{code,message,retryable}}` 形状。
5. 生产配置默认 fail-closed：当前 `AUTH_MODE=stub`、真实规则和真实钻石开关不能通过生产安全检查。BE-103、BE-301/306、BE-401/405 完成并评审后，才允许替换为真实实现。
6. `npm run lint`、`npm run typecheck`、`npm test` 和组合命令 `npm run check` 作为本地质量门；当前 JavaScript 项目使用 Node 语法/导出契约检查，未来引入 TypeScript 后再升级为编译型 typecheck。

## 模块责任边界

| 模块 | 只负责 | 当前不负责 |
| --- | --- | --- |
| auth | 身份、会话、封禁接口边界 | 真实 OTP/JWT 提供商（BE-103） |
| lobby | 大厅聚合查询边界 | 房间裁判、支付 |
| club | 俱乐部申请与成员权限边界 | 后台审批实现（BE-401） |
| floor | 楼层/规则版本边界 | 未确认的规则默认值 |
| room | 房间/回合生命周期边界 | 牌型和计分 |
| realtime | WSS 命令/事件传输边界 | 客户端裁判 |
| game | 规则插件和结算边界 | 未签字的宿松规则 |
| ledger | 积分/钻石账本边界 | 客户端充值或现金交易 |
| history | 战绩和回放查询边界 | 修改历史结果 |
| support | 客服工单边界 | 支付争议处理 |
| admin | 特权操作和审计边界 | 绕过审计的人工改库 |

## 后果与迁移策略

- 短期部署仍是一个 Node 进程，便于本地和 staging 验证；模块接口稳定后可按负载拆分服务。
- 房间、事件、账本的事实来源和 actor/Redis 设计在 BE-104、BE-202 决定；BE-101 不引入数据库依赖。
- 新模块不得直接读取别的模块内部 Map；跨边界通过明确的 command/query 接口和错误码。
- 真实规则、钻石、外部认证和支付相关能力必须通过后续任务、决策记录和 feature flag 进入；客户端永不获得充值/提现路由。
- 本 ADR 不解决截图中的规则歧义；未决项保持 `TBD`，只能使用 fake/sandbox。
