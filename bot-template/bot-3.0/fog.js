'use strict';

// Fog single-line layer for the Bot(3.0) 1v1 planner.
//
// Diagnosis. Relay's planner prices a move by what it can *see*; in fog that is
// wrong in three specific ways, and the round-2 replay traces show all three:
//
//   1. No objective. `targets` is built from remembered enemy crowns, and fog
//      vision is Chebyshev radius 1, so a crown is only ever remembered after
//      our land touches its neighbour. A replay of `relay/random/seed 12`
//      never learns a single enemy crown in 1000 ticks, so `goal` stays
//      infinite, every advance rule is dead, and the planner falls back to the
//      scouting field. The fix is to aim at the *visible* enemy front while no
//      crown is known: capturing it is what opens the vision that reveals the
//      crowns.
//   2. The column never converts into an attack. With no objective the march
//      term (`60 + sqrt(mass)` and a pickup bonus of up to 55 for stepping onto
//      an owned cell) outranks every plain capture (`32..65`), so a 1900-unit
//      hoard spends its ticks merging between its own cells. The same replay
//      spends 194 of 255 ticks on own-merge orders, 41 on neutral captures and
//      16 on attacks while the empire's crowns are picked off one by one.
//   3. No staging cost for the unknown. `assaultStrength` prices only visible
//      defenders; a fogged cell reports `grid_type 200` and `army_cnt 0`, so a
//      route into the dark looks free.
//
// Behaviour while the layer is active (fog, single line, small board, from
// `BOT3_FOG_TURN`): the heaviest stack becomes a column that advances down the
// objective field and attacks the frontier, and rear garrisons funnel into it
// (`BOT3_FOG_FUNNEL`). The column only commits when it can pay `required` plus
// a reserve of `guess` units per remaining step, which is the conservative
// stand-in for defenders the fog hides. Everything else - building, defence,
// the pressure model - stays on the existing path, so a threat still takes the
// tick and the layer simply pauses (it is a predicate, not a latch).
//
// `BOT3_FOG=0` restores the previous behaviour byte for byte.

const DEFAULT_MAX_BOARD = 800;
// Late enough to keep the opening untouched; the early economy is the same on
// both sides of a mirror, and the measured gains come from the attrition that
// follows.
const DEFAULT_START_TURN = 60;
// Reserve per remaining step toward the objective. A fogged cell can hide any
// number of units; four is the measured compromise between walking into an
// ambush and never moving at all (see BOT3_FOG.md).
const DEFAULT_GUESS = 8;
// Do not commit while behind on material: the reserve above is only a guess,
// the leaderboard army is measured.
const DEFAULT_FLOOR = 0;

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
function fogConfig(overrides = {}, env = process.env) {
  return {
    enabled: overrides.enabled ?? flag(env.BOT3_FOG, true),
    maxBoard: overrides.maxBoard ?? number(env.BOT3_FOG_BOARD, DEFAULT_MAX_BOARD, 1, 100000),
    startTurn: overrides.startTurn ?? number(env.BOT3_FOG_TURN, DEFAULT_START_TURN, 0, 100000),
    guess: overrides.guess ?? number(env.BOT3_FOG_GUESS, DEFAULT_GUESS, 0, 200),
    floor: overrides.floor ?? number(env.BOT3_FOG_FLOOR, DEFAULT_FLOOR, 0, 4),
    column: overrides.column ?? flag(env.BOT3_FOG_COLUMN, true),
    funnel: overrides.funnel ?? flag(env.BOT3_FOG_FUNNEL, false),
    aimFront: overrides.aimFront ?? flag(env.BOT3_FOG_AIM, false),
    expand: overrides.expand ?? flag(env.BOT3_FOG_EXPAND, false),
    invest: overrides.invest ?? flag(env.BOT3_FOG_INVEST, false),
    guard: overrides.guard ?? flag(env.BOT3_FOG_GUARD, false),
  };
}

// The planner derives `clearSerial` from the same expression, so a board is in
// fog exactly when `clearSerial` is false on a serial (non-multi) game.
function fogBoard(b) {
  return Boolean(b?.fogMode ?? (b?.fog ? b.fog.includes(1) : false));
}

