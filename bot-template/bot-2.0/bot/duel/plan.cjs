'use strict';

/**
 * Pure macro plan classifier for 1v1 (PolyGen v5 duel planner shape, Roka rules).
 *
 * The classifier answers one question per tick: *which win-condition is the
 * board in right now*?  It does not move anything, it does not remember
 * anything between ticks, and it never writes to the snapshot it is given.  It
 * exists so a future controller can pick between the layers that already
 * exist (`strike.cjs` for the action, `planner.cjs` for the heuristics) from a
 * single ordered decision instead of from whichever local rule fires first.
 *
 * Order (each gate is a *fall-through*, never a rewrite of a lower gate):
 *
 *   1. finish  an enemy crown falls this tick, and the race does not lose.
 *   2. defend  an enemy route reaches one of our crowns within `defendEta`
 *              ticks and is not slower than ours.
 *   3. attack  a clean route reaches an enemy crown within `attackEta` ticks
 *              and we win the race (or the opponent has no kill at all).
 *   4. push    a clean route exists but is too long, starts with a friendly
 *              relay, or delivers too thin a surplus to be called an attack -
 *              provided the target really is an enemy crown.
 *   5. expand  everything else.
 *
 * Why this order (and not "gather first"): PolyGen measured moving the gather
 * arm above the prepared defence and reverted it (1v1 57.75 %, -2.1 pp).  A
 * split push that ignores an inbound stack loses to a crown that falls one
 * tick earlier, so every "build now" arm is strictly below survival.  The same
 * argument holds in Roka, where the losing side of a race does not merely lose
 * a crown, it loses the game.
 *
 * Why no `city` step (PolyGen has one): Roka's capture rule is strictly
 * greater and every extra capture costs a guard, and the economy arm already
 * lives in `planner.cjs`.  A classifier that recommended a city would have to
 * price neutral garrisons with the same backward search - that is the
 * `push` arm's job here, with the crown as its target.
 *
 * Read-only contract: only the public board snapshot (`makeBoard` output) is
 * read.  `killpath.cjs` caches its cut analysis per board object in a
 * `WeakMap`; that cache is an implementation detail of `board.cjs` and does
 * not touch the board.  Fog is never guessed: hidden cells report owner 0 and
 * the route search simply cannot use them, so a fogged crown never becomes a
 * target.
 */

const { bestKill } = require('./killpath.cjs');
const { race } = require('./race.cjs');

/**
 * Gate defaults.  `finishEta: 1` mirrors `strike.cjs` (an immediate finish, not
 * a raid).  `defendEta: 3` is the shortest window in which an inbound route is
 * still worth answering: the enemy needs at least `their.eta` ticks, so a
 * one-tick threat cannot be intercepted from anywhere but an adjacent cell.
 * `attackEta: 6` is roughly the march a real stack can still pay for before
 * the crown growth outruns it.  `margin: 1` mirrors `race.cjs`'s conservative
 * default (a tie is a loss).  `attackSurplus: 1` means an attack must leave at
 * least one army on the captured crown - a route that lands exactly on zero
 * ("we take it and immediately lose it back") is a push, not an attack.
 */
const DEFAULTS = Object.freeze({
  finishEta: 1,
  defendEta: 3,
  attackEta: 6,
  maxEta: 240,
  margin: 1,
  attackSurplus: 1,
  allowRiskyCuts: false,
});

function bound(value, fallback, min) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, number) : fallback;
}

/**
 * Normalised options.  `playerId`/`opponentId` are `null` when the caller did
 * not override the snapshot (the race then uses `board.playerId` and the
 * largest visible enemy, exactly as `race.cjs` does on its own).
 *
 * `maxEta` is the *search window* for both sides and must be at least
 * `attackEta`, otherwise the attack gate can never fire; it is not widened
 * silently because that would hide a caller's real budget.
 */
function optionsOf(input = {}) {
  const source = input || {};
  const attackEta = source.attackEta;
  return {
    playerId: Number.isInteger(source.playerId) ? source.playerId : null,
    opponentId: Number.isInteger(source.opponentId) ? source.opponentId : null,
    goal: Number.isInteger(source.goal) ? source.goal : null,
    finishEta: bound(source.finishEta, DEFAULTS.finishEta, 1),
    defendEta: bound(source.defendEta, DEFAULTS.defendEta, 1),
    attackEta: bound(attackEta, DEFAULTS.attackEta, 1),
    maxEta: bound(source.maxEta, DEFAULTS.maxEta, 1),
    margin: bound(source.margin, DEFAULTS.margin, 0),
    attackSurplus: bound(source.attackSurplus, DEFAULTS.attackSurplus, 0),
    allowRiskyCuts:
      source.allowRiskyCuts === undefined ? DEFAULTS.allowRiskyCuts : Boolean(source.allowRiskyCuts),
  };
}

