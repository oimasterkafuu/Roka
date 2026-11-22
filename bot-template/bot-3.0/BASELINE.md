# Bot(3.0) 最终基线

本文件记录 `feat/bot-3.0-1v1` 当前主线的最终小图 1v1 验收数据。评测使用正式 `GameEngine`（`dist/` 构建产物）与上游最新 relay-bot 作为对手；旧引擎的 1490 基线已不可直接比较（上游移除了多线 burst 增长）。

- 源码提交：`c8e057d`（上游 cursor-control 同步后的主线）
- 策略源码哈希：`afd860d792a1e6b3c65b03bfe658f800904571bc4ebdae2c325db1459c0e9d46`
- 引擎基线：上游 `6821598 merge: disable multiline burst growth`
- 地图：官方小图（1v1 `0.34`），随机 / 迷宫 / 群岛 / 地中海
- 模式：迷雾关/开 × 多线关/开
- 对手：Apex / Anti-Human / Bot(2.0) / Relay（原版 relay-bot）
- 每个项目 32 局 = 16 个种子（`bot3-baseline-1` 至 `bot3-baseline-16`）× 双方换边
- 每局上限 1000 Tick；胜 = 对手先被淘汰，负 = Bot(3.0) 先被淘汰，超时 = 双方均存活至 1000 Tick
- 16 个种子全部在前台运行，最终验收使用 `WORKERS=2`

合计 **2048 局：1621 胜 / 367 负 / 60 超时，胜率 79.2%**。

## 汇总

| 对手       | 局数 |   胜 |  负 | 超时 |  胜率 |
| ---------- | ---: | ---: | --: | ---: | ----: |
| Apex       |  512 |  459 |  39 |   14 | 89.6% |
| Anti-Human |  512 |  442 |  48 |   22 | 86.3% |
| Bot(2.0)   |  512 |  451 |  47 |   14 | 88.1% |
| Relay      |  512 |  269 | 233 |   10 | 52.5% |
| 合计       | 2048 | 1621 | 367 |   60 | 79.2% |

| 地图   | 局数 |  胜 |  负 | 超时 |  胜率 |
| ------ | ---: | --: | --: | ---: | ----: |
| 随机   |  512 | 406 |  93 |   13 | 79.3% |
| 迷宫   |  512 | 419 |  83 |   10 | 81.8% |
| 群岛   |  512 | 382 | 119 |   11 | 74.6% |
| 地中海 |  512 | 414 |  72 |   26 | 80.9% |

| 模式        | 局数 |  胜 |  负 | 超时 |  胜率 |
| ----------- | ---: | --: | --: | ---: | ----: |
| 全图 / 单线 |  512 | 374 | 123 |   15 | 73.0% |
| 全图 / 多线 |  512 | 432 |  74 |    6 | 84.4% |
| 迷雾 / 单线 |  512 | 374 | 106 |   32 | 73.0% |
| 迷雾 / 多线 |  512 | 441 |  64 |    7 | 86.1% |

## 验收状态

验收目标：对阵原版 Relay 的每个项目胜率 >= 65%；其余项目 >= 50% 且相对上一版不退化。

- 非 Relay 三对手：**全部 >= 50%，无负向格**。
- Relay：**2 / 16 格达标**
  - 达标：`maze FF 单线 65.6%`、`mediterranean 迷雾单线 68.8%`
  - 未达标：其余 14 格 43.8%–59.4%
- 同引擎上一版（round6，1615/374/59）对比：**+6 胜，零负向格**。
- Relay 格是“同一引擎、同一策略”的镜像局；纯评分微调很难突破，需要严格更优的机制。剩余差距与已验证/未验证方向见 [NEXT.md](NEXT.md)。

## 完整矩阵

每格 32 局（16 种子 × 换边）。

