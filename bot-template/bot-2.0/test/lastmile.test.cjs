'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeBoard } = require('../bot/board.cjs');
const {
  lastMileConfig, lastMileState, lastMileNeed, boundedMargin, reseatRoot, freshLedger,
} = require('../bot/lastmile.cjs');
const { plan } = require('../bot/planner.cjs');

// One tick of the last mile: our column is three cells from the enemy crown,
// behind two enemy cells and the crown itself.
function config(overrides = {}) {
  return lastMileConfig({
    enabled: true, range: 6, margin: 0.15, stageTimeout: 24, targetMode: 'first',
    mode: 'full', minBoardSize: 0, ...overrides,
  });
}
const STAGE = config();
const WHOLE_PATH = config({ targetMode: 'path' });

function setEnv(values) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function lastMileBoard(rootArmy, firstEnemyArmy = 10) {
  return makeBoard({
    n: 1, m: 8,
    grid: [101, 1, 1, 1, 2, 2, 2, 102],
    army: [20, 5, 50, rootArmy, firstEnemyArmy, 10, 10, 150],
    isolated: Array(8).fill(0), fog: Array(8).fill(0), turn: 100,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
}

function lastMileMemory() {
  return {
    playerId: 1,
    home: 0,
    campaign: {
      crown: 7, at: 3, phase: 'gather', started: 0, lastPhase: 'gather',
      lastProgress: 0, deliveryBestDistance: Infinity, bestCrownDistance: 4,
      musterTurns: 4,
    },
    delivery: null, blocked: null, threatDistance: {},
  };
}

function step(state, turn, dist, army) {
  return lastMileState({
    board: { turn }, campaign: state.campaign, dist, army,
    firstNeed: 18, pathNeed: 189, config: STAGE,
  });
}

test('the last-mile layer is off unless APEX_LAST_MILE enables it', () => {
  const restore = setEnv({ APEX_LAST_MILE: undefined, APEX_LAST_MILE_RANGE: undefined });
  try {
    assert.equal(lastMileConfig().enabled, false);
    assert.equal(lastMileState({
      board: { turn: 10 }, campaign: { crown: 7, at: 1 }, dist: 3, army: 400,
      firstNeed: 30, pathNeed: 100, config: lastMileConfig(),
    }).state, 'approach');
  } finally {
    restore();
  }
  const restoreOn = setEnv({ APEX_LAST_MILE: '1', APEX_LAST_MILE_RANGE: '5' });
  try {
    const fromEnv = lastMileConfig();
    assert.equal(fromEnv.enabled, true);
    assert.equal(fromEnv.range, 5);
    assert.equal(fromEnv.targetMode, 'first');
    // Staging/commit/reroute are opt-in: the rejected full state machine is not
    // what the flag turns on by default.
    assert.equal(fromEnv.mode, 'reseat');
    assert.equal(fromEnv.minBoardSize, 800);
  } finally {
    restoreOn();
  }
});

test('the top-up margin is bounded for small and large paths', () => {
  assert.equal(boundedMargin(20, STAGE), 6);
  assert.equal(boundedMargin(400, STAGE), 28);
  // The default profile prices the next hostile cell, not the whole path.
  assert.equal(lastMileNeed(189, 18, 260, STAGE), 24);
  assert.equal(lastMileNeed(189, 90, 260, STAGE), 104);
  // The rejected whole-path profile stays available for A/B runs.
  assert.equal(lastMileNeed(189, 18, 260, WHOLE_PATH), 217);
  // The urgency cap never drops below the first-contact requirement.
  assert.equal(lastMileNeed(1200, 18, 260, WHOLE_PATH), 260);
});

test('far from the crown the ledger stays in approach and drops the commitment', () => {
  const campaign = { crown: 7, at: 3, lastMile: { ...freshLedger(7, 2, 300, 50), committed: true } };
  const state = lastMileState({
    board: { turn: 51 }, campaign, dist: 9, army: 300, firstNeed: 30, pathNeed: 200, config: STAGE,
  });
  assert.equal(state.state, 'approach');
  assert.equal(state.ledger.committed, false);
  // The best distance ever reached is kept so a later reseat can use it.
  assert.equal(state.ledger.bestDist, 2);
});

test('an unaffordable last mile stages instead of feeding a partial push', () => {
  const campaign = { crown: 7, at: 3 };
  const state = lastMileState({
    board: { turn: 40 }, campaign, dist: 4, army: 10, firstNeed: 18, pathNeed: 189, config: STAGE,
  });
  assert.equal(state.state, 'stage');
  assert.equal(state.target, 24);
  assert.equal(campaign.lastMile.crown, 7);
});

test('an affordable last mile commits and keeps committing while the column shrinks', () => {
  const campaign = { crown: 7, at: 3 };
  const commit = lastMileState({
    board: { turn: 40 }, campaign, dist: 4, army: 30, firstNeed: 18, pathNeed: 189, config: STAGE,
  });
  assert.equal(commit.state, 'commit');
  assert.equal(commit.ledger.commits, 1);
  // One hop later the column has paid the first hostile cell and is thinner
  // than the entry strength; it must keep pushing, not re-muster.
  const next = lastMileState({
    board: { turn: 41 }, campaign, dist: 3, army: 14, firstNeed: 18, pathNeed: 170, config: STAGE,
  });
  assert.equal(next.state, 'commit');
  assert.equal(next.ledger.commits, 1);
});

test('a dead column inside the last mile releases the commitment', () => {
  const campaign = { crown: 7, at: 3 };
  lastMileState({
    board: { turn: 40 }, campaign, dist: 4, army: 30, firstNeed: 18, pathNeed: 189, config: STAGE,
  });
  const dead = lastMileState({
    board: { turn: 41 }, campaign, dist: 4, army: 4, firstNeed: 18, pathNeed: 189, config: STAGE,
  });
  assert.equal(dead.state, 'stage');
  assert.equal(dead.ledger.committed, false);
});

test('staging without progress reroutes, a landing convoy restarts the clock', () => {
  const campaign = { crown: 7, at: 3 };
  const first = lastMileState({
    board: { turn: 40 }, campaign, dist: 4, army: 6, firstNeed: 18, pathNeed: 189, config: STAGE,
  });
  assert.equal(first.state, 'stage');
  // A convoy lands: army jumps by more than ambient growth.
  const fed = lastMileState({
    board: { turn: 50 }, campaign, dist: 4, army: 12, firstNeed: 18, pathNeed: 189, config: STAGE,
  });
  assert.equal(fed.state, 'stage');
  const stalled = lastMileState({
    board: { turn: 74 }, campaign, dist: 4, army: 12, firstNeed: 18, pathNeed: 189, config: STAGE,
  });
  assert.equal(stalled.state, 'reroute');
});

test('reseat picks the best forward supply cell near the best distance', () => {
  const board = makeBoard({
    n: 1, m: 6,
    grid: [101, 1, 1, 2, 2, 102],
    army: [20, 80, 40, 10, 10, 5],
    isolated: Array(6).fill(0), fog: Array(6).fill(0), turn: 100,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
  // Distances to the crown: 0 -> 5, 1 -> 4, 2 -> 3.
  const distances = [5, 4, 3, -1, -1, 0];
  assert.equal(reseatRoot(board, [0, 1], distances, 3, STAGE), 1);
  // A thin stack is not a launch point.
  const thin = makeBoard({
    n: 1, m: 6,
    grid: [101, 1, 1, 2, 2, 102],
    army: [20, 80, 5, 10, 10, 5],
    isolated: Array(6).fill(0), fog: Array(6).fill(0), turn: 100,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, 1);
  assert.equal(reseatRoot(thin, [0, 2], distances, 3, STAGE), 0);
  // Beyond the reseat slack there is no forward supply cell any more.
  assert.equal(reseatRoot(thin, [0, 1], [20, 21, 3, -1, -1, 0], 3, STAGE), -1);
  // Out of the last mile nothing is reseated.
  assert.equal(reseatRoot(board, [0, 1], distances, 30, STAGE), -1);
  // And a normal-size room has no long approach to recover in the first place.
  assert.equal(reseatRoot(board, [0, 1], distances, 3, config({ minBoardSize: 800 })), -1);
});

test('the planner commits the last mile as soon as first contact is payable', () => {
  // Default planner gates the same stack behind 65% of the whole path.
  assert.equal(plan(lastMileBoard(25), lastMileMemory()).branch, 'muster');
  const restore = setEnv({ APEX_LAST_MILE: '1', APEX_LAST_MILE_MODE: 'full' });
  try {
    const memory = lastMileMemory();
    const decision = plan(lastMileBoard(25), memory);
    assert.equal(decision.branch, 'march');
    assert.equal(memory.campaign.lastMile.committed, true);

    // A heavier first contact is still unaffordable, so the column gathers
    // instead of feeding a partial push.
    const staged = lastMileMemory();
    const held = plan(lastMileBoard(30, 20), staged);
    assert.equal(held.branch, 'muster');
    assert.equal(staged.campaign.phase, 'gather');
    assert.equal(staged.campaign.lastMile.committed, false);
  } finally {
    restore();
  }
});

test('a stalled last mile releases the crown for a reroute', () => {
  const restore = setEnv({ APEX_LAST_MILE: '1', APEX_LAST_MILE_MODE: 'full' });
  try {
    const memory = lastMileMemory();
    memory.campaign.lastMile = {
      ...freshLedger(7, 4, 60, 1), committed: false, lastProgress: 1, prevArmy: 60,
    };
    plan(lastMileBoard(60), memory);
    assert.equal(memory.blocked?.crown, 7);
    assert.equal(memory.campaign, null);
  } finally {
    restore();
  }
});

test('a cut column reseats forward instead of restarting at distance 40+', () => {
  // Default (reseat) mode with the size gate opened so a small fixture board
  // reaches the same planner branch as an official large room.
  const restore = setEnv({ APEX_LAST_MILE: '1', APEX_LAST_MILE_MIN_BOARD: '0' });
  try {
    const board = makeBoard({
      n: 1, m: 10,
      grid: [101, 1, 1, 1, 2, 1, 1, 2, 2, 102],
      army: [20, 30, 30, 90, 10, 40, 4, 10, 10, 30],
      isolated: [0, 0, 0, 0, 0, 0, 1, 0, 0, 0], fog: Array(10).fill(0), turn: 200,
      leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
    }, 1);
    const memory = {
      playerId: 1, home: 0, delivery: null, blocked: null, threatDistance: {},
      campaign: {
        crown: 9, at: 6, phase: 'attack', started: 100, lastPhase: 'attack',
        lastProgress: 190, deliveryBestDistance: Infinity, bestCrownDistance: 3,
        lastMile: { ...freshLedger(9, 3, 4, 150), committed: true, commits: 1 },
      },
    };
    plan(board, memory);
    assert.equal(memory.campaign.crown, 9);
    assert.notEqual(memory.campaign.at, 6);
    assert.equal(memory.campaign.lastMile.reseats, 1);
  } finally {
    restore();
  }
});
