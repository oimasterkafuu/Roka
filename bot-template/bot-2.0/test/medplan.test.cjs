'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeBoard } = require('../bot/board.cjs');
const {
  medPlanConfig, economyCoreReach, economyYields, crownRaceHold,
  DEFAULT_CORE_REACH, DEFAULT_MED_REACH,
} = require('../bot/medplan.cjs');
const { plan } = require('../bot/planner.cjs');

const ON = { enabled: true };
const LARGE = 900;

function withEnv(values, body) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// The layer is off by default and must stay a mediterranean large-room layer:
// every other mode/size keeps main's 24-cell core reach and no crown-race hold.
test('APEX_MED_PLAN is off by default and scoped to large mediterranean rooms', () => {
  assert.equal(medPlanConfig({}, {}).enabled, false);
  assert.equal(medPlanConfig({}, { APEX_MED_PLAN: '1' }).enabled, true);
  for (const value of ['0', 'false', 'off']) {
    assert.equal(medPlanConfig({}, { APEX_MED_PLAN: value }).enabled, false);
  }
  const config = medPlanConfig({}, { APEX_MED_PLAN: '1' });
  assert.deepEqual(config.modes, ['mediterranean']);
  assert.equal(config.minBoard, 800);
  assert.equal(config.reach, DEFAULT_MED_REACH);
  assert.equal(config.reach < DEFAULT_CORE_REACH, true);
  // Out-of-range reach is clamped instead of silently disabling the layer.
  assert.equal(medPlanConfig({}, { APEX_MED_PLAN: '1', APEX_MED_PLAN_REACH: '0' }).reach, 2);
  assert.equal(medPlanConfig({}, { APEX_MED_PLAN: '1', APEX_MED_PLAN_REACH: '99' }).reach, DEFAULT_CORE_REACH);
  // Scope can be widened for A/B runs without touching the planner.
  assert.deepEqual(
    medPlanConfig({}, { APEX_MED_PLAN: '1', APEX_MED_PLAN_MODES: 'mediterranean,maze' }).modes,
    ['mediterranean', 'maze'],
  );
});

test('the economy yield boundary only shortens on mediterranean large rooms', () => {
  const off = medPlanConfig({}, {});
  for (const mode of ['random', 'maze', 'archipelago', 'mediterranean']) {
    assert.equal(economyCoreReach({ mode, size: LARGE }, off), DEFAULT_CORE_REACH);
  }
  const on = medPlanConfig({}, { APEX_MED_PLAN: '1' });
  assert.equal(economyCoreReach({ mode: 'mediterranean', size: LARGE }, on), DEFAULT_MED_REACH);
  // Every other mode and the official normal size keep the main behaviour.
  for (const mode of ['random', 'maze', 'archipelago']) {
    assert.equal(economyCoreReach({ mode, size: LARGE }, on), DEFAULT_CORE_REACH);
  }
  assert.equal(economyCoreReach({ mode: 'mediterranean', size: 700 }, on), DEFAULT_CORE_REACH);
  // The 24-cell radius is longer than a ring room's perimeter: a head 20 cells
  // from the crown was permanently "in striking distance" and the crown
  // economy never returned.  With the layer on it may keep building.
  assert.equal(economyYields({ mode: 'mediterranean', size: LARGE, distance: 20 }, off).yields, true);
  assert.equal(economyYields({ mode: 'mediterranean', size: LARGE, distance: 20 }, on).yields, false);
  assert.equal(economyYields({ mode: 'random', size: LARGE, distance: 20 }, on).yields, true);
  // A column actually trading blows on its crown still yields, and an
  // unreachable crown still counts as "no economy window".
  assert.equal(economyYields({ mode: 'mediterranean', size: LARGE, distance: 6 }, on).yields, true);
  assert.equal(economyYields({ mode: 'mediterranean', size: LARGE, distance: Infinity }, on).yields, true);
});

