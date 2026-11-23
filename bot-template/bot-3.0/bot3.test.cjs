'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createBoard, chooseOrders } = require('./planner');
const { attachStrategy, MAX_TEAMS } = require('./strategy');
const { rescueValues, assessOpponents, evaluateFrontMove } = require('./single-front');
const { planFinish, finishEnabled } = require('./kill');
const { makeOpening } = require('./opening');
const relayPlanner = require('../relay-bot/planner');
const { predict: predictShadow, record: recordShadow, plan: planShadow } = require('./shadow');
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
const { archipelagoConfig, archipelagoUpdate, archipelagoWaterBlocked } = require('./archipelago');

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

test('arm the cut rescue only inside the positional gates', () => {
  const { cutConfig, saveGate } = require('./cut');
  // Two cells each: we hold index 0, the rival holds index 1.
  const ctx = { size: 2, myTeam: 1, teams: [1, 2], units: [40, 100], fog: true, closing: false };
  const plan = (turn, overrides) => ({ turn, config: cutConfig(overrides, {}) });
  const base = { enabled: true, min: 0, behindArmy: 0, behindLand: 0, share: 0, turn: 0, until: 0 };
  // Ungated: the bonus is armed wherever a pocket clears `min`.
  assert.ok(saveGate(plan(60, { save: base }), ctx));
  // Fog-only gate blocks clear rooms and keeps fog rooms.
  assert.ok(saveGate(plan(60, { save: { ...base, fog: true } }), ctx));
  assert.equal(saveGate(plan(60, { save: { ...base, fog: true } }), { ...ctx, fog: false }), null);
  // Closing gate blocks only while the endgame phase owns the plan.
  assert.equal(saveGate(plan(60, { save: { ...base, closing: true } }), { ...ctx, closing: true }), null);
  assert.ok(saveGate(plan(60, { save: { ...base, closing: true } }), ctx));
  // Turn window.
  assert.equal(saveGate(plan(40, { save: { ...base, turn: 60 } }), ctx), null);
  assert.equal(saveGate(plan(90, { save: { ...base, until: 80 } }), ctx), null);
  assert.ok(saveGate(plan(60, { save: { ...base, turn: 60, until: 80 } }), ctx));
  // Behind gates: 40 army against 100 is behind, 140 against 100 is not.
  assert.ok(saveGate(plan(60, { save: { ...base, behindArmy: 1 } }), ctx));
  const ahead = { ...ctx, units: [140, 100] };
  assert.equal(saveGate(plan(60, { save: { ...base, behindArmy: 1 } }), ahead), null);
  // Land gate reads the ownership counts (one cell each here).
  assert.ok(saveGate(plan(60, { save: { ...base, behindLand: 1 } }), ctx));
  assert.equal(saveGate(plan(60, { save: { ...base, behindLand: 0.5 } }), ctx), null);
  // Exact leaderboard reads win over the cell sums, and feed the share gate.
  const exact = { ...ctx, army: 400, rivalArmy: 300, land: 10, rivalLand: 20 };
  assert.equal(saveGate(plan(60, { save: { ...base, behindArmy: 1 } }), exact), null);
  const sums = saveGate(plan(60, { save: { ...base, share: 25 } }), exact);
  assert.deepEqual([sums.army, sums.rivalArmy, sums.land, sums.rivalLand], [400, 300, 10, 20]);
});

// Archipelago layer (see ./archipelago). Three 4x4 plain islands in a swamp sea:
// ours (top left), one unclaimed (bottom left) and one rival (bottom right).
function archipelagoFixture() {
  const b = createBoard(15, 15, 1);
  b.grid_type.fill(204);
  const put = (x, y, code) => (b.grid_type[x * 15 + y] = code);
  for (let x = 1; x < 5; x++) for (let y = 1; y < 5; y++) put(x, y, 1);
  put(1, 1, 101);
  for (let x = 1; x < 5; x++) for (let y = 9; y < 13; y++) put(x, y, 200);
  for (let x = 9; x < 13; x++) for (let y = 9; y < 13; y++) put(x, y, 2);
  put(9, 9, 102);
  const homeDist = new Int32Array(b.size);
  const enemyDist = new Int32Array(b.size);
  const teams = new Uint8Array(b.size);
  for (let i = 0; i < b.size; i++) {
    const x = Math.floor(i / 15),
      y = i % 15;
    homeDist[i] = Math.abs(x - 1) + Math.abs(y - 1);
    enemyDist[i] = Math.abs(x - 11) + Math.abs(y - 11);
    if (x >= 9 && x < 13 && y >= 9 && y < 13) teams[i] = 2;
    else if (x >= 1 && x < 5 && y >= 1 && y < 5) teams[i] = 1;
  }
  return {
    b,
    context: {
      turn: 40,
      tile: b.grid_type,
      teams,
      myTeam: 1,
      homes: [16],
      homeDist,
      enemyDist,
      enemies: [9 * 15 + 10],
      fog: false,
      multi: false,
    },
  };
}

test('default the measured archipelago bundle on and allow opting out', () => {
  const { b, context } = archipelagoFixture();
  const idle = archipelagoUpdate(b, context, archipelagoConfig({}, { BOT3_ARCH: '0' }));
  assert.equal(idle.active, false);
  assert.equal(idle.targets, null);
  assert.equal(idle.waterCap, 0);
  // The measured bundle is the default and only the two measured mechanisms.
  const bundle = archipelagoConfig({}, {});
  assert.equal(bundle.land, true);
  assert.equal(bundle.front, true);
  assert.equal(bundle.water, false);
  assert.equal(bundle.crown, false);
  // The land phase is armed in fog too, but only behind the fog-safe gate
  // (`fogQuiet`); `BOT3_ARCH_FOG_QUIET=0` restores the measured losing variant.
  assert.equal(bundle.landFog, true);
  assert.equal(bundle.fogQuiet, true);
  assert.equal(archipelagoConfig({}, { BOT3_ARCH: '1', BOT3_ARCH_LAND_FOG: '0' }).landFog, false);
  assert.equal(archipelagoConfig({}, { BOT3_ARCH: '1', BOT3_ARCH_FOG_QUIET: '0' }).fogQuiet, false);
  // A single flag overrides the bundle.
  assert.equal(archipelagoConfig({}, { BOT3_ARCH: '1', BOT3_ARCH_LAND: '0' }).land, false);
});

test('gate the archipelago layer on the swamp share, not on the map name', () => {
  const { b, context } = archipelagoFixture();
  const config = archipelagoConfig({ land: true });
  assert.equal(archipelagoUpdate(b, context, { ...config, swampShare: 1.1 }).active, false);
  const swamp = archipelagoUpdate(b, context, config);
  assert.equal(swamp.active, true);
  assert.ok(swamp.swampShare > 0.55);
  // A plain board with the same shape is left alone by the default gate.
  const dry = createBoard(15, 15, 1);
  dry.grid_type.fill(200);
  assert.equal(archipelagoUpdate(dry, { ...context, tile: dry.grid_type }, config).active, false);
});

test('aim the land phase at the nearest unclaimed island only during the burst', () => {
  const { b, context } = archipelagoFixture();
  const config = archipelagoConfig({ land: true });
  const early = archipelagoUpdate(b, context, config);
  assert.equal(early.aimLand, true);
  assert.ok(early.focus >= 0);
  assert.ok(early.targets.length > 0);
  // Every target is unclaimed plain land on the unclaimed island.
  assert.deepEqual([...new Set(early.targets.map((i) => i % 15))].sort((a, c) => a - c), [9, 10, 11, 12]);
  assert.ok(early.targets.every((i) => b.grid_type[i] === 200));
  // After the burst the rival crown is the objective again.
  assert.equal(archipelagoUpdate(b, { ...context, turn: 60 }, config).aimLand, false);
  // A rival next to our home outranks any land grab.
  const near = new Int32Array(b.size).fill(1);
  assert.equal(archipelagoUpdate(b, { ...context, enemyDist: near }, config).aimLand, false);
  // A contested island is never a land target.
  const contested = Uint8Array.from(context.teams);
  for (let x = 1; x < 5; x++) for (let y = 9; y < 13; y++) contested[x * 15 + y] = 2;
  assert.equal(archipelagoUpdate(b, { ...context, teams: contested }, config).aimLand, false);
});

test('stand the fog land phase down as soon as the rival is in vision', () => {
  const { b, context } = archipelagoFixture();
  const config = archipelagoConfig({ land: true });
  // Clear rooms keep the burst deadline: the quiet gate is fog-only.
  const clear = archipelagoUpdate(b, { ...context, enemies: [] }, config);
  assert.equal(clear.aimLand, true);
  // In fog nothing is visible yet, so the grab is free and the phase is armed.
  const fogged = { ...context, fog: true, enemies: [] };
  const quiet = archipelagoUpdate(b, fogged, config);
  assert.equal(quiet.aimLand, true);
  assert.ok(quiet.targets.length > 0);
  // One visible rival cell hands the frame back to the remembered crowns.
  const seen = archipelagoUpdate(b, { ...fogged, enemies: [9 * 15 + 10] }, config);
  assert.equal(seen.aimLand, false);
  // `fogKnown` extends the gate to a remembered crown.
  assert.equal(archipelagoUpdate(b, { ...fogged, known: 1 }, config).aimLand, true);
  const wrong = archipelagoUpdate(b, { ...fogged, known: 1 }, { ...config, fogKnown: true });
  assert.equal(wrong.aimLand, false);
  // The fog deadline ends the phase without touching the clear deadline.
  assert.equal(archipelagoUpdate(b, fogged, { ...config, fogUntil: 30 }).aimLand, false);
  assert.equal(archipelagoUpdate(b, { ...fogged, turn: 20 }, { ...config, fogUntil: 30 }).aimLand, true);
});

test('latch the focus island while it still has plain land', () => {
  const { b, context } = archipelagoFixture();
  const config = archipelagoConfig({ land: true });
  const first = archipelagoUpdate(b, context, config);
  const focus = first.focus;
  const claimed = Uint8Array.from(b.grid_type);
  claimed[first.targets[0]] = 1;
  const again = archipelagoUpdate(b, { ...context, tile: claimed }, config);
  assert.equal(again.focus, focus);
  assert.ok(!again.targets.includes(first.targets[0]));
});

test('cap a swamp capture that walks away from plain land and allow a crossing', () => {
  const { b, context } = archipelagoFixture();
  const arch = archipelagoUpdate(b, context, archipelagoConfig({ water: true }));
  assert.equal(arch.waterCap, 18);
  // A crossing step that shortens the run to the unclaimed island is allowed.
  assert.equal(b.grid_type[0 * 15 + 8], 204);
  assert.equal(arch.plainDist[0 * 15 + 8] < arch.plainDist[0 * 15 + 7], true);
  assert.equal(archipelagoWaterBlocked(arch, b.grid_type, 0 * 15 + 7, 0 * 15 + 8), false);
  // The landing itself is a plain capture, never capped.
  const landing = 1 * 15 + 9;
  assert.equal(b.grid_type[landing], 200);
  assert.equal(archipelagoWaterBlocked(arch, b.grid_type, 0 * 15 + 9, landing), false);
  // A swamp cell that is no closer to any plain cell buys nothing.
  assert.equal(archipelagoWaterBlocked(arch, b.grid_type, 7 * 15 + 1, 7 * 15 + 0), true);
  // Plain captures and the switched-off layer are never blocked.
  assert.equal(archipelagoWaterBlocked(arch, b.grid_type, 7 * 15 + 0, 1 * 15 + 9), false);
  const off = archipelagoUpdate(b, context, archipelagoConfig({}));
  assert.equal(archipelagoWaterBlocked(off, b.grid_type, 7 * 15 + 1, 7 * 15 + 0), false);
});

test('arm the island crown only on a fully owned island clear of the rival', () => {
  const { b, context } = archipelagoFixture();
  const config = archipelagoConfig({ crown: true });
  const arch = archipelagoUpdate(b, context, config);
  assert.equal(arch.crownIslands[arch.island[2 * 15 + 2]], 1);
  // The contested island and the unclaimed island are never crown sites.
  assert.equal(arch.crownIslands[arch.island[9 * 15 + 9]], 0);
  assert.equal(arch.crownIslands[arch.island[1 * 15 + 9]], 0);
  // A rival within reach removes the safe-income claim.
  const near = archipelagoUpdate(b, context, { ...config, crownEnemy: 40 });
  assert.equal(near.crownIslands[near.island[2 * 15 + 2]], 0);
  assert.equal(archipelagoConfig({ crown: false }).crown, false);
});

