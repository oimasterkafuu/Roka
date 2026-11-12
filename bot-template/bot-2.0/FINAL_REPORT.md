# Bot(2.0) 最终报告

## 结论

Bot(2.0) 是基于 Apex 的 1v1 策略模板，在官服普通房（0.34）和大图房（0.68）上完成了一轮以“可解释、可消融、按相位接管”为原则的强化。最终 seeds 8 基线为：

- 对 **anti**：65W / 32D / 31L，胜率 **50.8%**
- 对 **apex**：90W / 5D / 33L，胜率 **70.3%**
- 合计：155W / 37D / 64L，胜率 **60.5%**

胜率按 `W / (W + D + L)` 计算，**平局按负计**；表中的 `L` 是实际结束的负局，`D` 单独列出，便于区分“被杀”和“未决”。

## 评测设置

| 项目 | 值 |
| --- | --- |
| 评测代码 | `4a87a7e`（行为代码；最终文档/版本提交不改变逻辑） |
| 对手 | `anti`（Anti_Human）、`apex`（原版 apex-bot） |
| 地图模式 | random、maze、archipelago、mediterranean |
| 地图尺寸 | 0.34（221–255 格）、0.68（891–957 格） |
| 回合上限 | 2400 Tick |
| 种子 | 8 个 / 地图 / 尺寸 / 对手，双座位 |
| 每格对局 | 16（8 seeds × 2 seats） |
| 并行 | 10 worker |
| 迷雾 | 关闭（官服基线） |
| 汇总数据 | [`training/final-baseline.json`](training/final-baseline.json) |

## 四维基线

### vs anti

| 地图 | 0.34 W/D/L | 0.34 胜率 | 0.68 W/D/L | 0.68 胜率 |
| --- | ---: | ---: | ---: | ---: |
| random | 8 / 0 / 8 | 50.0% | 3 / 11 / 2 | 18.8% |
| maze | 14 / 0 / 2 | 87.5% | 7 / 6 / 3 | 43.8% |
| archipelago | 10 / 0 / 6 | 62.5% | 9 / 0 / 7 | 56.3% |
| mediterranean | 13 / 0 / 3 | 81.3% | 1 / 15 / 0 | 6.3% |
| **合计** | **45 / 0 / 19** | **70.3%** | **20 / 32 / 12** | **31.3%** |

### vs apex

| 地图 | 0.34 W/D/L | 0.34 胜率 | 0.68 W/D/L | 0.68 胜率 |
| --- | ---: | ---: | ---: | ---: |
| random | 14 / 0 / 2 | 87.5% | 11 / 0 / 5 | 68.8% |
| maze | 12 / 0 / 4 | 75.0% | 12 / 1 / 3 | 75.0% |
| archipelago | 10 / 0 / 6 | 62.5% | 10 / 0 / 6 | 62.5% |
| mediterranean | 10 / 0 / 6 | 62.5% | 11 / 4 / 1 | 68.8% |
| **合计** | **46 / 0 / 18** | **71.9%** | **44 / 5 / 15** | **68.8%** |

### 总计

| 对手 | 对局 | W / D / L | 有效负（D+L） | 胜率 |
| --- | ---: | ---: | ---: | ---: |
| anti | 128 | 65 / 32 / 31 | 63 | **50.8%** |
| apex | 128 | 90 / 5 / 33 | 38 | **70.3%** |
| 合计 | 256 | 155 / 37 / 64 | 101 | **60.5%** |

## 特性

### 决策与执行

- **单 Tick 斩杀层**：`bot/duel/killpath.cjs` 做反向 need 搜索，`race.cjs` 比较双方斩杀 ETA；`strike.cjs` 只在 `eta <= 1` 且不会先被斩杀时执行路线首步，并在 `preview` 中复核。
- **80ms 决策预算**：`bot/deadline.cjs` 默认 80ms，超时后给出经 `preview` 校验的合法动作；每局统计 `budgetExceeded` / `fallbacks` / `lastDecisionMs`。
- **动作确认宽限**：官服 RTT 下允许一帧确认宽限，连续两帧未确认才清队列重发，避免动作被反复取消。

### 1v1 相位

