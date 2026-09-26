'use strict';
const { BoardState } = require('./state.cjs');
const { performance } = require('node:perf_hooks');
const { chooseAction, getDecisionDiagnostics } = require('./policy.cjs');
function attachBot(socket, {
  roomName = 'bot', log = console.log, now = Date.now, params = {},
  setInterval: schedule = setInterval, clearInterval: cancel = clearInterval,
} = {}) {
  let clientId = '', room = null, board = null, sentTurn = -1, returning = false;
  let currentRoom = roomName, pendingRoom = null, running = false, closed = false;
  let autoReady = false, cancelReady = false, readyAt = Infinity, summary = '', lastLobbyCommand = -Infinity;
  let metrics = { count:0, sent:0, idle:0, ms:0, max:0, gaps:0 }, previousTurn = null;
  const handlers = {};
  const on = (name, fn) => { handlers[name] = fn; socket.on(name, fn); };
  function resetIntermission() {
    readyAt = autoReady ? now() + 5000 : Infinity;
    lastLobbyCommand = -Infinity;
  }
  function switchRoom() {
    // join_game_room ignores joins while lobbyOfSid is occupied. Neither leave nor
    // return_room releases it: only disconnect does. Wait for room_update(false),
    // not death/game_end, so server endGame has also cleared its game routing.
    if (!pendingRoom || !room || running || room.in_game || !socket.connected) return;
    currentRoom = pendingRoom;
    pendingRoom = null;
    room = null; board = null; returning = false; readyAt = Infinity;
    log(`[房间] 切换到 ${currentRoom}`);
    socket.disconnect();
    if (!closed) socket.connect();
  }
  on('connect', () => {
    if (closed) return;
    log('[连接] 独立机器人已连接');
    socket.emit('join_game_room', { room: currentRoom });
    socket.emit('room_heartbeat');
  });
  on('set_id', (id) => { clientId = String(id || ''); });
  on('disconnect', (reason) => {
    room = null; board = null; returning = false; readyAt = Infinity;
    log(`[断开] ${reason}`);
  });
  on('connect_error', () => log('[连接] 连接失败，等待自动重连'));
  on('room_update', (data) => {
    if (!data || !Array.isArray(data.players) || typeof data.in_game !== 'boolean') return;
    if (!data.in_game && (!room || running)) resetIntermission();
    // Retain only operational fields; never read or retain map_token/auth tokens.
    room = { in_game: data.in_game, players: data.players.map(({ sid, uid, team, ready }) => ({ sid, uid, team, ready })), need: data.need };
    running = data.in_game;
    if (!running) { board = null; returning = false; }
    const self = room.players.find((p) => p.sid === clientId);
    const next = JSON.stringify({ room: currentRoom, in_game: running, player: self?.uid, ready: self?.ready });
    if (next !== summary) { summary = next; log(`[房间] ${next}`); }
    switchRoom();
  });
  on('chat_message', (message) => {
    // Server assigns sender from the authenticated user's uid. Local room public
    // messages have no room field; global relays do. Never parse sender from text.
    if (!socket.connected || !room || !message || message.sender !== 'oimaster' ||
        Object.hasOwn(message, 'room') || message.team !== false ||
        !Number.isInteger(message.color) || message.color <= 0 || typeof message.text !== 'string') return;
    const text = message.text.trim();
    if (text === '/ready') {
      autoReady = !autoReady;
      readyAt = autoReady && !running ? now() + 5000 : Infinity;
      cancelReady = !autoReady;
      lastLobbyCommand = -Infinity;
      log(`[控制] 自动准备${autoReady ? '开启' : '关闭'}`);
      if (!autoReady) {
        socket.emit('change_ready', { ready: false });
        // In-game changes are rejected by the server; cancel again in the lobby.
        cancelReady = running;
      }
      return;
    }
    const match = /^\/room\s+(\S+)$/.exec(text);
    if (!match || match[1].length > 15) return;
    pendingRoom = match[1] === currentRoom ? null : match[1];
    if (pendingRoom) { readyAt = Infinity; switchRoom(); }
    else if (autoReady && !running) resetIntermission();
  });
  on('init_map', (data) => {
    running = true; readyAt = Infinity;
    metrics = { count:0, sent:0, idle:0, ms:0, max:0, gaps:0 }; previousTurn = null;
    try { board = new BoardState(data, clientId); sentTurn = -1; returning = false; log(`[对局] 初始化 ${board.n}x${board.m}，玩家 ${board.playerId}`); }
    catch { board = null; log('[对局] 地图初始化失败'); }
  });
  on('update', (payload) => {
    if (!board || !board.apply(payload)) return;
    if (board.ended || board.dead) {
      if (!returning) { returning = true; log(`[对局] ${board.ended ? '结束' : '被淘汰'}，返回房间`); socket.emit('return_room'); }
      return;
    }
    if (returning || board.playerId === 0 || board.turn <= sentTurn) return;
    sentTurn = board.turn;
    const started = performance.now();
    const selected = chooseAction(board, params);
    const elapsed = performance.now() - started;
    metrics.count++; metrics.ms += elapsed; metrics.max = Math.max(metrics.max, elapsed);
    if (previousTurn !== null) metrics.gaps += Math.max(0, board.turn - previousTurn - 1);
    previousTurn = board.turn;
    if (selected) metrics.sent++; else metrics.idle++;
    if (elapsed >= 50) log(`[慢决策] turn=${board.turn} 耗时=${elapsed.toFixed(1)}ms`);
    if (metrics.count >= 20) {
      if (!selected) log(`[空动作诊断] ${JSON.stringify(getDecisionDiagnostics(board))}`);
      log(`[决策统计] turn=${board.turn} 计算=${metrics.count} 发送=${metrics.sent} 空动作=${metrics.idle} 平均=${(metrics.ms/metrics.count).toFixed(2)}ms 最大=${metrics.max.toFixed(2)}ms 更新跳号=${metrics.gaps}（攻击详情每20turn采样，发送不等于执行）`);
      metrics = { count:0, sent:0, idle:0, ms:0, max:0, gaps:0 };
    }
    if (selected) {
      const { kind, reason: rawReason, ...action } = selected;
      const reason = typeof rawReason === 'string' ? rawReason : JSON.stringify(rawReason);
      socket.emit(kind, action);
      if (kind === 'build') log(`[建造] turn=${board.turn} ${reason} (${action.x},${action.y})`);
      else if (board.turn % 20 === 0 || board.turn < 10) log(`[决策] turn=${board.turn} ${reason} (${action.x},${action.y})->(${action.dx},${action.dy})`);
    }
  });
  on('left', () => { board = null; returning = false; });
  on('room_kick', () => { log('[房间] 被移出，停止连接'); socket.disconnect(); });
  const tick = () => {
    if (closed || !socket.connected || !room || running || room.in_game || pendingRoom) return;
    const self = room.players.find((p) => p.sid === clientId);
    if (!self || now() - lastLobbyCommand < 1000) return;
    const emitLobby = (event, payload) => { lastLobbyCommand = now(); socket.emit(event, payload); };
    if (cancelReady) { cancelReady = false; emitLobby('change_ready', { ready: false }); return; }
    if (!autoReady) return;
    if (Number(self.team) === 0) { emitLobby('change_team', { team: 1 }); return; }
    if (now() >= readyAt && Number(room.need) > 1 && !self.ready) emitLobby('change_ready', { ready: true });
  };
  const timer = schedule(tick, 100);
  const heartbeat = schedule(() => { if (!closed && socket.connected) socket.emit('room_heartbeat'); }, 30000);
  return { tick, close() {
    closed = true; cancel(timer); cancel(heartbeat);
    for (const [event, handler] of Object.entries(handlers)) socket.off(event, handler);
  } };
}
module.exports = { attachBot };
