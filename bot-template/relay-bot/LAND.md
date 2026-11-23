# Land-first layer (`land.js`) — round 12

目标：修掉 Bot(3.0) 在**沼泽占比高的明牌单线**两格上的落后——
`relay/mediterranean/clear/single` 19/32（59.4%）与
`relay/archipelago/clear/single` 16/32（50.0%）。这两格是整合分支上唯一只吃到
`SHADOW`（relay 影子层）的格子，`PAINT3`/`MAZEFOG3` 都只作用于迷雾。

结论先说：本层找到并默认开启了一个**零退化**的机制（沼泽重图上关闭收尾漏斗），
16 种子满量 2048 局 **1648/342/58（80.5%）对基线 1621/367/60（79.2%），+27 胜、
64 格无一格低于基线、非 relay 格全部 >= 50%**。但两格**没有达到 65%**：
`relay/mediterranean/clear/single` 19/32（0.0pp）、
`relay/archipelago/clear/single` 17/32（+3.1pp）。其余两个机制（burst 加成、
岛国王冠）与两个激进旋钮（夺取加分、明牌版「先涂地」封顶）实测为负，保留为默认关闭的
可开关代码。

## 1. 诊断（用 baseline-results.jsonl 复算）

checkpoint 是 `[land, army]`，且 `names` 按 seat 轮转（seat 1 的两个数组要互换），
所以统计时必须按 seat 重排，否则会把两边状态混在一起。

`relay/mediterranean/clear/single`（32 局，19-13）：

| tick | 胜局 我/relay (land, army) | 负局 我/relay (land, army) |
| --- | --- | --- |
| 50 | 45/846 vs 45/859 | 44/830 vs 44/811 |
| 100 | 53/562 vs 56/599 | 56/587 vs 52/531 |
| 250 | 74/729 vs 55/480 | 52/366 vs 62/634 |

- **t100 兵力领先反而是负信号**：`army 差 > 0` 时 6/16 胜（37.5%），`<= 0` 时
  13/16 胜（81.3%）。即「把回合花在集结兵力」在这一格是输法。
- 负局到 t250 时我们的地 52 对 relay 62，兵 366 对 634；胜局是地 74 对 55、
  兵 729 对 480。分水岭在中期：谁把地转成王冠收入并留住，谁赢。
- 单局探针（`land-probe.cjs`，seed 3 seat 0，负）：t110 我们地 68 领先
  relay 56，随后 relay 王冠数 5→8 而我们从 4 起落，t220 我们地崩到 26，
  这段我们每 10 tick 有 7-8 次合兵，relay 同时在抢地/进攻。

`relay/archipelago/clear/single`（32 局，16-16）：

- 16 个种子里 **16 对的 checkpoint 完全逐位相同**（按 seat 互换后），
  32 局里 30 局在 tick 150 之前结束（最早 t47）。也就是说这一格基本由
  **出生岛/座位几何**决定：probe 里 seed 1 seat 0 我们的岛 t34 就铺满 29 格
  后无中立邻格（被山封死），relay 的岛一路长到 38 并 t47 吃掉我们。
  这不是经济差距，任何「多抢地」的调参都无法跨海。
- 因此这一格的可改进空间只来自「不被地理直接判死」的那部分种子，
  +1 胜（16→17）已经是本层能测到的量级。

## 2. 机制

`landConfig()` 每个 tick 读取，全部字段在未开启时惰性：

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| `BOT3_LANDFIRST` | **开** | 本层总开关；关闭后回到 round-11 行为（构造上逐局一致） |
| `BOT3_LANDFIRST=0` | – | 关闭本层 |
| `BOT3_LAND_CLOSE_SKIP` | 1 | 沼泽重图 + 明牌单线 + 我方地落后时，收尾层（`closing.js` 的漏斗）停用 |
| `BOT3_LAND_CLOSE_UNTIL` | 0 | 停用到该 tick 为止（0 = 整局停用） |
| `BOT3_LAND_CAPTURE` | 0 | 落后时中立格夺取加分（实测 130 为负，默认关） |
| `BOT3_LAND_PAINT` | 0 | 明牌版「先涂地」封顶：自己格合兵分数上限（实测 155 为负，默认关） |
| `BOT3_LANDBURST=1` | 关 | 26..49 burst 窗口内中立格夺取加分（`BOT3_LAND_BURST`，默认 220） |
| `BOT3_ISLANDCROWN=1` | 关 | 王冠上限（`_HOMES`=6）与最小间距（`_SPREAD`=3） |
| `BOT3_LAND_SWAMP_SHARE` | 0.35 | 「结构上沼泽重」的判定阈值 |

