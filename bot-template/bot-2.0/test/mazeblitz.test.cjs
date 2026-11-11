'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeBoard } = require('../bot/board.cjs');
const { preview } = require('../bot/rules.cjs');
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
  launchCell,
  homeCrownExposed,
  routeNeed,
  pushModes,
  cheapForwardTarget,
  blitzGather,
  isJunction,
  growthAt,
  guardTimeline,
  selectHalfPushes,
  junctionThreat,
  classifySides,
  fullPushException,
  trackIsolatedBranches,
  computeDefense,
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
 *   (4,2)-(3,2)-(2,2) optional external exit (branchExit)
 *   (5,4) our plain
 *   (6,4) our crown
 *
 * Everything else is mountain.  The branch is a dead end: its only path to the
 * enemy crown runs through the junction we hold, so it is isolated unless the
 * test explicitly places an enemy anchor inside it.  `branchExit: 'force'`
 * puts an enemy stack behind the second doorway (a real reconnection route),
 * `branchExit: 'void'` makes that doorway lead to neutral ground only.
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
  if (options.branchExit) {
    // Second doorway out of the branch that does not use the junction.
    grid[at(3, 2)] = 1;
    army[at(3, 2)] = 0;
    if (options.branchExit === 'force') enemy(2, 2, 'plain', options.branchExitArmy ?? 30);
    else {
      grid[at(2, 2)] = 1;
      army[at(2, 2)] = 0;
    }
  }
  // The engine freezes every cell of a branch that no longer reaches an enemy
  // anchor, so a structurally dead branch is isolated on the frame too: its
  // stacks cannot move at all.  `branch: 'city'` keeps an enemy anchor inside
  // the branch, which is what makes it live.
  const anchored = options.branch === 'city' || options.branch === 'crown';
  if (!anchored) {
    for (let x = 2; x <= 4; x += 1) {
      for (let y = 1; y <= 3; y += 1) {
        const code = grid[at(x, y)];
        if (code === 2 || code === 52 || code === 102) isolated[at(x, y)] = 1;
      }
    }
  }
  return makeBoard(
    {
      n: N,
      m: M,
      grid,
      army,
      isolated,
      fog,
      turn: options.turn ?? 62,
      leaderboard: [
        { id: 1, team: 1 },
        { id: 2, team: 2 },
      ],
    },
    1,
  );
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

// Apply a decision through the real preview so the junction tests see the same
// board the engine would on the next tick.
function apply(b, action) {
  const result = preview(b, action);
  assert.equal(result.ok, true, 'the decision must be a legal action');
  b.grid = result.grid;
  b.army = result.army;
  b.isolated = result.isolated;
  b.turn += 1;
  return result;
}