function freshFog() {
  return { active: false, entries: 0, entry: null, exit: null };
}

// Gate for the whole layer: fog, serial, small board, late enough. `active`
// additionally needs a measured material edge and no threatened home.
function fogUpdate(board, input, config = fogConfig()) {
  const state = (board.fog ??= freshFog());
  const off = { active: false, state, entries: state.entries, entry: state.entry };
  if (!config.enabled) return off;
  if (input?.multi) return off;
  if (!(Number(input?.size) <= config.maxBoard)) return off;
  const turn = Number(input?.turn) || 0;
  if (turn < config.startTurn) return off;
  const army = Math.max(0, Number(input.army) || 0);
  const enemyArmy = Math.max(0, Number(input.enemyArmy) || 0);
  const threatened = (Number(input.danger) || 0) > 0;
  const active = !threatened && enemyArmy > 0 && army >= enemyArmy * config.floor;
  if (active && !state.active) {
    state.entries += 1;
    state.entry = { turn, army, enemyArmy };
  } else if (!active && state.active) {
    state.exit = threatened ? 'threat' : 'material';
  }
  state.active = active;
  return { active, state, entries: state.entries, entry: state.entry };
}

// `assaultStrength` cannot price a fogged cell, so every remaining step toward
// the objective carries a flat reserve. `goal` is the planner's objective
// distance field, so this is exactly the dark part of the route.
function fogRequired(required, goal, guess, cap = 8) {
  const out = new Float64Array(required.length);
  for (let i = 0; i < required.length; i++) {
    const base = required[i];
    const distance = Number(goal[i]);
    const steps = Number.isFinite(distance) && distance < cap ? Math.max(0, distance) : cap;
    out[i] = Number.isFinite(base) ? base + guess * steps : base;
  }
  return out;
}

// Scores for the fog column, kept next to the closing layer's numbers: the
// column advance has to outrank the march/merge terms (below 300) and the
// economy build (675), and the rear funnel has to outrank a march as well.
const COLUMN_SCORE = 1000;
const FUNNEL_SCORE = 940;
// A forward capture has to beat the march/merge pickup bonus (capped at 55 in
// the planner), otherwise the heaviest stack spends the game shuffling between
// its own cells (194 of 255 ticks in `relay/random/seed 12`).
const EXPAND_BONUS = 70;
// Falling back toward the nearest crown when the front is out of reach.
const GUARD_SCORE = 300;
// A crown pays +1 army per tick, so a stack that keeps walking to a preselected
// build site builds nothing: `relay/random/seed 12` finished 1000 ticks with
// 2479 army and two crowns. Building where the stack already stands is worth
// more than the march term but less than a strike.
const INVEST_SCORE = 700;

function columnAdvance(send, remaining) {
  return COLUMN_SCORE + Math.min(620, Math.sqrt(Math.max(send, remaining)) * 14);
}

function funnelScore(mass) {
  return FUNNEL_SCORE + Math.min(500, Math.sqrt(Math.max(0, mass)) * 14);
}

// Holding position is worth more than a march (which caps near 230) when the
// column has nothing adjacent to attack: a hoard that wanders is exactly how a
// fog mirror loses its crowns (`relay/random/seed 11` died at tick 256 while
// the 178-unit lead was two cells from home).
function guardScore(send) {
  return GUARD_SCORE + Math.min(140, Math.sqrt(Math.max(0, send)) * 8);
}

// Cheap forward expansion: capturing an undefended cell adds land (income) and
// opens one more ring of vision, which is how the enemy crowns are found.
function expandScore(send, heading) {
  return 60 + Math.min(140, Math.sqrt(Math.max(0, send)) * 8) + EXPAND_BONUS - Math.min(30, heading);
}

module.exports = {
  fogConfig,
  fogBoard,
  fogUpdate,
  fogRequired,
  freshFog,
  columnAdvance,
  funnelScore,
  expandScore,
  guardScore,
  INVEST_SCORE,
  DEFAULT_MAX_BOARD,
  DEFAULT_START_TURN,
  DEFAULT_GUESS,
  DEFAULT_FLOOR,
  COLUMN_SCORE,
  FUNNEL_SCORE,
  GUARD_SCORE,
  EXPAND_BONUS,
};
