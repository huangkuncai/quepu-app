# Android / iOS / HarmonyOS 设备矩阵模板

> 当前迭代仅执行 Android+iOS；HarmonyOS 条目保留为后续版本，暂不作为 G1 阻塞条件。

> 文档状态：`PLANNED`  
> 版本：`0.1.0-draft`  
> 关联决策：`DEC-011`、`G1`、`G4`  
> 重要说明：以下是登记模板，不代表已拥有设备、已完成测试或已承诺系统兼容范围。版本/API 在 W1 由项目负责人锁定，并在每个发布 manifest 中记录。

## 1. 使用说明

- 至少登记真实 Android、iPhone、HarmonyOS 设备各 1 台后，才可把 G1 标记为 `READY_FOR_RUN`。
- 模拟器/模拟器只能辅助自动化和布局检查，不能替代真机的 WSS、后台、推送、系统回收、签名安装和升级验收。
- “最低支持版本”是待决策字段，不根据当前开发机或截图猜测；填写后同步更新 `DEC-011`、商店声明和 CI。
- 纯鸿蒙 HAP/HSP 与旧鸿蒙 Android 兼容层 APK 是两条独立目标。若不支持其中一条，明确写 `OUT_OF_SCOPE`，不能用另一条结果代替。
- 同一设备换系统版本、ROM、渠道包或构建签名时，使用新的 `deviceId` 或新的运行记录，保留旧证据。

## 2. 项目目标与版本占位

| 字段 | 当前值 |
| --- | --- |
| 产品版本 | `1.0.0+1`（POC） |
| G1 POC 构建号范围 | `1.0.0+1`（待正式规划） |
| G4 RC 构建号范围 | `TBD` |
| 最低 Android API/版本 | `TBD`（相对基线：项目锁定后填写） |
| 最低 iOS 版本 | `TBD` |
| HarmonyOS NEXT / OpenHarmony 目标 API | `TBD` |
| 是否支持旧鸿蒙 Android APK | `TBD`（独立决策） |
| Android applicationId | `com.example.susong_app`（POC 占位，发布前必须替换） |
| iOS bundleId | `TBD` |
| Harmony bundleName | `TBD` |
| staging endpoint | `TBD` |
| 生产 endpoint | `TBD`（G4 前不写入 POC 包） |

## 3. 最小 G1 真机集合

这张表只定义“需要找到什么”，不预填具体品牌或型号。

| deviceId | 平台/目标 | 性能档位 | 系统/API | 设备/可用人 | 包类型 | 状态 | 证据 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `AND-LOW-01` | Android ARM64 | 低端、低内存 | `TBD` | `TBD` | AAB/APK debug | `TBD` | `TBD` |
| `AND-MID-01` | Android ARM64 | 中端 | `TBD` | `TBD` | AAB/APK debug | `TBD` | `TBD` |
| `IOS-BASE-01` | iPhone | 项目最低支持档 | `TBD` | `TBD` | signed IPA/TestFlight | `TBD` | `TBD` |
| `OHOS-MID-01` | HarmonyOS NEXT | 中端真机 | `TBD` | `TBD` | HAP（及需要时 HSP） | `TBD` | `TBD` |

G1 只有 1 台每个平台的最小集合时，结论范围限于这些设备；不得写“Android/iOS/鸿蒙全面兼容”。

## 4. 全量发布矩阵（G4 前补齐）

### 4.1 Android

| deviceId | 厂商/型号 | RAM/SoC | Android 版本/API | ROM | GMS/HMS | 网络 | 安装/升级 | 后台/回收 | WSS/弱网 | 结果/缺陷 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `EMU-API37-01` | Android Studio `Medium_Phone` Emulator | 4 GB / ARM64 | Android API 37 | Google Play image | GMS | Mac host dev WS | debug APK install/replace PASS | 未验 | 登录/online PASS | 仅模拟器开发证据；[截图](evidence/POC-20260907-01/android-emulator-wss-lobby.png) |

覆盖要求：

- ARM64 低端、中端、旗舰各至少 1 台。
- 覆盖项目锁定的最低 API、当前 API-1 和当前 API；实际数值由 W1 填写，不在模板中预设。
- 至少 1 台无 GMS 或以 HMS 为主的设备，验证登录、推送降级、WSS 和安全存储。
- 验证 AAB 内测包安装、覆盖升级、卸载重装、权限撤销、系统省电/后台回收和渠道签名。

### 4.2 iOS / iPadOS（若支持 iPad）

| deviceId | 型号/屏幕 | iOS/iPadOS 版本 | CPU/存储 | 网络 | TestFlight 安装/升级 | 后台/锁屏 | WSS/弱网 | 安全区/无障碍 | 结果/缺陷 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |

覆盖要求：

- 项目最低支持 iOS、latest-1、latest 各至少 1 台；版本在 W1 锁定。
- 至少 1 台旧款小屏/低性能 iPhone、1 台当前标准款；若产品支持 iPad，再加 iPad 横屏安全区场景。
- 验证 TestFlight 安装、覆盖升级、通知权限、锁屏、系统挂起/杀进程、Universal Links（如启用）和账号注销。
- 不以 iOS Simulator 代替真机网络、推送、后台和签名结果。

### 4.3 HarmonyOS / OpenHarmony

