'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeBoard } = require('../bot/board.cjs');
const {
  smallRaceConfig, smallRaceUpdate, smallRaceIncome, smallRaceEconomyRelief,
  freshSmallRace, DEFAULT_ENTRY_END, DEFAULT_MAX_BOARD, DEFAULT_DOMINANCE,
} = require('../bot/crownrace.cjs');
const { plan } = require('../bot/planner.cjs');

const ON = { enabled: true };
const COMPACT = 225;

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

// A 0.34-room state that matches the losing shape measured on the seeds-8 set:
// one crown each, the opponent's economy ahead (income and land), the opponent
// holding the bigger army and no crown captured recently.
function behind(overrides = {}) {
  return {
    size: COMPACT,
    turn: 50,
    maze: false,
    ownCrowns: 1,
    enemyCrowns: 1,
    ownLand: 30,
    enemyLand: 41,
    ownArmy: 500,
    enemyArmy: 700,
    campaignDistance: 10,
    ...overrides,
  };
}

function step(inputs, overrides = {}, config = smallRaceConfig(ON)) {
  const state = freshSmallRace();
  let decision = null;
  for (const input of inputs) decision = smallRaceUpdate(state, input, { ...config, ...overrides });
  return { state, decision };
}

test('the layer is off by default and scoped to compact rooms', () => {
  assert.equal(smallRaceConfig({}, {}).enabled, false);
  assert.equal(smallRaceConfig({}, { APEX_SMALL_CROWN_RACE: '1' }).enabled, true);
  for (const value of ['0', 'false', 'off']) {
    assert.equal(smallRaceConfig({}, { APEX_SMALL_CROWN_RACE: value }).enabled, false);
  }
  const config = smallRaceConfig({}, {});
  assert.equal(config.maxBoard, DEFAULT_MAX_BOARD);
  assert.equal(config.entryEnd, DEFAULT_ENTRY_END);
  assert.equal(config.dominance, DEFAULT_DOMINANCE);
  // Out-of-range values clamp instead of disabling the layer silently.
  assert.equal(smallRaceConfig({}, { APEX_SMALL_RACE_ENTRY_END: '-5' }).entryEnd, 0);
  assert.equal(smallRaceConfig({}, { APEX_SMALL_RACE_SPAN: '1' }).span, 20);
  // Income = crowns + land/50, i.e. the engine's two production terms.
  assert.equal(smallRaceIncome(3, 50), 4);
  assert.equal(smallRaceIncome(1, 25), 1.5);
});

test('the phase enters when the crown economy is behind and the opponent has the army', () => {
  const { state, decision } = step([behind()]);
  assert.equal(decision.active, true);
  assert.equal(state.entries, 1);
  assert.equal(state.entry.turn, 50);
  assert.equal(state.entry.landDeficit, true);
  assert.equal(state.entry.incomeDeficit, true);
  // The layer records the crown-construction race but does not gate on it.
  assert.equal(state.entry.ownBuilt, null);
  assert.equal(state.entry.enemyBuilt, null);
});

test('the phase does not enter while the crown race is ours', () => {
  const cases = {
    // Crown budget met (the GM23HTGqA0co win kept minting crowns: 5 against 1).
    'crown budget met': behind({ ownCrowns: 3, enemyCrowns: 1 }),
    // Equal or bigger army: with the army lead the map is ours to press.
    'army not behind': behind({ ownArmy: 700, enemyArmy: 700 }),
    'army ahead': behind({ ownArmy: 900, enemyArmy: 500 }),
    // Income is fine even though land is behind (crowns pay for the gap).
    'income ahead': behind({ ownCrowns: 1, enemyCrowns: 3, ownLand: 70 }),
    // Land is comparable: the opponent is not out-building the economy.
    'land comparable': behind({ ownLand: 40, enemyLand: 42 }),
    // Corridor maps: ground is bounded by the maze, not by a paint race.
    'maze room': behind({ maze: true }),
    // Full-size rooms are not this layer's business.
    'large room': behind({ size: 900 }),
    // Outside the bounded window.
    'before the window': behind({ turn: 20 }),
    'after the window': behind({ turn: 120 }),
    // A column already inside its crown's reach must be allowed to land.
    'crown exposed': behind({ campaignDistance: 4 }),
    // No crown captured for longer than the stale window is required; a fresh
    // capture means the attacks are converting.
    'converting': [behind({ turn: 20, enemyCrowns: 2 }), behind({ turn: 45, enemyCrowns: 1 })],
  };
  for (const [name, input] of Object.entries(cases)) {
    const inputs = Array.isArray(input) ? input : [input];
    const { decision } = step(inputs);
    assert.equal(decision.active, false, name);
  }
});

test('the phase exits on restored parity, an exposed crown, a lost race or the span', () => {
  const enter = behind();
  // Crown budget met and army parity restored: the race is won, press again.
  const parity = step([enter, behind({ turn: 60, ownCrowns: 3, enemyCrowns: 1, ownArmy: 690, enemyArmy: 700 })]);
  assert.equal(parity.decision.active, false);
  assert.equal(parity.state.exit, 'crown-parity');
  // A column within reach releases the budget immediately.
  const exposed = step([enter, behind({ turn: 60, campaignDistance: 5 })]);
  assert.equal(exposed.decision.active, false);
  assert.equal(exposed.state.exit, 'crown-exposed');
  // The opponent overtaking us in crowns: attacking its crowns is the only
  // route back, so the economy phase hands the budget back.
  const lost = step([enter, behind({ turn: 60, ownCrowns: 1, enemyCrowns: 4 })]);
  assert.equal(lost.decision.active, false);
  assert.equal(lost.state.exit, 'enemy-lead');
  // The phase is bounded: a race that cannot restore parity gives up.
  const span = step([enter, behind({ turn: 50 + smallRaceConfig(ON).span })]);
  assert.equal(span.decision.active, false);
  assert.equal(span.state.exit, 'span');
});