| 对手  | 地图          | 迷雾 | 多线 | 局数 |  胜 |  负 | 超时 |   胜率 |
| ----- | ------------- | ---- | ---- | ---: | --: | --: | ---: | -----: |
| anti  | random        | 关   | 关   |   32 |  21 |   4 |    7 |  65.6% |
| anti  | random        | 关   | 开   |   32 |  32 |   0 |    0 | 100.0% |
| anti  | random        | 开   | 关   |   32 |  21 |   9 |    2 |  65.6% |
| anti  | random        | 开   | 开   |   32 |  32 |   0 |    0 | 100.0% |
| anti  | maze          | 关   | 关   |   32 |  29 |   2 |    1 |  90.6% |
| anti  | maze          | 关   | 开   |   32 |  32 |   0 |    0 | 100.0% |
| anti  | maze          | 开   | 关   |   32 |  30 |   2 |    0 |  93.8% |
| anti  | maze          | 开   | 开   |   32 |  32 |   0 |    0 | 100.0% |
| anti  | archipelago   | 关   | 关   |   32 |  19 |  13 |    0 |  59.4% |
| anti  | archipelago   | 关   | 开   |   32 |  32 |   0 |    0 | 100.0% |
| anti  | archipelago   | 开   | 关   |   32 |  22 |  10 |    0 |  68.8% |
| anti  | archipelago   | 开   | 开   |   32 |  29 |   0 |    3 |  90.6% |
| anti  | mediterranean | 关   | 关   |   32 |  22 |   4 |    6 |  68.8% |
| anti  | mediterranean | 关   | 开   |   32 |  32 |   0 |    0 | 100.0% |
| anti  | mediterranean | 开   | 关   |   32 |  25 |   4 |    3 |  78.1% |
| anti  | mediterranean | 开   | 开   |   32 |  32 |   0 |    0 | 100.0% |
| apex  | random        | 关   | 关   |   32 |  30 |   2 |    0 |  93.8% |
| apex  | random        | 关   | 开   |   32 |  32 |   0 |    0 | 100.0% |
| apex  | random        | 开   | 关   |   32 |  28 |   2 |    2 |  87.5% |
| apex  | random        | 开   | 开   |   32 |  32 |   0 |    0 | 100.0% |
| apex  | maze          | 关   | 关   |   32 |  27 |   5 |    0 |  84.4% |
| apex  | maze          | 关   | 开   |   32 |  32 |   0 |    0 | 100.0% |
| apex  | maze          | 开   | 关   |   32 |  25 |   3 |    4 |  78.1% |
| apex  | maze          | 开   | 开   |   32 |  32 |   0 |    0 | 100.0% |
| apex  | archipelago   | 关   | 关   |   32 |  24 |   8 |    0 |  75.0% |
| apex  | archipelago   | 关   | 开   |   32 |  25 |   7 |    0 |  78.1% |
| apex  | archipelago   | 开   | 关   |   32 |  25 |   5 |    2 |  78.1% |
| apex  | archipelago   | 开   | 开   |   32 |  31 |   1 |    0 |  96.9% |
| apex  | mediterranean | 关   | 关   |   32 |  28 |   3 |    1 |  87.5% |
| apex  | mediterranean | 关   | 开   |   32 |  32 |   0 |    0 | 100.0% |
| apex  | mediterranean | 开   | 关   |   32 |  24 |   3 |    5 |  75.0% |
| apex  | mediterranean | 开   | 开   |   32 |  32 |   0 |    0 | 100.0% |
| relay | random        | 关   | 关   |   32 |  17 |  15 |    0 |  53.1% |
| relay | random        | 关   | 开   |   32 |  16 |  16 |    0 |  50.0% |
| relay | random        | 开   | 关   |   32 |  16 |  16 |    0 |  50.0% |
| relay | random        | 开   | 开   |   32 |  16 |  16 |    0 |  50.0% |
| relay | maze          | 关   | 关   |   32 |  21 |  11 |    0 |  65.6% |
| relay | maze          | 关   | 开   |   32 |  16 |  16 |    0 |  50.0% |
| relay | maze          | 开   | 关   |   32 |  16 |  16 |    0 |  50.0% |
| relay | maze          | 开   | 开   |   32 |  16 |  16 |    0 |  50.0% |
| relay | archipelago   | 关   | 关   |   32 |  16 |  16 |    0 |  50.0% |
| relay | archipelago   | 关   | 开   |   32 |  15 |  15 |    2 |  46.9% |
| relay | archipelago   | 开   | 关   |   32 |  19 |  13 |    0 |  59.4% |
| relay | archipelago   | 开   | 开   |   32 |  15 |  15 |    2 |  46.9% |
| relay | mediterranean | 关   | 关   |   32 |  19 |  13 |    0 |  59.4% |
| relay | mediterranean | 关   | 开   |   32 |  14 |  14 |    4 |  43.8% |
| relay | mediterranean | 开   | 关   |   32 |  22 |  10 |    0 |  68.8% |
| relay | mediterranean | 开   | 开   |   32 |  15 |  15 |    2 |  46.9% |
| v2    | random        | 关   | 关   |   32 |  25 |   7 |    0 |  78.1% |
| v2    | random        | 关   | 开   |   32 |  28 |   4 |    0 |  87.5% |
| v2    | random        | 开   | 关   |   32 |  28 |   2 |    2 |  87.5% |
| v2    | random        | 开   | 开   |   32 |  32 |   0 |    0 | 100.0% |
| v2    | maze          | 关   | 关   |   32 |  22 |  10 |    0 |  68.8% |
| v2    | maze          | 关   | 开   |   32 |  32 |   0 |    0 | 100.0% |
| v2    | maze          | 开   | 关   |   32 |  25 |   2 |    5 |  78.1% |
| v2    | maze          | 开   | 开   |   32 |  32 |   0 |    0 | 100.0% |
| v2    | archipelago   | 关   | 关   |   32 |  25 |   7 |    0 |  78.1% |
| v2    | archipelago   | 关   | 开   |   32 |  30 |   2 |    0 |  93.8% |
| v2    | archipelago   | 开   | 关   |   32 |  24 |   6 |    2 |  75.0% |
| v2    | archipelago   | 开   | 开   |   32 |  31 |   1 |    0 |  96.9% |
| v2    | mediterranean | 关   | 关   |   32 |  29 |   3 |    0 |  90.6% |
| v2    | mediterranean | 关   | 开   |   32 |  32 |   0 |    0 | 100.0% |
| v2    | mediterranean | 开   | 关   |   32 |  24 |   3 |    5 |  75.0% |
| v2    | mediterranean | 开   | 开   |   32 |  32 |   0 |    0 | 100.0% |

