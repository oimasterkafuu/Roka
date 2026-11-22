# 迷雾单线层实验记录（Bot(3.0) 小图 1v1）

本文件记录 Bot(3.0) 针对迷雾小图单线格（`MODES=010`）的策略层：动机、实现、开关与配对评测结果。基线见 [BASELINE.md](BASELINE.md)，迷宫层见 [BOT3_MAZE.md](BOT3_MAZE.md)。

## 问题定位

迷雾的视野是切比雪夫半径 1，`planner.js` 却按“看得见的目标”给每一帧定价，于是回放里能看到三处结构性失效：

1. **没有目标**。`targets` 来自记忆中的敌方皇冠，而敌方皇冠只有在我们的地皮贴到它邻格后才会被记住。`relay/random/seed 12` 1000 Tick 内一个敌方皇冠都没记住，`goal` 始终是无穷大，所有推进规则失效，规划器退化成侦察场。
2. **柱状主力不转化为进攻**。没有目标时行军项（`60 + sqrt(mass)`，踩自己格子还有最多 55 的收兵奖励）压过一切普通占领（`32..65`），1900 兵的主力整局在自己格子之间倒兵：同一局 255 个 Tick 里 194 个 Tick 用于自己合兵，41 个用于占中立，16 个用于进攻。
3. **未知格免费**。`assaultStrength` 只给可见守军定价，迷雾格上报 `grid_type 200 / army_cnt 0`，一条通向黑暗的路看起来免费。

迷雾档位还永久关闭了 `single` 分支（`single = clearSerial && ...`），所以迷宫层与收尾柱在这类格子里根本不会介入，等同于“通用路径 + 盲目”。

## 实现

新增 [fog.js](fog.js)，`planner.js` 加四处钩子：

| 位置 | 内容 |
| ---- | ---- |
| `chooseOrders` 房间门控 | `fogOpen = !clearSerial && !multi && size <= maxBoard && turn >= startTurn` |
| 目标场 | `fogAim` 时把 `objectives` 回退到可见敌人；要求无记忆皇冠、非迷宫、且 `army * 100 >= enemyArmy * aimLead` |
| 材料门控 | `fogUpdate()` 在 `army >= enemyArmy * floor`、无敌方威胁时把层置为 active（可暂停，不锁存） |
| 指令落地循环 | 柱推进 `columnAdvance`、后方汇兵 `funnelScore`、原地筑垒 `INVEST_SCORE`、前线扩张 `expandScore`、退守 `guardScore` |

- `fogRequired()`：迷雾格无法定价，于是“到目标剩余步数 × `guess`”作为保底预备队，步数封顶 8。柱只有付得起 `required + reserve` 才推进。
- `fogAim` 的解锁条件来自实测：`aimLead` 太松会在 Anti-Human/群岛格亏 3~4 局（把兵力追着敌方前线倒），太紧（100% 之外还要更高）则 Relay/群岛格退回 50%。默认 `aimLead=100`（即“我方军力不少于对手”）是零退化与收益之间的折中。
- 迷宫图不做前线瞄准：走廊里“追可见前线”正是 [maze.js](maze.js) 里推迟前线规划器要避免的形状，瞄准打开后 Apex/Bot(2.0) 的迷宫迷雾格各亏 1~2 局。
- 其余开关（`funnel`、`expand`、`guard`、`invest`）默认关闭：四者实测都是负收益，见下方“被否决的变体”。

## 开关

| 变量 | 默认 | 含义 |
| ---- | ---- | ---- |
| `BOT3_FOG` | **关** | `1` 打开整个迷雾单线层；默认关闭，默认路径与 round-2 基线逐局一致 |
| `BOT3_FOG_TURN` | `60` | 层最早启用的 Tick |
| `BOT3_FOG_GUESS` | `8` | 每剩余步的保底预备队 |
| `BOT3_FOG_FLOOR` | `0` | 柱启用所需的军力倍数下限（`army >= enemyArmy * floor`） |
| `BOT3_FOG_BOARD` | `800` | 层启用的最大格数 |
| `BOT3_FOG_COLUMN` | 开 | 柱状推进 |
| `BOT3_FOG_AIM` | 开 | 无记忆皇冠时把目标场回退到可见前线 |
| `BOT3_FOG_AIM_LEAD` | `100` | 前线瞄准所需的军力百分比（`army*100 >= enemyArmy*aimLead`） |
| `BOT3_FOG_INVEST` | 关 | 允许在前线附近筑垒（`INVEST_SCORE=700`） |
| `BOT3_FOG_FUNNEL` | 关 | 后方汇兵进柱（实测全负，见下） |
| `BOT3_FOG_EXPAND` | 关 | 柱优先吃中立格扩张 |
| `BOT3_FOG_GUARD` | 关 | 柱无目标时原地驻守 |