test('leave multi-line archipelago rooms alone unless asked', () => {
  const { b, context } = archipelagoFixture();
  const config = archipelagoConfig({ land: true });
  assert.equal(archipelagoUpdate(b, { ...context, multi: true }, config).active, false);
  assert.equal(archipelagoUpdate(b, { ...context, multi: true }, { ...config, multi: true }).active, true);
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
  // Round 13: the stand-down can ignore the instantaneous land race (measured
  // neutral on mediterranean), and the crown-economy knobs stay inert at 0.
  assert.equal(landConfig({}, {}).closeAlways, 0);
  assert.equal(landConfig({}, { BOT3_LAND_CLOSE_ALWAYS: '1' }).closeAlways, 1);
  const always = landConfig({}, { BOT3_LAND_CLOSE_ALWAYS: '1' });
  assert.equal(landContext(b, { ...room, land: 30 }, always).closeSkip, true);
  assert.equal(landContext(b, { ...room, single: false }, always).closeSkip, false);
  assert.equal(landConfig({}, {}).site, 0);
  assert.equal(landConfig({}, {}).develop, 0);
  const crowns = landConfig({}, { BOT3_LAND_SITE: '520', BOT3_LAND_DEVELOP: '1' });
  assert.equal(landContext(b, room, crowns).site, 520);
  assert.equal(landContext(b, room, crowns).develop, true);
  assert.equal(landContext(b, { ...room, single: false }, crowns).site, 0);
  assert.equal(landContext(b, room, landConfig({}, { BOT3_LANDFIRST: '0' })).site, 0);
});

