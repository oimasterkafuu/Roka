'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { distanceField, makeBoard } = require('../bot/board.cjs');
const { actionCoordinates } = require('../bot/rules.cjs');
const { plan, recover, routeGuard, constructionThreat, earlyRushThreat, mazeInfrastructureHold, sustainEconomy, treeGather, defensiveCut } = require('../bot/planner.cjs');

function corridor(sourceArmy, enemyArmy) {
  return makeBoard({
    n: 3, m: 3,
    grid: [101, 1, 201, 2, 1, 2, 201, 201, 201],
    army: [5, 30, 0, enemyArmy, sourceArmy, 10, 0, 0, 0],
    isolated: Array(9).fill(0), fog: Array(9).fill(0),
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
}

test('recognizes a saved no-build home reserve before it reaches the front', () => {
  const b = makeBoard({
    n: 1, m: 8,
    grid: [101, 1, 1, 1, 1, 2, 2, 102],
    army: [20, 20, 20, 20, 20, 20, 20, 20],
    isolated: Array(8).fill(0), fog: Array(8).fill(0), turn: 50,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
  const own = [0, 1, 2, 3, 4];
  const enemies = [5, 6, 7];
  assert.equal(earlyRushThreat(b, own, enemies), true);
});

test('protects a low crown before letting a saved home reserve trigger a raid', () => {
  const grid = [101, ...Array(23).fill(1), 102];
  const army = [80, 120, ...Array(23).fill(20)];
  for (let at = 19; at < 24; at += 1) grid[at] = 2;
  for (let at = 19; at < 24; at += 1) army[at] = 25;
  const b = makeBoard({
    n: 1, m: 25, grid, army,
    isolated: Array(25).fill(0), fog: Array(25).fill(0), turn: 60,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
  const own = [...Array(19).keys()];
  const enemies = [...Array(6).keys()].map((at) => at + 19);
  assert.equal(earlyRushThreat(b, own, enemies), true);
  const decision = plan(b, { playerId: 1, home: 0, threatDistance: {} });
  assert.equal(decision.branch, 'delayed-rush-guard');
  assert.equal(decision.action.x, 0);
  assert.equal(decision.action.y, 1);
  assert.equal(decision.action.dx, 0);
  assert.equal(decision.action.dy, 0);
  assert.notEqual(decision.action.kind, 'build');
});

test('detects an immediate home raid before the first construction window', () => {
  const grid = [101, ...Array(28).fill(1), 102];
  const army = [30, ...Array(28).fill(0), 30];
  for (let at = 24; at < 29; at += 1) grid[at] = 2;
  for (let at = 24; at < 29; at += 1) army[at] = 30;
  const b = makeBoard({
    n: 1, m: 30, grid, army,
    isolated: Array(30).fill(0), fog: Array(30).fill(0), turn: 30,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
  const own = [0];
  const enemies = [...Array(6).keys()].map((at) => at + 24);
  assert.equal(earlyRushThreat(b, own, enemies), true);
  const decision = plan(b, { playerId: 1, home: 0, threatDistance: {} });
  assert.equal(decision.branch, 'delayed-rush-wait');
});

test('guards the nearest weak crown when a saved reserve can choose a second crown', () => {
  const grid = Array(40).fill(1);
  const army = Array(40).fill(20);
  grid[0] = 101;
  grid[25] = 101;
  army[0] = 200;
  army[25] = 5;
  for (let at = 30; at < 39; at += 1) {
    grid[at] = 2;
    army[at] = 25;
  }
  grid[39] = 102;
  army[39] = 25;
  const b = makeBoard({
    n: 1, m: 40, grid, army,
    isolated: Array(40).fill(0), fog: Array(40).fill(0), turn: 70,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
  const own = [...Array(30).keys()];
  const enemies = [...Array(10).keys()].map((at) => at + 30);
  assert.equal(earlyRushThreat(b, own, enemies), true);
  const decision = plan(b, { playerId: 1, home: 0, threatDistance: {} });
  assert.equal(decision.branch, 'delayed-rush-guard');
  assert.equal(decision.action.dy, 25);
});

test('campaign refuses a safe head move when an older bridge can strand it', () => {
  const b = corridor(100, 80);
  const action = actionCoordinates(b, 4, 5, 2);
  assert.deepEqual(routeGuard(b, action), { blocked: true, anchor: -1, cut: 4 });
});

test('campaign can anchor a threatened bridge before committing the column', () => {
  const b = corridor(200, 110);
  const action = actionCoordinates(b, 4, 5, 2);
  assert.deepEqual(routeGuard(b, action), { blocked: true, anchor: 4, cut: 4 });
});

test('campaign keeps moving when the supply bridge can withstand the counterattack', () => {
  const b = corridor(100, 2);
  const action = actionCoordinates(b, 4, 5, 2);
  assert.deepEqual(routeGuard(b, action), { blocked: false, anchor: -1, cut: -1 });
});

test('sole crown gathers a full local column before a saved enemy stack arrives', () => {
  const b = makeBoard({
    n: 1, m: 4,
    grid: [1, 101, 1, 2],
    army: [5, 10, 80, 60],
    isolated: Array(4).fill(0), fog: Array(4).fill(0), turn: 60,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
  const decision = plan(b, { playerId: 1, home: 1, threatDistance: {} });
  assert.equal(decision.branch, 'anchor-approach');
  assert.deepEqual(decision.action, actionCoordinates(b, 2, 1, 0));
});

test('previews a direct enemy crown capture and reinforces before the hit', () => {
  const b = makeBoard({
    n: 2, m: 2,
    grid: [101, 2, 1, 1],
    army: [10, 60, 80, 1],
    isolated: Array(4).fill(0), fog: Array(4).fill(0), turn: 60,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
  const decision = plan(b, { playerId: 1, home: 0, threatDistance: {} });
  assert.equal(decision.branch, 'anchor-reinforce');
  assert.deepEqual(decision.action, actionCoordinates(b, 2, 0, 2));
});

test('opens a staged campaign before the full maze resistance is assembled', () => {
  const b = makeBoard({
    n: 1, m: 8,
    grid: [101, 1, 1, 2, 2, 2, 2, 102],
    army: [20, 170, 1, 4, 4, 4, 4, 8],
    isolated: Array(8).fill(0), fog: Array(8).fill(0), turn: 100,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
  const memory = {
    playerId: 1, home: 0,
    campaign: {
      crown: 7, at: 1, phase: 'gather', started: 0, lastPhase: 'gather',
      lastProgress: 0, deliveryBestDistance: Infinity, bestCrownDistance: 6,
      musterTurns: 2,
    },
    delivery: null, blocked: null, threatDistance: {},
  };
  const decision = plan(b, memory);
  assert.equal(decision.branch, 'march');
  assert.deepEqual(decision.action, actionCoordinates(b, 1, 2, 2));
});

test('pauses a long maze campaign after the opponent builds until anchors are funded', () => {
  const n = 5;
  const m = 15;
  const size = n * m;
  const grid = Array(size).fill(201);
  const army = Array(size).fill(0);
  for (let y = 0; y < m; y += 1) {
    const at = 2 * m + y;
    grid[at] = y === 1 ? 101 : y === 10 ? 52 : y === 14 ? 102 : 1;
    army[at] = y === 1 ? 120 : y === 10 ? 40 : y === 14 ? 40 : 30;
  }
  const b = makeBoard({
    n, m, grid, army, isolated: Array(size).fill(0), fog: Array(size).fill(0), turn: 80,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
  const memory = {
    playerId: 1, home: 31, enemyHome: 44,
    campaign: { crown: 44, at: 31, phase: 'gather' },
    delivery: null, threatDistance: {},
  };
  const own = [...Array(size).keys()].filter((at) => b.own(at));
  const enemies = [...Array(size).keys()].filter((at) => b.enemy(at));
  assert.equal(mazeInfrastructureHold(b, memory, own, enemies), true);
  const decision = plan(b, memory);
  assert.equal(memory.campaign, null);
  assert.equal(decision.branch, 'cluster-fund');
  assert.notEqual(decision.branch, 'march');
});

test('cuts an enemy supply articulation when direct crown defence cannot arrive', () => {
  const b = makeBoard({
    n: 2, m: 5,
    grid: [101, 1, 2, 2, 102, 1, 1, 1, 1, 1],
    army: [5, 20, 100, 20, 5, 5, 20, 1, 100, 1],
    isolated: Array(10).fill(0), fog: Array(10).fill(0), turn: 100,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
  const decision = defensiveCut(b, { at: 2, crown: 0, need: 100 });
  assert.equal(decision.branch, 'defense-cut');
  assert.deepEqual(decision.action, actionCoordinates(b, 8, 3, 2));
});

test('campaign gathers a token spearhead instead of marching it through a corridor', () => {
  const b = makeBoard({
    n: 3, m: 5,
    grid: [101, 1, 200, 2, 102, 201, 201, 201, 201, 201, 201, 201, 201, 201, 201],
    army: [20, 5, 0, 3, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    isolated: Array(15).fill(0), fog: Array(15).fill(0), turn: 100,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
  const memory = {
    playerId: 1,
    home: 0,
    campaign: {
      crown: 4, at: 1, phase: 'gather', started: 0, lastPhase: 'gather',
      lastProgress: 0, deliveryBestDistance: Infinity, bestCrownDistance: 3,
    },
    delivery: null, blocked: null, threatDistance: {},
  };
  const decision = plan(b, memory);
  assert.equal(decision.branch, 'muster');
  assert.deepEqual(decision.action, actionCoordinates(b, 0, 1, 0));
});

test('stalled campaign recovery clears stale cursors and resumes a safe frontier', () => {
  const b = makeBoard({
    n: 3, m: 5,
    grid: [101, 1, 0, 201, 102, 201, 201, 201, 201, 201, 201, 201, 201, 201, 201],
    army: [40, 20, 20, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    isolated: Array(15).fill(0), fog: Array(15).fill(0), turn: 160,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
  const memory = {
    playerId: 1,
    home: 0,
    campaign: { crown: 4, at: 1, phase: 'gather', started: 0 },
    delivery: { root: 1, at: 1 },
    blocked: { crown: 4, until: 999 },
    buildPlan: { cells: [1], index: 0 },
  };
  const decision = recover(b, memory, [0, 1, 2]);
  assert.ok(decision?.action);
  assert.equal(memory.campaign, null);
  assert.equal(memory.delivery, null);
  assert.deepEqual(memory.buildPlan, { cells: [1], index: 0 });
});

function investmentBoard(enemyArmy) {
  return makeBoard({
    n: 5, m: 5,
    grid: [101, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 102],
    army: [50, 10, 10, 10, 10, 0, 0, 0, 0, enemyArmy, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 30],
    isolated: Array(25).fill(0), fog: Array(25).fill(0), turn: 80,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
}

test('construction reserves a nearby garrison before spending fifty units', () => {
  const b = investmentBoard(80);
  assert.equal(constructionThreat(b, [0, 1, 2, 3, 4], [9, 24]), true);
  const memory = { playerId: 1, home: 0, threatDistance: {} };
  const decision = plan(b, memory);
  assert.equal(decision.branch, 'defend');
  assert.notEqual(decision.action?.kind, 'build');
});

test('construction resumes after the saved enemy stack is no longer a threat', () => {
  const b = investmentBoard(20);
  assert.equal(constructionThreat(b, [0, 1, 2, 3, 4], [9, 24]), false);
});

test('a cleared construction threat lets the existing cluster plan build again', () => {
  const b = makeBoard({
    n: 5, m: 5,
    grid: [101, ...Array(24).fill(1)],
    army: [60, 120, ...Array(23).fill(5)],
    isolated: Array(25).fill(0), fog: Array(25).fill(0), turn: 80,
    leaderboard: [{ id: 1, team: 1 }],
  }, 1);
  const memory = { playerId: 1, home: 0, threatDistance: {} };
  const decision = plan(b, memory);
  assert.equal(decision.branch, 'cluster-foundation');
  assert.equal(decision.action.kind, 'build');
});

test('route guard catches a large push that leaves a smaller branch exposed', () => {
  const b = makeBoard({
    n: 4, m: 4,
    grid: [101, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 2, 201, 201, 2, 201],
    army: [86, 146, 202, 85, 197, 148, 139, 18, 193, 71, 215, 15, 0, 0, 163, 0],
    isolated: Array(16).fill(0), fog: Array(16).fill(0), turn: 100,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
  const action = actionCoordinates(b, 10, 14, 2);
  assert.deepEqual(routeGuard(b, action), { blocked: true, anchor: 10, cut: 10 });
});

test('long campaigns can build a funded safe frontline site instead of hauling from the rear', () => {
  const grid = [101, ...Array(10).fill(1), 1, ...Array(22).fill(0), 102];
  const army = [1000, ...Array(9).fill(20), 100, 101, ...Array(22).fill(0), 20];
  const b = makeBoard({
    n: 1, m: 35, grid, army,
    isolated: Array(35).fill(0), fog: Array(35).fill(0), turn: 100,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
  const enemies = [34];
  const ed = require('../bot/board.cjs').distanceField(b, enemies);
  const memory = {
    playerId: 1,
    campaign: { at: 10 },
    delivery: null,
    rearEconomy: null,
  };
  const decision = sustainEconomy(b, memory, [...Array(12).keys()], ed, enemies);
  assert.equal(decision.branch, 'rear-foundation');
  assert.deepEqual(decision.action, { kind: 'build', x: 0, y: 11, op: 'b' });
});

test('frontline construction can use a bounded local supply branch', () => {
  const grid = [101, ...Array(12).fill(1), ...Array(21).fill(0), 102];
  const army = Array(35).fill(0);
  army[0] = 99;
  for (let at = 1; at <= 9; at += 1) army[at] = 1;
  army[10] = 100;
  army[11] = 20;
  army[12] = 90;
  army[34] = 20;
  const b = makeBoard({
    n: 1, m: 35, grid, army,
    isolated: Array(35).fill(0), fog: Array(35).fill(0), turn: 100,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
  const enemies = [34];
  const ed = require('../bot/board.cjs').distanceField(b, enemies);
  const memory = { playerId: 1, campaign: { at: 10 }, delivery: null, rearEconomy: null };
  const decision = sustainEconomy(b, memory, [...Array(13).keys()], ed, enemies);
  assert.equal(decision.branch, 'front-fund');
  assert.deepEqual(decision.action, { kind: 'attack', x: 0, y: 12, dx: 0, dy: 11, mode: 0, half: false });
  assert.equal(memory.rearEconomy.front, true);
});

test('tree gathering drains tributaries before their shared trunk', () => {
  const grid = [101, ...Array(9).fill(1)];
  const army = [1, 2, 2, 2, 20, 1, 1, 1, 30, 1];
  const b = makeBoard({
    n: 1, m: 10, grid, army,
    isolated: Array(10).fill(0), fog: Array(10).fill(0), turn: 100,
    leaderboard: [{ id: 1, team: 1 }],
  }, 1);
  const root = 0;
  const canEnter = (at) => b.own(at) && !b.isolated[at];
  const field = distanceField(b, [root], canEnter);
  const memory = { delivery: null };
  const sources = [
    { at: 4, p: [4, 3, 2, 1, 0] },
    { at: 8, p: [8, 7, 6, 5, 4, 3, 2, 1, 0] },
  ];
  const decision = treeGather(b, memory, root, 100, 'muster', canEnter, field, sources);
  assert.equal(decision.branch, 'muster-tree');
  assert.equal(decision.action.x, 0);
  assert.equal(decision.action.y, 8);
  assert.equal(decision.action.dy, 7);
  assert.equal(memory.delivery.edges[0][0], 8);
});
