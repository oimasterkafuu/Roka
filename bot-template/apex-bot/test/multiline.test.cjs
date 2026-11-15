'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { makeBoard } = require('../bot/board.cjs');
const { createController } = require('../bot/controller.cjs');
const { parallelActions } = require('../bot/multiline.cjs');
const { plan, routeGuard, safeMove } = require('../bot/planner.cjs');
const { actionCoordinates, preview } = require('../bot/rules.cjs');
const { attachStrategy } = require('../strategy.js');
const { createArena, runMatch } = require('../training/engine.cjs');

function board(overrides = {}) {
  return makeBoard(
    {
      n: 2,
      m: 4,
      grid: [101, 1, 200, 102, 1, 1, 200, 2],
      army: [30, 20, 0, 10, 70, 20, 0, 1],
      turn: 60,
      multiLine: true,
      ...overrides,
    },
    1,
  );
}
function memory() {
  return { byBranch: {}, actions: 0 };
}

test('independent heads and construction execute in the same authoritative tick', () => {
  const arena = createArena({ mapSize: 0.2, engineConfig: { multi_line: true }, captureReplay: false });
  const e = arena.engine;
  // Use an explicit connected 2x4 board; neutralise other generated cells.
  for (let x = 0; x < e.n; x++) {
    for (let y = 0; y < e.m; y++) {
      e.gridType[x][y] = 0;
      e.owner[x][y] = 0;
      e.armyCnt[x][y] = 0;
    }
  }
  e.gridType[0][0] = -2;
  e.owner[0][0] = 1;
  e.armyCnt[0][0] = 40;
  e.owner[0][1] = 1;
  e.armyCnt[0][1] = 30;
  e.owner[1][0] = 1;
  e.armyCnt[1][0] = 60;
  e.gridType[e.n - 1][e.m - 1] = -2;
  e.owner[e.n - 1][e.m - 1] = 2;
  e.armyCnt[e.n - 1][e.m - 1] = 20;
  arena.tick([
    [
      { kind: 'attack', x: 0, y: 1, dx: 0, dy: 2, mode: 2 },
      { kind: 'build', x: 1, y: 0, op: 'b' },
    ],
    null,
  ]);
  assert.equal(e.owner[0][2], 1);
  assert.equal(e.gridType[1][0], -1);
  assert.equal(arena.stats[0].attacks, 1);
  assert.equal(arena.stats[0].builds, 1);
});

test('parallel endpoints cannot depend on or double spend one another', () => {
  const b = board();
  const actions = parallelActions(b, memory(), {
    action: { kind: 'attack', x: 0, y: 1, dx: 0, dy: 2, mode: 2 },
    branch: 'march',
  });
  assert.ok(actions.length > 1);
  const endpoints = new Set();
  for (const a of actions) {
    const from = b.idx(a.x, a.y);
    const to = a.kind === 'attack' ? b.idx(a.dx, a.dy) : from;
    assert.ok(!endpoints.has(from));
    assert.ok(!endpoints.has(to));
    endpoints.add(from);
    endpoints.add(to);
  }
});

test('auxiliary expansion obeys the global army budget', () => {
  const b = board({
    grid: [101, 1, 200, 200, 1, 200, 200, 200],
    army: [50, 20, 0, 0, 20, 0, 0, 0],
  });
  const actions = parallelActions(b, { ...memory(), campaign: { at: 0 } }, {});
  const expansion = actions.filter((action) => action.kind === 'attack');
  assert.equal(expansion.length, 1);
  const spent = expansion.reduce((sum, action) => sum + preview(b, action).send, 0);
  assert.ok(spent <= Math.floor(90 * 0.2));
});

