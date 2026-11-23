# Bot(3.0) 最终基线

本文件记录 `feat/bot-3.0-1v1` 主线上第 7–13 轮迭代后的最终小图 1v1 验收数据。评测使用正式
`GameEngine`（`dist/` 构建产物）与上游最新 relay-bot 作为对手。

- 策略源码哈希：`a33fca4d77413a5badad7b87f685399b068c6167bb56cbba29f508cb1d289a48`
- 引擎基线：上游 `6821598 merge: disable multiline burst growth`
- 地图：官方小图（1v1 `0.34`），随机 / 迷宫 / 群岛 / 地中海
- 模式：迷雾关/开 × 多线关/开
- 对手：Apex / Anti-Human / Bot(2.0) / Relay（原版 relay-bot）
- 每个项目 32 局 = 16 个种子（`bot3-baseline-1` 至 `bot3-baseline-16`）× 双方换边
- 每局上限 1000 Tick；胜 = 对手先被淘汰，负 = Bot(3.0) 先被淘汰，超时 = 双方均存活至 1000 Tick
- 默认配置（无环境变量），`WORKERS=4` 前台跑完 16 个种子

合计 **2048 局：1688 胜 / 299 负 / 61 超时，胜率 82.4%**（较上一版 1621/367/60 提升 **+67 胜**，
逐格零退化）。

## 汇总

| 对手       | 局数 |   胜 |  负 | 超时 |  胜率 |
| ---------- | ---: | ---: | --: | ---: | ----: |
| Apex       |  512 |  471 |  28 |   13 | 92.0% |
| Anti-Human |  512 |  454 |  35 |   23 | 88.7% |
| Bot(2.0)   |  512 |  463 |  37 |   12 | 90.4% |
| Relay      |  512 |  300 | 199 |   13 | 58.6% |
| 合计       | 2048 | 1688 | 299 |   61 | 82.4% |

| 地图   | 局数 |  胜 |  负 | 超时 |  胜率 |
| ------ | ---: | --: | --: | ---: | ----: |
| 随机   |  512 | 420 |  74 |   18 | 82.0% |
| 迷宫   |  512 | 428 |  77 |    7 | 83.6% |
| 群岛   |  512 | 420 |  81 |   11 | 82.0% |
| 地中海 |  512 | 420 |  67 |   25 | 82.0% |

| 模式        | 局数 |  胜 |  负 | 超时 |  胜率 |
| ----------- | ---: | --: | --: | ---: | ----: |
| 全图 / 单线 |  512 | 408 |  88 |   16 | 79.7% |
| 全图 / 多线 |  512 | 433 |  73 |    6 | 84.6% |
| 迷雾 / 单线 |  512 | 406 |  74 |   32 | 79.3% |
| 迷雾 / 多线 |  512 | 441 |  64 |    7 | 86.1% |

## 验收状态

验收目标：对阵原版 Relay 的每个项目胜率 >= 65%；其余项目 >= 50% 且相对上一版不退化。

- 非 Relay 三对手：**全部 >= 50%，64 格中 0 个低于上一版基线**。
- Relay：**8 / 16 格达标** —— 全部 8 个单线格均 >= 65%：

| 地图          | 全图 / 单线 | 迷雾 / 单线 |
| ------------- | ----------: | ----------: |
| 随机          |       68.8% |       68.8% |
| 迷宫          |       71.9% |       65.6% |
| 群岛          |       71.9% |       71.9% |
| 地中海        |       65.6% |       68.8% |

- Relay 多线 8 格仍为 **46.9%–53.1%**（逐格 Δ0.0pp）。这是**镜像结构性上限**，不是策略缺口：
  每个种子的两座位是完美反射（同一决胜 Tick、双方各胜一场），任一确定性对称政策下多线格胜率
  上限就是 50%；多线每 Tick 只执行约 6 条指令（t100 约 1.4 兵/格，行动需 2 兵），主城永远建不出
  （无任何格达到 50 兵），斩首窗口在 597 个采样 Tick 中出现 0 次。第 12–14 轮用一阶精确搜索
  （自建仿真器与真实引擎逐 Tick 0 不匹配、relay 指令批次预测 100%）也未能取得净收益。
  证据链见 [MULTI.md](MULTI.md) 与 [NEXT.md](NEXT.md)。

