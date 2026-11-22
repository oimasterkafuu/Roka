'use strict';

// Land-first layer for structurally swamp-heavy clear serial rooms.
//
// Diagnosis (see LAND.md and baseline-results.jsonl): mediterranean and
// archipelago, clear single-line are the two cells where Bot(3.0) only gets the
// relay shadow layer, and both are 40-60% swamp. Swamp pays no income, so an
// army/merge tick there is worth nothing while a neutral capture is worth +1
// army per tick in the 26..50 burst and one more crown site later. The measured
// baseline ends those games with less land than relay (mediterranean 56 -> 60
// vs relay 53 -> 63 on the surviving games) and a far larger army, i.e. the
// serial tick was spent on concentration instead of land.
//
// The fog layer already solved the same shape with `fogPaintCap` (see ./fog):
// while the border still has a neutral cell to paint, a column advance that
// buys no land is capped under the capture score. This module ports that idea
// to the clear serial planner, gated on the board's *structural* swamp share
// (swamp keeps its code through the fog: neutral 204, owned 151..199, so the
// share is known even on a fully hidden board) and on the exact leaderboard
// land race.
//
// `BOT3_LANDFIRST` ships on: on the sixteen-seed matrix it is worth +27 wins
// with no regressing cell (1648/342/58 against the recorded 1621/367/60), and
// the swamp screen below it is +5 games over the paired baseline. The three
// mechanism knobs measured negative and stay opt-in; `BOT3_LANDFIRST=0` returns
// the pre-round-12 behaviour byte for byte. Every knob is read on every call, so
// an A/B run can flip the layer in-process (see LAND.md for the tables).

const DEFAULT_SWAMP_SHARE = 0.35;
// Score added to a neutral capture while our land trails the rival's. The
// stock capture term is ~75-110, the own-merge march is 60-200, so the boost
// only has to lift the capture above the merge, not above defence or a build.
// Measured at 130 on the 16-seed swamp screen: anti/archipelago -3.1pp,
// relay/mediterranean -3.1pp, so it ships at 0 (see LAND.md).
const DEFAULT_CAPTURE = 0;
// Clear-room analogue of `fogPaintCap`: an own-cell merge (mode 2, no strike)
// that buys no land is capped here while the border still has neutral cells.
// 155 sits above the stock capture (~110) and below the site funding (374+),
// the defensive reinforcement (600+) and the closing funnel (940+).
// Measured at 155 on the 16-seed swamp screen it converts 13 wins into
// 1000-tick timeouts on mediterranean (relay 19 -> 14/32), so it ships at 0.
const DEFAULT_PAINT = 0;
// Burst window boost (single-line turns 26..49): a neutral plain captured on
// turn 26 pays 24 ticks of +1 army, so an early land lead compounds. Measured
// at 220 on the 16-seed swamp screen: anti/archipelago +6.3pp, anti/med +9.4pp,
// relay/med -9.4pp, so it ships at 0 (see LAND.md).
const DEFAULT_BURST = 220;
// Island crowns: raise the crown ceiling and keep the sites apart so one raid
// cannot cascade through a cluster (`BOT3_ISLANDCROWN`). Measured at 6/3 on the
// 16-seed swamp screen it loses 3.9pp overall (relay/med -9.4pp, anti/med
// -6.3pp): a crown is a raid target before it is income, so it ships off.
const DEFAULT_HOMES = 6;
const DEFAULT_SPREAD = 3;
// Stand the closing funnel down on a swamp-heavy clear room (0 = stock
// closing). See LAND.md: the funnel is a concentration rule, and on a board
// where most of the map pays no income the concentrated stack crosses swamp
// instead of turning land into crowns.
const DEFAULT_CLOSE_SKIP = 1;
// Optional end of the stand-down: closing returns from this turn on (0 = it
// stays down for the rest of the game).
// Same board bound as ./closing: the layer is for the compact serial room.
const DEFAULT_MAX_BOARD = 800;

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
function landConfig(overrides = {}, env = process.env) {
  return {
    landfirst: overrides.landfirst ?? flag(env.BOT3_LANDFIRST, true),
    landburst: overrides.landburst ?? flag(env.BOT3_LANDBURST, false),
    islandcrown: overrides.islandcrown ?? flag(env.BOT3_ISLANDCROWN, false),
    maxBoard: overrides.maxBoard ?? number(env.BOT3_LAND_BOARD, DEFAULT_MAX_BOARD, 1, 100000),
    swampShare: overrides.swampShare ?? number(env.BOT3_LAND_SWAMP_SHARE, DEFAULT_SWAMP_SHARE, 0, 1),
    capture: overrides.capture ?? number(env.BOT3_LAND_CAPTURE, DEFAULT_CAPTURE, 0, 4000),
    paint: overrides.paint ?? number(env.BOT3_LAND_PAINT, DEFAULT_PAINT, 0, 10000),
    burst: overrides.burst ?? number(env.BOT3_LAND_BURST, DEFAULT_BURST, 0, 4000),
    homes: overrides.homes ?? number(env.BOT3_LAND_HOMES, DEFAULT_HOMES, 0, 32),
    spread: overrides.spread ?? number(env.BOT3_LAND_SPREAD, DEFAULT_SPREAD, 0, 20),
    closeSkip: overrides.closeSkip ?? number(env.BOT3_LAND_CLOSE_SKIP, DEFAULT_CLOSE_SKIP, 0, 1),
    closeUntil: overrides.closeUntil ?? number(env.BOT3_LAND_CLOSE_UNTIL, 0, 0, 100000),
  };
}