// Round 13: the punish recapture is gated on the structural swamp share, so a
// plain-rich board keeps the shipped path, and the bid/keep knobs stay addressable.
test('gate the shadow punish recapture on the structural swamp share', () => {
  const keys = [
    'BOT3_SHADOW_PUNISH',
    'BOT3_SHADOW_PUNISH_BID',
    'BOT3_SHADOW_PUNISH_KEEP',
    'BOT3_SHADOW_PUNISH_SWAMP',
  ];
  const saved = {};
  for (const key of keys) saved[key] = process.env[key];
  try {
    for (const key of keys) delete process.env[key];
    const setup = (swampCells) => {
      const b = createBoard(6, 10, 1);
      b.grid_type.fill(200);
      for (let i = 0; i < swampCells; i++) b.grid_type[i] = 204;
      // Our 9-unit stack next to relay's source tile.
      b.grid_type[15] = 2;
      b.grid_type[14] = 1;
      b.army_cnt[15] = 0;
      b.army_cnt[14] = 10;
      return b;
    };
    const run = (b) => {
      const candidates = [];
      const state = { stats: { branches: {} } };
      const ctx = {
        pred: { from: 15, to: 4, build: false, relayMe: 2 },
        weFirst: false,
        push: 100,
        defense: 10,
        me: 1,
        relayGrowth: 0,
        hard: true,
        state,
      };
      const added = planShadow(ctx, b, 70, candidates);
      return { candidates, added, branches: state.stats.branches };
    };
    // Plain-rich board (0% swamp): the gate leaves the shipped path alone.
    const open = run(setup(0));
    assert.equal(open.added, 0);
    assert.equal(open.candidates.length, 0);
    // Swamp-heavy board: relay's abandoned tile is recaptured.
    const heavy = run(setup(24));
    assert.equal(heavy.added, 1);
    assert.equal(heavy.candidates[0].score, 250);
    assert.deepEqual(
      [heavy.candidates[0].from, heavy.candidates[0].to, heavy.candidates[0].send],
      [14, 15, 9],
    );
    assert.equal(heavy.branches.punishAdd, 1);
    // The bid is a knob, and the gate can be opened or closed by hand.
    process.env.BOT3_SHADOW_PUNISH_BID = '350';
    assert.equal(run(setup(24)).candidates[0].score, 350);
    delete process.env.BOT3_SHADOW_PUNISH_BID;
    process.env.BOT3_SHADOW_PUNISH_SWAMP = '0';
    assert.equal(run(setup(0)).added, 1);
    delete process.env.BOT3_SHADOW_PUNISH_SWAMP;
    process.env.BOT3_SHADOW_PUNISH = '0';
    assert.equal(run(setup(24)).added, 0);
    delete process.env.BOT3_SHADOW_PUNISH;
    // `keep` bounds what relay may leave behind on the source tile.
    const stuck = setup(24);
    stuck.army_cnt[15] = 103;
    assert.equal(run(stuck).added, 0);
    process.env.BOT3_SHADOW_PUNISH_KEEP = '3';
    assert.equal(run(stuck).added, 1);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('ship the finish layer on by default behind the shadow-armed gate', () => {
  const saved = process.env.BOT3_FINISH;
  try {
    delete process.env.BOT3_FINISH;
    assert.equal(finishEnabled(), true);
    process.env.BOT3_FINISH = '0';
    assert.equal(finishEnabled(), false);
    process.env.BOT3_FINISH = '1';
    assert.equal(finishEnabled(), true);
  } finally {
    if (saved === undefined) delete process.env.BOT3_FINISH;
    else process.env.BOT3_FINISH = saved;
  }
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

// --- Expansion-shape layer for multi-line rooms (./mshape) ------------------
const {
  mshapeConfig,
  mshapeUpdate,
  applyMshape,
  applyFan,
  ringCount,
  neutralFrontier,
  freshMshape,
  DEFAULT_SLOTS,
  DEFAULT_STEAL,
  DEFAULT_FAN_ARMY,
  DEFAULT_LEAD_CAP,
  DEFAULT_FRONTIER,
} = require('./mshape');

// A 6x6 blob of our plains with two army each inside a 9x9 neutral board: enough
// frontier and enough interior stacks that the sixteen-order clamp binds.
function mshapeBlob(army = 2) {
  const b = createBoard(9, 9, 1);
  b.grid_type.fill(200);
  for (let r = 1; r <= 6; r++)
    for (let c = 1; c <= 6; c++) {
      b.grid_type[r * 9 + c] = 1;
      b.army_cnt[r * 9 + c] = army;
    }
  b.grid_type[0] = 101;
  b.army_cnt[0] = 2;
  return b;
}

test('ship the expansion-shape layer on and clamp its knobs', () => {
  assert.equal(mshapeConfig({}, {}).enabled, true);
  assert.equal(mshapeConfig({}, { BOT3_MSHAPE: '1' }).enabled, true);
  assert.equal(mshapeConfig({}, { BOT3_MSHAPE: 'off' }).enabled, false);
  const defaults = mshapeConfig({ enabled: true }, {});
  assert.equal(defaults.slots, DEFAULT_SLOTS);
  assert.equal(defaults.fanArmy, DEFAULT_FAN_ARMY);
  assert.equal(defaults.leadCap, DEFAULT_LEAD_CAP);
  assert.equal(defaults.frontier, DEFAULT_FRONTIER === 1);
  assert.equal(defaults.capture, 0);
  assert.equal(defaults.steal, DEFAULT_STEAL);
  assert.equal(defaults.fan, 0);
  assert.equal(defaults.ringCap, 6);
  // Every knob is clamped and read per call.
  const clamped = mshapeConfig({}, { BOT3_MSHAPE: '1', BOT3_MSHAPE_RING_CAP: '99', BOT3_MSHAPE_SLOTS: '0' });
  assert.equal(clamped.ringCap, 8);
  assert.equal(clamped.slots, 1);
  assert.equal(mshapeConfig({}, { BOT3_MSHAPE: '1', BOT3_MSHAPE_SLOTS: 'abc' }).slots, DEFAULT_SLOTS);
  assert.equal(mshapeConfig({}, { BOT3_MSHAPE: '1', BOT3_MSHAPE_FAN: '9' }).fan, 3);
});

test('reach the expansion-shape layer only from a multi-line room', () => {
  const b = mshapeBlob();
  const input = { turn: 60, multi: true, size: b.size, me: 1, land: 30, enemyLand: 30 };
  assert.equal(mshapeUpdate(b, input, mshapeConfig({}, { BOT3_MSHAPE: '0' })), null);
  const on = mshapeConfig({ enabled: true });
  assert.equal(mshapeUpdate(b, { ...input, multi: false }, on), null);
  assert.equal(mshapeUpdate(b, { ...input, size: 100000 }, { ...on, maxBoard: 800 }), null);
  const plan = mshapeUpdate(b, input, on);
  assert.ok(plan);
  assert.equal(plan.slots, DEFAULT_SLOTS);
  assert.equal(b.mshapeLine.ticks, 1);
  assert.deepEqual(freshMshape(), { ticks: 0 });
});

test('lift the inherited sixteen-order cap only in a multi-line room', () => {
  const players = [
    { id: 1, team: 1, army: 80, land: 3, dead: 0 },
    { id: 2, team: 2, army: 100, land: 4, dead: 0 },
  ];
  process.env.BOT3_MSHAPE = '0';
  try {
    const off = chooseOrders(mshapeBlob(), 60, players, true);
    assert.equal(off.length, 16);
  } finally {
    delete process.env.BOT3_MSHAPE;
  }
  const on = chooseOrders(mshapeBlob(), 60, players, true);
  assert.ok(on.length > 16, `expected more than sixteen orders, got ${on.length}`);
  // Serial rooms keep the one-order rule and the untouched score path.
  const serial = chooseOrders(mshapeBlob(), 60, players, false);
  assert.equal(serial.length, 1);
});

test('stand the expansion shape down when the land race is over', () => {
  const b = mshapeBlob();
  const input = { turn: 60, multi: true, size: b.size, me: 1, land: 30, enemyLand: 30 };
  const on = mshapeConfig({ enabled: true });
  assert.equal(neutralFrontier(b, 1), true);
  const closed = mshapeBlob();
  for (let i = 0; i < closed.size; i++) if (closed.grid_type[i] === 200) closed.grid_type[i] = 201;
  assert.equal(neutralFrontier(closed, 1), false);
  assert.equal(mshapeUpdate(closed, input, { ...on, frontier: true }), null);
  assert.ok(mshapeUpdate(closed, input, { ...on, frontier: false }));
  // A land lead above the cap also stands the layer down.
  assert.equal(mshapeUpdate(b, { ...input, land: 90 }, { ...on, leadCap: 110 }), null);
  assert.ok(mshapeUpdate(b, { ...input, land: 30 }, { ...on, leadCap: 110 }));
});

test('price a neutral capture by the frontier it keeps', () => {
  // 2x3 board: our plains on 0 and 3, neutral plains on 1, 4, 5, swamp on 2.
  const b = createBoard(2, 3, 1);
  b.grid_type.set([1, 200, 150, 1, 200, 200]);
  const ctx = {
    tile: b.grid_type,
    teams: Uint8Array.from([1, 0, 0, 1, 0, 0]),
    neighbors: b.neighbors,
    myTeam: 1,
  };
  assert.equal(ringCount(ctx, 1), 1); // 2 is swamp and does not pay a pulse
  assert.equal(ringCount(ctx, 4), 2); // 1 and 5 are plains
  const make = () => [
    { score: 32, from: 0, to: 1, mode: 2 },
    { score: 32, from: 0, to: 2, mode: 2 },
    { score: 32, from: 3, to: 4, mode: 2 },
    { score: 60, from: 0, to: 3, mode: 2 },
  ];
  const plan = { config: { slots: 64 } };
  const plain = make();
  applyMshape(plan, ctx, plain);
  assert.deepEqual(
    plain.map((op) => op.score),
    [32, 32, 32, 60],
  );
  const priced = make();
  applyMshape(
    plan,
    { ...ctx, tile: b.grid_type },
    priced,
  );
  applyMshape(
    { config: { slots: 64, capture: 10, ring: 5, ringCap: 6, hole: 25, water: 40, steal: 100, stealCap: 300 } },
    ctx,
    priced,
  );
  assert.equal(priced[0].score, 32 + 10 + 5); // one plain neighbour left
  assert.equal(priced[1].score, 32 + 10 + 10 - 40); // swamp capture pays no pulse
  assert.equal(priced[2].score, 32 + 10 + 10);
  // The merge would invalidate the capture from the same cell, so it loses (the
  // capture map is read before the boosts below move the capture scores).
  assert.equal(priced[3].score, 32 - 100);
  // A target that closes the frontier is charged for it.
  const hole = [{ score: 32, from: 3, to: 5, mode: 2 }];
  const closed = createBoard(2, 3, 1);
  closed.grid_type.set([1, 201, 150, 1, 1, 200]);
  applyMshape(
    { config: { slots: 64, hole: 25 } },
    { tile: closed.grid_type, teams: Uint8Array.from([1, 0, 0, 1, 1, 0]), neighbors: closed.neighbors, myTeam: 1 },
    hole,
  );
  assert.equal(hole[0].score, 32 - 25);
});

test('take a rival cell as a two-cell land swing when priced', () => {
  const b = createBoard(1, 3, 1);
  b.grid_type.set([1, 2, 1]);
  const ctx = { tile: b.grid_type, teams: Uint8Array.from([1, 2, 1]), neighbors: b.neighbors, myTeam: 1 };
  const raid = [{ score: 49, from: 0, to: 1, mode: 2 }];
  applyMshape({ config: { slots: 64 } }, ctx, raid);
  assert.equal(raid[0].score, 49);
  applyMshape({ config: { slots: 64, raid: 40 } }, ctx, raid);
  assert.equal(raid[0].score, 89);
});

test('split one stack over two neutral fronts only when asked', () => {
  // 2x2 board: our stack on 0 touches two neutral plains (1 and 2).
  const b = createBoard(2, 2, 1);
  b.grid_type.set([1, 200, 200, 201]);
  b.army_cnt.set([3, 0, 0, 0]);
  const ctx = {
    tile: b.grid_type,
    teams: Uint8Array.from([1, 0, 0, 0]),
    units: Float64Array.from([3, 0, 0, 0]),
    neighbors: b.neighbors,
    myTeam: 1,
  };
  const orders = () => [{ score: 32, from: 0, to: 1, mode: 2 }];
  const idle = orders();
  assert.deepEqual(applyFan({ config: { fan: 0 } }, ctx, idle), []);
  assert.equal(idle[0].mode, 2);
  const split = orders();
  const extra = applyFan({ config: { fan: 1, fanArmy: 3 } }, ctx, split);
  assert.equal(extra.length, 1);
  assert.equal(extra[0].to, 2);
  assert.equal(extra[0].mode, 1);
  assert.equal(split[0].mode, 1);
  // A stack below the threshold, a defence mode and a hostile target are left
  // alone: a halved push into defenders can be a mutual-loss trade.
  assert.deepEqual(applyFan({ config: { fan: 1, fanArmy: 6 } }, ctx, orders()), []);
  const defence = [{ score: 600, from: 0, to: 1, mode: 1 }];
  assert.deepEqual(applyFan({ config: { fan: 1, fanArmy: 3 } }, ctx, defence), []);
  const hostile = createBoard(2, 2, 1);
  hostile.grid_type.set([1, 2, 200, 201]);
  const raid = [{ score: 49, from: 0, to: 1, mode: 2 }];
  assert.deepEqual(
    applyFan(
      { config: { fan: 1, fanArmy: 3 } },
      { ...ctx, tile: hostile.grid_type, teams: Uint8Array.from([1, 2, 0, 0]), neighbors: hostile.neighbors },
      raid,
    ),
    [],
  );
});

// --- Sustained-pressure layer for multi-line rooms (./mhalf) ----------------
const {
  mhalfConfig,
  mhalfUpdate,
  mhalfField,
  mhalfPush,
  forkCount,
  applyMhalf,
  applyMhalfModes,
  freshMhalf,
  DEFAULT_FLOOR,
  DEFAULT_FORK,
  DEFAULT_ROUTE,
  DEFAULT_RETAIN,
  DEFAULT_RELOAD,
  DEFAULT_STALE,
  DEFAULT_MIN_FIRE,
  DEFAULT_LEAD,
} = require('./mhalf');

test('ship the sustained-pressure layer on and clamp its knobs', () => {
  assert.equal(mhalfConfig({}, {}).enabled, true);
  assert.equal(mhalfConfig({}, { BOT3_MHALF: '1' }).enabled, true);
  assert.equal(mhalfConfig({}, { BOT3_MHALF: 'off' }).enabled, false);
  const defaults = mhalfConfig({ enabled: true }, {});
  assert.equal(defaults.route, DEFAULT_ROUTE);
  assert.equal(defaults.retain, DEFAULT_RETAIN);
  assert.equal(defaults.floor, DEFAULT_FLOOR);
  assert.equal(defaults.fork, DEFAULT_FORK);
  assert.equal(defaults.reload, DEFAULT_RELOAD);
  assert.equal(defaults.stale, DEFAULT_STALE);
  assert.equal(defaults.minFire, DEFAULT_MIN_FIRE);
  assert.equal(defaults.leadCap, DEFAULT_LEAD);
  assert.equal(defaults.convoy, 0);
  assert.equal(defaults.corridor, false);
  // Every knob is clamped and read per call.
  const clamped = mhalfConfig({}, { BOT3_MHALF: '1', BOT3_MHALF_RETAIN: '9', BOT3_MHALF_FLOOR: '0' });
  assert.equal(clamped.retain, 2);
  assert.equal(clamped.floor, 1);
  assert.equal(mhalfConfig({}, { BOT3_MHALF: '1', BOT3_MHALF_HOP: 'abc' }).route, DEFAULT_ROUTE);
  assert.equal(mhalfConfig({}, { BOT3_MHALF: '1', BOT3_MHALF_MIN_FIRE: '1' }).minFire, 2);
});

test('reach the sustained-pressure layer only from a multi-line room', () => {
  const b = mshapeBlob();
  const input = { turn: 60, multi: true, size: b.size, me: 1, land: 30, enemyLand: 30 };
  assert.equal(mhalfUpdate(b, input, mhalfConfig({}, { BOT3_MHALF: '0' })), null);
  const on = mhalfConfig({ enabled: true });
  assert.equal(mhalfUpdate(b, { ...input, multi: false }, on), null);
  assert.equal(mhalfUpdate(b, { ...input, size: 100000 }, { ...on, maxBoard: 800 }), null);
  // A corridor room and a fog room are gated independently, and the land lead
  // stands the layer down (the weaker-opponent archipelago cells regress
  // without it).
  assert.equal(mhalfUpdate(b, { ...input, corridor: true }, on), null);
  assert.equal(mhalfUpdate(b, { ...input, fog: true }, { ...on, fog: false }), null);
  assert.equal(mhalfUpdate(b, { ...input, land: 90 }, { ...on, leadCap: 110 }), null);
  const plan = mhalfUpdate(b, input, on);
  assert.ok(plan);
  assert.equal(plan.turn, 60);
  assert.equal(b.mhalfLine.ticks, 1);
  assert.deepEqual(freshMhalf(), { ticks: 0 });
});

test('measure hops to the frontier ring through our own territory', () => {
  // 1x6 corridor: our cells on 0..3, neutral ground on 4, wall on 5.
  const b = createBoard(1, 6, 1);
  b.grid_type.set([1, 1, 1, 1, 200, 201]);
  const field = mhalfField(b.grid_type, Uint8Array.from([1, 1, 1, 1, 0, 0]), b.neighbors, 1);
  assert.deepEqual([...field.ring], [0, 0, 0, 1, 0, 0]);
  assert.deepEqual([...field.hop], [3, 2, 1, 0, -1, -1]);
});

test('compute the engine push of the three move modes', () => {
  // A 6-army cell next to a 3-army rival stack and a neutral cell: the threat
  // sum (3 - 1 = 2) is reserved by modes 0 and 1, mode 2 pushes everything.
  const b = createBoard(1, 3, 1);
  b.grid_type.set([1, 2, 200]);
  const push = mhalfPush(b.grid_type, Uint8Array.from([1, 2, 0]), Float64Array.from([6, 3, 1]), b.neighbors, 1, 0, 2);
  assert.equal(push.mode2, 5);
  assert.equal(push.mode0, 3);
  assert.equal(push.mode1, 1);
  assert.equal(forkCount(b.grid_type, Uint8Array.from([1, 2, 0]), b.neighbors, 1, 0, 2), 1);
});

test('price the reload of a spent ring cell and cap a pit delivery', () => {
  // 2x2: ring cell 0 (one army, one neutral neighbour at 1) and cell 2 behind
  // it (five army), plus a ring cell 3 that already holds three army.
  const b = createBoard(2, 2, 1);
  b.grid_type.set([1, 200, 1, 1]);
  b.army_cnt.set([1, 0, 5, 3]);
  const ctx = {
    tile: b.grid_type,
    teams: Uint8Array.from([1, 0, 1, 1]),
    units: Float64Array.from([1, 0, 5, 3]),
    neighbors: b.neighbors,
    myTeam: 1,
  };
  const cfg = { config: { route: 1, retain: 0, convoy: 0, reload: 60, hop: 6, stale: 28, exempt: 300, minFire: 3, armRing: 0, armWater: 0, cheap: 0, leak: 0, sideways: 0 }, state: {} };
  // 2 -> 0 arms the ring cell (result 5 >= 3): a big bonus.
  const arm = [{ score: 20, from: 2, to: 0, mode: 2, send: 4 }];
  applyMhalf(cfg, ctx, arm);
  assert.ok(arm[0].score >= 60, `expected a reload bonus, got ${arm[0].score}`);
  // 0 -> 2 walks away from the ring and must not be capped (it is progress in
  // the planner's own terms only), while a delivery that cannot reach the fire
  // threshold is capped below every capture.
  const thin = createBoard(2, 2, 1);
  thin.grid_type.set([1, 200, 1, 1]);
  thin.army_cnt.set([1, 0, 2, 3]);
  const pit = [{ score: 90, from: 2, to: 0, mode: 2, send: 1 }];
  applyMhalf(
    cfg,
    {
      tile: thin.grid_type,
      teams: Uint8Array.from([1, 0, 1, 1]),
      units: Float64Array.from([1, 0, 2, 3]),
      neighbors: thin.neighbors,
      myTeam: 1,
    },
    pit,
  );
  assert.equal(pit[0].score, 28);
  // An armed ring cell (three army) captures this tick, so a merge into it is
  // left to the inherited steal rule instead of being boosted above the capture.
  const busy = [{ score: 40, from: 2, to: 3, mode: 2, send: 1 }];
  applyMhalf(cfg, ctx, busy);
  assert.equal(busy[0].score, 40);
  // Defence/rescue work (>= exempt) is never re-priced.
  const defence = [{ score: 560, from: 2, to: 0, mode: 2, send: 4 }];
  applyMhalf(cfg, ctx, defence);
  assert.equal(defence[0].score, 560);
});

test('keep a rolling garrison only when the halved push still takes the cell', () => {
  // 2x2: a six-army cell on 0 with two neutral neighbours (a fork), one on 1.
  const b = createBoard(2, 2, 1);
  b.grid_type.set([1, 200, 200, 201]);
  const ctx = {
    tile: b.grid_type,
    teams: Uint8Array.from([1, 0, 0]),
    units: Float64Array.from([6, 1, 1]),
    neighbors: b.neighbors,
    myTeam: 1,
  };
  const orders = () => [{ score: 32, from: 0, to: 1, mode: 2 }];
  const off = orders();
  applyMhalfModes({ config: { retain: 0 }, state: {} }, ctx, off);
  assert.equal(off[0].mode, 2);
  // Halved push is 2, which takes a one-army garrison, and three army stay
  // behind - enough to fire again next tick.
  const fork = orders();
  applyMhalfModes({ config: { retain: 1, floor: 2, fork: 1 }, state: {} }, ctx, fork);
  assert.equal(fork[0].mode, 1);
  // Without a second open direction the fork rule keeps the inherited all-in:
  // the captured cell inherits the army either way.
  const lone = createBoard(1, 2, 1);
  lone.grid_type.set([1, 200]);
  applyMhalfModes(
    { config: { retain: 1, floor: 2, fork: 1 }, state: {} },
    {
      tile: lone.grid_type,
      teams: Uint8Array.from([1, 0]),
      units: Float64Array.from([6, 1]),
      neighbors: lone.neighbors,
      myTeam: 1,
    },
    orders(),
  );
  // A two-army cell cannot halve into a capture at all.
  const small = createBoard(2, 2, 1);
  small.grid_type.set([1, 200, 200, 201]);
  const tiny = [{ score: 32, from: 0, to: 1, mode: 2 }];
  applyMhalfModes(
    { config: { retain: 2, floor: 2, fork: 0 }, state: {} },
    {
      tile: small.grid_type,
      teams: Uint8Array.from([1, 0, 0]),
      units: Float64Array.from([2, 1, 1]),
      neighbors: small.neighbors,
      myTeam: 1,
    },
    tiny,
  );
  assert.equal(tiny[0].mode, 2);
});
// ---------------------------------------------------------------------------
// Multi-line exact simulator, relay batch predictor and two-tick search
// (./msim, ./mqueue, ./m2ply).
// ---------------------------------------------------------------------------
const msim = require('./msim');
const mqueue = require('./mqueue');
const m2ply = require('./m2ply');
const relayOpening = require('../relay-bot/opening');

// Hand-built board in the engine's encoded grid (200 is empty plain).
function simBoard(rows, cols, cells, me = 1) {
  const b = createBoard(rows, cols, me);
  b.grid_type.fill(200);
  for (const [index, code, army] of cells) {
    b.grid_type[index] = code;
    b.army_cnt[index] = army;
  }
  return b;
}

function simOf(b) {
  const st = msim.createState(b.size);
  msim.loadBoard(st, b);
  return st;
}

test('msim: growth, queue order and attack follow the engine rules', () => {
  // Crown +1 every tick, plain and city only on the growth marks, swamp never,
  // and an isolated cell never pays (a crown always does).
  assert.equal(msim.growthAt(101, 0, 7, true), 1);
  assert.equal(msim.growthAt(1, 0, 7, true), 0);
  assert.equal(msim.growthAt(1, 0, 50, true), 1);
  assert.equal(msim.growthAt(1, 0, 50, false), 2, 'the single-line burst adds one');
  assert.equal(msim.growthAt(51, 0, 50, true), 1);
  assert.equal(msim.growthAt(151, 0, 50, true), 0, 'swamp pays nothing');
  assert.equal(msim.growthAt(1, 1, 50, true), 0, 'isolation stops production');
  // A chain advances tail-first: only the order leaving the un-targeted cell.
  const chain = simBoard(1, 3, [
    [0, 1, 9],
    [1, 1, 0],
    [2, 200, 0],
  ]);
  const ctx = msim.contextOf(chain);
  const st = simOf(chain);
  const queue = [
    { from: 0, to: 1, mode: 2, build: null, me: 1 },
    { from: 1, to: 2, mode: 2, build: null, me: 1 },
  ];
  msim.executeQueue(st, ctx, 1, queue, true);
  assert.equal(queue.length, 1, 'the second order waits one tick');
  assert.deepEqual([st.army[0], st.army[1]], [1, 8]);
  // Two army cannot take a one-army cell, three can, and a failed assault trades.
  const push = simBoard(1, 3, [
    [0, 1, 2],
    [1, 200, 1],
    [2, 2, 4],
  ]);
  const st2 = simOf(push);
  const ctx2 = msim.contextOf(push);
  assert.equal(msim.pushAt(st2, ctx2, 0, 1, 2), 1);
  assert.equal(msim.attack(st2, ctx2, 0, 1, 2), true);
  assert.equal(msim.ownerOf(st2.code[1]), 0, 'a push of one does not take a garrison of one');
  st2.army[0] = 4;
  assert.equal(msim.attack(st2, ctx2, 0, 1, 2), true);
  assert.equal(msim.ownerOf(st2.code[1]), 1, 'three army push two and take the cell');
  // A seat resolves first on even ticks and second on odd ticks.
  const race = simBoard(1, 3, [
    [0, 101, 9],
    [1, 200, 0],
    [2, 102, 9],
  ]);
  const queues = () =>
    new Map([
      [1, [{ from: 0, to: 1, mode: 2, build: null, me: 1 }]],
      [2, [{ from: 2, to: 1, mode: 2, build: null, me: 2 }]],
    ]);
  const even = simOf(race);
  msim.step(even, msim.contextOf(race), { turn: 2, multi: true, players: [1, 2], queues: queues() });
  assert.equal(msim.ownerOf(even.code[1]), 1);
  const odd = simOf(race);
  msim.step(odd, msim.contextOf(race), { turn: 3, multi: true, players: [1, 2], queues: queues() });
  assert.equal(msim.ownerOf(odd.code[1]), 2);
});

test('mqueue: refuses serial and fogged rooms, predicts and verifies a clear one', () => {
  const previousOn = process.env.BOT3_M2PLY;
  const previousThree = process.env.BOT3_M3PLY;
  const previousArm = process.env.BOT3_MSEARCH_ARM;
  process.env.BOT3_M2PLY = '1';
  process.env.BOT3_M3PLY = '0';
  process.env.BOT3_MSEARCH_ARM = '1';
  try {
    const b = simBoard(5, 5, [
      [12, 101, 5],
      [11, 200, 0],
      [13, 200, 0],
      [7, 200, 0],
      [17, 200, 0],
      [18, 102, 5],
    ]);
    b.openingBudget = relayOpening.openingBudget(1);
    const board = [
      { id: 1, team: 1, army: 30, land: 3, dead: 0 },
      { id: 2, team: 2, army: 30, land: 3, dead: 0 },
    ];
    assert.equal(mqueue.predict(simBoard(3, 3, []), 0, board, false), null, 'serial rooms are refused');
    const fogged = simBoard(3, 3, []);
    fogged.fog[4] = 1;
    assert.equal(mqueue.isClear(fogged), false);
    assert.equal(mqueue.predict(fogged, 0, board, true), null);
    const pred = mqueue.predict(b, 0, board, true);
    assert.ok(pred, 'the first frame yields a batch');
    assert.equal(pred.armed, false, 'an unverified frame is not armed');
    assert.equal(pred.relayMe, 2);
    // The batch is relay's own planner output on the shadow board.
    const shadow = relayPlanner.createBoard(5, 5, 2);
    shadow.grid_type.set(b.grid_type);
    shadow.army_cnt.set(b.army_cnt);
    shadow.openingBudget = b.openingBudget;
    assert.deepEqual(
      pred.ops.map((op) => [op.from, op.to, op.mode]),
      relayPlanner.chooseOrders(shadow, 0, board, true).map((op) => [op.from, op.to, op.mode]),
    );
    mqueue.record(b, 0, [{ from: 12, to: 11, mode: 2 }]);
    // One exact engine tick arms the layer (the simulator is the model here).
    const st = simOf(b);
    msim.step(st, msim.contextOf(b), {
      turn: 1,
      multi: true,
      players: [1, 2],
      queues: new Map([
        [1, [{ from: 12, to: 11, mode: 2, build: null, me: 1 }]],
        [2, pred.ops.map((op) => ({ ...op }))],
      ]),
    });
    b.grid_type.set(st.code);
    b.army_cnt.set(st.army);
    b.isolated.set(st.iso);
    const second = mqueue.predict(b, 1, board, true);
    assert.ok(second);
    assert.equal(second.armed, true, 'one exact frame arms the layer');
    assert.equal(pred.state.stats.matched, 1);
    // One tick ahead: relay's batch on the *simulated* board, without disturbing
    // the shadow board or its bookkeeping.
    const aheadState = simOf(b);
    aheadState.army[12] += 4;
    const ahead = mqueue.predictAhead(second, aheadState, 2, [1, 2], 1);
    assert.ok(Array.isArray(ahead));
    assert.deepEqual(
      Array.from(second.state.board.grid_type),
      Array.from(b.grid_type),
      'shadow board restored',
    );
    assert.deepEqual(Array.from(second.state.board.army_cnt), Array.from(b.army_cnt));
    // Any unexplained frame disables the layer for the rest of the game.
    b.army_cnt[12] += 5;
    assert.equal(mqueue.predict(b, 2, board, true), null);
    assert.equal(pred.state.stats.drift, 1);
  } finally {
    if (previousOn === undefined) delete process.env.BOT3_M2PLY;
    else process.env.BOT3_M2PLY = previousOn;
    if (previousThree === undefined) delete process.env.BOT3_M3PLY;
    else process.env.BOT3_M3PLY = previousThree;
    if (previousArm === undefined) delete process.env.BOT3_MSEARCH_ARM;
    else process.env.BOT3_MSEARCH_ARM = previousArm;
  }
});

test('m2ply: ships on as the three-tick search, clamped knobs and a pulse-clock land weight', () => {
  // The shipped default is the round-18 three-tick compounding search; the
  // round-17 two-tick layer is `BOT3_M2PLY=1 BOT3_M3PLY=0`.
  assert.equal(m2ply.configOf({}, {}).enabled, true);
  assert.equal(m2ply.configOf({}, {}).plies, 3);
  assert.equal(m2ply.configOf({}, { BOT3_M2PLY: '1' }).enabled, true);
  assert.equal(m2ply.configOf({}, { BOT3_M2PLY: 'off', BOT3_M3PLY: 'off' }).enabled, false);
  assert.equal(m2ply.configOf({}, { BOT3_M3PLY: 'off' }).enabled, false);
  assert.equal(m2ply.configOf({}, { BOT3_M3PLY: 'off', BOT3_M2PLY: '1' }).plies, 2);
  assert.equal(m2ply.configOf({}, { BOT3_M2PLY: '1', BOT3_M3PLY: 'off' }).plies, 2);
  const defaults = m2ply.configOf({ enabled: true }, {});
  assert.equal(defaults.margin, m2ply.DEFAULTS.margin);
  assert.equal(defaults.sims, m2ply.DEFAULTS.sims);
  assert.equal(defaults.keep, 0, 'the trim family measured negative and ships off');
  assert.equal(defaults.retain, 0, 'the halved-capture family measured neutral and ships off');
  const clamped = m2ply.configOf(
    {},
    { BOT3_M2PLY: '1', BOT3_M2PLY_SIMS: '999', BOT3_M2PLY_MARGIN: '-4', BOT3_M2PLY_LAND_CAP: '0' },
  );
  assert.equal(clamped.sims, 64);
  assert.equal(clamped.margin, 0);
  assert.equal(clamped.landCap, 1);
  assert.equal(m2ply.configOf({}, { BOT3_M2PLY: '1', BOT3_M2PLY_SIMS: 'abc' }).sims, m2ply.DEFAULTS.sims);
  // Land is worth its remaining growth pulses, so it decays with the clock.
  const config = m2ply.configOf({ enabled: true, horizon: 250, landCap: 5 }, {});
  assert.ok(m2ply.landWeight(10, config) > m2ply.landWeight(200, config));
  assert.equal(m2ply.landWeight(10, config), 5);
  assert.equal(m2ply.landWeight(400, config), 1);
});

test('m2ply: the baseline set is the planner matching, and batches leave no leftovers', () => {
  const op = (from, to, score) => ({ from, to, mode: 2, build: null, score, send: 1 });
  const candidates = [op(0, 1, 9), op(0, 2, 8), op(1, 3, 7), op(3, 4, 6)];
  assert.deepEqual(
    m2ply.collect(candidates, 16).map((o) => [o.from, o.to]),
    [
      [0, 1],
      [3, 4],
    ],
    'one order per source and per target',
  );
  const many = m2ply.collect(
    Array.from({ length: 40 }, (_, i) => op(i * 2, i * 2 + 1, 40 - i)),
    16,
  );
  assert.equal(many.length, 16, 'the cap is the room slot count');
  assert.deepEqual(
    m2ply.collect(candidates, 16, new Set([candidates[0]])).map((o) => [o.from, o.to]),
    [
      [0, 2],
      [1, 3],
    ],
    'a banned order frees its source and target for the next best',
  );
  // Multi-feed keeps the duplicate target, but an order whose source is another
  // order's target would stay queued in the engine, so it is dropped.
  const sanitized = m2ply.sanitize([
    { from: 1, to: 4, mode: 2, build: null },
    { from: 3, to: 4, mode: 2, build: null },
    { from: 4, to: 5, mode: 2, build: null },
    { from: 1, to: 4, mode: 2, build: null },
  ]);
  assert.deepEqual(
    sanitized.map((o) => [o.from, o.to]),
    [
      [1, 4],
      [3, 4],
    ],
  );
});

test('m2ply: the value prices army, land, crown safety and isolation', () => {
  const b = simBoard(1, 5, [
    [0, 101, 10],
    [1, 1, 0],
    [2, 200, 0],
    [3, 102, 70],
    [4, 2, 5],
  ]);
  const ctx = msim.contextOf(b);
  const st = simOf(b);
  const config = m2ply.configOf(
    { enabled: true, land: 1, landCap: 1, crown: 120, ring: 0, mass: 0, cut: 0.5, guard: 0 },
    { BOT3_M3PLY: 'off' },
  );
  // 10 army and two cells against 75 army and two cells, one crown each.
  assert.equal(m2ply.value(st, ctx, 1, 2, 60, config), 10 - 75);
  st.army[1] = 4;
  assert.equal(m2ply.value(st, ctx, 1, 2, 60, config), 14 - 75, 'interior army is plain army');
  st.code[2] = 1;
  assert.equal(m2ply.value(st, ctx, 1, 2, 60, config), 14 - 75 + 1, 'land is worth its weight');
  // A crown next to a bigger enemy stack is cheaper than a safe one.
  const safe = m2ply.value(st, ctx, 1, 2, 60, { ...config, guard: 1 });
  st.code[1] = 2;
  st.army[1] = 40;
  assert.ok(m2ply.value(st, ctx, 1, 2, 60, { ...config, guard: 1 }) < safe, 'an exposed crown is priced');
  st.code[1] = 1;
  st.army[1] = 4;
  // A finished game is bounded far outside any material difference.
  st.code[3] = 2;
  assert.ok(m2ply.value(st, ctx, 1, 2, 60, config) > 1e6, 'the rival has no crown left');
  st.code[3] = 102;
  st.code[0] = 1;
  assert.ok(m2ply.value(st, ctx, 1, 2, 60, config) < -1e6, 'we have no crown left');
  // Isolation is army the rival cannot spend.
  const cut = simBoard(1, 4, [
    [0, 101, 10],
    [1, 1, 4],
    [2, 1, 4],
    [3, 102, 10],
  ]);
  const cutState = simOf(cut);
  cutState.code[2] = 2;
  cutState.iso[2] = 1;
  const cutCtx = msim.contextOf(cut);
  assert.ok(
    m2ply.value(cutState, cutCtx, 1, 2, 60, config) >
      m2ply.value(cutState, cutCtx, 1, 2, 60, { ...config, cut: 0 }),
  );
});

test('m2ply: the tick+2 rollout fires captures, then feeds the ring', () => {
  const b = simBoard(2, 3, [
    [0, 101, 5],
    [1, 1, 6],
    [2, 200, 0],
    [3, 1, 4],
    [4, 1, 1],
    [5, 200, 0],
  ]);
  const st = simOf(b);
  const ctx = msim.contextOf(b);
  const config = m2ply.configOf({ enabled: true, fan: 0 }, {});
  const pairs = m2ply.rollout(st, ctx, 1, config).map((op) => [op.from, op.to, op.mode]);
  assert.ok(
    pairs.some(([from, to, mode]) => from === 1 && to === 2 && mode === 2),
    'a cell that can take a neutral cell does so with an all-in push',
  );
  assert.ok(
    pairs.some(([from, to]) => from === 3 && to === 4),
    'a spare cell feeds the armed frontier cell',
  );
  // Cell 0 faces a small garrison: it fires, so it is not a feed source either.
  assert.ok(!pairs.some(([from]) => from === 0), 'cell 0 only has the wall to its left');
});

test('m2ply: the candidate supply adds the shapes the planner cannot propose', () => {
  const b = simBoard(2, 3, [
    [0, 101, 5],
    [1, 1, 4],
    [2, 200, 0],
    [3, 1, 4],
    [4, 1, 1],
    [5, 200, 2],
  ]);
  const units = Float64Array.from(b.army_cnt);
  units[0] += 1; // crown growth on the tick the orders run
  const teams = new Uint8Array(b.size);
  for (let i = 0; i < b.size; i++) teams[i] = msim.ownerOf(b.grid_type[i]);
  const store = m2ply.freshStore(b.size);
  const ring = m2ply.ringMask(b.grid_type, teams, b.neighbors, 1, store);
  assert.deepEqual(Array.from(ring), [0, 1, 0, 0, 1, 0], 'cells 1 and 4 are frontier');
  const base = [{ from: 1, to: 2, mode: 2, build: null, send: 3, score: 40 }];
  const config = m2ply.configOf({ enabled: true, feeds: 3 }, {});
  const sets = m2ply.feedSets({
    b,
    turn: 10,
    candidates: base,
    base,
    pred: { relayMe: 2, ops: [] },
    units,
    teams,
    myTeam: 1,
    ring,
    config,
  });
  assert.ok(sets.length > 0, 'a ring cell that cannot take its target is fed');
  const feed = sets.find((variant) => variant.kind === 'feed');
  assert.ok(feed, 'two sources into one cell is offered (multi-feed)');
  assert.equal(feed.set.filter((op) => op.to === 4).length, 2, 'both neighbours feed the same cell');
  assert.ok(
    feed.set.every((op) => op.build || op.from !== 4),
    'the fed cell does not also try to fire on the same tick',
  );
  // A ring cell that can already capture is not a feed target.
  const easy = simBoard(2, 3, [
    [0, 101, 5],
    [1, 1, 4],
    [2, 200, 0],
    [3, 1, 1],
    [4, 1, 1],
    [5, 200, 0],
  ]);
  const easyUnits = Float64Array.from(easy.army_cnt);
  const easyTeams = new Uint8Array(easy.size);
  for (let i = 0; i < easy.size; i++) easyTeams[i] = msim.ownerOf(easy.grid_type[i]);
  const easyRing = m2ply.ringMask(easy.grid_type, easyTeams, easy.neighbors, 1, store);
  const easySets = m2ply.feedSets({
    b: easy,
    turn: 10,
    candidates: [],
    base: [],
    pred: { relayMe: 2, ops: [] },
    units: easyUnits,
    teams: easyTeams,
    myTeam: 1,
    ring: easyRing,
    config,
  });
  assert.equal(easySets.length, 1, 'the unarmed frontier cell is still fed');
  assert.ok(
    easySets.every((variant) => variant.set.every((op) => op.to !== 1)),
    'an armed ring cell is already firing, so it is not a feed target',
  );
});

test('m2ply: adopts a two-tick arming plan only when it wins the simulation', () => {
  const previousOn = process.env.BOT3_M2PLY;
  const previousThree = process.env.BOT3_M3PLY;
  const previousArm = process.env.BOT3_MSEARCH_ARM;
  process.env.BOT3_M2PLY = '1';
  process.env.BOT3_M3PLY = '0';
  process.env.BOT3_MSEARCH_ARM = '1';
  try {
    // Our crown can arm the ring cell 1, which then takes relay's last crown on
    // the second tick. The planner's own candidate is an unrelated merge.
    const b = simBoard(1, 5, [
      [0, 101, 9],
      [1, 1, 1],
      [2, 102, 3],
      [3, 1, 4],
      [4, 200, 0],
    ]);
    b.openingBudget = relayOpening.openingBudget(1);
    const board = [
      { id: 1, team: 1, army: 18, land: 4, dead: 0 },
      { id: 2, team: 2, army: 4, land: 1, dead: 0 },
    ];
    const pred = mqueue.predict(b, 5, board, true);
    assert.ok(pred);
    const candidates = [{ from: 3, to: 4, mode: 2, build: null, send: 3, score: 60 }];
    const teams = new Uint8Array(b.size);
    const units = Float64Array.from(b.army_cnt);
    for (let i = 0; i < b.size; i++) teams[i] = msim.ownerOf(b.grid_type[i]);
    units[0] += 1;
    const config = m2ply.configOf({ enabled: true, margin: 0 }, { BOT3_M3PLY: 'off' });
    // Not armed yet: the search stands down with the planner's own set.
    pred.armed = false;
    assert.equal(
      m2ply.choose({ b, turn: 5, candidates, pred, slots: 16, config, units, teams, myTeam: 1 }),
      null,
    );
    pred.armed = true;
    const picked = m2ply.choose({
      b,
      turn: 5,
      candidates,
      pred,
      slots: 16,
      config,
      units,
      teams,
      myTeam: 1,
    });
    assert.ok(picked, 'the arming plan is adopted');
    assert.ok(
      picked.some((op) => op.from === 0 && op.to === 1),
      'the crown feeds the frontier cell',
    );
    assert.ok(!picked.some((op) => op.from === 1), 'the fed cell does not also fire on the same tick');
    // A margin above the measured gain keeps the planner's set.
    const guarded = simBoard(1, 5, [
      [0, 101, 9],
      [1, 1, 1],
      [2, 102, 40],
      [3, 1, 4],
      [4, 200, 0],
    ]);
    guarded.openingBudget = b.openingBudget;
    const guardedPred = mqueue.predict(guarded, 5, board, true);
    guardedPred.armed = true;
    const cautious = m2ply.configOf({ enabled: true, margin: 100000 }, {});
    assert.equal(
      m2ply.choose({
        b: guarded,
        turn: 5,
        candidates,
        pred: guardedPred,
        slots: 16,
        config: cautious,
        units,
        teams,
        myTeam: 1,
      }),
      null,
    );
  } finally {
    if (previousOn === undefined) delete process.env.BOT3_M2PLY;
    else process.env.BOT3_M2PLY = previousOn;
    if (previousThree === undefined) delete process.env.BOT3_M3PLY;
    else process.env.BOT3_M3PLY = previousThree;
    if (previousArm === undefined) delete process.env.BOT3_MSEARCH_ARM;
    else process.env.BOT3_MSEARCH_ARM = previousArm;
  }
});

// --- Round 18: the third tick and the compounding value ---------------------

test('m3ply: the third tick and the compounding value are a separate switch', () => {
  // The shipped default is the round-18 layer; `BOT3_M3PLY=off` is the round-17
  // path and `BOT3_M3PLY=off BOT3_M2PLY=1` is the round-17 two-tick layer.
  const off = m2ply.configOf({}, { BOT3_M3PLY: 'off' });
  assert.equal(off.enabled, false);
  assert.equal(off.plies, 2);
  assert.equal(off.stream, false, 'the round-17 linear land weight');
  assert.equal(off.minFeed, 3, 'the round-17 donor bar');
  assert.equal(off.width, 0);
  assert.equal(off.cheap, 0);
  assert.equal(off.split, 0);
  assert.equal(off.stage, 0);
  // BOT3_M2PLY alone is still exactly the round-17 two-tick layer.
  const two = m2ply.configOf({}, { BOT3_M2PLY: '1', BOT3_M3PLY: '0' });
  assert.equal(two.enabled, true);
  assert.equal(two.plies, 2);
  assert.equal(two.stream, false);
  assert.equal(two.minFeed, 3);
  assert.equal(two.split, 0);
  const shipped = m2ply.configOf({}, {});
  assert.equal(shipped.enabled, true);
  assert.equal(shipped.plies, 3);
  const three = m2ply.configOf({}, { BOT3_M3PLY: '1' });
  assert.equal(three.enabled, true);
  assert.equal(three.plies, 3);
  assert.equal(three.stream, true);
  assert.equal(three.minFeed, 2);
  assert.ok(three.width > 0 && three.cheap > 0);
  assert.ok(three.split > 1 && three.stage >= 1);
  assert.equal(m2ply.configOf({}, { BOT3_M3PLY: 'off' }).enabled, false);
  assert.equal(m2ply.configOf({}, { BOT3_M3PLY: 'off', BOT3_M2PLY: '1' }).plies, 2);
  const clamped = m2ply.configOf(
    {},
    {
      BOT3_M3PLY: '1',
      BOT3_M3PLY_PLIES: '9',
      BOT3_M3PLY_DECAY: '4',
      BOT3_M3PLY_EXCHANGE: '-2',
      BOT3_M3PLY_MINFEED: '0',
      BOT3_M3PLY_STAGE: '99',
      BOT3_M3PLY_SPLIT: '42',
    },
  );
  assert.equal(clamped.plies, 3);
  assert.equal(clamped.decay, 1);
  assert.equal(clamped.exchange, 0);
  assert.equal(clamped.minFeed, 2);
  assert.equal(clamped.stage, 8);
  assert.equal(clamped.split, 8);
  // The compounding value can be asked for on its own, at two plies.
  assert.equal(m2ply.configOf({ enabled: true, plies: 2, stream: true }, {}).stream, true);
});

test('m3ply: land is priced as the remaining income stream, not one pulse', () => {
  const config = m2ply.configOf(
    { enabled: true, plies: 3, horizon: 250, landCap: 8, exchange: 1.5, decay: 0.95 },
    {},
  );
  assert.ok(m2ply.streamWeight(10, config) > m2ply.streamWeight(200, config));
  assert.ok(m2ply.streamWeight(200, config) > 1, 'a cell taken late still pays its one pulse');
  assert.equal(m2ply.streamWeight(250, config), 1, 'past the horizon a cell is just a cell');
  assert.ok(
    m2ply.streamWeight(100, { ...config, exchange: 3 }) > m2ply.streamWeight(100, config),
    'the exchange rate scales the stream',
  );
  const linear = { ...config, stream: false };
  assert.ok(
    m2ply.streamWeight(100, config) > m2ply.landWeight(100, linear),
    'the stream is at least the linear weight it replaces',
  );
  assert.equal(m2ply.landValue(100, config), m2ply.streamWeight(100, config));
  assert.equal(m2ply.landValue(100, linear), m2ply.landWeight(100, linear));
});

test('m3ply: the value prices ring width and a capture that is one feed away', () => {
  // Our ring cell 1 has two army and faces a one-army neutral (one feed away);
  // relay's ring is two cells wide but every cell there can fire already.
  const b = simBoard(1, 6, [
    [0, 101, 9],
    [1, 1, 2],
    [2, 200, 1],
    [3, 2, 3],
    [4, 102, 9],
    [5, 200, 0],
  ]);
  const ctx = msim.contextOf(b);
  const st = simOf(b);
  const zero = m2ply.configOf(
    {
      enabled: true,
      plies: 3,
      land: 0,
      crown: 0,
      ring: 0,
      mass: 0,
      cut: 0,
      guard: 0,
      width: 0,
      cheap: 0,
    },
    {},
  );
  assert.equal(m2ply.value(st, ctx, 1, 2, 60, zero), 11 - 12, 'plain army difference');
  assert.equal(
    m2ply.value(st, ctx, 1, 2, 60, { ...zero, cheap: 2 }),
    -1 + 2,
    'one ring cell becomes able to capture with a single feed',
  );
  assert.equal(
    m2ply.value(st, ctx, 1, 2, 60, { ...zero, width: 3 }),
    -1 - 3,
    'a ring one cell narrower than relay is a cost',
  );
  assert.equal(
    m2ply.value(st, ctx, 1, 2, 60, { ...zero, ring: 0, mass: 0, cheap: 0, width: 0 }),
    -1,
    'the terms are additive',
  );
});

test('m3ply: a two-army donor is enough to arm a ring cell', () => {
  // Cell 3 is a one-army ring cell facing an empty plain; its only donor is cell
  // 0 with two army, which pushes exactly one. The round-17 bar (three army)
  // finds no donor at all, which is why the supply was 1.14 donors per target.
  const b = simBoard(2, 3, [
    [0, 1, 2],
    [1, 200, 0],
    [2, 200, 0],
    [3, 1, 1],
    [4, 200, 0],
    [5, 201, 0],
  ]);
  const units = Float64Array.from(b.army_cnt);
  const teams = new Uint8Array(b.size);
  for (let i = 0; i < b.size; i++) teams[i] = msim.ownerOf(b.grid_type[i]);
  const store = m2ply.freshStore(b.size);
  const ring = m2ply.ringMask(b.grid_type, teams, b.neighbors, 1, store);
  assert.deepEqual(Array.from(ring), [1, 0, 0, 1, 0, 0]);
  const strict = m2ply.configOf({ enabled: true, minFeed: 3 }, {});
  assert.equal(m2ply.feedPlans({ b, units, teams, myTeam: 1, ring, config: strict }).length, 0);
  const cheapCfg = m2ply.configOf({ enabled: true, minFeed: 2 }, {});
  const plans = m2ply.feedPlans({ b, units, teams, myTeam: 1, ring, config: cheapCfg });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].target, 3);
  assert.deepEqual(
    plans[0].sources.map((s) => s.cell),
    [0],
    'the two-army neighbour is a donor',
  );
});

test('m3ply: the split and stage families arm two ring cells at once', () => {
  // Two independent lanes, each with a one-army ring cell and a spare donor.
  const b = simBoard(3, 2, [
    [0, 1, 2],
    [1, 1, 2],
    [2, 1, 1],
    [3, 1, 1],
    [4, 200, 0],
    [5, 200, 0],
  ]);
  const units = Float64Array.from(b.army_cnt);
  const teams = new Uint8Array(b.size);
  for (let i = 0; i < b.size; i++) teams[i] = msim.ownerOf(b.grid_type[i]);
  const store = m2ply.freshStore(b.size);
  const ring = m2ply.ringMask(b.grid_type, teams, b.neighbors, 1, store);
  const config = m2ply.configOf({ enabled: true, plies: 3, split: 2, stage: 2, feeds: 0 }, {});
  const plans = m2ply.feedPlans({ b, units, teams, myTeam: 1, ring, config });
  assert.equal(plans.length, 2, 'both ring cells are plans');
  const split = m2ply.splitSets({ plans, base: [], units, config });
  assert.equal(split.length, 1);
  assert.equal(split[0].kind, 'split');
  assert.deepEqual(
    split[0].set.map((op) => [op.from, op.to]).sort(),
    [
      [0, 2],
      [1, 3],
    ],
    'one donor into each ring cell',
  );
  const stage = m2ply.stageSets({ plans, base: [], units, config });
  assert.equal(stage.length, 1);
  assert.equal(stage[0].kind, 'stage');
  // Neither family may leave an order whose source is another order's target.
  for (const variant of [...split, ...stage]) {
    const targets = new Set(variant.set.map((op) => op.to));
    assert.ok(variant.set.every((op) => !targets.has(op.from)), 'sanitized batch');
  }
});

test('m3ply: the three-tick scorer prices an arming tick and adopts a clean batch', () => {
  const previousThree = process.env.BOT3_M3PLY;
  const previousArm = process.env.BOT3_MSEARCH_ARM;
  process.env.BOT3_M3PLY = '1';
  process.env.BOT3_MSEARCH_ARM = '1';
  try {
    // The crown arms ring cell 1, which takes the neutral cell 2 on tick + 2; the
    // planner's own order is a hopeless push into relay's forty-army crown.
    const b = simBoard(1, 5, [
      [0, 101, 9],
      [1, 1, 1],
      [2, 200, 1],
      [3, 1, 4],
      [4, 102, 40],
    ]);
    b.openingBudget = relayOpening.openingBudget(1);
    const board = [
      { id: 1, team: 1, army: 18, land: 4, dead: 0 },
      { id: 2, team: 2, army: 41, land: 1, dead: 0 },
    ];
    const pred = mqueue.predict(b, 5, board, true);
    assert.ok(pred);
    pred.armed = true;
    const candidates = [{ from: 3, to: 4, mode: 2, build: null, send: 3, score: 60 }];
    const teams = new Uint8Array(b.size);
    const units = Float64Array.from(b.army_cnt);
    for (let i = 0; i < b.size; i++) teams[i] = msim.ownerOf(b.grid_type[i]);
    units[0] += 1;
    const config = m2ply.configOf({ enabled: true, plies: 3, margin: 0 }, {});
    const picked = m2ply.choose({
      b,
      turn: 5,
      candidates,
      pred,
      slots: 16,
      config,
      units,
      teams,
      myTeam: 1,
    });
    assert.ok(picked, 'the three-tick search adopts the arming plan');
    const targets = new Set(picked.map((op) => op.to));
    assert.ok(picked.every((op) => !targets.has(op.from)), 'emitted batch leaves no queued order');
    assert.ok(
      picked.some((op) => op.from === 0 && op.to === 1),
      'the crown arms the frontier cell',
    );
    // The scorer itself must prefer the arming set over the planner's own order
    // once the third tick is included.
    const ctx = msim.contextOf(b);
    const store = m2ply.freshStore(b.size);
    msim.loadBoard(store.start, b, pred.ages ?? null);
    const base = m2ply.collect(candidates, 16).map((op) => ({ ...op, me: 1 }));
    // The feed family keeps every planner order that does not use the fed cell
    // or the donor as a source, and adds the arming move.
    const armed = [...base, { from: 0, to: 1, mode: 2, build: null, send: 8, me: 1 }];
    const baseScore = m2ply.threeTick(store, ctx, 5, [1, 2], 1, 2, base, pred.ops, pred, config);
    const feedScore = m2ply.threeTick(store, ctx, 5, [1, 2], 1, 2, armed, pred.ops, pred, config);
    assert.ok(Number.isFinite(baseScore) && Number.isFinite(feedScore));
    assert.ok(feedScore > baseScore, 'arming the ring wins the three-tick comparison');
  } finally {
    if (previousThree === undefined) delete process.env.BOT3_M3PLY;
    else process.env.BOT3_M3PLY = previousThree;
    if (previousArm === undefined) delete process.env.BOT3_MSEARCH_ARM;
    else process.env.BOT3_MSEARCH_ARM = previousArm;
  }
});

// --- Self-play-tuned multi-line evaluation (./mtune) ------------------------
const {
  mtuneConfig,
  mtuneUpdate,
  applyMtune,
  mshapeOverrides,
  mhalfOverrides,
  parseWeights,
  plainFrontier,
  crownField,
  BASE_WEIGHTS,
  WEIGHT_KEYS,
  DEFENCE_FLOOR,
  PULSE_WINDOW,
  RING_CAP,
} = require('./mtune');

// 9x9 walled board: our block on rows 2..5 x cols 2..5 (hop 0..3), a neutral
// shelf on row 1 and one rival plain at row 1 col 4.
function mtuneBlob() {
  const b = createBoard(9, 9, 1);
  b.grid_type.fill(201);
  for (let r = 2; r <= 5; r++)
    for (let c = 2; c <= 5; c++) {
      const i = r * 9 + c;
      b.grid_type[i] = 1;
      b.army_cnt[i] = 2;
    }
  b.grid_type[11] = 200; // row 1 col 2, neutral plain
  b.grid_type[12] = 200; // row 1 col 3, neutral plain
  b.grid_type[13] = 52; // row 1 col 4, rival plain
  b.grid_type[10] = 200; // row 1 col 1, neutral plain
  b.grid_type[2] = 200; // row 0 col 2, neutral plain (above the neutral shelf)
  return b;
}

function mtuneCtx(b) {
  return {
    tile: b.grid_type,
    teams: Uint8Array.from({ length: b.size }, (_, i) => (b.grid_type[i] < 150 ? b.grid_type[i] % 50 : 0)),
    units: b.army_cnt,
    neighbors: b.neighbors,
    myTeam: 1,
    hop: null,
  };
}

function mtunePlan(weights, turn = 60) {
  return { weights: parseWeights(weights), turn, crownDist: null, enemyCut: null, state: {} };
}

test('default the tuned multi-line evaluation off and validate its weight blob', () => {
  assert.equal(mtuneConfig({}, {}).enabled, false);
  assert.equal(mtuneConfig({}, { BOT3_MTUNE: '1' }).enabled, true);
  assert.equal(mtuneConfig({}, { BOT3_MTUNE: 'off' }).enabled, false);
  // An empty blob is the inherited round-16 evaluation, key for key.
  assert.deepEqual(parseWeights(undefined), BASE_WEIGHTS);
  assert.deepEqual(parseWeights({}), BASE_WEIGHTS);
  assert.deepEqual(Object.keys(parseWeights({})).sort(), [...WEIGHT_KEYS].sort());
  // The layer knobs the blob owns repeat the base environment, so the base blob
  // is a no-op and the screen reproduces the round-16 jsonl byte for byte.
  const base = mtuneConfig({ enabled: true, weights: BASE_WEIGHTS }, {});
  assert.deepEqual(mshapeOverrides(base), { slots: 64, leadCap: 110, steal: 100, water: 0, corridor: false });
  assert.deepEqual(mhalfOverrides(base), {
    reload: 60,
    hop: 6,
    leadCap: 110,
    retain: 0,
    floor: 2,
    minFire: 3,
    cheap: 0,
    startTurn: 0,
    endTurn: 0,
    corridor: false,
  });
  // Off means no overrides at all, so every other mshape/mhalf switch keeps
  // reading its own environment variable.
  assert.equal(mshapeOverrides({ enabled: false }), undefined);
  assert.equal(mhalfOverrides({ enabled: false }), undefined);
  // Every weight is clamped to its band, and a typo is refused instead of
  // silently tuning nothing.
  const clamped = parseWeights({ capture: 999, reload: -5, corridor: 5, slots: 0, ring: -99 });
  assert.equal(clamped.capture, 80);
  assert.equal(clamped.reload, 0);
  assert.equal(clamped.corridor, 1);
  assert.equal(clamped.slots, 1);
  assert.equal(clamped.ring, -8);
  assert.throws(() => parseWeights({ captur: 10 }), /unknown BOT3_MTUNE weight "captur"/);
  // A broken blob never takes the bot down mid-game: the config falls back to
  // the inherited numbers and reports why.
  const broken = mtuneConfig({}, { BOT3_MTUNE: '1', BOT3_MTUNE_JSON: '{oops' });
  assert.equal(broken.enabled, true);
  assert.deepEqual(broken.weights, BASE_WEIGHTS);
  assert.match(broken.error, /not valid JSON/);
});

test('reach the tuned evaluation only from a multi-line room', () => {
  const b = mtuneBlob();
  const config = mtuneConfig({ enabled: true, weights: parseWeights({ capture: 10 }) }, {});
  const input = { b, turn: 60, multi: true, size: b.size, targets: [13] };
  assert.equal(mtuneUpdate(b, input, mtuneConfig({}, {})), null);
  assert.equal(mtuneUpdate(b, { ...input, multi: false }, config), null);
  assert.equal(mtuneUpdate(b, { ...input, size: 100000 }, { ...config, maxBoard: 800 }), null);
  const plan = mtuneUpdate(b, input, config);
  assert.ok(plan);
  assert.equal(plan.turn, 60);
  assert.equal(plan.weights.capture, 10);
  assert.equal(b.mtuneLine.ticks, 1);
});

test('re-price the multi-line score bands from one blob', () => {
  const b = mtuneBlob();
  const ctx = mtuneCtx(b);
  const candidates = () => [
    { score: 32, from: 20, to: 11, mode: 2 }, // neutral capture
    { score: 62, from: 22, to: 13, mode: 2 }, // rival capture
    { score: 40, from: 20, to: 21, mode: 2 }, // own merge on the ring (lateral)
    { score: 40, from: 40, to: 31, mode: 2 }, // own merge behind the ring
    { score: 520, from: 30, to: 31, mode: 0 }, // defence merge
    { score: 100, from: 50, to: 51, mode: 2, build: true }, // build site
  ];
  const on = candidates();
  applyMtune(
    mtunePlan({ capture: 10, hostile: -15, merge: -30, lateral: 12, defence: 100 }),
    ctx,
    on,
  );
  assert.equal(on[0].score, 42);
  assert.equal(on[1].score, 47);
  assert.equal(on[2].score, 52);
  // hop[31] is 1, so the interior merge price applies instead of the lateral.
  assert.equal(on[3].score, 10);
  assert.equal(on[4].score, 620);
  assert.equal(on[5].score, 100);
  // Without the blob every score is the inherited one.
  const off = candidates();
  applyMtune(mtunePlan({}), ctx, off);
  assert.deepEqual(
    off.map((op) => op.score),
    [32, 62, 40, 40, 520, 100],
  );
});

test('price captures by the pulse they still pay out and by the ring they keep', () => {
  const b = mtuneBlob();
  const ctx = mtuneCtx(b);
  // The neutral shelf cell 11 keeps three plain neutral neighbours open.
  const open = plainFrontier(ctx, 11);
  assert.equal(open, 3);
  const at = (turn, weights, to = 11) => {
    const candidates = [{ score: 32, from: 20, to, mode: 2 }];
    applyMtune(mtunePlan(weights, turn), ctx, candidates);
    return candidates[0].score;
  };
  // t=50 is the pulse: the full weight; it decays linearly over the window.
  assert.equal(at(50, { pulse: 30 }), 32 + 30);
  assert.equal(at(50 + PULSE_WINDOW / 2, { pulse: 30 }), 32 + 15);
  assert.equal(at(50 + PULSE_WINDOW, { pulse: 30 }), 32);
  // A ring capture is worth more than a rival capture of the same price.
  assert.equal(at(60, { ring: 8 }) - at(60, {}), 8 * Math.min(RING_CAP, open));
  // Defence work is exempt from the merge prices.
  const defence = [{ score: DEFENCE_FLOOR, from: 30, to: 31, mode: 0 }];
  applyMtune(mtunePlan({ merge: -60, march: -60, lateral: -60 }), ctx, defence);
  assert.equal(defence[0].score, DEFENCE_FLOOR);
});

test('measure crown distance over every non-water cell', () => {
  const b = createBoard(1, 5, 1);
  b.grid_type.set([1, 1, 2, 1, 201]);
  const dist = crownField({ tile: b.grid_type, neighbors: b.neighbors }, [2]);
  assert.deepEqual([...dist], [2, 1, 0, 1, -1]);
  assert.equal(crownField({ tile: b.grid_type, neighbors: b.neighbors }, []), null);
});

// --- Geometry-gated crown bank (./bankgate) ---------------------------------
const {
  bankgateConfig,
  bankgateUpdate,
  applyBankgate,
  bankgateOrders,
  geometry,
  gateOpen,
  releaseNow,
  rearRise,
  ownField,
  deepBasin,
  pickVault,
  vaultOk,
  freshBankgate,
  DEFAULT_HOP,
  DEFAULT_FEED,
  DEFAULT_GAIN,
  DEFAULT_SAFE,
  DEFAULT_CROWNS,
  DEFAULT_CAP,
  DEFAULT_MIN_BASIN,
  DEFAULT_BEHIND,
  DEFAULT_GATE,
  DEFAULT_DEMAND,
  DEFAULT_REAR,
  DEFAULT_SWAMP,
  DEFAULT_MOUNTAIN,
  DEFAULT_RELEASE,
  DEFAULT_RELEASE_FILL,
  DEFAULT_RELEASE_GRACE,
} = require('./bankgate');

// A 1x8 strip of ours with an explicit hop field, so a test never depends on the
// planner's own distance bookkeeping.
function bankStrip(units = [1, 1, 1, 4, 4, 5, 4, 1], hop = [0, 1, 2, 3, 4, 5, 6, 7]) {
  const b = createBoard(1, 8, 1);
  b.grid_type.set(units.map((u) => (u > 0 ? 1 : 200)));
  b.army_cnt.set(units);
  return {
    b,
    ctx: {
      size: b.size,
      tile: b.grid_type,
      teams: Uint8Array.from(units.map((u) => (u > 0 ? 1 : 0))),
      units: Float64Array.from(units),
      neighbors: b.neighbors,
      myTeam: 1,
      me: 1,
      isolated: new Uint8Array(b.size),
      frontDist: Int32Array.from(hop),
      enemyDist: Int32Array.from(hop.map(() => 40)),
      cut: new Float64Array(b.size),
      army: units.reduce((s, u) => s + u, 0),
      enemyArmy: 1000,
      fogMask: null,
    },
  };
}

// The mechanism tests below are about the bank, not about the gate: they run
// the round-18 layer (`gate: false`) so a fixture does not have to pretend to
// be a swamp board. The gate itself has its own tests.
const bankOn = () => bankgateConfig({ enabled: true, gate: false });

test('ship the geometry-gated bank on and clamp its knobs', () => {
  // Round 19 ships the layer on: zero regressed cells in the full matrix.
  assert.equal(bankgateConfig({}, {}).enabled, true);
  assert.equal(bankgateConfig({}, { BOT3_BANKGATE: '1' }).enabled, true);
  assert.equal(bankgateConfig({}, { BOT3_BANKGATE: 'off' }).enabled, false);
  assert.equal(bankgateConfig({ enabled: false }, {}).enabled, false);
  const defaults = bankgateConfig({ enabled: true }, {});
  assert.equal(defaults.hop, DEFAULT_HOP);
  assert.equal(defaults.feed, DEFAULT_FEED);
  assert.equal(defaults.gain, DEFAULT_GAIN);
  assert.equal(defaults.safe, DEFAULT_SAFE);
  assert.equal(defaults.crowns, DEFAULT_CROWNS);
  assert.equal(defaults.cap, DEFAULT_CAP);
  assert.equal(defaults.minBasin, DEFAULT_MIN_BASIN);
  assert.equal(defaults.behind, DEFAULT_BEHIND);
  assert.equal(defaults.build, true);
  assert.equal(defaults.corridor, false);
  // The round-19 discriminator defaults.
  assert.equal(defaults.gate, DEFAULT_GATE === 1);
  assert.equal(defaults.demand, DEFAULT_DEMAND);
  assert.equal(defaults.rear, DEFAULT_REAR);
  assert.equal(defaults.swamp, DEFAULT_SWAMP);
  assert.equal(defaults.mountain, DEFAULT_MOUNTAIN);
  assert.equal(defaults.release, DEFAULT_RELEASE === 1);
  assert.equal(defaults.releaseFill, DEFAULT_RELEASE_FILL);
  assert.equal(defaults.releaseGrace, DEFAULT_RELEASE_GRACE);
  // Every knob is clamped and read per call.
  const clamped = bankgateConfig(
    {},
    {
      BOT3_BANKGATE: '1',
      BOT3_BANKGATE_HOP: '0',
      BOT3_BANKGATE_FEED: '999',
      BOT3_BANKGATE_CROWNS: '9',
      BOT3_BANKGATE_SAFE: '0',
      BOT3_BANKGATE_BEHIND: '-4',
      BOT3_BANKGATE_DEMAND: '-1',
      BOT3_BANKGATE_SWAMP: '999',
      BOT3_BANKGATE_RELEASE_GRACE: '-2',
    },
  );
  assert.equal(clamped.hop, 1);
  assert.equal(clamped.feed, 64);
  assert.equal(clamped.crowns, 4);
  assert.equal(clamped.safe, 1);
  assert.equal(clamped.behind, 0);
  assert.equal(clamped.demand, 0);
  assert.equal(clamped.swamp, 100);
  assert.equal(clamped.releaseGrace, 0);
  assert.equal(
    bankgateConfig({}, { BOT3_BANKGATE: '1', BOT3_BANKGATE_GAIN: 'abc' }).gain,
    DEFAULT_GAIN,
  );
  assert.equal(bankgateConfig({}, { BOT3_BANKGATE: '1', BOT3_BANKGATE_BUILD: '0' }).build, false);
  assert.equal(bankgateConfig({}, { BOT3_BANKGATE: '1', BOT3_BANKGATE_GATE: '0' }).gate, false);
  assert.equal(bankgateConfig({}, { BOT3_BANKGATE: '1', BOT3_BANKGATE_MOUNTAIN: '40' }).mountain, 40);
});

test('reach the bank only from a losing multi-line room', () => {
  const { b, ctx } = bankStrip();
  const off = bankgateConfig({ enabled: false });
  assert.equal(bankgateUpdate(b, { ...ctx, turn: 60, multi: true }, off), null);
  const on = bankOn();
  assert.equal(bankgateUpdate(b, { ...ctx, turn: 60, multi: false }, on), null);
  assert.equal(bankgateUpdate(b, { ...ctx, turn: 10, multi: true }, on), null);
  assert.equal(bankgateUpdate(b, { ...ctx, turn: 60, multi: true, size: 100000 }, on), null);
  assert.equal(bankgateUpdate(b, { ...ctx, turn: 60, multi: true, corridor: true }, on), null);
  assert.equal(
    bankgateUpdate(b, { ...ctx, turn: 60, multi: true, fog: true }, { ...on, fog: false }),
    null,
  );
  // The army-race gate: a vault is only started while we are behind.
  assert.equal(
    bankgateUpdate(b, { ...ctx, turn: 60, multi: true, army: 300, enemyArmy: 200 }, on),
    null,
  );
  assert.ok(bankgateUpdate(b, { ...ctx, turn: 60, multi: true, army: 150, enemyArmy: 200 }, on));
  // Once started the bank is finished even when the race flips (hysteresis).
  assert.ok(
    bankgateUpdate(b, { ...ctx, turn: 61, multi: true, army: 400, enemyArmy: 200 }, on),
    'a started bank survives the gate',
  );
  assert.equal(b.bankgate.cells.length, 1);
  assert.deepEqual(freshBankgate().cells, []);
});

test('measure the geometry the gate reads', () => {
  // A 2x5 board: our strip in the top row, a neutral plain left of it and a
  // neutral swamp right of it, a plain at the bottom left that no cell of ours
  // touches, a mountain in the bottom right.
  const b = createBoard(2, 5, 1);
  b.grid_type.set([200, 1, 1, 1, 204, 200, 1, 1, 1, 201]);
  const units = Float64Array.from([0, 2, 50, 3, 0, 0, 1, 1, 1, 0]);
  const teams = Uint8Array.from([0, 1, 1, 1, 0, 0, 1, 1, 1, 0]);
  const ctx = {
    size: 10,
    tile: b.grid_type,
    teams,
    units,
    neighbors: b.neighbors,
    myTeam: 1,
    isolated: new Uint8Array(10),
    frontDist: Int32Array.from([9, 0, 1, 4, 9, 9, 2, 2, 3, 9]),
    enemyDist: new Int32Array(10).fill(40),
    cut: Float64Array.from([0, 0, 9, 0, 0, 0, 0, 0, 0, 0]),
    fogMask: new Uint8Array(10),
    config: bankgateConfig({ enabled: true, gate: false }),
  };
  const g = geometry(ctx);
  assert.equal(g.own, 6);
  assert.equal(g.ring, 1);
  assert.equal(g.hop0, 2);
  assert.equal(g.hop1, 50);
  assert.equal(g.hop2, 2);
  assert.equal(g.hop3, 1);
  assert.equal(g.hop4, 3);
  // Hops 3 and beyond (cells 3 and 8) are the reservoir the layer banks.
  assert.equal(g.rear, 4);
  // Both neutral plains in reach (0 next to our ring, 5 under our cell 6) count
  // as demand; the neutral swamp at 4 is tracked separately.
  assert.equal(g.demand, 2);
  assert.equal(g.demandSwamp, 1);
  assert.equal(g.swampShare, 0.1);
  assert.equal(g.mountainShare, 0.1);
  assert.equal(g.articulations, 1, 'the cut weight marks cell 2 as an articulation');
  assert.equal(g.plains, 2);
  // A fogged neutral plain is not counted as demand (an unseen cell reports
  // `200`, so counting it would invent land that is not there).
  const fogged = { ...ctx, fogMask: Uint8Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0]) };
  assert.equal(geometry(fogged).demand, 0);
  // Fogging only the left plain still counts the visible one under our cell 6.
  const half = { ...ctx, fogMask: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]) };
  assert.equal(geometry(half).demand, 1);
});