默认关闭的理由：Relay 迷雾单线四格仍是 50%~56%，达不到 65% 门禁；按实验约定“拿不到 65% 就不保留退化”，所以把层保留为可选，默认路径保持与 round-2 基线逐局相同（2048 局 `flips` 全 0）。

## 评测结果（16 种子，与 round-2 基线逐局配对）

命令：

```sh
BOT3_FOG=1 SEED_FROM=1 SEED_TO=16 WORKERS=4 OUT=data/scratch/fog-on-full.jsonl \
  SUMMARY=data/scratch/fog-on-full.json node scripts/evaluate-bot3-baseline.cjs
node scripts/compare-bot3-baseline.cjs data/scratch/fog-on-full.jsonl data/scratch/round2-baseline.jsonl
```

### 迷雾单线 16 格（每格 32 局）

| 对手 | 地图 | 候选 W/L/T | 基线 W/L/T | Δwin | 目标 | 门禁 |
| ---- | ---- | ---------- | ---------- | ---: | ---: | ---- |
| Anti-Human | 地中海 | 22/7/3 | 13/11/8 | +28.1pp | 50% | PASS |
| Anti-Human | 迷宫 | 29/3/0 | 26/2/4 | +9.4pp | 50% | PASS |
| Anti-Human | 随机 | 19/10/3 | 17/11/4 | +6.3pp | 50% | PASS |
| Anti-Human | 群岛 | 21/11/0 | 21/10/1 | 0.0pp | 50% | PASS |
| Apex | 地中海 | 30/1/1 | 23/4/5 | +21.9pp | 50% | PASS |
| Apex | 随机 | 22/4/6 | 16/6/10 | +18.8pp | 50% | PASS |
| Apex | 迷宫 | 24/2/6 | 24/0/8 | 0.0pp | 50% | PASS |
| Apex | 群岛 | 23/5/4 | 24/5/3 | -3.1pp | 50% | 退化 1 局 |
| Bot(2.0) | 地中海 | 30/1/1 | 23/4/5 | +21.9pp | 50% | PASS |
| Bot(2.0) | 随机 | 21/3/8 | 16/8/8 | +15.6pp | 50% | PASS |
| Bot(2.0) | 群岛 | 24/3/5 | 24/4/4 | 0.0pp | 50% | PASS |
| Bot(2.0) | 迷宫 | 24/2/6 | 25/0/7 | -3.1pp | 50% | 退化 1 局 |
| Relay | 随机 | 18/14/0 | 15/15/2 | +9.4pp | 65% | 未达 65% |
| Relay | 地中海 | 17/14/1 | 15/15/2 | +6.3pp | 65% | 未达 65% |
| Relay | 迷宫 | 16/15/1 | 15/15/2 | +3.1pp | 65% | 未达 65% |
| Relay | 群岛 | 16/16/0 | 16/16/0 | 0.0pp | 65% | 未达 65% |

迷雾单线合计 313 → **356 胜**（61.1% → 69.5%，+8.4pp）；其中 Relay 61 → 67 胜（47.7% → 52.3%），Anti 77 → 91 胜（60.2% → 71.1%）。

### 完整 2048 局矩阵

| 规模 | 候选 W/L/T | 基线 W/L/T | Δwin | 退化格 |
| ---- | ---------- | ---------- | ---: | ------ |
| 2048 局全矩阵 | 1584/380/84（77.3%） | 1541/395/112（75.2%） | +2.1pp | Apex/群岛 -1、Bot(2.0)/迷宫 -1 |

`flips`：`lossToWin` 32、`timeoutToWin` 35、`winToLoss` 13、`winToTimeout` 11、`timeoutToLoss` 16、`lossToTimeout` 12。超时 112 → 84。

**非迷雾单线 48 格逐格 Δ 全部为 0.0pp**（层以外代码路径未变）；`BOT3_FOG` 关闭时 2048 局与 round-2 基线逐局完全一致（`flips` 全 0）。

### 被否决的变体（16 种子，配对）