const swamp = (code) => code >= 150 && code !== 200 && code !== 201;

// Structural terrain mix. Fog keeps swamp visible, so the same walk is valid
// before the board is explored.
function swampShare(b) {
  const size = Number(b?.size) || 0;
  if (!size) return 0;
  let cells = 0;
  for (let i = 0; i < size; i++) if (swamp(b.grid_type[i])) cells++;
  return cells / size;
}

const OFF = {
  active: false,
  heavy: false,
  trail: false,
  capture: 0,
  paint: Infinity,
  burst: 0,
  homes: 0,
  spread: 0,
  closeSkip: false,
};

// One call per planning tick. `input` carries the numbers the planner already
// computed; the layer keeps no state of its own.
function landContext(b, input, config = landConfig()) {
  if (!input || input.multi) return OFF;
  // Clear serial rooms only: the fog column owns the fog shape (./fog) and the
  // corridor boards keep their own objective (./maze, ./fog-maze).
  if (!input.clearSerial) return OFF;
  if (!(Number(input.size) <= config.maxBoard)) return OFF;
  const heavy = swampShare(b) >= config.swampShare;
  if (!heavy) return { ...OFF, heavy };
  const turn = Math.max(0, Number(input.turn) || 0);
  const single = Boolean(input.single);
  const mine = Math.max(0, Number(input.land) || 0);
  const theirs = Math.max(0, Number(input.enemyLand) || 0);
  const trail = theirs > 0 && mine < theirs;
  const capture = config.landfirst && single && trail ? config.capture : 0;
  const paint =
    config.landfirst && single && trail && config.paint > 0 && (Number(input.neutral) || 0) > 0
      ? config.paint
      : Infinity;
  // The burst window is priced even before `single` opens (turns 26-27 still
  // take the stock capture path), and it does not need a land race to fire: at
  // turn 26 nobody leads on land yet, and the point is that the lead compounds.
  const burst = config.landburst && turn >= 26 && turn <= 49 ? config.burst : 0;
  const island = config.islandcrown;
  return {
    active: capture > 0 || paint !== Infinity,
    heavy,
    trail,
    capture,
    paint,
    burst,
    homes: island ? config.homes : 0,
    spread: island ? config.spread : 0,
    closeSkip: Boolean(
      config.landfirst &&
      config.closeSkip &&
      single &&
      trail &&
      !(config.closeUntil > 0 && turn >= config.closeUntil),
    ),
  };
}

module.exports = {
  landConfig,
  landContext,
  swampShare,
  DEFAULT_SWAMP_SHARE,
  DEFAULT_CAPTURE,
  DEFAULT_PAINT,
  DEFAULT_BURST,
  DEFAULT_HOMES,
  DEFAULT_SPREAD,
  DEFAULT_CLOSE_SKIP,
  DEFAULT_MAX_BOARD,
};
