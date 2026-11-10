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

## 官方尺寸基线（2026-11-09 起）

评测默认尺寸改为官服实际可达的两档：

- `standard`：`0.34`（1v1 普通房）
- `large`：`0.34 + 0.68`（普通房 + 大图房）
- 不再使用 `1.0`；官服无法创建，且它主导了旧基线的平局。大地图统一用 2400 Tick；1200 Tick 的平局只表示未决。

当前代码（`517a759` 后）64 局 seeds 4：

| 对手 | 总计 | 0.34 | 0.68 |
| --- | --- | --- | --- |
| anti | 31W / 13D / 20L | 21W / 0D / 11L | 10W / 13D / 9L |
| apex | 39W / 3D / 22L | 19W / 0D / 13L | 20W / 3D / 9L |

命令：

```sh
node training/long-eval.cjs --profile large --seeds 4 --workers 10 \n  --turns 2400 --opponents anti --seat both
```

以下旧记录保留作历史对照，尺寸/回合数按当时标注理解。

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

### 2026-11-09：独立 offset 6 复核与终局/早期防守实验

- 模式门控第二次独立 holdout（offset 6，48 局）：gated vs stock，anti 11 vs 9 胜、apex 22 vs 21 胜；CI 仍含 0，收益仍只在 random/maze，未门控模式逐局一致。累计 offset 4+6：anti 26 vs 21、apex 43 vs 40，保持 sign-positive / unproven。
- 早期防守 `compactRushHold`（0.5 棋盘、homeReserve≥150、皇冠低于 floor 或敌堆≤3）：16 局目标套件 7→8 胜、早死 4→3，但 96 局 anti 32→29（3 局 arch 0.5 胜→负）、apex 46→47；净负，回退。
- 终局经济让位（turn≥900、敌冠≤2、兵力>1.35x 时 `sustainEconomy` 返回 null）：anti 31 vs 32、apex 46，回退。
- campaign 交付进度刷新（任意 delivery 模式 movedTurn 刷新 `lastProgress`，不再仅 tree）：anti 32（持平，2 局变化），apex 46（mean −0.031），回退。
- 终局诊断：1.0 尺寸非胜主要是 campaign 在 28 Tick gather timeout 处被整体重置（非 tree 交付不刷新进度），以及 `coreBias` 让 bot 跨图打原始敌冠、`desired` 按目标当前兵力每 Tick 抬价。下一步应针对“convoy 存活 + 目标选择”做独立实验，而不是继续改终局阈值。

### 2026-11-09：coreBias 目标选择实验

- `chooseCampaign` 的原始敌冠 `coreBias`（maze 1800 / 普通 450）可缩放，`APEX_CORE_BIAS_SCALE` 默认 1。
- scale 0.25：96 局 seeds 0-3 anti 32 胜（1 局 loss→draw）、apex 47 胜（1 局 draw→win），看似正收益；但独立 offset 4 上 anti 15 持平、apex 20 vs 21（−1），不复现，回退默认 1。
- scale 0：anti 29、apex 39，明显更差，说明原始核心偏向仍有价值；不应直接移除，只能在特定局面下小幅降低。

### 2026-11-09：官服日志与 1200 Tick 上限的偏差

- 官服 4 局大地图日志：`queueResets=0`、`budgetExceeded=0`、`fallbacks=0`，说明网络确认与 80ms 预算不是主因；但 `march` 占 806/894/1633 Tick，`muster-wait` 71/43/282、`supply-hold` 238/296、`emergency-defense-cut` 97/190/354，`campaign-reset` 2/20，`broad-expansion` 仅 22~93；`maxNoActionStreak` 16/37/27。结论：长局是 campaign/muster/防守循环，不是挂机或网络。
- 基线 `--turns 1200` 会把 900~1900 Tick 的败局记为平局，掩盖真实弱点。0.68 尺寸 anti：1200 Tick 为 10W/19D/3L；延长到 2400 Tick 为 **10W/13D/9L**（6 个平局转为失败，无新增胜局）。
- 后续大地图评测应至少用 `--turns 2400`（或 3000）；1200 Tick 的平局只能视为未决，不能当作防守成功。

### 2026-11-09：官服尺寸下的终局目标/突破实验（均拒绝）

- **dominant core bias**：敌冠≥6 且兵力>1.5E 时把原始核心 bias 降到 0.2。完整官方尺寸 2400 Tick 与基线逐局一致（anti 31/14/19、apex 39/3/22）；0.68 单尺寸的 ±1 变化在相同代码重复运行中同样出现，属于 worker 调度噪声。回退。
- **dominant breakthrough**：dominant 时把突破门槛降到 `firstContactNeed+8`。0.68/2400 anti 10/12/10（基线 10/13/9，1 局 draw→loss），apex 20/3/9 持平。回退。
- **long campaign timeout**：gather 时限按剩余冠距最多 +60 Tick。0.68/2400 anti 10/13/9（持平），apex 18/2/12（基线 20/3/9，−2 胜）。回退。
- **测量教训**：8 worker 下 ±1 局会因调度抖动翻转，单尺寸 32 局不足以判定；至少用完整官方尺寸、10 worker、2400 Tick，并优先看同一 run 内的配对结果。

