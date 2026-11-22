# Bot(3.0)

Bot(3.0) 以 [`relay-bot`](../relay-bot/) 为基础框架，参考 [`bot-2.0`](../bot-2.0/) 的 1v1 结构，目标是在官方小图（1v1 标准尺寸，`0.34`）上继续提升对 Apex、Anti-Human、Bot(2.0) 与 Relay 的实战胜率。当前首个提交是 Relay 2.16.0 策略的完整副本，作为后续改动的基线；策略代码尚未针对小图做行为修改。

## 基线（2026-11-22）

对手为 Apex / Anti-Human / Bot(2.0) / Relay，官方小图，随机、迷宫、群岛、地中海四种地图，迷雾开/关、多线开/关，每格 32 局（16 个种子 × 双方换边），每局上限 1000 Tick，共 2048 局。胜 = 对手先被淘汰，负 = 自己先被淘汰，超时 = 到达 1000 Tick 时双方仍存活。

| 对手       | 局数 |   胜 |  负 | 超时 |  胜率 |
| ---------- | ---: | ---: | --: | ---: | ----: |
| Apex       |  512 |  436 |  49 |   27 | 85.2% |
| Anti-Human |  512 |  390 |  75 |   47 | 76.2% |
| Bot(2.0)   |  512 |  425 |  61 |   26 | 83.0% |
| Relay      |  512 |  239 | 239 |   34 | 46.7% |
| 合计       | 2048 | 1490 | 424 |  134 | 72.8% |

| 地图   | 局数 |  胜 |  负 | 超时 |  胜率 |
| ------ | ---: | --: | --: | ---: | ----: |
| 随机   |  512 | 353 | 118 |   41 | 68.9% |
| 迷宫   |  512 | 381 |  93 |   38 | 74.4% |
| 群岛   |  512 | 384 | 117 |   11 | 75.0% |
| 地中海 |  512 | 372 |  96 |   44 | 72.7% |

| 模式        | 局数 |  胜 |  负 | 超时 |  胜率 |
| ----------- | ---: | --: | --: | ---: | ----: |
| 全图 / 单线 |  512 | 290 | 165 |   57 | 56.6% |
| 全图 / 多线 |  512 | 441 |  69 |    2 | 86.1% |
| 迷雾 / 单线 |  512 | 313 | 126 |   73 | 61.1% |
| 迷雾 / 多线 |  512 | 446 |  64 |    2 | 87.1% |

Relay 对照是相同策略的镜像局，因此合计接近 50%，只用于检查换边与引擎对称性，不代表强弱。非镜像对手的短板集中在随机与地中海的全图单线，以及 Anti-Human 的随机单线（8/15/9，25.0%）。完整 64 格逐项数据见 [BASELINE.md](BASELINE.md)，原始逐局记录见 [baseline-results.jsonl](baseline-results.jsonl) 与 [baseline-summary.json](baseline-summary.json)。

## 结构

- `strategy.js`：托管/CLI 共用入口，维护座位、队列序号、帧同步与心跳。
- `planner.js`：逐 Tick 决策；处理扩张、建造、战役、救援与迷雾记忆。
- `opening.js`：前 24 Tick 的等待、汇兵与并行扩张规划。
- `single-front.js`：单线对手评估、补给切断、围城与集结路线。
- `kill.js`：终结层（默认关闭）；精确需求场、逐 Tick 复算的斩杀路线、竞速与切断校验。
- `bot3.test.cjs`：短局穷举、峡谷与协议回归。
- `index.js`：独立运行的 CLI。

## 终结层实验（默认关闭）

`kill.js` 移植了 Bot(2.0) 斩杀层「证明本 Tick / 短 ETA 可斩杀且不会先被斩杀」的思路，但没有照搬 Apex 的图搜索：

- 反向需求场：从所有可见敌方王冠多源 Dijkstra，`need[目标] = 驻军 + 1`，己方锚点按 `need - (army - 1)` 递减、敌方格按 `need + 驻军 + 1` 递增；一次搜索覆盖全部王冠。
- 逐 Tick 复算：每 Tick 只发射最佳路线的第一步，并按 `present - 1` 的全推模型正向重算，防守方增长按到达 Tick 计入（对进攻方保守），所以路线被堵就自然停止发射，不会沿旧计划行军。
- 竞速：仅当目标是敌方最后一冠时，反手用同一搜索估计对手斩杀我方王冠的最短 ETA，要求 `我方 ETA + margin <= 对方 ETA`。
- 切断与增援：路线上的己方割点若在到达前被敌方威胁击穿则否决；目标格还必须吃得下 `threat`（四步内敌方可达兵力的衰减值）的增援。
- 迷雾下只允许攻击可见王冠、只走可见格，绝不按记忆中的空驻军规划。

开关与参数：

