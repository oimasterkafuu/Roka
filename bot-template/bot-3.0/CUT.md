# 切断经济学层（cut）

`cut.js` 是隔离/切断方向的实验层：它只改评分（以及 `BOT3_ARTIC` 额外提出建造候选），不保存任何状态、不读时钟、不用随机数。全部开关默认关闭，关闭时逐局结果与基线 `baseline-results.jsonl` 完全一致（4 种子屏幕逐行 `diff` 为空）。

## 引擎事实（诊断依据）

- `applyConnectivity` 每 Tick 在所有己方**锚点**（主城 -2 / 指挥所 -1）上做一次多源 BFS：连到任一锚点的格子为正常，其余格子被标记 `isolated`。新断链的格子**立即减半**（1 兵例外），随后 10 Tick 宽限，之后每回合（2 Tick）衰减 5%，减到 0 变中立；重新连回时**兵力翻倍**（该孤军周期内被推过兵则翻倍失效）。
- `applyTickGrowth` 在**移动阶段之前**执行：主城每 Tick +1；普通格/指挥所在 `turn % 50 === 0` 且非孤军时 +1。
- 出生顺序：`strategy.js` 用 `frame.turn = T` 的状态决策，指令在 **Tick T+1** 执行。因此“在 Tick 49 落下切断”的决策点是 `turn % 50 === 48`（`BOT3_CUTTIME_PHASE`），这样被切断区域从 Tick 50 的 +1 开始就再也拿不到。
- 锚点格子**永远不会被标记孤军**：把它升级成指挥所/主城，等于给它背后的整片区域上保险（BFS 从这里出发）。代价是锚点格可被攻占，攻占即摧毁建筑并带走全部驻军。

## 五个机制

| 开关                                           | 默认 | 机制                                                                                                                                                             |
| ---------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOT3_CUTTIME`                                 | 关   | 时间：`turn % 50 === 48` 时，给“本 Tick 必胜”的敌方割点攻击加 `min(cap, gain*sqrt(cut))`（默认 300/600）；可选 `BOT3_CUTTIME_APPROACH` 在风落前走入割点距离场    |
| `BOT3_CUTVALUE`                                | 关   | 定价：敌方割点攻击 `+min(600, 4*cut)`，`cut > 40` 时保底 420，要求 `homes >= 2`                                                                                  |
| `BOT3_ARTIC`                                   | 关   | 加固：对己方最高 `cut` 的割点格提出廉价建造（成本 + 3 兵），要求脱战（`enemyDist >= 3`、七步压力、相邻无敌方大堆）                                               |
| `BOT3_MULTICUT`                                | 关   | 多线：多线房间内敌方割点攻击 `+min(600, 4*sqrt(cut))`（`multi.js` 的 `cut` 层的加法版本，不启用 focus/paint 负向项）                                             |
| `BOT3_CUTSAVE`（本轮新增，方向上唯一的正结果） | 关   | 反向切断：己方被切断的“孤岛”若能被某格重新连回，则该格的攻占价 `+min(cap, 3*pocket)`；`BOT3_CUTSAVE_MIN` 是孤岛兵力门槛（默认 30），`_SURE=1` 只算本 Tick 能打下 |

## 实测（Relay，16 种子 × 双座位 = 512 局；`NO_GATE=1` 配对比较）

| 配置                                                            | 胜/负/超时 | 胜率  | Δ vs 配对基线 | 说明                                                                                                                   |
| --------------------------------------------------------------- | ---------- | ----- | ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 基线                                                            | 269/233/10 | 52.5% | —             | 参考                                                                                                                   |
| `BOT3_CUTTIME=1`                                                | 268/232/12 | 52.3% | -0.2pp        | 几乎惰性：风落窗口内我们**根本不挨着**敌方割点（trace：Tick 48 敌方候选 0 条）                                         |
| `BOT3_CUTVALUE=1`                                               | 269/232/11 | 52.5% | 0.0pp         | random 单线 +3、arch 单线 -2、med 单线 -2；多线 8 格全 0（`homes>=2` 不成立）                                          |
| `BOT3_ARTIC=1`                                                  | 232/265/15 | 45.3% | -7.2pp        | 负：maze 单线 -21.9、maze 迷雾单线 -28.1、med 迷雾单线 -31.3；多线 8 格全 0（`units>=53` 不出现）                      |
| `BOT3_MULTICUT=1`                                               | 270/233/9  | 52.7% | +0.2pp        | 仅 `mediterranean 迷雾多线` +1 局，其余多线格不动                                                                      |
| `BOT3_CUTTIME=1 BOT3_CUTTIME_APPROACH=150 BOT3_CUTTIME_MULTI=0` | 279/222/11 | 54.5% | +2.0pp        | 单线最好的一个：maze 单线 25/7（+4）、med 单线 +3、random 单线 +3、random 迷雾单线 +1、arch 单线 -1；多线格全部 = 基线 |
| `BOT3_CUTSAVE=1`（min 30）                                      | 274/228/10 | 53.5% | +1.0pp        | random 迷雾单线 +4、random 单线 +2、maze 单线 +1；arch 迷雾单线 -1、med 迷雾单线 -1                                    |

全量矩阵（4 对手 × 2048 局）只对两个候选跑完：

| 候选                                                            | 合计        | 胜率  | Δ          | 备用种子 17–32（配对自建基线）                     |
| --------------------------------------------------------------- | ----------- | ----- | ---------- | -------------------------------------------------- |
| `BOT3_CUTTIME=1 BOT3_CUTTIME_APPROACH=150 BOT3_CUTTIME_MULTI=0` | 1612/372/64 | 78.7% | **-0.4pp** | 未跑                                               |
| `BOT3_CUTSAVE=1`（min 30）                                      | 1632/355/61 | 79.7% | +0.5pp     | 1581/382/85（77.2%）对 1576/386/86（77.0%），+5 胜 |
| `BOT3_CUTSAVE=1`（min 6）                                       | 1633/353/62 | 79.7% | +0.6pp     | 1592/381/75（77.7%）对 77.0%，+16 胜               |

结论：

1. **切断进攻（CUTTIME/CUTVALUE/MULTICUT）在本次引擎上基本不可用**。原因是可打到的敌方割点极少：随机/迷宫/群岛这类开阔地图上，敌方领土很少有真正的割点贴着我们的可攻击格；trace 显示风落窗口内的敌方候选里 `cut` 中位数为 0。
2. **加固（ARTIC）是负向**：花费 50 兵 + 一个指令去换“后方不会被切断”，在单线里就是拿推进节奏换保险；迷雾房更糟（`enemyDist` 只数可见敌人，安全门形同虚设）。
3. **反向切断（CUTSAVE）是唯一可复现的正结果**：+5…+16 胜/2048（0.2–0.8pp），在两个互不相交的种子块上都是正的。但它没有达成每格 65% 的目标，且逐格仍是 ±1 局噪声（含受保护的 `med/F-` 在 min=6 时 -1 局）。
4. **多线 8 格无法用切断经济学推动**：多线房间的孤岛兵力中位数 1、p90 5、最大 24（单线：中位数 21、p90 72、最大 279），有孤军的 Tick 占比 7%（单线 39.7%）。一格的攻占价换不到任何东西，所以四个切断开关在两个多线种子块上全部 0.0pp。

## 复现

```sh
# 屏幕（4 种子，约 20s）
WORKERS=2 SEED_FROM=1 SEED_TO=4 OPPONENTS=relay BOT3_CUTSAVE=1 \
  OUT=/tmp/cut-s4.jsonl SUMMARY=/tmp/cut-s4.json node scripts/evaluate-bot3-baseline.cjs