### 2026-11-09：campaign 无冠进展重置（拒绝）

- 在 campaign 连续 `180 Tick` 未减少敌冠时，把当前目标加入 blocked 并清空 campaign，迫使重新选冠或转入扩张（`APEX_CAMPAIGN_NOGAIN` 可调/关闭）。
- 0.68/2400：anti 10/14/8（基线 10/13/9，1 局 loss→draw），apex 20/2/10（基线 20/3/9，1 局 draw→loss）；无净收益，回退。
- 说明 900+ Tick 的 march 并不是“选错目标”这么简单；即使强制换冠也没有提高胜率。下一步需要重写 campaign 执行状态机（进展度量、动作预算与扩张切换），而不是继续加单个超时/阈值。

### 2026-11-09：官服尺寸参数复测（无提升）

- 0.34 / seeds 4 / 2400：基线 anti 21W/0D/11L、apex 19W/0D/13L。全 stock 经济 22/18，`CAMPAIGN_STRENGTH=0.30` 22/19；完整官方尺寸下 stock 29/34、strength 31/35（apex −4），均不采纳。
- 0.34 上 `FORCE_MARGIN`、`BUILD_CLUSTER_SIZE`、`GATHER_TIMEOUT`、`STRIKE_ETA=2` 均无变化或更差。
- burst 窗口强制 `broadExpansion`：0.34 21/19 不变，0.68 anti 10/13/9 不变，回退。
- 结论：官服 0.34/0.68 的胜负对现有单参数已不敏感；继续提升需要重写 campaign 执行状态机（进展度量、动作预算、扩张切换），而不是继续扫参。

### 2026-11-09：常规地图出现 maze 分支的排查（保留启发式）

- 原因：`isMazeBoard` 以“山脉占比 >12%”判断迷宫；官服 random 生成器的目标正是 12%（0.24×0.5），所以约一半常规图被标记为 maze，触发 `maze-opening`/`maze-reroute` 等分支。
- 尝试过的替代：直接用 `room_update.map_mode`（random 即非 maze）、random 阈值提高到 0.18、只关闭 random 的 `mazeOpening`、按最大连通山墙组件识别迷宫。完整官方尺寸 2400 Tick：
  - map_mode 信任：anti 30/14/20、apex 37/3/24；
  - 阈值 0.18：32/13/19、37/3/24；
  - 仅 opening：31/14/19、39/3/22（apex 持平、anti 未增）；
  - 拓扑分类：30/14/20、37/3/24。
- 结论：这些“修正”都没有超过基线 31/13/20、39/3/22；迷宫走廊/滞回逻辑在部分高墙 random 图上实际有益。保留 12% 启发式，不按 map_mode 硬切；若后续重做，需要以胜率为准，而不是分支名称。

### 2026-11-10：早期 rush hold 的可落地兵力门控（`APEX_OPENING_SMALL=1`）

- 0.34 逐局诊断（seeds 4，seeds 做 4 局时序 dump）：24 局失利的共同形态是「地图控制先输」。典型局如 `apex-long-0-archipelago/anti/s0`：t40–t124 在 `cluster-fund` 与 `delayed-rush-guard` 之间逐 Tick 交替，`cluster-fund` 永远凑不满 50 兵，全局 `city=0`；自身领土从 t36 的 30 格冻结在 34 格，对手同期从 33 格铺到 90+ 格。终局形态一致：最后一座皇冠驻军只有 2~30，而 3~8 格外有 44~290 的对手堆，其余兵力仍在 `march`/`muster`。
- 直接消融：`rushProfile=null`（完全关掉 hold）0.34 为 anti 24W、apex 23W（基线 21/19），配对 +10.9pp，说明该 hold 在紧凑棋盘上是净负。
- 保留防守语义的改法：`earlyRushProfile` 只判定“对手在囤兵”，新增 `projectedArrival` 用 `routeArrival` 计算沿最短路线真正能落地的兵力（沿途要付出驻军代价），只有该兵力 ≥ 皇冠连通驻军（`localGuard`）+12 时才进入 hold。仅作用于 `b.size < 800`（0.34 为 221–255 格，0.68 为 891–957 格，按现有大地图阈值切分），默认关闭。
- 结果（10 worker、2400 Tick、seeds 4）：
  - 0.34：anti **23W/0D/9L**（基线 21/0/11）、apex **24W/0D/8L**（基线 19/0/13），合计 **47W/0D/17L = 73.4%**（基线 40W/24L = 62.5%），配对 +10.9pp，CI [-0.031,+0.469]。
  - 完整官方尺寸（0.34+0.68）：anti 33W/14D/17L（基线 31/13/20）、apex 44W/3D/17L（基线 39/3/22）；0.68 分组胜场与基线逐局一致（anti 0.68 出现 1 局 D/L 翻转，同参数重复运行同样出现，属调度抖动）。
  - 0.68 单独复跑：flag on/off 同为 30W/16D/18L（1 局抖动），确认大地图逻辑未被改动。
