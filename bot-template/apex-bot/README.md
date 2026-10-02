# apex-bot

这是一个独立重写的 Roka 策略 Bot。它把每回合的动作分成四层：

- 先处理能在当前窗口内救下主城的防守或直接攻冠；
- 再执行会切断敌方锚点连接的局部打击；
- 目标锁定后沿一条可解释的推进走廊滚动集结，达到当前格的兵力预算就推进，不重复等待互相矛盾的全局集结；
- 没有军事收益时才扩张或建设，并给桥接格和敌方反击留出安全余量。
- 长距离战役超过经济窗口后，单独从后方选择安全工地，限制集资半径并交替完成建城/升冠，让运输前线与后方产能同时推进。
- 大地图集结缺口较大时，会冻结当前目标并先合并多条近邻支路，再按叶子到根逐段汇聚；共享干线只走一次，避免单个后方起点长距离往返运输。
- 远征前锋兵力不足时不会继续把一到十个兵送入走廊：战役会优先换用更强的后方兵堆，连续八个 Tick 无法集结则解除当前目标并恢复局部推进；大地图同时提高后方建设目标和扩张频率。

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

评测结果默认打印为 JSON；传入 `--output FILE` 或设置 `APEX_EVAL_OUTPUT` 可保存报告。`--profile large` 会固定覆盖 0.5、0.68、1 三档地图尺寸，建议配合 1200 Tick 观察完整长距离战役。报告包括每局地图、种子、胜负、Tick、决策延迟直方图、失败回放，以及按尺寸和尺寸组汇总的 120/300/600/900/1200 Tick 皇冠、城市、兵力、领土、建设/升级/攻击动作、存活率和相对对手的兵力/领土/皇冠比；`losses`/`effectiveLosses` 会把未结束对局也计为失败。

服务端托管入口使用 `require('./strategy').attachStrategy(socket, options)`，与独立进程共用同一套控制器和状态机。
Bot 加入房间后默认自动切换到配置队伍并发送准备；只有设置 `BOT_AUTO_READY=0` 或传入 `autoReady: false` 才会关闭自动准备。
