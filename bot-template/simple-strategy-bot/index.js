// simple-strategy-bot 独立运行入口（CLI）。
// 策略与房间循环逻辑全部在 strategy.js，这里只负责解析环境变量并建立连接。
// 环境变量与 random-patch-bot 保持一致，详见 USAGE.md / static/develop-bot.html。

const { io } = require('socket.io-client');
const { attachStrategy } = require('./strategy');

const BOT_SERVER = String(process.env.BOT_SERVER || 'http://127.0.0.1:23333').trim();
const BOT_ROOM = String(process.env.BOT_ROOM || '').trim();
const BOT_TOKEN = String(process.env.BOT_TOKEN || '').trim();
const BOT_TEAM = Math.max(1, Number.parseInt(String(process.env.BOT_TEAM || '1'), 10) || 1);
const BOT_AUTO_READY = String(process.env.BOT_AUTO_READY || '1') !== '0';
const ACTION_DELAY_MS = Math.max(
  0,
  Number.parseInt(String(process.env.BOT_ACTION_DELAY_MS || '120'), 10) || 120,
);

if (!BOT_ROOM) {
  throw new Error('Missing BOT_ROOM. Example: BOT_ROOM=abc123');
}

if (!BOT_TOKEN) {
  throw new Error('Missing BOT_TOKEN. Copy auth_token from browser cookie after login.');
}

const socket = io(BOT_SERVER, {
  transports: ['websocket', 'polling'],
  auth: { token: BOT_TOKEN },
  reconnection: true,
});

attachStrategy(socket, {
  room: BOT_ROOM,
  team: BOT_TEAM,
  autoReady: BOT_AUTO_READY,
  actionDelayMs: ACTION_DELAY_MS,
  log: (message) => console.log(`[bot] ${message}`),
});

process.on('SIGINT', () => {
  console.log('[bot] shutting down');
  socket.disconnect();
  process.exit(0);
});