- seeds 8 复核：combined 后 anti 46.1% vs 43.0%，apex 66.4% vs 57.0%（apex 配对 CI [+0.047,+0.336] 排除 0）；`APEX_OPENING_SMALL` 已默认开启，`=0` 可关闭用于 A/B。
- 已拒绝的相邻想法（同批测试）：终局单皇冠按 arrival 补驻军（0.34 21/18）、首个建设优先于 hold（19/18）、hold 只守皇冠不冻结经济（21/19）、hold 的到达判定改用单格驻军（21/23）。

### 2026-11-10：最后一段（攻击相）状态机与 reseat（部分采纳，默认关）

- 诊断（8 局 0.68 anti，2400 Tick）：campaign 拥有 6592 Tick，`march` 4437（67%）、`muster*` 仅 1045（16%）；一个皇冠 campaign 564 Tick 里 551 Tick 无进展（喂进 13.7k 兵）；convoy 到根需 8–10 Tick。进一步采样（4 局 0.68）显示每局 campaign 重建约 31 次，`march` 的皇冠距离分布 41+ 占 879/1399、11-20 占 87、7-10 占 52、4-6 占 41、0-3 占 30：**循环是「40+ 格长征 → 10~30 Tick 最后一段 → 纵队被打死 → 从头再来」**，泄漏在攻击相而不是集结门控。
- 新增 `bot/lastmile.cjs`（按 campaign 皇冠记账：纵深距离、首敌格需求、无距离/兵力进展的 Tick 数）与 `test/lastmile.test.cjs`，全部由 `APEX_LAST_MILE=1` 开启，默认关（关闭时逐局与基线一致：0.34/32 局 0 差异）。三种设计都在完整官方尺寸（seeds 4、workers 10、2400、双座位、64 局/对手）上测过：
  1. **整段路径 staging/commit**（`APEX_LAST_MILE_TARGET=path`，`mode=full`）：等整条剩余路径付得起才打，`dist<=6` 时只补到该需求。anti **29/16/19**（0.34 20/0/12、0.68 9/16/7），apex **34/5/25**（0.34 17/0/15、0.68 17/5/10）。把败局拖成平局但拖掉了胜局，**拒绝**。
  2. **首敌格 commit + 取消 18 落地门槛**（`mode=full`，默认 `first`）：只要首敌格付得起就开打并锁定连推。修复「近战目标被套用到 40 格长征」的范围错误前 anti 22/17/25，修复后 **29/10/25**（0.34 18/0/14、0.68 11/10/11）。0.34 明显退化（放弃基线依赖的集结体量），**拒绝**。
  3. **仅 reseat**（`mode=reseat`，不限棋盘）：纵队在最后一段死亡/被切时，从最佳前向补给格重新落座（允许 `bestDist+8` 而不是必须更近），不再从 40+ 格重开。anti **32/13/19**（0.34 20/0/12、0.68 12/13/7；成对 +1.6pp，CI [−0.063,+0.141]），apex **38/3/23**（0.34 17/0/15、0.68 21/3/8；成对 −1.6pp，CI [−0.141,+0.063]）：**0.68 两个对手都变好，0.34 两个对手都变差**，整体中性。
  4. **reseat 只在大图生效**（`APEX_LAST_MILE_MIN_BOARD=800`，采纳为 flag 开启后的默认）：0.34 棋盘全图只有两个屏幕，不存在「40+ 格重开」，reseat 只会把根换成更弱的邻格。anti **33/13/18**（0.34 与基线逐局一致 21/0/11，0.68 12/13/7，成对 +6.3pp，CI [+0.000,+0.281]；总体 +3.1pp，CI [+0.000,+0.156]），apex **40/3/21**（0.34 逐局一致 19/0/13，0.68 21/3/8，+3.1pp，CI [−0.063,+0.188]；总体 +1.6pp，CI [−0.031,+0.094]）。
- 结论：**只采纳设计 4**，已默认开启（`APEX_LAST_MILE=0` 可关闭）：两个对手都不退化，0.34 完全不变，收益全在 0.68（anti +2 胜、apex +1 胜），但 CI 下界贴着 0，按 sign-positive / unproven 记录。设计 1/2 留在 flag 后面（`APEX_LAST_MILE_MODE=full`），仅用于复现 A/B。
- 下一步：把账本从「死亡后补救」扩展到「持续推进」——在进攻期就持续把 campaign 根保持在 `bestDist+reseatSlack` 以内的前向补给格（滚动落座），并在 0.68 单尺寸上用 seeds 8 复核，目标是让 CI 离开 0；不要在 0.34 上再调门槛。

### 2026-11-10：大图「皇冠预算锚定土地」相位（`APEX_CROWN_LAND_ANCHOR`，默认开）