test('gate the pick on measured geometry, not on the map name', () => {
  const on = bankgateConfig({ enabled: true });
  const state = freshBankgate();
  const geom = (over = {}) => ({
    demand: 3,
    rear: 40,
    swampShare: 0.5,
    mountainShare: 0.05,
    ...over,
  });
  assert.equal(gateOpen(state, geom(), on), true);
  // An open frontier still has income land to take: the rear army is a pipe.
  assert.equal(gateOpen(state, geom({ demand: 11, swampShare: 0.08 }), on), false);
  // A dry, open board never passes the terrain clause, however late the tick.
  const late = { ...on, demand: 100 };
  assert.equal(gateOpen(state, geom({ demand: 1, swampShare: 0.08 }), late), false);
  // A corridor board passes on its mountain share, not on its swamp share.
  const corridor = { ...on, mountain: 40 };
  assert.equal(
    gateOpen(state, geom({ demand: 1, swampShare: 0.08, mountainShare: 0.54 }), corridor),
    true,
  );
  assert.equal(
    gateOpen(state, geom({ demand: 1, swampShare: 0.08, mountainShare: 0.13 }), corridor),
    false,
  );
  // The reservoir clause is opt-in and reads the hop >= HOP army, absolute and
  // rising over the window.
  assert.equal(gateOpen(state, geom({ rear: 5 }), { ...on, rear: 30 }), false);
  assert.equal(gateOpen(state, geom({ rear: 50 }), { ...on, rear: 30 }), true);
  assert.equal(rearRise(state, geom({ rear: 50 }), on), 0, 'no history yet');
  state.hist.push({ turn: 20, rear: 10 }, { turn: 60, rear: 40 });
  assert.equal(rearRise(state, geom({ rear: 50 }), on), 40);
  assert.equal(gateOpen(state, geom({ rear: 50 }), { ...on, rise: 20 }), true);
  assert.equal(gateOpen(state, geom({ rear: 50 }), { ...on, rise: 60 }), false);
  // Zero on a clause disables it.
  const bare = bankgateConfig({ enabled: true, swamp: 0, mountain: 0, demand: 100 });
  assert.equal(gateOpen(state, geom({ demand: 99, rear: 0, swampShare: 0 }), bare), true);
  assert.equal(gateOpen(state, geom(), bankgateConfig({ enabled: true, gate: false })), true);
});

