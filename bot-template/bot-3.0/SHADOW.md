# 影子层（shadow，默认开启）

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

## 候选创造（子开关）

重新排序只能动已有候选，而前线循环本身只看「相邻一格」。预测已知 relay 下一 Tick
去哪，所以这层也会**新建**候选（`planner.js` 在 `shadowAdjust` 之后调用 `shadowPlan`，
新候选项随后走同样的 `take`：`lastFrom`/`lastMove` 反悔记账、maze 车道纪律都照旧）：

| 子开关                 | 默认 | 作用                                                                                                                                     |
| ---------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `BOT3_SHADOW_INVALID`  | 开   | 后手时「relay 先落地、我们打同一个格」的指令若打不过残兵，直接投票否决（`op.veto`），单线唯一的名额让给下一条；每局省下一次白给。        |
| `BOT3_SHADOW_APPROACH` | 关   | 预测目标（建城/主城/指挥所）距离我方某股 ≥6 兵 2..4 步时，补一条朝它靠近一格的候选；`st.plan` 记住上一 Tick 的台阶，避免在两格之间来回。 |
| `BOT3_SHADOW_PUNISH`   | 关   | 后手且 relay 这 Tick 攻下目标时，它出发格只剩 1 兵（模式 2 只留 1）：给相邻的我方股补一条反抢候选。                                      |
| `BOT3_SHADOW_RACE`     | 关   | 我方地块落后 ≥2 时，给所有「小股→空格」的扩张边上分（burst 期一格 = 每 Tick 一兵）。                                                     |
| `BOT3_SHADOW_GUARD`    | 关   | 只剩一座主城时，用全图视野 + 预测推兵量估算两 Tick 内能打到主城的最强股，提前补防。                                                      |
| `BOT3_SHADOW_HOLD`     | 关   | 先手且预测会打下我方锚点时，从相邻股补一条增援（relay 整股撞死在加固后的格子上）。                                                       |
| `BOT3_SHADOW_FREE`     | 关   | relay 这 Tick 的推兵**远离**我方主城且 ≥12 兵时，视为「空档期」，给朝它主城的靠近步上分。                                                |

## 严格预热（`BOT3_SHADOW_ARM`，默认 28）

整层都在同一个闸门后面：**连续 `K=28` 帧**「预测的那条指令就是 relay 实际执行的那条」
才开始改分，并且**第一帧对不上就整局关闭**（不是两帧）。被丢弃的指令（只增长了、
没有执行）算「无证据」并打断连击；我们自己指令碰到预测格的帧记「不可观测」并跳过。

这条闸门是为了 anti：它的策略与 relay 同源（开局逐帧一致），旧版 6 帧预热会让影子层
误判成 relay 并给 anti 的局面乱定价（8 种子现网实测：anti 清图单线 archipelago
16/32 对基线 19/32 = -9.4pp）。实测 anti 的最长连击是 **25**（32 局采样），relay 是
100+，所以 `K=28` 既隔离了 anti 又不挡 relay：

| K（连续帧）         | anti 清图单线 4 格   | relay archipelago | maze | mediterranean | random |
| ------------------- | -------------------- | ----------------- | ---- | ------------- | ------ |
| 6（旧版，无严格闸） | -9.4 / -6.3 / +6.3pp | 17                | 23   | 19            | 21     |
| 24                  | 全部 Δ0.0pp，0 翻转  | 17                | 21   | 19            | 23     |
| 28（默认）          | 全部 Δ0.0pp，0 翻转  | 17                | 23   | 19            | 22     |
| 32                  | 全部 Δ0.0pp，0 翻转  | 16                | 21   | 15            | 21     |
| 48                  | 全部 Δ0.0pp，0 翻转  | 16                | 21   | 16            | 21     |

（K≥24 时 anti 四格逐局与基线完全一致，`flips` 全 0；更高 K 不再增加安全性，只是
让 relay 的 mediterranean 掉 3..4 胜，因为连击要跨过 relay 早期偶尔被丢弃的指令。）

镜像经济签名（`|land 差| ≤ 2` 且 `|army 差| ≤ 8`，`BOT3_SHADOW_MIRROR=1` 打开）也实现了：
在 `K=28` 下它挡不住 anti（anti 连击本来就 ≤25），反而会误伤 relay——有些合法 relay
对局在连击完成时双方兵力已差 8 以上，实测 maze 从 23 掉到 21，因此默认关闭。

## 门控与自保

- 默认开启（`BOT3_SHADOW=0` 关闭）；关闭时 `predict` 立即返回 `null`，评分路径与
  基线逐字节一致（4 种子 relay，`MODES=000,010`，64 局 0 翻转，逐格 Δ0.0pp）。
