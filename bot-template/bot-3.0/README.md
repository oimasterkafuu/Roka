# Bot(3.0)

Bot(3.0) 以 [`relay-bot`](../relay-bot/) 为基础框架，参考 [`bot-2.0`](../bot-2.0/) 的 1v1 结构，目标是在官方小图（1v1 标准尺寸，`0.34`）上继续提升对 Apex、Anti-Human、Bot(2.0) 与 Relay 的实战胜率。首个提交是 Relay 2.16.0 策略的完整副本，作为后续改动的基线。

当前主线已合入迷宫走廊相位、单线收尾纵队、迷雾单线层，并同步上游 relay 的 opening/reinforcement pricing 与多线 burst 移除。最终小图 1v1 基线为 **1621/367/60（79.2%）**；完整矩阵见 [BASELINE.md](BASELINE.md)，暂停时保留的后续方向见 [NEXT.md](NEXT.md)。

## 基线（新引擎，最终）

对手为 Apex / Anti-Human / Bot(2.0) / Relay，官方小图，随机、迷宫、群岛、地中海四种地图，迷雾开/关、多线开/关，每格 32 局（16 个种子 × 双方换边），每局上限 1000 Tick，共 2048 局。胜 = 对手先被淘汰，负 = 自己先被淘汰，超时 = 到达 1000 Tick 时双方仍存活。

引擎为上游 `6821598`（多线 burst 已移除），relay 对手为同步上游后的最新版本。项目初始的 1490/424/134 使用旧引擎与旧 relay，只能作为历史记录，不能与新引擎逐格比较。

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

非 Relay 三对手全部 >=50% 且无负向格；Relay 2/16 格达标（maze FF 单线 65.6%、mediterranean 迷雾单线 68.8%），其余 14 格 43.8%–59.4%。完整 64 格逐项数据见 [BASELINE.md](BASELINE.md)，原始逐局记录见 [baseline-results.jsonl](baseline-results.jsonl) 与 [baseline-summary.json](baseline-summary.json)。

## 结构

- `strategy.js`：托管/CLI 共用入口，维护座位、队列序号、帧同步与心跳。
- `planner.js`：逐 Tick 决策；处理扩张、建造、战役、救援与迷雾记忆。
- `opening.js`：前 24 Tick 的等待、汇兵与并行扩张规划。
- `single-front.js`：单线对手评估、补给切断、围城与集结路线。
- `maze.js`：迷宫（走廊）层：地图判定、集中式前线规划器的推迟启用与可选的走廊换线纪律。
- `closing.js`：小图单线终局的收尾层（见下节），默认开启。
- `kill.js`：可选的单线斩杀层（默认关闭，`BOT3_FINISH=1` 开启）。
- `multi.js`：多线 focus 层（burst 已随上游移除而默认关闭；默认关闭，`BOT3_MULTI=1` 开启，见 [MULTI.md](MULTI.md)）。
- `fog.js`：迷雾单线前线瞄准/柱状推进层（默认开启，`BOT3_FOG=0` 关闭）。
- `fog-multi.js`：迷雾多线 burst 土地竞赛门控（多线 burst 移除后默认关闭，`BOT3_FOG_MULTI=1` 开启，见 [BOT3_FOG.md](BOT3_FOG.md)）。
- `bot3.test.cjs`：短局穷举、峡谷、迷宫判定、收尾层、斩杀层、多线/迷雾层与协议回归。
- `NEXT.md`：暂停时保留的后续重启方向、负结果与复现方式。
- `index.js`：独立运行的 CLI。

## 收尾层（closing）

`closing.js` 只在小图（`<= 800` 格）、单线、对手已铺开至少 6 座主城、我方兵力不低于对手 1.35 倍、且没有主城受威胁时接管计划：停建主城/指挥所与升级，把帝国兵力汇聚到最大的那一股，这股部队在“打穿剩余路径所需兵力”（`required`）足够前原地等待、其余兵力持续汇入，足够后沿主城距离场推进；主城攻击与两 Tick 围城仍保持更高优先级。威胁出现时该阶段自动暂停并交还防御评分（非一次性闩锁）。

