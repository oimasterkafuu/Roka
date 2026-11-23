# 迷雾情报层（fog-oracle）实验记录

本文件记录 Bot(3.0) 的「迷雾情报」层：动机、实现、开关与配对评测结果。基线见 [BASELINE.md](BASELINE.md)，迷雾单线的既有层见 [BOT3_FOG.md](BOT3_FOG.md)。

## 问题定位

迷雾视野是切比雪夫半径 1（`src/game-engine/fog-vision.ts`）：视野外只保留山脉（201）与沼泽（204），其余格一律抹成空地 200、归属与兵力归零。于是规划器看到的棋盘永远显示「那边什么都没有」。

但**排行榜没有迷雾**：`src/game-engine/leaderboard.ts` 每 Tick 从真实网格重建，`rival.army` / `rival.land` 在迷雾下依然精确。两者之差就是被迷雾藏起来的那部分：

```text
visibleArmy = 我方视野内所有对手格兵力之和
visibleLand = 我方视野内对手格数
hiddenArmy  = rival.army - visibleArmy      # 内部预备队
hiddenLand  = rival.land - visibleLand
density     = hiddenArmy / max(1, hiddenLand)
```

逐 Tick 回放（`relay/random|mediterranean|archipelago/mist/single`，种子 1）实测 `hiddenArmy` 在 130~550、`hiddenLand` 18~59、`density` 2.6~16.6：对手在看不见的地方一直握着几百兵，而 `./fog` 的柱状推进只按「每步固定 `BOT3_FOG_GUESS=8` 未知驻军」定价。

## 王冠计数

王冠每 Tick +1，其它地块只在 50 Tick 成长 Tick（单线 burst 期 26~50 额外 +1）产出（`src/game-engine/tick-growth.ts`）。因此在非成长 Tick 上，对手兵力增量恰好是「王冠数 - 战损」。层只在这些 Tick 记账：

- 安静窗口（对手占地不变 **且** 我方兵力不变，说明没有发生战斗）：`Δarmy` 直接读作王冠数；
- 占地不变而兵力掉约 50：建造事件，王冠 +1（掉 100 记 2 座）；
- 成长 Tick、或任何一方占地/兵力发生战斗变化：本 Tick 不记账。

每次开局双方各 1 座王冠，所以账本从 1 开始。合成序列验证（2 座王冠 → Tick 15 建造 → 3 座）：Tick 14 估值 1、Tick 16 估值 2，建造被准确识别。

## 实现

新增 [fog-oracle.js](fog-oracle.js)，`planner.js` 只在迷雾单线房间加一处取数（`fogOracleUpdate`）与三处很小的用法：

| 位置                         | 内容                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `chooseOrders`（敌人汇总旁） | 找到排行榜里兵力最高的对手行，`oracle = fogOracleUpdate(...)`                                           |
| `fogReserve`                 | 每步未知驻军从固定 `guess` 改为 `max(guess, min(reserveCap, density))`                                  |
| `fogColumn` 推进             | 潜入迷雾格而兵力付不起 `density` 时封顶（`blockScore`）；对手内部空（`density <= low`）时加 `pushScore` |
| 候选落地前                   | 有剩余中立格时，落在自己格上的普通合并封顶（`paintScore`），让中立格涂色（150+）赢下 Tick               |
| 目标推进                     | 王冠估值降到 1 座且记忆里有对手主城时，给目标推进 `allInScore`（高于柱状推进 1000+）                    |

所有信号默认关闭（`BOT3_FOGORACLE` 未设时整层不分配状态、不改变任何评分，默认路径与基线逐局一致）。

## 开关

| 变量                                                                     | 默认                           | 含义                                       |
| ------------------------------------------------------------------------ | ------------------------------ | ------------------------------------------ |
| `BOT3_FOGORACLE`                                                         | 关                             | 总开关，开启后整套（下方四项）生效         |
| `BOT3_FOGORACLE_RESERVE`                                                 | 随总开关                       | 密度预备队（每步未知驻军）                 |
| `BOT3_FOGORACLE_DIVE`                                                    | 随总开关                       | 付不起内部预备队时拒绝潜入（结构上不可达，见第八轮复核） |
| `BOT3_FOGORACLE_PUSH`                                                    | 随总开关                       | 对手内部空时给柱状推进加成                 |
| `BOT3_FOGORACLE_PAINT`                                                   | 随总开关                       | 有剩余中立格时封顶自身格合并               |
| `BOT3_FOGORACLE_ALLIN`                                                   | 关                             | 最后一座王冠时全押（需账本确认，实测为负） |
| `BOT3_FOGORACLE_RESERVE_CAP`                                             | `24`                           | 每步预备队上限                             |
| `BOT3_FOGORACLE_DIVE`                                                    | `100`                          | 潜入判定：`send*100 < density*DIVE` 时拒绝 |
| `BOT3_FOGORACLE_LOW`                                                     | `1`                            | 「内部空」阈值：`density <= LOW`           |
| `BOT3_FOGORACLE_BLOCK` / `_PUSH_SCORE` / `_PAINT_SCORE` / `_ALLIN_SCORE` | `240` / `160` / `140` / `1250` | 对应评分                                   |
| `BOT3_FOGORACLE_BOARD`                                                   | `800`                          | 只在小图生效                               |

## 评测结果（16 种子，Relay，配对基线）

命令：

```sh
cd <worktree>
BOT3_FOGORACLE=1 WORKERS=2 SEED_FROM=1 SEED_TO=16 OPPONENTS=relay   OUT=/tmp/orc16.jsonl SUMMARY=/tmp/orc16.json node bot-template/relay-bot/training/evaluate-matrix.cjs
NO_GATE=1 node bot-template/relay-bot/training/compare.cjs /tmp/orc16.jsonl
```

