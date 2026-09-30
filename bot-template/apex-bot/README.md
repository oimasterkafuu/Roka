# apex-bot

`apex-bot` 是独立于 `simple-strategy-bot` 与 `anti-human-bot` 的实验性模板。它只依赖公开的 socket 协议状态：每个 tick 从当前可见盘面生成一个动作，并用引擎规则的本地预演筛选推兵、建设和短视敌方回复。预演不替代完整引擎 tick（产兵、行动顺序和孤军衰减仍由服务端决定），迷雾外格不会被猜测。

```sh
pnpm install
BOT_SERVER=http://127.0.0.1:23333 BOT_ROOM=room BOT_TOKEN=token pnpm start
node --test test/*.test.cjs
node training/benchmark.cjs
```

未结束的 benchmark 对局计为 draw，不会按兵力冒充胜利。策略入口 `strategy.js` 同时导出 `attachStrategy` 供服务端托管发现。
