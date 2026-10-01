# apex-bot

这是一个独立重写的 Roka 策略 Bot。它把每回合的动作分成四层：

- 先处理能在当前窗口内救下主城的防守或直接攻冠；
- 再执行会切断敌方锚点连接的局部打击；
- 目标锁定后沿一条可解释的推进走廊滚动集结，达到当前格的兵力预算就推进，不重复等待互相矛盾的全局集结；
- 没有军事收益时才扩张或建设，并给桥接格和敌方反击留出安全余量。
- 长距离战役超过经济窗口后，单独从后方选择安全工地，限制集资半径并交替完成建城/升冠，让运输前线与后方产能同时推进。

建设采用短而连续的邻接集群计划：先在同一片区域连续完成指挥所和皇冠，再转向相邻格，避免东建一个、西建一个造成兵力分散。推进前会预演移动后的割点；若后方走廊会被敌方一击截断，优先保留突破点、补强断点或改用安全后方兵堆，避免把整堆兵力送入腹地后被截断。

策略只读取协议提供的状态，规则预演使用与服务器相同的智能分兵公式。迷雾下保留服务器公开的地形编码，探索时不猜测隐藏的所有者和兵力。

```sh
pnpm install
BOT_SERVER=http://127.0.0.1:23333 BOT_ROOM=room BOT_TOKEN=token pnpm start
node --test test/*.test.cjs
node training/benchmark.cjs
```

长期评测直接运行真实 `src/game-engine.ts`，支持多线程、四种地图、换边、迷雾和失败回放。默认目标是在 600 Tick 内击杀 Anti-Human；未结束的对局计为平局。例如：

```sh
APEX_EVAL_SEEDS=8 APEX_EVAL_WORKERS=8 APEX_EVAL_TURNS=600 \
  node training/long-eval.cjs
```

命令行也接受等价参数：

```sh
node training/long-eval.cjs --seeds 24 --workers 8 --turns 600 --opponents anti --seat both
node training/long-eval.cjs --help
```

评测结果默认打印为 JSON；传入 `--output FILE` 或设置 `APEX_EVAL_OUTPUT` 可保存报告。`--profile large` 会固定覆盖 0.5、0.68、1 三档地图尺寸，建议配合 1200 Tick 观察完整长距离战役。报告包括每局地图、种子、胜负、Tick、决策延迟直方图、失败回放，以及按尺寸和尺寸组汇总的 120/300/600/900/1200 Tick 皇冠、城市、兵力、领土、建设/升级/攻击动作、存活率和相对对手的兵力/领土/皇冠比。历史 48 局 Anti-Human 基准曾记录 42 胜、0 负、6 平；实际结果会随种子、尺寸和代码版本变化，应以评测报告为准。结果用于回归比较，不把平局计作击杀。

服务端托管入口使用 `require('./strategy').attachStrategy(socket, options)`，与独立进程共用同一套控制器和状态机。
Bot 加入房间后默认自动切换到配置队伍并发送准备；只有设置 `BOT_AUTO_READY=0` 或传入 `autoReady: false` 才会关闭自动准备。
