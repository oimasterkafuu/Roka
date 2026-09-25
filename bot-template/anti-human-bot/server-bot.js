'use strict';
// 服务端托管适配入口：把管理器（src/server/server-bot-manager.ts）的托管接口
// attachStrategy(socket, { room, team, autoReady, log }) 映射到本 bot 的
// attachBot(socket, { roomName, preferredTeam, autoReady, log })。
const { attachBot } = require('./bot/client.cjs');

function attachStrategy(socket, { room, team = 1, autoReady = true, log = console.log } = {}) {
  const handle = attachBot(socket, {
    roomName: room,
    preferredTeam: team,
    autoReady,
    log,
  });
  return { stop() { handle.close(); } };
}

module.exports = { attachStrategy };
