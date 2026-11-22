'use strict';

const { createBoard, chooseOrders } = require('./planner');

function attachStrategy(socket, { room, team = 1, autoReady = true } = {}) {
  let id,
    board,
    multiLine = false,
    nextSeq = 1,
    lastTurn = -1;
  const pending = new Set();
  const join = () => socket.emit('join_game_room', { room });
  const handlers = {
    set_id(value) {
      id = value;
      join();
    },
    disconnect() {
      board = null;
      pending.clear();
    },
    room_update(snapshot) {
      multiLine = snapshot.multi_line === true;
      if (snapshot.in_game || snapshot.update_queued || !autoReady) return;
      const self = snapshot.players.find((player) => player.sid === id);
      if (!self) return;
      const targetTeam = snapshot.allow_team ? team : 1;
      if (self.team !== targetTeam) socket.emit('change_team', { team: targetTeam });
      else if (!self.ready) socket.emit('change_ready', { ready: true });
    },
    init_map(init) {
      const player = init.player_ids.indexOf(id) + 1;
      board = player && init.general[0] >= 0 ? createBoard(init.n, init.m, player) : null;
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

module.exports = { attachStrategy };
