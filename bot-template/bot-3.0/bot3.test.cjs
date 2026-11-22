'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createBoard, chooseOrders } = require('./planner');
const { attachStrategy, MAX_TEAMS } = require('./strategy');
const { rescueValues, assessOpponents, evaluateFrontMove } = require('./single-front');
const { planFinish } = require('./kill');
const { makeOpening } = require('./opening');
const relayPlanner = require('../relay-bot/planner');
const { predict: predictShadow, record: recordShadow } = require('./shadow');
const { isMazeBoard, laneBlocked, laneState, recordLane } = require('./maze');
const { closingConfig, closingUpdate, freshClosing } = require('./closing');
const { landConfig, landContext, swampShare } = require('./land');
const {
  fogConfig,
  fogBoard,
  fogUpdate,
  fogRequired,
  fogBeliefTargets,
  fogRaidUpdate,
  fogPaintCap,
  freshRaid,
  DEFAULT_START_TURN,
  DEFAULT_GUESS,
  DEFAULT_AIM_LEAD,
  DEFAULT_SWAMP_LEAD,
  DEFAULT_PAINT3,
  DEFAULT_PAINT3_SWAMP,
  DEFAULT_PAINT3_UNTIL,
  RAID_SCORE,
} = require('./fog');
const { fogMazeConfig, fogMazeProgress, fogMazeEconomy, fogMazeEconGate } = require('./fog-maze');

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
    // The fixture leaves one exposed enemy crown within reach, so the finish
    // layer is switched off here: this test is about the planner's own
    // construction policy, and the companion test below covers the takeover.
    b.finish = false;
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

// Closing layer. The phase exists to convert a material edge into a kill on a
// compact serial room; see ./closing for the replay diagnosis it encodes.
test('open the closing phase only on a dominated, crown-sprawling serial room', () => {
  assert.deepEqual(closingConfig({}, {}), {
    enabled: true,
    maxBoard: 800,
    startTurn: 60,
    minCrowns: 6,
    armyFloor: 1.35,
    pushTurn: 0,
    pushScale: 0.75,
  });
  assert.equal(closingConfig({}, { BOT3_CLOSING: '0' }).enabled, false);
  assert.equal(closingConfig({}, { BOT3_CLOSING_FLOOR: '1.1' }).armyFloor, 1.1);
  assert.equal(closingConfig({}, { BOT3_CLOSING_TURN: '90' }).startTurn, 90);
  assert.equal(closingConfig({}, { BOT3_CLOSING_PUSH: '250' }).pushTurn, 250);

  const board = { closing: freshClosing() };
  const room = {
    turn: 140,
    multi: false,
    size: 221,
    army: 800,
    enemyArmy: 500,
    enemyCrowns: 7,
    danger: 0,
  };
  assert.equal(closingUpdate(board, room).active, true);
  // A multi-line room, a room that is a war of equals and a threatened home
  // all stay on the baseline plan.
  assert.equal(closingUpdate({ closing: freshClosing() }, { ...room, multi: true }).active, false);
  assert.equal(closingUpdate({ closing: freshClosing() }, { ...room, size: 900 }).active, false);
  assert.equal(closingUpdate({ closing: freshClosing() }, { ...room, army: 600 }).active, false);
  assert.equal(closingUpdate({ closing: freshClosing() }, { ...room, enemyCrowns: 3 }).active, false);
  assert.equal(closingUpdate({ closing: freshClosing() }, { ...room, turn: 40 }).active, false);
  // A threat pauses the plan instead of latching it away for the rest of the
  // game, which is what the first (latched) cut did.
  assert.equal(closingUpdate(board, { ...room, danger: 1 }).active, false);
  assert.equal(board.closing.exit, 'threat');
  assert.equal(closingUpdate(board, room).active, true);
  assert.equal(board.closing.entries, 2);
  assert.equal(closingUpdate(board, room, closingConfig({}, { BOT3_CLOSING: '0' })).active, false);
  // Late-race pressure: the column commits at `pushScale` of the path price
  // once `pushTurn` has passed, and keeps the full staging gate before it.
  assert.equal(closingUpdate({ closing: freshClosing() }, { ...room, turn: 400 }).push, 1);
  const pushCfg = closingConfig({}, { BOT3_CLOSING_PUSH: '250' });
  assert.equal(closingUpdate({ closing: freshClosing() }, { ...room, turn: 100 }, pushCfg).push, 1);
  assert.equal(closingUpdate({ closing: freshClosing() }, { ...room, turn: 250 }, pushCfg).push, 0.75);
});

test('funnel the empire into its heaviest stack and hold it until it can pay', () => {
  const b = createBoard(1, 6, 1);
  b.grid_type.set([101, 1, 1, 200, 102, 102]);
  b.army_cnt.set([2, 40, 200, 0, 5, 3]);
  const fill = (value) => Int32Array.from({ length: b.size }, () => value);
  const state = {
    b,
    units: Float64Array.from(b.army_cnt),
    teams: Uint8Array.from([1, 1, 1, 0, 2, 2]),
    myTeam: 1,
    turn: 200,
    goal: Int32Array.from([3, 2, 2, 1, 0, 0]),
    required: fill(6),
    homeDist: fill(1),
    immediate: fill(0),
    cut: fill(0),
    rescue: fill(0),
    frontDist: fill(0),
    route: Int32Array.from([3, 2, 1, 1, 0, 0]),
    homes: [0],
    danger: [],
    site: -1,
    self: { army: 250, land: 5 },
    rival: { player: { army: 50 }, crowns: [4, 5], otherFront: 0, contact: 0 },
    ffa: false,
    wide: false,
    anchorDist: fill(1),
    enemyDist: Int32Array.from([3, 3, 3, 1, 1, 1]),
    defense: fill(1),
    closing: true,
    lead: 2,
    leadDist: Int32Array.from([2, 1, 0, 1, 2, 3]),
  };
  const merge = {
    i: 1,
    j: 2,
    own: true,
    hostile: false,
    strike: false,
    send: 39,
    remaining: 79,
    support: 2,
    exposure: 0,
    intercept: false,
    base: false,
  };
  assert.ok(evaluateFrontMove(state, merge) >= 1000);
  assert.ok(evaluateFrontMove({ ...state, closing: false }, merge) < 500);
  // Frontier garrisons stay home: only rear stacks are funnelled.
  assert.ok(evaluateFrontMove({ ...state, enemyDist: fill(1) }, merge) < 500);
  // The lead pushes when it can pay for the remaining path and holds when it
  // cannot, so the rear keeps arriving instead of feeding a doomed column.
  const advance = { ...merge, i: 2, j: 3, send: 199, remaining: 199 };
  assert.ok(evaluateFrontMove({ ...state, required: fill(4) }, advance) >= 1000);
  assert.equal(evaluateFrontMove({ ...state, required: fill(400) }, advance), 0);
  // The late-race commitment lowers that price instead of removing it: a path
  // priced at 250 is refused with the full gate and taken at 75% of it.
  assert.equal(evaluateFrontMove({ ...state, required: fill(250) }, advance), 0);
  assert.ok(evaluateFrontMove({ ...state, required: fill(250), push: 0.75 }, advance) >= 1000);
});

test('hand the plan to the closing column only while the layer is on', () => {
  const army = [
    { id: 1, team: 1, army: 300, land: 9, dead: 0 },
    { id: 2, team: 2, army: 90, land: 6, dead: 0 },
  ];
  const build = () => {
    const b = createBoard(3, 6, 1);
    b.grid_type.fill(200);
    b.grid_type[0] = 101;
    b.army_cnt[0] = 20;
    b.grid_type[2] = 1;
    b.army_cnt[2] = 130;
    b.grid_type[3] = 1;
    b.army_cnt[3] = 4;
    b.grid_type[4] = 1;
    b.army_cnt[4] = 60;
    for (let i = 12; i < 18; i++) {
      b.grid_type[i] = 102;
      b.army_cnt[i] = 3;
    }
    return b;
  };
  const board = build();
  const closed = chooseOrders(board, 140, army, false);
  assert.equal(board.closing.active, true);
  assert.ok(closed[0].score >= 1000);
  const off = build();
  process.env.BOT3_CLOSING = '0';
  try {
    const baseline = chooseOrders(off, 140, army, false);
    assert.equal(off.closing.active, false);
    assert.ok(baseline[0].score < closed[0].score);
  } finally {
    delete process.env.BOT3_CLOSING;
  }
});