「沼泽重」用**地形结构**判定：沼泽在迷雾里也保留编码（中立 204、归属
151..199），所以 `swamp 格数 / size >= 0.35` 即可，不写死地图名。实测
mediterranean 45.7%、archipelago 66.7%（海=沼泽）、random/maze ~7-8%，
阈值 0.35 只命中前两者。

停用收尾层的理由：收尾层是**集结**规则（把全帝国灌进最重的堆并压上），
在沼泽重的地图上它跨越的是不产收入的地形，粮道越长、失败越贵；而
`single-front.js` 的漏斗分会盖过一切（940+/1000+），于是中期该抢地/建冠的
回合全被漏斗吃掉。这与 `fog.js` 里 `paint` 的注释一致（沼泽重图上封顶是负的）。

## 3. 实测（全部对 baseline-results.jsonl 的配对基线）

16 种子 × relay,anti × mediterranean,archipelago × 明牌单线 = 128 局：

| 配置 | 总计 | anti/arch | anti/med | relay/arch | relay/med |
| --- | --- | --- | --- | --- | --- |
| 基线（配对） | 76/128 | 19 | 22 | 16 | 19 |
| `LANDFIRST`（仅停用收尾） | **81/128 (+3.9pp)** | 19 | **26 (+4)** | **17 (+1)** | 19 |
| `LANDFIRST` + 夺取加分 130 | 77/128 | 18 | 25 | 16 | 18 |
| `LANDFIRST` + 封顶 155 + 加分 130 | 68/128 | 21 | 15 | 18 | 14 |
| 只加分 + 封顶（`CAPTURE=130 PAINT=155`） | 68/128 | 21 | 15 | 18 | 14 |
| `LANDBURST`（单独） | 78/128 (+1.6pp) | 21 | 25 | 16 | 16 |
| `LANDFIRST` + `LANDBURST` | 78/128 | 21 | 24 | 16 | 17 |
| `ISLANDCROWN`（homes 6 / spread 3） | 71/128 (-3.9pp) | 18 | 20 | 17 | 16 |
| `LANDFIRST` + `CLOSE_UNTIL=200` | 77/128 | 19 | 22 | 17 | 19 |

封顶那一行最刺眼：`flips` 里 **13 局 win→timeout**（mediterranean 超时 6→16/32）。
明牌版封顶把合兵回合换成抢地，但单线一回合只有一条指令、又没有迷雾柱状推进的
「必须前进」压力，结果是我们既没集结也没终结——这正是 `fog.js`
`DEFAULT_PAINT_SWAMP` 注释里记过的同一个坑。

满量矩阵（16 种子 × 4 对手 × 4 地图 × 4 模式 = 2048 局，`LANDFIRST` 开）：

- **1648/342/58（80.5%）对 1621/367/60（79.2%），+1.3pp**；
  flips：win→loss 21、loss→win 47、win→timeout 9、timeout→win 10。
- 64 格里**没有任何一格 delta 为负**；非 relay 格全部 >= 50%。
- relay 单线：archipelago 17/32（53.1%，+3.1pp）、mediterranean 19/32（59.4%，0.0pp）、
  random 22/32（68.8%，+5）、maze 23/32（71.9%，+2）。
- relay 两格仍未到 65%：这是本轮**没有达成**的目标（见上面的诊断）。

## 4. 复现

