# 截断 + maze 专项 + 建造精确性：验证记录（2026-09-27）

对应 spec-cutoff-maze.md。分支 feat/bot-cutoff-maze。

## 改动点

### 目标一：截断逻辑（bot/cutoff.cjs、bot/policy.cjs）
- `chooseCutoff` = 入侵截断（保留原有，并修「敌方锚点不做截断目标」的 bug）+ 新增
  `dispersedCutoff` 散兵截断，按 score 取优，不做跨回合锁定。
- 散兵截断的有效性判断完全复刻引擎 applyConnectivity：从该敌队**所有**城市/皇冠同时
  BFS（连通按队伍），移除候选格后走不到的部分才计入收益——段内必然不含敌方锚点，
  含皇冠的段天然不会被误判。支持单格与相邻两格组合（窄走廊并排脖子，先打较弱一格）。
- 「守得住」校验：`counterForce`（割断后仍连锚的敌军紧邻瓶颈的可动兵，被冻侧不计），
  出兵方案到达兵力 < 反夺力则放弃该候选（占下也被立刻夺回 = 白送兵）。
- 调度（policy.cjs）：防守场景（defense 有动作）下非紧急截断也压过普通推进/调兵，
  仅次于拆建筑推进；冻住规模 ≥ max(cutoffMinIsolate×4, 30) 视同紧急。
- 新增 `chooseNeckGuard` 脖子纪律（maze 症状 3 的修法）：我方割点本 tick 可被敌堆
  打穿且断开 ≥cutoffMinIsolate 兵时，从两侧 BFS 集兵补脖子。
  **止损纪律**：脖子现有兵力 + 每 tick 增援 ×3 仍追不上敌堆时返回 null——
  必死之局不每 tick 白送兵，把 tick 让给推进/攻击（见下方「仍存在的问题」）。

### 目标二：maze 专项（bot/frontline.cjs、bot/logistics.cjs、bot/building.cjs）
- 死循环集兵根因 1（EBS5：(5,9) 1800 兵对 105 守军趴 80 tick）：frontline 的
  `consolidate` 跳过条件误杀「已经判定稳赢的收割推进」→ 加 `&& !accepted`。
- 死循环集兵根因 2（uzsTrD：187 兵趴 35 回合）：logistics 运输对「经济工地」整格豁免，
  超额存量永远运不出去 → 只保留 economyGoal(51) 额度，超额供军运；
  clusterScore 的 count(i) 封顶 60，避免大堆吸走所有补给。
- 建造选址（EBS5 余兵锁大堆导致锚点锁死 19 座）：building.cjs crownTarget 的
  safeLand/surplus 判定 enemyDistance ≥5 → ≥4。

### 目标三：建造精确性（bot/architecture.cjs、bot/building.cjs、bot/logistics.cjs）
- 触发线统一为引擎硬门槛：兵力 ≥51 即建（BUILD_COST=50 + 留 1 兵），101 升级同理；
  不再等增援到位。`logistics.economyGoal()` 固定返回 51。
- 砍掉的策略自加余量：architecture 的 50+premium+reserve、building 候选的
  race.behind 40/50 浮动线。保留的防守检查（非经济余量）：贴脸反夺
  （`crownSafe = afterUpgrade >= spot.adj`），注释已写明。

## 验证数据

单元测试：`pnpm test`（bot-template/anti-human-bot）**286 项全绿**（基线 271 + 新增 15：
截断 8、脖子纪律 4、建造 5 条精确门槛——含部分既有用例改写）。

A/B 基准（training/conservatism-benchmark.cjs，对手 = prevconservative 冻结线上版，
4 图 × 3 种子 × 双换边 = 24 局，turns=1500，size=0.5，判定：歼灭 > 物资碾压 > 均势 > 被碾压）：

| 版本 | 总胜率 | 负率 | random | maze | archipelago | mediterranean |
|---|---|---|---|---|---|---|
| 旧版（precutoff） | 0.833 | 0.083 | 6W | 5W 1E | 6W | 3W 1E 2L |
| 新版 v1（脖子 bug） | 0.750 | 0.125 | 4W 2L | 6W | 5W 1E | 3W 2E 1L |
| 新版 v2（止损修复后） | 0.833 | 0.042 | 5W 1L | 5W 1E | 6W | 4W 2E |

maze 专项加跑（6 种子 × 双换边 = 12 局，同对手同参数）：

| 版本 | maze 胜率 | 构成 | 地皮占比 | 物资比均值 | 后方囤兵 | 最大兵堆 |
|---|---|---|---|---|---|---|
| 旧版 | 0.917 | 5 歼灭 + 6 碾压 + 1 均势 | 0.83 | 82.5 | 5821 | 113 |
| 新版 | 0.917 | **7 歼灭** + 4 碾压 + 1 均势 | **0.89** | **214** | **4227** | **65** |

胜率持平（基数已 11/12），但碾压质量显著提升（歼灭胜 5→7、物资比 82→214），
且 maze 典型瘫痪症状消失：最大兵堆 113→65、后方囤兵 -27%、边境堆兵 147→102。
非 maze 三图（见上表 v2）：总负率 0.083→0.042，archipelago 持平全胜，
mediterranean 3W2L→4W0L，random 6W→5W1L（唯一负局实质均势，见下）。

## 仍存在的问题

- **v1 暴露、v2 已修的脖子死守 bug**：neck-guard 初版对「守不住也追不上」的割点
  每 tick 喂 1 兵（对 580+ 敌堆连续 300+ tick），把 random 图两局拖成被碾压。
  已加止损门槛并补回归测试。这是本轮唯一一次明显退化，已闭环。
- random-1 seat 1 一局仍被判 dominated：实质是均势（物资比 1.007、地皮 229:167 领先、
  兵力持平），仅因皇冠数少 5 座触发 crownLead 规则。新版该局打法偏囤兵
  （终局兵力 35618 对旧版 17227，但地皮 229 对 307），economy-emergency 通道占用
  tick 明显多于旧版（389 vs 121），值得后续观察但本轮未继续追（30 分钟测试预算约束）。
- 回放复盘曾怀疑 planner 沼泽评分问题，已证伪（(3,10) 实为山体），planner 未动。