NO_GATE=1 node scripts/compare-bot3-baseline.cjs /tmp/cut-s4.jsonl

# 16 种子 Relay 矩阵（约 80s）
WORKERS=2 SEED_FROM=1 SEED_TO=16 OPPONENTS=relay BOT3_CUTSAVE=1 \
  OUT=/tmp/cut-r16.jsonl SUMMARY=/tmp/cut-r16.json node scripts/evaluate-bot3-baseline.cjs
NO_GATE=1 node scripts/compare-bot3-baseline.cjs /tmp/cut-r16.jsonl

# 全量 2048 局（约 6–8 分钟）
WORKERS=2 SEED_FROM=1 SEED_TO=16 BOT3_CUTSAVE=1 \
  OUT=/tmp/cut-full.jsonl SUMMARY=/tmp/cut-full.json node scripts/evaluate-bot3-baseline.cjs
NO_GATE=1 node scripts/compare-bot3-baseline.cjs /tmp/cut-full.jsonl
```

模块自检（无需引擎）：

```sh
node -e "const c=require('./bot-template/bot-3.0/cut.js');console.log(JSON.stringify(c.cutConfig()))"
```

## 建议

- 全部开关保持默认关闭：没有一个配置满足“Relay 每格 >= 65% 且不低于基线”。
- 下一轮若要多线收益，切断经济学不是路径（见上面第 4 条数据）；`NEXT.md` 的“第二主城经济”仍是多线唯一未被证伪的方向。
- 若要试用 CUTSAVE，先跑 `BOT3_CUTSAVE_MIN=30`（1–16 种子块里 Relay 无退化格），`_MIN=6` 总量更好但会把 `med/F-` 从 68.8% 拉到 65.6%。