// Fog single-line layer. It prices the part of a route the fog hides and aims
// the column at the visible front instead of at a crown that is never
// remembered; see ./fog and BOT3_FOG.md for the measured matrix. On by default
// since round 3; `BOT3_FOG=0` restores the round-2 plan byte for byte.
test('price the hidden part of a fog route and keep the layer switchable', () => {
  assert.equal(fogConfig({}, {}).enabled, true);
  assert.equal(fogConfig({}, { BOT3_FOG: '1' }).enabled, true);
  assert.equal(fogConfig({}, { BOT3_FOG: 'off' }).enabled, false);
  const tuned = fogConfig(
    {},
    {
      BOT3_FOG: '1',
      BOT3_FOG_TURN: '220',
      BOT3_FOG_GUESS: '12',
      BOT3_FOG_AIM_LEAD: '40',
      BOT3_FOG_FUNNEL: '1',
    },
  );
  assert.equal(tuned.startTurn, 220);
  assert.equal(tuned.guess, 12);
  assert.equal(tuned.aimLead, 40);
  assert.equal(tuned.funnel, true);
  assert.equal(tuned.column, true);
  const defaults = fogConfig({}, {});
  assert.equal(defaults.startTurn, DEFAULT_START_TURN);
  assert.equal(defaults.guess, DEFAULT_GUESS);
  assert.equal(defaults.aimLead, DEFAULT_AIM_LEAD);
  // A fogged cell reports no defenders, so every remaining step carries the
  // flat reserve and the reserve stops growing at the cap.
  const required = Float64Array.from([10, 20, 30]);
  const goal = Float64Array.from([0, 2, 99]);
  assert.deepEqual(Array.from(fogRequired(required, goal, 5)), [10, 30, 70]);
  assert.deepEqual(Array.from(fogRequired(Float64Array.from([4]), Float64Array.from([1]), 0)), [4]);
});

test('open the fog column only on a late serial fog room with a material edge', () => {
  assert.equal(fogBoard({ fog: [0, 1, 0] }), true);
  assert.equal(fogBoard({ fog: [0, 0, 0] }), false);
  assert.equal(fogBoard({ fog: [0, 0, 0], fogMode: true }), true);
  const board = {};
  const room = { multi: false, size: 221, turn: 200, army: 400, enemyArmy: 300, danger: 0 };
  const config = fogConfig({ enabled: true, floor: 1 }, {});
  assert.equal(fogUpdate(board, room, config).active, true);
  assert.equal(board.fogLayer.entries, 1);
  assert.equal(fogUpdate({}, { ...room, multi: true }, config).active, false);
  assert.equal(fogUpdate({}, { ...room, size: 900 }, config).active, false);
  assert.equal(fogUpdate({}, { ...room, turn: 20 }, config).active, false);
  // Behind on the measured army, or with a home already threatened, the layer
  // stays out of the frame; it pauses rather than latching away the game.
  assert.equal(fogUpdate({}, { ...room, army: 100 }, config).active, false);
  assert.equal(fogUpdate(board, { ...room, danger: 1 }, config).active, false);
  assert.equal(board.fogLayer.exit, 'threat');
  assert.equal(fogUpdate(board, room, config).active, true);
  assert.equal(board.fogLayer.entries, 2);
  assert.equal(fogUpdate({}, room, fogConfig({ enabled: false }, {})).active, false);
});

// Fog scout / memory / raid layer. The belief field is the prior over an
// unseen enemy home: spawn placement in `general-selection.ts` maximises the
// shortest-path distance between the generals, and mountains stay visible in
// fog, so the passable map - and its far region - is known before it is
// explored. These tests pin the field, the gather-then-raid state machine and
// the two room gates that keep the layer off shapes it does not fit.
function beliefBoard(walls = []) {
  const b = createBoard(1, 12, 1);
  b.grid_type.fill(200);
  b.grid_type[0] = 101;
  b.army_cnt[0] = 1;
  for (const wall of walls) b.grid_type[wall] = 201;
  return b;
}

test('aim the fog belief field at the far region and never at our own land', () => {
  const b = beliefBoard();
  const config = fogConfig({ enabled: true, scoutRatio: 0.7, scoutCount: 2, scoutSpread: 3 }, {});
  // Distances 0..11; the 70% band starts at 8 and the spread rule keeps the
  // second anchor three cells away from the first.
  assert.deepEqual(fogBeliefTargets(b, [0], config), [11, 8]);
  // A wall at index 10 cuts the band off: nothing beyond it is reachable, and
  // the remaining band is one cell wide so the spread rule keeps one anchor.
  const walled = beliefBoard([10]);
  assert.deepEqual(fogBeliefTargets(walled, [0], config), [9]);
  // A fully owned corridor has no unknown region left to aim at.
  const owned = beliefBoard();
  owned.grid_type.fill(101);
  assert.deepEqual(fogBeliefTargets(owned, [0], config), []);
});

test('gather a lead stack before raiding and fall back when it is spent', () => {
  const b = {};
  const config = fogConfig({ raid: true, raidMass: 100, raidRatio: 0.5, raidAbort: 0.5 }, {});
  const room = { lead: 5, leadMass: 40, mobileArmy: 100, turn: 90, danger: 0 };
  assert.equal(fogRaidUpdate(b, room, config).phase, 'gather');
  assert.equal(fogRaidUpdate(b, { ...room, leadMass: 120 }, config).phase, 'raid');
  assert.equal(b.fogRaid.entries, 1);
  // The lead was spent below the abort share: back to gathering, not idle.
  assert.equal(fogRaidUpdate(b, { ...room, leadMass: 40 }, config).phase, 'gather');
  // A threatened home pauses the doctrine without losing the learned mass.
  assert.deepEqual(
    [fogRaidUpdate(b, { ...room, leadMass: 120, danger: 1 }, config).resting, b.fogRaid.phase],
    [true, 'idle'],
  );
  assert.equal(fogRaidUpdate(b, { ...room, lead: -1 }, config).phase, 'idle');
  assert.equal(fogRaidUpdate(b, room, fogConfig({ raid: false }, {})).phase, 'idle');
  assert.deepEqual(freshRaid(), { phase: 'idle', lead: -1, mass: 0, since: -1, entries: 0 });
  assert.ok(RAID_SCORE > 675);
});

test('default the fog belief, spread, crown and raid experiments off', () => {
  const d = fogConfig({}, {});
  assert.equal(d.scout, false);
  assert.equal(d.raid, false);
  assert.equal(d.belief, false);
  assert.equal(d.spread, 0);
  assert.equal(d.homes, 0);
  assert.equal(d.maze, false);
  assert.equal(d.aimLead, DEFAULT_AIM_LEAD);
  assert.equal(d.aimLeadSwamp, DEFAULT_SWAMP_LEAD);
  assert.ok(d.aimLeadSwamp > d.aimLead);
  const tuned = fogConfig({}, { BOT3_FOG_SCOUT: '1', BOT3_FOG_RAID: '1', BOT3_FOG_SPREAD: '4' });
  assert.deepEqual([tuned.scout, tuned.raid, tuned.spread], [true, true, 4]);
});

test('keep the fog layer off corridor boards unless it is asked for', () => {
  const army = [
    { id: 1, team: 1, army: 300, land: 9, dead: 0 },
    { id: 2, team: 2, army: 90, land: 6, dead: 0 },
  ];
  const build = () => {
    const b = createBoard(5, 5, 1);
    b.grid_type.fill(200);
    // Eight walls out of twenty-five is a corridor share (32% > maze's 30%).
    for (const i of [1, 2, 3, 4, 5, 9, 14, 19]) b.grid_type[i] = 201;
    b.grid_type[0] = 101;
    b.army_cnt[0] = 60;
    b.grid_type[6] = 102;
    b.army_cnt[6] = 5;
    b.fogMode = true;
    return b;
  };
  process.env.BOT3_FOG = '1';
  try {
    const off = build();
    chooseOrders(off, 80, army, false);
    assert.equal(off.fogLayer, undefined);
    const on = build();
    process.env.BOT3_FOG_MAZE = '1';
    chooseOrders(on, 80, army, false);
    assert.notEqual(on.fogLayer, undefined);
  } finally {
    delete process.env.BOT3_FOG;
    delete process.env.BOT3_FOG_MAZE;
  }
});

