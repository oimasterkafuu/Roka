# 影子层（shadow，默认关闭）

`shadow.js` 是 relay 规划器的影子副本：在清图单线 1v1 里，每一帧都带完整
`grid_type`/`army_cnt`/`isolated` 与排行榜，而 relay 是完全确定性的（无
`Math.random`/`Date.now`，唯一伪随机是 `opening.js` 里固定 LCG）。把同样的帧重放
一遍 `relay-bot/planner.js` 的 `chooseOrders`，它的私有状态（`opening`/
`openingHome`/`homeApproach`、`column`/`columnTurn`、`lastFrom`/`lastMove`）与它自己的
棋盘逐 Tick 一致，于是它下一 Tick 要执行的指令在它发出之前就已知。

引擎每 Tick 按座位号升序结算，奇数 Tick 反序（`src/game-engine.ts` 的 `gameTick`），
所以一半 Tick 我们可以抢在 relay 之前（`turnFirst`），另一半它先落地（`turnSecond`）。
`adjust` 用引擎真实的 `computePush`（不是规划器的 `send` 变量）给两种顺序分别定价：

- 先手：抢占 relay 的出发格（它的指令因源格易主被丢弃，整个单线 Tick 白给，
  还能顺走那股兵）、抢占它即将建城的格子、在它攻击的目标格加防把整股推兵耗死、
  先手削弱那股兵让它打不动目标。
- 后手：不再往它即将拿下的格子里送兵（我们的指令会在它之后被校验）、在它拿下后
  用更大的推兵反抢、捡它刚腾空的出发格。
- 主城权重：我方主城被点名时防御/反抢加分更高（主城是经济锚点）。

## 门控与自保

- `BOT3_SHADOW=1` 才启用，默认关闭；关闭时 `predict` 立即返回 `null`，评分路径与
  基线逐字节一致（4 种子 relay，`MODES=000,010`，64 局 0 翻转，逐格 Δ0.0pp）。
- 只处理清图单线：迷雾里 relay 的私有地图不可观测，多线里它的队列（最多 16 条）
  没有建模，两者一律拒绝。
- **预热**：连续 `ARM_AFTER=6` 帧「预测的那条指令确实被执行」之后才开始改分。被丢弃
  的指令保持中性（relay 自己的兵力投影也可能偏差），但不算「对手是 relay」的证据，
  所以对其它 bot 预热永远不会完成（2 种子全量矩阵 256 局：apex/v2 逐格 0 翻转；
  anti 只有 1 局因为开局与 relay 同源而完成预热，结果 +1 胜，其余 0 翻转）。
- **漂移熔断**：两帧与预测不符（出发格兵力既不是「执行后」也不是「只增长」的值，
  或出发格易主）就整局关闭该层并回退到未改动的规划器。我们自己的指令碰到预测格
  时该帧记为「不可观测」并跳过校验。

## 实测

预测精度（`shadow-probe.cjs`，`SEED=relay-eval-1`，4 图 × 2 座位）：

| 指标                              | 值           |
| --------------------------------- | ------------ |
| 有预测的帧                        | 3080         |
| 与 relay 实际发出的指令逐字段一致 | 3080（100%） |
| 漂移事件                          | 0            |
| 不可观测帧（我方指令碰到预测格）  | 30           |
| 预热完成帧                        | 第 6 帧左右  |

relay 清图单线矩阵（`SEED 1..16`，32 局/格，配对比较 `baseline-results.jsonl`）：

| 格子          | 基线            | `BOT3_SHADOW=1` |       Δ | 65%  |
| ------------- | --------------- | --------------- | ------: | ---- |
| random        | 17/32           | 21/32（65.6%）  | +12.5pp | PASS |
| maze          | 21/32           | 23/32（71.9%）  |  +6.3pp | PASS |
| archipelago   | 16/32           | 17/32（53.1%）  |  +3.1pp | FAIL |
| mediterranean | 19/32           | 19/32（59.4%）  |   0.0pp | FAIL |
| 合计          | 73/128（57.0%） | 80/128（62.5%） |  +5.5pp |      |

`flips: winToLoss 9 / lossToWin 16 / lossToTimeout 1`。先手/后手帧数基本各半
（`turnFirst` 3138 / `turnSecond` 3134）；每局只有约 2 条入选指令的分数被真正改动
过（32 局合计 `selectedBonus` 63、`selectedPenalty` 9），但单条改动会级联，翻盘数
远大于命中数。增益并非均匀分布：`SEED 1..4` 单独只有 40/64（净 0），`SEED 5..16`
的 96 局是 40 胜对基线 33 胜，全部 +7 胜来自后半段种子。

**结论：没有达到验收线。** random/maze 过 65%，archipelago 与 mediterranean 仍不足
（需要 21/32），原因是镜像对局的接触面很窄：`adjust` 只能给已有候选项重新排序，
每局真正触及 relay 预测格的候选只有个位数，绝大部分 Tick 两个帝国的前线并不相邻。
默认保持关闭。

调参记录（同样 16 种子、同样口径，全为 `BOT3_SHADOW=1`）：

| 变体        | 总分   | 说明                                       |
| ----------- | ------ | ------------------------------------------ |
| B（当前）   | 80/128 | 保留「别白送」类小额负分                   |
| A（B 之前） | 82/128 | 没有 `hold`/`holdShort` 拆分、没有主城权重 |
| C           | 79/128 | 去掉全部「别白送」负分                     |
| D           | 79/128 | 按 relay 兵力放大先手收益                  |

A 与 B 的差别小于 4 局噪声（每格 32 局，1 局 = 3.1pp），因此 B 的拆分没有做二次确认。

## 复现

```sh
# 预测精度（逐帧对照 relay 实际发出的指令）
BOT3_SHADOW=1 BOT3_SHADOW_TRACE=1 SEED=relay-eval-1 MAP=random MODE=000 SEAT=0 \
  node bot-template/bot-3.0/shadow-probe.cjs

# relay 清图单线矩阵 + 配对比较
BOT3_SHADOW=1 WORKERS=2 SEED_FROM=1 SEED_TO=16 OPPONENTS=relay \
  MAPS=random,maze,archipelago,mediterranean MODES=000 \
  OUT=/tmp/sh.jsonl SUMMARY=/tmp/sh.json node scripts/evaluate-bot3-baseline.cjs
NO_GATE=1 node scripts/compare-bot3-baseline.cjs /tmp/sh.jsonl

# 关闭开关的对照（必须与基线逐局一致）
WORKERS=2 SEED_FROM=1 SEED_TO=4 OPPONENTS=relay MODES=000 \
  OUT=/tmp/off.jsonl SUMMARY=/tmp/off.json node scripts/evaluate-bot3-baseline.cjs
```

## 已知限制

- 只对「下一 Tick 队头那条指令」定价。relay 偶尔在一帧里排队两条（`build`+`move`，
  单线里只有队头执行），被挤在后面的那条没有建模。
- 只重排已有候选，不新增候选：预测到 relay 后方建城/主城空虚时，若手头没有相邻的
  候选兵，这层无能为力。
- 依赖 `../relay-bot/planner`（只读）。路径缺失（例如只发布 `bot-3.0` 包）时自动
  降级为 no-op。
- 多线与迷雾格子没有收益，也没有副作用（直接拒绝）。
