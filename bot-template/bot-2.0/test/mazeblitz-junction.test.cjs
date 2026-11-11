'use strict';

/**
 * Junction half-push rule (v6): the wave only halves out of a junction while a
 * simulated worst-case enemy arrival still cannot take the guard it leaves
 * behind.  These tests pin the rule's building blocks (classification, arrival
 * timeline, guard growth, k selection) and the decisions they produce.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeBoard } = require('../bot/board.cjs');
const { preview } = require('../bot/rules.cjs');
const { BLITZ_HELPERS } = require('../bot/planner.cjs');
const {
  mazeBlitzConfig,
  mazeBlitzPlan,
  initialState,
  isJunction,
  growthAt,
  guardTimeline,
  selectHalfPushes,
  junctionThreat,
  trackIsolatedBranches,
  pushModes,
} = require('../bot/mazeblitz.cjs');

const N = 8;
const M = 7;
const MOUNTAIN = 201;
const at = (x, y) => x * M + y;

function forkBoard(options = {}) {
  const grid = Array(7 * M).fill(MOUNTAIN);
  const army = Array(7 * M).fill(0);
  const isolated = Array(7 * M).fill(0);
  const fog = Array(7 * M).fill(0);
  const own = (x, y, kind, count) => {
    grid[at(x, y)] = kind === 'crown' ? 101 : kind === 'city' ? 51 : 1;
    army[at(x, y)] = count;
  };
  const enemy = (x, y, kind, count) => {
    grid[at(x, y)] = kind === 'crown' ? 102 : kind === 'city' ? 52 : 2;
    army[at(x, y)] = count;
  };
  own(6, 4, 'crown', options.homeArmy ?? 100);
  own(5, 4, 'plain', 1);
  own(4, 4, 'plain', options.wave ?? 400);
  own(3, 4, 'plain', 1);
  own(2, 4, 'plain', 1);
  enemy(1, 4, 'crown', options.crownArmy ?? 10);
  enemy(4, 3, 'plain', options.branchArmy ?? 5);
  if (options.branch === 'city') enemy(4, 2, 'city', options.branchCityArmy ?? 20);
  else enemy(4, 2, 'plain', options.branchInnerArmy ?? 20);
  return makeBoard(
    {
      n: 7,
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
  const own = [];
  const enemies = [];
  for (let i = 0; i < b.size; i += 1) {
    if (b.own(i) && !b.isolated[i]) own.push(i);
    if (b.enemy(i) && !b.isolated[i]) enemies.push(i);
  }
  return mazeBlitzPlan(b, store, own, enemies, BLITZ_HELPERS, cfg);
}

function apply(b, action) {
  const result = preview(b, action);
  assert.equal(result.ok, true, 'the decision must be a legal action');
  b.grid = result.grid;
  b.army = result.army;
  b.isolated = result.isolated;
  b.turn += 1;
  return result;
}

const enabledCfg = (extra = {}) => mazeBlitzConfig({ enabled: true, ...extra });

const ROLE_CODE = { own: 1, enemy: 2, neutral: 1 };

/**
 * Generic maze board: every listed cell is passable, everything else is a
 * mountain.  Entries are [x, y, role, army, kind, isolated].
 */
