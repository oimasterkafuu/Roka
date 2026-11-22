'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createBoard, chooseOrders } = require('./planner');
const { attachStrategy, MAX_TEAMS } = require('./strategy');
const { rescueValues, assessOpponents } = require('./single-front');
const { makeOpening } = require('./opening');
const { isMazeBoard, laneBlocked, laneState, recordLane } = require('./maze');

const players = [
  { id: 1, team: 1, army: 80, land: 3, dead: 0 },
  { id: 2, team: 2, army: 100, land: 4, dead: 0 },
];

function openingFixture(rows, cols, root, walls = []) {
  const b = createBoard(rows, cols, 1);
  b.grid_type.fill(200);
  for (const wall of walls) b.grid_type[wall] = 201;
  b.grid_type[root] = 101;
  b.army_cnt[root] = 1;
  const teams = Array.from(b.grid_type, (t) => (t === 101 ? 1 : 0));
  return { b, teams };
}

// Independent exhaustive oracle for short games. Try every legal order or
// wait, advance growth, and merge only identical army distributions.
function bruteLand(b, root, ticks) {
  let states = [Array.from(b.army_cnt)];
  for (let t = 0; t < ticks; t++) {
    const next = new Map();
    for (const army of states) {
      army[root]++;
      next.set(army.join(), army.slice());
      for (const [i, n] of army.entries()) {
        if (n < 2) continue;
        for (const j of b.neighbors[i]) {
          if (b.grid_type[j] === 201) continue;
          const other = b.neighbors[i].filter((k) => k !== j && b.grid_type[k] !== 201 && !army[k]).length;
          for (const send of new Set([n - 1, Math.min(n - 1, Math.floor((n - 1 + other) / 2))])) {
            if (!send) continue;
            const copy = army.slice();
            copy[i] -= send;
            copy[j] += send;
            next.set(copy.join(), copy);
          }
        }
      }
    }
    states = [...next.values()];
  }
  return states.reduce((best, s) => Math.max(best, s.filter(Boolean).length), 0);
}

test('match exhaustive legal serial play on short openings including blocked exits', () => {
  for (let mask = 0; mask < 32; mask++) {
    const walls = [1, 2, 3, 4, 5].filter((i) => mask & (1 << (i - 1)));
    const { b, teams } = openingFixture(2, 3, 0, walls);
    for (const ticks of [5, 8]) {
      const optimal = bruteLand(b, 0, ticks);
      const plan = makeOpening(b, teams, [0], 0, Array(b.size).fill(90), ticks);
      assert.deepEqual([plan.land, plan.upper], [optimal, optimal], JSON.stringify({ walls, ticks }));
    }
  }
});

test('wait for a column in a single-exit corridor and reach tile thirteen by tick 24', () => {
  const { b, teams } = openingFixture(1, 25, 0);
  const plan = makeOpening(b, teams, [0], 0, Array(25).fill(90));
  assert.deepEqual([plan.land, plan.upper], [13, 13]);
  assert.ok(plan.moves.some((batch) => !batch.length));
});

test('prefer an uncontested branch when both directions offer the same land', () => {
  const { b, teams } = openingFixture(1, 15, 7);
  b.grid_type[2] = 102;
  b.grid_type[14] = 103;
  teams[2] = 2;
  teams[14] = 3;
  const d = Array.from({ length: 15 }, (_, i) => Math.min(Math.abs(i - 2), 14 - i));
  const plan = makeOpening(b, teams, [7], 0, d, 2);
  assert.equal(plan.moves.flat()[0].to, 8);
});

test('expand in parallel from a single crown with executable independent orders', () => {
  const { b, teams } = openingFixture(9, 9, 40);
  const distance = Array(81).fill(99);
  const serial = makeOpening(b, teams, [40], 0, distance);
  const parallel = makeOpening(b, teams, [40], 0, distance, 24, 25000, true);
  assert.ok(parallel.land > serial.upper);
  for (const batch of parallel.moves) {
    b.army_cnt[40]++;
    const endpoints = batch.flatMap((op) => [op.from, op.to]);
    assert.equal(new Set(endpoints).size, endpoints.length);
    for (const op of batch) {
      assert.equal(b.army_cnt[op.from], op.source);
      assert.equal(b.army_cnt[op.to], op.destination);
      b.army_cnt[op.from] -= op.send;
      b.army_cnt[op.to] += op.send;
    }
  }
  assert.equal(b.army_cnt.filter((n) => n > 0).length, parallel.land);
});