| 变体 | 结果 | 结论 |
| ---- | ---- | ---- |
| 只开柱、不开前线瞄准 | Relay 四格 50%/50%/50%/53% | 柱独自不解决问题 |
| 前线瞄准 + `TURN=120` | Relay 四格 50%/50%/50%/53% | 太晚，开局经济已定 |
| 前线瞄准 + `TURN=30/40/50` | Relay 群岛 72%，但 Anti/群岛 -4 局 | 无军力门控时把兵力倒进敌方前线 |
| 前线瞄准 + `AIM_LEAD=0/40/60` | Relay +11 胜、Anti -13 胜 | 与上一行同因 |
| `GUESS=4` / `GUESS=12` / `GUESS=16` | Relay 56%（每格波动 ±12.5pp） | 预备队大小只改噪声，不改均值 |
| `GUESS=4` | Relay 随机 75%、迷宫 38% | 单格大涨大跌，属噪声 |
| `INVEST=1` | Relay +56%、Anti/地中海 -1 | 前线筑垒分流了柱 |
| `EXPAND=1` | Relay 56%（Anti 与 Relay 的群岛格互换） | 净零，但把 Anti 群岛打回基线 |
| `GUARD=1` | Relay 51% | 驻守让出主动权 |
| `FUNNEL=1` | 0 胜（64 局全负） | 实现有缺陷，汇兵把柱抽空，已默认关闭 |

`WORKERS<=4`、前台运行，单次 128 局筛查约 60 秒，2048 局约 6 分钟。

## 第三轮组合筛查：防线预备队不能整层放大

组合开启（`BOT3_MULTI=1 BOT3_FOG=1`）后，两个 -1 局退化格都是“原本快胜被柱拖成超时/失败”：

| 格 | round-2 | 组合 | 差异局 |
| --- | --- | --- | --- |
| `apex/archipelago/fog` | 24/5/3 | 23/5/4 | seed 2 seat 1 胜(234) → 超时；seed 10 seat 1 胜(279) → 负(891) |
| `v2/maze/fog` | 25/0/7 | 24/2/6 | seed 1/9/11 seat 1 胜(131/320/710) → 超时；seed 5/6 seat 0 超时 → 负 |

`BOT3_FOG_COLUMN=0` 把两格都还原到 round-2，但会把地中海/随机格的增益一起丢掉，所以不能整层关。
按“未知路线的预备队”整层放大 `GUESS` 是唯一有效的单旋钮，但收益和代价一样大：

| `BOT3_FOG_GUESS` | 迷雾单线（1024 局）Δ胜 vs round-2 | 仍低于 round-2 的格 |
| --- | ---: | --- |
| 8（默认） | +81 | `apex/archipelago` 23 vs 24、`v2/maze` 24 vs 25 |
| 16 | 修好 `v2/maze` 的 3 局胜局 | `apex/archipelago` 的 seed 2 反而变负(759) |
| 20 | +35 | `apex/archipelago` 23 vs 24、`relay/mediterranean` 14 vs 15、`relay/random` 13 vs 15 |
| 22 | +27 | `anti/archipelago` 19 vs 21、`apex/archipelago` 23 vs 24、`relay/random` 13 vs 15 |
| 24 | +10 | `anti/random` 15 vs 17、`relay/archipelago` 15 vs 16、`relay/random` 13 vs 15 |

结论：柱是否该接管是**局面问题**，不是预备队大小的问题。同一个 `GUESS` 在 anti/apex/v2/relay 的迷雾格上方向相反，
整层放大只是把一处单局翻转换成另一处。因此默认仍为 `GUESS=8`，本轮不为“组合零退化”改动迷雾层；
要真正收敛需要按局面特征（谁在收紧、皇冠是否已知、时间压力）回退柱，而不是权重微调。

## 未解决

- **Relay 迷雾单线四格仍只有 50%~56%，达不到 65%**。这四格是“同一张图的座位互换”，round-2 基线里胜者由座位/地图细微差异决定（15/15/2、16/16/0 的对称结果），要赢下两局就必须真正强于 Relay 的迷雾打法，而不是评分微调。所有开关组合下 Relay 四格合计都落在 52%~56%，单格 ±12.5pp 的波动是噪声而非收益。
- 两处 -1 局退化（Apex/群岛、Bot(2.0)/迷宫迷雾单线）是“胜局变超时/失败”的单局翻转，属于混沌末局；要进一步收敛需要按局面特征回退（例如只在明确的时间压力下启用），本轮未做。
- Relay 迷雾单线的下一步方向：需要“侦察—记忆—突袭皇冠”的量级改动（迷雾下主动搜索敌方皇冠位置并记住），而不是更细的柱评分；当前层只是把盲目倒兵变成朝可见前线倒兵。