```sh
# 128 局沼泽屏幕（本层默认开启，即 BOT3_LANDFIRST=1）
cd C:/Users/reson/Downloads/fork/Roka-bot3-r12-land
WORKERS=2 SEED_FROM=1 SEED_TO=16 OPPONENTS=relay,anti \
  MAPS=mediterranean,archipelago MODES=000 OUT=/tmp/ld.jsonl \
  node bot-template/relay-bot/training/evaluate-matrix.cjs
NO_GATE=1 node bot-template/relay-bot/training/compare.cjs /tmp/ld.jsonl

# 满量矩阵（16 种子，约 9 分钟/1024 局，分两段跑）
WORKERS=2 SEED_FROM=1 SEED_TO=8 OUT=/tmp/ld-full-a.jsonl node bot-template/relay-bot/training/evaluate-matrix.cjs
WORKERS=2 SEED_FROM=9 SEED_TO=16 OUT=/tmp/ld-full-b.jsonl node bot-template/relay-bot/training/evaluate-matrix.cjs
cat /tmp/ld-full-a.jsonl /tmp/ld-full-b.jsonl > /tmp/ld-full.jsonl
NO_GATE=1 node bot-template/relay-bot/training/compare.cjs /tmp/ld-full.jsonl

# 单局逐 tick 探针（land/army/王冠数 + 双方指令构成）
SEED=bot3-baseline-3 MAP=mediterranean SEAT=0 node bot-template/relay-bot/land-probe.cjs
SEED=bot3-baseline-1 MAP=archipelago SEAT=0 TRACE_FROM=26 TRACE_TO=47 TRACE_ORDERS=1 \
  node bot-template/relay-bot/land-probe.cjs
```

## 第 13 轮：地中海的败因不是漏斗，是 t150 的王冠竞速

目标仍是 `relay/mediterranean/clear/single` 19/32 -> 21/32。本轮先证伪了最自然的假设
（收尾漏斗吃掉中期），最后用两个**已在库里、但默认关闭**的机制（影子层 `_PUNISH`、斩杀层
`FINISH`）加门控后达成 21/32（65.6%），全量 2048 局 **1673/309/66（81.7%）对
1621/367/60（79.2%）**，64 格零退化。

### 1. 败因（32 局逐 tick 探针，按 seat 重排 checkpoint）

负局的形：t100 我方土地 57 对 54、兵力 594 对 558，但**王冠 5 对 6**；到 t150 变成
地 53 对 61、兵 415 对 534、王冠 6 对 8，t250 兵 427 对 702。胜局相反：t100 王冠 6 对 5，
t150 王冠 7 对 6 且兵力领先。

| t150 王冠差 | 局数 | 胜 |
| --- | --- | --- |
| >= +1 | 14 | 12 |
| 0 | 3 | 3 |
| <= -2 | 12 | 1 |

分水岭不是土地也不是兵力，而是**王冠数**：王冠是唯一每 Tick 产出的地块，被攻占时会连同
周边地一起改写。这也解释了「t100 兵力领先反而输」：我们把同一批兵花在集结/抢地上，relay
换成了王冠。16 个种子里 13 个是「一胜一负」，所以这一格本质是两座位各差一点。

### 2. 试过且无效/为负的旋钮（不要重复）

16 种子、`relay,anti × mediterranean × 明码单线`（每格 32 局），基线 relay 19 / anti 26：

| 配置 | relay/med | anti/med | 结论 |
| --- | --- | --- | --- |
| 基线（LANDFIRST 默认） | 19 | 26 | — |
| `BOT3_LAND_CLOSE_ALWAYS=1`（沼泽单线一律停漏斗） | 19 | 26 | 中性（+1 胜 -1 胜互抵，另有 1 局变超时） |
| 默认漏斗 + `BOT3_CLOSING_PUSH=250` | 19 | 25 | 中性 |
| `BOT3_CLOSING_TURN=90` | 18 | 26 | -1 |
| `BOT3_CLOSING_FLOOR=1.7` | 17 | 25 | -2 |
| `CLOSE_SKIP=0 CROWNS=4 FLOOR=1.0`（激进漏斗） | 14 | 19 | -5 / -7 |
| `CLOSE_SKIP=0 CROWNS=4 FLOOR=1.2 PUSH=150` | 9 | 21 | -10 |
| `BOT3_LAND_SITE=520/650`、`BOT3_LAND_DEVELOP=1` | 19 | 23-25 | 建筑分不是瓶颈（relay 局逐局 0 翻转） |
| `BOT3_CUTTIME=1 BOT3_CUTTIME_APPROACH=150` | 15 | 24 | -4 |
| `BOT3_SHADOW_RACE=1` / `_APPROACH` / `_HOLD` / `_FREE` | 13 / 17 / 18 / 18 | 26 | 负 |
| `BOT3_FINISH=1`（无门控） | 20 | 27 | +1，但 `anti/random` 21 -> 19 |
| `BOT3_SHADOW_PUNISH=1`（无门控） | 20 | 26 | +1，但 `relay/random` 22 -> 21 |