test('hold construction funds when an enemy column can round a bend, and build with enough reserve', () => {
  for (const terrain of [1, 51]) {
    const b = createBoard(3, 5, 1);
    b.grid_type.fill(201);
    for (const [i, t, n] of [
      [0, 101, 4],
      [1, terrain, 108],
      [2, 1, 1],
      [7, 200, 0],
      [12, 2, 80],
      [13, 2, 15],
      [14, 102, 2],
    ]) {
      b.grid_type[i] = t;
      b.army_cnt[i] = n;
    }
    // A corridor board defers the concentrated front planner to turn 250, so
    // the reserve behaviour is asserted once it owns the frame.
    assert.ok(!chooseOrders(b, 262, players, false).some((op) => op.build));
    b.army_cnt[1] = 170;
    assert.equal(chooseOrders(b, 262, players, false)[0].build, terrain === 1 ? 'b' : 'c');
  }
});

test('trade into a larger invading stack from a side branch to save the crown', () => {
  const b = createBoard(2, 4, 1);
  b.grid_type.set([101, 1, 2, 102, 201, 201, 1, 201]);
  b.army_cnt.set([9, 1, 60, 1, 0, 0, 57, 0]);
  const [move] = chooseOrders(b, 81, players, false);
  assert.deepEqual([move.from, move.to], [6, 2]);
});

test('value a whole isolated group once per bridge and distinguish a lone outpost', () => {
  const b = createBoard(2, 4, 1);
  b.grid_type.set([1, 1, 200, 1, 1, 200, 101, 201]);
  b.isolated.set([1, 1, 0, 1, 1, 0, 0, 0]);
  b.army_cnt.set([32, 4, 0, 1, 2, 0, 15, 0]);
  const teams = Array.from(b.grid_type, (code) => (code < 200 ? code % 50 : 0));
  const rescue = rescueValues(b, teams, 1, b.army_cnt);
  assert.equal(rescue[5], 44);
  assert.equal(rescue[2], 47);
});

test('prefer the weaker FFA rival with an exposed last crown at comparable range', () => {
  const b = createBoard(1, 7, 1);
  b.grid_type.set([102, 2, 200, 101, 200, 3, 103]);
  b.memory.set(b.grid_type);
  const standings = [...players, { id: 3, team: 3, army: 800, land: 30, dead: 0 }];
  const chosen = assessOpponents(
    b,
    standings,
    [0, 6],
    [3, 2, 1, 0, 1, 2, 3],
    [2, 2, 0, 1, 0, 3, 3],
    1,
    b.army_cnt,
    players[0],
  );
  assert.equal(chosen.player.id, 2);
});

test('keep the last crown garrison when a neutral advance would leave it open', () => {
  const b = createBoard(1, 4, 1);
  b.grid_type.set([102, 2, 101, 200]);
  b.army_cnt.set([2, 22, 10, 0]);
  assert.deepEqual(chooseOrders(b, 85, players, false), []);
});

test('fund a safe second crown before the burst ends on a compact visible front', () => {
  const b = createBoard(1, 10, 1);
  b.grid_type.set([101, 1, 1, 200, 200, 200, 200, 200, 2, 102]);
  b.army_cnt.set([10, 100, 1, 0, 0, 0, 0, 0, 20, 180]);
  const order = chooseOrders(b, 43, players, false)[0];
  assert.deepEqual([order.from, order.build], [1, 'b']);
});

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