function isBoard(board) {
  return Boolean(
    board &&
    Number.isFinite(Number(board.size)) &&
    typeof board.owner === 'function' &&
    typeof board.kind === 'function' &&
    typeof board.own === 'function' &&
    typeof board.sameTeam === 'function',
  );
}

/**
 * Does this route's first hop land on a cell that is not ours?
 *
 * `strike.cjs` refuses a route that begins by merging into an owned relay
 * (`no-capture`): merging is not a capture, the action would be a muster, and
 * the merged stack is not ours until the next tick.  A macro classifier has
 * the same asymmetry - a relay-first route *builds* the stack the attack will
 * eventually need - so it is a `push`, never a `finish`/`attack`.  The tap is
 * re-checked for `own`/`isolated` because `killpath` skips isolated taps and
 * the invariant must not depend on that filter staying in place.
 */
function captureFirst(board, kill) {
  const path = kill?.path;
  if (!Array.isArray(path) || path.length < 2) return false;
  const from = path[0];
  const to = path[1];
  if (!board.own(from) || board.isolated[from]) return false;
  const nextOwner = board.owner(to);
  return !(nextOwner > 0 && board.sameTeam(board.owner(from), nextOwner));
}

/**
 * "Clean" = proven feasible *and* not flagged by the corridor check.
 *
 * Roka's defining constraint is ownership connectivity: an advancing stack can
 * be cut off behind itself, at which point the cells it captured lose their
 * anchor, become isolated and cannot push again.  `killpath.cjs` already
 * re-derives that risk per route (`cutRisk.level === 'high'` means an enemy
 * stack can reach a corridor cell before the strike lands), so this classifier
 * never re-implements the arithmetic - it only refuses to build a plan on a
 * route the route search itself would not recommend.  A decapitation route is
 * reported as `level: 'none'` by `killpath` because the game ends before any
 * cut can matter, so the game-winning case is not filtered out here either.
 */
function cleanRoute(kill) {
  return Boolean(kill?.ok) && !kill.cutRisk?.risky;
}

/**
 * A real crown: visible, enemy-owned, and actually a crown.
 *
 * `killpath` targets enemy crowns by default, but `options.goal` may point at
 * any cell.  Pushing toward a plain or toward a neutral crown is a different
 * plan (expansion / neutral contest), so the push gate validates the target
 * instead of trusting the caller's goal.
 */
function realCrown(board, at) {
  return (
    Number.isInteger(at) &&
    at >= 0 &&
    at < board.size &&
    Boolean(board.visible[at]) &&
    board.kind(at) === 'crown' &&
    typeof board.enemy === 'function' &&
    board.enemy(at)
  );
}

function relayFirstOf(board, kill, owner) {
  const path = kill?.path;
  if (!Array.isArray(path) || path.length < 2) return false;
  const nextOwner = board.owner(path[1]);
  return nextOwner > 0 && board.sameTeam(owner, nextOwner);
}

/**
 * Stable, JSON-friendly summary of one `bestKill` result.  Kept separate from
 * the raw record so diagnostics stay printable and comparable, and so tests
 * can assert on a small shape instead of on the whole search state.
 */
function routeSummary(board, kill, owner) {
  if (!kill) return null;
  return {
    ok: Boolean(kill.ok),
    reason: kill.reason ?? null,
    eta: Number.isFinite(kill.eta) ? kill.eta : null,
    goal: Number.isInteger(kill.goal) ? kill.goal : null,
    tap: Number.isInteger(kill.tap) ? kill.tap : null,
    departing: Number(kill.departing) || 0,
    required: Number(kill.required) || 0,
    delivered: Number(kill.delivered) || 0,
    decap: Boolean(kill.decap),
    cutRisk: kill.cutRisk?.level ?? 'none',
    risky: Boolean(kill.cutRisk?.risky),
    relayFirst: relayFirstOf(board, kill, owner),
    path: Array.isArray(kill.path) ? kill.path.slice() : null,
  };
}

function verdict(kind, reason, extra = {}) {
  return { kind, reason, kill: null, race: null, goal: null, target: null, diagnostics: {}, ...extra };
}

