'use strict';

// Campaign last-mile ledger and attack-phase state machine.
//
// Measurement (eight anti games at 0.68, 2400 ticks) showed the campaign
// owning 6592 ticks: `march` 4437 (67%), `muster*` only 1045 (16%). One crown
// campaign ran 564 ticks with 551 no-progress ticks after feeding 13.7k army,
// and convoys need 8-10 ticks to land at the root. A second sample traced the
// shape of the loop: the campaign is created ~31 times per lost game, each
// approach is 40+ cells long (`march` at distance 41+: 879 of 1399 ticks), the
// column only spends ~10-30 ticks at short range and then dies, after which the
// next campaign restarts from the rear. The leak is therefore the attack phase
// and the last mile, not muster gating.
//
// This module owns one coherent last-mile decision per campaign crown. In the
// default `reseat` mode it only records the ledger (distance, first-contact
// requirement, ticks without distance/army progress) and recovers a dead or cut
// column forward. The optional `full` mode adds the attack-phase states:
//
//   approach - far from the crown; keep the existing march/gather behaviour.
//   stage    - inside the last-mile range but the next hostile cell is not
//              payable yet. Hold the column and top it up to the bounded
//              requirement instead of feeding a partial push that dies on the
//              second hostile cell.
//   commit   - the requirement is met; push every tick without dropping back to
//              a fresh muster in the middle of the last mile.
//   reroute  - staging stopped making progress, so give up this corridor
//              (or crown) instead of holding the same stack forever.
//
// Both staging profiles (whole path and first contact) measured negative on the
// official profile and stay behind the flag; only the forward reseat is a net
// improvement, and only on large rooms.
//
// The ledger is keyed by the campaign crown so a deliberate reseat of the
// rally root keeps the measured progress, and `reseatRoot` below recovers a dead
// or cut column from the best forward supply cell instead of letting the
// campaign restart at distance 40+.
//
// Everything is gated behind APEX_LAST_MILE=1 and defaults to off. When the flag
// is off this module is never consulted and the planner is byte-identical to
// the previous behaviour.

const DEFAULT_RANGE = 6;
const DEFAULT_MARGIN = 0.15;
const DEFAULT_MIN_MARGIN = 6;
const DEFAULT_MAX_MARGIN = 28;
const DEFAULT_STAGE_TIMEOUT = 24;
const DEFAULT_RESEAT_SLACK = 8;
const DEFAULT_ARMY_JUMP = 3;
const DEFAULT_MIN_BOARD = 800;

function number(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function flag(raw, fallback = false) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = String(raw).trim();
  return value !== '0' && value !== 'false' && value !== 'off';
}

// Read from the environment on every call so tests and A/B runs can toggle the
// layer without reloading the planner. The parse cost is a handful of Number
// calls per campaign decision.
function lastMileConfig(overrides = {}, env = process.env) {
  return {
    enabled: overrides.enabled ?? flag(env.APEX_LAST_MILE, false),
    range: overrides.range ?? number(env.APEX_LAST_MILE_RANGE, DEFAULT_RANGE, 2, 12),
    margin: overrides.margin ?? number(env.APEX_LAST_MILE_MARGIN, DEFAULT_MARGIN, 0, 1),
    minMargin: overrides.minMargin ?? DEFAULT_MIN_MARGIN,
    maxMargin: overrides.maxMargin ?? DEFAULT_MAX_MARGIN,
    stageTimeout: overrides.stageTimeout ??
      number(env.APEX_LAST_MILE_STAGE_TIMEOUT, DEFAULT_STAGE_TIMEOUT, 4, 120),
    reseatSlack: overrides.reseatSlack ?? number(env.APEX_LAST_MILE_RESEAT, DEFAULT_RESEAT_SLACK, 0, 40),
    armyJump: overrides.armyJump ?? DEFAULT_ARMY_JUMP,
    targetMode: overrides.targetMode ??
      (String(env.APEX_LAST_MILE_TARGET || 'first').trim() === 'path' ? 'path' : 'first'),
    // 'reseat' (default) only recovers a dead or cut column from the best
    // forward supply cell; 'full' additionally runs staging, commit and
    // reroute. The full state machine measured negative on both opponents and
    // is kept behind the flag for reproducible A/B runs.
    mode: overrides.mode ??
      (String(env.APEX_LAST_MILE_MODE || 'reseat').trim() === 'full' ? 'full' : 'reseat'),
    // Long-approach recovery only exists on large rooms: on a 0.34 board the
    // whole map is barely two screens, so a "restart from distance 40+" cannot
    // happen and a reseat only swaps one local root for a weaker one.
    minBoardSize: overrides.minBoardSize ??
      number(env.APEX_LAST_MILE_MIN_BOARD, DEFAULT_MIN_BOARD, 0, 10000),
  };
}

// Bounded top-up margin. A flat percentage punishes a small last-mile path (a
// 30-unit crown would require 35) and a flat constant punishes a big one, so
// the margin is the percentage clamped to [minMargin, maxMargin].
function boundedMargin(need, config) {
  const raw = Math.round((Number(need) || 0) * config.margin);
  return Math.max(config.minMargin, Math.min(config.maxMargin, raw));
}

// Force the column must reach before it may attack.
//
// Two profiles are supported. `first` (default) prices only the next hostile
// cell, so the column starts pushing as soon as its first contact is payable
// and the commitment below keeps it pushing; `path` prices the whole remaining
// path in one shot (measured negative on both opponents: it converted losses
// into draws but delayed wins, 29/16/19 against anti and 34/5/25 against apex).
function lastMileNeed(resistance, firstNeed, cap, config) {
  const first = Math.max(18, Number(firstNeed) || 0);
  const base = config?.targetMode === 'path'
    ? Math.max(first, Number(resistance) || 0)
    : first;
  const need = base + boundedMargin(base, config);
  // The urgency cap keeps a single crown from demanding the whole empire, but
  // never below the force the first hostile cell already requires.
  if (!(Number.isFinite(cap) && cap > 0)) return need;
  return Math.max(first, Math.min(need, cap));
}