test('release a bank that cannot be held', () => {
  const on = bankgateConfig({ enabled: true, gate: false, release: true });
  const state = freshBankgate();
  const geom = (over = {}) => ({ demand: 3, land: 60, enemyLand: 60, ...over });
  state.cells.push({ cell: 3, done: false, pickTurn: 60, peak: 4 });
  // Inside the grace window nothing is released.
  assert.equal(releaseNow(state, geom(), on, 70), false);
  // After it, a bank that never filled is given back ...
  assert.equal(releaseNow(state, geom(), on, 100), true);
  // ... while a bank that filled is kept.
  state.cells[0].peak = 60;
  assert.equal(releaseNow(state, geom(), on, 100), false);
  // The starve rule is opt-in and needs both a starved frontier and a land
  // deficit against the rival (measured negative, off by default).
  const starve = { ...on, releaseDemand: 3, releaseTicks: 2, releaseGap: 5 };
  assert.equal(releaseNow(state, geom({ demand: 9 }), starve, 101), false);
  assert.equal(releaseNow(state, geom({ demand: 9, enemyLand: 80 }), starve, 102), true);
  assert.equal(
    releaseNow(state, geom({ demand: 9, enemyLand: 62 }), { ...starve, releaseGap: 20 }, 103),
    false,
  );
  // The switch is off by default: no release without it.
  assert.equal(releaseNow(state, geom(), bankgateConfig({}), 200), false);
});

