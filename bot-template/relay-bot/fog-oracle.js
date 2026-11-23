'use strict';

// Fog oracle: price the army the fog hides.
//
// Fog vision is Chebyshev radius 1 (`src/game-engine/fog-vision.ts`) and every
// hidden cell is rewritten to plain 200 with zero army, so the board the planner
// sees says "nothing is over there". The *leaderboard* is not fogged: it is
// rebuilt from the real grids every tick (`src/game-engine/leaderboard.ts`), so
// `rival.army` and `rival.land` are exact. Everything this module knows is
// derived from that pair plus what the vision does leave visible:
//
//   visibleArmy  = sum of the rival armies on cells the fog does not cover
//   visibleLand  = count of rival cells the fog does not cover
//   hiddenArmy   = rival.army - visibleArmy     (the interior reserve)
//   hiddenLand   = rival.land - visibleLand
//   density      = hiddenArmy / max(1, hiddenLand)
//
// Mountains and swamp stay visible, so the passable map is known; what is hidden
// is *who holds what and how much sits there*. `density` is therefore the one
// honest estimate of a fogged cell's garrison on the route ahead, and a fogged
// dive can be priced with it instead of the flat `BOT3_FOG_GUESS` of `./fog`.
//
// Crowns. A crown pays exactly +1 army per tick, plains/cities pay +1 only on the
// 50-tick growth tick (and +1 extra inside the single-line burst window, see
// `src/game-engine/tick-growth.ts`). On every other tick the rival army delta is
// exactly `crowns - losses`, so:
//
//   * a quiet window (rival land unchanged and our army unchanged, so nothing
//     fought) reads the crown count straight off the delta;
//   * a ~50 army drop with unchanged land is a build (one more crown);
//   * the estimate is only advanced on non-growth ticks, so the burst and the
//     50-tick plain growth never look like crowns.
//
// That count is the "how many crowns are left" number an all-in needs: one crown
// left and a remembered home is the only position where paying a stack for the
// last home ends the game instead of trading into a rebuild.
//
// Every signal is opt-in and off by default (`BOT3_FOGORACLE`), because the
// stock fog path is the measured baseline: `BOT3_FOGORACLE=1` enables the bundle
// (density reserve, dive refusal, low-reserve push, last-crown all-in) and each
// piece can be isolated with its own knob. Measured verdicts are in BOT3_FOG.md.

const DEFAULT_MAX_BOARD = 800;
// A fogged step is priced at up to `density` units instead of the flat guess of
// `./fog`: the target cell of a dive is exactly one hidden garrison.
const DEFAULT_RESERVE_CAP = 24;
// Refuse to walk a stack into a hidden reserve it cannot pay: the lead may not
// be smaller than this share of `density`.
const DEFAULT_DIVE = 100;
// "The rear is empty" threshold: a hidden army at or below one unit per hidden
// cell means the rival keeps nothing behind the front.
const DEFAULT_LOW = 1;
// Score ceiling for a refused dive (has to sit under a capture, see `./fog`).
const DEFAULT_BLOCK_SCORE = 240;
// Paint-before-merge ceiling. The column advance is 1000+ and the gather march
// caps near 260, so an empire with open land in front still spends its serial
// tick merging between its own cells (the traced fog losses hold 35-50 land
// while the leaderboard says hundreds of cells are still neutral). Capping a
// merge below the capture term (150) turns those ticks into land.
const DEFAULT_PAINT = 140;
// Bonus for a column/raid step while the rival's interior is empty: their rear
// is the cheapest land on the board and their front is what the fog hides.
const DEFAULT_PUSH_SCORE = 160;
// All-in bonus for a step toward a remembered crown when the rival is down to
// its last one. Above the column advance (`./fog` COLUMN_SCORE) on purpose.
const DEFAULT_ALL_IN = 1250;

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
function fogOracleConfig(overrides = {}, env = process.env) {
  const on = flag(env.BOT3_FOGORACLE, false);
  return {
    enabled: overrides.enabled ?? on,
    // `BOT3_FOGORACLE=1` is the bundle; each piece can be switched off by name.
    reserve: overrides.reserve ?? flag(env.BOT3_FOGORACLE_RESERVE, on),
    dive: overrides.dive ?? flag(env.BOT3_FOGORACLE_DIVE, on),
    push: overrides.push ?? flag(env.BOT3_FOGORACLE_PUSH, on),
    // Last-crown all-in: opt-in only. `lastCrown` needs a *confirmed* ledger
    // (`crowns` is primed at 1 by the spawn rule), and the unconfirmed version
    // measured -6.4pp on its own (see BOT3_FOG_ORACLE.md).
    allIn: overrides.allIn ?? flag(env.BOT3_FOGORACLE_ALLIN, false),
    paint: overrides.paint ?? flag(env.BOT3_FOGORACLE_PAINT, on),
    maxBoard: overrides.maxBoard ?? number(env.BOT3_FOGORACLE_BOARD, DEFAULT_MAX_BOARD, 1, 100000),
    reserveCap: overrides.reserveCap ?? number(env.BOT3_FOGORACLE_RESERVE_CAP, DEFAULT_RESERVE_CAP, 1, 200),
    diveLead: overrides.diveLead ?? number(env.BOT3_FOGORACLE_DIVE, DEFAULT_DIVE, 0, 1000),
    low: overrides.low ?? number(env.BOT3_FOGORACLE_LOW, DEFAULT_LOW, 0, 100),
    blockScore: overrides.blockScore ?? number(env.BOT3_FOGORACLE_BLOCK, DEFAULT_BLOCK_SCORE, 0, 10000),
    pushScore: overrides.pushScore ?? number(env.BOT3_FOGORACLE_PUSH_SCORE, DEFAULT_PUSH_SCORE, 0, 10000),
    paintScore: overrides.paintScore ?? number(env.BOT3_FOGORACLE_PAINT_SCORE, DEFAULT_PAINT, 0, 10000),
    allInScore: overrides.allInScore ?? number(env.BOT3_FOGORACLE_ALLIN_SCORE, DEFAULT_ALL_IN, 0, 10000),
  };
}