## 默认开启的层（第 7–13 轮新增）

| 层 | 作用 | 关闭方式 |
| --- | --- | --- |
| `fog.js` 先涂地封顶 `BOT3_FOG_PAINT3` | 迷雾单线柱状推进在边境仍有中立格时先取地 | `BOT3_FOG_PAINT3=0` |
| `shadow.js` 影子预测 `BOT3_SHADOW` | 清晰房间重放 relay 规划器，严格武装 28 Tick 后按结算顺序否决/重排单条指令 | `BOT3_SHADOW=0` |
| `fog-maze.js` 迷雾迷宫层 `BOT3_MAZEFOG3` | 走廊目标场 + 涂色封顶 + 王冠经济退场门控（`ECON=4`） | `BOT3_MAZEFOG3=0` |
| `cut.js` 反向救援 `BOT3_CUTSAVE` | 切断后同 Tick 重连大口袋（`_MIN=10 _BEHIND=1 _SHARE=10`） | `BOT3_CUTSAVE=0` |
| `archipelago.js` 群岛层 `BOT3_ARCH` | burst 期抢最近无人岛 + burst 后用可见前线替代远处主城（迷雾下仅在看不到敌方格时抢地） | `BOT3_ARCH=0` |
| `land.js` 抢地层 `BOT3_LANDFIRST` | 沼泽重图明牌单线、土地落后时让收尾漏斗退场 | `BOT3_LANDFIRST=0` |
| `shadow.js` 惩罚 + `kill.js` 斩杀 | 沼泽重图惩罚 relay 留下的 1 兵格；斩杀层只在影子已武装（镜像确认）时启用 | `BOT3_SHADOW_PUNISH=0` / `BOT3_FINISH=0` |

默认关闭、保留为可复现实验：`BOT3_FINISH`（非武装路径）、`BOT3_MULTI`、`BOT3_FOG_MULTI`、
`BOT3_FOGORACLE`、`BOT3_CUTTIME`、`BOT3_ARTIC`、`BOT3_MULTIDENY`、`BOT3_MDOUBLE`、
`BOT3_MRUSH`、`BOT3_MSEARCH`、`BOT3_MTURTLE`、`BOT3_RESERVE`、`BOT3_PARITY`、
`BOT3_LATEBUILD`、`BOT3_MULTIBANK`、`BOT3_MAZEFOG3` 的裸层变体等（见各专题文档）。

## 完整矩阵

每格 32 局（16 种子 × 换边）。

