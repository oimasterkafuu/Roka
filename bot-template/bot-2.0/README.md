# Bot(2.0)

Bot(2.0) 是基于 [`apex-bot`](../apex-bot/) 的 Roka 策略 Bot，目标是针对 **1v1** 对局做强化。当前版本保留 Apex 的全部决策逻辑作为基线，后续改动会围绕 1v1 的目标选择、资源分配与早中期节奏展开。它把每回合的动作分成四层：

- 先处理能在当前窗口内救下主城的防守或直接攻冠；明确的后方绕行威胁会沿可见、可通行的中立/沼泽/他人地盘主动截断，但仍受规则预演、兵力安全和路线护栏约束；
- 再执行会切断敌方锚点连接的局部打击；
- 目标锁定后沿一条可解释的推进走廊滚动集结，达到当前格的兵力预算就推进，不重复等待互相矛盾的全局集结；
- 没有军事收益时才扩张或建设，并给桥接格和敌方反击留出安全余量。
- 长距离战役超过经济窗口后，单独从后方选择安全工地，限制集资半径并交替完成建城/升冠，让运输前线与后方产能同时推进。
- 大地图集结缺口较大时，会冻结当前目标并先合并多条近邻支路，再按叶子到根逐段汇聚；共享干线只走一次，避免单个后方起点长距离往返运输。
- 远征前锋兵力不足时不会继续把一到十个兵送入走廊：战役会优先换用更强的后方兵堆，连续八个 Tick 无法集结则解除当前目标并恢复局部推进；大地图同时提高后方建设目标和扩张频率。
- 迷宫中一旦发现对手已经完成建造，若本方还没有足够的连续锚点，旧的远征计划会立即挂起，优先完成本地皇冠/指挥所集群；只有具备补充纵队的基础后才恢复长距离推进。
- 迷宫普通移动带有跨 Tick 滞回：记录最近边、反向边和短期冷却，普通集结不能在同一条边上重复送兵或立即掉头；出现真实斩首、截断或紧急防守时仍可越过护栏，找不到安全替代路线时会暂缓并转入局部锚点建设。

建设采用短而连续的邻接集群计划：先在同一片区域连续完成指挥所和皇冠，再转向相邻格，避免东建一个、西建一个造成兵力分散。推进前会预演移动后的割点；若后方走廊会被敌方一击截断，优先保留突破点、补强断点或改用安全后方兵堆，避免把整堆兵力送入腹地后被截断。

当前控制器保持一个连续的突击单元和一个独立的紧凑建设项目。突击单元被截断或路线停滞时会清空旧运输游标，改走局部截断、前线锚定或跨区域扩张，避免在同一条长征路线上反复集兵。大地图在兵力落后时会周期性寻找最近的可达中立地块；前锋深入长走廊时会定期建设指挥所，减少一次截断损失整条前线的概率。

策略只读取协议提供的状态，规则预演使用与服务器相同的智能分兵公式。迷雾下保留服务器公开的地形编码，探索时不猜测隐藏的所有者和兵力。

```sh
pnpm install
BOT_SERVER=http://127.0.0.1:23333 BOT_ROOM=room BOT_TOKEN=token pnpm start
node --test test/*.test.cjs
node training/benchmark.cjs
```

`test/replay-regression.test.cjs` 还会重放用户提供的 13×17 回放：`player_ops[0]` 是 `oimaster` 的人类操作流，`Anti_Human` 使用 Apex 控制器，确保新版 Apex 能在 600 Tick 内守住并击败该进攻。

长期评测直接运行真实 `src/game-engine.ts`，支持多线程、四种地图、换边、迷雾和失败回放。默认目标是在 600 Tick 内击杀 Anti-Human；未结束的对局保留 `draws` 诊断字段，但在 `losses`/`effectiveLosses` 中按失败计入。

```sh
APEX_EVAL_SEEDS=8 APEX_EVAL_WORKERS=8 APEX_EVAL_TURNS=600 \
  node training/long-eval.cjs
```

命令行也接受等价参数：

```sh
node training/long-eval.cjs --seeds 24 --workers 8 --turns 600 --opponents anti --seat both
node training/long-eval.cjs --help
```

评测对手可选 `anti`、`simple` 或 `apex`（原版 `bot-template/apex-bot`，用于交叉测试防过拟合）。

评测结果默认打印为 JSON；传入 `--output FILE` 或设置 `APEX_EVAL_OUTPUT` 可保存报告。评测尺寸只覆盖官服可用的两档：`standard=0.34`、`large=0.34,0.68`（1v1 普通/大地图）；不再使用 1.0 等官服不可达的超大地图。大地图建议配合 2400 Tick，1200 Tick 的平局只能视为未决。报告包括每局地图、种子、胜负、Tick、决策延迟直方图、失败回放，以及按尺寸和尺寸组汇总的 120/300/600/900/1200 Tick 皇冠、城市、兵力、领土、建设/升级/攻击动作、存活率和相对对手的兵力/领土/皇冠比；`losses`/`effectiveLosses` 会把未结束对局也计为失败。

