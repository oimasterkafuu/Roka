'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeBoard } = require('../bot/board.cjs');
const { classifyPlan, DEFAULTS, optionsOf, captureFirst } = require('../bot/duel/plan.cjs');

// n x m board; cell index = x * m + y, so a 1 x k board is a simple row.
// `makeBoard` is the same snapshot builder the controller uses, so the
// classifier sees exactly the public shape it will see in a game.
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

test('an immediate kill this tick classifies as finish', () => {
  // 0 our crown 5 - 1 our stack 30 - 2 their crown 10.  The tap is adjacent,
  // so the full push sends 29 and captures the crown's 11 (garrison + growth).
  const b = board([101, 1, 102], [5, 30, 10]);
  const plan = classifyPlan(b);
  assert.equal(plan.kind, 'finish');
  assert.equal(plan.reason, 'finish-immediate');
  assert.equal(plan.kill.ok, true);
  assert.equal(plan.kill.eta, 1);
  assert.equal(plan.goal, 2);
  assert.equal(plan.target, 2);
  assert.equal(plan.diagnostics.gates.finish, true);
  // The classifier is not an executor: no action, no move, no coordinates.
  assert.equal(plan.action, undefined);
  assert.equal(plan.race.ourEta, 1);
});

test('the same board without the army to pay is not a finish', () => {
  // 6 - 1 = 5 which does not beat the crown's 11, and every longer route has to
  // merge through our own 6-army cell and still cannot pay.
  const b = board([101, 1, 102], [5, 6, 10]);
  const plan = classifyPlan(b);
  assert.notEqual(plan.kind, 'finish');
  assert.equal(plan.kind, 'expand');
  assert.equal(plan.kill, null);
  assert.equal(plan.diagnostics.gates.finish, false);
  assert.equal(plan.diagnostics.race.our.ok, false);
});

test('finish is refused when the race is lost', () => {
  // Our crown falls in one tick and our own kill also takes one tick: with the
  // default margin a tie is a loss, so the strike layer would decline and the
  // classifier must defend instead of finishing.
  // 0 our crown 5 - 1 their crown 10 - 2 our stack 30: both kills are adjacent
  // and both pay (29 > 11 and 9 > 6).
  const b = board([101, 102, 1], [5, 10, 30]);
  const tie = classifyPlan(b);
  assert.equal(tie.race.ourEta, 1);
  assert.equal(tie.race.theirEta, 1);
  assert.equal(tie.diagnostics.race.weWinRace, false);
  assert.notEqual(tie.kind, 'finish');
  assert.equal(tie.kind, 'defend');
  assert.equal(tie.target, 0);
});

test('a one-tick inbound kill defends when our route is slower', () => {
  // 0 crown 5, then their 40-army stack next to it; ours is three cells away
  // and cannot pay for their crown at all.  their.eta = 1, our kill = none.
  const b = board([101, 2, 200, 200, 1, 102], [5, 40, 0, 0, 3, 5]);
  const plan = classifyPlan(b);
  assert.equal(plan.kind, 'defend');
  assert.equal(plan.reason, 'defend-threat');
  assert.equal(plan.target, 0, 'the threatened crown is our own');
  assert.equal(plan.goal, null);
  assert.equal(plan.kill, null);
  assert.equal(plan.diagnostics.threat.eta, 1);
  assert.equal(plan.diagnostics.threat.goal, 0);
  assert.equal(plan.diagnostics.gates.defend, true);
});

test('defend respects the defendEta boundary', () => {
  // 0 our crown 5 - 1,2 neutral - 3 their 40-army stack - ... - 6 their crown.
  // Their three-tick route is the threat: it pays our crown's 8 and we have no
  // route at all, so it is answered inside the default window and ignored
  // outside it.  The gate is a window, not a distance heuristic.
  const b = board([101, 200, 200, 2, 200, 200, 102], [5, 0, 0, 40, 0, 0, 5]);
  const inside = classifyPlan(b);
  assert.equal(inside.kind, 'defend');
  assert.equal(inside.diagnostics.threat.eta, 3);
  assert.equal(inside.diagnostics.threat.goal, 0);

  const outside = classifyPlan(b, { defendEta: 2 });
  assert.equal(outside.kind, 'expand');
  assert.equal(outside.reason, 'expand-no-route');
  assert.equal(outside.diagnostics.threat.eta, 3, 'the threat is still reported');

  // defendEta is clamped to one tick so the window cannot be closed by an
  // accidental zero.
  assert.equal(optionsOf({ defendEta: 0 }).defendEta, 1);
});