test('auxiliary lanes preserve campaign, defence, and economy delivery chains', () => {
  const b = board({
    grid: [101, 1, 200, 200, 1, 1, 200, 200],
    army: [30, 20, 0, 0, 70, 110, 0, 0],
  });
  const state = {
    ...memory(),
    campaign: { at: 0 },
    delivery: { at: 4, root: 0, edges: [[4, 0]] },
    parallelDefense: { threatDistance: {}, delivery: { at: 5, root: 4, edges: [[5, 4]] } },
    rearEconomy: { site: 5, delivery: { at: 5, root: 4, edges: [[5, 4]] } },
  };
  const actions = parallelActions(b, state, {});
  assert.deepEqual(
    actions.filter((action) => action.kind === 'attack').map((action) => b.idx(action.x, action.y)),
    [1],
  );
});

test('contact expansion rejects token columns and overwhelming counter-pressure', () => {
  const frame = (source, enemy = 1) =>
    board({ n: 1, m: 4, grid: [101, 1, 200, 102], army: [300, source, 0, enemy] });
  assert.equal(parallelActions(frame(8), memory(), {}).length, 0);
  assert.equal(parallelActions(frame(30, 100), memory(), {}).length, 0);
  const actions = parallelActions(frame(30), memory(), {});
  assert.equal(actions.length, 1);
  assert.equal(actions[0].x, 0);
  assert.equal(actions[0].y, 1);
});

test('building thresholds are 51 for foundation and 101 for upgrade', () => {
  for (const [kind, low, high, op] of [
    [1, 50, 51, 'b'],
    [51, 100, 101, 'c'],
  ]) {
    const frame = (count) => board({ n: 1, m: 2, grid: [101, kind], army: [1000, count] });
    assert.ok(!parallelActions(frame(low), memory(), {}).some((a) => a.kind === 'build'));
    assert.ok(parallelActions(frame(high), memory(), {}).some((a) => a.kind === 'build' && a.op === op));
    const decision = (count) =>
      plan(frame(count), { home: 0, threatDistance: {}, buildPlan: { cells: [1], index: 0 } });
    assert.notEqual(decision(low).action?.kind, 'build');
    assert.equal(decision(high).action?.kind, 'build');
    assert.equal(decision(high).action?.op, op);
  }
});

test('sustained economy uses the same multi-line construction thresholds', () => {
  for (const [kind, low, high, op] of [
    [1, 50, 51, 'b'],
    [51, 100, 101, 'c'],
  ]) {
    const frame = (count) => {
      const grid = Array(30).fill(200);
      const army = Array(30).fill(0);
      grid[0] = 101;
      grid[1] = kind;
      grid[29] = 102;
      army[0] = 300;
      army[1] = count;
      army[29] = 20;
      return board({ n: 1, m: 30, grid, army, turn: 100 });
    };
    const decision = (count) =>
      plan(frame(count), {
        home: 0,
        threatDistance: {},
        rearEconomy: { site: 1, delivery: null, spent: 0, nextWindow: 0, front: false },
      });
    assert.notEqual(decision(low).action?.kind, 'build');
    assert.equal(decision(high).action?.kind, 'build');
    assert.equal(decision(high).action?.op, op);
  }
});

test('multi-line crown capture bypasses the conservative route finish gate', () => {
  const raw = {
    n: 3,
    m: 3,
    grid: [101, 1, 201, 102, 1, 102, 201, 201, 201],
    army: [5, 10, 0, 10, 100, 80, 0, 0, 0],
    turn: 60,
  };
  const legacy = makeBoard(raw, 1);
  const multi = makeBoard({ ...raw, multiLine: true }, 1);
  const action = actionCoordinates(multi, 4, 5, 2);
  assert.equal(routeGuard(legacy, action).blocked, true);
  assert.equal(routeGuard(multi, action).blocked, false);
  assert.deepEqual(safeMove(multi, 4, 5, 'campaign'), action);
});

test('legacy chooseBatch stays one action and repeated ticks emit nothing', () => {
  const c = createController(1);
  const legacy = board({ multiLine: false });
  assert.ok(c.chooseBatch(legacy).length <= 1);
  assert.deepEqual(c.chooseBatch(legacy), []);
});