test('never touch a visible board while the fog layer is on', () => {
  const army = [
    { id: 1, team: 1, army: 300, land: 9, dead: 0 },
    { id: 2, team: 2, army: 90, land: 6, dead: 0 },
  ];
  const build = () => {
    const b = createBoard(3, 6, 1);
    b.grid_type.fill(200);
    b.grid_type[0] = 101;
    b.army_cnt[0] = 20;
    b.grid_type[2] = 1;
    b.army_cnt[2] = 130;
    b.grid_type[4] = 1;
    b.army_cnt[4] = 60;
    for (let i = 12; i < 18; i++) {
      b.grid_type[i] = 102;
      b.army_cnt[i] = 3;
    }
    return b;
  };
  process.env.BOT3_FOG = '1';
  try {
    // A visible (non-fog) board never reaches the layer, so it cannot allocate
    // state or change a single score.
    const visible = build();
    chooseOrders(visible, 140, army, false);
    assert.equal(visible.fogLayer, undefined);
    // A fog single-line board does reach it, and switching the layer off again
    // leaves the board state untouched.
    const hidden = build();
    hidden.fogMode = true;
    chooseOrders(hidden, 140, army, false);
    assert.notEqual(hidden.fogLayer, undefined);
    const off = build();
    off.fogMode = true;
    process.env.BOT3_FOG = '0';
    chooseOrders(off, 140, army, false);
    assert.equal(off.fogLayer, undefined);
  } finally {
    delete process.env.BOT3_FOG;
  }
});

// Finish layer fixtures. Owners follow the engine encoding (`50 * owner + kind`),
// so `101`/`102` are a crown of player 1 / player 2 and `1`/`2` plain land.
function finishBoard(kinds, armies, rows = 1) {
  const b = createBoard(rows, kinds.length / rows, 1);
  b.grid_type.set(kinds);
  b.army_cnt.set(armies);
  return b;
}

function finishContext(b, targets, overrides = {}) {
  const teamByOwner = new Map([
    [1, 1],
    [2, 2],
    [3, 3],
  ]);
  const teams = new Uint8Array(b.size).map((_, i) => teamByOwner.get(b.grid_type[i] % 50) ?? 0);
  return {
    turn: 100,
    teams,
    myTeam: 1,
    homes: [0],
    targets,
    cut: new Float64Array(b.size),
    threat: new Float64Array(b.size),
    danger: [],
    teamByOwner,
    rivalTeam: 2,
    ...overrides,
  };
}

test('finish the last enemy crown through open ground with a spare stack', () => {
  const b = finishBoard([101, 1, 200, 200, 102, 200], [5, 40, 0, 0, 3, 0]);
  // The shipped default only allows two-tick routes; the machinery is tested
  // with the wider window the README documents for experiments.
  const plan = planFinish(b, finishContext(b, [4]), { maxEta: 7, surplus: 25 });
  assert.equal(plan.ok, true);
  assert.equal(plan.decap, true);
  // Three ticks of travel, and the crown grows on every one of them.
  assert.equal(plan.eta, 3);
  assert.equal(plan.goal, 4);
  assert.deepEqual([plan.from, plan.to, plan.mode], [1, 2, 2]);
  // 40 - 1 leaves the tap, three arrival guards stay behind, six units of
  // defender growth are paid: 31 units hold the crown.
  assert.equal(plan.delivered, 31);
});

test('decline a route whose stack cannot pay for the defenders on it', () => {
  const b = finishBoard([101, 1, 200, 2, 102, 200], [5, 20, 0, 30, 3, 0]);
  const plan = planFinish(b, finishContext(b, [4]));
  assert.equal(plan.ok, false);
  assert.ok(['no-route', 'no-tap', 'surplus'].includes(plan.reason), plan.reason);
});

test('decline a decapitation the opponent reaches first', () => {
  // Our 60-stack and their 30-stack both neighbour a crown; only the enemy can
  // take ours on the next tick, so the race must be lost.
  const b = finishBoard([101, 200, 1, 102, 2, 200, 200, 200], [5, 0, 60, 20, 30, 0, 0, 0], 2);
  const plan = planFinish(b, finishContext(b, [3]));
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'race');
});

test('decline a stale fog memory and hidden ground on the route', () => {
  const b = finishBoard([101, 1, 200, 200, 102, 200], [5, 40, 0, 0, 3, 0]);
  b.fogMode = true;
  b.fog[4] = 1;
  assert.equal(planFinish(b, finishContext(b, [4])).reason, 'no-goal');
  b.fog[4] = 0;
  b.fog[2] = 1;
  const plan = planFinish(b, finishContext(b, [4]), { maxEta: 7, surplus: 25 });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'no-route');
});

test('decline a long expedition from a single crown but take the decapitation', () => {
  // Two enemy crowns: the far one is a normal capture, not a decapitation.
  const b = finishBoard([101, 1, 200, 200, 102, 200, 102], [5, 200, 0, 0, 3, 0, 3]);
  const plan = planFinish(b, finishContext(b, [4, 6]), { maxEta: 7, surplus: 25 });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'sole-crown');
  // A second own crown removes the objection; the surplus then decides.
  b.grid_type[6] = 101;
  b.army_cnt[6] = 5;
  assert.equal(planFinish(b, finishContext(b, [4]), { maxEta: 7, surplus: 25 }).ok, true);
});