- 诊断（官方尺寸 seeds 4、2400 Tick、10 worker，逐局时序）：0.68 上失利的共同形态是**土地在 t300 左右冻结**——bot 从 t150 起 40~50% 的 Tick 花在 `march`（长征），land 卡在 65~95，而 anti 一路铺到 500~750；到 t1200 双方皇冠数接近（bot 21~38、anti 12~30），但 bot 自己每座皇冠要花 100 兵、并且用 `enemyCrowns + 2`（上限 24~36）无限追赶对手的皇冠数，等于把本该用去打穿对手的兵反复铸成皇冠。0.34 没有这个形态（t600 前就结束）。
- 机制：`sustainEconomy` 的目标皇冠数在「自方土地 < 对手土地」时改为 `max(econ.goal, floor(land / 12))`——生产能力只能随实控土地增长，土地追平即恢复原来的 `enemyCrowns + 2` 追赶。只作用于 `random` / `archipelago`（开放铺地图）；`maze`（走廊天然限制对手铺地）与 `mediterranean`（对 Apex 是镜像皇冠竞赛）保持原逻辑。`APEX_CROWN_LAND_ANCHOR=0` 关闭，`APEX_CROWN_LAND_RATIO`（默认 1）与 `APEX_CROWN_LAND_TILES`（默认 12）为 A/B 旋钮。
- 结果（`--profile large --seeds 4 --workers 10 --turns 2400 --seat both`）：
  - anti **37W / 12D / 15L**（基线 35 / 13 / 16；配对 +3.1pp，CI [+0.000,+0.125]）：0.68 由 12W 升到 14W（+6.3pp，CI [+0.000,+0.250]），0.34 逐局完全一致（23W）。收益全在 archipelago（7W/0D/9L → 9W/0D/7L，+12.5pp，CI [+0.000,+0.500]），random/maze/med 逐局不变。变化的 3 局都是「0.68 archipelago：long 0 先手 L→W、long 0 后手 L→W、long 2 先手 D→W」，这些局基线是 8~26 地对 558~738 地，改后早期就打完。
  - apex **45W / 3D / 16L**，与基线逐局完全一致（0 差异）。
- 已拒绝的同批机制：**持续铺地层**（`landPhaseActive`/`landGrowth`，在大图非迷宫、土地落后时每 3 Tick 抢一次中立格，campaign 让位）在机制上有效（同一局 land 79→270、t1200 兵力 7k→30k、对手土地 768→572），但**不转化为胜局**：anti 31W/16D/17L（基线 35/13/16），0.68 12W→8W，把 4 局基线胜局拖成平/负。原因是这些对局在 t600 后已被对手完全包围，中立格已不存在，只能靠打穿敌土；抢 Tick 等于把唯一一次早期收官窗口让掉。`APEX_LAND_PHASE` 相关代码未保留。
- 归因结论：大图 0.68 的胜负在 t600 前就被决定（胜局 t87~498 结束，之后对手皇冠数 20+ 基本无法清空），因此**任何以土地/经济为目标的改动只有在它同时释放早期突击兵力时才有效**；单纯铺地不行。下一步应针对「早期突击吞吐」（一次 Tick 一条指令下的 march 占用）而不是继续加土地层。

### 2026-11-10：城市/经济雪球阶段（`APEX_CITY_SNOWBALL=1`，默认关，采纳）

- 诊断（seeds 4、2400 Tick、0.68 anti，17 局长局）：失败局的共同形态不是「前期兵力领先没换成地盘」，而是**从 t120 起兵力就落后**（t120 702 vs 742、t600 2368 vs 3059、t1200 6369 vs 10971），领地全程落后（t1200 133 vs 448），而主城数基本持平（24 vs 22）。收入口径：对手 22 主城 + 448 地 ≈ 31 兵/Tick，我方 24 + 133 ≈ 27，差距全在地盘；双方都在掉兵（我方 t600→t1200 收入约 22.5/Tick 只净存 6.7），即分差不是产能而是「喂进去的纵队被打死」。
- 引擎事实（`src/game-engine/tick-growth.ts`）：主城 +1/Tick，指挥所与普通地都是 50 Tick +1，**城市不是产能**；城市的真实价值是「50 兵升级成主城（空地要 100）」与「前方连通锚点（断链时保住整片新地不被减半衰减）」。
- 机制（`bot/snowball.cjs` + `bot/planner.cjs` 的 `citySnowball`，全部由 `APEX_CITY_SNOWBALL=1` 开启，默认关且关闭时不进入任何新分支）：大地图（>=800 格）、非迷宫、`turn >= 300`、领地 < 对手 0.8×、兵力 >= 对手 0.55× 时开一个**有界阶段**：
  1. `anchor`：用局部（4 格内）富余兵力 >= 120 的池子在前线建 2 座指挥所并升级为主城（`snowball-foundation`/`snowball-upgrade`/`snowball-fund`）。
  2. `paint`：把阶段 Tick 换成地盘——先抓锚点 6 格内的中性格（离敌 >= 3），再抓对手驻军 <= 12 且我方够两倍薄边格（`snowball-paint`），直到领地追平 / 兵力 < 0.45× / 涂地预算 140 / 跨度 700 Tick。
  - 只在「campaign 已就位但距目标皇冠 > 12 格」的 Tick 上借行动预算，防守、斩杀层、rush hold、最后一段全部排在前面。