test('the crown-race hold is scoped, released by a dominant army and by the crown budget', () => {
  const config = medPlanConfig({}, { APEX_MED_PLAN: '1' });
  const base = {
    mode: 'mediterranean', size: LARGE, maze: false, turn: 600,
    ownCrowns: 1, enemyCrowns: 3, campaignDistance: 20,
    ownArmy: 4000, enemyArmy: 4000,
  };
  assert.equal(crownRaceHold(base, config), true);
  // Flag off, wrong mode, small room, maze room: main behaviour.
  assert.equal(crownRaceHold(base, medPlanConfig({}, {})), false);
  assert.equal(crownRaceHold({ ...base, mode: 'random' }, config), false);
  assert.equal(crownRaceHold({ ...base, size: 700 }, config), false);
  assert.equal(crownRaceHold({ ...base, maze: true }, config), false);
  // The race only owns the budget once the opening is over.
  assert.equal(crownRaceHold({ ...base, turn: 20 }, config), false);
  // Budget met, or a dominant army: finish the game instead of racing.
  assert.equal(crownRaceHold({ ...base, ownCrowns: 5 }, config), false);
  assert.equal(crownRaceHold({ ...base, ownArmy: 9000 }, config), false);
  // A column standing next to its crown must be allowed to land.
  assert.equal(crownRaceHold({ ...base, campaignDistance: 4 }, config), false);
  // No visible enemy crown means no race.
  assert.equal(crownRaceHold({ ...base, enemyCrowns: 0 }, config), false);
  // The lead is tunable; zero restores the plain grind.
  assert.equal(crownRaceHold(base, medPlanConfig({}, { APEX_MED_PLAN: '1', APEX_MED_PLAN_CROWN_LEAD: '0' })), false);
  // The hold can be thinned out on a duty cycle; every tick is the default.
  assert.equal(medPlanConfig({}, { APEX_MED_PLAN: '1' }).cadence, 1);
  const held = medPlanConfig({}, { APEX_MED_PLAN: '1', APEX_MED_PLAN_HOLD_CADENCE: '4' });
  assert.equal(crownRaceHold({ ...base, turn: 604 }, held), true);
  assert.equal(crownRaceHold({ ...base, turn: 606 }, held), false);
  assert.equal(crownRaceHold({ ...base, turn: 604 }, medPlanConfig({}, { APEX_MED_PLAN: '1' })), true);
  assert.equal(
    medPlanConfig({}, { APEX_MED_PLAN: '1', APEX_MED_PLAN_HOLD_CADENCE: '0' }).cadence,
    1,
  );
});

test('the campaign distance probe is only paid for when the hold can fire', () => {
  const config = medPlanConfig({}, { APEX_MED_PLAN: '1' });
  const base = {
    mode: 'mediterranean', size: LARGE, maze: false, turn: 600,
    ownCrowns: 1, enemyCrowns: 3, ownArmy: 4000, enemyArmy: 4000,
  };
  let calls = 0;
  const probe = () => {
    calls += 1;
    return 20;
  };
  assert.equal(crownRaceHold({ ...base, campaignDistance: probe }, config), true);
  assert.equal(calls, 1);
  // Released before the probe: the board-wide field is never built.
  calls = 0;
  assert.equal(crownRaceHold({ ...base, campaignDistance: probe, ownArmy: 9000 }, config), false);
  assert.equal(calls, 0);
  calls = 0;
  assert.equal(crownRaceHold({ ...base, campaignDistance: probe, ownCrowns: 5 }, config), false);
  assert.equal(calls, 0);
});