test('a three-tick clean route that wins the race classifies as attack', () => {
  // Our 60-army stack marches three neutral cells into their 10-army crown
  // (56 delivered against 13).  Their counter-route must capture our 60 and
  // cannot, so the race is ours.
  const b = board([101, 1, 200, 200, 102, 2, 200], [5, 60, 0, 0, 10, 4, 0]);
  const plan = classifyPlan(b);
  assert.equal(plan.kind, 'attack');
  assert.equal(plan.reason, 'attack-clean-route');
  assert.equal(plan.kill.eta, 3);
  assert.equal(plan.goal, 4);
  assert.deepEqual(plan.kill.path, [1, 2, 3, 4]);
  assert.equal(plan.kill.cutRisk.level, 'none');
  assert.equal(plan.diagnostics.race.weWinRace, true);
  assert.equal(plan.diagnostics.gates.attack, true);

  // Tightening attackEta does not make it a finish and dropping it below the
  // route length demotes it to a gather, not to idling.
  assert.equal(classifyPlan(b, { attackEta: 2 }).kind, 'push');
  assert.equal(classifyPlan(b, { attackEta: 2 }).reason, 'push-long-route');
});

test('a long clean route is a push, not an attack', () => {
  // Ten ticks of neutrals: a real route, but crown growth and reinforcement
  // make it a plan rather than a strike.
  const grid = [101, 1, 200, 200, 200, 200, 200, 200, 200, 200, 200, 102];
  const army = [5, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5];
  const b = board(grid, army);
  const plan = classifyPlan(b);
  assert.equal(plan.kind, 'push');
  assert.equal(plan.reason, 'push-long-route');
  assert.equal(plan.kill.eta, 10);
  assert.equal(plan.kill.eta > DEFAULTS.attackEta, true);
  assert.equal(plan.target, plan.kill.goal);
  assert.equal(plan.diagnostics.gates.push, true);
});

test('a relay-first route is a push even when it is short', () => {
  // 0 crown 4 - 1 own 12 - 2 own 12 - 3 their crown 10.  Cell 2 alone sends 11
  // into an 11-garrison crown (not strictly greater), and cell 1's cheap route
  // is 1 - 2 - 3, i.e. it starts by merging into cell 2.  This tick must build,
  // not strike.
  const b = board([101, 1, 1, 102], [4, 12, 12, 10]);
  const plan = classifyPlan(b);
  assert.equal(plan.kill.ok, true);
  assert.deepEqual(plan.kill.path, [1, 2, 3]);
  assert.equal(plan.kill.eta, 2);
  assert.equal(captureFirst(b, plan.kill), false);
  assert.equal(plan.kind, 'push');
  assert.equal(plan.reason, 'push-relay-first');

  // Widening finishEta must not turn a muster into a finish: the relay-first
  // gate is independent of the ETA window (it mirrors `strike.cjs`'s
  // `no-capture` decline).
  const wide = classifyPlan(b, { finishEta: 10 });
  assert.notEqual(wide.kind, 'finish');
  assert.equal(wide.kind, 'push');
  assert.equal(wide.kill.delivered, 10);
});

test('an empty board has nothing to plan and classifies as expand', () => {
  // 3 army on each crown, two neutral cells between: the full push sends 2,
  // pays one guard per capture and arrives with nothing.
  const b = board([101, 200, 200, 102], [3, 0, 0, 3]);
  const plan = classifyPlan(b);
  assert.equal(plan.kind, 'expand');
  assert.equal(plan.reason, 'expand-no-route');
  assert.equal(plan.kill, null);
  assert.equal(plan.goal, null);
  assert.equal(plan.target, null);
  assert.equal(plan.diagnostics.race.our.ok, false);
  assert.equal(plan.diagnostics.race.their.ok, false);
  assert.deepEqual(plan.diagnostics.gates, {
    finish: false,
    defend: false,
    attack: false,
    push: false,
  });
});