- 结果（完整官方尺寸 seeds 4、10 worker、2400 Tick、双座位 64 局/对手；`/tmp/default-anti.json` 35/13/16、`/tmp/default-apex.json` 45/3/16 为基线）：
  - cadence 1（默认）：anti **36W/13D/15L**（0.34 23/0/9 逐局不变，0.68 13/13/6 vs 基线 12/13/7），apex **46W/1D/17L**（0.34 24/0/8 逐局不变，0.68 22/1/9 vs 21/3/8）；`effectiveLosses` anti 28（基线 29）、apex 18（基线 19）。
  - cadence 2：anti 35/14/15、apex 46/2/16；cadence 1 在胜场与有效失败上都更好。
  - 同参数重跑 anti 完整尺寸：**逐局完全一致**（36/13/15），本机不存在调度抖动。
  - 拆分：0.68 anti 从 t600 起领地 114（基线 102）、t900 137（114）、landRatio 0.85（0.75），`cityDelta` 由 -1.78 抬到 -1.29，`armyRatio` t900 2.39（2.20）；0.34 两组逐局不变（入口要求 >= 800 格）。
- 被否定的变体（同尺寸 32 局）：先按「兵力领先 1.15×」入门（0.68 anti 12/12/8，入口在长局里几乎不触发：长局从头到尾没有兵力领先）；禁用敌薄边格抢地（11/15/6，丢掉 1 胜）；涂地预算 400 + 跨度 1400（12/14/6，与 140/700 完全相同 —— 真正的出口是「兵力 < 0.45×」，说明后期抢地会喂掉军团）。
- 结论：与皇冠锚定组合后，默认只作用于 `mediterranean`（`APEX_CITY_SNOWBALL_MODES` 可覆盖），组合结果为 anti 37/12/15、apex 46/1/17，0.34 不变；已默认开启（`APEX_CITY_SNOWBALL=0` 关闭）。变化幅度是 anti +1 胜、apex +1 胜，属于 sign-positive / unproven；机制本身（地盘、landRatio、cityDelta、兵力比）方向明确。下一步：把 `paint` 的后期形态从「抢中性格」换成「守已得地盘」（长局 t1200 后领地 251 → 145 的二次塔陷没有被这个阶段覆盖），再考虑并入默认。

### 2026-11-10：合并后的官方基线（seeds 8）

- 合并 opening 到达门控、last-mile reseat、皇冠预算锚定土地（random/archipelago）与 mediterranean 雪球后，默认跑分：
  - anti **62W / 26D / 40L**（128 局，48.4%）；0.34 42/0/22，0.68 20/26/18。
  - apex **86W / 5D / 37L**（67.2%）；0.34 46/0/18，0.68 40/5/19。
  - 对照原始基线（seeds 8）：anti 55/28/45、apex 73/7/48。
- 分模式（seeds 8）：anti random 9/11/12、med 14/9/9、arch 18/0/14、maze 21/6/5；apex random 25/0/7、med 17/4/11、arch 20/0/12、maze 24/1/7。
- 结论：apex 已接近 70%，anti 的 random/mediterranean 大图仍是主缺口；early tempo 与 mediterranean 专项实验继续进行。

### 2026-11-10：地中海皇冠竞赛层（`APEX_MED_PLAN=1`，默认关）

- 诊断（官方尺寸 seeds 8、`/tmp/final8-apex.json`）：mediterranean 是唯一低于 70% 的地图（17W/4D/11L，胜率 53.1%），0.68 组 7W/4D/5L。败局时序的共同形态是**皇冠经济在中局完全停摆**：`seed apex-long-2-mediterranean` 先手 t700 以 2080 兵/7 皇冠对 2114 兵/14 皇冠打平，t1500 变成 4427/7 对 11278/21；`long-3` 先手 t100 是 5 皇冠对 4，t700 变成 1 对 7。引擎产能是「皇冠 +1/Tick、其他地 50 Tick +1」，7 对 21 就是 10 兵/Tick 的永久赤字，靠地盘或交换都补不回来。
- 原因：`sustainEconomy` 里「campaign 已在敌方核心 24 格内就让位」是大地图常数；0.68 环形房只有约 890 格、其中约 380 是海，整圈子陆地周长不到 30 格，所以纵队从 t300 起永远在 24 格内，bot 从此既不建皇冠也不再回到经济窗口。
- 机制（`bot/medplan.cjs` + `planner.cjs` 两处接线，全部由 `APEX_MED_PLAN=1` 开启）：
  1. `economyYields`：地中海大图把该半径换成 12（`APEX_MED_PLAN_REACH`），只在纵队真的贴身（<= 12 格）时让位。
  2. `crownRaceHold`：`ownCrowns < enemyCrowns + 2` 且兵力未到对手 1.35× 时，皇冠竞赛暂占行动预算（campaign 冻结一 Tick、根节点与集结状态保留）；防守、终结层、最后一段仍在它上面，纵队已贴到 `reach` 内则立刻放开。
  - 距离探针按需构建（`campaignDistance` 传 thunk），只在廉价门控都已通过后才付一次棋盘级 field：早期 eager 版本把 apex 地中海 p95 抬到 43.8ms，惰性版本回落到 36.0ms（同种子基线 41.3ms）。