function gridBoard(n, cells, options = {}) {
  const grid = Array(n * M).fill(MOUNTAIN);
  const army = Array(n * M).fill(0);
  const isolated = Array(n * M).fill(0);
  const fog = Array(n * M).fill(0);
  for (const [x, y, role, count = 0, kind = 'plain', iso = 0] of cells) {
    const base = role === 'neutral' ? 0 : ROLE_CODE[role];
    grid[at(x, y)] = kind === 'crown' ? base + 100 : kind === 'city' ? base + 50 : base;
    army[at(x, y)] = count;
    isolated[at(x, y)] = iso;
  }
  return makeBoard(
    {
      n,
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

// A junction at (4,4) with a straight road west to an enemy crown at (0,4).
function junctionBoard(extra = [], options = {}) {
  return gridBoard(
    N,
    [
      [0, 4, 'enemy', options.crownArmy ?? 10, 'crown'],
      [1, 4, 'own', 1],
      [2, 4, 'own', 1],
      [3, 4, 'own', 1],
      [4, 4, 'own', options.wave ?? 400, options.junctionKind ?? 'plain'],
      [5, 4, 'own', 1],
      [6, 4, 'own', options.homeArmy ?? 50, 'crown'],
      ...extra,
    ],
    options,
  );
}

const ROAD = [at(4, 4), at(3, 4), at(2, 4), at(1, 4), at(0, 4)];

test('a neutral branch is a delayed path, never an immediate threat', () => {
  // (4,3) and (4,2) are neutral, so the 60-stack three cells away needs three
  // ticks: capture the neutral cell, walk the corridor, then attack.
  const b = junctionBoard([
    [4, 3, 'neutral'],
    [4, 2, 'neutral'],
    [4, 1, 'enemy', 60],
  ]);
  const cfg = enabledCfg();
  assert.equal(isJunction(b, at(4, 4)), true);
  const analysis = junctionThreat(b, at(4, 4), at(3, 4), ROAD, cfg);
  const neutral = analysis.sides.find((side) => side.at === at(4, 3));
  assert.equal(neutral.role, 'neutral');
  assert.equal(neutral.delay, 1, 'neutral ground costs the enemy one capture tick');
  assert.equal(analysis.threat[1], 0, 'nothing can attack from a neutral cell on tick 1');
  assert.equal(analysis.threat[2], 0, 'the neutral capture costs a tick');
  assert.equal(analysis.threat[3], 57, '60 - three pushes of one soldier leaves 57');
  assert.equal(analysis.real, true);
  // 400 halves to 200 / 100 / 50, so the third half would still cover 61 but a
  // fourth would not.
  assert.equal(analysis.halfLimit, 2);

  // A small neutral-branch stack stays below the real-threat floor, so the wave
  // commits fully instead of paying a guard for nothing.
  const small = junctionBoard([
    [4, 3, 'neutral'],
    [4, 2, 'neutral'],
    [4, 1, 'enemy', 10],
  ]);
  const smallAnalysis = junctionThreat(small, at(4, 4), at(3, 4), ROAD, cfg);
  assert.equal(smallAnalysis.threat[3], 7);
  assert.equal(smallAnalysis.real, false);
  const store = memory(small, { phase: 'push', crown: at(0, 4), root: at(4, 4), prev: at(5, 4) });
  const decision = run(small, store, cfg);
  assert.equal(decision.action.mode, 2, 'no real threat: full push');
});

test('the decision ladder stops after exactly k half pushes', () => {
  // The neutral branch needs three ticks to bring 57, so k = 2: 400 halves to
  // 200 (safe) and then 100 (safe), but the next half would leave 50 below the
  // 61 the threat plus margin needs.  The column must leave the junction after
  // the second half, not keep halving to the maxHalf cap of 4.
  const b = junctionBoard([
    [4, 3, 'neutral'],
    [4, 2, 'neutral'],
    [4, 1, 'enemy', 60],
  ]);
  const cfg = enabledCfg();
  const store = memory(b, { phase: 'push', crown: at(0, 4), root: at(4, 4), prev: at(5, 4) });
  assert.equal(junctionThreat(b, at(4, 4), at(3, 4), ROAD, cfg).halfLimit, 2);
  const first = run(b, store, cfg);
  assert.equal(first.action.mode, 1);
  assert.equal(store.blitz.root, at(4, 4), 'the guard stays for the second half');
  apply(b, first.action);
  const second = run(b, store, cfg);
  assert.equal(second.action.mode, 1);
  assert.equal(store.blitz.root, at(3, 4), 'the k-th half hands the column to the forward cell');
  apply(b, second.action);
  const third = run(b, store, cfg);
  assert.equal(third.action.mode, 2, 'past the junction every move is a full push');
  assert.ok(b.army[at(4, 4)] >= 57 + cfg.guardMargin, 'the guard covers the threat plus margin');
});

test('own ground at a junction is only safe when it survives the horizon', () => {
  // (4,3) is ours with 2 and the 100 behind it can take the cell and use it.
  const weak = junctionBoard([
    [4, 3, 'own', 2],
    [4, 2, 'enemy', 100],
  ]);
  const cfg = enabledCfg();
  const analysis = junctionThreat(weak, at(4, 4), at(3, 4), ROAD, cfg);
  const side = analysis.sides.find((cell) => cell.at === at(4, 3));
  assert.equal(side.role, 'own');
  assert.equal(analysis.threat[1], 0, 'the enemy is not adjacent to the junction');
  assert.equal(analysis.threat[2], 96, '100 - 2 defenders - 2 pushes');
  assert.equal(analysis.real, true, 'a weak own cell is a delayed threat, not a safe branch');

  // The same cell with 300 survives the whole horizon: the enemy's first push
  // cannot take it, so the branch is not even traversable.
  const strong = junctionBoard([
    [4, 3, 'own', 300],
    [4, 2, 'enemy', 100],
  ]);
  const strongAnalysis = junctionThreat(strong, at(4, 4), at(3, 4), ROAD, cfg);
  assert.equal(strongAnalysis.maxThreat, 0);
  assert.equal(strongAnalysis.real, false);
  const store = memory(strong, { phase: 'push', crown: at(0, 4), root: at(4, 4), prev: at(5, 4) });
  assert.equal(run(strong, store, cfg).action.mode, 2);
});

test('the planned destination is only impassable when the push really takes it', () => {
  const cfg = enabledCfg();
  // The half push (200) takes the 50 on (3,4), so the destination and the enemy
  // cell beyond it are impassable: the 400 behind them never becomes a threat.
  const captured = junctionBoard([
    [4, 3, 'neutral'],
    [3, 4, 'enemy', 50],
    [2, 4, 'enemy', 400],
    [1, 4, 'enemy', 5],
  ]);
  const open = junctionThreat(captured, at(4, 4), at(3, 4), ROAD, cfg);
  assert.equal(open.captures, true);
  assert.deepEqual([...open.blocked].sort((a, z) => a - z), [at(3, 4), at(2, 4)].sort((a, z) => a - z));
  assert.equal(open.maxThreat, 0);
  assert.equal(open.real, false);
  const store = memory(captured, { phase: 'push', crown: at(0, 4), root: at(4, 4), prev: at(5, 4) });
  const decision = run(captured, store, cfg);
  assert.equal(decision.branch, 'blitz-break');
  assert.equal(decision.action.mode, 2);

  // A destination the half cannot take stays enemy ground, so the 400 behind it
  // is a real threat and the junction cannot be left.
  const held = junctionBoard([
    [4, 3, 'neutral'],
    [3, 4, 'enemy', 500],
    [2, 4, 'enemy', 400],
    [1, 4, 'enemy', 5],
  ]);
  const closed = junctionThreat(held, at(4, 4), at(3, 4), ROAD, cfg);
  assert.equal(closed.captures, false);
  assert.equal(closed.blocked.size, 0);
  // The 500 on the destination is itself adjacent, and the 400 behind it can
  // walk through it: both approaches are live.
  assert.equal(closed.threat[1], 499);
  assert.equal(closed.threat[2], 499);
  assert.equal(closed.halfLimit, -1, 'not even holding the junction is safe');
  const heldStore = memory(held, { phase: 'push', crown: at(0, 4), root: at(4, 4), prev: at(5, 4) });
  const heldDecision = run(held, heldStore, cfg);
  assert.equal(heldDecision.branch, 'blitz-junction-hold');
  assert.notEqual(heldDecision.action?.mode, 1, 'the guard is never halved into a losing cell');
});

test('an isolated enemy stack cannot move and is only watched', () => {
  const b = junctionBoard([
    [4, 3, 'enemy', 50, 'plain', 1],
    [4, 2, 'neutral'],
  ]);
  const cfg = enabledCfg();
  const analysis = junctionThreat(b, at(4, 4), at(3, 4), ROAD, cfg);
  const side = analysis.sides.find((cell) => cell.at === at(4, 3));
  assert.equal(side.role, 'enemy-isolated');
  assert.equal(side.isolated, true);
  assert.equal(analysis.maxThreat, 0, 'an isolated stack cannot push at all');
  assert.equal(analysis.real, false);
  const store = memory(b, { phase: 'push', crown: at(0, 4), root: at(4, 4), prev: at(5, 4) });
  const decision = run(b, store, cfg);
  assert.equal(decision.action.mode, 2, 'the wave walks past an isolated branch');
  assert.equal(store.blitz.iso.watchedTotal, 1, 'the branch is recorded as a reconnection risk');
});

test('the isolated-branch watch records recapture, another path and decay', () => {
  const b = junctionBoard([
    [4, 3, 'enemy', 50, 'plain', 1],
    [3, 4, 'enemy', 20, 'plain', 1],
  ]);
  const store = memory(b, { phase: 'push', crown: at(0, 4), root: at(4, 4), prev: at(5, 4) });
  trackIsolatedBranches(b, store.blitz, at(4, 4));
  assert.equal(store.blitz.iso.watched.length, 2);
  // (4,3) reconnects through another path, (3,3) decays into neutral ground.
  b.isolated[at(4, 3)] = 0;
  b.grid[at(3, 4)] = 1;
  b.army[at(3, 4)] = 0;
  b.turn += 4;
  let iso = trackIsolatedBranches(b, store.blitz, at(4, 4));
  assert.equal(iso.otherPath, 1);
  assert.equal(iso.decayed, 1);
  assert.equal(iso.reconnects, 1);
  assert.equal(iso.reconnectTicks, 4);
  assert.equal(iso.reconnectMass, 50);
  // Recapture: the enemy takes the junction we left and reconnects through it.
  b.grid[at(4, 3)] = 2;
  b.army[at(4, 3)] = 12;
  b.isolated[at(4, 3)] = 1;
  trackIsolatedBranches(b, store.blitz, at(4, 4));
  b.isolated[at(4, 3)] = 0;
  b.grid[at(4, 4)] = 2;
  b.turn += 2;
  iso = trackIsolatedBranches(b, store.blitz, at(4, 4));
  assert.equal(iso.recapture, 1);
});

test('the threat timeline takes one action per tick, not every source at once', () => {
  const cfg = enabledCfg();
  // Two different approaches, both adjacent: only one can attack, so the threat
  // is the maximum (79), never the sum (128).
  const split = junctionBoard([
    [4, 3, 'enemy', 50],
    [4, 5, 'enemy', 80],
  ]);
  const splitAnalysis = junctionThreat(split, at(4, 4), at(3, 4), ROAD, cfg);
  assert.equal(splitAnalysis.threat[1], 79);
  assert.ok(splitAnalysis.threat[1] < 50 - 1 + 80 - 1);

  // The same two stacks on one approach may combine: the pile waits on (4,3)
  // and the second stack pushes into it (a friendly transfer, one extra tick).
  const merged = junctionBoard([
    [4, 3, 'enemy', 50],
    [4, 2, 'enemy', 80],
  ]);
  const mergedAnalysis = junctionThreat(merged, at(4, 4), at(3, 4), ROAD, cfg);
  assert.equal(mergedAnalysis.threat[1], 49);
  assert.equal(mergedAnalysis.threat[3], 49 + 78, 'one approach: the two stacks combine');
  assert.ok(mergedAnalysis.threat[3] > mergedAnalysis.threat[1]);
});

test('the junction guard grows, and the ladder uses the real post-push army', () => {
  assert.equal(growthAt('crown', 7), 1, 'a crown grows every tick');
  assert.equal(growthAt('plain', 30), 1, 'the burst adds a plain tick');
  assert.equal(growthAt('city', 30), 0, 'cities do not get the burst bonus');
  // Tick 50 is both a plain-growth tick and inside the burst window.
  assert.equal(growthAt('plain', 50), 2, 'the 50-tick plain growth plus the burst');
  assert.equal(growthAt('plain', 100), 1, 'the 50-tick plain growth outside the burst');
  assert.equal(growthAt('plain', 51), 0);
  assert.equal(growthAt('city', 100), 1);
  const cfg = enabledCfg();

  // A crown junction grows every tick, so the no-push guard timeline rises.
  const crown = junctionBoard([], { junctionKind: 'crown', turn: 60 });
  assert.deepEqual(guardTimeline(crown, at(4, 4), at(3, 4), 0, cfg).slice(0, 5), [0, 401, 402, 403, 404]);
  // A plain junction grows on the 50-tick boundary only.
  const plain = junctionBoard([], { turn: 99 });
  assert.deepEqual(guardTimeline(plain, at(4, 4), at(3, 4), 0, cfg).slice(0, 4), [0, 401, 401, 401]);
  // Tick 50 also carries the burst growth, so that boundary gives +2.
  const burstBoundary = junctionBoard([], { turn: 49 });
  assert.deepEqual(guardTimeline(burstBoundary, at(4, 4), at(3, 4), 0, cfg).slice(0, 3), [0, 402, 402]);
  // The ladder uses the real post-push army, not a fixed 1/2 + 1/4 + 1/8 rule.
  const ladder = guardTimeline(plain, at(4, 4), at(3, 4), 4, cfg);
  assert.equal(ladder[1], 201, '400 + 1 growth, then the half push');
  assert.ok(ladder[4] < 400 / 8, 'the fourth half leaves less than the naive 1/8 of 400');
});

test('k is the largest ladder the guard can afford, and the wave then advances', () => {
  const b = junctionBoard([], { turn: 62 });
  const cfg = enabledCfg();
  // 400 halves to 200 / 100 / 50 / 25; the threat is 60 and the margin 4, so
  // the third half (50) is already unsafe and k is 2.
  const threat = [0, 60, 60, 60, 60, 60, 60];
  assert.equal(selectHalfPushes(b, at(4, 4), at(3, 4), threat, cfg), 2);
  // A wider margin closes the ladder earlier.
  assert.equal(selectHalfPushes(b, at(4, 4), at(3, 4), threat, enabledCfg({ guardMargin: 100 })), 1);
  // The ladder cap and the horizon both bound k.
  assert.equal(selectHalfPushes(b, at(4, 4), at(3, 4), threat, enabledCfg({ maxHalf: 1 })), 1);
  assert.equal(selectHalfPushes(b, at(4, 4), at(3, 4), threat, enabledCfg({ threatHorizon: 2 })), 2);
  // No affordable k at all.
  assert.equal(selectHalfPushes(b, at(4, 4), at(3, 4), [0, 900, 900, 900, 900, 900, 900], cfg), -1);

  // The live-branch fork board gives k = 4, and the decision ladder runs that
  // many half pushes before the column moves to the forward cell.
  const fork = forkBoard({ wave: 480, branch: 'city', branchCityArmy: 20, turn: 70 });
  const analysis = junctionThreat(fork, at(4, 4), at(3, 4), ROAD, enabledCfg());
  assert.equal(analysis.halfLimit, 4);
  const store = memory(fork, {
    phase: 'push',
    crown: at(1, 4),
    root: at(4, 4),
    prev: at(5, 4),
    lastSplitTurn: 70,
  });
  for (let step = 0; step < 4; step += 1) {
    const decision = run(fork, store, enabledCfg());
    assert.equal(decision.action.mode, 1, `step ${step} is a ladder half push`);
    assert.equal(
      store.blitz.root,
      step < 3 ? at(4, 4) : at(3, 4),
      step < 3 ? 'the guard holds the junction while the ladder halves' : 'the last half hands the column over',
    );
    apply(fork, decision.action);
  }
  const after = run(fork, store, enabledCfg());
  assert.notEqual(store.blitz.root, at(4, 4), 'after the ladder the wave leaves the junction');
  assert.equal(after.action.kind, 'attack');
  assert.ok(fork.army[at(4, 4)] >= 22 + 4, 'the guard left behind still covers the threat plus margin');
});

test('no safe k holds and reinforces, or aborts instead of pushing', () => {
  const cfg = enabledCfg();
  // 60 on the junction against an adjacent 200: k = -1, the junction cannot be
  // held, and the crown stack behind it is pulled in instead.
  const b = junctionBoard([[4, 3, 'enemy', 200]], { wave: 60, homeArmy: 300 });
  const store = memory(b, { phase: 'push', crown: at(0, 4), root: at(4, 4), prev: at(5, 4) });
  const analysis = junctionThreat(b, at(4, 4), at(3, 4), ROAD, cfg);
  assert.equal(analysis.halfLimit, -1);
  const decision = run(b, store, cfg);
  assert.equal(decision.branch, 'blitz-junction-hold');
  assert.equal(store.blitz.root, at(4, 4), 'the root stays on the junction');
  assert.equal(decision.action.mode, 2);
  assert.deepEqual([decision.action.dx, decision.action.dy], [5, 4], 'the rear stack is pulled in');

  // With nothing left to reinforce with, the blitz hands the board back instead
  // of walking the guard out of the junction.
  const bare = junctionBoard([[4, 3, 'enemy', 200]], { wave: 60, homeArmy: 1, crownArmy: 10 });
  const bareStore = memory(bare, { phase: 'push', crown: at(0, 4), root: at(4, 4), prev: at(5, 4) });
  const bareDecision = run(bare, bareStore, cfg);
  assert.equal(bareDecision.action, null, 'no guard is pushed out of the junction');
  assert.equal(bareStore.blitz.phase, 'done');
});

test('the transit mode is binary: a junction ladder or a full push', () => {
  assert.deepEqual(pushModes(false), [2]);
  assert.deepEqual(pushModes(true), [1]);
});