| 对手  | 地图          | 迷雾 | 多线 | 局数 |  胜 |  负 | 超时 |   胜率 |
| ----- | ------------- | ---- | ---- | ---: | --: | --: | ---: | -----: |
| apex | random | 关 | 关 | 32 | 30 | 2 | 0 | 93.8% |
| apex | random | 关 | 开 | 32 | 32 | 0 | 0 | 100.0% |
| apex | random | 开 | 关 | 32 | 28 | 1 | 3 | 87.5% |
| apex | random | 开 | 开 | 32 | 32 | 0 | 0 | 100.0% |
| apex | maze | 关 | 关 | 32 | 27 | 5 | 0 | 84.4% |
| apex | maze | 关 | 开 | 32 | 32 | 0 | 0 | 100.0% |
| apex | maze | 开 | 关 | 32 | 26 | 3 | 3 | 81.3% |
| apex | maze | 开 | 开 | 32 | 32 | 0 | 0 | 100.0% |
| apex | archipelago | 关 | 关 | 32 | 30 | 2 | 0 | 93.8% |
| apex | archipelago | 关 | 开 | 32 | 25 | 7 | 0 | 78.1% |
| apex | archipelago | 开 | 关 | 32 | 30 | 2 | 0 | 93.8% |
| apex | archipelago | 开 | 开 | 32 | 31 | 1 | 0 | 96.9% |
| apex | mediterranean | 关 | 关 | 32 | 28 | 3 | 1 | 87.5% |
| apex | mediterranean | 关 | 开 | 32 | 32 | 0 | 0 | 100.0% |
| apex | mediterranean | 开 | 关 | 32 | 24 | 2 | 6 | 75.0% |
| apex | mediterranean | 开 | 开 | 32 | 32 | 0 | 0 | 100.0% |
| anti | random | 关 | 关 | 32 | 21 | 4 | 7 | 65.6% |
| anti | random | 关 | 开 | 32 | 32 | 0 | 0 | 100.0% |
| anti | random | 开 | 关 | 32 | 23 | 5 | 4 | 71.9% |
| anti | random | 开 | 开 | 32 | 32 | 0 | 0 | 100.0% |
| anti | maze | 关 | 关 | 32 | 29 | 2 | 1 | 90.6% |
| anti | maze | 关 | 开 | 32 | 32 | 0 | 0 | 100.0% |
| anti | maze | 开 | 关 | 32 | 30 | 2 | 0 | 93.8% |
| anti | maze | 开 | 开 | 32 | 32 | 0 | 0 | 100.0% |
| anti | archipelago | 关 | 关 | 32 | 24 | 5 | 3 | 75.0% |
| anti | archipelago | 关 | 开 | 32 | 32 | 0 | 0 | 100.0% |
| anti | archipelago | 开 | 关 | 32 | 23 | 9 | 0 | 71.9% |
| anti | archipelago | 开 | 开 | 32 | 29 | 0 | 3 | 90.6% |
| anti | mediterranean | 关 | 关 | 32 | 26 | 3 | 3 | 81.3% |
| anti | mediterranean | 关 | 开 | 32 | 32 | 0 | 0 | 100.0% |
| anti | mediterranean | 开 | 关 | 32 | 25 | 5 | 2 | 78.1% |
| anti | mediterranean | 开 | 开 | 32 | 32 | 0 | 0 | 100.0% |
| v2 | random | 关 | 关 | 32 | 25 | 7 | 0 | 78.1% |
| v2 | random | 关 | 开 | 32 | 28 | 4 | 0 | 87.5% |
| v2 | random | 开 | 关 | 32 | 29 | 1 | 2 | 90.6% |
| v2 | random | 开 | 开 | 32 | 32 | 0 | 0 | 100.0% |
| v2 | maze | 关 | 关 | 32 | 22 | 10 | 0 | 68.8% |
| v2 | maze | 关 | 开 | 32 | 32 | 0 | 0 | 100.0% |
| v2 | maze | 开 | 关 | 32 | 26 | 3 | 3 | 81.3% |
| v2 | maze | 开 | 开 | 32 | 32 | 0 | 0 | 100.0% |
| v2 | archipelago | 关 | 关 | 32 | 28 | 4 | 0 | 87.5% |
| v2 | archipelago | 关 | 开 | 32 | 31 | 1 | 0 | 96.9% |
| v2 | archipelago | 开 | 关 | 32 | 30 | 2 | 0 | 93.8% |
| v2 | archipelago | 开 | 开 | 32 | 31 | 1 | 0 | 96.9% |
| v2 | mediterranean | 关 | 关 | 32 | 29 | 3 | 0 | 90.6% |
| v2 | mediterranean | 关 | 开 | 32 | 32 | 0 | 0 | 100.0% |
| v2 | mediterranean | 开 | 关 | 32 | 24 | 1 | 7 | 75.0% |
| v2 | mediterranean | 开 | 开 | 32 | 32 | 0 | 0 | 100.0% |
| relay | random | 关 | 关 | 32 | 22 | 9 | 1 | 68.8% |
| relay | random | 关 | 开 | 32 | 16 | 16 | 0 | 50.0% |
| relay | random | 开 | 关 | 32 | 22 | 9 | 1 | 68.8% |
| relay | random | 开 | 开 | 32 | 16 | 16 | 0 | 50.0% |
| relay | maze | 关 | 关 | 32 | 23 | 9 | 0 | 71.9% |
| relay | maze | 关 | 开 | 32 | 16 | 16 | 0 | 50.0% |
| relay | maze | 开 | 关 | 32 | 21 | 11 | 0 | 65.6% |
| relay | maze | 开 | 开 | 32 | 16 | 16 | 0 | 50.0% |
| relay | archipelago | 关 | 关 | 32 | 23 | 9 | 0 | 71.9% |
| relay | archipelago | 关 | 开 | 32 | 15 | 15 | 2 | 46.9% |
| relay | archipelago | 开 | 关 | 32 | 23 | 8 | 1 | 71.9% |
| relay | archipelago | 开 | 开 | 32 | 15 | 15 | 2 | 46.9% |
| relay | mediterranean | 关 | 关 | 32 | 21 | 11 | 0 | 65.6% |
| relay | mediterranean | 关 | 开 | 32 | 14 | 14 | 4 | 43.8% |
| relay | mediterranean | 开 | 关 | 32 | 22 | 10 | 0 | 68.8% |
| relay | mediterranean | 开 | 开 | 32 | 15 | 15 | 2 | 46.9% |