迷雾单线四格（每格 32 局，Relay）：

| 变体                               | random         | archipelago | mediterranean | maze  | 全矩阵 W（基线 269） |
| ---------------------------------- | -------------- | ----------- | ------------- | ----- | -------------------: |
| 基线                               | 16/32          | 19/32       | 22/32         | 16/32 |                  269 |
| 整套（reserve+paint+dive+push）    | 17/32          | 18/32       | 20/32         | 16/32 |            267（-2） |
| 仅 reserve（cap 24）               | 18/32          | 18/32       | 18/32         | 16/32 |            266（-3） |
| 仅 reserve（cap 12）               | 19/32          | 18/32       | 18/32         | 16/32 |            267（-2） |
| 仅 paint                           | 17/32          | 19/32       | 22/32         | 16/32 |            270（+1） |
| 仅 dive/push（4 种子随机图 32 局） | 与基线逐局一致 | —           | —             | —     |               0 翻转 |
| 仅 allIn（未确认账本，与整套同跑） | 7/32           | 8/32        | 9/32          | 16/32 |           236（-33） |

- `reserve` 是随机图唯一稳定正向的信号（16 → 18~19/32，+2~3 胜），但地中海同时 22 → 18/32（-4），整套净 -2 胜。
- `paint` 在 16 种子 relay 上**逐格不退化**（随机 16 → 17/32，+1 胜；地中海/群岛 0.0pp），但全矩阵 2048 局复核是 1620W vs 1621W（-1）：`anti/archipelago/fog+single` 22 → 20/32（-2）、`relay/random/fog+single` 16 → 17/32（+1）。因此仍是净零带一格退化，默认关闭。
- `dive` 在 4 种子随机图筛查下逐局与基线完全一致：`send` 常在 50~150，而 `density` 只有 3~16，`send*100 < density*100` 几乎不成立。`push` 需要 `hiddenLand > 0 && density <= 1`，实测迷雾里对手内部从不空（16 个种子最小 `density` 2.6）。
- `allIn` 必须关闭：账本按出生规则从 1 开始，未确认时 `lastCrown` 从开局就为真，1250 分的目标推进直接把随机图压到 7/32（-28.1pp）、地中海 9/32（-40.6pp）、群岛 8/32（-34.4pp），全矩阵 236W（-6.4pp）。现在它需要 `BOT3_FOGORACLE_ALLIN=1` **且** 至少两个安静窗口确认过账本（`quiet >= 2`）才生效，默认关闭。

结论：整层**默认关闭**。它把「看不见的预备队」变成了可读数字（`density`、`openLand`、王冠账本），但只有 `paint` 这一条在 relay 迷雾单线上是零退化的小幅正向（+1 胜 / 32 局），在地图上换来了群岛镜像的 1~2 局损失。负结果与开关全部保留在代码里，方便后续用更细的判据重测。

## 第八轮复核：逐格潜入判据在结构上不可达

本轮重新检查 `dive` 与「按隐藏兵力拒潜」这一类**逐格**判据，结论是它们不可能触发，原因不在阈值：

迷雾视野是切比雪夫半径 1（`src/game-engine/fog-vision.ts`），**任何一次合法移动的目标格都是我方土地的（八邻域）相邻格**，因此目标格必然可见，`board.fog[to]` 恒为 0。也就是说迷雾里不存在「潜入未知格」这一步：看不见的是第二环及更远，而不是下一步。

实测确认（16 种子 × 4 图 × 2 座位，`BOT3_FOGORACLE=1` 只开 `dive` 或只开新增的「隐藏兵力压过机动兵力就拒潜」判据，`BOT3_FOGORACLE_BLOCK=120/240`）：**flips 全 0**，逐局与基线一致。新的 `fogOracleHold` 变体（按 `hiddenArmy` 与机动兵力比较）因此从未触发，代码已删除，只保留本记录。

仍然有效的用法只有**按剩余步数定价**：

- `reserve`（`fogRequired` 的每步未知驻军改为 `density`，cap 24/12）：随机图 16 → 18/19 胜，但地中海 22 → 18，整套 -2；
- `paint`（有中立格时封顶自格合并）：relay 迷雾单线随机 16 → 17，全矩阵 -1。

这两条的「随机图正、地中海负」与第五轮 `BOT3_FOG_PAINT3` 的沼泽/Tick 停机是同一个形态：**开放随机图需要把合并 Tick 换成土地，沼泽型地图不需要**。现在随机图的正收益由 `BOT3_FOG_PAINT3`（120/25/200）承接：relay/random/fog+single 16 → 21/32（65.6%），全矩阵零退化（数据见 [BOT3_FOG.md](BOT3_FOG.md)）。oracle 层本身仍默认关闭。

## 已知限制补充

- 逐格判据（`dive`、`BLOCK`）在迷雾里不可达（见上），只剩「每步预备队」与「按剩余步数的密度定价」两种可达用法。

## 已知限制

- 战斗频繁的对局里安静窗口稀少，王冠账本更新很慢；burst 窗口（26~50 Tick）与 50 Tick 成长 Tick 全部跳过，期间的建造不可见。
- `density` 是「内部平均每格驻军」，无法区分「一堆空格 + 一座大城」与「均匀分布」；`hiddenLand` 含不可达口袋。
- 剩余中立格由 `可通行格 - 我方占地 - 对手占地` 推出，山脉可见所以可通行格可算，但孤立水塘等不可达区域会被算成「可涂的中立格」。