- 开关：`BOT3_CLOSING=0` 恢复基线行为（逐局与基线完全一致）。其余可调项：`BOT3_CLOSING_BOARD`、`BOT3_CLOSING_TURN`（默认 60）、`BOT3_CLOSING_CROWNS`、`BOT3_CLOSING_FLOOR`、`BOT3_CLOSING_PUSH`（默认 0=关闭）、`BOT3_CLOSING_PUSH_SCALE`（默认 0.75）。
- 迟速双段：新 relay 在约 110 Tick 就铺开到 6 座主城，旧 120 的启用点整整晚一个阶段；`BOT3_CLOSING_TURN` 降到 60 并用满量矩阵验证零退化。实验开关 `BOT3_CLOSING_PUSH=250 BOT3_CLOSING_PUSH_SCALE=0.75` 会在该 Tick 后让主柱按 `required` 的比例提前投入（把“等凑齐整条路径的兵力”改成“后期按比例压上”），在 16 种子 relay 矩阵上多 1 胜（`relay/random/clear/single` 17 -> 18）且没有任何格子退化，但默认关闭，仍走纯 `required` 门控。
- 迷雾单线不走这一层：planner 只在 `clearSerial` 房间（非多线、非迷雾）调用 `closingUpdate`，迷雾单线由 `fog.js` 的集结-突袭教条负责。
- 新引擎最终 2048 局中，`BOT3_CLOSING_TURN=60` 的收尾层贡献 +6 胜（round6 1615/374/59 → 最终 1621/367/60），逐格零退化；旧引擎的 1490→1519/414/115 仅作历史记录。

## 终结层实验（默认关闭）

`kill.js` 移植了 Bot(2.0) 斩杀层「证明本 Tick / 短 ETA 可斩杀且不会先被斩杀」的思路，但没有照搬 Apex 的图搜索：

- 反向需求场：从所有可见敌方王冠多源 Dijkstra，`need[目标] = 驻军 + 1`，己方锚点按 `need - (army - 1)` 递减、敌方格按 `need + 驻军 + 1` 递增；一次搜索覆盖全部王冠。
- 逐 Tick 复算：每 Tick 只发射最佳路线的第一步，并按 `present - 1` 的全推模型正向重算，防守方增长按到达 Tick 计入（对进攻方保守），所以路线被堵就自然停止发射，不会沿旧计划行军。
- 竞速：仅当目标是敌方最后一冠时，反手用同一搜索估计对手斩杀我方王冠的最短 ETA，要求 `我方 ETA + margin <= 对方 ETA`。
- 切断与增援：路线上的己方割点若在到达前被敌方威胁击穿则否决；目标格还必须吃得下 `threat`（四步内敌方可达兵力的衰减值）的增援。
- 迷雾下只允许攻击可见王冠、只走可见格，绝不按记忆中的空驻军规划。

开关与参数：

| 变量                        | 默认 | 含义                                                             |
| --------------------------- | ---: | ---------------------------------------------------------------- |
| `BOT3_FINISH`               | 关闭 | 设为 `1` 启用；也可在板上用 `board.finish = true/false` 单独开关 |
| `BOT3_FINISH_ETA`           |    2 | 路线 Tick 上限                                                   |
| `BOT3_FINISH_SURPLUS`       |   60 | 非斩首路线需要留在目标冠上的富余兵力                             |
| `BOT3_FINISH_DECAP_SURPLUS` |    1 | 斩首路线的最低富余兵力                                           |
| `BOT3_FINISH_MARGIN`        |    1 | 斩首时要求的先手 Tick                                            |
| `BOT3_FINISH_TURN`          |   45 | 最早生效 Tick                                                    |

### 实测结论（配对比较，均对 `baseline-results.jsonl`）

| 配置                        | 规模                        |           Δ胜率 |
| --------------------------- | --------------------------- | --------------: |
| 默认（ETA 7 / 富余 25）     | 2 种子全矩阵 256 局         |          +0.4pp |
| 默认，仅 relay+anti         | 4 种子 256 局               |          −0.8pp |
| `MARGIN=0`（允许同速对杀）  | 4 种子 256 局               |          −1.2pp |
| `SURPLUS=1, ETA=10`（激进） | 4 种子 256 局               |          −1.6pp |
| 仅斩首（ETA 7）             | 4 种子 256 局               |           0.0pp |
| 仅斩首（ETA 7）             | 8 种子 512 局               |          −0.4pp |
| `ETA=2, SURPLUS=25`         | anti 单线三格 16 种子 96 局 |          −1.0pp |
| `ETA=2, SURPLUS=60`         | anti 单线三格 16 种子 96 局 |           0.0pp |
| `ETA=4` / `ETA=7` 仅斩首    | anti 单线三格 16 种子 96 局 | −4.2pp / −5.2pp |
| `ETA=7, SURPLUS=25`         | anti 单线三格 16 种子 96 局 |          −8.3pp |

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