function freshLedger(crown, dist, army, turn) {
  return {
    crown,
    bestDist: dist,
    prevArmy: army,
    lastProgress: turn,
    committed: false,
    commits: 0,
    reroutes: 0,
    reseats: 0,
  };
}

// Pure state transition. `info` carries the numbers the planner already
// computed for this tick: own column distance to the crown, the column army,
// the first hostile cell's requirement, and the whole-path requirement.
// Returns the state plus the ledger that the caller stores on the campaign.
function lastMileState(input) {
  const {
    board, campaign, dist, army, firstNeed, pathNeed,
    config = lastMileConfig(),
  } = input;
  const numericDist = Number(dist);
  const numericArmy = Math.max(0, Number(army) || 0);
  const turn = Number(board?.turn) || 0;
  const fallback = plain(input, config);
  if (!config.enabled) {
    return { enabled: false, state: 'approach', dist: numericDist, army: numericArmy, ...fallback };
  }
  if (!Number.isFinite(numericDist) || !campaign || !Number.isInteger(campaign.crown)) {
    return { enabled: true, state: 'approach', dist: numericDist, army: numericArmy, ...fallback };
  }
  let ledger = campaign.lastMile;
  if (!ledger || ledger.crown !== campaign.crown) {
    ledger = freshLedger(campaign.crown, numericDist, numericArmy, turn);
    campaign.lastMile = ledger;
  }
  // Progress is only evidence of a real delivery or a real advance: ambient
  // growth is one soldier per tick, so a jump of `armyJump` means a convoy
  // landed, and a shorter distance means the column actually moved.
  const jumped = numericArmy - (Number(ledger.prevArmy) || 0) >= config.armyJump;
  const advance = numericDist < ledger.bestDist;
  if (advance) ledger.bestDist = numericDist;
  if (advance || jumped) ledger.lastProgress = turn;
  ledger.prevArmy = numericArmy;
  if (config.mode === 'reseat') {
    // Recovery only: keep the ledger (distances and progress) so the planner
    // can reseat a dead or cut column, but leave the attack-phase decision to
    // the existing planner logic.
    return {
      enabled: false, reseatOnly: true, state: 'approach',
      dist: numericDist, army: numericArmy, ...fallback, ledger,
    };
  }

  const target = lastMileNeed(pathNeed, firstNeed, input.cap, config);
  const inRange = numericDist <= config.range;
  const stalled = turn - (Number(ledger.lastProgress) || 0) >= config.stageTimeout;
  let state;
  if (!inRange) {
    ledger.committed = false;
    state = 'approach';
  } else {
    // A committed push must stay committed: every hop costs the defender's
    // garrison, so the column is expected to shrink below the path target on
    // the way in. Dropping back to a fresh muster there is exactly the
    // "march two cells, die, re-muster" loop this layer replaces.
    if (numericArmy < 12) {
      // The column died inside the last mile; release the commitment so the
      // next root has to pay for the path again instead of marching a token.
      ledger.committed = false;
      state = stalled ? 'reroute' : 'stage';
    } else if (ledger.committed || numericArmy >= target) {
      if (!ledger.committed) ledger.commits += 1;
      ledger.committed = true;
      state = stalled ? 'reroute' : 'commit';
    } else {
      state = stalled ? 'reroute' : 'stage';
    }
  }
  return {
    enabled: true,
    state,
    dist: numericDist,
    army: numericArmy,
    target,
    firstNeed: Math.max(18, Number(firstNeed) || 0) + boundedMargin(firstNeed, config),
    pathNeed: target,
    stalled,
    ledger,
  };
}

function plain(input, config) {
  const need = Math.max(18, Number(input.firstNeed) || 0);
  const target = lastMileNeed(input.pathNeed, input.firstNeed, input.cap, config);
  return {
    target,
    firstNeed: need + boundedMargin(need, config),
    pathNeed: target,
    stale: false,
  };
}

// Deliberate recovery after the column died or was cut. The old rebase paths
// demanded a substitute strictly closer to the crown than the best distance
// ever reached, which almost never exists, so the campaign restarted from the
// rear at distance 40+ and paid for the whole approach again. Instead accept
// any forward supply cell within `reseatSlack` of the best distance: the
// campaign keeps its ledger and resumes from the closest self-supporting cell.
function reseatRoot(board, candidates, distances, bestDist, config = lastMileConfig()) {
  if (!config.enabled || !Number.isFinite(bestDist)) return -1;
  if (board.size < config.minBoardSize) return -1;
  if (bestDist > config.range + 2) return -1;
  let best = -1;
  let bestScore = -Infinity;
  for (const at of candidates) {
    if (!Number.isInteger(at) || !Number.isFinite(distances[at])) continue;
    if (distances[at] > bestDist + config.reseatSlack) continue;
    const army = Math.max(0, Number(board.army[at]) || 0);
    if (army < 12 || board.isolated[at]) continue;
    const score = army - distances[at] * 3;
    if (score > bestScore) {
      bestScore = score;
      best = at;
    }
  }
  return best;
}

module.exports = {
  lastMileConfig,
  lastMileState,
  lastMileNeed,
  boundedMargin,
  reseatRoot,
  freshLedger,
  DEFAULT_RANGE,
};
