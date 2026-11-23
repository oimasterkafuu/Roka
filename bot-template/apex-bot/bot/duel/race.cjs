'use strict';

/**
 * Kill-race estimate: our fastest crown capture versus the opponent's fastest
 * crown capture, using the same backward search with the sides flipped.
 *
 * Both searches read exactly the board snapshot the bot already owns.  Under
 * fog the opponent's hidden cells report owner 0 / army 0, so their tap list
 * shrinks to what is actually visible; no hidden information is reconstructed.
 */

const { bestKill } = require('./killpath.cjs');

const DEFAULT_MARGIN = 1;

// Most frequent visible non-team owner.  Ties go to the lowest player id so the
// estimate is deterministic for symmetric boards.
function pickOpponent(board, owner) {
  const counts = new Map();
  for (let at = 0; at < board.size; at += 1) {
    const cellOwner = board.owner(at);
    if (!cellOwner || cellOwner === owner || board.sameTeam(owner, cellOwner)) continue;
    counts.set(cellOwner, (counts.get(cellOwner) || 0) + 1);
  }
  let best = 0;
  let bestCount = -1;
  for (const [id, count] of counts) {
    if (count > bestCount || (count === bestCount && id < best)) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Options:
 *   playerId      our side (default board.playerId)
 *   opponentId    explicit opponent; otherwise the largest visible enemy
 *   margin        ticks of head start required to call the race (default 1)
 *   goal          our target cell forwarded to bestKill
 *   theirGoal     opponent target; defaults to every visible crown of ours
 *   everything else is forwarded to bestKill (allowRiskyCuts, maxEta, ...)
 *
 * `weWinRace` means: we have a kill and either the opponent has none, or our
 * ETA plus `margin` is not later than theirs.  The default margin of one tick
 * is a placeholder for Roka's real resolution order (whoever queues first in a
 * tick, server latency, 0.5 s base tick at speed 1); it must be calibrated
 * against live games or engine replays before it is trusted for a real raid.
 */
function race(board, input = {}) {
  const playerId = Number(input.playerId ?? board.playerId) || 0;
  const margin = Number.isFinite(input.margin) ? Math.max(0, input.margin) : DEFAULT_MARGIN;
  const shared = { ...input };
  delete shared.margin;
  // `bestKill` resolves its side from `owner ?? playerId`; strip the side keys
  // so the explicit playerId below always wins for both searches.
  delete shared.owner;
  delete shared.playerId;
  delete shared.opponentId;
  delete shared.goal;
  delete shared.theirGoal;

  const our = playerId > 0
    ? bestKill(board, { ...shared, playerId })
    : { ok: false, reason: 'no-owner', eta: Infinity, delivered: 0, cutRisk: { level: 'none', risky: false } };

  const opponentId = Number.isFinite(input.opponentId) ? input.opponentId : pickOpponent(board, playerId);
  const theirOptions = { ...shared, playerId: opponentId, allowRiskyCuts: true };
  delete theirOptions.goal;
  if (Number.isInteger(input.theirGoal)) theirOptions.goal = input.theirGoal;
  const their = opponentId > 0
    ? bestKill(board, theirOptions)
    : { ok: false, reason: 'no-opponent', eta: Infinity, delivered: 0, cutRisk: { level: 'none', risky: false } };

  const ourEta = our.ok ? our.eta : null;
  const theirEta = their.ok ? their.eta : null;
  const weWinRace = Boolean(our.ok) && (!their.ok || ourEta + margin <= theirEta);

  let verdict = 'stable';
  if (weWinRace) verdict = 'win-race';
  else if (their.ok && (!our.ok || theirEta < ourEta + margin)) verdict = 'lose-race';
  else if (our.ok) verdict = 'draw-race';

  return {
    ok: Boolean(our.ok || their.ok),
    weWinRace,
    margin,
    playerId,
    opponentId,
    ourEta,
    theirEta,
    verdict,
    our,
    their,
  };
}

module.exports = { race, pickOpponent, DEFAULT_MARGIN };
