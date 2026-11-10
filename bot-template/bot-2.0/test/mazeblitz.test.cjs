'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeBoard } = require('../bot/board.cjs');
const { BLITZ_HELPERS } = require('../bot/planner.cjs');
const {
  BURST_END_TURN,
  mazeBlitzConfig,
  blitzEligible,
  mazeBlitzPlan,
  initialState,
  analyzeBranch,
  branchWorthClearing,
  waveFloor,
  enemyGuard,
} = require('../bot/mazeblitz.cjs');

const N = 7;
const M = 7;
const WALL = 201;
const at = (x, y) => x * M + y;
const PLAIN = 1; // neutral plain
const MOUNTAIN = WALL;

function withEnv(name, value, body) {
  const previous = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    return body();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

/**
 * A maze-like corridor with one fork:
 *
 *   (1,4) enemy crown                        <- target
 *   (2,4) our plain
 *   (3,4) our plain
 *   (4,4) junction: the wave lives here
 *   (4,3) enemy branch cell, (4,2) enemy building or plain
 *   (5,4) our plain
 *   (6,4) our crown
 *
 * Everything else is mountain.  The branch is a dead end: its only path to the
 * enemy crown runs through the junction we hold, so it is isolated unless the
 * test explicitly places an enemy anchor inside it.
 */
function forkBoard(options = {}) {
  const grid = Array(N * M).fill(MOUNTAIN);
  const army = Array(N * M).fill(0);
  const isolated = Array(N * M).fill(0);
  const fog = Array(N * M).fill(0);
  const own = (x, y, kind, count) => {
    grid[at(x, y)] = kind === 'crown' ? 101 : kind === 'city' ? 51 : 1;
    army[at(x, y)] = count;
  };
  const enemy = (x, y, kind, count) => {
    grid[at(x, y)] = kind === 'crown' ? 102 : kind === 'city' ? 52 : 2;
    army[at(x, y)] = count;
  };
  own(6, 4, 'crown', options.homeArmy ?? 100);
  own(5, 4, 'plain', options.linkArmy ?? 1);
  own(4, 4, 'plain', options.wave ?? 400);
  own(3, 4, 'plain', options.northArmy ?? 1);
  own(2, 4, 'plain', options.innerArmy ?? 1);
  enemy(1, 4, 'crown', options.crownArmy ?? 10);
  enemy(4, 3, 'plain', options.branchArmy ?? 5);
  if (options.branch === 'city') enemy(4, 2, 'city', options.branchCityArmy ?? 20);
  else if (options.branch === 'plain') enemy(4, 2, 'plain', options.branchInnerArmy ?? 20);
  return makeBoard({
    n: N,
    m: M,
    grid,
    army,
    isolated,
    fog,
    turn: options.turn ?? 62,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
}

function cells(b) {
  const own = [];
  const enemies = [];
  for (let i = 0; i < b.size; i += 1) {
    if (b.own(i) && !b.isolated[i]) own.push(i);
    if (b.enemy(i) && !b.isolated[i]) enemies.push(i);
  }
  return { own, enemies };
}

function memory(b, overrides = {}) {
  return {
    mapMode: 'maze',
    home: at(6, 4),
    enemyHome: at(1, 4),
    threatDistance: Object.create(null),
    blitz: { ...initialState(), ...overrides },
  };
}

function run(b, store, cfg) {
  const { own, enemies } = cells(b);
  return mazeBlitzPlan(b, store, own, enemies, BLITZ_HELPERS, cfg);
}

const enabledCfg = (extra = {}) => mazeBlitzConfig({ enabled: true, ...extra });

test('maze blitz is off by default and gated to maze rooms', () => {
  withEnv('APEX_MAZE_BLITZ', undefined, () => {
    assert.equal(mazeBlitzConfig().enabled, false);
    const b = forkBoard();
    assert.equal(blitzEligible(b, { mapMode: 'maze' }), false);
    assert.equal(run(b, memory({ phase: 'push' }), mazeBlitzConfig()), null);
  });
  withEnv('APEX_MAZE_BLITZ', '1', () => {
    const b = forkBoard();
    const cfg = mazeBlitzConfig();
    assert.equal(cfg.enabled, true);
    assert.equal(blitzEligible(b, { mapMode: 'maze' }, cfg), true);
    // terrain that merely looks like a maze must not opt an open room in
    assert.equal(blitzEligible(b, { mapMode: 'random' }, cfg), false);
    assert.equal(blitzEligible(b, {}, cfg), false);
  });
});

test('the burst opening spends every action on expansion and never builds', () => {
  const b = forkBoard({ turn: 30, wave: 200 });
  const m = memory();
  for (const turn of [0, BURST_END_TURN - 1, BURST_END_TURN]) {
    b.turn = turn;
    const decision = run(b, m, enabledCfg());
    assert.ok(decision, `expected an expansion decision at tick ${turn}`);
    assert.match(decision.branch, /^blitz-/);
    assert.notEqual(decision.action?.kind, 'build');
  }
  // The window ends exactly at the engine burst boundary; the same board then
  // switches to the muster phase instead of continuing to paint.
  b.turn = BURST_END_TURN + 1;
  run(b, m, enabledCfg());
  assert.equal(m.blitz.phase, 'muster');
});

test('the wave launches only once it covers the target, not at a token size', () => {
  const small = forkBoard({ wave: 60, homeArmy: 20 });
  const smallMemory = memory({ phase: 'muster', crown: at(1, 4), root: at(4, 4) });
  const waiting = run(small, smallMemory, enabledCfg());
  assert.ok(waiting);
  assert.notEqual(waiting.branch, 'blitz-march');
  assert.notEqual(waiting.branch, 'blitz-break');
  assert.equal(smallMemory.blitz.phase, 'muster');

  const big = forkBoard({ wave: 420 });
  const bigMemory = memory({ phase: 'muster', crown: at(1, 4), root: at(4, 4) });
  const launched = run(big, bigMemory, enabledCfg());
  assert.ok(launched);
  assert.match(launched.branch, /^blitz-(march|break)$/);
  assert.equal(launched.action.kind, 'attack');
  assert.equal(bigMemory.blitz.phase, 'push');
  assert.equal(bigMemory.blitz.launches, 1);
  // the march leaves the junction toward the crown, and a fresh floor of 340
  // on a small board is what gated the 60-unit column above
  assert.deepEqual([launched.action.dx, launched.action.dy], [3, 4]);
  assert.equal(waveFloor(big.size, enabledCfg()), 340);
});

test('a held junction keeps the wave moving past an isolated branch', () => {
  const b = forkBoard({ wave: 400, branch: 'plain', branchArmy: 5 });
  const store = memory({ phase: 'push', crown: at(1, 4), root: at(4, 4), prev: at(5, 4) });
  const connected = new Set();
  const branch = analyzeBranch(b, at(4, 4), at(4, 3), enabledCfg(), connected);
  assert.equal(branch.reconnectable, false);
  assert.equal(branch.building, null);
  assert.equal(branchWorthClearing(branch, enabledCfg()), false);

  const decision = run(b, store, enabledCfg());
  assert.ok(decision);
  assert.notEqual(decision.branch, 'blitz-fork');
  assert.equal(decision.branch, 'blitz-march');
  // the main wave keeps advancing north instead of detouring into the dead end
  assert.deepEqual([decision.action.dx, decision.action.dy], [3, 4]);
  assert.equal(store.blitz.splits, 0);
  assert.equal(store.blitz.detach, null);
});

test('a branch that can still reach an enemy anchor is cleared by a bounded split', () => {
  const b = forkBoard({ wave: 400, branch: 'city', branchCityArmy: 20, branchArmy: 5 });
  const store = memory({ phase: 'push', crown: at(1, 4), root: at(4, 4), prev: at(5, 4) });
  const decision = run(b, store, enabledCfg());
  assert.ok(decision);
  assert.equal(decision.branch, 'blitz-fork');
  // a fork split is always the half push, so the main column keeps the rest
  assert.equal(decision.action.mode, 1);
  assert.equal(decision.action.half, true);
  assert.deepEqual([decision.action.dx, decision.action.dy], [4, 3]);
  assert.equal(store.blitz.splits, 1);
  assert.ok(store.blitz.detach);
  assert.equal(store.blitz.detach.goal, at(4, 2));
});

test('the fork split is refused when it would leave the main column too weak', () => {
  const b = forkBoard({ wave: 120, branch: 'city', branchCityArmy: 110, branchArmy: 40 });
  const store = memory({ phase: 'push', crown: at(1, 4), root: at(4, 4), prev: at(5, 4) });
  const decision = run(b, store, enabledCfg());
  assert.ok(decision);
  assert.notEqual(decision.branch, 'blitz-fork');
  assert.equal(store.blitz.splits, 0);
});

test('the staging guard counts the enemy garrison, not our own', () => {
  const b = forkBoard({ crownArmy: 10, branchArmy: 5 });
  // crown 10 + the enemy branch stack at distance four
  assert.equal(enemyGuard(b, at(1, 4)), 15);
  // our own nearby army must not inflate the enemy guard
  b.army[at(3, 4)] = 500;
  assert.equal(enemyGuard(b, at(1, 4)), 15);
  // a real enemy stack inside the radius does
  b.army[at(2, 3)] = 40;
  b.grid[at(2, 3)] = 2;
  assert.equal(enemyGuard(b, at(1, 4)), 55);
});