## 迭代轨迹（同引擎、同 relay）

| 轮次 | 结果 | 关键变化 |
| ---- | ---- | -------- |
| round 6（上一版基线） | 1621/367/60（79.2%） | 迷宫走廊、单线收尾、迷雾单线层；relay 2/16 格达标 |
| 第 7–8 轮 | 1629–1637 | 迷雾先涂地封顶 `PAINT3`（+8，零退化）、影子预测 `SHADOW` 严格武装 |
| 第 11 轮 | 1644–1649 | 迷雾迷宫层王冠经济门控、反向救援门控 `CUTSAVE` |
| 第 12 轮 | 1668–1671 | 群岛抢地层 `ARCH`、抢地层 `LAND` |
| 第 13 轮 | 1686–1688 | 群岛迷雾视野门控（+15）、地中海沼泽惩罚 + 武装斩杀（+2） |

## 大图零退化烟测

大图不在验收矩阵内。`scripts/evaluate-bot3-baseline.cjs` 只接受官方小图，大图用底层
`scripts/evaluate-bot3.cjs` 运行。以 large maze、1 个种子、四个对手 × 双方换边 × 四个 large 模式
（32 局）对比“默认全层”与“新层全部关闭”（`BOT3_FOG_PAINT3=0 BOT3_SHADOW=0 BOT3_MAZEFOG3=0
BOT3_ARCH=0 BOT3_CUTSAVE=0 BOT3_LANDFIRST=0`）：

- 默认：16 胜 / 4 负 / 12 超时
- 新层全关：16 胜 / 5 负 / 11 超时
- **胜场完全一致**，仅 1 局由负转为超时；未发现默认层对大图造成胜率退化。

## 复现

```sh
pnpm run build
SEED_FROM=1 SEED_TO=16 WORKERS=4 \
  OUT=/tmp/bot3-final.jsonl SUMMARY=/tmp/bot3-final-summary.json \
  node scripts/evaluate-bot3-baseline.cjs
NO_GATE=1 node scripts/compare-bot3-baseline.cjs /tmp/bot3-final.jsonl
pnpm --dir bot-template/bot-3.0 test   # 或 node --test bot-template/bot-3.0/bot3.test.cjs
```

原始逐局记录见 [baseline-results.jsonl](baseline-results.jsonl)，机器可读汇总见
[baseline-summary.json](baseline-summary.json)。历史基线（1621/367/60）仍保留在
`baseline-results.jsonl` 的 git 历史中；`compare-bot3-baseline.cjs` 以当前记录文件为门禁基准。