- 只处理清图单线：迷雾里 relay 的私有地图不可观测，多线里它的队列（最多 16 条）
  没有建模，两者一律拒绝。
- **严格预热**：连续 28 帧精确命中才启用（见上一节），第一帧不符即整局关闭。
- **漂移熔断**：出发格兵力既不是「执行后」也不是「只增长」的值、或出发格易主，就是
  一帧「不符」，立刻关闭该层并回退到未改动的规划器。我们自己的指令碰到预测格时该帧
  记为「不可观测」并跳过校验（不打断连击，也不算命中）。

## 实测

预测精度（`shadow-probe.cjs`，`SEED=relay-eval-1`，4 图 × 2 座位）：

| 指标                              | 值           |
| --------------------------------- | ------------ |
| 有预测的帧                        | 3080         |
| 与 relay 实际发出的指令逐字段一致 | 3080（100%） |
| 漂移事件                          | 0            |
| 不可观测帧（我方指令碰到预测格）  | 30           |
| 预热完成帧                        | 第 6 帧左右  |

relay 清图单线矩阵（`SEED 1..16`，32 局/格，配对比较 `baseline-results.jsonl`）。
默认（开启，只开 `_INVALID`）：

| 格子          | 基线            | 默认（INVALID） |       Δ | 65%  |
| ------------- | --------------- | --------------- | ------: | ---- |
| random        | 17/32           | 22/32（68.8%）  | +15.6pp | PASS |
| maze          | 21/32           | 23/32（71.9%）  |  +6.3pp | PASS |
| archipelago   | 16/32           | 17/32（53.1%）  |  +3.1pp | FAIL |
| mediterranean | 19/32           | 19/32（59.4%）  |   0.0pp | FAIL |
| 合计          | 73/128（57.0%） | 81/128（63.3%） |  +6.3pp |      |

逐项增量（同一 16 种子、默认闸门 `K=28`，每行 = 默认 + 该子开关，W/32）：

| 子开关      | archipelago | maze | mediterranean | random   | 合计   |
| ----------- | ----------- | ---- | ------------- | -------- | ------ |
| 默认        | 17          | 23   | 19            | 22       | 81/128 |
| `_APPROACH` | 16          | 24   | 18 (+1T)      | 15 (+1T) | 73/128 |
| `_PUNISH`   | 14          | 25   | 20            | 21       | 80/128 |
| `_RACE`     | **19**      | 20   | 11 (+1T)      | 15 (+2T) | 65/128 |
| `_GUARD`    | 15          | 23   | 19            | 22       | 79/128 |
| `_HOLD`     | 17          | 23   | 18            | 21       | 79/128 |
| `_FREE`     | **18**      | 23   | 18            | 22       | 81/128 |

- 没有一项把 archipelago / mediterranean 推到 21/32。最好的 archipelago 是 `_RACE`
  的 19/32（+3 胜，0 负向翻转）与 `_FREE` 的 18/32，但 `_RACE` 同时把 mediterranean
  打到 11/32（净 -25pp），`_FREE` 是拿 mediterranean 的 1 胜换 archipelago 的 2 胜，
  两者都不是净收益，因此都保持关闭。
- 默认（只开 `_INVALID`）是本轮唯一把总分从 80 提到 81、且没有任何格子变差的选择。

全量矩阵（4 对手 × 4 图 × 4 模式 × 16 种子 × 2 座位 = 2048 局，
`WORKERS=2` 分两批跑，默认配置）：

| 指标        | 基线                 | 本层                 | Δ          |
| ----------- | -------------------- | -------------------- | ---------- |
| 总胜负      | 1621/367/60（79.2%） | 1629/358/61（79.5%） | **+8 胜**  |
| 负数格子    | —                    | **0 / 64**           | —          |
| anti 清图格 | 19/29/22/21          | 同左（逐格 Δ0.0pp）  | 0          |
| apex/v2     | —                    | 全部逐格 Δ0.0pp      | 0          |
| relay 清图  | 16/21/19/17          | 17/23/19/22          | +1/+2/0/+5 |

`flips: winToLoss 9 / lossToWin 17 / lossToTimeout 1 / timeoutToWin 1`。anti 的四格
（archipelago 19/13、maze 29/2/1、mediterranean 22/4/6、random 21/4/7）与基线**逐局
完全一致**，旧版的 -9.4pp / -6.3pp 回归已被严格预热消除。