- 结果（完整官方尺寸、10 worker、2400 Tick、双座位）：
  - seeds 8 apex：**88W/7D/33L**（基线 86/5/37；配对 +2 胜，平均 +0.047，CI [−0.023,+0.125]）。mediterranean **19W/6D/7L**（基线 17/4/11；+6.3pp，CI [−0.094,+0.500]），0.68 组 9W/6D/1L（基线 7/4/5；+12.5pp，CI [−0.125,+0.938]）；random/maze/archipelago 与 0.34 组逐局完全一致。
  - seeds 8 anti：**61W/33D/34L**（基线 62/26/40；配对平均 +0.039，CI [+0.000,+0.078]）。mediterranean 14W/15D/3L（基线 14/9/9，胜率不变，6 局 0.68 败局变平局，终局土地由 2~18 提高到 73~334）；random 组的 −1 胜是同参数重跑抖动（成对 CI 贴 0）。
- 被否定的拆分/变体（mediterranean seeds 8、32 局）：只收半径 17W/2D/13L（比基线更差，两个平局变败局）；只做竞赛占用 17W/6D/9L（把败局拖成平局但拿不到胜局）；「经济先、不冻结 campaign」的 window 变体 12W/10D/10L（且同样付 defense 成本）；占用节奏 2 / 4 分别 18W/6D/8L、19W/3D/10L，均不如每 Tick。
- 已知代价：占用让规划器在僵持局每 Tick 走一遍 `defense`（基线在 campaign 返回后根本不跑），单局对照（`apex-long-1-mediterranean` 0.68 后手）p50 6.95ms → 53.4ms、66% 决策 > 40ms；默认预算 80ms 下会有一部分决策走兜底。这是当前层未解决的问题：下一步应给「占用 Tick 上的防守」一个廉价预检（例如先看皇冠/城市 6 格内是否有敌兵再跑完整 `emergencyDefensiveCut`），或把占用限制在 `defense` 已触发过的 Tick 上，把这一层的延迟降回基线水平后再考虑并入默认。
- 结论：机制方向明确（0.68 地中海 +2 胜、6 局败局移出败局），但成对 CI 仍跨 0，且存在上述延迟代价，因此**保持 `APEX_MED_PLAN` 默认关**，只在实验分支记录。

### 2026-11-10：地中海皇冠竞赛层的释放阈值复核（`APEX_MED_PLAN` 默认开启）

- 上一版把该层留在默认关，理由是「占用 Tick 会多跑一轮 `defense`」。本轮的诊断显示剩下的地中海平局/败局是另一种形态：**中局双方各持 25~30 座皇冠时 `enemyCrowns + 2` 永远达不到**，campaign 被永久冻结到 2400 Tick（例：`apex-long-3-mediterranean` 先手 t1300 为 30 皇冠/246 地/11.5k 兵对 31/238/11.0k，t1400 领地塌到 76）。因此问题不在「占用太多」，而在**释放条件太早**。
- 只改一个旋钮：`crownRaceHold` 的兵力压制释放由 1.35× 放宽到 1.6×（`DEFAULT_DOMINANCE`，`APEX_MED_PLAN_DOMINANCE` 仍可覆盖）。环形房里 1.4× 总兵力是中局常态，不是已定胜负；在那里放开竞赛等于把正在复利的皇冠经济让掉。其余门控（预算达成、纵队贴身 <= `reach`、开局、小图、非地中海）不变。
- 地中海 seeds 8（32 局、0.34+0.68、2400 Tick、双座位、对手 apex）逐档实测（每行一次完整运行，同机噪声 ±2 局）：

  | 配置 | 地中海 | 0.68 |
  | --- | --- | --- |
  | `APEX_MED_PLAN=0`（消融） | 17W / 4D / 11L | 7W / 4D / 5L |
  | `DOMINANCE=1.35`（旧默认） | 21W / 4D / 7L、20W / 5D / 7L、19W / 6D / 7L | 11/4/1、10/5/1、9/6/1 |
  | `DOMINANCE=1.6`（新默认） | **22W / 3D / 7L** | **12W / 3D / 1L** |
  | `DOMINANCE=1.15` | 19W / 7D / 6L | 9W / 7D / 0L |
  | `CROWN_LEAD=1` | 18W / 5D / 9L | 8W / 5D / 3L |
  | `CROWN_LEAD=3` | 21W / 4D / 7L | 11W / 4D / 1L |
  | 产能追平即放开（`ownCrowns + ownLand/50`，试验用 `APEX_MED_PLAN_INCOME`） | 19W / 5D / 8L | 9W / 5D / 2L |

  结论：占用越短越差（lead 1、dominance 1.15、产能追平都更差），所以保留「按皇冠数竞赛」并把压制阈值放宽；`CROWN_LEAD=3` 与 2 等价，保持 2。产能追平方案（`APEX_MED_PLAN_INCOME`）实测为负，代码未保留。
