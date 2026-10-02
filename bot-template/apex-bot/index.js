'use strict';

const { io } = require('socket.io-client');
const { attachStrategy } = require('./strategy');

const server = String(process.env.BOT_SERVER || 'http://127.0.0.1:23333');
const room = String(process.env.BOT_ROOM || '').trim();
const token = String(process.env.BOT_TOKEN || '').trim();
if (!room) throw new Error('Missing BOT_ROOM');
if (!token) throw new Error('Missing BOT_TOKEN');

const socket = io(server, {
  transports: ['websocket', 'polling'],
  reconnection: true,
  auth: { token },
});
const bot = attachStrategy(socket, {
  room,
  team: Number(process.env.BOT_TEAM || 1),
  autoReady: process.env.BOT_AUTO_READY !== '0',
  actionDelayMs: Number(process.env.BOT_ACTION_DELAY_MS || 0),
  log: (message) => console.log(`[apex] ${message}`),
});

function shutdown() {
  bot.stop();
  socket.disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