| deviceId | 目标类型 | 厂商/型号 | Harmony/OpenHarmony 版本/API | CPU/RAM | DevEco/工具版本 | HAP/HSP 安装/升级 | 后台/回收 | WSS/推送/存储 | 结果/缺陷 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `OHOS-LOW-01` | 纯鸿蒙 NEXT | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |
| `OHOS-MID-01` | 纯鸿蒙 NEXT | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |
| `OHOS-HIGH-01` | 纯鸿蒙 NEXT | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |
| `OHOS-COMPAT-01` | Android 兼容层（可选） | `TBD` | `TBD` | `TBD` | `TBD` | APK | `TBD` | `TBD` | `TBD` |

覆盖要求：

- 至少 1 台真实纯鸿蒙 NEXT 设备；DevEco 模拟器仅作辅助。
- 纯鸿蒙包按 HAP（需要时含 HSP）单独验收：安装、升级、权限、安全存储、网络、生命周期、推送和客服附件。
- 旧鸿蒙 Android 兼容层若列为目标，使用独立 APK 矩阵和独立发布声明；兼容层通过不能证明纯鸿蒙通过。
- ArkUI-X/原生 Bridge 或其他平台插件的每个能力都记录 SDK 版本、权限、降级和证据。

## 5. 网络与生命周期组合矩阵

| caseId | 网络/系统动作 | 期望连接行为 | 验证设备 | 状态 | 证据 |
| --- | --- | --- | --- | --- | --- |
| `NET-001` | 稳定 Wi-Fi，冷启动 | 登录/WSS 正常 | `TBD` | `TBD` | `TBD` |
| `NET-002` | Wi-Fi→4G/5G | 进入重连，恢复后 sync | `TBD` | `TBD` | `TBD` |
| `NET-003` | 4G/5G→Wi-Fi | 同上；不重复命令 | `TBD` | `TBD` | `TBD` |
| `NET-004` | 高延迟/丢包/乱序/重复 | reducer 按 roomVersion 幂等 | `TBD` | `TBD` | `TBD` |
| `NET-005` | 飞行模式 30s 后恢复 | 退避重连；不降级明文 | `TBD` | `TBD` | `TBD` |
| `LIFE-001` | 前台→后台 60s→前台 | 回前台先 snapshot/delta | `TBD` | `TBD` | `TBD` |
| `LIFE-002` | 锁屏/解锁 | 服务端 deadline 不暂停 | `TBD` | `TBD` | `TBD` |
| `LIFE-003` | 系统回收/用户强杀/重启 | 新 session 同步，私有手牌正确 | `TBD` | `TBD` | `TBD` |
| `LIFE-004` | 服务端滚动发布/维护事件 | 显示维护提示并可重连 | `TBD` | `TBD` | `TBD` |

建议注入参数（实际值写入报告）：丢包率 `TBD`%、延迟 `TBD`ms、断网时长 `TBD`s、后台时长 `TBD`min。

## 6. 每台设备必跑的 P0 流程

```text
冷安装 → 首次隐私占位页 → 假登录/刷新/退出
→ 大厅 mock → 俱乐部待审状态 → 楼层详情
→ 创建/加入四人 mock 房 → 收到公共事件与本人私有视图
→ 重复 commandId、跳过 roomVersion、非法动作
→ 断网 30s → 切后台/锁屏 → 恢复同步
→ 结算 mock/战绩 → 客服工单 → 升级安装 → 账号注销入口
```

每次失败记录：`deviceId`、OS/API、厂商 ROM、包 SHA256、步骤、时间、日志、录屏、严重级别、复现率、责任人和预计修复版本。日志必须脱敏，不保存 token、验证码或完整私有牌面。

## 7. 设备登记表（逐台复制）

```yaml
deviceId: TBD
platform: "android | ios | harmonyos"
targetType: "pure_harmony_next | android_compat_layer | ios | android"
vendor: TBD
model: TBD
osVersion: TBD
apiLevel: TBD
ramGb: TBD
cpuAbi: TBD
romOrDistribution: TBD
gmsOrHms: TBD
networkProfile: TBD
ownerOrLab: TBD
availableFrom: TBD
availableTo: TBD
debugBridge: TBD
signingChannel: "debug | internal | testflight | appgallery_internal"
notes: TBD
```

## 8. G1 真机就绪检查

- [ ] `DEC-011` 已指定三端目标边界、最低系统/API 和是否支持兼容层。
- [ ] Android 真机、iPhone、纯鸿蒙真机各至少 1 台，设备登记表完整。
- [ ] 测试账号、staging endpoint、WSS 证书链和 mock 数据已准备。
- [ ] 开发者/签名账号可用；证书、profile、HAP 签名材料不在仓库。
- [ ] 设备可安装 debug/internal 包，能够采集脱敏日志和录屏。
- [ ] 网络注入工具或可重复的弱网方法已确认。
- [ ] POC 验收表 [POC_ACCEPTANCE.md](POC_ACCEPTANCE.md) 的 runId 已建立。

## 9. G4 发布前汇总

| 平台 | 计划最低版本/API | 实际测试设备数 | P0 通过率 | P1 未关闭数 | 包类型/渠道 | Go/No-Go | 负责人/日期 |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| Android | `TBD` | `TBD` | `TBD` | `TBD` | AAB 内测→生产 | `TBD` | `TBD` |
| iOS | `TBD` | `TBD` | `TBD` | `TBD` | TestFlight→App Store | `TBD` | `TBD` |
| HarmonyOS | `TBD` | `TBD` | `TBD` | `TBD` | HAP/HSP→AppGallery | `TBD` | `TBD` |
