'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeBoard } = require('../bot/board.cjs');
const { race, pickOpponent, DEFAULT_MARGIN } = require('../bot/duel/race.cjs');

function board(grid, army, options = {}) {
  const n = options.n ?? 1;
  const m = options.m ?? grid.length / n;
  const size = n * m;
  return makeBoard({
    n,
    m,
    grid,
    army,
    isolated: options.isolated || Array(size).fill(0),
    fog: options.fog || Array(size).fill(0),
    turn: options.turn ?? 0,
    leaderboard: [{ id: 1, team: 1 }, { id: 2, team: 2 }],
  }, options.playerId ?? 1);
}

test('a faster crown strike wins the race', () => {
  // Our stack sits next to their crown (eta 1); their stack needs two hops.
  const b = board([101, 1, 102, 2, 2, 101, 200], [5, 30, 10, 20, 0, 5, 0]);
  const result = race(b);
  assert.equal(result.playerId, 1);
  assert.equal(result.opponentId, 2);
  assert.equal(result.ourEta, 1);
  assert.equal(result.theirEta, 2);
  assert.equal(result.weWinRace, true);
  assert.equal(result.verdict, 'win-race');
  assert.equal(result.our.goal, 2);
  assert.equal(result.their.path[result.their.path.length - 1], 5);
  assert.equal(b.kind(5), 'crown');
});

test('the margin decides equal-speed races and needs calibration', () => {
  // Both sides kill their enemy crown in one tick.
  const b = board([101, 1, 102, 2, 101], [5, 20, 3, 20, 5]);
  assert.equal(DEFAULT_MARGIN, 1);
  const cautious = race(b);
  assert.equal(cautious.ourEta, cautious.theirEta);
  assert.equal(cautious.weWinRace, false);
  assert.equal(cautious.verdict, 'lose-race');

  const aggressive = race(b, { margin: 0 });
  assert.equal(aggressive.weWinRace, true);
  assert.equal(aggressive.verdict, 'win-race');
});

test('an opponent without a kill cannot win the race', () => {
  // Their crown is the only visible cell they own and its garrison is 0, so
  // they have no tap at all while our route is a clean two-tick kill.
  const b = board([101, 0, 102], [20, 0, 3]);
  const result = race(b);
  assert.equal(result.our.ok, true);
  assert.equal(result.their.ok, false);
  assert.equal(result.theirEta, null);
  assert.equal(result.weWinRace, true);
});

test('fog hides the opponent stack instead of guessing it', () => {
  // Identical board, but the enemy stack cell is fogged and therefore reported
  // with owner 0 / army 0.  The race may not invent a hidden counter-raid.
  const visible = board([101, 1, 1, 102, 2, 2, 2, 101], [5, 0, 30, 10, 20, 0, 0, 5]);
  const hidden = board([101, 1, 1, 102, 200, 0, 0, 101], [5, 0, 30, 10, 0, 0, 0, 5], {
    fog: [0, 0, 0, 0, 1, 1, 1, 0],
  });
  const openRace = race(visible);
  const fogRace = race(hidden);
  assert.equal(openRace.their.ok, true);
  assert.equal(fogRace.their.ok, false);
  assert.equal(fogRace.weWinRace, true);
  assert.equal(fogRace.verdict, 'win-race');
});

test('opponent selection is deterministic and configurable', () => {
  // Player 2 owns the most visible cells, so it is the inferred opponent; an
  // explicit opponent with no stack at all simply cannot kill.
  const b = board([101, 1, 1, 2, 102, 3], [5, 10, 10, 4, 5, 1]);
  assert.equal(pickOpponent(b, 1), 2);
  const explicit = race(b, { opponentId: 3 });
  assert.equal(explicit.opponentId, 3);
  assert.equal(explicit.their.ok, false);
  assert.equal(explicit.weWinRace, true);
  assert.equal(explicit.verdict, 'win-race');
});

test('no side has a kill returns a stable verdict', () => {
  const b = board([101, 1, 1, 102], [100, 0, 0, 100]);
  const result = race(b);
  assert.equal(result.our.ok, false);
  assert.equal(result.their.ok, false);
  assert.equal(result.weWinRace, false);
  assert.equal(result.verdict, 'stable');
});