test('bank the rear basin, never the ring', () => {
  const { b, ctx } = bankStrip();
  const on = bankOn();
  assert.equal(vaultOk(ctx, 0, on, true), false, 'the ring is off limits');
  assert.equal(vaultOk(ctx, 2, on, true), false, 'hop 2 is too shallow');
  assert.equal(vaultOk(ctx, 3, on, true), true);
  // A rival next door disqualifies the site; a held vault survives a rival two
  // hops out and is dropped only when the rival is adjacent.
  const near = { ...ctx, enemyDist: Int32Array.from([40, 40, 40, 2, 40, 40, 40, 40]) };
  assert.equal(vaultOk(near, 3, on, true), false);
  assert.equal(vaultOk(near, 3, on, false), true);
  const adjacent = { ...ctx, enemyDist: Int32Array.from([40, 40, 40, 1, 40, 40, 40, 40]) };
  assert.equal(vaultOk(adjacent, 3, on, false), false);
  // The basin behind cell 3 is cells 3..7.
  const basin = deepBasin(ctx, 3, 3);
  assert.equal(basin.cells, 5);
  assert.equal(basin.army, 18);
  assert.equal(basin.exits, 1);
  assert.equal(basin.outlets, 1);
  assert.equal(deepBasin(ctx, 5, 5).army, 10);
  // A dead end is not an outlet (its only neighbour is deeper), and a basin with
  // a second way out cannot be held by freezing one cell.
  assert.equal(deepBasin(ctx, 7, 7).exits, 1);
  assert.equal(pickVault({ ...ctx, frontDist: Int32Array.from(ctx.frontDist, () => 3) }, on, []), null);
  const twin = {
    ...ctx,
    size: 10,
    tile: Int32Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
    teams: Uint8Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
    units: Float64Array.from([1, 1, 1, 4, 4, 5, 4, 1, 1, 1]),
    neighbors: createBoard(1, 10, 1).neighbors,
    isolated: new Uint8Array(10),
    frontDist: Int32Array.from([0, 1, 2, 3, 4, 5, 6, 2, 3, 4]),
    enemyDist: new Int32Array(10).fill(40),
    cut: new Float64Array(10),
  };
  assert.equal(deepBasin(twin, 3, 3).outlets, 2);
  // `OUTLETS=1` is the strict rule; the shipped default (`8`) tolerates the
  // multi-outlet basins that measurably starve the frontier.
  assert.equal(pickVault(twin, { ...on, outlets: 1 }, []), null);
  assert.equal(pickVault(twin, on, []).cell, 3);
  assert.equal(pickVault(twin, { ...on, outlets: 40 }, []).cell, 3);
  assert.equal(pickVault(ctx, on, []).cell, 3);
  // With the first basin taken, the one behind it is the next best outlet.
  assert.equal(pickVault(ctx, on, [3]).cell, 4);
  assert.equal(pickVault(ctx, on, [3, 4]), null);
  assert.equal(pickVault(ctx, { ...on, minBasin: 40 }, []), null);
  const blocked = { ...ctx, enemyDist: Int32Array.from([40, 40, 40, 40, 40, 40, 2, 40]) };
  assert.equal(pickVault(blocked, on, []), null);
  assert.equal(b.bankgate, undefined, 'picking never allocates state by itself');
});

