'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { attachStrategy } = require('../strategy');

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.outbound = [];
  }

  emit(event, payload) {
    this.outbound.push({ event, payload });
    return super.emit(event, payload);
  }

  receive(event, payload) {
    return super.emit(event, payload);
  }

  sent(event) {
    return this.outbound.filter((item) => item.event === event);
  }
}

function frame(turn, overrides = {}) {
  return {
    turn,
    is_diff: false,
    grid_type: [101, 1, 102],
    army_cnt: [20, 10, 5],
    isolated: [0, 0, 0],
    leaderboard: [
      { id: 1, team: 1, dead: 0 },
      { id: 2, team: 2, dead: 0 },
    ],
    kills: {},
    game_end: false,
    ...overrides,
  };
}

function init(socket) {
  socket.receive('set_id', 'me');
  socket.receive('init_map', { n: 1, m: 3, player_ids: ['me', 'enemy'] });
}

test('update validates every field before atomically committing a frame', () => {
  const socket = new FakeSocket();
  const bot = attachStrategy(socket, {
    room: 'r',
    autoReady: false,
    heartbeatIntervalMs: 0,
    actionDelayMs: 0,
  });
  init(socket);
  socket.receive('update', frame(1));
  const before = {
    turn: bot.state.turn,
    grid: bot.state.grid.slice(),
    army: bot.state.army.slice(),
  };

  socket.receive(
    'update',
    frame(2, {
      is_diff: true,
      grid_type: [1, 102],
      army_cnt: [1], // odd length: invalid after the grid diff has been parsed
    }),
  );
  assert.equal(bot.state.turn, before.turn);
  assert.deepEqual(bot.state.grid, before.grid);
  assert.deepEqual(bot.state.army, before.army);

  // A duplicate turn is ignored even when it is a valid full frame.
  socket.receive('update', frame(1, { grid_type: [101, 99, 102] }));
  assert.equal(bot.state.turn, 1);
  assert.deepEqual(bot.state.grid, before.grid);
  bot.stop();
});

test('init_map resets the board and cancels a queued decision from the old game', async () => {
  const socket = new FakeSocket();
  const bot = attachStrategy(socket, {
    room: 'r',
    autoReady: false,
    heartbeatIntervalMs: 0,
    actionDelayMs: 25,
  });
  init(socket);
  socket.receive('update', frame(1));
  assert.equal(bot.state.turn, 1);
  socket.receive('init_map', { n: 1, m: 2, player_ids: ['me', 'enemy'] });
  assert.equal(bot.state.turn, -1);
  assert.equal(bot.state.size, 2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(socket.sent('attack').length + socket.sent('build').length, 0);
  bot.stop();
});

test('room updates choose the configured team, then ready exactly once', () => {
  const socket = new FakeSocket();
  const bot = attachStrategy(socket, {
    room: 'r',
    team: 2,
    autoReady: true,
    heartbeatIntervalMs: 0,
    actionDelayMs: 0,
  });
  socket.receive('set_id', 'me');
  socket.receive('room_update', { in_game: false, players: [{ sid: 'me', team: 1, ready: false }] });
  assert.deepEqual(
    socket.sent('change_team').map((item) => item.payload),
    [{ team: 2 }],
  );
  socket.receive('room_update', { in_game: false, players: [{ sid: 'me', team: 2, ready: false }] });
  assert.deepEqual(
    socket.sent('change_ready').map((item) => item.payload),
    [{ ready: true }],
  );
  socket.receive('room_update', { in_game: false, players: [{ sid: 'me', team: 2, ready: false }] });
  assert.equal(socket.sent('change_ready').length, 1);
  socket.receive('room_update', { in_game: true, players: [{ sid: 'me', team: 2, ready: false }] });
  assert.equal(socket.sent('change_ready').length, 1);
  bot.stop();
});

test('connect clears an obsolete reconnect timer and performs one rejoin', async () => {
  const socket = new FakeSocket();
  const bot = attachStrategy(socket, {
    room: 'r',
    autoReady: false,
    heartbeatIntervalMs: 0,
    actionDelayMs: 0,
  });
  assert.equal(socket.sent('join_game_room').length, 1);
  socket.connected = false;
  socket.receive('disconnect');
  socket.connected = true;
  socket.receive('connect');
  assert.equal(socket.sent('join_game_room').length, 2);
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(socket.sent('join_game_room').length, 2);
  bot.stop();
});

test('rejoin init followed by a full frame establishes a fresh diff baseline', () => {
  const socket = new FakeSocket();
  const bot = attachStrategy(socket, {
    room: 'r',
    autoReady: false,
    heartbeatIntervalMs: 0,
    actionDelayMs: 0,
  });
  init(socket);
  socket.receive('update', frame(4));
  socket.connected = false;
  socket.receive('disconnect');
  socket.connected = true;
  socket.receive('connect');
  socket.receive('init_map', { n: 1, m: 3, player_ids: ['me', 'enemy'] });
  socket.receive('update', frame(1, { grid_type: [101, 7, 102] }));
  assert.equal(bot.state.turn, 1);
  assert.deepEqual(bot.state.grid, [101, 7, 102]);
  bot.stop();
});
