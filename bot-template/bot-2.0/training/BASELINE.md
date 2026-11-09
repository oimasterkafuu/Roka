# Bot(2.0) 基线

本文件记录模板复制自 `bot-template/apex-bot` 后、尚未做任何策略改动时的基线，供后续 1v1 优化对比。
评测固定使用 Apex 的种子命名空间（`apex-benchmark` / `apex-long`），因此相同参数下的地图与 Apex 一致，可直接横向比较。

## 环境

- 仓库提交：`bd79054`（main，v2.1.16）
- Node：`v26.8.1`
- 平台：Windows（Git Bash）
- 评测引擎：直接加载仓库当前 `src/game-engine.ts`

## 单元测试

```sh
cd bot-template/bot-2.0
node --test test/*.test.cjs
```

结果：`58` 个测试全部通过，`0` 失败，耗时约 `1.7s`。

## 标准基准（四地图 / 1 种子 / 600 Tick）

```sh
cd bot-template/bot-2.0
node training/benchmark.cjs --output /tmp/bot2-baseline-benchmark.json
```

- 对局：8（4 地图 × 先后手），对手 `anti`
- 结果：`0` 胜 / `8` 平；未结束对局按 `effectiveLosses` 计，故 `0%` 胜率
- 决策延迟（本方）：p50 `1.70ms`，p95 `8.81ms`，max `61.8ms`；超时 `1`
- 墙钟：`8.5s`（8 worker 并行）

按地图：random / maze / archipelago / mediterranean 各 2 平。

## 大地图回归（0.5 与 0.68、1 三档 / 1200 Tick）

```sh
cd bot-template/bot-2.0
node training/long-eval.cjs --profile large --seeds 1 --workers 8 \
  --turns 1200 --opponents anti --seat both -q \
  --output /tmp/bot2-baseline-large.json
```

- 对局：24（4 地图 × 3 尺寸 × 先后手）
- 结果：`7` 胜 / `17` 负（其中 `12` 平按负计），胜率 `29.2%`
- 胜局平均 `360.7` Tick
- 决策延迟（本方）：p50 `3.47ms`，p95 `44.7ms`，max `179.9ms`；超时 `1281`
- 墙钟：`77.0s`

按地图：random 2/6、maze 2/6、archipelago 2/6、mediterranean 1/6。
按尺寸组：standard（0.5）5/8，large（0.68、1）2/16。

## 迭代记录

### 2026-11-08：基础设施 + 终结层

- 新增 `bot/duel/killpath.cjs` / `race.cjs`（反向 need 搜索、成长/ETA、孤军与割点风险）与 `training/compare.cjs`（配对 bootstrap）。
- 新增 `bot/deadline.cjs`（默认 80ms + 合法兜底）；12 worker 大地图下出现约 250 次超预算/14 次兜底，但 24 局结果与基线完全一致（7/13/4）。
- 终结层实测（`--profile large --seeds 1/2 --turns 1200 --opponents anti --seat both`，12 worker）：
  - `maxEta: 4`：seeds 1 为 6 胜（基线 7），出现 3 局结果变化，回退；
  - 仅最后皇冠（`decapOnly`，`maxEta: 4`）：7 胜，2 次触发，无变化；
  - `maxEta: 2`：6 胜；
  - `maxEta: 1`（本 Tick 可斩杀）：seeds 1 为 **9 胜 / 15 负 / 12 平**，seeds 2 为 **16 胜 / 32 负 / 25 平**（基线 14/34/27）；默认 80ms 下同为 9/16 胜。
- 结论：终结层只做“本 Tick 立即斩杀”，不接管多 Tick 走廊；默认 `maxEta: 1`，并用相邻皇冠的 O(N·4) 预检避免每 Tick 跑完整搜索。
- 样本仍小（24/48 局），配对 CI 含 0；后续改动继续用 seeds 2 以上的配对报告验证。

### 2026-11-09：1v1 经济参数 + 原版 Apex 交叉测试

- 在固定 seeds 2 大地图（48 局）上扫描 Apex 经济参数：`APEX_ECON_DEADLINE` 90 -> 45、`APEX_ECON_GOAL` 6 -> 10 后，对 anti 胜场 16 -> 18。
- 交叉测试原版 `bot-template/apex-bot`（新增 `--opponents apex`）：同一 48 局，stock 参数 17 胜，新默认 21 胜，说明提升不依赖 anti 对手。
- 默认值已写入 `bot/planner.cjs`；环境变量仍可覆盖（`APEX_ECON_GOAL`/`APEX_ECON_DEADLINE`）。

### 2026-11-09：连通性驻军、参数复测与宏计划门控