const ownerOf = (code) => (code < 200 ? code % 50 : 0);

// Crowns pay +1 on every tick; everything else only on growth ticks.
function growthTick(turn, multi) {
  if (turn % 50 === 0) return true;
  return !multi && turn >= 26 && turn <= 50;
}

function freshOracle() {
  return {
    turn: -1,
    prevArmy: -1,
    prevLand: -1,
    prevMine: -1,
    // Every player starts with exactly one crown (`general-selection.ts`), and
    // it is the only income that pays on every tick, so the ledger starts there.
    crowns: 1,
    builds: 0,
    lastBuild: -1,
    quiet: 0,
    hiddenArmy: 0,
    hiddenLand: 0,
    visibleArmy: 0,
    visibleLand: 0,
    density: 0,
    mine: 0,
    passable: 0,
    openLand: 0,
  };
}

// `input`: { turn, multi, fog, rival: { id, army, land }, mine } where `mine` is
// our leaderboard army. Returns the derived signals; the ledger lives on
// `board.fogOracle` so the estimate survives between ticks.
function fogOracleUpdate(b, input, config = fogOracleConfig()) {
  const state = (b.fogOracle ??= freshOracle());
  const turn = Number(input?.turn) || 0;
  const rival = input?.rival ?? null;
  const rivalArmy = Math.max(0, Number(rival?.army) || 0);
  const rivalLand = Math.max(0, Number(rival?.land) || 0);
  const rivalId = Number(rival?.id) || 0;
  const mine = Math.max(0, Number(input?.mine) || 0);
  // What the vision leaves visible: hidden cells report owner 0 and army 0, so a
  // plain scan of the board is exactly the visible half of the leaderboard.
  let visibleArmy = 0,
    visibleLand = 0,
    myCrowns = 0,
    passable = 0;
  for (let i = 0; i < b.size; i++) {
    if (b.grid_type[i] !== 201) passable++;
    const owner = ownerOf(b.grid_type[i]);
    if (owner === rivalId) {
      visibleLand++;
      visibleArmy += b.army_cnt[i];
    } else if (owner === b.me) {
      const code = b.grid_type[i];
      if (code >= 100 && code < 150) myCrowns++;
    }
  }
  state.visibleArmy = visibleArmy;
  state.visibleLand = visibleLand;
  state.hiddenArmy = Math.max(0, rivalArmy - visibleArmy);
  state.hiddenLand = Math.max(0, rivalLand - visibleLand);
  state.density = state.hiddenArmy / Math.max(1, state.hiddenLand);
  state.mine = myCrowns;
  // The neutral budget. Mountains are visible through the fog and both land
  // counts are exact, so the open land is known even when not one of its cells
  // is: `passable - ours - theirs`.
  state.passable = passable;
  state.openLand = Math.max(0, passable - mine - rivalLand);
  // Crown ledger. Only the ticks where crowns are the only income are read, so
  // the burst window and the 50-tick plain growth never enter the estimate.
  const quietNow = state.prevArmy >= 0 && !growthTick(turn, input?.multi);
  if (quietNow) {
    const dArmy = rivalArmy - state.prevArmy;
    const dLand = rivalLand - state.prevLand;
    const dMine = mine - state.prevMine;
    if (dLand === 0 && dMine === 0) {
      state.quiet++;
      const expected = state.crowns;
      if (dArmy - expected <= -40) {
        // A ~50-point drop with no land change is a build: one more crown.
        const built = Math.max(1, Math.round((expected - dArmy) / 50));
        state.crowns += built;
        state.builds += built;
        state.lastBuild = turn;
      } else if (dArmy - expected > 2) {
        // More income than the estimate allows (a build we did not see, or a
        // capture the leaderboard already counted). Do not chase it.
      } else if (dArmy < expected - 2) {
        // They lost units in a fight with someone else: the crown count holds.
      }
    }
  }
  state.turn = turn;
  state.prevArmy = rivalArmy;
  state.prevLand = rivalLand;
  state.prevMine = mine;
  const empty = state.hiddenLand > 0 && state.density <= config.low;
  return {
    state,
    rivalId,
    visibleArmy,
    visibleLand,
    hiddenArmy: state.hiddenArmy,
    hiddenLand: state.hiddenLand,
    density: state.density,
    crowns: state.crowns,
    builds: state.builds,
    quiet: state.quiet,
    passable,
    openLand: state.openLand,
    // The rival keeps nothing behind the front.
    empty,
    // The last crown: one more home and the game is over. Only reported once a
    // quiet window has confirmed the ledger - the spawn rule primes it at 1, and
    // an unconfirmed read is what made the all-in hook fire from tick 40.
    lastCrown: state.quiet >= 2 && state.crowns <= 1,
  };
}