- 完整官方尺寸 seeds 8（10 worker、2400 Tick、双座位，同机同一批次跑消融与候选）：

  | 对手 | 候选（`APEX_MED_PLAN` 默认开） | 消融（`APEX_MED_PLAN=0`） |
  | --- | --- | --- |
  | apex | **90W / 5D / 33L**（70.3%） | 85W / 5D / 38L（66.4%） |
  | anti | **62W / 32D / 34L** | 62W / 24D / 42L |

  按地图（apex 候选/消融）：random 25/24、maze 24/24、archipelago 20/20、mediterranean **21 / 17**（0.68 地中海 12/7，0.34 地中海 10/10）。anti 的地中海胜场两者都是 14（0.68 组 1W/15D/0L 对 1W/6D/9L：9 个败局变平局）；apex 的 random +1 与 anti 的 maze −1 属于同参数重跑抖动（±1~2 局）。
- 代价（未解决，因此单独记录）：占用 Tick 会多跑一整轮 `defense`，基线在 campaign 返回后根本不跑。对 anti 的完整尺寸统计：p50 3.6 → 3.5 ms、p95 **38 → 76 ms**、>40 ms 决策 5676 → 18177、`budgetExceeded` 820 → 7554、兜底 180 → 2806（约 2% 决策）。单局剖析（`apex-long-3-mediterranean` 0.68 后手对 anti）显示占用 Tick 的 `defense` 占决策总耗时 69%。下一步应做「锚点附近有敌堆才跑完整防守」的廉价预检，而不是把占用改稀疏（cadence 2/4 更差）。
- 默认值：`APEX_MED_PLAN` 现在默认开启，`APEX_MED_PLAN=0` 为消融；`test/medplan.test.cjs` 覆盖默认开启、1.6× 释放阈值（含 1.35× 覆盖对比）与逐局不变性。全部 161 个单元测试通过。

### 2026-11-10：迷宫「无建设爆发 + 单波」方案（`APEX_MAZE_BLITZ=1`，默认关，未合并）

- 用户提出的反制战术：爆发期不建设、只铺地；爆发结束后把全军汇成一个 400–600 的超级波，沿迷宫树推进，岔路分一支清支线、清完归队，优先拆建筑，小图希望 60–70 回合结束。
- 实现（`bot/mazeblitz.cjs`，只在 `mapMode === 'maze'` 且 `APEX_MAZE_BLITZ=1` 时接管行动预算，默认关闭时逐局与基线一致）：
  1. `expand`：Tick ≤ 50（引擎爆发窗口 26–50，见 `src/game-engine/tick-growth.ts`）只走 `mazeOpening`/`opening`，从不建设；
  2. `muster`：把棋盘汇到一个发射格，门槛 `max(棋盘地板, 目标守军需求)`，地板按尺寸 340（0.34）/ 520（0.68），需求 = 路径敌军抵抗 ×1.15 + 20 与目标 4 格内敌军 ×1.35 + 20 取大，并封顶 2.5× 地板；另有 `APEX_MAZE_BLITZ_LATEST` 兜底；
  3. `push`：单列沿 `route` 前进，智能分兵（mode 0）优先，离开岔口时刚好留下「其他敌邻之和 −1」的驻军，避免走廊被切断；岔路用 `connectedSet` 判定能否回到敌方锚点，孤立的纯地格支线不派分队（路口在手即可），能回锚点的支线才用半兵（mode 1）分队清除并归队；被切断的孤军先尝试真实连通性验证的「复位连通」再放弃；
  4. 波被打光/放弃后进入 `done`，交回默认迷宫 planner，不空转到超时。
- 结果（seeds 8、双座位、2400 Tick、10 worker；同机 flag-off 基线 `/tmp/maze-base.json`）：

  | 范围 | 基线（flag off） | blitz（flag on） |
  | --- | --- | --- |
  | maze 全部（0.34+0.68，64 局） | 45W / 7D / 12L | 28W / 6D / 30L |
  | 0.34（32 局） | 27W / 0D / 5L | 17W / 0D / 15L |
  | 0.68（32 局） | 18W / 7D / 7L | 11W / 6D / 15L |
  | vs anti（32 局） | 21W / 6D / 5L | 14W / 6D / 12L |
  | vs apex（32 局） | 24W / 1D / 7L | 14W / 0D / 18L |

