'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeBoard } = require('../bot/board.cjs');
const { preview } = require('../bot/rules.cjs');
const { chooseKillStrike, evaluateStrike, DEFAULTS } = require('../bot/duel/strike.cjs');
const { createController } = require('../bot/controller.cjs');

// Roka cell encoding: plain = owner, city = 50 + owner, crown = 100 + owner,
// 200 = neutral plain.  Index = x * m + y, so a 1 x k frame is a row.
function board(grid, army, options = {}) {
  const n = options.n ?? 1;
  const m = options.m ?? grid.length / n;
  const size = n * m;
  return makeBoard(
    {
      n,
      m,
      grid,
      army,
      isolated: options.isolated || Array(size).fill(0),
      fog: options.fog || Array(size).fill(0),
      turn: options.turn ?? 0,
      leaderboard: [
        { id: 1, team: 1 },
        { id: 2, team: 2 },
      ],
    },
    options.playerId ?? 1,
  );
}

function frame(grid, army, n, m, turn = 60) {
  return {
    n,
    m,
    grid,
    army,
    isolated: Array(n * m).fill(0),
    fog: Array(n * m).fill(0),
    turn,
    leaderboard: [
      { id: 1, team: 1 },
      { id: 2, team: 2 },
    ],
  };
}

test('the finish layer is on by default and short-ranged', () => {
  assert.deepEqual({ ...DEFAULTS }, { maxEta: 4, margin: 1, allowRiskyCuts: false });
});

test('an adjacent last-crown kill becomes one mode-2 strike that preview confirms', () => {
  // Crown -> enemy crown: eta 1, and the tap is the only legal source.
  const b = board([101, 102], [8, 5]);
  const strike = chooseKillStrike(b);
  assert.ok(strike);
  assert.equal(strike.branch, 'duel-strike');
  assert.deepEqual(strike.action, { kind: 'attack', x: 0, y: 0, dx: 0, dy: 1, mode: 2, half: false });
  // The action is the first hop of the proven route and a full push.
  assert.equal(strike.plan.eta, 1);
  assert.equal(strike.plan.decap, true);
  assert.deepEqual(strike.plan.path, [0, 1]);
  assert.equal(strike.action.mode, 2);
  const check = preview(b, strike.action);
  assert.equal(check.ok, true);
  assert.equal(check.captured, true);
  assert.equal(check.decap, true);
  assert.equal(check.send, strike.plan.departing);
});

test('a clean kill that arrives after the opponent counter-kill is declined', () => {
  // Our plain at 4 needs two ticks for their crown at 6; their plain at 1 is
  // already next to our last crown and kills in one tick, so the capture is
  // real but worthless.
  const b = board([101, 2, 200, 200, 1, 200, 102], [30, 40, 0, 0, 25, 0, 4]);
  assert.equal(evaluateStrike(b).reason, 'lose-race');
  assert.equal(chooseKillStrike(b), null);
});

test('maxEta caps the finish radius', () => {
  // Three-tick route through two neutrals; no opponent counter-kill exists, so
  // only the radius decides.
  const capped = () => board([101, 200, 200, 102], [30, 0, 0, 5]);
  const long = evaluateStrike(capped(), { maxEta: 2, margin: 0 });
  assert.equal(long.ok, false);
  assert.equal(chooseKillStrike(capped(), { maxEta: 2, margin: 0 }), null);
  // `bestKill` truncates its own search at the same cap, hence the inner
  // failure reason; the explicit `eta-cap` check is defence in depth.
  assert.equal(long.reason, 'our-no-route');

  const allowed = chooseKillStrike(capped(), { maxEta: 3, margin: 0 });
  assert.ok(allowed);
  assert.equal(allowed.plan.eta, 3);
  assert.deepEqual(allowed.action, { kind: 'attack', x: 0, y: 0, dx: 0, dy: 1, mode: 2, half: false });
});

