# apex-bot

`apex-bot` 是独立于 `simple-strategy-bot` 与 `anti-human-bot` 的实验性模板。它只依赖公开的 socket 协议状态：每个 tick 从当前可见盘面生成一个动作，并按威胁 ETA、皇冠安全、连通割点和有限敌方回复排序推兵、建设与防守。搜索带硬时间预算并有合法动作回退；迷雾外格不会被猜测。搜索中的局面模拟是服务端规则的可测试近似，不替代完整引擎 tick。

```sh
pnpm install
BOT_SERVER=http://127.0.0.1:23333 BOT_ROOM=room BOT_TOKEN=token pnpm start
node --test test/*.test.cjs
APEX_BENCH_SUITE=investment-raider APEX_BENCH_TURNS=300 node training/benchmark.cjs
APEX_BENCH_SUITE=full APEX_BENCH_TURNS=1200 node training/benchmark.cjs
```

`investment-raider` 专项模拟“先投资和涂色、再集中偷家”；输出首个威胁/防守响应、动作接受率和延迟统计。未结束的 benchmark 对局计为 draw，不会按兵力冒充胜利。专项对局不能替代真人回放，也不能单凭局部结果宣称全面胜过旧 bot。策略入口 `strategy.js` 同时导出 `attachStrategy` 供服务端托管发现。
