# 第 20 轮：最后的收口（多线 173 → 193/256）

第 20 轮把 Relay 多线从 **173/256（67.6%）** 推到 **193/256（75.4%）**，全量矩阵从
1739/254/55 推到 **1759/237/52（85.9%）**，逐格零退化。Relay 16 格中 **14 格达标**：8 个单线格
全部 >=65%，多线 6 格达标（random 明牌 68.8%、maze 明牌 68.8%、arch 明牌 81.3%、arch 迷雾 78.1%、
med 明牌 96.9%、med 迷雾 96.9%），**只剩 random 迷雾与 maze 迷雾各 18/32**（各差 3 胜）。

## 启用项（默认开启）

| 机制 | 开关 | 实测 |
| --- | --- | --- |
| 岛屿浅层取兵：岛屿图的后方盆地比第 18 轮采集带浅一跳，第一次 50 兵建城抽干 hop≥3 后，付第二次 50 兵的兵力停在 hop 2，金库永远停在指挥所。沼泽 ≥55% 时把取点/盆地行走/改道/灌兵整体下移一跳 | `BOT3_MCROWN2_SHALLOW=55` | arch 迷雾 19 → 24（+5），独立半区 18 → 21；全量只动该格 |
| 走廊层：迷宫多线是单通道（1 兵格不能推、匹配循环一格只收一单），按 `mhalf` 走廊路由重排通道合并、向环格追加多路灌兵、迷雾里给十六单一个走廊分支目标 | `BOT3_MAZERUSH=1` | maze 明牌 18 → 20/22、迷雾 16 → 18/20；独立半区 +1/+1 |
| 草地迷雾补环：脉冲帧的补环武装合并会压过它正在武装的占领（脉冲 Tick 我们拿 10.1 格、relay 16.7 格），该帧降低重载奖励 | `BOT3_FOGRASS=1` | random 迷雾 17 → 19（两半区均 +2），其余格逐字节不变 |
| 联合三旋钮（第 20 轮配置搜索的稳健子集） | `BOT3_BANKGATE_HOP=1`、`BOT3_M2PLY_CUT=1.5`、`BOT3_MHALF_ARM_RING=10` | 金库取兵带下移到 hop 1（arch 明牌 +5、med 明牌 +1）、搜索里断链估值 1.5（maze 明牌 +1）、被威胁的环格武装 10（每个沼泽重迷雾格 +1） |

全局跑同一套补环（`BOT3_MHALF_RELOAD=30`）会退化 med 明牌与 random 明牌，所以它只留在草地迷雾房间。

## 负结果与方法学

- 迷雾搜索（`BOT3_MFOGSEARCH`，鲁棒计划集）：迷雾下对手整批指令不可重建（整批匹配 0.1–0.4%，
  明牌 97–98%），最坏情况混合反而更差；净 +1 局。
- 走廊层的雷达：岔口抢攻（`RUSH`）、两兵泵（`PUMP`）、封口（`SEAL`）、多路灌兵（`FEED`）单独实测
  非负即负；有效的是 `mhalf` 走廊路由 + 被威胁环格的合并定价 + 迷雾分支目标这一组合。
- 第 20 轮配置搜索（213 个配置、116 个轴、种子 1–16 选择 + 17–32 留出 + 全量矩阵）：冻结组合
  193–188 局；**部分轴是选择拟合**（held-out 上 random 明牌 −3、maze 明牌 −1），因此只采纳了
  在留出半区不回退的三个旋钮。轴映射结论：迷雾多线房间里 `MAZEFOG3`、`MAZE_SINGLE_FROM`、
  `MAZE_LANE` 与全部 fog-multi 旋钮都是惰性的；把迷雾金库强行开到 random 迷雾（`MCROWN2_SWAMP=5`）
  会重现第 19 轮的 18 → 10 崩盘。
- 评估确定性：同一棵树两次相同运行在 128 局内 0 差异；`v2` 单线格是**时钟预算敏感**的对手
  （两次相同运行可差 4–13 局），因此全量矩阵里 v2 格的小幅波动不能算作本方的变化。

## 剩下两格的机制诊断（为什么调参到头了）

- 两格都是「迷雾 + 多线」：搜索的偏置来源（预测对手整批指令）在迷雾下不可用，因此所有明牌收益都
  无法迁移。
- `random` 迷雾（草地）：后本金库实测亏本（后方军队是管道，t100 地盘 60 对 95）；厚度环、后手反夺
  都实测中性或负；唯一有效的是补环节奏（已启用）。
- `maze` 迷雾（走廊）：胜负由 t100 的 Voronoi 分割决定（42/46 局可由其符号预测），前沿吞吐被
  「一通道每两 Tick 一兵」限死；迷雾里没有对手棋盘，连信念都只能从可见格推。
- 下一步若继续，需要的是机制而不是旋钮：例如在迷雾里维护对手前沿的信念清单并据此定价
  （鲁棒计划集只差 1 局），或把走廊的「一兵不能推」在迷雾里用多路灌兵补上（明牌已由走廊层解决）。

## 复现

```sh
pnpm run build
OPPONENTS=relay MAPS=random,maze,archipelago,mediterranean MODES=001,011 \
SEED_FROM=1 SEED_TO=16 WORKERS=8 OUT=/tmp/m20.jsonl node bot-template/relay-bot/training/evaluate-matrix.cjs || true
NO_GATE=1 node bot-template/relay-bot/training/compare.cjs /tmp/m20.jsonl
WORKERS=8 OUT=/tmp/m20-full.jsonl node bot-template/relay-bot/training/evaluate-matrix.cjs
node --test bot-template/relay-bot/strategy.test.cjs
```

分支记录：`exp/bot3-r20-archfog`（`f2f7eb3`）、`exp/bot3-r20-mazerush`（`d12449b`）、
`exp/bot3-r20-foggrass`（`774801e`）、`exp/bot3-r20-combine4`（`1830333`）。