- `treeGather`/`advanceSupplyTree` 在敌方 2 Tick 可达的己方割点上保留 `threat + 2` 驻军；48 局确定性 anti 对局结果与改动前完全一致（18/30/27），作为连通性安全修复保留。
- campaign 参数（gather/attack timeout、rebase、strength、readiness、cluster、force margin、multi-crown cap）逐个扫描：无任何值超过默认；唯一进入 48 局验证的 `REBASE_AFTER=10` 对 anti 和 Apex 均 −2 胜，全部拒绝。
- 经济参数复测：`8/45` 与 `10/45` 相同，`12/45` 更差，`DEADLINE 40/50` 更差；维持 `10/45`。
- 宏计划分类器 `bot/duel/plan.cjs` 已合入（纯函数，未接线）；把 `classifyPlan().kind === 'defend'` 提前接到 `defense` 的 A/B 门控在 48 局 anti 上胜场不变，但 2 局 draw→loss 且墙钟约翻倍，已回退，不作为默认。
- 原版 Apex 交叉测试 96 局（seeds 4，10 worker）：tuned 10/45 为 41 胜，stock 6/90 为 37 胜；方向一致但配对 CI 含 0，继续标记为 provisional，后续重大改动前跑 seeds 8。
- anti 96 局（seeds 4，10 worker）：tuned 29 胜 / 58 平 / 9 负，stock 27 / 52 / 17；配对 +2 胜、CI 含 0，0.68 尺寸明显更好（11 vs 7 胜），0.5 持平、1.0 略差，因此与 Apex 结果一致但仍不能称为已验证。

### 2026-11-09：按地图模式门控经济档

- 观察：seeds 4 的 96 局中，tuned 10/45 在 random/maze 上是正收益，在 archipelago/mediterranean 上是负收益。`room_update.map_mode` 已可用，因此按模式选择经济档：random/maze 用 10/45，其余用 stock 6/90。
- 96 局 seeds 4（10 worker，默认 80ms）：
  - anti：gated **32 胜 / 54 平 / 10 负**；tuned 29 / 58 / 9；stock 27 / 52 / 17。
  - apex：gated **46 胜 / 50 负 / 25 平**；tuned 41 / 55 / 25；stock 37 / 59 / 27。
  - gated vs stock 配对：anti +5.2pp（CI [+0.021,+0.250]），apex +9.4pp（CI [+0.031,+0.313]），均不含 0；gated vs tuned 同向但 CI 含 0。
- `APEX_ECON_MODE_GATE=0` 可恢复“所有模式都用 tuned”用于 A/B；模式未知时回退 random。
- 独立 holdout（offset 4，48 局）：gated vs stock，anti 15 vs 12 胜、apex 21 vs 19 胜；tuned-everywhere apex 20 胜。配对 CI 仍含 0，但方向在 anti/apex 都为正，且收益集中在 random/maze 与 0.5 尺寸；gated 模式在 archipelago/mediterranean 与 stock 逐局一致，未见过拟合信号。结论：保持模式门控，仍标记 sign-positive / unproven，继续用独立 offset 累积证据。

### 2026-11-09：96 局失败归因与三个针对性实验

- 失败集中在 1.0 尺寸的 1200 Tick 未结束局（anti 30/32、apex 22/32 非胜），其中多局是 1.5~5 倍兵力领先但只拿到 1~2 座敌冠；0.5 尺寸对 apex 有 9 局 <200 Tick 的早期死亡（arch/med）。
- H1 提高终局冠数上限（`FINISH_LEAD_CAP=12`，ratio 1.6/2.5/3.0）与单独提高 `DECISIVE_CROWN_CAP=12`：96 局 anti 最好 31 胜，低于基线 32，回退。
- H2 在 26–50 爆发期、领地落后 30% 时暂停首个经济窗：anti 逐局不变，apex 45 vs 46，回退。
- H3 把 `frontierStrike` 从 `cut` intent 改为 `front` 以启用 arrive/pressure 守卫：anti 29 胜，回退。
- 结论：三个“从失败样本直接推导”的改动都未转化为胜场；当前保留模式门控经济档（32/96 anti、46/96 apex）与 eta1 斩杀层。下一步应优先做独立 seeds 6-7 的模式档确认，或重新设计终局目标选择（而不是只放宽上限）。

## 后续对比约定

1. 保持 `--seeds`、`--turns`、`--profile`、`--seat`、`--opponents` 与本文一致；
2. 优先看 `effectiveLosses`（平局即失败）与尺寸组胜率，避免“拖平”掩盖退化；
3. 策略改动后同时重跑单元测试与回放回归（`test/replay-regression.test.cjs`）；
4. 结果 JSON 不提交仓库，只把汇总与异常写入本文件或 PR 说明。