`CLOSE_SKIP` 的闸门在本分支是沼泽占比 >= 0.35（不是 0.55），地中海 0.457 一直在闸内；
探针复算的漏斗谓词（t>=60、敌冠>=6、兵>=1.35x）在 13 个负局里有 9 局**一次都没成立**
（中期就已经崩了），所以漏斗不是主因。

### 3. 交付的机制：两个门控

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| `BOT3_SHADOW_PUNISH` | **开**（本轮改） | relay 攻下目标后反抢它腾空的出发格；新增结构闸门 `BOT3_SHADOW_PUNISH_SWAMP`（默认 0.35，与 `land.js` 同一阈值），只在沼泽重图生效，`random`/`maze` 逐局不变 |
| `BOT3_SHADOW_PUNISH_BID` / `_KEEP` | 250 / 2 | 反抢出价与「出发格允许剩多少兵」；`_BID` 150/200/225/250/275/350 在 med 上是 20/20/20/21/22/22、random 上是 23/21/21/21/20/20，`_KEEP` 1/2/3 同分，故保持 250/2 |
| `BOT3_FINISH` | **开**（本轮改） | 斩杀层只在影子层 `armed`（连续 28 帧逐字段命中 relay 指令）后生效，即「对手确实是被重放的 relay 规划器」；anti 最长连击 25，因此 anti 四格逐局不变 |

斩杀门控放在 planner 的斩杀分支上读 `board.shadow.armed`（不是每 Tick 的预测对象：relay 队列
偶尔为空但层仍然 armed）。把 `shadowContest` 挪到斩杀分支之前会改变行为，已避免。

### 4. 实测

明码单线 8 格（16 种子，配对 baseline）：

| 格 | 候选 | 配对基线 | delta |
| --- | --- | --- | --- |
| relay/mediterranean | **21/32（65.6%）** | 19 | +6.3pp |
| relay/archipelago | 23/32 | 16 | +21.9pp |
| relay/maze | 23/32 | 21 | +6.3pp |
| relay/random | 22/32 | 17 | +15.6pp |
| anti/mediterranean | 26/32 | 22 | +12.5pp |
| anti/archipelago | 24/32 | 19 | +15.6pp |
| anti/maze | 29/32 | 29 | 0.0pp |
| anti/random | 21/32 | 21 | 0.0pp |

全量 2048 局（16 种子 x 4 对手 x 4 图 x 4 模式，默认无 env）：**1673/309/66（81.7%）**，
flips `winToLoss 27 / lossToWin 79 / winToTimeout 10 / timeoutToWin 10 / lossToTimeout 11 /
timeoutToLoss 5`，**64 格 0 个负 delta**，非 relay 格全部 >= 50%。仍未到 65% 的只有 relay
的多线格（本轮不涉及，逐格 delta 0.0pp）。

### 5. 复现

```sh
cd C:/Users/reson/Downloads/fork/Roka-bot3-r13-med
# 明码单线 8 格（约 3 分钟）
WORKERS=2 SEED_FROM=1 SEED_TO=16 OPPONENTS=relay,anti \
  MAPS=mediterranean,archipelago,random,maze MODES=000 OUT=/tmp/g.jsonl SUMMARY=/tmp/g.json \
  node bot-template/relay-bot/training/evaluate-matrix.cjs
NO_GATE=1 node bot-template/relay-bot/training/compare.cjs /tmp/g.jsonl
# 逐 tick 探针（土地/兵力/王冠 + 漏斗谓词）
SEED=bot3-baseline-3 MAP=mediterranean SEAT=0 node /tmp/med-probe.cjs
```