/**
 * Classify the macro plan for the given snapshot.
 *
 * Options (all optional, pure):
 *   playerId       our side (default `board.playerId`)
 *   opponentId     explicit opponent id (default: largest visible enemy)
 *   goal           explicit target cell forwarded to the route search
 *   finishEta      immediate-finish window (1)
 *   defendEta      inbound-threat window in ticks (3)
 *   attackEta      attack march window in ticks (6)
 *   maxEta         route search window for both sides (240)
 *   margin         ticks of head start required to call the race (1)
 *   attackSurplus  army that must remain on the captured crown (1)
 *   allowRiskyCuts forwarded to `bestKill` so a refused route is *visible* in
 *                  diagnostics; the classifier still never plans on it
 *
 * Returns `{ kind, reason, kill, race, goal, target, diagnostics }` where
 * `diagnostics.gates` records which gate was opened and which was not, and
 * `diagnostics.race.our` / `.their` are `routeSummary` objects.  `kill` is the
 * route the plan commits to (`null` for `defend`/`expand`), `goal` is that
 * route's target crown, and `target` is the cell the plan is about (our
 * threatened crown for `defend`).
 */
function classifyPlan(board, input = {}) {
  if (!isBoard(board)) return verdict('expand', 'invalid-board');
  const options = optionsOf(input);
  const owner = Number(options.playerId ?? board.playerId) || 0;
  if (!owner) return verdict('expand', 'no-owner');

  // One race call prices both sides with the same backward search: `our` is
  // the fastest crown we can deliver, `their` the fastest crown the opponent
  // can deliver.  Under fog the opponent's hidden cells are owner 0, so
  // `their` collapses to what is actually visible - no hidden route is
  // invented, which is exactly what the wire format allows.
  const duel = race(board, {
    playerId: owner,
    ...(options.opponentId === null ? {} : { opponentId: options.opponentId }),
    ...(options.goal === null ? {} : { goal: options.goal }),
    maxEta: options.maxEta,
    margin: options.margin,
    allowRiskyCuts: options.allowRiskyCuts,
  });
  const our = duel.our;
  const their = duel.their;
  const ourClean = cleanRoute(our);
  const ourCaptureFirst = captureFirst(board, our);
  const theirThreat =
    their && their.ok && Number.isFinite(their.eta)
      ? {
          goal: Number.isInteger(their.goal) ? their.goal : null,
          eta: their.eta,
          tap: Number.isInteger(their.tap) ? their.tap : null,
          decap: Boolean(their.decap),
          cutRisk: their.cutRisk?.level ?? 'none',
        }
      : null;

  const diagnostics = {
    owner,
    opponentId: duel.opponentId,
    options: {
      finishEta: options.finishEta,
      defendEta: options.defendEta,
      attackEta: options.attackEta,
      maxEta: options.maxEta,
      margin: options.margin,
      attackSurplus: options.attackSurplus,
      allowRiskyCuts: options.allowRiskyCuts,
      goal: options.goal,
    },
    race: {
      verdict: duel.verdict,
      weWinRace: Boolean(duel.weWinRace),
      ourEta: duel.ourEta,
      theirEta: duel.theirEta,
      our: routeSummary(board, our, owner),
      their: routeSummary(board, their, duel.opponentId || owner),
    },
    gates: { finish: false, defend: false, attack: false, push: false },
    threat: theirThreat,
  };

  // Gate 1 - finish.  An immediate capture exists (`our.eta <= finishEta`,
  // `bestKill` is exact for the path so the first hop is a real capture) and
  // the race is not lost.  `weWinRace` is deliberately the same predicate
  // `strike.cjs` uses, so the classifier can never recommend a finish the
  // executor would refuse: same margin, same verdict, same cut filter.  The
  // executor still owns the action - this layer only names the plan.
  if (
    ourClean &&
    ourCaptureFirst &&
    Number.isFinite(our.eta) &&
    our.eta <= options.finishEta &&
    duel.weWinRace
  ) {
    diagnostics.gates.finish = true;
    return verdict('finish', 'finish-immediate', {
      kill: our,
      race: duel,
      goal: our.goal,
      target: our.goal,
      diagnostics,
    });
  }

  // Gate 2 - defend.  The opponent has a credible route to one of our crowns
  // and it is not slower than ours: `their.eta <= our.eta` when we have a
  // route at all.  Both sides use the same search, so that comparison is a
  // real race of two arrivals rather than two unrelated distances.  `margin`
  // can only make the race stricter, never looser: with the default margin of
  // one tick, `their.eta <= our.eta` is exactly `!weWinRace`.
  //
  // Deliberately conservative in both directions:
  //   - the opponent's route is *not* required to be clean.  A high cut risk
  //     makes their plan less likely to land, and answering a threat that does
  //     not materialise costs one gather turn, while ignoring one that does
  //     costs the game.  `diagnostics.threat.cutRisk` records the level so a
  //     future caller can price it.
  //   - an isolated enemy source is already filtered by `killpath` (a cell
  //     that cannot push is never a tap), so a threat reported here is a
  //     threat from a cell that can actually move.
  // The threat is also required to be inside `defendEta`: an enemy kill five
  // ticks out is not a reason to stop expanding, it is a reason to keep the
  // crown garrisoned, which the planner's reserve already does.
  const theirFaster = !their?.ok ? false : !our?.ok || their.eta <= our.eta;
  if (their?.ok && Number.isFinite(their.eta) && their.eta <= options.defendEta && theirFaster) {
    diagnostics.gates.defend = true;
    return verdict('defend', 'defend-threat', {
      race: duel,
      target: Number.isInteger(their.goal) ? their.goal : null,
      diagnostics,
    });
  }

  // Gate 3 - attack.  A clean route inside `attackEta` that is not merely legal
  // but won: `weWinRace` (or the opponent has no kill at all, which
  // `weWinRace` already implies when we have a route).  The extra gates are
  // what separate a macro *attack* from a gather:
  //   - `ourCaptureFirst`: the first hop must capture, not merge into a relay;
  //   - `delivered >= attackSurplus`: an attack leaves a stack on the crown,
  //     a zero-surplus capture is a trade and belongs to the push arm.
  if (
    ourClean &&
    ourCaptureFirst &&
    Number.isFinite(our.eta) &&
    our.eta <= options.attackEta &&
    Number(our.delivered) >= options.attackSurplus &&
    (duel.weWinRace || !their?.ok)
  ) {
    diagnostics.gates.attack = true;
    return verdict('attack', 'attack-clean-route', {
      kill: our,
      race: duel,
      goal: our.goal,
      target: our.goal,
      diagnostics,
    });
  }

  // Gate 4 - push.  The route exists and is clean, but it is not an attack
  // yet.  Three independent reasons, checked in a fixed order so the reported
  // reason is deterministic:
  //   'push-relay-first'   the route starts by merging, so this tick builds
  //                        the stack instead of spending it;
  //   'push-long-route'    the march is longer than `attackEta`, i.e. crown
  //                        growth and enemy reinforcement make it a plan, not
  //                        a strike;
  //   'push-thin-delivery' less than `attackSurplus` survives the capture;
  //   'push-lose-race'     the route is attackable but the opponent's kill
  //                        lands first: keep staging, do not commit.
  // The target must be a *real* enemy crown and the route must not be flagged
  // by the corridor check - a push along a corridor that can be cut strands the
  // very stack the push exists to build.
  if (ourClean && realCrown(board, our.goal)) {
    let reason = null;
    if (!ourCaptureFirst) reason = 'push-relay-first';
    else if (Number(our.eta) > options.attackEta) reason = 'push-long-route';
    else if (Number(our.delivered) < options.attackSurplus) reason = 'push-thin-delivery';
    else if (!(duel.weWinRace || !their?.ok)) reason = 'push-lose-race';
    if (reason) {
      diagnostics.gates.push = true;
      return verdict('push', reason, {
        kill: our,
        race: duel,
        goal: our.goal,
        target: our.goal,
        diagnostics,
      });
    }
  }

  // Gate 5 - expand.  Nothing is worth committing to.  The reason is derived
  // from the route search's own verdict so the taxonomy stays closed:
  //   'expand-no-route' / 'expand-no-goal' / 'expand-goal-owned'
  //   'expand-cut-risk'  a route exists but only through a cuttable corridor
  //   'expand-not-a-crown'  a clean route to a non-crown target (explicit goal)
  let reason;
  if (ourClean && !realCrown(board, our.goal)) reason = 'expand-not-a-crown';
  else if (our?.ok && !ourClean) reason = 'expand-cut-risk';
  else reason = `expand-${our?.reason || 'no-route'}`;
  return verdict('expand', reason, { race: duel, diagnostics });
}

module.exports = {
  DEFAULTS,
  optionsOf,
  captureFirst,
  cleanRoute,
  realCrown,
  routeSummary,
  classifyPlan,
};
