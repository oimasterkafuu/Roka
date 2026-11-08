'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeBoard } = require('../bot/board.cjs');
const { previewAttack } = require('../bot/rules.cjs');
const { bestKill, garrisonAt, growthFor } = require('../bot/duel/killpath.cjs');

// n x m board; cell index = x * m + y, so a 1 x k board is simply a row.
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

test('crown growth and normal growth follow the Roka production table', () => {
  const b = board([101, 1, 102], [0, 0, 0], { turn: 49 });
  assert.equal(growthFor('crown', 49, 2), 2);
  assert.equal(growthFor('plain', 49, 1), 1);
  assert.equal(growthFor('city', 0, 49), 0);
  assert.equal(growthFor('swamp', 0, 200), 0);
  // Neutral cells never produce even when their kind is a crown.
  assert.equal(garrisonAt(board([100], [7]), 0, 10), 7);
  assert.equal(garrisonAt(b, 0, 1), 1);
});

test('a capture needs a push strictly greater than the garrison plus growth', () => {
  // One tick of travel: the enemy crown grows once, so the send of 7 only just
  // beats 5 + 1 and a send of 6 fails.  Full push sends army - 1.
  const win = board([101, 102], [8, 5]);
  const result = bestKill(win);
  assert.equal(result.ok, true);
  assert.equal(result.eta, 1);
  assert.equal(result.tap, 0);
  assert.deepEqual(result.path, [0, 1]);
  assert.equal(result.departing, 7);
  assert.equal(result.required, 7);
  assert.equal(result.delivered, 1);
  assert.equal(result.growth.goal, 1);

  const lose = bestKill(board([101, 102], [7, 5]));
  assert.equal(lose.ok, false);
  assert.equal(lose.reason, 'no-route');
});

test('fragments merge through an owned relay to beat a stack neither can beat alone', () => {
  // 0 crown 4 -> 1 empty own -> 2 own 12 -> 3 enemy 12.
  // Alone, cell 2 sends 11 and loses; 4 - 1 = 3 arriving at cell 1 then merges
  // with 12 and pushes 13, which captures and leaves one.
  const b = board([101, 1, 1, 2], [4, 0, 12, 12]);
  const result = bestKill(b, { goal: 3, allowRiskyCuts: true });
  assert.equal(result.ok, true);
  assert.equal(result.tap, 0);
  assert.deepEqual(result.path, [0, 1, 2, 3]);
  assert.equal(result.departing, 3);
  assert.equal(result.required, 3);
  assert.equal(result.delivered, 1);
  assert.equal(result.eta, 3);

  // With the crown unable to push, the big fragment still cannot do it alone.
  const alone = bestKill(board([101, 1, 1, 2], [1, 0, 12, 12]), { goal: 3, allowRiskyCuts: true });
  assert.equal(alone.ok, false);
  assert.equal(alone.reason, 'no-route');
});

test('goal growth can turn a feasible route into no kill at all', () => {
  // 4 ticks of travel across neutrals costs three guards, so a send of 24 lands
  // 21 units on the crown.  Static garrisons make that a kill, four ticks of
  // crown growth do not.
  const b = board([101, 0, 0, 0, 102], [25, 0, 0, 0, 18]);
  const staticRoute = bestKill(b, { ignoreGrowth: true });
  assert.equal(staticRoute.ok, true);
  assert.equal(staticRoute.eta, 4);
  assert.equal(staticRoute.delivered, 3);
  assert.equal(bestKill(b).ok, false);
});

