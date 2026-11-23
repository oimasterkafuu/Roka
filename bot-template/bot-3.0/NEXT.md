# Bot(3.0) 后续方向与负结果

本文件记录第 20 轮结束（暂停迭代）时的状态、剩余缺口与已证伪方向。当前基线见 [BASELINE.md](BASELINE.md)，
第 15–16 轮的 9 条多线实验汇总见 [ROUND16-ROUNDUP.md](ROUND16-ROUNDUP.md)。

## 当前状态

- 小图 1v1 全矩阵 **1759/237/52（85.9%）**，较第 13 轮 +71 胜，**64 格零退化**（32 个单线格逐局相同）。
- 非 Relay 三对手全部 >=50%；Relay **14/16 格达标**——8 个单线格 65.6%–71.9%，多线 random 明牌
  68.8%、maze 明牌 68.8%、archipelago 明牌 81.3%、archipelago 迷雾 78.1%、mediterranean 明牌与
  迷雾均 96.9%。
- 多线 8 格 **193/256（75.4%）**：random 明牌 22、maze 明牌 22、arch 明牌 26、arch 迷雾 25、
  med 明牌 31、med 迷雾 31、random 迷雾 18、maze 迷雾 18。
- 默认开启：第 7–13 轮全部层 + `mshape` + `mhalf`（`ARM_RING=10`）+ 三 Tick 复利搜索
  （`M3PLY`，`CUT=1.5`）+ 几何门控后方主城（`BANKGATE`，明牌，`HOP=1`）+ 沼泽迷雾后方主城
  （`FOGBANK`，迷雾，岛屿 `SHALLOW=55`）+ 走廊层（`MAZERUSH`）+ 草地迷雾补环（`FOGRASS`）。

## 唯一未达标项：Relay 多线 2 格（都是 18/32，目标每格 21/32）

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

已找到并启用六条**有偏**的策略：三 Tick 精确搜索（明牌）、几何门控后方主城（明牌）、沼泽迷雾
后方主城（迷雾）、岛屿浅层取兵、走廊层、草地迷雾补环。第 19 轮的实测见
[ROUND19-ROUNDUP.md](ROUND19-ROUNDUP.md)，第 20 轮见 [ROUND20-ROUNDUP.md](ROUND20-ROUNDUP.md)。

剩下的两格都是「迷雾 + 多线」：`random` 迷雾（草地盲局）与 `maze` 迷雾（走廊盲局），各差 3 胜。
已知的约束：迷雾下对手棋盘不可观测，所以整批指令预测（搜索的 4.9pp 偏置来源）完全失效；草地局
后本金库实测亏本（后方军队是管道）；走廊局的胜负由 t100 的 Voronoi 分割决定（几何），而前沿吞吐
被「一条通道每两 Tick 一兵」限死。第 20 轮的轴映射显示：迷雾多线的每一个既有旋钮在这两格上都是
惰性的，下一步需要的是机制（而不是调参），例如在迷雾里维持一份对手前沿的信念清单并据此定价
（`mfogsearch` 的鲁棒计划集只差 1 局），或把走廊的「一兵不能推」用多路灌兵在迷雾里补上。

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