function expectForward(b, action, crown) {
  const f = BLITZ_HELPERS.field(b, [crown]);
  const from = b.idx(action.x, action.y);
  const to = b.idx(action.dx, action.dy);
  assert.ok(f.distance[to] < f.distance[from], `expected a move toward the crown, got ${from} -> ${to}`);
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

test('the burst window belongs to the default planner and is only observed', () => {
  const b = forkBoard({ turn: 30, wave: 200 });
  const m = memory();
  const cfg = enabledCfg({ gate: false });
  for (const turn of [0, BURST_END_TURN - 1]) {
    b.turn = turn;
    assert.equal(run(b, m, cfg), null, `the blitz must not act at tick ${turn}`);
    assert.equal(m.blitz.phase, 'expand');
  }
  // The observation window ends exactly at the engine burst boundary: the same
  // board then hands the launch tick to the gate/muster instead of painting.
  b.turn = BURST_END_TURN + 1;
  run(b, m, cfg);
  assert.equal(m.blitz.phase, 'muster');
});

test('the wave launches only once it covers the target, not at a token size', () => {
  const small = forkBoard({ wave: 60, homeArmy: 20 });
  const smallMemory = memory(small, { phase: 'muster', crown: at(1, 4), root: at(4, 4) });
  const waiting = run(small, smallMemory, enabledCfg());
  assert.ok(waiting);
  assert.notEqual(waiting.branch, 'blitz-march');
  assert.notEqual(waiting.branch, 'blitz-break');
  assert.equal(smallMemory.blitz.phase, 'muster');

  const big = forkBoard({ wave: 420, homeArmy: 20 });
  const bigMemory = memory(big, { phase: 'muster', crown: at(1, 4), root: at(4, 4) });
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

test('a dead branch with no alternative exit never earns a half push', () => {
  const b = forkBoard({ wave: 400, branch: 'plain', branchArmy: 5 });
  const store = memory(b, { phase: 'push', crown: at(1, 4), root: at(4, 4), prev: at(5, 4) });
  const branch = analyzeBranch(b, at(4, 4), at(4, 3), enabledCfg());
  assert.equal(branch.reconnectable, false);
  assert.equal(branch.anchored, false);
  assert.equal(branch.building, null);
  assert.equal(branchWorthClearing(branch, enabledCfg()), false);

  const decision = run(b, store, enabledCfg());
  assert.ok(decision);
  assert.equal(decision.branch, 'blitz-march');
  // The whole wave commits into the live direction; no repeated half pushes.
  assert.equal(decision.action.mode, 2);
  assert.deepEqual([decision.action.dx, decision.action.dy], [3, 4]);
  assert.equal(store.blitz.root, at(3, 4));
  apply(b, decision.action);
  assert.equal(b.army[at(4, 4)], 1, 'a full push leaves the single junction guard');
  assert.ok(b.army[at(3, 4)] > 390, 'the live direction got the whole wave');
  assert.equal(store.blitz.splits, 0);
  assert.equal(store.blitz.detach, null);
});

test('a branch with an external exit but no reconnection is still dead', () => {
  // The branch has a second doorway, but it only leads to neutral ground: the
  // enemy's remaining force cannot come back in without passing the junction.
  const dead = forkBoard({ wave: 400, branch: 'plain', branchArmy: 5, branchExit: 'void' });
  const deadBranch = analyzeBranch(dead, at(4, 4), at(4, 3), enabledCfg());
  assert.equal(deadBranch.reconnectable, false);
  assert.ok(deadBranch.reach > 0);
  const deadStore = memory(dead, { phase: 'push', crown: at(1, 4), root: at(4, 4), prev: at(5, 4) });
  const deadDecision = run(dead, deadStore, enabledCfg());
  assert.ok(deadDecision);
  assert.equal(deadDecision.action.mode, 2);

  // An enemy stack behind that doorway is still dead on its own: without a
  // path of enemy-held cells back to an anchor it cannot move at all.
  const trapped = forkBoard({ wave: 400, branch: 'plain', branchArmy: 5, branchExit: 'force' });
  assert.equal(analyzeBranch(trapped, at(4, 4), at(4, 3), enabledCfg()).reconnectable, false);

  // A doorway whose far side really is anchored (an enemy city there) is live.
  const live = forkBoard({ wave: 400, branch: 'city', branchCityArmy: 5, branchExit: 'void' });
  assert.equal(analyzeBranch(live, at(4, 4), at(4, 3), enabledCfg()).reconnectable, true);
});

test('a live branch keeps the junction guard (mode-1 half pushes)', () => {
  const b = forkBoard({ wave: 480, branch: 'city', branchCityArmy: 20, turn: 70 });
  const store = memory(b, {
    phase: 'push',
    crown: at(1, 4),
    root: at(4, 4),
    prev: at(5, 4),
    lastSplitTurn: 70,
  });
  const wave = b.army[at(4, 4)];
  const cfg = enabledCfg();
  let halves = 0;
  for (let step = 0; step < cfg.maxHalf; step += 1) {
    const decision = run(b, store, cfg);
    assert.ok(decision, `expected a main-route action on step ${step}`);
    assert.notEqual(decision.action.mode, 0, 'the smart split is never a junction transit');
    if (store.blitz.root !== at(4, 4)) break;
    assert.equal(decision.branch, 'blitz-march');
    assert.equal(decision.action.mode, 1);
    assert.equal(decision.action.half, true);
    assert.ok(b.army[at(4, 4)] >= 22 + 4, 'the guard still covers the simulated threat plus margin');
    halves += 1;
    apply(b, decision.action);
  }
  assert.ok(halves >= 3 && halves <= cfg.maxHalf, `ladder length ${halves} outside [3, ${cfg.maxHalf}]`);
  assert.notEqual(store.blitz.root, at(4, 4), 'the column leaves the junction once the ladder ends');
  assert.ok(b.army[at(4, 4)] >= wave / 16, `guard ${b.army[at(4, 4)]} < 1/16 of ${wave}`);
  assert.ok(b.army[at(3, 4)] > wave * 0.35, 'the forward cell holds the majority of the wave');
  assert.equal(store.blitz.splits, 0, 'a live plain branch is guarded, not cleared');
});

test('a live branch that holds a building is cleared by a bounded split', () => {
  const b = forkBoard({ wave: 400, branch: 'city', branchCityArmy: 20, branchArmy: 5 });
  const store = memory(b, { phase: 'push', crown: at(1, 4), root: at(4, 4), prev: at(5, 4) });
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
  const store = memory(b, { phase: 'push', crown: at(1, 4), root: at(4, 4), prev: at(5, 4) });
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

// A corridor: enemy crown at 0, our cells 1..length, our crown at length+1.
// Options place stacks on the row so a rally can be asked to choose between a
// forward and a deep stack.
function corridorBoard(options = {}) {
  const length = options.length ?? 9;
  const n = length + 2;
  const grid = Array(n * M).fill(MOUNTAIN);
  const army = Array(n * M).fill(0);
  const isolated = Array(n * M).fill(0);
  const fog = Array(n * M).fill(0);
  const put = (x, code, count) => {
    grid[at(x, 4)] = code;
    army[at(x, 4)] = count;
  };
  put(0, 102, options.crownArmy ?? 10);
  for (let x = 1; x <= length; x += 1) put(x, 1, 1);
  for (const [x, count] of Object.entries(options.stacks ?? {})) put(Number(x), 1, count);
  put(length + 1, 101, options.homeArmy ?? 1);
  return makeBoard(
    {
      n,
      m: M,
      grid,
      army,
      isolated,
      fog,
      turn: 70,
      leaderboard: [
        { id: 1, team: 1 },
        { id: 2, team: 2 },
      ],
    },
    1,
  );
}

// A crown one cell away from our root, so the exchange is decided on this tick.
// The optional side branch is either dead (its stacks are cut off) or live (an
// enemy stack can still reach it through a second doorway).
function crownBoard(options = {}) {
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
  enemy(0, 4, 'crown', options.crownArmy ?? 14);
  own(1, 4, 'plain', options.wave ?? 200);
  own(2, 4, 'plain', 1);
  own(3, 4, 'crown', options.homeArmy ?? 100);
  // A second enemy crown keeps the capture from being a decap, so the tail the
  // full push leaves behind is really at risk.
  enemy(6, 0, 'crown', 1);
  enemy(1, 3, 'plain', 5);
  enemy(1, 2, 'plain', 5);
  if (options.side === 'live') {
    // An enemy city inside the side branch: anchored, so the branch is live.
    enemy(1, 2, 'city', options.sideArmy ?? 5);
  }
  return makeBoard(
    {
      n: N,
      m: M,
      grid,
      army,
      isolated,
      fog,
      turn: options.turn ?? 80,
      leaderboard: [
        { id: 1, team: 1 },
        { id: 2, team: 2 },
      ],
    },
    1,
  );
}

test('a capture away from a junction is a full push', () => {
  // v4 defaulted every capture to the half push, so a 306 wave paid a half
  // push on plain road and left a guard behind for nothing (t143/t144.5 of the
  // 4bQF replay).  Away from a live junction the wave commits fully.
  const b = crownBoard({ crownArmy: 14, wave: 200 });
  const store = memory(b, { phase: 'push', crown: at(0, 4), root: at(1, 4), prev: at(2, 4) });
  const decision = run(b, store, enabledCfg());
  assert.ok(decision);
  assert.equal(decision.branch, 'blitz-break');
  assert.equal(decision.action.mode, 2, 'a capture away from a threatened fork pushes fully');
  apply(b, decision.action);
  assert.equal(b.owner(at(0, 4)), 1, 'the crown is ours');
  assert.equal(b.army[at(1, 4)], 1, 'the source keeps only the engine minimum');
  assert.ok(b.army[at(0, 4)] > 180, 'the whole wave went through');
});

test('the half push is offered only at a threatened junction', () => {
  // The transit mode is binary: a junction ladder halves, everything else is a
  // full push.  Mode 0 (the smart split) is never offered.
  assert.deepEqual(pushModes(false), [2], 'no fork: full push only');
  assert.deepEqual(pushModes(true), [1], 'a junction ladder halves');
  assert.ok(!pushModes(true).includes(0) && !pushModes(false).includes(0));
  // A corridor cell with two exits is not a junction, so even an adjacent
  // enemy crown is taken with a full push.
  const flat = corridorBoard({ length: 9, crownArmy: 14, homeArmy: 10, stacks: { 1: 200 } });
  assert.equal(isJunction(flat, at(1, 4)), false);
  const flatStore = memory(flat, { phase: 'push', crown: at(0, 4), root: at(1, 4), prev: at(2, 4) });
  const flatDecision = run(flat, flatStore, enabledCfg());
  assert.equal(flatDecision.branch, 'blitz-break');
  assert.equal(flatDecision.action.mode, 2, 'no junction: full push, never a half');
  // The neutral side corridor of the fork board gives the junction three exits.
  const fork = neutralForkBoard();
  assert.equal(isJunction(fork, at(4, 4)), true);
  // ...but a 5-army city four cells away is not a real branch threat, so the
  // wave still commits fully instead of paying a guard.
  const forkStore = memory(fork, { phase: 'push', crown: at(1, 4), root: at(4, 4), prev: at(5, 4) });
  const forkDecision = run(fork, forkStore, enabledCfg());
  assert.equal(forkDecision.action.mode, 2);
});

test('a full push is allowed for an adjacent crown when half cannot kill it', () => {
  const b = crownBoard({ crownArmy: 300, wave: 400 });
  const store = memory(b, { phase: 'push', crown: at(0, 4), root: at(1, 4), prev: at(2, 4) });
  assert.equal(analyzeBranch(b, at(1, 4), at(1, 3), enabledCfg()).reconnectable, false);
  const decision = run(b, store, enabledCfg());
  assert.ok(decision);
  assert.equal(decision.action.mode, 2, 'half is insufficient, so the one-cell exchange is taken');
  apply(b, decision.action);
  assert.equal(b.owner(at(0, 4)), 1);
});

test('the same crown is not full-pushed when the branch is live', () => {
  const b = crownBoard({ crownArmy: 300, wave: 400, side: 'live' });
  const store = memory(b, { phase: 'push', crown: at(0, 4), root: at(1, 4), prev: at(2, 4) });
  assert.equal(analyzeBranch(b, at(1, 4), at(1, 3), enabledCfg()).reconnectable, true);
  const decision = run(b, store, enabledCfg());
  const toCrown = decision?.action && b.idx(decision.action.dx, decision.action.dy) === at(0, 4);
  if (toCrown) assert.notEqual(decision.action.mode, 2, 'a live branch keeps the junction guard');
  assert.equal(b.owner(at(0, 4)), 2);
});

test('forward gathering never walks a forward stack back toward the rally', () => {
  // The forward 150 sits at x=5; the 400 home crown is the rear mass.  The old
  // code re-seated the rally on the largest rear stack and the front walked
  // back down the corridor.
  const b = corridorBoard({ length: 9, crownArmy: 10, homeArmy: 400, stacks: { 5: 150, 9: 40 } });
  const crown = at(0, 4);
  const store = memory(b, { phase: 'muster', crown, root: -1 });
  const decision = run(b, store, enabledCfg());
  assert.ok(decision);
  assert.equal(store.blitz.root, at(5, 4), 'the forward 150 is the rally, not the rear 400');
  const f = BLITZ_HELPERS.field(b, [crown]);
  assert.ok(
    f.distance[b.idx(decision.action.dx, decision.action.dy)] <=
      f.distance[b.idx(decision.action.x, decision.action.y)],
    'no backward step',
  );
  // Run a few ticks: the corridor is only ever walked forward.
  for (let tick = 0; tick < 4; tick += 1) {
    const next = run(b, store, enabledCfg());
    if (!next || next.action?.kind !== 'attack') break;
    const from = b.idx(next.action.x, next.action.y);
    const to = b.idx(next.action.dx, next.action.dy);
    assert.ok(f.distance[to] <= f.distance[from], `backward gather ${from} -> ${to}`);
    apply(b, next.action);
  }
});

test('the crown stack joins the wave with no defensive reserve', () => {
  // The blitz is an all-in trade: a crown garrison contributes everything
  // except the single soldier the engine needs to keep the source legal.
  const b = corridorBoard({ length: 9, crownArmy: 10, homeArmy: 400, stacks: { 5: 150 } });
  const crown = at(0, 4);
  const store = memory(b, { phase: 'muster', crown, root: at(5, 4) });
  const decision = run(b, store, enabledCfg());
  assert.ok(decision);
  assert.equal(decision.branch, 'blitz-muster');
  // The crown stack is a gather source, not a reserved garrison.
  assert.equal(decision.action.x, 10);
  assert.deepEqual([decision.action.dx, decision.action.dy], [9, 4]);
  apply(b, decision.action);
  assert.equal(b.army[at(10, 4)], 1, 'the crown keeps only the engine minimum');
  assert.equal(b.army[at(9, 4)], 400 + 1 - 1, 'the whole crown stack went forward');
});

/**
 * A corridor with a fat chain right next to the rally and a fat crown far
 * behind it.  The chain always scores higher (short route, fat pile), which is
 * exactly why the v4 gather never spent the crown garrison.
 */
function crownBehindChain() {
  const b = corridorBoard({ length: 9, crownArmy: 10, homeArmy: 300, stacks: { 2: 40, 3: 40, 4: 40 } });
  b.army[at(1, 4)] = 30; // the rally already holds a wave
  return b;
}

test('the crown joins the gather even when a fat chain sits next to the rally', () => {
  const b = crownBehindChain();
  const crown = at(0, 4);
  const store = memory(b, { phase: 'muster', crown, root: at(1, 4) });
  const decision = run(b, store, enabledCfg());
  assert.ok(decision);
  assert.equal(decision.branch, 'blitz-muster');
  assert.equal(decision.action.x, 10, 'the crown is the source, not the chain');
  assert.equal(decision.action.mode, 2, 'the crown is spent fully');
  apply(b, decision.action);
  assert.equal(b.army[at(10, 4)], 1, 'the crown keeps only the engine minimum');
  assert.equal(b.army[at(9, 4)], 300, 'the whole crown garrison moved into the column');
});

test('a stack with a cheap forward kill is not recalled into the gather', () => {
  // A 60 stack that can still take a neighbouring 5-garrison city stays put;
  // the gather uses the rear 40 instead of pulling the spearhead back.
  const b = corridorBoard({ length: 9, crownArmy: 10, homeArmy: 1, stacks: { 3: 60, 6: 40 } });
  b.grid[at(3, 3)] = 52; // enemy city, one cheap score below the 60
  b.army[at(3, 3)] = 5;
  const crown = at(0, 4);
  const cf = BLITZ_HELPERS.field(b, [crown]);
  assert.equal(cheapForwardTarget(b, at(3, 4), cf), true);
  assert.equal(cheapForwardTarget(b, at(6, 4), cf), false);
  const store = {
    ...memory(b),
    blitz: { ...initialState(), phase: 'muster', crown, root: at(1, 4) },
  };
  const decision = blitzGather(
    b,
    store,
    cells(b).own,
    store.blitz,
    crown,
    400,
    enabledCfg(),
    BLITZ_HELPERS,
    'blitz-muster',
  );
  assert.ok(decision);
  assert.equal(decision.action.x, 6, 'the rear stack delivers, the spearhead stays');
  // With no other source the spearhead is still used, so the gather never dies.
  b.army[at(6, 4)] = 1;
  const fallback = blitzGather(
    b,
    store,
    cells(b).own,
    store.blitz,
    crown,
    400,
    enabledCfg(),
    BLITZ_HELPERS,
    'blitz-muster',
  );
  assert.ok(fallback);
  assert.equal(fallback.action.x, 3, 'a held stack is recalled when nothing else can deliver');
});

// A cut mid-gather with the mass behind it: the rally must follow the wave.
function cutWaveBoard() {
  const n = 11;
  const grid = Array(n * M).fill(MOUNTAIN);
  const army = Array(n * M).fill(0);
  const isolated = Array(n * M).fill(0);
  const fog = Array(n * M).fill(0);
  const put = (x, code, count, dead = 0) => {
    grid[at(x, 4)] = code;
    army[at(x, 4)] = count;
    isolated[at(x, 4)] = dead;
  };
  put(0, 102, 10);
  put(1, 1, 1);
  put(2, 1, 1);
  put(3, 1, 1);
  put(4, 1, 269); // the gathered wave, still connected
  put(5, 2, 4000); // the cutter: it cannot be repaired this tick
  for (let x = 6; x <= 8; x += 1) put(x, 1, 1, 1);
  put(7, 1, 24, 1); // the cut head
  put(10, 101, 300);
  return makeBoard(
    {
      n,
      m: M,
      grid,
      army,
      isolated,
      fog,
      turn: 90,
      leaderboard: [
        { id: 1, team: 1 },
        { id: 2, team: 2 },
      ],
    },
    1,
  );
}

test('a cut mid-gather keeps the 269 stack and the objective', () => {
  const b = cutWaveBoard();
  const crown = at(0, 4);
  const store = memory(b, { phase: 'muster', crown, root: at(7, 4) });
  const decision = run(b, store, enabledCfg());
  assert.ok(decision);
  assert.equal(store.blitz.crown, crown, 'the objective is not re-picked');
  assert.equal(store.blitz.root, at(4, 4), 'the rally follows the 269 stack, not a token lane');
  assert.notEqual(store.blitz.root, at(10, 4), 'the rear crown is never promoted');
  assert.notEqual(decision.branch, 'blitz-expand');
  if (decision.action?.kind === 'attack') {
    const f = BLITZ_HELPERS.field(b, [crown]);
    const from = b.idx(decision.action.x, decision.action.y);
    const to = b.idx(decision.action.dx, decision.action.dy);
    assert.ok(f.distance[to] <= f.distance[from], `backward regroup ${from} -> ${to}`);
  }
  assert.equal(store.blitz.abandons, 1, 'the cut is counted, not hidden');
});

test('the burst ends and gathering starts on the very next tick', () => {
  // The decision state carries the tick that just finished, so a state turn of
  // BURST_END_TURN is already the first post-burst tick (t25.5 in the replay).
  const b = corridorBoard({ length: 9, crownArmy: 10, homeArmy: 400, stacks: { 5: 60 } });
  b.turn = BURST_END_TURN - 1;
  const store = memory(b);
  // Blanket mode: the gate decision is covered by its own tests, and an
  // unchanged board would correctly read as a quiet (non-swarm) opponent.
  const cfg = enabledCfg({ gate: false });
  assert.equal(store.blitz.phase, 'expand');
  assert.equal(run(b, store, cfg), null, 'the pre-burst tick still belongs to the planner');
  b.turn = BURST_END_TURN;
  const first = run(b, store, cfg);
  assert.ok(first, 'a decision is emitted on the tick after the burst');
  assert.equal(store.blitz.phase, 'muster');
  assert.equal(first.branch, 'blitz-muster', 'the tick after the burst already gathers');
  assert.notEqual(first.branch, 'blitz-expand');
  assert.equal(first.action.kind, 'attack');
  // And it keeps gathering every tick instead of falling back to painting.
  for (let tick = 0; tick < 4; tick += 1) {
    const next = run(b, store, cfg);
    assert.ok(next);
    assert.equal(store.blitz.phase, 'muster');
    assert.notEqual(next.branch, 'blitz-expand', 'no lingering expansion after the burst');
    assert.equal(next.action.kind, 'attack');
    apply(b, next.action);
  }
});

test('a wave exactly at the floor launches, with no extra gate', () => {
  const floor = waveFloor(7 * 11, enabledCfg());
  const b = corridorBoard({ length: 9, crownArmy: 10, homeArmy: 1, stacks: { 5: floor } });
  const store = memory(b, { phase: 'muster', crown: at(0, 4), root: at(5, 4) });
  const decision = run(b, store, enabledCfg());
  assert.ok(decision);
  assert.equal(store.blitz.phase, 'push');
  assert.equal(store.blitz.launches, 1);
  assert.match(decision.branch, /^blitz-(march|break|fork)$/);
});

// A corridor cut in the middle: our front half is isolated by an enemy stack,
// exactly the shape that made the rally jump to the rear pack.
function cutBoard() {
  const n = 11;
  const grid = Array(n * M).fill(MOUNTAIN);
  const army = Array(n * M).fill(0);
  const isolated = Array(n * M).fill(0);
  const fog = Array(n * M).fill(0);
  const put = (x, code, count, dead = 0) => {
    grid[at(x, 4)] = code;
    army[at(x, 4)] = count;
    isolated[at(x, 4)] = dead;
  };
  put(0, 102, 10);
  for (let x = 1; x <= 4; x += 1) put(x, 1, 1);
  put(5, 2, 30); // the cutter
  for (let x = 6; x <= 9; x += 1) put(x, 1, 1, 1); // trapped front (isolated)
  put(6, 1, 220, 1); // the wave that got cut
  put(10, 101, 300); // home crown: the rear mass
  return makeBoard(
    {
      n,
      m: M,
      grid,
      army,
      isolated,
      fog,
      turn: 90,
      leaderboard: [
        { id: 1, team: 1 },
        { id: 2, team: 2 },
      ],
    },
    1,
  );
}

test('a cut frontier never re-seats the rally on the rear mass', () => {
  const b = cutBoard();
  const crown = at(0, 4);
  const store = memory(b, { phase: 'muster', crown, root: at(6, 4) });
  const decision = run(b, store, enabledCfg());
  assert.ok(decision);
  // The rally moves to the forward edge of the still connected part, not home.
  assert.notEqual(store.blitz.root, at(10, 4), 'the home crown must not become the rally');
  assert.equal(store.blitz.root, at(2, 4));
  if (decision.action?.kind === 'attack') {
    const f = BLITZ_HELPERS.field(b, [crown]);
    const from = b.idx(decision.action.x, decision.action.y);
    const to = b.idx(decision.action.dx, decision.action.dy);
    assert.ok(f.distance[to] <= f.distance[from], 'no backward step after the cut');
  }

  // In the push phase the cut is repaired or held: the objective and the root
  // stay, and nothing is pulled back.
  const pushStore = memory(b, { phase: 'push', crown, root: at(6, 4), prev: at(7, 4) });
  const pushDecision = run(b, pushStore, enabledCfg());
  assert.ok(pushDecision);
  assert.equal(pushStore.blitz.root, at(6, 4), 'the cut root is kept while repairing');
  assert.notEqual(pushStore.blitz.root, at(10, 4));
  assert.match(pushDecision.branch, /^blitz-(hold|rescue)$/);
});

test('the forward rally stages near the front and never sends rear stacks backwards', () => {
  const b = corridorBoard({ stacks: { 2: 21, 8: 253 } });
  const store = memory(b, { phase: 'muster', crown: at(0, 4), root: -1 });
  const decision = run(b, store, enabledCfg());
  assert.ok(decision);
  // The staging cell is the forward 21 stack, not the deep 253 stack.
  assert.equal(store.blitz.root, at(2, 4));
  assert.equal(launchCell(b, cells(b).own, at(0, 4), BLITZ_HELPERS), at(2, 4));
  // The deep stack walks toward the crown instead of pulling the front back.
  expectForward(b, decision.action, at(0, 4));
  assert.equal(decision.action.x, 8);
  apply(b, decision.action);
  // The rally does not re-walk the corridor: the root stays where it was.
  const next = run(b, store, enabledCfg());
  assert.ok(next);
  assert.equal(store.blitz.root, at(2, 4));
  if (next.action?.kind === 'attack') expectForward(b, next.action, at(0, 4));
});

test('a 759-unit wave launches even when the route estimate is far higher', () => {
  const b = corridorBoard({ length: 20, crownArmy: 1500, homeArmy: 100, stacks: { 20: 759 } });
  const cfg = enabledCfg();
  const store = memory(b, { phase: 'muster', crown: at(0, 4), root: at(20, 4) });
  const route = BLITZ_HELPERS.route(BLITZ_HELPERS.field(b, [at(0, 4)]), at(20, 4));
  assert.ok(routeNeed(b, route, at(0, 4), BLITZ_HELPERS, cfg).need > 759);
  const decision = run(b, store, cfg);
  assert.ok(decision);
  assert.equal(store.blitz.phase, 'push');
  assert.equal(store.blitz.launches, 1);
  assert.equal(decision.branch, 'blitz-march');
  assert.notEqual(decision.action.mode, 0, 'the launch never uses the smart split');
});

test('an exposed home crown is answered by defence before the launch', () => {
  const b = forkBoard({ wave: 759 });
  // An adjacent enemy stack that can take the home crown in one full push.
  b.grid[at(6, 3)] = 2;
  b.army[at(6, 3)] = 200;
  assert.equal(homeCrownExposed(b, { home: at(6, 4) }), true);
  const store = memory(b, { phase: 'muster', crown: at(1, 4), root: at(4, 4) });
  const decision = run(b, store, enabledCfg());
  assert.ok(decision);
  assert.equal(store.blitz.phase, 'muster');
  assert.equal(store.blitz.launches, 0);
});

// A fork whose side corridor is neutral ground that eventually reaches enemy
// territory.  There is no enemy stack on the junction itself, so the branch
// has nothing to cut the tail with: it is not a live threat.
function neutralForkBoard() {
  const grid = Array(N * M).fill(MOUNTAIN);
  const army = Array(N * M).fill(0);
  const isolated = Array(N * M).fill(0);
  const fog = Array(N * M).fill(0);
  const own = (x, y, kind, count) => {
    grid[at(x, y)] = kind === 'crown' ? 101 : 1;
    army[at(x, y)] = count;
  };
  const enemy = (x, y, kind, count) => {
    grid[at(x, y)] = kind === 'crown' ? 102 : kind === 'city' ? 52 : 2;
    army[at(x, y)] = count;
  };
  own(6, 4, 'crown', 20);
  own(5, 4, 'plain', 1);
  own(4, 4, 'plain', 400);
  own(3, 4, 'plain', 1);
  own(2, 4, 'plain', 1);
  enemy(1, 4, 'crown', 10);
  // Neutral corridor out of the junction: nothing there can cut the wave.
  // The enemy city is three cells in, out of next-two-tick reach.
  grid[at(4, 3)] = 1;
  grid[at(4, 2)] = 1;
  grid[at(4, 1)] = 1;
  enemy(3, 1, 'city', 5);
  return makeBoard(
    {
      n: N,
      m: M,
      grid,
      army,
      isolated,
      fog,
      turn: 80,
      leaderboard: [
        { id: 1, team: 1 },
        { id: 2, team: 2 },
      ],
    },
    1,
  );
}

test('a neutral side corridor is not a live branch and earns no guard', () => {
  const b = neutralForkBoard();
  const branch = analyzeBranch(b, at(4, 4), at(4, 3), enabledCfg());
  // The enemy could in principle reconnect through neutral ground...
  assert.equal(branch.reconnectable, true);
  // ...but no enemy stack sits on the junction, so nothing can cut the tail.
  assert.equal(branch.adjacent, 0);
  assert.equal(branch.live, false);
  assert.equal(branchWorthClearing(branch, enabledCfg()), false);

  const store = memory(b, { phase: 'push', crown: at(1, 4), root: at(4, 4), prev: at(5, 4) });
  const decision = run(b, store, enabledCfg());
  assert.ok(decision);
  assert.equal(decision.branch, 'blitz-march');
  assert.equal(decision.action.mode, 2, 'the wave commits fully instead of halving at a neutral fork');
  assert.deepEqual([decision.action.dx, decision.action.dy], [3, 4]);
  assert.equal(store.blitz.splits, 0);
  assert.equal(store.blitz.detach, null);
});

// The cut board with a second forward stack that is still connected: the cut
// costs at most one tick, then the wave moves on.
function cutWithReserve() {
  const b = cutBoard();
  b.army[at(3, 4)] = 200;
  // A garrison the reseated wave cannot take, so the fallback keeps moving.
  b.army[at(0, 4)] = 4000;
  return b;
}

test('a cut holds at most one tick and then moves the body forward', () => {
  const b = cutWithReserve();
  const crown = at(0, 4);
  const store = memory(b, { phase: 'push', crown, root: at(6, 4), prev: at(7, 4) });
  const first = run(b, store, enabledCfg());
  assert.ok(first);
  assert.match(first.branch, /^blitz-(hold|rescue|advance|reseat)$/);
  if (first.action) {
    assert.equal(first.action.kind, 'attack');
  }
  // The next tick must move: the alternate forward stack takes the wave over.
  b.turn += 1;
  const second = run(b, store, enabledCfg());
  assert.ok(second, 'the plan must emit a decision after one quiet tick');
  assert.equal(second.action.kind, 'attack', 'a second frozen tick is never acceptable');
  const f = BLITZ_HELPERS.field(b, [crown]);
  assert.ok(f.distance[store.blitz.root] < f.distance[at(6, 4)], 'the wave moved off the cut root');
  assert.ok(f.distance[store.blitz.root] <= f.distance[at(3, 4)], 'the alternate forward stack leads');
  const to = b.idx(second.action.dx, second.action.dy);
  assert.ok(f.distance[to] < f.distance[at(3, 4)], 'the fallback move goes toward the objective');
  // No frozen stretch either: a quiet tick may happen once, never twice in a
  // row, and the plan hands back instead of freezing forever.
  apply(b, second.action);
  let streak = 0;
  for (let tick = 0; tick < 6; tick += 1) {
    const next = run(b, store, enabledCfg());
    if (!next) break;
    if (!next.action) {
      streak += 1;
      assert.ok(streak <= 1, `frozen for ${streak} consecutive ticks at ${b.turn}`);
      b.turn += 1;
      continue;
    }
    streak = 0;
    apply(b, next.action);
  }
});

test('the crown stack is used even when the rally already holds a wave', () => {
  // The old gather returned early once `army[root] >= need`, so a crown stack
  // sitting behind the rally was never sent.  A stalled push must still pull it.
  const n = 11;
  const grid = Array(n * M).fill(MOUNTAIN);
  const army = Array(n * M).fill(0);
  const isolated = Array(n * M).fill(0);
  const fog = Array(n * M).fill(0);
  const put = (x, code, count) => {
    grid[at(x, 4)] = code;
    army[at(x, 4)] = count;
  };
  put(0, 102, 10); // enemy crown
  put(1, 2, 3000); // enemy wall: the wave cannot push through it
  put(2, 1, 400); // the wave sits right on the enemy wall
  put(3, 1, 1);
  put(4, 1, 1);
  put(5, 1, 1);
  put(6, 1, 1);
  for (let x = 7; x <= 9; x += 1) put(x, 1, 1);
  put(10, 101, 400); // home crown: the mass the old short-circuit omitted
  const b = makeBoard(
    {
      n,
      m: M,
      grid,
      army,
      isolated,
      fog,
      turn: 90,
      leaderboard: [
        { id: 1, team: 1 },
        { id: 2, team: 2 },
      ],
    },
    1,
  );
  const store = memory(b, { phase: 'push', crown: at(0, 4), root: at(2, 4), prev: at(3, 4) });
  const decision = run(b, store, enabledCfg());
  assert.ok(decision);
  assert.equal(decision.branch, 'blitz-rejoin');
  assert.equal(decision.action.x, 10, 'the crown stack is the gather source');
  assert.equal(decision.action.mode, 2);
  apply(b, decision.action);
  assert.equal(b.army[at(10, 4)], 1, 'no defensive reserve is kept');
  assert.equal(b.army[at(9, 4)], 400, 'the whole crown stack joined the column');
});

/**
 * Opponent-style gate boards.  A compact maze room with an own crown plus a
 * short corridor on row 6 and a growing enemy zone in columns 0-1.  Enemy land
 * is the number of cells the gate counts (crown/city included); `buildings` is
 * how many of those are anchors, which is the crown-race signature.
 */
function gateBoard({ turn = 40, enemyLand = 2, buildings = 1 } = {}) {
  const grid = Array(N * M).fill(MOUNTAIN);
  const army = Array(N * M).fill(0);
  const isolated = Array(N * M).fill(0);
  const fog = Array(N * M).fill(0);
  for (let x = 3; x <= 6; x += 1) {
    grid[at(x, 6)] = x === 6 ? 101 : 1;
    army[at(x, 6)] = x === 6 ? 400 : 1;
  }
  const board = makeBoard(
    { n: N, m: M, grid, army, isolated, fog, turn, leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }] },
    1,
  );
  if (enemyLand) paintEnemy(board, enemyLand, buildings);
  return board;
}

// Enemy zone cells in paint order: columns 0-5 above the own corridor row, so
// the gate can observe up to 36 enemy cells without touching our territory.
const GATE_ZONE = (() => {
  const zone = [];
  for (let x = 0; x <= 5; x += 1) for (let y = 0; y < 6; y += 1) zone.push(at(x, y));
  return zone;
})();

// Paint the first `land` zone cells: the first `buildings` are anchors (crown,
// then a city), the rest are enemy plains.
function paintEnemy(b, land, buildings = 1) {
  for (let index = 0; index < land; index += 1) {
    const cell = GATE_ZONE[index];
    b.grid[cell] = index === 0 ? 102 : index < buildings ? 52 : 2;
    b.army[cell] = 10;
  }
}

// Drive the expand phase over the gate window with a given enemy paint rate.
function gateWindow(board, store, { from = 40, to = 50, start, end, buildings = 1 } = {}) {
  for (let turn = from; turn < to; turn += 1) {
    board.turn = turn;
    const land = start + Math.round(((end - start) * (turn - from)) / (to - from));
    paintEnemy(board, land, buildings);
    const decision = run(board, store, enabledCfg());
    assert.equal(decision, null, `the observation window must not act at tick ${turn}`);
  }
  board.turn = to;
  paintEnemy(board, end, buildings);
  return run(board, store, enabledCfg());
}

test('the opponent gate keeps the blitz against a swarm that keeps painting', () => {
  const b = gateBoard({ turn: 40 });
  const store = memory(b);
  const decision = gateWindow(b, store, { start: 24, end: 34 });
  assert.ok(decision, 'a painting opponent must still launch the blitz');
  // The home crown already holds a wave floor, so the approved blitz may go
  // straight to the push phase on the same tick.
  assert.match(store.blitz.phase, /^(muster|push)$/);
  assert.equal(store.blitz.gate.allow, true);
  assert.equal(store.blitz.gate.reason, 'swarm');
  assert.equal(store.blitz.gate.paint, 10);
  assert.equal(store.blitz.gate.buildings, 1);
});

test('the opponent gate declines the blitz against a quiet crown racer', () => {
  const b = gateBoard({ turn: 40 });
  const store = memory(b);
  const decision = gateWindow(b, store, { start: 26, end: 28 });
  assert.equal(decision, null, 'a quiet opponent must fall back to the planner');
  assert.equal(store.blitz.phase, 'done');
  assert.equal(store.blitz.gate.allow, false);
  assert.equal(store.blitz.gate.reason, 'quiet');
  assert.equal(store.blitz.gate.paint, 2);
  // The gate never re-opens: the blitz stays dead for the rest of the game.
  b.turn = 120;
  assert.equal(run(b, store, enabledCfg()), null);
  assert.equal(store.blitz.phase, 'done');
});

test('a second enemy building already marks a crown race, whatever it paints', () => {
  const b = gateBoard({ turn: 40 });
  const store = memory(b);
  const decision = gateWindow(b, store, { start: 24, end: 34, buildings: 2 });
  assert.equal(decision, null);
  assert.equal(store.blitz.gate.reason, 'crown-race');
  assert.equal(store.blitz.gate.buildings, 2);
});

test('the gate can be forced on, disabled, or left without evidence', () => {
  const forced = gateBoard({ turn: 40 });
  const forcedStore = memory(forced);
  const forcedDecision = gateWindow(forced, forcedStore, { start: 26, end: 28 });
  assert.equal(forcedStore.blitz.gate.reason, 'quiet');
  const forcedCfg = enabledCfg({ gateForce: true });
  forced.turn = 50;
  const reopened = run(forced, memory(forced, { phase: 'expand', gate: null }), forcedCfg);
  assert.ok(reopened, 'APEX_MAZE_BLITZ_GATE_FORCE=1 must ignore the gate');
  assert.ok(forcedDecision === null);

  // APEX_MAZE_BLITZ_GATE=0 restores the blanket v6 blitz.
  const blanket = gateBoard({ turn: 40 });
  const blanketStore = memory(blanket);
  for (let turn = 40; turn < 50; turn += 1) {
    blanket.turn = turn;
    paintEnemy(blanket, 26, 1);
    run(blanket, blanketStore, enabledCfg({ gate: false }));
  }
  blanket.turn = 50;
  const blanketDecision = run(blanket, blanketStore, enabledCfg({ gate: false }));
  assert.ok(blanketDecision);
  assert.match(blanketStore.blitz.phase, /^(muster|push)$/);
  assert.equal(blanketStore.blitz.gate.reason, 'gate-off');

  // No observation at all (a first decision after the burst) keeps the flag
  // semantics instead of silently disabling the experiment.
  const late = gateBoard({ turn: 60, enemyLand: 30 });
  const lateStore = memory(late);
  const lateDecision = run(late, lateStore, enabledCfg());
  assert.ok(lateDecision);
  assert.equal(lateStore.blitz.gate.reason, 'unobserved');
});

test('a declined gate plans every tick exactly as a blitz-free planner', () => {
  const { plan } = require('../bot/planner.cjs');
  // Two identical boards: a crown racer that already stopped painting, so the
  // gate has to decline at the launch tick.  The gated run drives the real
  // planner (the observation window included) and must be indistinguishable
  // from the flag-off run on every tick, not just the fallback tick.
  const gated = gateBoard({ turn: 40, enemyLand: 26 });
  const plainBoard = gateBoard({ turn: 40, enemyLand: 26 });
  const blitzStore = memory(gated);
  const plainStore = memory(plainBoard);
  delete plainStore.blitz;
  const quiet = { start: 26, end: 28 };
  const rows = [];
  for (let turn = 40; turn <= 56; turn += 1) {
    const land = quiet.start + Math.round(((quiet.end - quiet.start) * (turn - 40)) / 10);
    for (const [board, store] of [[gated, blitzStore], [plainBoard, plainStore]]) {
      board.turn = turn;
      paintEnemy(board, Math.min(land, quiet.end), 1);
    }
    const withBlitz = withEnv('APEX_MAZE_BLITZ', '1', () => plan(gated, blitzStore));
    const withoutBlitz = withEnv('APEX_MAZE_BLITZ', undefined, () => plan(plainBoard, plainStore));
    rows.push({ turn, withBlitz, withoutBlitz });
  }
  const declined = rows.find((row) => row.turn === 50);
  assert.equal(blitzStore.blitz.gate.reason, 'quiet');
  assert.equal(blitzStore.blitz.phase, 'done');
  for (const row of rows) {
    assert.deepEqual(
      { action: row.withBlitz.action, branch: row.withBlitz.branch },
      { action: row.withoutBlitz.action, branch: row.withoutBlitz.branch },
      `tick ${row.turn} diverged from the blitz-free planner`,
    );
  }
  assert.ok(declined, 'the launch tick was planned');
  assert.equal(blitzStore.blitz.phase, 'done', 'no half-blitz state survives the fallback');
});