## 与历史基线

- 项目初始基线 1490/424/134（72.8%）使用旧引擎（多线 burst 仍存在）与旧 relay；上游随后移除多线 burst，并更新了 relay 的 opening/reinforcement pricing，因此原始数字只能作为历史记录，不能与新引擎逐格比较。
- 在新引擎下，round6 基线为 1615/374/59（78.9%）；最终版本 1621/367/60（79.2%），逐格零负向。
- 当前主线默认开关：
  - 默认开：迷宫走廊相位、单线收尾纵队、迷雾单线层
  - 默认关：斩杀层 `BOT3_FINISH`、多线 focus 层 `BOT3_MULTI`、迷雾多线 burst 门控 `BOT3_FOG_MULTI`

## 大图零退化烟测

大图不在验收矩阵内。当前默认路径中只有迷宫走廊相位会作用于大图（`closing` 限制小图，`fog` 限制 `<=800`，`multi`/`kill` 默认关）。用 1 个种子、large maze、四个对手 × 双方换边 × 四个 large 模式（32 局）对比 `BOT3_MAZE=0` 与默认：双方均为 17 胜 / 3 负 / 12 超时，胜场完全一致，仅 1 局 timeout/loss 互换；未发现默认层对大图造成胜率退化。

## 复现

```sh
pnpm run build
SEED_FROM=1 SEED_TO=16 WORKERS=2   OUT=/tmp/bot3-final.jsonl SUMMARY=/tmp/bot3-final-summary.json   node scripts/evaluate-bot3-baseline.cjs
NO_GATE=1 node scripts/compare-bot3-baseline.cjs /tmp/bot3-final.jsonl   bot-template/bot-3.0/baseline-results.jsonl
```

原始逐局记录见 [baseline-results.jsonl](baseline-results.jsonl)，机器可读汇总见 [baseline-summary.json](baseline-summary.json)。