test('redirect rear merges into the bank and keep defence work', () => {
  const { b, ctx } = bankStrip();
  const on = bankOn();
  const plan = bankgateUpdate(b, { ...ctx, turn: 60, multi: true, army: 100, enemyArmy: 200 }, on);
  assert.ok(plan);
  assert.equal(plan.active[0].cell, 3);
  const candidates = [
    { score: 40, from: 4, to: 3, mode: 2 }, // already into the bank
    { score: 30, from: 5, to: 4, mode: 2 }, // steps toward the bank
    { score: 20, from: 3, to: 2, mode: 2 }, // drains the bank
    { score: 600, from: 3, to: 2, mode: 0 }, // defence keeps its slot
    { score: 32, from: 2, to: 1, mode: 2 }, // hop 2 is not the layer's business
  ];
  applyBankgate(plan, { ...ctx, teams: ctx.teams }, candidates);
  assert.equal(candidates.length, 4);
  assert.equal(candidates[0].score, 40 + DEFAULT_GAIN + 40);
  assert.equal(candidates[1].score, 30 + DEFAULT_GAIN);
  assert.equal(candidates[1].to, 4);
  assert.equal(candidates[2].score, 600, 'defence is exempt from the veto');
  assert.equal(candidates[3].score, 32, 'shallow merges are untouched');
});

