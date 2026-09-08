# 宿松麻将服务端规则验收清单

> 状态：已完成可验证纵切；未决项继续 `provisional/fail-closed`。  
> 参考 APK SHA-256：`4da9c2e4c4c006bd1dad9f378ecd895bd2852eff9d7402b167070ce924c72ddb`。

## 1. 已完成且有自动化证据

| 范围 | 服务端行为 | 主要证据 |
| --- | --- | --- |
| 巴杠/抢杠胡 | 巴杠声明期间不改牌组、私牌或牌墙；三家响应后，有胡则取消巴杠并由声明者点炮，无胡才升级并补牌 | `test/be-303-susong-wall.test.js` |
| 过圈 | 不必胡时放弃点炮胡/抢杠胡后屏蔽后续点炮胡；自摸不受影响；候选状态进入事件、快照和恢复 | `test/be-303-susong-wall.test.js` |
| 三西形成 | 单方累计吃/碰同一对手 3 次建立双方关系；巴杠仍按原碰计一次，明杠/暗杠不新增次数 | `test/be-302-susong-scoring.test.js` |
| 三西结算 | 自摸对象额外一份；关系内点炮共两份；第三方点炮时三西对象连带一份 | `test/be-302-susong-scoring.test.js` |
| 同炮解除 | C 一炮多响同时被有三西关系的 A/B 胡牌时，AB 关系解除且不互付，C 仍分别正常付款 | `test/be-302-susong-scoring.test.js` |
| 权威与恢复 | 三西从公开牌组历史重算；客户端关系、分数、缺失关系或伪造解除不能通过持久化审计 | `src/domain/room.js`、`src/domain/rules/susong-scoring.js` |
| 计分回归 | 20 个 JSON golden cases + 固定种子 10,000 组属性回放，校验档位、付款、四家零和及迹线 | `test/fixtures/rules/susong-scoring-golden.json`、`test/be-308-susong-properties.test.js` |

当前质量门：`npm run check` 为 Node 205/205；Flutter 24/24，静态分析无问题。

## 2. APK 能证明与不能证明的边界

APK 内置 `assets/res/common/8931_rule.txt` 可证明：上一局首个赢家坐庄、流局连庄、剩余 14 张流局、花档、杠花、必胡/不必胡和“必须过圈”等文字规则。

`assets/res/pb/MsgXYSSMJ.pb` 只表明旧服务端会向客户端下发 `hChair`、`lastNum`、`ctrlArr`、`ctrlTime`、`flowerCards`、`sanxiChairs` 等结果。客户端收到的是裁决结果，不足以反推出旧服务端内部的取牌方向、首局选庄、过圈解除和超时动作。编译后的客户端 Lua 同样只消费这些字段。

## 3. 正式规则仍需提供的最小证据

以下任一项可用“旧服连续录屏 + 对局日志/结算截图”或规则负责人书面确认解除：

1. 首局庄家如何产生：随机、房主、首座或其他策略。
2. 正常摸牌、补花和杠后补牌从牌墙哪一端取，以及 14 张保留区的精确口径。
3. 不必胡放弃后，“过圈”在哪个时点解除：本人摸牌、取得出牌权、实际出牌或完整一圈。
4. 吃/碰/杠/胡并发时的最终优先级，以及响应超时、飘花选择超时的默认动作。
5. 花奖与胡牌分同时出现时的封顶、舍入和取消顺序。
6. 同一玩家同时拥有两条及以上三西关系时，自摸、第三方点炮和一炮多响的完整结算样本。

这些答案会改变牌墙、合法动作或不可逆积分结果，不能用客户端表现或常规麻将习惯代替旧服务端规则。

## 4. 验收命令

```bash
cd "/Users/huangkuncai/Documents/ChatGPT/宿松app.migrated-backup"
npm run check

cd clients/flutter_app
dart analyze
flutter test
```