// A 30x30 large room with a central sea: both players own the outer ring, which
// is the shape where a head is always inside the 24-cell large-map radius.
function ringRoom({ turn = 600, ownCrowns = 1, enemyCrowns = 3, ownArmy = 6, enemyArmy = 4, side = 30 } = {}) {
  const n = side;
  const m = side;
  const size = n * m;
  const grid = Array(size).fill(0);
  const army = Array(size).fill(0);
  const at = (x, y) => x * m + y;
  const ownEdge = Math.round(n * 0.28);
  const enemyEdge = Math.round(n * 0.7);
  for (let x = 0; x < n; x += 1) {
    for (let y = 0; y < m; y += 1) {
      const index = at(x, y);
      if (!(x < 2 || y < 2 || x >= n - 2 || y >= m - 2)) continue;
      if (x <= ownEdge) {
        grid[index] = 1;
        army[index] = ownArmy;
      } else if (x >= enemyEdge) {
        grid[index] = 2;
        army[index] = enemyArmy;
      }
    }
  }
  grid[at(1, 1)] = 101;
  army[at(1, 1)] = 40;
  grid[at(1, Math.floor(m / 2))] = 101;
  army[at(1, Math.floor(m / 2))] = 40;
  for (let i = 0; i < ownCrowns; i += 1) {
    const cell = at(ownEdge - 2, 3 + i * 4);
    grid[cell] = 101;
    army[cell] = 60;
  }
  for (let i = 0; i < enemyCrowns; i += 1) {
    const cell = at(n - 2, 3 + i * 4);
    grid[cell] = 102;
    army[cell] = 40;
  }
  grid[at(n - 2, m - 3)] = 102;
  army[at(n - 2, m - 3)] = 30;
  return makeBoard({
    n, m, grid, army,
    isolated: Array(size).fill(0),
    fog: Array(size).fill(0),
    turn,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
}

function memory(overrides = {}) {
  return {
    playerId: 1, home: 0, campaign: null, delivery: null, blocked: null,
    threatDistance: {}, maze: false, mapMode: 'mediterranean', ...overrides,
  };
}

function drive(options, env, ticks = 8) {
  return withEnv(env, () => {
    const board = ringRoom(options);
    const state = memory({ mapMode: options.mapMode || 'mediterranean', maze: options.maze });
    const branches = [];
    for (let tick = 0; tick < ticks; tick += 1) {
      board.turn = (options.turn ?? 600) + tick * 2;
      const decision = plan(board, state);
      assert.ok(decision.action === null || ['attack', 'move'].includes(decision.action.kind));
      branches.push(String(decision.branch));
    }
    return branches;
  });
}

test('the planner keeps the crown economy instead of parking on the ring', () => {
  const off = drive({}, { APEX_MED_PLAN: '0' });
  assert.deepEqual(off, Array(off.length).fill('march'));
  const on = drive({}, { APEX_MED_PLAN: '1' });
  // With the layer on the campaign no longer owns every tick, so the crown
  // economy (which is frozen on this shape today) keeps running.
  assert.notDeepEqual(on, off);
  assert.deepEqual(on, Array(on.length).fill('rear-fund'));
  // Each mechanism alone also releases the budget, but to a different branch:
  // the reach change alone funds rear crowns, the hold alone a front cluster.
  assert.deepEqual(
    drive({}, { APEX_MED_PLAN: '1', APEX_MED_PLAN_CROWN_LEAD: '0' }),
    Array(8).fill('rear-fund'),
  );
  assert.deepEqual(
    drive({}, { APEX_MED_PLAN: '1', APEX_MED_PLAN_REACH: '24' }),
    Array(8).fill('cluster-fund'),
  );
});

test('the flag changes nothing where the hold is released or out of scope', () => {
  const holdOnly = { APEX_MED_PLAN: '1', APEX_MED_PLAN_REACH: '24' };
  const cases = [
    // Budget met: the race is already won, grind as before.
    { options: { ownCrowns: 3, enemyCrowns: 3 } },
    // Dominant army: finish the game instead of racing.
    { options: { ownArmy: 20, enemyArmy: 3 } },
    // Opening turns, official normal size, and every other map mode.
    { options: { turn: 20 } },
    { options: { side: 24 } },
    { options: { mapMode: 'random' } },
    { options: { mapMode: 'archipelago' } },
  ];
  for (const { options } of cases) {
    assert.deepEqual(
      drive(options, holdOnly),
      drive(options, { APEX_MED_PLAN: '0' }),
      JSON.stringify(options),
    );
  }
});