**为什么 archipelago / mediterranean 打不动。** 预测是 100% 准的，但作用面极小：
8 种子 16 局 archipelago（1164 个已定价帧）里，预测的出发/目标格与我方相邻的只有
383 帧（33%），预测会**打下我方格子**的有 164 帧（14%），而当它发生且轮到我们先手
时，周围一格内还有可救援股、并且加入后能挡住的情况是 **0 帧**（`_HOLD` 打开时
`holdAdd=0`）。原因在结构上：

- 单线每方每 Tick 只有一条指令（`planner.js` `take` 贪心去冲突后只剩一条），引擎
  也只执行一条（`src/game-engine.ts` `gameTick`）。预测不能提高吞吐，只能选择
  「这一条做什么」。
- archipelago 的胜负是吞吐赛：26..50 Tick 每格每 Tick 一兵，落后 4 格就是每 Tick
  少 4 兵，20 Tick 就是 80 兵，最后在主城对撞里体现。要补上这个差额，得让那唯一
  一条指令从「并堆」改成「占地」——但那正是 `_RACE`，而它在其它图上破坏主线队形
  （mediterranean 19→11）。
- relay 的指令大多打在和我方前线不相邻的格子上（67%），此时 `adjust`/`hold` 没有
  可定价的对象，唯一的远程用法就是 `_APPROACH`/`_FREE` 那种多 Tick 行军，而 3 格
  行军在 50 Tick 的局里就是 6% 的行动预算，实测反而亏。

**默认仍然关闭整层**：relay 清图四格里 random 68.8% 与 maze 71.9% 过线，
archipelago 53.1% 与 mediterranean 59.4% 未过，验收线要求四格全过。严格预热之后
整层在 2048 局里**没有负数格子**，所以「能不能开」只剩验收口径问题：
按「四格全过」就不开（现状），按「无回归 + 两格过线」则可以开，风险已量化。

调参记录（同样 16 种子、同样口径）：

| 变体                 | 总分   | 说明                                                      |
| -------------------- | ------ | --------------------------------------------------------- |
| 默认（INVALID）      | 81/128 | 只否决「后手白给」的指令                                  |
| 上一版（无子开关）   | 80/128 | 只重排已有候选、6 帧预热（会误判 anti）                   |
| `_RACE` 全量不设门   | 65/128 | 常年落后即抢地，mediterranean 崩到 11/32                  |
| `_RACE` 仅在 relay   | 68/128 | 加「relay 正在扩张」门后 archipelago 回到 17/32，增益消失 |
| 也扩张时             |        |                                                           |
| 调高 `_RACE` 出价    | 15/32  | 320→400 时 archipelago 反而 15/32（分数挤掉真实防御）     |
| `_FINISH`（kill.js） | 17/32  | 放宽 `EARLY/ETA 6/SURPLUS 1` 也只能到 archipelago 17/32   |

## 复现

```sh
# 预测精度（逐帧对照 relay 实际发出的指令）
BOT3_SHADOW=1 BOT3_SHADOW_TRACE=1 SEED=relay-eval-1 MAP=random MODE=000 SEAT=0 \
  node bot-template/bot-3.0/shadow-probe.cjs

# 逐 Tick 决策对照（预测 / 我方指令 / 双方主城与兵力），排查某一格为什么打不动
BOT3_SHADOW=1 BOT3_SHADOW_TRACE=1 SEED=bot3-baseline-1 MAP=archipelago MODE=000 SEAT=0 \
  FROM=26 node bot-template/bot-3.0/shadow-dump.cjs

# 单个子开关的增量（默认 + 该开关，再与基线配对比较）
BOT3_SHADOW=1 BOT3_SHADOW_RACE=1 WORKERS=2 SEED_FROM=1 SEED_TO=16 OPPONENTS=relay \
  MODES=000 OUT=/tmp/race.jsonl SUMMARY=/tmp/race.json \
  node scripts/evaluate-bot3-baseline.cjs
NO_GATE=1 node scripts/compare-bot3-baseline.cjs /tmp/race.jsonl

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
- 所有改动（含 `_INVALID` 的否决与候选创造）都在严格预热之后：连续 28 帧精确命中，
  所以开局 28 Tick 只有重排序；这是对「开局与 relay 同源」的 bot 的必要保护。
- 多 Tick 计划只有 `_APPROACH` 的一步台阶 + `st.plan` 记忆，没有真正的路线规划；
  archipelago 的 3..4 步行军在 50 Tick 的局里太贵，实测不划算。
- 依赖 `../relay-bot/planner`（只读）。路径缺失（例如只发布 `bot-3.0` 包）时自动
  降级为 no-op。
- 多线与迷雾格子没有收益，也没有副作用（直接拒绝）。