test('feed the bank from several sources and buy the crown in two steps', () => {
  // 3x3 blob with the bank in the middle and four donors around it. The plan is
  // built by hand here: the site choice has its own test, this one is about the
  // batch the engine actually receives.
  const blob = createBoard(3, 3, 1);
  blob.grid_type.fill(1);
  blob.army_cnt.fill(3);
  blob.army_cnt[4] = 44;
  const hop = Int32Array.from([4, 4, 4, 4, 4, 4, 4, 4, 4]);
  const own = {
    size: 9,
    tile: blob.grid_type,
    teams: new Uint8Array(9).fill(1),
    units: Float64Array.from(blob.army_cnt),
    neighbors: blob.neighbors,
    myTeam: 1,
    me: 1,
    isolated: new Uint8Array(9),
    frontDist: hop,
    enemyDist: new Int32Array(9).fill(40),
    cut: new Float64Array(9),
    army: 68,
    enemyArmy: 90,
  };
  const on = bankOn();
  const plan = {
    config: on,
    state: freshBankgate(),
    active: [{ cell: 4, done: false, field: ownField(9, blob.neighbors, own.teams, 1, 4) }],
    crowns: [],
    keep: on.keep,
  };
  assert.deepEqual([...plan.active[0].field], [2, 1, 2, 1, 0, 1, 2, 1, 2]);
  const extra = bankgateOrders(plan, own, []);
  const feeds = extra.filter((op) => !op.build);
  // Four donors, four merges into the same cell: the engine runs them all.
  assert.equal(feeds.length, 4);
  assert.deepEqual(new Set(feeds.map((op) => op.to)), new Set([4]));
  assert.deepEqual(new Set(feeds.map((op) => op.from)), new Set([1, 3, 5, 7]));
  for (const op of feeds) assert.equal(op.mode, 2);
  // 44 army plus the deliveries pays for the city at once.
  assert.equal(extra.filter((op) => op.build).length, 1);
  assert.equal(extra.at(-1).build, 'b');
  assert.equal(extra.at(-1).from, 4);
  // A city upgrades on the next tick.
  const city = createBoard(3, 3, 1);
  city.grid_type.fill(1);
  city.grid_type[4] = 51;
  city.army_cnt.fill(1);
  city.army_cnt[4] = 50;
  const cityCtx = { ...own, tile: city.grid_type, units: Float64Array.from(city.army_cnt) };
  const cityOps = bankgateOrders(plan, cityCtx, []);
  assert.equal(cityOps.filter((op) => op.build).at(-1).build, 'c');
});

test('never chain two appended merges in one tick', () => {
  const { b, ctx } = bankStrip([1, 1, 1, 2, 5, 5, 5, 1]);
  const on = bankOn();
  const plan = bankgateUpdate(b, { ...ctx, turn: 60, multi: true, army: 100, enemyArmy: 200 }, on);
  assert.ok(plan);
  const extra = bankgateOrders(plan, ctx, []);
  // The engine drops a queued move whose source is another queued move's target.
  const sources = new Set(extra.map((op) => op.from));
  for (const op of extra) assert.equal(sources.has(op.to) && op.to !== op.from, false);
  assert.ok(extra.length >= 1);
  assert.equal(extra[0].to, 3);
  // An order the planner already emitted is never duplicated.
  const taken = [{ score: 40, from: 4, to: 3, mode: 2 }];
  const again = bankgateOrders(plan, ctx, taken);
  assert.equal(again.some((op) => op.from === 4), false);
  // A full bank stops taking army.
  const full = { ...ctx, units: Float64Array.from([1, 1, 1, 200, 5, 5, 5, 1]), army: 220 };
  assert.equal(bankgateOrders(plan, full, []).length, 0);
});

test('leave the planner byte-identical while the bank is off', () => {
  const previous = process.env.BOT3_BANKGATE;
  process.env.BOT3_BANKGATE = '0';
  try {
    const b = mshapeBlob(3);
    b.openingBudget = 3;
    const board = mshapeBlob(3);
    board.openingBudget = 3;
    const before = chooseOrders(b, 60, players, true);
    const after = chooseOrders(board, 60, players, true);
    assert.equal(b.bankgate, undefined, 'no state is allocated while the switch is off');
    assert.deepEqual(
      after.map((op) => [op.from, op.to, op.build ?? null, op.mode]),
      before.map((op) => [op.from, op.to, op.build ?? null, op.mode]),
    );
  } finally {
    if (previous === undefined) delete process.env.BOT3_BANKGATE;
    else process.env.BOT3_BANKGATE = previous;
  }
});

// --- Fog crown bank: the shallow gather band (./mcrown2) --------------------
const {
  mcrown2Config,
  mcrown2Update,
  DEFAULT_SHALLOW,
  DEFAULT_MINBANK,
} = require('./mcrown2');

// A 1x20 strip: eight of our plains at the front of the field and twelve cells
// of swamp behind them, so the board's swamp share is 60 % - between the
// archipelago share (64-67 %) and the mediterranean one (36-47 %). Cell 2 sits
// at hop 2 and cell 3 at hop 3, which is exactly the band the shallow switch
// decides between.
function shallowStrip(swampBehind = true) {
  const b = createBoard(1, 20, 1);
  for (let i = 0; i < 20; i++) b.grid_type[i] = i < 8 ? 1 : swampBehind ? 204 : 200;
  const units = [1, 1, 1, 4, 4, 5, 5, 1];
  for (let i = 0; i < 8; i++) b.army_cnt[i] = units[i];
  const hop = [0, 1, 2, 3, 3, 4, 4, 4];
  for (let i = 8; i < 20; i++) hop.push(1e6);
  return {
    b,
    input: {
      turn: 50,
      multi: true,
      fog: true,
      size: 20,
      tile: b.grid_type,
      teams: Uint8Array.from(Array.from({ length: 20 }, (_, i) => (i < 8 ? 1 : 0))),
      units: Float64Array.from(Array.from({ length: 20 }, (_, i) => (i < 8 ? units[i] : 0))),
      neighbors: b.neighbors,
      myTeam: 1,
      me: 1,
      isolated: new Uint8Array(20),
      frontDist: Int32Array.from(hop),
      enemyDist: new Int32Array(20).fill(40),
      cut: new Float64Array(20),
      army: 60,
      enemyArmy: 80,
      land: 8,
      enemyLand: 9,
    },
  };
}

test('gate the shallow gather band on the swamp share, on for island boards', () => {
  // Round 20 ships the shallow band at 55% swamp: on island boards the rear
  // basin is one hop shallower, so a hop-3 gather never pays for the second 50.
  assert.equal(DEFAULT_SHALLOW, 55);
  assert.equal(DEFAULT_MINBANK, 0);
  const shipped = mcrown2Config({}, {});
  assert.equal(shipped.shallow, 55);
  assert.equal(shipped.hop, 3);
  assert.equal(mcrown2Config({}, { BOT3_MCROWN2_SHALLOW: '55' }).shallow, 55);
  assert.equal(
    mcrown2Config({}, { BOT3_MCROWN2_SHALLOW: '55' }).hop,
    3,
    'the switch moves the band at run time, not the configured hop',
  );
  // Clamped into 0..100; a non-numeric value falls back to the shipped default,
  // and an explicit 0 turns the shallow band off.
  assert.equal(mcrown2Config({}, { BOT3_MCROWN2_SHALLOW: '500' }).shallow, 100);
  assert.equal(mcrown2Config({}, { BOT3_MCROWN2_SHALLOW: '0' }).shallow, 0);
  assert.equal(mcrown2Config({}, { BOT3_MCROWN2_SHALLOW: 'abc' }).shallow, DEFAULT_SHALLOW);
});

test('shorten the bank band to hop 2 only on a swamp board', () => {
  const base = { enabled: true, fogOnly: false, fog: true, swamp: 0, behind: 0 };
  const off = mcrown2Config({ ...base, shallow: 0 });
  const on = mcrown2Config({ ...base, shallow: 55 });
  // Every call gets a fresh board: the vault state lives on `b.mcrown2`, and a
  // second call would keep the first call's pick.
  // Off: the round-18 band, and the plan carries the very config object it was
  // given (nothing is rebuilt, so the shipped path is byte-identical).
  const idOff = shallowStrip(true);
  const shipped = mcrown2Update(idOff.b, idOff.input, off);
  assert.ok(shipped);
  assert.equal(shipped.config, off);
  assert.equal(shipped.config.hop, 3);
  assert.equal(shipped.active[0].cell, 3);
  // On, swamp 60 %: the band is hop 2, and the hop-2 cell is now the pick.
  const idWet = shallowStrip(true);
  const shallow = mcrown2Update(idWet.b, idWet.input, on);
  assert.ok(shallow);
  assert.equal(shallow.config.hop, 2);
  assert.notEqual(shallow.config, on);
  assert.equal(shallow.active[0].cell, 2);
  // On, dry board (0 % swamp): the gate keeps the round-18 band.
  const idDry = shallowStrip(false);
  const dryPlan = mcrown2Update(idDry.b, idDry.input, on);
  assert.ok(dryPlan);
  assert.equal(dryPlan.config, on);
  assert.equal(dryPlan.active[0].cell, 3);
});
