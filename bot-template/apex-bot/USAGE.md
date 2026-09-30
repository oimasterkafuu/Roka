# apex-bot 使用说明

需要 Node.js 18+ 与 socket.io bot token。`BOT_ROOM`、`BOT_TOKEN` 必填，`BOT_SERVER` 默认为 `http://127.0.0.1:23333`。`BOT_AUTO_READY=0` 可关闭自动准备，`BOT_ACTION_DELAY_MS` 调整决策发送延迟。

本模板不读取对手不可见格；迷雾状态由协议的 `fog` 数组过滤。服务端托管通过 `require('./strategy').attachStrategy(socket, { room, autoReady, log })` 使用同一生命周期。
