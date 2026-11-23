# Bot(3.0) 后续方向与负结果

本文件记录第 16 轮结束时的状态、剩余缺口与已证伪方向。当前基线见 [BASELINE.md](BASELINE.md)，
第 15–16 轮的 9 条多线实验汇总见 [ROUND16-ROUNDUP.md](ROUND16-ROUNDUP.md)。

## 当前状态

- 小图 1v1 全矩阵 **1702/290/56（83.1%）**，较第 13 轮 +14 胜，**64 格零退化**（32 个单线格逐局相同）。
- 非 Relay 三对手全部 >=50%；Relay **9/16 格达标**——8 个单线格 65.6%–71.9%，多线 random 明牌 65.6%。
- 多线 8 格 **136/256（53.1%）**：random 明牌 21、random 迷雾 17、med 明牌 19、med 迷雾 17、
  maze 16/16、archipelago 15/15。
- 默认开启：第 7–13 轮全部层 + `mshape`（脉冲破格 + 占领优先，`SLOTS=64 STEAL=100 LEAD=110`）
  + `mhalf`（按跳数场补满前线环到 3 兵）。

## 唯一未达标项：Relay 多线 8 格（46.9%–65.6%，目标每格 21/32）

多线房间仍是**完美镜像**：Bot(3.0) 与 relay 在多线里执行同一份 planner，同一 `(地图, 迷雾, 种子)`
的两次换席对局逐 Tick 状态逐字节相同、胜负互补、决胜 Tick 相同。因此：

1. 现状不是「50% 上限」，而是**零净优势**：一旦策略不同，每个种子必然变成 2-0 或 0-2，所以
   21/32 需要 **16 个种子里赢 11 个**（净 +5 对）。
2. 第 15–16 轮 9 条实验全部落在 ±6–12 胜且**跨半区不可复现**：它们扰动了临界交换，但没有产生偏置。
3. 已实测的引擎事实（详见 ROUND16-ROUNDUP.md）：占领阈值 3 兵、16 单上限只在脉冲 Tick 生效、
   「废掉占领的合并」要花两个 Tick、前线环无法预先武装（脉冲产出由环宽决定）、同一 Tick 可以让
   多个来源灌进同一格（planner 尚未使用）、横向（前线→前线）合并从不成为候选、`strategy.js` 的
   pending 门控从不跳 Tick。
4. 47 局死亡诊断：t50/t100 两席几乎完全相同，差距在 t≈100–115 才超过 10 格；败者被逐步推平
   （死前 20 Tick 中位地盘 23 对 171），不是被偷主城。

若仍要推进多线，需要的是一条**有偏**的策略：两席都能赢。当前候选方向（第 17 轮正在实验）：

- **呼吸式环**：把「灌兵」和「出手」分成相位，同一 Tick 多个来源灌满整条环、下一 Tick 全线同时出手。
- **强点突破**：多对一把 1–3 个头部格灌到 8–14 兵，按 `supplyCuts` 断链价值选破口，破后保持或滚动。
- **自对弈调参**：把多线评分参数化后用搜索（训练 1–8、选择 9–16、只在 17–32 上确认）寻找偏置。
- **两 Tick 精确搜索**：复用第 14 轮已验证的 `msim`/`mqueue`，把评估从一 Tick 扩到两 Tick。

## 其他保留方向（单线已达标，优先级低）

- `exp/bot3-r7-tempo`（`5e3d234`）：mode 0/1/2 真实推兵量、结算顺序、兜底指令；全部负向。
- `exp/bot3-r7-econ`（`2544633`）：迷雾建城时点、pressure 解冻、开局节点预算、多线攒兵；中性或负向。
- `exp/bot3-r7-cut`（`2e8d704`）：切断时间/定价/加固/多线隔离；单独使用中性或负向，只有 `CUTSAVE` 有效。
- `exp/bot3-r7-fog`（`88ff8d5`）：排行榜情报层；`paint` 小幅正向，`dive`/`allIn` 灾难性。
- `exp/bot3-r14-multisearch`（`d89fdaa`）：`msim.js`/`mqueue.js` 是可复用的精确仿真器与预测器，
  一阶搜索默认关闭（−1.2pp），可作为多 Tick 搜索的基础设施。
- `exp/bot3-r15-mstack`（`fb36ec9`）：局部强点突破层，`BOT3_MSTACK`，种子 17–32 回吐。
- `exp/bot3-r16-mpulse`（`08d1f90`）：脉冲相位层，`BOT3_MPULSE`，独立半区 −1.1pp。
- `exp/bot3-r16-mfog`（`6f4e10f`）：迷雾多线信条，`BOT3_MFOG`，1 格退化。

## 复现

```sh
pnpm run build
WORKERS=6 OUT=/tmp/bot3-next.jsonl SUMMARY=/tmp/bot3-next-summary.json   node scripts/evaluate-bot3-baseline.cjs
NO_GATE=1 node scripts/compare-bot3-baseline.cjs /tmp/bot3-next.jsonl
node --test bot-template/bot-3.0/bot3.test.cjs
```
