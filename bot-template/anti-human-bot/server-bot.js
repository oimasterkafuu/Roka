'use strict';
// 服务端托管适配入口：把管理器（src/server/server-bot-manager.ts）的托管接口
// attachStrategy(socket, { room, team, autoReady, log }) 映射到本 bot 的
// attachBot(socket, { roomName, preferredTeam, autoReady, log })。
// 本 bot 固定首选 2 队（组队模式下检测到人类同队会自主避让换队），
// 有意忽略管理器通用的 team: 1 传参。
const { attachBot } = require('./bot/client.cjs');

function attachStrategy(socket, { room, autoReady = true, log = console.log } = {}) {
  const handle = attachBot(socket, {
    roomName: room,
    preferredTeam: 2,
    autoReady,
    log,
  });
  return { stop() { handle.close(); } };
}

module.exports = { attachStrategy };
