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
- 托管启动固定传入 `autoReady: true`（进房自动准备、无需 `/ready`），本 bot 固定首选 2 队
  （有意忽略管理器通用的 `team: 1` 传参）；
- 详细协议说明见 `README.md`。

## 队伍自我管理

- 准备阶段未入队（观战席）时优先加入首选的 2 队；非组队模式由服务端规整为参赛。
- 组队模式下检测到有人类加入本队时，bot 主动退出本队并换到无人类的队伍：
  首选 2 队无人类则回 2 队，否则取编号最小的空队，再退而求纯 bot 队；
  全部队伍都有人类时按兵不动。人类侧不受任何限制或提示，服务端也不做分池修正。
- 纯 bot 同队不触发避让，换队目标为确定性选择，多个 bot 不会互踩抖动。

## 人格表现（对局内）

- **优势垃圾话**（`bot/trash-talk.cjs`）：全面领先时经 `send_message` 发言，文案为
  帝国时代 2 嘲讽风格（礼貌又欠揍），分小优/大优/碾压/对手挣扎四档、本局不重复。
  触发看综合局势：领土比突破阈值、兵力差翻倍、全面碾压、连续吃掉对方建筑（窗口期）、
  累计踩掉 N 座皇冠/指挥所、对方长时间无进展——每种触发独立冷却；另有全局冷却、
  每局次数上限（默认 4 次）与概率门控，劣势时绝不开口。
  彩蛋：对方领土单 tick 暴跌（被截断/隔离结算）时发一条写死的 `wololo`，
  不进轮换池、不占额度、每局限 1 次。
- **绝境投降 GG**（`bot/surrender.cjs`）：以下四条**全部**满足才发 `GG` 并走协议投降——
  ① 严重劣势（敌方兵力 ≥8 倍、领土 ≥4 倍、皇冠差 ≥3）；② 绝无胜算（敌兵力 ≥10 倍、
  自己产能见底且无可执行斩首）；③ 对方没有挂机（地盘近期有变化且未被标记 AFK）；
  ④ 对方在「调戏」（劣势持续 ≥250 tick 且敌 ≥30 次兵临皇冠能收尾不收）。
  阈值从严、宁可少投不误投，全部可在 `bot/params.cjs` 调整（`trash*`/`surrender*` 参数）。