// Per-step reserve for a fogged route: a hidden cell is a garrison of `density`
// on average, so a step into the dark is worth that many units rather than the
// flat guess. Clamped: the cap keeps the column from never moving.
function fogOracleReserve(base, oracle, config = fogOracleConfig()) {
  if (!config.reserve || !oracle) return base;
  return Math.max(base, Math.min(config.reserveCap, Math.ceil(oracle.density)));
}

// A dive is a step that walks *into* a fogged cell on the objective route. It is
// refused when the lead cannot pay the hidden reserve it may meet there: the
// traced fog losses feed a 50-150 unit stack into a rear that holds 200-500.
function fogOracleBlocked(oracle, fogged, send, config = fogOracleConfig()) {
  if (!config.dive || !oracle || !fogged) return false;
  if (!config.diveLead) return false;
  return send * 100 < oracle.density * config.diveLead;
}

// The rival's interior is empty: the front they show is not what the fog hides,
// so their rear is the cheap half of the board.
function fogOraclePush(oracle, send, config = fogOracleConfig()) {
  return Boolean(config.push && oracle?.empty && send >= 8);
}

// Paint before merging. While the leaderboard says there is open neutral land,
// a move onto our own cell buys nothing that the fog can hide: land, income and
// the next ring of vision all come from the neutral cell next door. Returns
// `Infinity` when the rule is off, so the caller can use it as a plain
// `Math.min`.
function fogOraclePaint(oracle, config = fogOracleConfig()) {
  if (!config.paint || !oracle) return Infinity;
  if (!(oracle.openLand > 0)) return Infinity;
  return config.paintScore;
}

module.exports = {
  fogOracleConfig,
  fogOracleUpdate,
  fogOracleReserve,
  fogOracleBlocked,
  fogOraclePush,
  fogOraclePaint,
  freshOracle,
  DEFAULT_MAX_BOARD,
  DEFAULT_RESERVE_CAP,
  DEFAULT_DIVE,
  DEFAULT_LOW,
  DEFAULT_BLOCK_SCORE,
  DEFAULT_PAINT,
  DEFAULT_PUSH_SCORE,
  DEFAULT_ALL_IN,
};
