# 宿松麻将服务端规则验收清单

> 状态：已完成可验证纵切；未决项继续 `provisional/fail-closed`。  
> 参考 APK SHA-256：`4da9c2e4c4c006bd1dad9f378ecd895bd2852eff9d7402b167070ce924c72ddb`。

## 1. 已完成且有自动化证据

| 范围 | 服务端行为 | 主要证据 |
| --- | --- | --- |
| 巴杠/抢杠胡 | 巴杠声明期间不改牌组、私牌或牌墙；三家响应后，有胡则取消巴杠并由声明者点炮，无胡才升级并补牌；允许多人同时抢杠胡并分别结算 | `test/be-303-susong-wall.test.js` |
| 首庄与取牌 | 首局庄家由服务端随机产生；普通摸牌取牌墙头，补花和杠后补牌取牌墙尾 | `test/be-303-susong-wall.test.js` |
| 庄家天胡 | 庄家跳牌取得 14 张后直接处于出牌阶段；零行牌历史即可由服务端识别天胡并按一索结算，全程不生成首次摸牌事件 | `test/be-303-susong-wall.test.js` |
| 过圈 | 不必胡时放弃点炮胡/抢杠胡后屏蔽后续点炮胡；自摸不受影响；仅在本人随后实际摸牌后解除，吃碰杠取得出牌权不解除 | `test/be-303-susong-wall.test.js` |
| 超时 | 倒计时可降到 0，但服务端继续等待，不自动过、不托管、不代替玩家执行动作 | `test/be-204-room-deadline-integration.test.js` |
| 三西形成 | 单方累计吃/碰同一对手 3 次建立双方关系；巴杠仍按原碰计一次，明杠/暗杠不新增次数 | `test/be-302-susong-scoring.test.js` |
| 三西结算 | 自摸对象额外一份；关系内点炮共两份；第三方点炮时三西对象连带一份 | `test/be-302-susong-scoring.test.js` |
| 同炮解除 | C 一炮多响同时被有三西关系的 A/B 胡牌时，AB 关系解除且不互付，C 仍分别正常付款 | `test/be-302-susong-scoring.test.js` |
| 多重三西 | 同一赢家与多人存在三西时，每条关系独立增加一份不含花奖的胡牌分 | `test/fixtures/rules/susong-scoring-golden.json` |
| 花奖 | 与胡牌档位独立；按第二底分档逐奖累加，三家分别支付；点炮者取消自身花奖、流局全取消，三西份额不含花奖 | `test/be-309-susong-flower-award.test.js` |
| 花奖组合 | 箭牌四张同种、三种箭牌各三张、特殊牌累计四个对子均各成一奖；组合允许重叠，4 红中 + 4 发财为 3 奖 | `test/be-309-susong-flower-award.test.js` |
| 红黑花分组 | 春夏秋冬归为红花，梅兰竹菊归为黑花；与中发白共同组成四对子花奖的五种牌 | `test/be-309-susong-flower-award.test.js` |
| 飘花风牌限制 | 飘花玩家不能碰或杠风牌，服务端不投影相应候选，伪造动作会被拒绝 | `test/be-303-susong-wall.test.js` |
| 吃后限制 | 吃牌取得出牌权后，不能立即打出与所吃进牌相同的牌面 | `test/be-303-susong-wall.test.js` |
| 动作优先级 | 同一张弃牌按胡 > 碰/明杠 > 吃裁决，与三家响应先后无关；同一玩家可碰或明杠时由本人选择 | `test/be-303-susong-wall.test.js` |
| 连续杠开 | 当前出牌权内连续两次及以上杠后自摸进入一索；出牌或下一次普通摸牌会切断杠链，旧回合杠次数不累计 | `test/be-303-susong-wall.test.js` |
| 权威与恢复 | 三西从公开牌组历史重算；客户端关系、分数、缺失关系或伪造解除不能通过持久化审计 | `src/domain/room.js`、`src/domain/rules/susong-scoring.js` |
| 计分回归 | 22 个 JSON golden cases + 固定种子 10,000 组属性回放，校验档位、付款、四家零和及迹线 | `test/fixtures/rules/susong-scoring-golden.json`、`test/be-308-susong-properties.test.js` |

当前质量门：`npm run check` 为 Node 223/223；Flutter 24/24，静态分析无问题。

## 2. APK 能证明与不能证明的边界

APK 内置 `assets/res/common/8931_rule.txt` 可证明：上一局首个赢家坐庄、流局连庄、剩余 14 张流局、花档、杠花、必胡/不必胡和“必须过圈”等文字规则。

`assets/res/pb/MsgXYSSMJ.pb` 只表明旧服务端会向客户端下发 `hChair`、`lastNum`、`ctrlArr`、`ctrlTime`、`flowerCards`、`sanxiChairs` 等结果。上述服务端内部裁决现以规则负责人书面确认作为依据，而不是从客户端字段倒推。

## 3. 正式规则仍需提供的最小证据

本轮冲突项已确认：庄家在发牌阶段通过跳牌取得第 14 张，进入行牌后直接先出牌，不存在“庄家首次摸牌”；过圈只在本人摸牌完成后解除。后续若补充尚未列入基线的特殊牌型或冲突场景，继续增加 golden case，不从通用麻将习惯猜测。

这些答案会改变牌墙、合法动作或不可逆积分结果，不能用客户端表现或常规麻将习惯代替旧服务端规则。

## 4. 验收命令

```bash
cd "/Users/huangkuncai/Documents/ChatGPT/宿松app.migrated-backup"
npm run check

cd clients/flutter_app
dart analyze
flutter test
```
