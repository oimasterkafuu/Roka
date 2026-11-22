'use strict';

const { createBoard, chooseOrders } = require('./planner');
const { openingBudget } = require('./opening');
const MAX_TEAMS = 16;

function attachStrategy(socket, { room, team = 1, autoReady = true } = {}) {
  let id,
    board,
    multiLine = false,
    speed = 1,
    nextSeq = 1,
    lastTurn = -1;
  const pending = new Set();
  let lobbyRequest = null;
  let starting = false;
  const join = () => socket.emit('join_game_room', { room });
  const handlers = {
    set_id(value) {
      id = value;
      lobbyRequest = null;
      starting = false;
      join();
    },
    disconnect() {
      board = null;
      pending.clear();
      lobbyRequest = null;
      starting = false;
    },
    starting() {
      starting = true;
      lobbyRequest = null;
    },
    room_update(snapshot) {
      multiLine = snapshot.multi_line === true;
      speed = snapshot.speed ?? speed;
      if (starting || snapshot.in_game === true || snapshot.update_queued === true || !autoReady) {
        lobbyRequest = null;
        return;
      }
      const players = snapshot.players ?? [];
      const self = players.find((player) => player.sid === id);
      if (!self) {
        lobbyRequest = null;
        return;
      }
      const playingCount = players.filter((player) => player.team !== 0).length;
      const targetTeam = snapshot.allow_team === true ? team : 1;
      if (self.team !== targetTeam && (self.team !== 0 || playingCount < MAX_TEAMS)) {
        const request = `team:${self.team}:${targetTeam}`;
        if (lobbyRequest === request) return;
        lobbyRequest = request;
        socket.emit('change_team', { team: targetTeam });
      } else if (self.team !== 0 && self.ready === false && playingCount >= 2) {
        if (lobbyRequest === 'ready') return;
        lobbyRequest = 'ready';
        socket.emit('change_ready', { ready: true });
      } else {
        lobbyRequest = null;
      }
    },
    init_map(init) {
      starting = false;
      lobbyRequest = null;
      const player = init.player_ids.indexOf(id) + 1;
      board = player && init.general[0] >= 0 ? createBoard(init.n, init.m, player) : null;
      if (board) board.openingBudget = openingBudget(speed);
      multiLine = init.multi_line ?? multiLine;
      lastTurn = -1;
      nextSeq = init.next_seq ?? 1;
      pending.clear();
      for (const op of init.queue_ops ?? []) pending.add(op.seq);
    },
    update(frame) {
      if (frame.game_end) {
        if (board) socket.emit('return_room', {});
        board = null;
        return;
      }
      if (!board) return;
      if (!frame.is_diff) board.fogMode = Array.isArray(frame.fog);
      const self = frame.leaderboard.find((player) => player.id === board.me);
      if (!self || self.dead || frame.kills?.[id]) return;
      for (const key of ['grid_type', 'army_cnt', 'isolated', 'fog']) {
        const data = frame[key];
        if (!frame.is_diff) {
          if (data) board[key].set(data);
          else board[key].fill(0);
        } else if (data) {
          for (let i = 0; i < data.length; i += 2) board[key][data[i]] = data[i + 1];
        }
      }
      for (const seq of frame.lst_moves ?? []) pending.delete(seq);
      if (frame.turn === lastTurn || pending.size) return;
      lastTurn = frame.turn;
      for (const op of chooseOrders(board, frame.turn, frame.leaderboard, multiLine)) {
        const x = Math.floor(op.from / board.cols),
          y = op.from % board.cols;
        pending.add(nextSeq++);
        if (op.build) socket.emit('build', { x, y, op: op.build });
        else
          socket.emit('attack', {
            x,
            y,
            dx: Math.floor(op.to / board.cols),
            dy: op.to % board.cols,
            mode: op.mode,
          });
      }
    },
  };
  for (const [name, handler] of Object.entries(handlers)) socket.on(name, handler);
  const heartbeat = setInterval(() => {
    if (socket.connected) socket.emit('room_heartbeat', {});
  }, 30_000);
  heartbeat.unref?.();
  return {
    stop() {
      clearInterval(heartbeat);
      for (const [name, handler] of Object.entries(handlers)) socket.off(name, handler);
    },
  };
}

module.exports = { attachStrategy, MAX_TEAMS };
