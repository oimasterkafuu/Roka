# anti-human-bot 使用说明

独立实现的 Roka 机器人（不依赖旧 strategy-bot），核心入口为 `bot/client.cjs` 的 `attachBot(socket, options)`。

## 命令行运行

```sh
pnpm install --frozen-lockfile
pnpm test                      # node --test test/*.test.cjs training/arena.test.cjs
BOT_TOKEN='你的令牌' pnpm start        # 默认连接 https://roka.oim.moe:444/，房间 bot
BOT_TOKEN='你的令牌' node bot.cjs --room=abc
```

CLI 默认**自动准备**（`BOT_AUTO_READY=0` 关闭），开启后每次局间等待 5 秒再准备；管理员 `oimaster` 在当前房间公开聊天发送 `/ready` 切换自动准备，`/room abc` 换房。

## 服务端托管运行

管理员后台（`static/admin.html` 超管分区）自动枚举本模板，选择后以托管方式在服务器进程内运行，无需 BOT_TOKEN：

- 管理器调用 `server-bot.js` 的 `attachStrategy(socket, { room, team, autoReady, log })`，
  内部映射为 `attachBot` 的 `{ roomName, preferredTeam, autoReady, log }`；
- 托管启动固定传入 `autoReady: true`（进房自动准备、无需 `/ready`）与 `team: 1`
  （准备阶段未入队时优先加入 1 队）；
- 详细协议说明见 `README.md`。
