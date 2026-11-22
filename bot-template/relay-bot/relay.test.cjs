'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createBoard, chooseOrders } = require('./planner');
const { attachStrategy } = require('./strategy');

const players = [
  { id: 1, team: 1, army: 80, land: 3, dead: 0 },
  { id: 2, team: 2, army: 100, land: 4, dead: 0 },
];

test('reinforce the last crown before advancing an unrelated stack', () => {
  const board = createBoard(1, 6, 1);
  board.grid_type.set([2, 101, 1, 1, 200, 102]);
  board.army_cnt.set([30, 2, 35, 8, 0, 5]);
  const [order] = chooseOrders(board, 77, players, false);
  assert.deepEqual([order.from, order.to], [2, 1]);
});

test('take a crown when next-tick growth makes strict capture possible', () => {
  const board = createBoard(1, 2, 1);
  board.grid_type.set([101, 102]);
  board.army_cnt.set([7, 5]);
  assert.equal(chooseOrders(board, 7, players, false)[0].to, 1);
  board.army_cnt[0] = 6;
  assert.deepEqual(chooseOrders(board, 7, players, false), []);
});

test('remember a hidden crown and clear its location when a scout revisits it', () => {
  const b = createBoard(1, 5, 1);
  b.grid_type.set([101, 1, 200, 200, 102]);
  b.army_cnt.set([8, 20, 0, 0, 4]);
  chooseOrders(b, 55, players, false);
  b.fog[4] = 1;
  b.grid_type[4] = 200;
  b.army_cnt[4] = 0;
  chooseOrders(b, 56, players, false);
  assert.equal(b.memory[4], 102);
  b.fog[4] = 0;
  chooseOrders(b, 57, players, false);
  assert.equal(b.memory[4], 200);
});

test('rebind with a pending queue, apply diff and retain independent multiline orders', () => {
  const socket = new EventEmitter();
  const handle = attachStrategy(socket, { room: 'test' });
  try {
    const attacks = [];
    socket.on('attack', (op) => attacks.push(op));
    socket.emit('set_id', 'new');
    socket.emit('room_update', { multi_line: true, in_game: true });
    socket.emit('init_map', {
      n: 1,
      m: 7,
      general: [0, 0],
      player_ids: ['new', 'opponent'],
      next_seq: 30,
      queue_ops: [{ seq: 29 }],
    });
    const frame = {
      turn: 7,
      leaderboard: players,
      grid_type: [101, 200, 201, 200, 101, 200, 102],
      army_cnt: [1, 0, 0, 0, 1, 0, 20],
      fog: [0, 0, 0, 0, 0, 0, 0],
      isolated: [0, 0, 0, 0, 0, 0, 0],
      lst_moves: [],
    };
    socket.emit('update', frame);
    assert.equal(attacks.length, 0);
    socket.emit('update', {
      ...frame,
      turn: 8,
      is_diff: true,
      grid_type: [6, 200],
      army_cnt: [0, 6, 4, 9, 6, 0],
      fog: [6, 1],
      isolated: [],
      lst_moves: [29],
    });
    assert.equal(attacks.length, 2);
    assert.equal(new Set(attacks.flatMap(({ y, dy }) => [y, dy])).size, 4);
    socket.emit('update', { ...frame, turn: 9, lst_moves: [30] });
    assert.equal(attacks.length, 2);
    socket.emit('update', { ...frame, turn: 10, lst_moves: [31] });
    assert.ok(attacks.length > 2);
    socket.emit('init_map', { n: 1, m: 7, general: [-1, -1], player_ids: ['opponent'] });
    const count = attacks.length;
    socket.emit('update', frame);
    assert.equal(attacks.length, count);
  } finally {
    handle.stop();
    assert.equal(socket.listenerCount('update'), 0);
  }
});
