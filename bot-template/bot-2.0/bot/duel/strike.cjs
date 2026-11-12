'use strict';

/**
 * "Finish" layer: turn a proven kill route into one concrete action.
 *
 * `killpath.cjs` answers "can this stack reach and take that crown", `race.cjs`
 * answers "do we get there before the opponent kills us".  Neither of them
 * emits a move, so without this adapter a mathematically certain decapitation
 * can still be missed by the heuristic planner (it prefers economy or the
 * nearest frontier and has no notion of tick-exact routes).
 *
 * The layer is deliberately narrow and cheap to reason about:
 *
 *   - it only ever takes the FIRST step of the route, and it re-derives that
 *     step from the live board on every turn, so a blocked or cut route simply
 *     stops producing a strike instead of marching into a stale plan;
 *   - it uses a full push (mode 2), which is exactly the `army - 1` the route
 *     model assumes on the tap;
 *   - `preview` is the authority: a step that is not a legal capture is
 *     dropped, never "repaired".
 *
 * Pure by construction: no memory, no socket, no board mutation (`preview`
 * works on copies).
 */

const { race } = require('./race.cjs');
const { actionCoordinates, preview } = require('../rules.cjs');

// `maxEta: 1` is an immediate finish, not a raid planner: the first hop must
// already capture, so the layer never spends a turn walking a corridor the
// heuristic planner could garrison.  `BOT_DUEL_STRIKE_ETA` can widen it for
// experiments, but the measured 4-tick version lost games.  `margin: 1`
// mirrors `race`'s conservative default until the real tick order is calibrated.
const DEFAULTS = Object.freeze({
  maxEta: 1,
  margin: 1,
  allowRiskyCuts: false,
  decapOnly: false,
});

function bound(value, fallback, min) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, number) : fallback;
}

function decline(reason, duel = null) {
  return { ok: false, reason, action: null, plan: null, race: duel, branch: 'duel-strike' };
}

function hasLocalCrownStrike(board, playerId) {
  for (let at = 0; at < board.size; at += 1) {
    if (!board.own(at) || board.isolated[at]) continue;
    if ((Number(board.army[at]) || 0) <= 1) continue;
    for (const to of board.neighbors(at)) {
      if (board.kind(to) !== 'crown') continue;
      if (!board.enemy(to)) continue;
      // The full push sends army - 1 and must beat the crown's next-tick
      // garrison; `preview` remains the final authority.
      if ((Number(board.army[at]) || 0) - 1 > (Number(board.army[to]) || 0)) return true;
    }
  }
  return false;
}

/**
 * Full diagnostic verdict, always an object.  `chooseKillStrike` is the thin
 * null-returning wrapper used by the controller; tests read `reason` here.
 *
 * Declines, in order:
 *   'no-owner'          no player id on the snapshot
 *   'our-<reason>'      `bestKill` found nothing ('no-goal' | 'no-route' | ...)
 *   'eta-cap'           the cheapest clean route is longer than `maxEta`
 *   'lose-race'/'draw-race'  the opponent's counter-kill lands first
 *   'cut-risk'          the route's corridor can be cut (defence in depth)
 *   'short-path'        malformed plan
 *   'isolated-source'   the tap cannot push (should not happen; re-validated)
 *   'preview-<reason>'  `preview` rejects the step
 *   'no-capture'        the first hop is a friendly relay, not a capture
 *
 * The last one is a real policy: a route that starts by merging into an owned
 * relay cannot be fired as a single "finish" move, because the merged stack is
 * not ours yet.  Such routes are left to the planner's muster logic.
 */
function evaluateStrike(board, input = {}) {
  const maxEta = bound(input.maxEta, DEFAULTS.maxEta, 1);
  const margin = bound(input.margin, DEFAULTS.margin, 0);
  const allowRiskyCuts =
    input.allowRiskyCuts === undefined ? DEFAULTS.allowRiskyCuts : Boolean(input.allowRiskyCuts);
  const decapOnly = input.decapOnly === undefined ? DEFAULTS.decapOnly : Boolean(input.decapOnly);

  const playerId = Number(board?.playerId) || 0;
  if (!playerId || !Number.isFinite(Number(board?.size))) return decline('no-owner');
  // Default radius 1: the finish layer is an immediate tactical move, so a
  // cheap adjacency scan must gate the full race search.  Without this the
  // backward search runs every tick even when no crown is in reach.
  if (maxEta <= 1 && !hasLocalCrownStrike(board, playerId)) return decline('no-local-crown');

  // One call, both sides: `race` runs the backward search for us and for the
  // opponent.  Requiring `weWinRace` is what keeps this layer low risk - a
  // capture that is merely legal but arrives after the opponent's counter-kill
  // is worthless, so the planner keeps that decision.
  const duel = race(board, { playerId, maxEta, margin, allowRiskyCuts });
  const our = duel.our;
  if (!our?.ok) return decline(our?.reason ? `our-${our.reason}` : 'our-no-route', duel);
  if (!(Number.isFinite(our.eta) && our.eta <= maxEta)) return decline('eta-cap', duel);
  if (!duel.weWinRace) return decline(duel.verdict === 'draw-race' ? 'draw-race' : 'lose-race', duel);
  if (decapOnly && !our.decap) return decline('non-decap', duel);
  if (our.cutRisk?.risky) return decline('cut-risk', duel);

  const path = our.path;
  if (!Array.isArray(path) || path.length < 2) return decline('short-path', duel);
  const from = path[0];
  const to = path[1];
  // `bestKill` already filters isolated taps, but the action must never rely on
  // a cell that cannot push, so the invariant is checked again here.
  if (!board.own(from) || board.isolated[from]) return decline('isolated-source', duel);

  const action = actionCoordinates(board, from, to, 2);
  const check = preview(board, action);
  if (!check.ok) return decline(`preview-${check.reason || 'rejected'}`, duel);
  if (!check.captured) return decline('no-capture', duel);

  return { ok: true, reason: 'ok', action, plan: our, race: duel, branch: 'duel-strike' };
}

/**
 * Controller entry point: `{ action, plan, race, branch }` or `null`.
 *
 * `plan` is `race.our` (eta, path, tap, departing, required, delivered, goal,
 * decap, growth, cutRisk) so callers can log the full justification.
 */
function chooseKillStrike(board, options = {}) {
  const verdict = evaluateStrike(board, options);
  if (!verdict.ok) return null;
  return { action: verdict.action, plan: verdict.plan, race: verdict.race, branch: verdict.branch };
}

module.exports = { DEFAULTS, evaluateStrike, chooseKillStrike };