test('commit the first of two attacks only when a second force can finish', () => {
  const board = createBoard(2, 7, 1);
  board.grid_type.fill(201);
  board.grid_type.set([101, 1, 1, 1, 51, 102, 51]);
  board.army_cnt.set([5, 1, 1, 1, 65, 80, 65]);
  const [attack] = chooseOrders(board, 275, players, false);
  assert.equal(attack.to, 5);
  assert.ok([4, 6].includes(attack.from));
  board.grid_type[12] = 2;
  board.army_cnt[12] = 90;
  const defended = chooseOrders(board, 276, players, false);
  assert.ok(!defended.some((op) => op.to === 5));
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

test('ready only with two participants, and resume after a game or deployment', (context) => {
  const socket = new EventEmitter();
  context.after(attachStrategy(socket, { room: 'test' }).stop);
  const requests = [];
  socket.on('change_ready', (request) => requests.push(request));
  socket.emit('set_id', 'bot3');

  const member = { sid: 'bot3', team: 1, ready: false };
  const second = { sid: 'second', team: 1, ready: false };
  const snapshot = { players: [member, { sid: 'watching', team: 0 }] };
  socket.emit('room_update', { players: [member] });
  socket.emit('room_update', snapshot);
  snapshot.players.push(second);
  socket.emit('room_update', { ...snapshot, update_queued: true });
  socket.emit('room_update', { ...snapshot, in_game: true });
  assert.deepEqual(requests, []);

  socket.emit('room_update', snapshot);
  socket.emit('room_update', snapshot);
  member.ready = true;
  socket.emit('room_update', snapshot);
  assert.deepEqual(requests, [{ ready: true }]);

  socket.emit('starting');
  member.ready = false;
  socket.emit('room_update', snapshot);
  socket.emit('init_map', { n: 1, m: 1, general: [-1, -1], player_ids: ['bot3'] });
  socket.emit('room_update', { ...snapshot, in_game: true });
  assert.equal(requests.length, 1);
  socket.emit('room_update', snapshot);
  assert.deepEqual(requests, [{ ready: true }, { ready: true }]);
});

test('wait for a playing seat and request the configured team once it opens', (context) => {
  const socket = new EventEmitter();
  context.after(attachStrategy(socket, { room: 'test', team: 2 }).stop);
  const teams = [];
  const readiness = [];
  socket.on('change_team', (request) => teams.push(request));
  socket.on('change_ready', (request) => readiness.push(request));
  socket.emit('set_id', 'bot3');

  const member = { sid: 'bot3', team: 0, ready: false };
  const others = Array.from({ length: MAX_TEAMS }, (_, index) => ({ sid: `seat-${index}`, team: 1 }));
  socket.emit('room_update', { allow_team: true, players: [member, ...others] });
  assert.deepEqual(teams, []);
  assert.deepEqual(readiness, []);

  const snapshot = { allow_team: true, players: [member, ...others.slice(1)] };
  socket.emit('room_update', snapshot);
  socket.emit('room_update', snapshot);
  assert.deepEqual(teams, [{ team: 2 }]);
  assert.deepEqual(readiness, []);
  member.team = 2;
  socket.emit('room_update', snapshot);
  assert.deepEqual(readiness, [{ ready: true }]);
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

test('detect corridor boards and leave open maps alone', () => {
  const open = createBoard(10, 10, 1);
  open.grid_type.fill(200);
  // A random map uses ~12% mountains, well below the corridor threshold.
  for (let i = 0; i < 10; i++) open.grid_type[i * 10 + i] = 201;
  assert.equal(isMazeBoard(open), false);
  const corridor = createBoard(10, 10, 1);
  corridor.grid_type.fill(201);
  for (let i = 0; i < 10; i++) corridor.grid_type[i * 10 + (i % 2)] = 200;
  assert.equal(isMazeBoard(corridor), true);
});

test('refuse to reverse or repeat a corridor lane, but keep progress and cuts', () => {
  const b = createBoard(1, 4, 1);
  b.grid_type.set([101, 1, 2, 102]);
  recordLane(b, 0, 1);
  // The reverse of the last lane is blocked when it gains no ground.
  assert.equal(laneBlocked(b, 1, 0, 40, false, false), true);
  // Walking back toward the objective is real progress on a corridor.
  assert.equal(laneBlocked(b, 1, 0, 41, true, false), false);
  // A crown strike or a rescue reinforcement is never blocked.
  assert.equal(laneBlocked(b, 1, 0, 41, false, true), false);
  // The third consecutive use of one edge is refused as well.
  recordLane(b, 0, 1);
  assert.equal(laneBlocked(b, 0, 1, 40, false, false), true);
  recordLane(b, 1, 2);
  assert.equal(laneState(b).edge, '1:2');
  assert.equal(laneState(b).blocked, 2);
});

test('defer the concentrated front planner on a corridor board', () => {
  // A 5x5 snake: walls everywhere except one winding corridor with a crown at
  // each end. Mountains are 60% of the board, like a generated maze.
  const path = [
    [0, 0],
    [0, 1],
    [0, 2],
    [1, 2],
    [2, 2],
    [2, 3],
    [2, 4],
    [3, 4],
    [4, 4],
    [4, 3],
  ];
  const build = () => {
    const b = createBoard(5, 5, 1);
    b.grid_type.fill(201);
    for (const [x, y] of path) b.grid_type[x * 5 + y] = 200;
    b.grid_type[0] = 101;
    b.grid_type[24] = 102;
    b.army_cnt[0] = 34;
    b.army_cnt[1] = 9;
    b.army_cnt[13] = 7;
    b.army_cnt[23] = 6;
    b.army_cnt[24] = 40;
    return b;
  };
  const corridor = build();
  assert.equal(isMazeBoard(corridor), true);
  // The fog seat already plays the generic path; a corridor board must match it
  // until the deferred turn instead of switching to the front planner at 28.
  const fog = build();
  fog.fogMode = true;
  assert.deepEqual(chooseOrders(corridor, 40, players, false), chooseOrders(fog, 40, players, false));
  // From the deferred turn the concentrated front planner owns the frame again,
  // which is visible in the different (front) scoring.
  const late = build();
  const lateFog = build();
  lateFog.fogMode = true;
  assert.notDeepEqual(chooseOrders(late, 300, players, false), chooseOrders(lateFog, 300, players, false));
});