- **紧凑图开局**：`APEX_OPENING_SMALL` 用 `projectedArrival` 计算对手沿最短路线真正能落地的兵力，只在 `<800` 格决定是否进入 rush hold，避免把“家里屯兵”误判成早期威胁。
- **最后一段**：`APEX_LAST_MILE` 的 `reseat` 模式只作用于 `>=800` 格；纵队死亡/被切时从最佳前向补给格重新落座，避免回到 40+ 格重开。`mode=full` 的 staging/commit 仅保留作 A/B，默认关闭。
- **经济档门控**：random/maze 使用 tuned 10/45，archipelago/mediterranean 使用 stock 6/90；`APEX_ECON_MODE_GATE=0` 可统一。
- **皇冠锚定土地**：`APEX_CROWN_LAND_ANCHOR` 在 random/archipelago、领地落后时把皇冠预算锚定 `floor(land/12)`，避免在窄底子上无限铸冠。
- **地中海城市雪球**：`APEX_CITY_SNOWBALL` 默认只作用于 mediterranean 大图；先建/升前线城市锚点，再把有界 Tick 换成地盘。
- **地中海皇冠竞赛**：`APEX_MED_PLAN` 把“已在核心打击范围”的半径从 24 收到 12，并在皇冠预算未达成且兵力未压制时让皇冠竞赛暂占行动预算；默认 `dominance=1.6`。
- **紧凑图皇冠竞赛**：`APEX_SMALL_CROWN_RACE` 在 `<800` 非迷宫、皇冠/收入落后且攻击 40 Tick 未转化时进入有界竞赛，追平或跨度用尽即退出。
- **可选迷宫爆发**：`bot/mazeblitz.cjs` 默认关闭，`APEX_MAZE_BLITZ=1` 才启用；它针对 swarm 风格有门控，不参与默认基线。

## 改进过程概要

起点是 Apex 的完整策略克隆。早期 seeds 8 官方尺寸基线为 anti **55W/28D/45L（43.0%）**、apex **73W/7D/48L（57.0%）**。主要增量来自：

1. **终结与工程基线**：killpath/race/strike、80ms 预算、动作确认宽限、经济档按地图门控。
2. **开局与最后一段**：紧凑图 arrival gate 与大地图 last-mile reseat；两项合并后 anti 62W/26D/40L、apex 86W/5D/37L。
3. **经济相位**：皇冠土地锚定、mediterranean 雪球、mediterranean 皇冠竞赛、紧凑图皇冠竞赛；最终 anti 65W/32D/31L、apex 90W/5D/33L。

相对起点，anti +7.8pp、apex +13.3pp。单层收益多为 sign-positive / unproven，最终表格是唯一权威口径。

已实现但**不合并**的方向：

- campaign 预算/多线/切割类局部规则：完整官方尺寸上反复持平或负收益。
- 用 anti policy 整体替换：对 anti 是纯镜像，0W/32D；参数搜索 224 局 0 胜。
- 单纯扩大土地/前线的架构：土地曲线上升，但无法转化为击杀；加入 force diversion 也不翻盘。
- 人类回放中的 full-game line advance：能赢土地，但 1 皇冠/0 建造无法支撑皇冠经济，anti 45→37W、apex 46→35W。

这些实验分支已清理，保留的只是最终代码、测试、评测工具和本报告。

## 已知限制

- 最大缺口是 **0.68 vs anti：20W/32D/12L（31.3%）**；其中 random 18.8%、mediterranean 6.3%。这是当前版本的明确上限，不应把总胜率 50.8% 误读为大地图已经解决。
- 37 局平局按负计；2400 Tick 的平局表示未击杀，而不是防守成功。
- 本机 10 worker 下存在 ±1 局的调度噪声；跨版本比较应使用 `training/compare.cjs` 的配对 bootstrap，而不是只比总数。
- 评测使用官服可达的 0.34/0.68 尺寸、`fog=false`；迷雾和组队模式不在本报告结论内。
- 迷宫判定仍使用 12% 山比例启发式（官服 random 的目标山比例也接近 12%），这是已测过的折中，不按 `map_mode` 硬切。

## 复现

```sh
cd bot-template/bot-2.0
pnpm install
node --test test/*.test.cjs
node training/long-eval.cjs --profile large --seeds 8 --workers 10 \
  --turns 2400 --opponents anti,apex --seat both -q \
  --output /tmp/roka-final-baseline.json
```

根目录提交前检查：

```sh
pnpm run lint
pnpm run build
pnpm run format
```
