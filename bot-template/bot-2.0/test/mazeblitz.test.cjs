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
  anchorReserve,
  launchCell,
  homeCrownExposed,
  routeNeed,
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
    else { grid[at(2, 2)] = 1; army[at(2, 2)] = 0; }
  }
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
  assert.ok(
    f.distance[to] < f.distance[from],
    `expected a move toward the crown, got ${from} -> ${to}`,
  );
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
  const store = memory(b, { phase: 'push', crown: at(1, 4), root: at(4, 4), prev: at(5, 4), lastSplitTurn: 70 });
  const wave = b.army[at(4, 4)];
  for (let step = 0; step < 3; step += 1) {
    const decision = run(b, store, enabledCfg());
    assert.ok(decision, `expected a main-route action on step ${step}`);
    assert.equal(decision.branch, 'blitz-march');
    assert.notEqual(decision.action.mode, 0, 'the smart split is never a junction transit');
    assert.equal(decision.action.mode, 1);
    assert.equal(decision.action.half, true);
    const last = step === 2;
    assert.equal(store.blitz.root, last ? at(3, 4) : at(4, 4),
      'the wave stays on the junction while it halves');
    apply(b, decision.action);
  }
  assert.ok(b.army[at(4, 4)] >= wave / 8, `guard ${b.army[at(4, 4)]} < 1/8 of ${wave}`);
  assert.ok(b.army[at(3, 4)] > wave * 0.7, 'the forward cell holds the majority of the wave');
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
  return makeBoard({
    n,
    m: M,
    grid,
    army,
    isolated,
    fog,
    turn: 70,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
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
  return makeBoard({
    n: N,
    m: M,
    grid,
    army,
    isolated,
    fog,
    turn: options.turn ?? 80,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
}

test('a crown capture defaults to the half push when half already kills', () => {
  const b = crownBoard({ crownArmy: 14, wave: 200 });
  const store = memory(b, { phase: 'push', crown: at(0, 4), root: at(1, 4), prev: at(2, 4) });
  const decision = run(b, store, enabledCfg());
  assert.ok(decision);
  assert.equal(decision.branch, 'blitz-break');
  assert.equal(decision.action.mode, 1, 'the half push kills the 14 crown and keeps a guard');
  const half = Math.floor((200 - 4 - 1) / 2);
  apply(b, decision.action);
  assert.equal(b.owner(at(0, 4)), 1, 'the crown is ours');
  assert.equal(b.army[at(0, 4)], half - 14);
  assert.equal(b.army[at(1, 4)], 200 - half, 'the junction keeps a real guard');
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
  assert.ok(f.distance[b.idx(decision.action.dx, decision.action.dy)] <=
    f.distance[b.idx(decision.action.x, decision.action.y)], 'no backward step');
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

test('a home crown above its reserve joins the gathering', () => {
  const b = corridorBoard({ length: 9, crownArmy: 10, homeArmy: 400, stacks: { 5: 150 } });
  const crown = at(0, 4);
  const store = memory(b, { phase: 'muster', crown, root: at(5, 4) });
  const reserve = anchorReserve(b, BLITZ_HELPERS, at(10, 4), enabledCfg().anchorReserve);
  assert.ok(reserve >= 1 && reserve < 400);
  const decision = run(b, store, enabledCfg());
  assert.ok(decision);
  // The crown stack is the gather source: it sends its surplus forward.
  assert.equal(decision.action.x, 10);
  assert.deepEqual([decision.action.dx, decision.action.dy], [9, 4]);
  apply(b, decision.action);
  assert.ok(b.army[at(10, 4)] >= reserve, 'the crown keeps its defensive reserve');
  assert.ok(b.army[at(9, 4)] > 1, 'the surplus reached the forward cell');
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
  put(5, 2, 30);            // the cutter
  for (let x = 6; x <= 9; x += 1) put(x, 1, 1, 1); // trapped front (isolated)
  put(6, 1, 220, 1);        // the wave that got cut
  put(10, 101, 300);        // home crown: the rear mass
  return makeBoard({
    n,
    m: M,
    grid,
    army,
    isolated,
    fog,
    turn: 90,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
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

test('an exposed home crown vetoes the launch', () => {
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