## 成对 A/B 对比

`training/compare.cjs` 把两次长期评测按局配对比较，用于判断改动是否真的更好（避免不同地图/种子之间直接比总胜率）：

```sh
# 两个 checkout 各跑一次（相同参数），或直接比较现成报告
node training/compare.cjs --baseline ../baseline-checkout --candidate . \
  --seeds 8 --turns 600 --opponents anti --seat both --workers 2 --quiet \
  --output /tmp/bot2-compare.json
node training/compare.cjs --baseline-json /tmp/before.json --candidate-json /tmp/after.json
```

- 配对键：`(mode, mapSize, seed, swap, opponent, fog)`；每对记 `+1` 胜 / `0` 平 / `-1` 负（`error` 按负计）。
- 若不传任何评测参数，默认跑一个小而安全的套件：`--seeds 1 --turns 120 --workers 1 --modes random --sizes 0.34`；`--workers` 上限为 `2`，拒绝 `--profile large`。
- 报告给出胜率/平局率/`effectiveLosses` 差值（`draws` 仍计入有效失败，另附 `halfDrawWinRate` 把平局记 0.5）与固定种子的成对 bootstrap 95% 置信区间（默认 `2000` 次、种子 `20240601`，可用 `--iterations`/`--seed` 调整），并按地图、尺寸、尺寸组、座位、对手、迷雾分解。
- 设置不一致、重复配对键、存在缺对时退出码非零；`--allow-missing` 可只比较交集。`-q/--quiet` 关闭子进程的逐局进度。

公网对局中动作确认可能晚到一帧：`strategy.js` 允许一个 Tick 的确认宽限，只有连续两帧未确认才清队列重发，避免官服 RTT 造成动作反复取消；每局结束会打印一行 `game stats`（`queueResets`、`queueGraceWaits`、`budgetExceeded`、`fallbacks`、`maxNoActionStreak`、`strikes`、`byBranch`），用于区分网络时序与策略问题。

经济档位按 `room_update.map_mode` 选择：random/maze 使用 1v1 tuned（`APEX_ECON_GOAL=10`、`APEX_ECON_DEADLINE=45`），archipelago/mediterranean 保持 stock（6/90）；`APEX_ECON_MODE_GATE=0` 可强制所有模式用 tuned。

早期防守：`earlyRushProfile` 判断“对手在囤兵”后会把行动预算投入 `delayed-rush-guard`（守住皇冠），但它只看对手兵种构成，容易被“把大军留在家里、同时铺地图”的对手误触发，导致首个建设永远凑不满 50 兵。`APEX_OPENING_SMALL=1` 时改为按“可落地的兵力”判定：用 `projectedArrival` 计算对手沿最短路线真正能到达皇冠的兵力（沿途每格都要付出驻军代价），只有该兵力能击穿皇冠周边的连通驻军（`localGuard`）时才进入 hold。该门控只作用于 `b.size < 800` 的紧凑棋盘（0.34 官服普通房 221–255 格），0.68 及以上大地图行为完全不变；默认关闭，便于 A/B。

服务端托管入口使用 `require('./strategy').attachStrategy(socket, options)`，与独立进程共用同一套控制器和状态机；`options.decisionBudgetMs`（或环境变量 `BOT_DECISION_BUDGET_MS`）设置单次决策预算（默认 80 ms，预留 8 ms），超时后回退到一个经 `preview` 校验的合法动作，`controller.stats()` 会额外报告 `budgetExceeded`、`fallbacks`、`lastDecisionMs` 与 `maxDecisionMs`。
`options.duelStrike`（或环境变量 `BOT_DUEL_STRIKE=0`）控制“终结层”：默认开启时，控制器在规划器之前先跑一次 `bot/duel/strike.cjs` 的 race 门控斩杀判断，若证明本 Tick 内可斩杀（`maxEta` 默认 1，可用 `BOT_DUEL_STRIKE_ETA` 放宽）且不会先被对方斩杀，就直接执行该路线首步（mode 2 全推，经 `preview` 复核）；否则完全回落到原有规划器路径。关闭后行为与仅规划器版本一致，便于 A/B 对比。`BOT_DUEL_STRIKE_DECAP=1` 进一步只接受“最后一座皇冠”的必杀。
Bot 加入房间后默认自动切换到配置队伍并发送准备；只有设置 `BOT_AUTO_READY=0` 或传入 `autoReady: false` 才会关闭自动准备。
服务端运行时会按对手用户名累计胜负、平局和连续失败次数（仅作日志记录，不影响自动准备——无论连败多少局都会照常准备开局）。