| 变量 | 默认 | 含义 |
| --- | ---: | --- |
| `BOT3_FINISH` | 关闭 | 设为 `1` 启用；也可在板上用 `board.finish = true/false` 单独开关 |
| `BOT3_FINISH_ETA` | 2 | 路线 Tick 上限 |
| `BOT3_FINISH_SURPLUS` | 60 | 非斩首路线需要留在目标冠上的富余兵力 |
| `BOT3_FINISH_DECAP_SURPLUS` | 1 | 斩首路线的最低富余兵力 |
| `BOT3_FINISH_MARGIN` | 1 | 斩首时要求的先手 Tick |
| `BOT3_FINISH_TURN` | 45 | 最早生效 Tick |

### 实测结论（配对比较，均对 `baseline-results.jsonl`）

| 配置 | 规模 | Δ胜率 |
| --- | --- | ---: |
| 默认（ETA 7 / 富余 25） | 2 种子全矩阵 256 局 | +0.4pp |
| 默认，仅 relay+anti | 4 种子 256 局 | −0.8pp |
| `MARGIN=0`（允许同速对杀） | 4 种子 256 局 | −1.2pp |
| `SURPLUS=1, ETA=10`（激进） | 4 种子 256 局 | −1.6pp |
| 仅斩首（ETA 7） | 4 种子 256 局 | 0.0pp |
| 仅斩首（ETA 7） | 8 种子 512 局 | −0.4pp |
| `ETA=2, SURPLUS=25` | anti 单线三格 16 种子 96 局 | −1.0pp |
| `ETA=2, SURPLUS=60` | anti 单线三格 16 种子 96 局 | 0.0pp |
| `ETA=4` / `ETA=7` 仅斩首 | anti 单线三格 16 种子 96 局 | −4.2pp / −5.2pp |
| `ETA=7, SURPLUS=25` | anti 单线三格 16 种子 96 局 | −8.3pp |

- 越长、越激进的斩杀路线越差：relay 的启发式已经覆盖相邻与围城窗口，而 3 Tick 以上的「可证明」路线会被对手增援、割断补给或反向偷冠惩罚（与 Bot(2.0) 测到的 `maxEta:1` 结论一致）。
- 16 个 Relay 镜像格在**所有**配置下都是 0.0pp：对称局面里双方斩杀 ETA 相同，竞速校验必然否决，层无法制造系统性优势；`MARGIN=0` 只是让双方互相偷冠，净收益为零。
- 因此交付形态是「能力 + 开关 + 记录」，默认保持 planner 原路径不变（与基线逐局一致）。若后续要真正提升单线终结，方向应是经济/囤兵政策（例如地中海单线长期囤积上千兵力却不进攻），而不是更长的斩杀路线。

## 运行

```sh
pnpm install
BOT_SERVER=http://127.0.0.1:23333 BOT_ROOM=room BOT_TOKEN=token pnpm start
node --test bot3.test.cjs
```

服务端托管入口为 `require('./strategy').attachStrategy(socket, options)`。目录名 `bot-3.0` 会由 `src/server/server-bot-manager.ts` 自动发现，无需额外注册。

## 评测

先构建真实引擎，再分批运行验收矩阵；每批保持前台运行，结束后合并：

```sh
pnpm run build
SEED_FROM=1 SEED_TO=4 WORKERS=4 OUT=/tmp/bot3-1.jsonl SUMMARY=/tmp/bot3-1.json node scripts/evaluate-bot3-baseline.cjs
SEED_FROM=5 SEED_TO=8 WORKERS=4 OUT=/tmp/bot3-2.jsonl SUMMARY=/tmp/bot3-2.json node scripts/evaluate-bot3-baseline.cjs
SEED_FROM=9 SEED_TO=12 WORKERS=4 OUT=/tmp/bot3-3.jsonl SUMMARY=/tmp/bot3-3.json node scripts/evaluate-bot3-baseline.cjs
SEED_FROM=13 SEED_TO=16 WORKERS=4 OUT=/tmp/bot3-4.jsonl SUMMARY=/tmp/bot3-4.json node scripts/evaluate-bot3-baseline.cjs
node scripts/summarize-bot3-baseline.cjs /tmp/bot3-1.jsonl /tmp/bot3-2.jsonl /tmp/bot3-3.jsonl /tmp/bot3-4.jsonl
pnpm run eval:bot3:compare -- /tmp/bot3-1.jsonl
```

`compare-bot3-baseline.cjs` 按 `(对手, 地图, 迷雾, 多线, 种子, 座位)` 与基线配对，可传入完整结果或两种子快速筛查；对 Relay 每格要求 65%，其余每格要求 50% 且不低于配对基线，未达标时退出码为 1（`NO_GATE=1` 仅报告）。

也可一次性跑完整 16 个种子。`OPPONENTS`、`MAPS`、`MODES`、`TICKS` 与 `SEED_PREFIX` 可覆盖默认值；`MODES` 的三位依次为大小图、迷雾、多线，基线使用 `000,001,010,011`。评测器只加载各对手的公开托管入口，并使用正式引擎的地图、增长、调度与战斗规则。