test('an isolated tap never produces finish or attack', () => {
  // 0 their crown 3 - 1 our crown 100 - 2 our plain 0.  Cell 1 is our only
  // stack and it is isolated, so it cannot push; the same board without the
  // flag is an immediate finish from cell 1.
  const grid = [102, 101, 1];
  const army = [3, 100, 0];
  const isolated = board(grid, army, { n: 3, m: 1, isolated: [0, 1, 1] });
  const plan = classifyPlan(isolated);
  assert.notEqual(plan.kind, 'finish');
  assert.notEqual(plan.kind, 'attack');
  assert.equal(plan.kind, 'expand');
  assert.equal(plan.diagnostics.race.our.ok, false);
  assert.equal(plan.diagnostics.race.our.reason, 'no-route');

  const open = board(grid, army, { n: 3, m: 1 });
  const live = classifyPlan(open);
  assert.equal(live.kind, 'finish');
  assert.equal(live.kill.tap, 1);
  assert.equal(live.kill.path[1], 0);
});

test('a high cut-risk route never classifies as attack', () => {
  // 0 our crown 30 - 1 corridor 30 - 2 tap 20, enemy 40 at 5 can cut the
  // corridor behind the stack, and their two crowns (6, 7) make this a
  // non-decapitation, so `killpath` refuses the route.  Cell 4 is a mountain:
  // it blocks the enemy's own two-tick kill through it (so the defend gate
  // stays shut) while the pressure BFS that flags the cut still reaches the
  // corridor from cell 5.
  const grid = [101, 1, 1, 200, 201, 2, 102, 102];
  const army = [30, 30, 20, 0, 0, 40, 5, 5];
  const b = board(grid, army, { n: 2, m: 4 });
  const plan = classifyPlan(b);
  assert.notEqual(plan.kind, 'attack');
  assert.notEqual(plan.kind, 'finish');
  assert.equal(plan.kind, 'expand');
  assert.equal(plan.reason, 'expand-cut-risk');
  assert.equal(plan.diagnostics.race.our.reason, 'cut-risk');
  assert.equal(plan.diagnostics.race.our.cutRisk, 'high');

  // Asking for the risky route only makes it *visible*; every gate still
  // requires a clean route, so the classifier cannot be talked into planning on
  // a corridor the route search refused.
  const forced = classifyPlan(b, { allowRiskyCuts: true });
  assert.notEqual(forced.kind, 'attack');
  assert.equal(forced.kind, 'expand');
  assert.equal(forced.reason, 'expand-cut-risk');
  assert.equal(forced.diagnostics.race.our.ok, true);
  assert.equal(forced.diagnostics.race.our.risky, true);
  assert.equal(forced.diagnostics.race.their.ok, false, 'the mountain denies their kill');
});

test('tie-breaks are deterministic', () => {
  // Two equidistant enemy crowns with the same garrison: the lowest goal (and
  // the lowest tap) must win, twice, with no dependence on call order.
  const b = board([102, 2, 1, 2, 102], [5, 0, 50, 0, 5]);
  const first = classifyPlan(b);
  const second = classifyPlan(b);
  assert.deepEqual(first, second);
  assert.equal(first.kill.goal, 0);
  assert.equal(first.kill.tap, 2);

  // Two symmetric taps, one enemy crown: both send 19 over the crown's 4, so
  // the delivered army ties and the lower cell index wins.
  const symmetric = board([1, 102, 1], [20, 3, 20]);
  const plan = classifyPlan(symmetric);
  assert.equal(plan.kill.tap, 0);
  assert.deepEqual(classifyPlan(symmetric), plan);
  assert.equal(plan.kind, 'finish');
});

test('classification is read-only on the snapshot', () => {
  const b = board([101, 1, 102], [5, 30, 10]);
  const grid = b.grid.slice();
  const army = b.army.slice();
  const isolated = b.isolated.slice();
  const fog = b.fog.slice();
  classifyPlan(b);
  classifyPlan(b, { attackEta: 2, allowRiskyCuts: true });
  assert.deepEqual(b.grid, grid);
  assert.deepEqual(b.army, army);
  assert.deepEqual(b.isolated, isolated);
  assert.deepEqual(b.fog, fog);
});

test('missing owner and malformed boards degrade instead of throwing', () => {
  const b = board([101, 1, 102], [5, 30, 10], { playerId: 0 });
  assert.equal(classifyPlan(b).kind, 'expand');
  assert.equal(classifyPlan(b).reason, 'no-owner');
  assert.equal(classifyPlan(null).reason, 'invalid-board');
  assert.equal(classifyPlan({}).reason, 'invalid-board');
});