test('single-line choose and chooseBatch produce identical authoritative matches', () => {
  const run = (batch) => {
    const controller = createController(1);
    const result = runMatch({
      mapMode: 'random',
      seed: 'apex-single-line-parity',
      mapSize: 0.2,
      maxTurns: 120,
      engineConfig: { multi_line: false },
      policies: [(state) => (batch ? controller.chooseBatch(state) : controller.choose(state)), () => null],
      traceLimit: 1,
    });
    return { result, controller };
  };
  const legacy = run(false);
  const wrapped = run(true);
  assert.equal(wrapped.result.replay.finalStateSha256, legacy.result.replay.finalStateSha256);
  assert.deepEqual(
    wrapped.result.stats.map(({ attacks, builds, upgrades }) => ({ attacks, builds, upgrades })),
    legacy.result.stats.map(({ attacks, builds, upgrades }) => ({ attacks, builds, upgrades })),
  );
  assert.deepEqual(wrapped.controller.stats().byBranch, legacy.controller.stats().byBranch);
});

test('reconnect restores the global queue and removes only acknowledged seqs', async () => {
  const socket = new EventEmitter();
  socket.connected = false;
  const sent = [];
  const emit = socket.emit.bind(socket);
  socket.emit = (name, payload) => {
    sent.push({ name, payload });
    return emit(name, payload);
  };
  const bot = attachStrategy(socket, { room: 'test', heartbeatIntervalMs: 0 });
  socket.emit('set_id', 'me');
  socket.emit('init_map', {
    n: 1,
    m: 4,
    player_ids: ['me', 'other'],
    multi_line: true,
    next_seq: 44,
    queue_ops: [
      { kind: 'm', x: 0, y: 0, dx: 0, dy: 1, mode: 2, seq: 41 },
      { kind: 'm', x: 0, y: 1, dx: 0, dy: 2, mode: 2, seq: 43 },
    ],
  });
  assert.equal(bot.state.nextSeq, 44);
  const frame = { turn: 1, grid_type: [101, 1, 200, 102], army_cnt: [10, 30, 0, 1], lst_moves: [41] };
  socket.emit('update', frame);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(
    bot.state.queueOps.map((op) => op.seq),
    [43],
  );
  assert.equal(sent.filter((item) => item.name === 'attack').length, 0);
  socket.emit('update', { ...frame, turn: 2, lst_moves: [43] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(bot.state.nextSeq > 44);
  assert.ok(bot.state.queueOps.every((op) => op.seq >= 44));
  assert.equal(sent.filter((item) => item.name === 'clear_queue').length, 0);
  bot.stop();
});

test('rebind init preserves multi-line mode but a new single-line game resets it', () => {
  const socket = new EventEmitter();
  socket.connected = false;
  const bot = attachStrategy(socket, { room: 'test', heartbeatIntervalMs: 0 });
  socket.emit('set_id', 'me');
  const init = { n: 1, m: 4, player_ids: ['me', 'other'], next_seq: 44, queue_ops: [] };
  socket.emit('init_map', { ...init, multi_line: true });
  socket.emit('disconnect');
  socket.emit('init_map', init);
  assert.equal(bot.state.multiLine, true);
  assert.equal(bot.state.nextSeq, 44);
  socket.emit('update', {
    turn: 1,
    grid_type: [101, 1, 200, 102],
    army_cnt: [10, 30, 0, 1],
    lst_moves: [],
    game_end: true,
  });
  socket.emit('init_map', init);
  assert.equal(bot.state.multiLine, false);
  bot.stop();
});

test('large-board auxiliary cuts cannot withdraw a reserved campaign convoy', () => {
  const grid = Array(800).fill(201);
  const army = Array(800).fill(0);
  for (const [at, tile, troops] of [[0, 101, 200], [1, 1, 70], [2, 52, 1], [799, 102, 20]]) {
    grid[at] = tile;
    army[at] = troops;
  }
  const b = board({ n: 1, m: 800, grid, army });
  const state = {
    ...memory(),
    campaign: { at: 0 },
    delivery: { at: 1, root: 0, edges: [[1, 0]] },
  };
  assert.ok(parallelActions(b, state, {}).every((a) => b.idx(a.x, a.y) !== 1));
});

test('multi-line previews keep frames and independent lane results isolated', () => {
  const b = board();
  const original = b.army.slice();
  const move = actionCoordinates(b, 1, 2, 2);
  const building = { kind: 'build', x: 1, y: 0, op: 'b' };
  const first = preview(b, move);
  const built = preview(b, building);
  const combined = preview(first.after, building);
  assert.equal(built.after.army[4], 20);
  assert.equal(combined.after.army[4], 20);
  assert.equal(combined.after.owner(2), 1);
  assert.equal(built.after.owner(2), 0);
  assert.deepEqual(b.army, original);
  const next = board({ army: [30, 40, 0, 10, 70, 20, 0, 1] });
  assert.equal(preview(next, move).send, 39);
  assert.equal(first.send, 19);
});

test('multi-line campaign retains a captured breach for the next crown', () => {
  const b = board({
    n: 1, m: 10,
    grid: [101, 1, 1, 1, 1, 1, 1, 1, 102, 102],
    army: [500, 200, 1, 1, 1, 1, 1, 1, 20, 20],
    turn: 200,
  });
  const state = {
    ...memory(), home: 0, enemyHome: 9, threatDistance: {}, maze: false,
    campaign: { at: 1, crown: 1, phase: 'attack', started: 199, lastProgress: 199 },
  };
  const decision = plan(b, state);
  assert.equal(state.campaign.at, 1);
  assert.equal(state.campaign.crown, 9);
  assert.equal(decision.branch, 'march');
  assert.equal(decision.action.y, 1);
  assert.equal(decision.action.dy, 2);
});

test('decisive multi-line assault rebases near an isolated spearhead', () => {
  const raw = {
    n: 1, m: 7,
    grid: [101, 1, 1, 1, 200, 102, 102],
    army: [500, 1, 200, 80, 0, 20, 20],
    isolated: [0, 1, 1, 0, 0, 0, 0],
    turn: 200,
  };
  const campaign = { at: 2, crown: 5, phase: 'attack', started: 190, lastProgress: 199 };
  const first = plan(board(raw), {
    ...memory(), home: 0, enemyHome: 5, threatDistance: {}, maze: false, campaign,
  });
  assert.equal(first.branch, 'march');
  assert.equal(first.action.y, 3);
  assert.equal(first.action.dy, 4);
  assert.equal(campaign.crown, 5);
  assert.equal(campaign.at, 3);

  const legacy = plan(board({ ...raw, multiLine: false }), {
    ...memory(), home: 0, enemyHome: 5, threatDistance: {}, maze: false,
    campaign: { at: 2, crown: 5, phase: 'attack', started: 190, lastProgress: 199 },
  });
  assert.equal(legacy.action.y, 0);
  assert.equal(legacy.action.dy, 1);
});

test('high-swamp maps keep the original isolated-assault recovery', () => {
  const raw = {
    n: 1, m: 7,
    grid: [101, 151, 151, 151, 204, 102, 102],
    army: [500, 1, 200, 80, 0, 20, 20],
    isolated: [0, 1, 1, 0, 0, 0, 0],
    turn: 200,
  };
  const campaign = () => ({ at: 2, crown: 5, phase: 'attack', started: 190, lastProgress: 199 });
  const state = () => ({ ...memory(), home: 0, enemyHome: 5, threatDistance: {}, maze: false, campaign: campaign() });
  const multi = plan(board(raw), state());
  const legacy = plan(board({ ...raw, multiLine: false }), state());
  assert.deepEqual(multi, legacy);
});
