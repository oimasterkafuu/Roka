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
- `bot3.test.cjs`：短局穷举、峡谷与协议回归。
- `index.js`：独立运行的 CLI。

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