test('the phase latches after its bounded window instead of oscillating', () => {
  const { state } = step([behind(), behind({ turn: 180 })], {});
  assert.equal(state.done, true);
  // A later deficit inside the window does not re-enter.
  const again = step([behind(), behind({ turn: 200 })]);
  assert.equal(again.state.done, true);
  assert.equal(again.state.active, false);
  assert.equal(again.state.entries, 1);
});

test('the layer stays out of the way when it is disabled or out of scope', () => {
  const off = { ...smallRaceConfig({}), enabled: false };
  const state = freshSmallRace();
  const decision = smallRaceUpdate(state, behind(), off);
  assert.equal(decision.active, false);
  assert.equal(state.entries, 0);
  assert.equal(state.samples.length, 0);
});

test('the economy yield relief only applies while the race phase owns the budget', () => {
  const config = smallRaceConfig(ON);
  const active = { ...freshSmallRace(), active: true };
  // 0.34 rooms are smaller than the 24-cell large-map radius; during the race
  // the rear crown project keeps running until a column is in the last mile.
  assert.equal(smallRaceEconomyRelief(active, 20, config), true);
  // The yield boundary is the same as the mediterranean reach: economy stops
  // only strictly inside the last-mile range.
  assert.equal(smallRaceEconomyRelief(active, 5, config), false);
  assert.equal(smallRaceEconomyRelief(active, 6, config), true);
  assert.equal(smallRaceEconomyRelief(active, Infinity, config), false);
  assert.equal(smallRaceEconomyRelief(freshSmallRace(), 20, config), false);
  assert.equal(smallRaceEconomyRelief(null, 20, config), false);
});

// ---------------------------------------------------------------------------
// Planner wiring.  A 15x15 room (225 cells) with the opponent ahead on land,
// income and army is the measured losing shape; the same board with our crown
// lead is the shape where pressure must be preserved.

function compactRoom({ turn = 50, ownLand = 30, enemyLand = 42, ownArmy = 180, enemyArmy = 330 } = {}) {
  const n = 15;
  const m = 15;
  const size = n * m;
  const grid = Array(size).fill(0);
  const army = Array(size).fill(0);
  const at = (x, y) => x * m + y;
  const ownCols = Math.ceil(ownLand / n);
  const enemyCols = Math.ceil(enemyLand / n);
  for (let x = 0; x < n; x += 1) {
    for (let y = 0; y < m; y += 1) {
      const index = at(x, y);
      if (x < ownCols) {
        grid[index] = 1;
        army[index] = Math.round(ownArmy / ownLand);
      } else if (x >= n - enemyCols - 1) {
        grid[index] = 2;
        army[index] = Math.round(enemyArmy / enemyLand);
      }
    }
  }
  grid[at(0, 0)] = 101;
  army[at(0, 0)] = 40;
  grid[at(n - 1, m - 1)] = 102;
  army[at(n - 1, m - 1)] = 60;
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
    threatDistance: {}, maze: false, mapMode: 'random',
    campaign: null, delivery: null, ...overrides,
  };
}

function drive(board, state, ticks = 8, startTurn = 50) {
  const branches = [];
  for (let tick = 0; tick < ticks; tick += 1) {
    board.turn = startTurn + tick * 2;
    const decision = plan(board, state);
    assert.ok(decision.action === null || ['attack', 'move', 'build'].includes(decision.action.kind));
    branches.push(String(decision.branch));
  }
  return branches;
}

function raceState(board) {
  const own = [];
  const enemies = [];
  for (let at = 0; at < board.size; at += 1) {
    if (board.own(at) && !board.isolated[at]) own.push(at);
    if (board.enemy(at) && !board.isolated[at]) enemies.push(at);
  }
  const crown = enemies.find((at) => board.kind(at) === 'crown');
  return memory({ campaign: { at: own.at(-1), crown, phase: 'attack', route: null } });
}

test('with the race behind us the planner spends the window on economy, not the push', () => {
  const off = drive(compactRoom(), raceState(compactRoom()), 8);
  const on = withEnv({ APEX_SMALL_CROWN_RACE: '1' }, () => {
    const board = compactRoom();
    return drive(board, raceState(board), 8);
  });
  assert.notDeepEqual(on, off);
  // Flag off: the campaign owns the budget (muster/cluster funding).
  assert.ok(off.some((branch) => branch === 'muster'), off.join(','));
  // Flag on: the phase entered and the economy branches took the budget; the
  // campaign is paused instead of marching.
  assert.ok(!on.includes('march'), on.join(','));
  assert.ok(on.some((branch) => /fund|foundation|cluster/.test(branch)), on.join(','));
});

test('with the crown race ours the flag changes nothing and pressure keeps running', () => {
  const pressure = () => {
    const board = compactRoom({ ownLand: 60, enemyLand: 30, ownArmy: 400, enemyArmy: 200 });
    return { board, state: raceState(board) };
  };
  const first = pressure();
  const off = drive(first.board, first.state, 8);
  const second = pressure();
  const on = withEnv({ APEX_SMALL_CROWN_RACE: '1' }, () => drive(second.board, second.state, 8));
  assert.deepEqual(on, off);
  assert.equal(second.state.smallRace?.entries ?? 0, 0);
  // The attack branches are still reachable with the flag on.
  assert.ok(off.some((branch) => /muster|march|front/.test(branch)), off.join(','));
});
