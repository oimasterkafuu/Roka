'use strict';

// Endgame closing layer for compact single-line 1v1 rooms.
//
// Diagnosis. On the official 0.34 room both sides spam crowns (a crown is
// +1 army per tick, so the `limit`-bypassing outpost rule makes crowns cheap
// income) and the 1000-tick timeouts are not failed openings: at tick 250 the
// paired army ratio of a timeout is 0.99 and the land ratio 1.15, i.e. a
// dead-even attrition. A replay of `anti/mediterranean/seed 1/seat 1` shows the
// shape: at tick 625 we hold 3985 army spread over 30 crowns while the
// opponent keeps 25, one stack of 561 marches eleven cells, captures three
// crowns in three ticks (`2600`-score strikes land back to back), is wiped by
// the reply, and the planner then spends the next 350 ticks founding crowns and
// painting swamp with 50-unit detachments (scores 430-680) while re-massing the
// remaining 2000 army is never attempted again. The gap is last-mile
// throughput, not income: in serial play one action per tick means a dispersed
// empire converts its army into kills at roughly one merge per tick, so every
// tick spent on economy is a tick the column does not advance. Killing also
// requires taking *every* enemy crown, and the opponent's 25 crowns grow one
// army each per tick, so a partial push that dies at the frontier is worse than
// no push at all.
//
// Behaviour while the phase owns the plan:
//   * no new crowns, outposts or upgrades (stop scattering the army into
//     50-unit deposits at the back of the map),
//   * a single rolling column: the heaviest stack leads, weighted by sqrt(mass)
//     so a 2000-army lead outranks a 55-unit detachment, and it always moves
//     down the crown-distance field, so every tick is either an advance or a
//     merge toward the front,
//   * a lead that cannot pay for the rest of the path holds and lets the rear
//     garrisons merge into it instead of walking into the enemy line to die,
//   * strikes and two-tick sieges keep their existing (higher) priority, so a
//     payable capture is never postponed.
//
// Entry is late and conservative because the phase is for games that are
// already an attrition: it waits for `startTurn`, a rival that has built at
// least `minCrowns` crowns, no home under real threat, and an army that has not
// fallen below `armyFloor` of the opponent's. The phase is a predicate, not a
// one-shot latch: if a home comes under threat the ordinary defensive scoring
// takes the tick, and the closing plan resumes as soon as the threat is
// answered. A latched version lost the games where the reply arrived mid-way
// (`anti/mediterranean/seed 1/seat 1` exited at tick 404 and coasted to a loss).
//
// `BOT3_CLOSING=0` restores the previous behaviour for A/B runs. When disabled
// the planner is byte-identical to the baseline path.

// `startTurn` is late because the layer is for games that are already an
// attrition, and `armyFloor` above 1 means it only converts a real material
// edge: at 0.9 the phase entered even games and turned the `anti` single-line
// timeouts into losses; 1.2 is break-even (7/7/2 against 2/4/10) and 1.35
// converts 15 timeouts into wins without losing a single decided game.
// `minCrowns` keeps ordinary games out: a 1000-tick stall always shows a rival
// that has built six or more crowns, while a decided game is over before that.
const DEFAULT_MAX_BOARD = 800;
const DEFAULT_START_TURN = 120;
const DEFAULT_MIN_CROWNS = 6;
const DEFAULT_ARMY_FLOOR = 1.35;

function number(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function flag(raw, fallback = false) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'off';
}

// Read on every call so tests and A/B runs can toggle the layer in-process.
function closingConfig(overrides = {}, env = process.env) {
  return {
    enabled: overrides.enabled ?? flag(env.BOT3_CLOSING, true),
    maxBoard: overrides.maxBoard ?? number(env.BOT3_CLOSING_BOARD, DEFAULT_MAX_BOARD, 1, 100000),
    startTurn: overrides.startTurn ?? number(env.BOT3_CLOSING_TURN, DEFAULT_START_TURN, 0, 100000),
    minCrowns: overrides.minCrowns ?? number(env.BOT3_CLOSING_CROWNS, DEFAULT_MIN_CROWNS, 1, 64),
    armyFloor: overrides.armyFloor ?? number(env.BOT3_CLOSING_FLOOR, DEFAULT_ARMY_FLOOR, 0, 4),
  };
}

function freshClosing() {
  return { active: false, entries: 0, entry: null, exit: null };
}

// One call per planning tick. `input` carries the numbers the planner already
// computed; the ledger lives on the board for diagnostics only.
function closingUpdate(board, input, config = closingConfig()) {
  const state = (board.closing ??= freshClosing());
  const off = { active: false, state, entries: state.entries, entry: state.entry };
  if (!config.enabled) return off;
  if (input?.multi) return off;
  if (!(Number(input?.size) <= config.maxBoard)) return off;
  const turn = Number(input.turn) || 0;
  const enemyCrowns = Math.max(0, Number(input.enemyCrowns) || 0);
  const army = Math.max(0, Number(input.army) || 0);
  const enemyArmy = Math.max(0, Number(input.enemyArmy) || 0);
  const threatened = (Number(input.danger) || 0) > 0;
  const active =
    turn >= config.startTurn &&
    enemyCrowns >= config.minCrowns &&
    !threatened &&
    (enemyArmy <= 0 || army >= enemyArmy * config.armyFloor);
  if (active && !state.active) {
    state.entries += 1;
    state.entry = { turn, army, enemyArmy, enemyCrowns };
  } else if (!active && state.active) {
    state.exit = threatened ? 'threat' : 'conditions';
  }
  state.active = active;
  return { active, state, entries: state.entries, entry: state.entry };
}

module.exports = {
  closingConfig,
  closingUpdate,
  freshClosing,
  DEFAULT_MAX_BOARD,
  DEFAULT_START_TURN,
  DEFAULT_MIN_CROWNS,
  DEFAULT_ARMY_FLOOR,
};
