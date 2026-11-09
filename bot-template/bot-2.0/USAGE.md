# Bot(2.0) 使用说明

需要 Node.js 18+ 和 Socket.IO Bot token。`BOT_ROOM`、`BOT_TOKEN` 必填；`BOT_SERVER` 默认是 `http://127.0.0.1:23333`。

`BOT_AUTO_READY=0` 可以关闭自动准备，`BOT_ACTION_DELAY_MS` 用于设置决策发送延迟。`BOT_DUEL_STRIKE=0` 关闭 race 门控的斩杀终结层（默认开启：证明本 Tick 内可斩杀（`BOT_DUEL_STRIKE_ETA` 默认 1，可放宽到 1~12）且不会先被对方斩杀时，直接执行该路线首步），关闭后仅走原有规划器逻辑，便于 A/B 对比。`BOT_DECISION_BUDGET_MS` 限制单次决策的实际耗时（默认 80 ms，内部预留约 8 ms，安全低于 4 倍速的 125 ms 单 Tick）；超时后不再等待规划器，而是立刻给出一个经 `preview` 校验的合法动作（优先可立即斩首的皇冠攻击，其次 `recover` 的局部走子，最后是最省兵力的相邻占领/扩张）。动作确认晚到一帧时不会立即清队列，连续两帧未确认才重发；每局结束会输出 `game stats` 日志（`queueResets`/`queueGraceWaits`/`budgetExceeded`/`fallbacks`/`maxNoActionStreak`/`strikes`/`byBranch`）。Bot 每个服务器 Tick 最多发送一条移动或建造操作，收到差分帧后重新计算局面；如果上一条操作没有在 `lst_moves` 中确认，会先清空服务器队列再发送新操作，避免高倍速或网络抖动时执行过期长距离调兵。

默认行为是加入房间后自动切换到 `BOT_TEAM`（默认 1）并准备；服务端托管入口同样默认自动准备。决策默认在最新服务器帧到达后立即排队，`BOT_ACTION_DELAY_MS` 只用于故障复现或调试。

策略的核心状态是当前目标皇冠、推进走廊和集结点。目标只在失效或不可达时切换；集结预算按目标当前守军、路径长度和邻接支援重新计算，因此局部兵力增长不会触发相反方向的重复调兵。建设按邻接短链串行完成；推进动作会预演敌方对后方割点的截断能力，必要时先加固或等待。

## 离线评测

评测使用仓库当前的 `src/game-engine.ts`，不依赖网络服务器。默认每局最多 600 Tick；未在时限内结束会在 `draws` 中单独记录，同时计入 `losses`/`effectiveLosses`，因为未击杀即未达标。`worker_threads` 可把多个种子分配到独立线程。

```sh
node training/long-eval.cjs --help
node training/long-eval.cjs --seeds 24 --workers 8 --turns 600 --opponents anti --seat both
node training/long-eval.cjs --seeds 8 --workers 8 --turns 600 --opponents simple --seat 0
node training/long-eval.cjs --profile large --seeds 8 --workers 8 --turns 1200 --opponents anti --seat both
```

常用选项：`--profile standard|large` 选择尺寸套件（large 固定覆盖 0.5、0.68、1），`--sizes CSV` 可精确覆盖尺寸；`--seeds N` 设置每张地图的种子数，`--workers N` 设置并行线程数，`--turns N` 设置单局服务器 Tick 上限，`--opponents anti|simple|apex` 选择对手（`apex` 为原版 `bot-template/apex-bot`，用于防止过拟合），`--modes random,maze,...` 固定地图类型，`--seat 0|1|both` 选择我方先后手，`--output FILE` 指定结果 JSON。经济档位默认按地图模式选择（random/maze 用 tuned 10/45，archipelago/mediterranean 用 stock 6/90）；`APEX_ECON_MODE_GATE=0` 可强制所有模式使用 tuned，`APEX_ECON_GOAL`/`APEX_ECON_DEADLINE` 可覆盖 tuned 档。环境变量 `APEX_EVAL_PROFILE`、`APEX_EVAL_SIZES`、`APEX_EVAL_SEEDS`、`APEX_EVAL_WORKERS`、`APEX_EVAL_TURNS`、`APEX_EVAL_MODES` 可替代对应默认值。

结果 JSON 包含胜负汇总、每局 Tick、失败回放、决策延迟 p50/p95/p99，以及按地图尺寸和 standard/large 尺寸组统计的阶段性皇冠、城市、兵力、领土、建设/升级/攻击动作和存活率；配对样本还会给出相对对手的兵力/领土/皇冠比、城市差和兵力领先率。大地图回归示例：`node training/long-eval.cjs --profile large --seeds 8 --turns 1200 --workers 8 --opponents anti --seat both`；交叉测试原版 Apex：`--opponents apex`。未结束对局保留在 `draws`，同时计入 `losses`/`effectiveLosses`。