test('friendly crown relay growth can make a route feasible', () => {
  // Goal is a static enemy plain (12); the owned crown relay adds one unit on
  // the tick we pass, which lowers the required send from 5 to 4.
  const b = board([101, 101, 200, 200], [5, 10, 0, 12]);
  const result = bestKill(b, { goal: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.eta, 3);
  assert.equal(result.required, 4);
  assert.equal(result.departing, 4);
  assert.equal(result.growth.relays, 1);
  assert.equal(bestKill(b, { goal: 3, ignoreGrowth: true }).ok, false);
});

test('a mountain forces a detour instead of a straight line', () => {
  // 2 x 3: the direct row is blocked, so the route leaves through row x=1.
  const b = board([101, 201, 200, 200, 200, 102], [60, 0, 0, 0, 0, 3], { n: 2, m: 3 });
  const result = bestKill(b);
  assert.equal(result.ok, true);
  assert.equal(result.eta, 3);
  assert.deepEqual(result.path, [0, 3, 4, 5]);
  assert.equal(result.path.includes(1), false);
});

test('an isolated own stack is never used as the tap', () => {
  const b = board([101, 102, 1], [100, 3, 20], { n: 3, m: 1, isolated: [1, 0, 0] });
  const result = bestKill(b);
  assert.equal(result.ok, true);
  assert.equal(result.tap, 2);
  assert.equal(result.path[result.path.length - 1], result.goal);
});

test('one-cell corridor cuts are rejected unless risky cuts are allowed', () => {
  // 0 crown 30 - 1 corridor 30 - 2 tap 20, enemy 40 at 5 can cut cell 1
  // behind the tap, and two enemy crowns (6 and 7) make this a non-decap kill.
  // Cutting cell 1 disconnects the tap and every captured cell from the anchor.
  const grid = [101, 1, 1, 200, 200, 2, 102, 102];
  const army = [30, 30, 20, 0, 0, 40, 5, 5];
  const b = board(grid, army, { n: 2, m: 4 });
  const rejected = bestKill(b);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'cut-risk');
  assert.equal(rejected.cutRisk.level, 'high');
  assert.equal(rejected.cutRisk.risky, true);
  assert.equal(rejected.cutRisk.cells[0].cell, 1);
  assert.equal(rejected.cutRisk.cells[0].phase, 'behind-tap');

  const forced = bestKill(b, { allowRiskyCuts: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.reason, 'risky-cut');
  assert.equal(forced.cutRisk.risky, true);
  assert.equal(forced.eta, 1);
});

test('capturing the last enemy crown ignores a cut risk behind the stack', () => {
  // Same corridor, but cell 7 is neutral: crown 6 is the defender's last
  // crown, so the capture ends the game before a cut can strand anything.
  const grid = [101, 1, 1, 200, 200, 2, 102, 200];
  const army = [30, 30, 20, 0, 0, 40, 5, 0];
  const b = board(grid, army, { n: 2, m: 4 });
  const result = bestKill(b);
  assert.equal(result.ok, true);
  assert.equal(result.decap, true);
  assert.equal(result.eta, 1);
  assert.equal(result.cutRisk.risky, false);
  assert.equal(result.cutRisk.level, 'none');
});

test('tie-break prefers the lower ETA, then more delivered army, then the lower cell', () => {
  // Both own cells are one step from the enemy crown with equal stacks; the
  // lower index must win.
  const symmetric = board([1, 102, 1], [20, 3, 20], { n: 3, m: 1 });
  const tie = bestKill(symmetric);
  assert.equal(tie.ok, true);
  assert.equal(tie.eta, 1);
  assert.equal(tie.delivered, 15);
  assert.equal(tie.tap, 0);

  // The closer stack wins even with a smaller surplus.
  const closer = board([101, 1, 102], [20, 20, 3], { n: 3, m: 1 });
  const fast = bestKill(closer);
  assert.equal(fast.eta, 1);
  assert.equal(fast.tap, 1);
});

test('no route returns ok:false with diagnostics', () => {
  const b = board([101, 201, 201, 201, 102], [100, 0, 0, 0, 5]);
  const result = bestKill(b);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-route');
  assert.equal(result.path, null);
  assert.equal(result.eta, Infinity);
  assert.equal(result.cutRisk.level, 'none');
});

test('invisible crowns are not targetable', () => {
  const b = board([101, 0, 102], [40, 0, 5], { fog: [0, 0, 1] });
  assert.equal(bestKill(b).ok, false);
  assert.equal(bestKill(b).reason, 'no-goal');
});

test('a multi-tick route matches previewAttack tick by tick', () => {
  const b = board([101, 0, 0, 0, 2], [30, 0, 0, 0, 10]);
  const result = bestKill(b, { goal: 4 });
  assert.equal(result.ok, true);
  assert.equal(result.eta, 4);
  assert.equal(result.required, 14);

  let current = b;
  for (let i = 0; i < result.path.length - 1; i += 1) {
    const from = current.xy(result.path[i]);
    const to = current.xy(result.path[i + 1]);
    const step = previewAttack(current, { kind: 'attack', x: from.x, y: from.y, dx: to.x, dy: to.y, mode: 2 });
    assert.equal(step.ok, true);
    assert.equal(step.captured, true);
    assert.equal(step.send, result.departing - i);
    current = step.after;
  }
  assert.equal(current.owner(result.goal), 1);
  assert.equal(current.kind(result.goal), 'plain');
  assert.equal(current.army[result.goal], result.delivered);
});

test('the search respects a tight ETA cap', () => {
  const b = board([101, 0, 0, 102], [40, 0, 0, 3]);
  assert.equal(bestKill(b, { maxEta: 2 }).ok, false);
  assert.equal(bestKill(b, { maxEta: 3 }).ok, true);
});