test('refuse a corridor that an enemy stack can cut before the column arrives', () => {
  const b = finishBoard([101, 1, 1, 200, 102, 200, 102, 101], [5, 40, 10, 0, 3, 0, 3, 5]);
  const cut = new Float64Array(b.size);
  cut[2] = 40;
  const threat = new Float64Array(b.size);
  threat[2] = 90;
  const plan = planFinish(b, finishContext(b, [4, 6], { cut, threat, homes: [0, 7] }), {
    maxEta: 7,
    surplus: 25,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'cut');
});

test('order the kill step before construction and expansion', () => {
  const b = finishBoard([101, 1, 200, 102], [5, 300, 0, 3]);
  // Off by default: the same board only produces the strike when asked.
  assert.ok(!chooseOrders(b, 100, players, false).some((op) => op.score === 3000));
  b.finish = true;
  const [order] = chooseOrders(b, 100, players, false);
  assert.deepEqual([order.from, order.to, order.mode, order.score], [1, 2, 2, 3000]);
  b.finish = false;
  assert.ok(!chooseOrders(b, 100, players, false).some((op) => op.score === 3000));
});

// --- Multi-line economy layer (./multi) -------------------------------------
const { multiConfig, multiUpdate, applyMulti, crownRoute, teamCuts, freshMulti } = require('./multi');

function multiContext(overrides = {}) {
  const b = createBoard(1, 5, 1);
  b.grid_type.set([101, 1, 200, 2, 102]);
  b.army_cnt.set([10, 30, 0, 6, 3]);
  const teams = new Uint8Array([1, 1, 0, 2, 2]);
  const units = new Float64Array([10, 30, 0, 6, 3]);
  return {
    b,
    teams,
    units,
    input: {
      turn: 30,
      multi: true,
      size: b.size,
      units,
      teams,
      myTeam: 1,
      targets: [4],
      mobileArmy: 34,
    },
    ctx: {
      tile: b.grid_type,
      teams,
      units,
      neighbors: b.neighbors,
      myTeam: 1,
      frontDist: new Int32Array([3, 2, 1, 2, 3]),
    },
    ...overrides,
  };
}

test('multi-line layer is off after the burst removal and clamps its own environment', () => {
  const off = multiConfig({}, {});
  assert.equal(off.enabled, false);
  assert.equal(multiConfig({}, { BOT3_MULTI: '1' }).enabled, true);
  assert.deepEqual(
    [off.burstGain, off.raidBonus, off.mergePenalty, off.marchGain, off.marchBase, off.cut],
    [2, 400, 100, 0, 15, 0],
  );
  const on = multiConfig(
    {},
    { BOT3_MULTI: '1', BOT3_MULTI_RAID: '900', BOT3_MULTI_MARCH: '4', BOT3_MULTI_FOCUS: 'off' },
  );
  assert.equal(on.enabled, true);
  assert.equal(on.raidBonus, 900);
  assert.equal(on.marchGain, 4);
  assert.equal(on.focus, false);
  const clamped = multiConfig({}, { BOT3_MULTI_RAID: '-5', BOT3_MULTI_BUILD: 'abc' });
  assert.equal(clamped.raidBonus, 0);
  assert.equal(clamped.buildPenalty, 220);
});

test('only burst and focus turns of a multi-line room reach the layer', () => {
  const on = multiConfig({ enabled: true, burst: true }, {});
  const { b, input } = multiContext();
  assert.equal(multiUpdate(b, { ...input, multi: false }, on), null);
  assert.equal(multiUpdate(b, input, multiConfig({}, { BOT3_MULTI: '0' })), null);
  assert.equal(multiUpdate(b, { ...input, turn: 12 }, on), null);
  const big = multiContext({ input: { ...input, size: 900 } });
  assert.equal(multiUpdate(big.b, big.input, on), null);
  const burst = multiUpdate(b, input, on);
  assert.deepEqual([burst.burst, burst.worth, burst.focus], [true, 20, false]);
  assert.equal(b.multiLine.burstTicks, 1);
  const later = multiContext();
  const focus = multiUpdate(later.b, { ...later.input, turn: 60 }, on);
  assert.deepEqual([focus.burst, focus.focus], [false, true]);
  assert.ok(focus.route[4] < focus.route[0]);
});

test('the fog burst gate only releases the burst while the army race is held', () => {
  const base = multiContext();
  const at = (army, enemyArmy, fog) => multiContext({ input: { ...base.input, army, enemyArmy, fog } });
  const config = multiConfig({ enabled: true, burst: true, burstFog: true, burstFogLead: 100 }, {});
  const behind = at(58, 108, true);
  assert.equal(multiUpdate(behind.b, behind.input, config), null);
  const ahead = at(140, 108, true);
  assert.equal(multiUpdate(ahead.b, ahead.input, config).burst, true);
  const clear = at(58, 108, false);
  assert.equal(multiUpdate(clear.b, clear.input, config).burst, true);
  const off = multiConfig({ enabled: true, burst: true, burstFog: false }, {});
  const ungated = at(58, 108, true);
  assert.equal(multiUpdate(ungated.b, ungated.input, off).burst, true);
});

test('burst scoring paints cheap neutrals and stops banking army into a crown', () => {
  const config = multiConfig({ enabled: true, burst: true }, {});
  const { b, input } = multiContext();
  const plan = multiUpdate(b, input, config);
  const candidates = [
    { score: 300, from: 1, to: 1, mode: 2, build: 'b' },
    { score: 62, from: 1, to: 2, mode: 2 },
    { score: 62, from: 4, to: 3, mode: 2 },
    { score: 40, from: 0, to: 1, mode: 2 },
  ];
  applyMulti(plan, multiContext().ctx, candidates);
  assert.equal(candidates[0].score, 300 - config.buildPenalty);
  // A free neutral pays the rest of the burst; its neighbours are already
  // owned by either side, so no breadth bonus applies.
  assert.equal(candidates[1].score, 62 + 2 * 20);
  // Raiding a rival cell is worth a full raid bonus on top of its capture.
  assert.equal(candidates[2].score, 62 + config.raidBonus);
  // Stacking our own frontier loses a slot, and outward merges keep the front.
  assert.equal(
    candidates[3].score,
    40 - config.mergePenalty + config.outwardBase + Math.sqrt(10) * config.outwardGain,
  );
  // The outward bonus is what makes a merge into the frontier bearable: the
  // same merge away from it only pays the penalty.
  assert.ok(candidates[3].score > 40 - config.mergePenalty);
});

test('focus scoring refuses paint and prices the march by its remaining ground', () => {
  const config = multiConfig({ enabled: true }, {});
  const b = createBoard(1, 7, 1);
  b.grid_type.set([200, 200, 1, 1, 1, 1, 102]);
  b.army_cnt.set([0, 0, 4, 4, 4, 4, 6]);
  const teams = new Uint8Array([0, 0, 1, 1, 1, 1, 2]);
  const units = new Float64Array([0, 0, 4, 4, 4, 4, 6]);
  const input = {
    turn: 60,
    multi: true,
    size: b.size,
    units,
    teams,
    myTeam: 1,
    targets: [6],
    mobileArmy: 20,
  };
  const plan = multiUpdate(b, input, config);
  assert.deepEqual(Array.from(plan.route.slice(2)), [10, 8, 6, 4, 0]);
  const candidates = [
    { score: 300, from: 2, to: 1, mode: 2 },
    { score: 300, from: 5, to: 6, mode: 2 },
    { score: 300, from: 3, to: 4, mode: 2 },
    { score: 300, from: 4, to: 5, mode: 2 },
  ];
  applyMulti(plan, { tile: b.grid_type, teams, units, neighbors: b.neighbors, myTeam: 1 }, candidates);
  assert.equal(candidates[0].score, 300 - config.paintPenalty);
  // A march onto the rival crown is a strike, not a march: the layer leaves it
  // to the planner's own (higher) siege and campaign scores.
  assert.equal(candidates[1].score, 300);
  // The rest of the path pays a base bonus minus two per remaining step.
  assert.equal(candidates[2].score, 300 + config.marchBase - 2 * plan.route[4]);
  assert.equal(candidates[3].score, 300 + config.marchBase - 2 * plan.route[5]);
  assert.ok(candidates[3].score > candidates[2].score);
});

test('price a rival cell by the army its capture severs from the rival anchors', () => {
  const b = createBoard(1, 7, 1);
  b.grid_type.set([200, 200, 2, 2, 2, 2, 102]);
  b.army_cnt.set([0, 0, 3, 3, 3, 3, 3]);
  const teams = new Uint8Array([0, 0, 2, 2, 2, 2, 2]);
  const units = new Float64Array([0, 0, 3, 3, 3, 3, 3]);
  const lost = teamCuts(b, teams, units, 2);
  assert.deepEqual(Array.from(lost), [0, 0, 0, 5, 10, 15, 20]);
  const route = crownRoute(b, [6], units, teams, 1, 10);
  assert.deepEqual(Array.from(route), [12, 10, 8, 6, 4, 2, 0]);
});

test('serial rooms stay byte-identical while the multi layer is enabled', () => {
  const make = () => {
    const b = createBoard(1, 6, 1);
    b.grid_type.set([101, 1, 1, 200, 2, 102]);
    b.army_cnt.set([10, 40, 1, 0, 20, 5]);
    return b;
  };
  const serial = chooseOrders(make(), 44, players, false);
  process.env.BOT3_MULTI = '1';
  try {
    const enabled = make();
    assert.deepEqual(chooseOrders(enabled, 44, players, false), serial);
    assert.equal(enabled.multiLine, undefined);
    const multi = make();
    chooseOrders(multi, 44, players, true);
    assert.equal(multi.multiLine, undefined);
    chooseOrders(multi, 60, players, true);
    assert.ok(multi.multiLine instanceof Object);
    assert.equal(multi.multiLine.burstTicks, 0);
  } finally {
    delete process.env.BOT3_MULTI;
  }
});

test('fresh ledger starts empty', () => {
  assert.deepEqual(freshMulti(), { ticks: 0, burstTicks: 0, focusTicks: 0, entered: null });
});

// --- Fog multi-line layer (./fog-multi) -------------------------------------
const {
  fogMultiConfig,
  fogMultiTargets,
  fogMultiBurst,
  fogMultiUpdate,
  freshFogMulti,
  DEFAULT_LAND_SLACK,
} = require('./fog-multi');

// A small fog board whose passable map reaches two far corners, so the belief
// field has somewhere to point.
function fogMultiBoard() {
  const b = createBoard(3, 5, 1);
  b.fogMode = true;
  b.grid_type.set([101, 1, 200, 200, 200, 200, 200, 200, 201, 200, 200, 200, 200, 200, 102]);
  b.army_cnt.set([10, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5]);
  b.fog.fill(1);
  return b;
}

test('fog multi layer is off after the burst removal and clamps its knobs', () => {
  assert.equal(fogMultiConfig({}, {}).enabled, false);
  assert.equal(fogMultiConfig({}, { BOT3_FOG_MULTI: '1' }).enabled, true);
  assert.equal(fogMultiConfig({}, { BOT3_FOG_MULTI: '0' }).enabled, false);
  assert.equal(fogMultiConfig({}, { BOT3_FOG_MULTI: '1' }).enabled, true);
  assert.equal(fogMultiConfig({}, { BOT3_FOG_MULTI: 'off' }).enabled, false);
  const defaults = fogMultiConfig({ enabled: true }, {});
  assert.equal(defaults.burst, true);
  assert.equal(defaults.landSlack, DEFAULT_LAND_SLACK);
  assert.equal(defaults.armyLead, 0);
  // The belief route measured negative in a multi room, so it stays off.
  assert.equal(defaults.route, false);
  const tuned = fogMultiConfig(
    { enabled: true },
    { BOT3_FOG_MULTI_LAND: '0.5', BOT3_FOG_MULTI_LEAD: '80', BOT3_FOG_MULTI_ROUTE: '1' },
  );
  assert.deepEqual([tuned.landSlack, tuned.armyLead, tuned.route], [0.5, 80, true]);
  const clamped = fogMultiConfig(
    { enabled: true },
    { BOT3_FOG_MULTI_LAND: '-3', BOT3_FOG_MULTI_COUNT: '99' },
  );
  assert.equal(clamped.landSlack, 0);
  assert.equal(clamped.count, 8);
});

test('release the fog burst while the land race is open, not while army trails', () => {
  const config = fogMultiConfig({ enabled: true, landSlack: 0.1 });
  // No rival land is known: nothing to price, release.
  assert.equal(fogMultiBurst({ turn: 30, land: 20, enemyLand: 0, army: 0, enemyArmy: 0 }, config), true);
  // Level or behind on land: the race is open, even when the army trails.
  assert.equal(fogMultiBurst({ turn: 30, land: 20, enemyLand: 20, army: 50, enemyArmy: 200 }, config), true);
  assert.equal(fogMultiBurst({ turn: 30, land: 19, enemyLand: 25, army: 50, enemyArmy: 200 }, config), true);
  // Twice the rival's land: the race is won, so the paint is garrison spent.
  assert.equal(
    fogMultiBurst({ turn: 30, land: 100, enemyLand: 50, army: 400, enemyArmy: 200 }, config),
    false,
  );
  // Outside the burst window the multi layer keeps its own gate.
  assert.equal(fogMultiBurst({ turn: 24, land: 5, enemyLand: 5 }, config), undefined);
  assert.equal(fogMultiBurst({ turn: 51, land: 5, enemyLand: 5 }, config), undefined);
  // An explicit army floor re-adds the army race on top of the land race.
  const pinned = fogMultiConfig({ enabled: true, landSlack: 10, armyLead: 80 });
  assert.equal(fogMultiBurst({ turn: 30, land: 10, enemyLand: 10, army: 100, enemyArmy: 100 }, pinned), true);
  assert.equal(fogMultiBurst({ turn: 30, land: 10, enemyLand: 10, army: 70, enemyArmy: 100 }, pinned), false);
});

test('only fog multi rooms reach the fog multi layer', () => {
  const config = fogMultiConfig({ enabled: true });
  const b = fogMultiBoard();
  const room = { turn: 30, multi: true, fog: true, size: b.size, land: 2, enemyLand: 4, homes: [0] };
  assert.ok(fogMultiUpdate(b, room, config));
  assert.equal(fogMultiUpdate(fogMultiBoard(), room, fogMultiConfig({}, { BOT3_FOG_MULTI: '0' })), null);
  assert.equal(fogMultiUpdate(fogMultiBoard(), { ...room, multi: false }, config), null);
  assert.equal(fogMultiUpdate(fogMultiBoard(), { ...room, fog: false }, config), null);
  assert.equal(fogMultiUpdate(fogMultiBoard(), { ...room, size: 900 }, config), null);
  // An open land race releases the burst; a decided one gates it.
  const open = fogMultiUpdate(fogMultiBoard(), room, config);
  assert.equal(open.burst, true);
  assert.deepEqual([open.targets.length, open.source], [0, null]);
  const won = fogMultiUpdate(fogMultiBoard(), { ...room, land: 40, enemyLand: 10 }, config);
  assert.equal(won.burst, false);
});

test('a fog focus objective falls back to the visible frontier, then the belief field', () => {
  const b = fogMultiBoard();
  const config = fogMultiConfig({ enabled: true, route: true, count: 1, spread: 1 });
  const front = fogMultiTargets(b, { enemies: [13, 14], homes: [0] }, config);
  assert.deepEqual([front.targets, front.source], [[13], 'front']);
  const belief = fogMultiTargets(b, { enemies: [], homes: [0] }, config);
  assert.equal(belief.source, 'belief');
  assert.equal(belief.targets.length, 1);
  // The visible frontier is measured information: without it the prior takes
  // over, and with no crown of our own there is nothing to aim from.
  const noFront = fogMultiTargets(b, { enemies: [], homes: [0] }, { ...config, front: false });
  assert.equal(noFront.source, 'belief');
  assert.deepEqual(fogMultiTargets(b, { enemies: [], homes: [] }, config).targets, []);
  // Post-burst the layer hands the anchors to the multi layer, which needs a
  // remembered crown to be absent and the route switch to be on.
  const late = { turn: 60, multi: true, fog: true, size: b.size, homes: [0], targets: [] };
  assert.equal(fogMultiUpdate(b, late, config).targets.length, 1);
  assert.equal(fogMultiUpdate(b, late, { ...config, route: false }), null);
  assert.equal(fogMultiUpdate(b, { ...late, targets: [14] }, config), null);
  // Releasing the burst stays on the focus turn even without a route.
  const noRoute = fogMultiUpdate(b, late, { ...config, route: false, burst: true });
  assert.equal(noRoute, null);
  const burstTurn = fogMultiUpdate(b, { ...late, turn: 40 }, { ...config, route: false });
  assert.equal(burstTurn.burst, true);
});

test('the planner fog burst verdict overrides the multi layer fog gate', () => {
  const config = multiConfig({ enabled: true, burst: true, burstFog: true, burstFogLead: 100 }, {});
  const { b, input } = multiContext();
  const behind = { ...input, fog: true, army: 58, enemyArmy: 108 };
  assert.equal(multiUpdate(multiContext().b, behind, config), null);
  // `fog-multi` releases the burst on a land race and gates it on archipelago.
  assert.equal(multiUpdate(multiContext().b, { ...behind, fogBurst: true }, config).burst, true);
  assert.equal(multiUpdate(multiContext().b, { ...behind, fogBurst: false }, config), null);
  // The multi layer still owns the rest of the room.
  const ahead = { ...input, fog: true, army: 140, enemyArmy: 108 };
  assert.equal(multiUpdate(multiContext().b, ahead, config).burst, true);
});

test('fresh fog multi ledger starts empty', () => {
  assert.deepEqual(freshFogMulti(), {
    active: false,
    source: null,
    targets: 0,
    since: -1,
    entries: 0,
    burstTicks: 0,
    released: 0,
    gated: 0,
  });
});

test('cap a fog column merge only while the frontier still has neutral land', () => {
  assert.equal(fogPaintCap({ paint: 0, paintFrom: 8 }, 40), Infinity);
  assert.equal(fogPaintCap({ paint: 120, paintFrom: 8 }, 7), Infinity);
  assert.equal(fogPaintCap({ paint: 120, paintFrom: 8 }, 8), 120);
});

test('default the paint-before-advance cap on and allow the pre-round-8 opt-out', () => {
  // The measured bundle is the default: it is the only setting that reaches the
  // 65% Relay target with no regressing cell (see BOT3_FOG.md).
  const on = fogConfig({}, {});
  assert.deepEqual(
    [on.paint, on.paintFrom, on.paintSwamp, on.paintUntil, on.paintArmy],
    [DEFAULT_PAINT3, 8, DEFAULT_PAINT3_SWAMP, DEFAULT_PAINT3_UNTIL, 0],
  );
  const off = fogConfig({}, { BOT3_FOG_PAINT3: '0' });
  assert.deepEqual(
    [off.paint, off.paintFrom, off.paintSwamp, off.paintUntil, off.paintArmy],
    [0, 8, 0, 0, 0],
  );
  const bundle = fogConfig({}, { BOT3_FOG_PAINT3: '1' });
  assert.deepEqual(
    [bundle.paint, bundle.paintSwamp, bundle.paintUntil],
    [DEFAULT_PAINT3, DEFAULT_PAINT3_SWAMP, DEFAULT_PAINT3_UNTIL],
  );
  const over = fogConfig({}, { BOT3_FOG_PAINT3: '1', BOT3_FOG_PAINT: '90', BOT3_FOG_PAINT_SWAMP: '0' });
  assert.deepEqual([over.paint, over.paintSwamp, over.paintUntil], [90, 0, DEFAULT_PAINT3_UNTIL]);
});

test('stand the corridor layer down only inside the land-behind window', () => {
  const config = fogMazeConfig({}, { BOT3_FOG_MAZE_LAYER: '1', BOT3_FOG_MAZE_BEHIND: '90' });
  const input = { land: 33, enemyLand: 40, army: 300, enemyArmy: 300, neutralFront: 5 };
  const b = {};
  assert.equal(fogMazeProgress(b, { ...input, turn: 60 }, config).stalled, true);
  assert.equal(fogMazeProgress({}, { ...input, turn: 40 }, config).stalled, false);
  assert.equal(fogMazeProgress({}, { ...input, turn: 90 }, config).stalled, false);
  // The verdict latches: a recovered land count does not reopen the layer.
  assert.equal(fogMazeProgress(b, { ...input, turn: 120, land: 60, enemyLand: 40 }, config).stalled, true);
});

test('stand the corridor layer down once the rival material takes off', () => {
  const config = fogMazeConfig({}, { BOT3_FOG_MAZE_LAYER: '1', BOT3_FOG_MAZE_ARMY_BEHIND: '200' });
  const input = { land: 50, enemyLand: 48, neutralFront: 5 };
  const b = {};
  assert.equal(fogMazeProgress(b, { ...input, turn: 240, army: 900, enemyArmy: 400 }, config).stalled, false);
  assert.equal(fogMazeProgress(b, { ...input, turn: 260, army: 400, enemyArmy: 900 }, config).stalled, true);
});
// --- shadow layer (./shadow) -------------------------------------------------

// Two-player leaderboard the shadow needs to identify relay's seat.
const shadowPlayers = [
  { id: 1, team: 1, army: 10, land: 1, dead: 0 },
  { id: 2, team: 2, army: 10, land: 1, dead: 0 },
];

const ownerOf = (code) => (code < 200 ? code % 50 : 0);

// A 3x3 duel: our crown in one corner, relay's in the other, open ground in
// between. Relay's planner expands toward us, which the shadow replays.
function shadowBoard() {
  const b = createBoard(3, 3, 1);
  b.grid_type.fill(200);
  b.grid_type[0] = 101;
  b.grid_type[8] = 102;
  b.army_cnt[0] = 10;
  b.army_cnt[8] = 10;
  b.openingBudget = 160000;
  return b;
}

// Apply the predicted order the way the engine would; growth is zero for plain
// land on the early turns used here and the target of a capture is neutral.
function applyPrediction(b, pred) {
  if (pred.build) {
    b.army_cnt[pred.from] -= 50;
    b.grid_type[pred.from] = 51;
    return;
  }
  const push = Math.max(0, b.army_cnt[pred.from] - 1);
  b.army_cnt[pred.from] -= push;
  const to = pred.to;
  if (ownerOf(b.grid_type[to]) === 2) {
    b.army_cnt[to] += push;
    return;
  }
  const defense = b.army_cnt[to];
  if (push > defense) {
    b.army_cnt[to] = push - defense;
    b.grid_type[to] = 2;
  } else b.army_cnt[to] = defense - push;
}

function withShadow(run) {
  const saved = {};
  for (const key of ['BOT3_SHADOW', 'BOT3_SHADOW_ARM', 'BOT3_SHADOW_MIRROR']) saved[key] = process.env[key];
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('shadow layer is inert when disabled with BOT3_SHADOW=0', () =>
  withShadow(() => {
    process.env.BOT3_SHADOW = '0';
    const b = shadowBoard();
    assert.equal(predictShadow(b, 0, shadowPlayers, false), null);
    assert.equal(b.shadow, undefined);
  }));

test('shadow layer is on by default', () =>
  withShadow(() => {
    delete process.env.BOT3_SHADOW;
    const b = shadowBoard();
    const pred = predictShadow(b, 0, shadowPlayers, false);
    assert.ok(pred, 'default configuration predicts an order');
    assert.equal(pred.armed, false, 'the strict arming streak still starts at zero');
  }));

test('shadow replays the relay planner order for the same frame', () =>
  withShadow(() => {
    process.env.BOT3_SHADOW = '1';
    const b = shadowBoard();
    const pred = predictShadow(b, 0, shadowPlayers, false);
    // Independent relay board fed the same frame.
    const reference = relayPlanner.createBoard(3, 3, 2);
    reference.openingBudget = 160000;
    reference.fogMode = false;
    reference.grid_type.set(b.grid_type);
    reference.army_cnt.set(b.army_cnt);
    const [order] = relayPlanner.chooseOrders(reference, 0, shadowPlayers, false);
    assert.ok(order, 'relay plans an order on the opening frame');
    assert.deepEqual([pred.from, pred.to, pred.mode], [order.from, order.to, order.mode]);
    assert.equal(pred.armed, false);
  }));

test('shadow refuses fog, multi-line and non-duel rooms', () =>
  withShadow(() => {
    process.env.BOT3_SHADOW = '1';
    const foggy = shadowBoard();
    foggy.fog[3] = 1;
    assert.equal(predictShadow(foggy, 0, shadowPlayers, false), null);
    assert.equal(predictShadow(shadowBoard(), 0, shadowPlayers, true), null);
    const ffa = [...shadowPlayers, { id: 3, team: 3, army: 10, land: 1, dead: 0 }];
    assert.equal(predictShadow(shadowBoard(), 0, ffa, false), null);
  }));

test('shadow stays inert when the opponent does not follow its plan', () =>
  withShadow(() => {
    process.env.BOT3_SHADOW = '1';
    const b = shadowBoard();
    for (let turn = 0; turn < 30; turn++) {
      const pred = predictShadow(b, turn, shadowPlayers, false);
      recordShadow(b, turn, []);
      // A different bot does something else entirely: the predicted source cell
      // is untouched, which the guard classifies as a dropped order, never as
      // evidence that this is relay.
      if (pred) assert.equal(pred.armed, false);
    }
    assert.equal(b.shadow.armed, false);
    assert.equal(b.shadow.stats.drift, 0);
    assert.equal(b.shadow.verified, 0);
  }));

test('shadow arms only after a strict streak of exact executions', () =>
  withShadow(() => {
    process.env.BOT3_SHADOW = '1';
    process.env.BOT3_SHADOW_ARM = '6';
    const b = shadowBoard();
    let armed = -1;
    for (let turn = 0; turn < 40 && armed < 0; turn++) {
      const pred = predictShadow(b, turn, shadowPlayers, false);
      recordShadow(b, turn, []);
      if (!pred) continue;
      // Strict gate: nothing is priced before the sixth consecutive exact frame.
      if (b.shadow.streak < 6) assert.equal(pred.armed, false);
      if (pred.armed) armed = turn;
      else applyPrediction(b, pred);
    }
    assert.ok(armed > 0, 'the layer armed after the strict streak');
    assert.equal(b.shadow.armed, true);
    assert.ok(b.shadow.streak >= 6);
    assert.ok(typeof b.shadow.stats.armedTurn === 'number');
  }));

test('shadow stays unarmed when the two economies are not mirrors', () =>
  withShadow(() => {
    process.env.BOT3_SHADOW = '1';
    process.env.BOT3_SHADOW_ARM = '6';
    process.env.BOT3_SHADOW_MIRROR = '1';
    // Our board plays relay's plan, but the leaderboard says the two sides are
    // nowhere near mirrored (a relay-derived bot with its own policy).
    const skewed = [
      { id: 1, team: 1, army: 40, land: 9, dead: 0 },
      { id: 2, team: 2, army: 120, land: 4, dead: 0 },
    ];
    const b = shadowBoard();
    for (let turn = 0; turn < 40; turn++) {
      const pred = predictShadow(b, turn, skewed, false);
      recordShadow(b, turn, []);
      if (!pred) continue;
      if (pred.armed) assert.fail('a skewed economy must not arm the layer');
      applyPrediction(b, pred);
    }
    assert.equal(b.shadow.armed, false);
    assert.ok(b.shadow.streak >= 6, 'the streak itself still completes');
  }));

test('shadow disables itself on the first unexplained frame', () =>
  withShadow(() => {
    process.env.BOT3_SHADOW = '1';
    process.env.BOT3_SHADOW_ARM = '6';
    const b = shadowBoard();
    let armed = -1;
    for (let turn = 0; turn < 40 && armed < 0; turn++) {
      const pred = predictShadow(b, turn, shadowPlayers, false);
      recordShadow(b, turn, []);
      if (!pred) continue;
      if (pred.armed) armed = turn;
      else applyPrediction(b, pred);
    }
    assert.ok(armed > 0);
    // One frame whose army change matches neither "executed" nor "dropped"
    // proves the shadow is out of sync: the layer is gone for good.
    let turn = armed + 1;
    let inject = -1;
    let disabled = false;
    while (turn < armed + 10 && !disabled) {
      const pred = predictShadow(b, turn, shadowPlayers, false);
      recordShadow(b, turn, []);
      if (inject >= 0) {
        b.army_cnt[inject] += 7;
        inject = -1;
      }
      disabled = b.shadow.ok === false;
      if (pred && !disabled) inject = pred.from;
      turn++;
    }
    assert.equal(disabled, true);
    assert.equal(b.shadow.stats.drift, 1);
    assert.equal(b.shadow.armed, false);
  }));

// Two visible own crowns, so `ours` reads 2 without any fog trickery.
function economyFixture() {
  return { size: 4, me: 1, grid_type: Int32Array.from([101, 201, 200, 101]) };
}

// Feed a rival army sequence from `start` and return the ledger's last read.
function feedEconomy(b, start, deltas) {
  let army = 400;
  let last = null;
  for (const [index, delta] of deltas.entries()) {
    last = fogMazeEconomy(b, { turn: start + index, enemyArmy: army });
    army += delta;
  }
  return last;
}

test('read the rival crown income from the unfogged army deltas', () => {
  const b = economyFixture();
  // A steady three-crown rival: every non-growth tick pays exactly +3.
  const steady = feedEconomy(
    b,
    60,
    Array.from({ length: 20 }, () => 3),
  );
  assert.equal(steady.ours, 2);
  assert.equal(steady.bound, 3);
  // One isolated-cell reconnection more than doubles a stack in a single tick
  // (`game-engine.ts`), which is not income: the median ignores it.
  const doubled = feedEconomy(economyFixture(), 60, [
    ...Array.from({ length: 10 }, () => 3),
    41,
    3,
    3,
    3,
    3,
    3,
  ]);
  assert.equal(doubled.bound, 3);
  // A rival that keeps building crowns lifts the median with it.
  const growing = feedEconomy(economyFixture(), 60, [
    ...Array.from({ length: 8 }, () => 3),
    ...Array.from({ length: 24 }, () => 9),
  ]);
  assert.equal(growing.bound, 9);
});

test('ignore growth ticks and gaps in the crown ledger', () => {
  const growth = feedEconomy(economyFixture(), 46, [40, 40, 40, 40]);
  // Turns 46-49 are the burst window: no delta is read at all.
  assert.equal(growth.window.length, 0);
  assert.equal(growth.bound, 1);
  const b = economyFixture();
  fogMazeEconomy(b, { turn: 60, enemyArmy: 400 });
  fogMazeEconomy(b, { turn: 100, enemyArmy: 900 });
  assert.equal(b.fogMazeEconomy.window.length, 0);
  assert.equal(fogMazeEconGate(b.fogMazeEconomy, 100, fogMazeConfig({ econ: 4 }, {})), false);
});

test('stand the corridor layer down when the rival economy outgrows ours', () => {
  const config = fogMazeConfig({}, { BOT3_FOG_MAZE_LAYER: '1', BOT3_FOG_MAZE_ECON: '4' });
  const rival = feedEconomy(
    economyFixture(),
    60,
    Array.from({ length: 20 }, () => 5),
  );
  // The exact anti shape: four crowns against our two.
  assert.equal(fogMazeEconGate(rival, 80, config), true);
  // Our own economy matching the rival keeps the layer.
  assert.equal(fogMazeEconGate({ bound: 5, ours: 5 }, 80, config), false);
  // A three-crown corridor rival is the relay shape and is not a stand-down.
  assert.equal(fogMazeEconGate({ bound: 3, ours: 2 }, 300, config), false);
  // The gate is switched off with the knob at 0.
  assert.equal(fogMazeEconGate(rival, 80, fogMazeConfig({}, { BOT3_FOG_MAZE_ECON: '0' })), false);
});

test('default the maze fog bundle on with the crown-economy gate armed', () => {
  // Round 11 makes the bundle the shipped default: the layer plus the paint cap
  // plus the gate, which removes its one measured regression (see BOT3_MAZE.md).
  const on = fogMazeConfig({}, {});
  assert.equal(on.enabled, true);
  assert.equal(on.econ, 4);
  assert.equal(on.paint, 120);
  const off = fogMazeConfig({}, { BOT3_MAZEFOG3: '0' });
  assert.equal(off.enabled, false);
  assert.equal(off.econ, 0);
  assert.equal(off.paint, 0);
  // The bare round-7 layer (`BOT3_MAZEFOG3=0` + `BOT3_FOG_MAZE_LAYER=1`) keeps
  // its measured path: no gate, no paint cap.
  const layer = fogMazeConfig({}, { BOT3_MAZEFOG3: '0', BOT3_FOG_MAZE_LAYER: '1' });
  assert.equal(layer.enabled, true);
  assert.equal(layer.econ, 0);
  assert.equal(layer.paint, 0);
  assert.equal(fogMazeConfig({}, { BOT3_FOG_MAZE_LAYER: '1', BOT3_FOG_MAZE_ECON: '6' }).econ, 6);
});

// Land-first layer (see ./land and LAND.md). The only knob that survived the
// sixteen-seed swamp screen is the closing stand-down; the capture boost, the
// clear-room paint cap and the island crowns stay opt-in with their measured
// verdicts. These tests pin the room gate and the stand-down hand-off.
test('arm the land-first layer only on a structurally swamp-heavy clear serial room', () => {
  assert.equal(landConfig({}, {}).landfirst, true);
  assert.equal(landConfig({}, { BOT3_LANDFIRST: '0' }).landfirst, false);
  // The measured-negative knobs default to off and stay addressable.
  assert.equal(landConfig({}, {}).capture, 0);
  assert.equal(landConfig({}, {}).paint, 0);
  assert.equal(landConfig({}, { BOT3_LAND_CAPTURE: '130' }).capture, 130);
  assert.equal(landConfig({}, { BOT3_LAND_PAINT: '155' }).paint, 155);
  assert.equal(landConfig({}, { BOT3_LAND_BURST: '0' }).burst, 0);
  assert.equal(landConfig({}, { BOT3_LAND_CLOSE_SKIP: '0' }).closeSkip, 0);
  assert.equal(landConfig({}, { BOT3_LAND_CLOSE_UNTIL: '200' }).closeUntil, 200);

  const b = createBoard(6, 10, 1);
  b.grid_type.fill(200);
  for (let i = 0; i < 24; i++) b.grid_type[i] = 204;
  assert.equal(swampShare(b), 0.4);
  const room = {
    turn: 140,
    multi: false,
    clearSerial: true,
    single: true,
    size: b.size,
    land: 12,
    enemyLand: 15,
    neutral: 4,
  };
  const config = landConfig({}, {});
  assert.equal(landContext(b, room, config).heavy, true);
  assert.equal(landContext(b, room, config).trail, true);
  assert.equal(landContext(b, room, config).closeSkip, true);
  // Ahead on land, or before the front planner opens, the layer stands down.
  assert.equal(landContext(b, { ...room, land: 16 }, config).closeSkip, false);
  assert.equal(landContext(b, { ...room, single: false }, config).closeSkip, false);
  assert.equal(landContext(b, { ...room, land: 0, enemyLand: 0 }, config).closeSkip, false);
  // Fog, multi-line, an oversized board and an open map are out of scope.
  assert.equal(landContext(b, { ...room, clearSerial: false }, config).closeSkip, false);
  assert.equal(landContext(b, { ...room, multi: true }, config).closeSkip, false);
  assert.equal(landContext(b, { ...room, size: 900 }, config).closeSkip, false);
  const open = createBoard(6, 10, 1);
  open.grid_type.fill(200);
  assert.equal(swampShare(open), 0);
  assert.equal(landContext(open, room, config).heavy, false);
  assert.equal(landContext(open, room, config).closeSkip, false);
  // `BOT3_LANDFIRST=0` makes every field inert.
  assert.equal(landContext(b, room, landConfig({}, { BOT3_LANDFIRST: '0' })).closeSkip, false);
  // The capture boost and the burst window are wired but off by default.
  const capture = landConfig({}, { BOT3_LAND_CAPTURE: '130' });
  assert.equal(landContext(b, room, capture).capture, 130);
  assert.equal(landContext(b, { ...room, enemyLand: 12 }, capture).capture, 0);
  const burst = landConfig({}, { BOT3_LANDBURST: '1' });
  assert.equal(landContext(b, { ...room, turn: 26, single: false }, burst).burst, 220);
  assert.equal(landContext(b, { ...room, turn: 50 }, burst).burst, 0);
  // The stand-down can end: closing returns from `closeUntil` on.
  const late = landConfig({}, { BOT3_LAND_CLOSE_UNTIL: '120' });
  assert.equal(landContext(b, room, late).closeSkip, false);
  assert.equal(landContext(b, { ...room, turn: 119 }, late).closeSkip, true);
});

test('stand the closing column down on a swamp-heavy clear room while land trails', () => {
  const army = (ours, theirs) => [
    { id: 1, team: 1, army: 300, land: ours, dead: 0 },
    { id: 2, team: 2, army: 90, land: theirs, dead: 0 },
  ];
  const swamp = 204;
  const build = (terrain) => {
    const b = createBoard(4, 6, 1);
    b.grid_type.fill(terrain);
    b.grid_type[0] = 101;
    b.army_cnt[0] = 20;
    b.grid_type[1] = 1;
    b.army_cnt[1] = 130;
    b.grid_type[2] = 1;
    b.army_cnt[2] = 4;
    b.grid_type[6] = 1;
    b.army_cnt[6] = 60;
    for (let i = 12; i < 18; i++) {
      b.grid_type[i] = 102;
      b.army_cnt[i] = 3;
    }
    return b;
  };
  // Trailing on the exact leaderboard land race: the funnel stands down.
  const trailing = build(swamp);
  chooseOrders(trailing, 140, army(4, 8), false);
  assert.equal(trailing.closing.active, false);
  // Leading on land, an open board, or the layer switched off keep the funnel.
  const leading = build(swamp);
  chooseOrders(leading, 140, army(12, 8), false);
  assert.equal(leading.closing.active, true);
  const open = build(200);
  chooseOrders(open, 140, army(4, 8), false);
  assert.equal(open.closing.active, true);
  const off = build(swamp);
  process.env.BOT3_LANDFIRST = '0';
  try {
    chooseOrders(off, 140, army(4, 8), false);
    assert.equal(off.closing.active, true);
  } finally {
    delete process.env.BOT3_LANDFIRST;
  }
});

test('price the land-first capture boost and merge cap only when enabled', () => {
  const b = createBoard(1, 6, 1);
  b.grid_type.set([101, 1, 1, 200, 102, 102]);
  b.army_cnt.set([2, 40, 200, 0, 5, 3]);
  const fill = (value) => Int32Array.from({ length: b.size }, () => value);
  const state = {
    b,
    units: Float64Array.from(b.army_cnt),
    teams: Uint8Array.from([1, 1, 1, 0, 2, 2]),
    myTeam: 1,
    turn: 200,
    goal: Int32Array.from([3, 2, 2, 1, 0, 0]),
    required: fill(6),
    homeDist: fill(1),
    immediate: fill(0),
    cut: fill(0),
    rescue: fill(0),
    frontDist: fill(0),
    route: Int32Array.from([3, 2, 1, 1, 0, 0]),
    homes: [0],
    danger: [],
    site: -1,
    self: { army: 250, land: 5 },
    rival: { player: { army: 50 }, crowns: [4, 5], otherFront: 0, contact: 0 },
    ffa: false,
    wide: false,
    anchorDist: fill(1),
    enemyDist: Int32Array.from([3, 3, 3, 1, 1, 1]),
    defense: fill(1),
    closing: false,
    push: 1,
    lead: -1,
    leadDist: null,
  };
  const capture = {
    i: 2,
    j: 3,
    own: false,
    hostile: false,
    strike: false,
    send: 199,
    remaining: 199,
    support: 2,
    exposure: 0,
    intercept: false,
    base: false,
  };
  // A capture that is not also a crown approach (that case has its own rule):
  // only the plain gap-filling term moves.
  const flat = { ...state, goal: fill(3), route: fill(0) };
  const plain = evaluateFrontMove(flat, capture);
  assert.equal(
    evaluateFrontMove({ ...flat, land: { capture: 0, burst: 0, paint: Infinity } }, capture),
    plain,
  );
  assert.equal(
    evaluateFrontMove({ ...flat, land: { capture: 130, burst: 0, paint: Infinity } }, capture),
    plain + 130,
  );
  assert.equal(
    evaluateFrontMove({ ...flat, land: { capture: 0, burst: 220, paint: Infinity } }, capture),
    plain + 220,
  );
  // The paint cap clamps a plain own-cell merge and leaves site funding alone.
  const merge = {
    i: 1,
    j: 2,
    own: true,
    hostile: false,
    strike: false,
    send: 39,
    remaining: 79,
    support: 2,
    exposure: 0,
    intercept: false,
    base: false,
  };
  const march = evaluateFrontMove(state, merge);
  assert.ok(march > 150);
  assert.equal(evaluateFrontMove({ ...state, land: { capture: 0, burst: 0, paint: 150 } }, merge), 150);
  // Funding the build site and the closing funnel are exempt from the cap.
  const funded = evaluateFrontMove({ ...state, site: 2 }, merge);
  assert.ok(funded > 150);
  assert.equal(
    evaluateFrontMove({ ...state, site: 2, land: { capture: 0, burst: 0, paint: 150 } }, merge),
    funded,
  );
  const funnel = evaluateFrontMove({ ...state, closing: true }, merge);
  assert.equal(
    evaluateFrontMove({ ...state, closing: true, land: { capture: 0, burst: 0, paint: 150 } }, merge),
    funnel,
  );
});