test('an isolated stack is never the tap and an isolated-only route is no strike', () => {
  // The 100-strong isolated crown at 0 would be the obvious source, but the
  // route must start on the connected plain at 2.
  const b = board([101, 102, 1], [100, 3, 20], { n: 3, m: 1, isolated: [1, 0, 0] });
  const strike = chooseKillStrike(b);
  assert.ok(strike);
  assert.equal(strike.plan.tap, 2);
  assert.deepEqual(strike.action, { kind: 'attack', x: 2, y: 0, dx: 1, dy: 0, mode: 2, half: false });
  assert.equal(b.isolated[2], 0);

  // Only an isolated stack exists, so no strike - `preview` would reject the
  // source anyway, and the layer declines before it builds an action.
  const stuck = board([1, 102], [100, 5], { n: 2, m: 1, isolated: [1, 0] });
  const verdict = evaluateStrike(stuck);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.action, null);
  assert.equal(chooseKillStrike(stuck), null);
});

test('the first hop must capture, so a relay-first route is left to the planner', () => {
  // Best route is crown 0 -> own plain 1 (relay) -> own plain 2 -> crown 3.
  // A friendly transfer is not a "finish" move: the layer refuses and the
  // muster logic of the planner keeps ownership of that route.
  const b = board([101, 1, 1, 102], [7, 0, 12, 12]);
  const verdict = evaluateStrike(b);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'no-capture');
  assert.equal(verdict.race.weWinRace, true);
  assert.equal(chooseKillStrike(b), null);
});

test('a multi-crown capture is only taken when the race is won', () => {
  // Two enemy crowns: taking one is not a decapitation, so it is treated as an
  // ordinary raid and must win the race.  Here the enemy cannot counter-kill.
  const win = chooseKillStrike(board([101, 200, 102, 102], [30, 0, 5, 5]));
  assert.ok(win);
  assert.equal(win.plan.decap, false);
  assert.equal(win.race.weWinRace, true);
  assert.equal(preview(board([101, 200, 102, 102], [30, 0, 5, 5]), win.action).captured, true);

  // Identical plan, but the enemy plain at 1 kills our last crown in one tick.
  const lose = board([101, 2, 1, 200, 200, 102, 200, 200, 102], [30, 60, 25, 0, 0, 5, 0, 0, 5], {
    n: 3,
    m: 3,
  });
  const verdict = evaluateStrike(lose);
  assert.equal(verdict.reason, 'lose-race');
  assert.equal(verdict.race.ourEta, 1);
  assert.equal(verdict.race.theirEta, 1);
  assert.equal(chooseKillStrike(lose), null);
});

test('no legal kill returns null', () => {
  // Both crowns are too small to break a neighbour: parity on the board.
  const b = board([101, 200, 102], [2, 0, 2]);
  const verdict = evaluateStrike(b);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.action, null);
  assert.equal(verdict.reason, 'our-no-route');
});

test('the controller takes the strike by default and keeps the planner path when disabled', () => {
  // Crown 60 + two plains 20 march four ticks; the planner would spend the
  // turn on its march cursor, the finish layer takes the first hop instead.
  const strikeable = () =>
    frame(
      [101, 1, 1, 2, 102, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200],
      [60, 20, 20, 1, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      3,
      5,
    );

  const off = createController(1, { duelStrike: false });
  const offAction = off.choose(strikeable());
  assert.ok(offAction);
  assert.equal(preview(makeBoard(strikeable(), 1), offAction).ok, true);
  // Flag off means the strike candidate is never consulted: planner branches
  // only, no strike bookkeeping.
  assert.notEqual(off.stats().branch, 'duel-strike');
  assert.equal(off.stats().strikes, 0);
  assert.equal(off.stats().byBranch['duel-strike'], undefined);

  // The planner-only decision is deterministic on this fixture.
  const offAgain = createController(1, { duelStrike: false }).choose(strikeable());
  assert.deepEqual(offAgain, offAction);

  const on = createController(1);
  const onAction = on.choose(strikeable());
  assert.equal(on.stats().branch, 'duel-strike');
  assert.equal(on.stats().strikes, 1);
  assert.equal(on.stats().byBranch['duel-strike'], 1);
  assert.equal(on.stats().lastStrike.eta, 2);
  assert.equal(on.stats().lastStrike.decap, true);
  assert.deepEqual(onAction, { kind: 'attack', x: 0, y: 2, dx: 0, dy: 3, mode: 2, half: false });
  assert.notDeepEqual(onAction, offAction);
});