- 结论：**负收益，未合并、默认关闭**。赢的局确实是用户描述的形态（106 / 94 / 89 / 148 / 175 Tick 一波推平，0.34 与 0.68 都有；`apex-long-1-maze` 在 0.34/0.68、两个对手、两个座位共 8 局里赢 7 局），但输的局集中在同一个引擎机制：迷宫走廊上的 1 兵尾巴被对手一支大堆反推即整列「孤军」——`chkMove` 拒绝孤军移动，且断链瞬间整列减半，超级波当场冻结。`frozen` 计数显示 30 个败局里 18 个发生过冻结（0.34 的 15 个败局里 12 个）；另有 10 个败局根本没发射（0.68 长走廊抵抗估算过大，门槛已封顶 2.5× 地板后仍不够）。要把它转正需要「走廊滚动驻军/沿线锚点」或选择避开敌方大堆邻格的路线，不是再调阈值。
- 旋钮：`APEX_MAZE_BLITZ_OPENING`（默认 50）、`APEX_MAZE_BLITZ_FLOOR_SMALL/LARGE`（340/520）、`APEX_MAZE_BLITZ_MARGIN`（1.15）、`APEX_MAZE_BLITZ_GATE_CAP`（2.5）、`APEX_MAZE_BLITZ_LATEST`（170）、`APEX_MAZE_BLITZ_BRANCH_SHARE`（0.55）、`APEX_MAZE_BLITZ_JUNCTION`（12）、`APEX_MAZE_BLITZ_DEBUG=1` 输出波状态。单元测试见 `test/mazeblitz.test.cjs`（无建设窗口、发射门槛、孤立支线跳过、分队上限、敌方守军口径）。

### 2026-11-11：迷宫 blitz 校正（半兵路口推进 + 前向集结 + 立即发射，`APEX_MAZE_BLITZ` 仍默认关）

- 回放复核指出三处错误：智能分兵（mode 0）在主路路口只留下「其他敌邻之和」的象征驻军（486 的波留 4、518 的波留 1），对手两步就能切断；发射点落在纵深后方，把前方兵力往回抽（t30–38 来回走同一段走廊）；0.68 上 759 的波已经成型，却因「路径抵抗估算」的发射门迟迟不发（0.68 同一局到 1340 Tick 才输）。
- 机制：
  1. 主路路口只用半兵（mode 1），连续最多 3 次（`APEX_MAZE_BLITZ_HALF_PUSHES`，默认 3），即 1/2 + 1/4 + 1/8 = 7/8 前压、1/8 留下守路口，不再尝试 mode 0。整推（mode 2）只在「除目标格以外没有敌方邻格」时允许（尾部 1 兵不可能被切）。侧支线仍有界：能真实回连才派分队，分队本身也走半兵。
  2. 集结格改为前向：从目标皇冠向外按 2 格带扫描，取第一个真正有兵（>1）的带内的最大堆；已深入前方的堆优先，后方大堆向前汇入，而不是把前方拉回。断链/被清后的波根重选同样用前向筛选（`forwardStack`），货流沿用同一根，避免重复走同一段。
  3. 发射门槛改为「波 ≥ 棋盘地板（0.34 340 / 0.68 520）+ 有可达路径」；路径抵抗估算只作为集结目标（仍封顶 2.5× 地板）。唯一否决项是「本方皇冠可被一次整推拿走」的暴露检查（`homeCrownExposed`）。
- 结果（用户点名的三局，单种子单 worker，2400 Tick，flag on；先在同一代码上复现旧结果，再跑校正版）：

  | 局（种子 / 尺寸 / 对手 / 座位） | 旧 | 校正后 |
  | --- | --- | --- |
  | `apex-long-1-maze` 0.34 anti seat 0 | W 106 | **W 91** |
  | `apex-long-0-maze` 0.34 anti seat 0 | L 218 | **W 99** |
  | `apex-long-3-maze` 0.68 anti seat 0 | L 1340 | **W 945** |

- maze 全量（seeds 8、0.34+0.68、双座位、anti+apex、2400 Tick、8 worker）：**46W / 4D / 14L**（旧 blitz 29W/8D/27L；flag-off 基线 45W/7D/12L）。0.34 25W/0D/7L（旧 17/0/15）、0.68 21W/4D/7L（旧 11/6/15）；vs anti 23W/4D/5L（旧 14/6/12）、vs apex 23W/0D/9L（旧 14/0/18）。
- 单测 `test/mazeblitz.test.cjs` 新增：路口连续三次半兵（mode 从不为 0，路口驻军 ≥ 1/8，三次后波头前移，只有安全格才允许整推）；前向集结（发射格取前方的 21 而非纵深的 253，深层向前走且根不反复改选）；759 波在 `need` 远大于波时仍发射；皇冠暴露时否决发射。bot-2.0 全部 172 项单测与 `pnpm run test:bot` 通过。
- 结论：仍是默认关的实验层（`APEX_MAZE_BLITZ=1` 开启），flag off 逐局不变；本轮未合并到 main。

## 后续对比约定

1. 默认使用 `--profile large`（0.34+0.68）与 `--turns 2400`；1.0 地图不再参与基线；
2. 优先看 `effectiveLosses`（平局即失败）与尺寸组胜率，避免“拖平”掩盖退化；
3. 策略改动后同时重跑单元测试与回放回归（`test/replay-regression.test.cjs`）；
4. 结果 JSON 不提交仓库，只把汇总与异常写入本文件或 PR 说明。
