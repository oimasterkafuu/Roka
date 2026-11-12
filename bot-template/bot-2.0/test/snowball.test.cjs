'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeBoard } = require('../bot/board.cjs');
const {
  snowballConfig, snowballEntry, snowballExit, snowballTurn, snowballTakesTick,
  anchorScore, paintScore, captureScore,
} = require('../bot/snowball.cjs');
const { plan, citySnowball } = require('../bot/planner.cjs');

const ON = { enabled: true };

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

// A 30x30 official-large room: our side is the smaller half, the middle is
// neutral and the opponent owns the larger half. That is the shape the phase
// exists for - clearly behind on land, still holding a playable army.
function largeRoom(options = {}) {
  const n = 30;
  const m = 30;
  const size = n * m;
  const grid = Array(size).fill(0);
  const army = Array(size).fill(0);
  const at = (x, y) => x * m + y;
  const ownEdge = options.ownEdge ?? 8;
  const enemyEdge = options.enemyEdge ?? 17;
  for (let x = 0; x < n; x += 1) {
    for (let y = 0; y < m; y += 1) {
      const index = at(x, y);
      if (x <= ownEdge) {
        grid[index] = 1;
        army[index] = 5;
      } else if (x >= enemyEdge) {
        grid[index] = 2;
        army[index] = 3;
      }
    }
  }
  grid[at(1, 1)] = 101;
  army[at(1, 1)] = 20;
  grid[at(28, 28)] = 102;
  army[at(28, 28)] = 20;
  for (const [x, y, kind, value] of options.cells || []) {
    grid[at(x, y)] = kind;
    army[at(x, y)] = value;
  }
  return makeBoard({
    n, m, grid, army,
    isolated: Array(size).fill(0),
    fog: Array(size).fill(0),
    turn: options.turn ?? 320,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
}

function memory(overrides = {}) {
  return {
    playerId: 1,
    home: 0,
    campaign: null,
    delivery: null,
    blocked: null,
    threatDistance: {},
    maze: false,
    ...overrides,
  };
}

function ownCells(board) {
  const cells = [];
  for (let at = 0; at < board.size; at += 1) if (board.own(at) && !board.isolated[at]) cells.push(at);
  return cells;
}

function enemyCells(board) {
  const cells = [];
  for (let at = 0; at < board.size; at += 1) if (board.enemy(at) && !board.isolated[at]) cells.push(at);
  return cells;
}

function totals(board, campaign = null) {
  let own = 0;
  let enemy = 0;
  for (let at = 0; at < board.size; at += 1) {
    if (board.own(at)) own += board.army[at];
    else if (board.enemy(at)) enemy += board.army[at];
  }
  return { own, enemy, campaign };
}

test('the city/economy snowball phase is on by default and APEX_CITY_SNOWBALL=0 disables it', () => {
  assert.equal(snowballConfig({}, {}).enabled, true);
  assert.equal(snowballConfig({}, { APEX_CITY_SNOWBALL: '0' }).enabled, false);
  assert.equal(snowballConfig({}, { APEX_CITY_SNOWBALL: '1' }).enabled, true);
  const tuned = snowballConfig({}, {
    APEX_CITY_SNOWBALL: '1',
    APEX_CITY_SNOWBALL_TURN: '420',
    APEX_CITY_SNOWBALL_LAND_GAP: '0.6',
    APEX_CITY_SNOWBALL_CADENCE: '3',
  });
  assert.equal(tuned.startTurn, 420);
  assert.equal(tuned.landGap, 0.6);
  assert.equal(tuned.cadence, 3);
  // The phase is a large-room layer: the default floor stays at 800 cells.
  assert.equal(snowballConfig({}, { APEX_CITY_SNOWBALL: '1' }).minBoard, 800);
  // Out-of-range overrides are clamped instead of disabling the gate silently.
  assert.equal(snowballConfig({}, { APEX_CITY_SNOWBALL: '1', APEX_CITY_SNOWBALL_CADENCE: '0' }).cadence, 1);
});

test('entry needs a large non-maze room, a land deficit and a playable army', () => {
  const config = snowballConfig(ON);
  const base = {
    size: 900, maze: false, turn: 320,
    ownArmy: 1400, enemyArmy: 1000, ownLand: 300, enemyLand: 400,
  };
  assert.equal(snowballEntry(base, config), true);
  assert.equal(snowballEntry({ ...base, maze: true }, config), false);
  assert.equal(snowballEntry({ ...base, size: 700 }, config), false);
  assert.equal(snowballEntry({ ...base, turn: 120 }, config), false);
  // A land deficit is what opens the phase; a map we already dominate does not.
  assert.equal(snowballEntry({ ...base, ownLand: 340 }, config), false);
  assert.equal(snowballEntry({ ...base, enemyLand: 0 }, config), false);
  // The phase is not a last stand: a collapsing army keeps the campaign budget.
  assert.equal(snowballEntry({ ...base, ownArmy: 500 }, config), false);
  assert.equal(snowballEntry(base, snowballConfig({ enabled: false })), false);
});

test('the phase exits on land parity, on army collapse, on the paint budget and on its span', () => {
  const config = snowballConfig({ ...ON, span: 700, paintBudget: 40, landShare: 0.3 });
  const base = {
    turn: 600, startedTurn: 320, anchors: 1, paints: 4,
    ownArmy: 1400, enemyArmy: 1000, ownLand: 300, enemyLand: 400, size: 900,
  };
  assert.equal(snowballExit(base, config), null);
  assert.equal(snowballExit({ ...base, ownLand: 420 }, config), 'secured');
  assert.equal(snowballExit({ ...base, paints: 40 }, config), 'secured');
  assert.equal(snowballExit({ ...base, ownArmy: 400 }, config), 'lead');
  assert.equal(snowballExit({ ...base, turn: 1100 }, config), 'span');
});

test('the phase takes one tick in `cadence` and never interrupts the last mile', () => {
  const config = snowballConfig({ ...ON, cadence: 2, lastMile: 12 });
  assert.equal(snowballTurn(100, config), true);
  assert.equal(snowballTurn(101, config), false);
  assert.equal(snowballTakesTick(null, config), true);
  assert.equal(snowballTakesTick({ phase: 'attack', bestCrownDistance: 40 }, config), true);
  assert.equal(snowballTakesTick({ phase: 'gather', bestCrownDistance: 9 }, config), false);
});

test('anchor scoring prefers a funded forward city and rejects unsafe cells', () => {
  const config = snowballConfig(ON);
  const base = {
    kind: 'plain', army: 10, enemyDistance: 6, frontDistance: 3, homeDistance: 20,
    pressure: 0, funds: 120, need: 51,
  };
  const plain = anchorScore(base, config);
  assert.ok(Number.isFinite(plain));
  // A defended city is one upgrade (50) away from a crown; a plain needs both.
  assert.ok(anchorScore({ ...base, kind: 'city' }, config) > plain);
  // Forward of the march head and closer to the front both score higher.
  assert.ok(anchorScore({ ...base, frontDistance: 1 }, config) > plain);
  assert.ok(anchorScore({ ...base, enemyDistance: 4 }, config) > plain);
  assert.ok(anchorScore({ ...base, army: 120, funds: 220 }, config) > plain);
  // Rejections: wrong terrain, enemy contact, contested or unfunded sites.
  assert.equal(anchorScore({ ...base, kind: 'crown' }, config), null);
  assert.equal(anchorScore({ ...base, kind: 'swamp' }, config), null);
  assert.equal(anchorScore({ ...base, enemyDistance: 3 }, config), null);
  assert.equal(anchorScore({ ...base, pressure: 40 }, config), null);
  assert.equal(anchorScore({ ...base, funds: 20 }, config), null);
});

test('land painting rejects cells the opponent taps back and cells outside anchor reach', () => {
  const config = snowballConfig(ON);
  const base = {
    owner: 0, kind: 'plain', isolated: false, enemyDistance: 6, anchorDistance: 2,
    room: 2, enemyNeighbours: 0, army: 20,
  };
  const score = paintScore(base, config);
  assert.ok(Number.isFinite(score));
  assert.ok(paintScore({ ...base, anchorDistance: 1 }, config) > score);
  assert.ok(paintScore({ ...base, enemyNeighbours: 2 }, config) > score);
  assert.equal(paintScore({ ...base, owner: 2 }, config), null);
  assert.equal(paintScore({ ...base, kind: 'swamp' }, config), null);
  assert.equal(paintScore({ ...base, enemyDistance: 2 }, config), null);
  assert.equal(paintScore({ ...base, anchorDistance: Infinity }, config), null);
});

test('thin enemy cells are captured only when the source pays the garrison twice', () => {
  const config = snowballConfig(ON);
  assert.ok(Number.isFinite(captureScore({ kind: 'plain', garrison: 3, army: 40 }, config)));
  assert.ok(captureScore({ kind: 'city', garrison: 3, army: 40 }, config) >
    captureScore({ kind: 'plain', garrison: 3, army: 40 }, config));
  // A stack that can barely win the push is not worth a whole action: a failed
  // attack consumes the entire sent stack.
  assert.equal(captureScore({ kind: 'plain', garrison: 12, army: 20 }, config), null);
  assert.equal(captureScore({ kind: 'plain', garrison: 40, army: 400 }, config), null);
  assert.equal(captureScore({ kind: 'crown', garrison: 3, army: 40 }, config), null);
  assert.equal(captureScore({ kind: 'swamp', garrison: 3, army: 40 }, config), null);
});

test('the phase builds a forward city, upgrades it, then converts surplus into land', () => {
  // A funded forward plain: build the city first, exactly as the phase entitles.
  const board = largeRoom({ cells: [[8, 15, 1, 140]] });
  const state = memory();
  const foundation = citySnowball(board, state, ownCells(board), enemyCells(board),
    totals(board), snowballConfig(ON));
  assert.ok(foundation);
  assert.equal(foundation.branch, 'snowball-foundation');
  assert.equal(foundation.action.kind, 'build');
  assert.equal(foundation.action.op, 'b');
  assert.deepEqual([foundation.action.x, foundation.action.y], [8, 15]);
  assert.equal(state.snowball.phase, 'anchor');

  // The same cell, now a city with enough garrison, is upgraded next.
  const upgradedRoom = largeRoom({ cells: [[8, 15, 51, 140]] });
  const upgradeState = memory();
  const upgrade = citySnowball(upgradedRoom, upgradeState, ownCells(upgradedRoom),
    enemyCells(upgradedRoom), totals(upgradedRoom), snowballConfig(ON));
  assert.ok(upgrade);
  assert.equal(upgrade.branch, 'snowball-upgrade');
  assert.equal(upgrade.action.op, 'c');
  assert.equal(upgradeState.snowball.anchors, 1);
  assert.equal(upgradeState.snowball.site, -1);

  // With the anchor budget spent the phase switches to land and captures a
  // neutral cell next to our territory instead of adding another crown.
  const paintRoom = largeRoom();
  const paintMemory = memory({
    snowball: { phase: 'paint', startedTurn: 320, anchors: 2, paints: 0, site: -1, misses: 0 },
  });
  const paint = citySnowball(paintRoom, paintMemory, ownCells(paintRoom), enemyCells(paintRoom),
    totals(paintRoom), snowballConfig(ON));
  assert.ok(paint);
  assert.equal(paint.branch, 'snowball-paint');
  assert.equal(paint.action.kind, 'attack');
  assert.equal(paintMemory.snowball.paints, 1);
});

test('the phase takes thin enemy cells once the neutral frontier is gone', () => {
  // No neutral ring: the two sides touch, so land can only come from the
  // opponent. The thin garrison is cheaper than the surrounding stacks.
  const board = largeRoom({ ownEdge: 10, enemyEdge: 11, cells: [[10, 15, 1, 40]] });
  const state = memory({
    snowball: { phase: 'paint', startedTurn: 320, anchors: 2, paints: 0, site: -1, misses: 0 },
  });
  const decision = citySnowball(board, state, ownCells(board), enemyCells(board),
    totals(board), snowballConfig(ON));
  assert.ok(decision);
  assert.equal(decision.branch, 'snowball-paint');
  assert.equal(decision.action.kind, 'attack');
  assert.deepEqual([decision.action.x, decision.action.y], [10, 15]);
  assert.deepEqual([decision.action.dx, decision.action.dy], [11, 15]);
});

test('the phase stays silent on maze rooms and without a land deficit', () => {
  const board = largeRoom({ cells: [[8, 15, 1, 140]] });
  const cells = ownCells(board);
  const enemySide = enemyCells(board);
  // Maze rooms keep the maze economy; the phase never fires there.
  assert.equal(
    citySnowball(board, memory({ maze: true }), cells, enemySide, totals(board), snowballConfig(ON)),
    null,
  );
  // A dominant land position is not a snowball target either.
  const dominant = memory();
  assert.equal(
    citySnowball(board, dominant, cells.slice(0, 320), enemySide.slice(0, 100),
      totals(board), snowballConfig(ON)),
    null,
  );
  assert.equal(dominant.snowball, undefined);
});

test('the planner never emits a snowball branch while the flag is off', () => {
  withEnv({ APEX_CITY_SNOWBALL: '0' }, () => {
    const board = largeRoom({ cells: [[8, 15, 1, 140]] });
    const state = memory();
    for (let tick = 0; tick < 6; tick += 1) {
      board.turn = 320 + tick * 2;
      const decision = plan(board, state);
      assert.equal(String(decision.branch).startsWith('snowball'), false);
    }
    assert.equal(state.snowball, undefined);
  });
});
