'use strict';

// Maze + fog layer for the Bot(3.0) 1v1 planner.
//
// Diagnosis. A corridor board that is also fogged is the worst measured cell of
// the matrix (`relay/maze/fog+single` 46.9%, `fog+multi` 56.3% against 71.9% and
// 56.3% clear). The two layers that could price it both step aside:
//
//   * `./fog` closes on corridor maps (`BOT3_FOG_MAZE=0`) because its column is
//     built for open rooms;
//   * `./maze` keeps the open-map front planner late (`SINGLE_FROM`) but the
//     planner only engages it when the board is *clear* (`single` is gated on
//     `clearSerial`), so on a fogged maze the front planner never runs either.
//
// What is left is the plain expansion policy with an empty objective: `targets`
// is built from remembered rival crowns and fog vision is Chebyshev radius 1,
// so no crown is known for most of the game and `goal` stays infinite. The
// diagnostic dump (`data/scratch/diag-mazefog.cjs`, relay/maze/fog+single, seeds
// 1-2) shows the result: 0.01 remembered crowns per frame, 0.56 of the single
// serial order per tick spent merging between our own cells and 0.05 painting a
// neutral cell. Land therefore stops growing, vision (which comes from owned
// land) stops growing with it, and the empire never finds the rival crown.
//
// Behaviour while the layer owns the frame (fog, corridor board, serial room,
// from `BOT3_FOG_MAZE_TURN`):
//
//   1. Objective. With no remembered rival crown the planner aims at the
//      *visible* rival frontier plus the belief anchors of `./fog` (the far end
//      of the passable tree, which on a maze is where `general-selection.ts`
//      puts the enemy home: measured 16/16 on the maze maps). That turns the
//      infinite goal into a real distance field, which is what the fog column
//      and the forward-capture bonus below are priced against.
//   2. Expand. A neutral cell forward along that field is scored above the
//      own-merge march term. On a corridor board every captured cell is one
//      more income cell and one more ring of vision, and a serial tick that
//      merges two garrisons buys nothing at all.
//   3. Column. The fog layer's column (`columnAdvance` + `fogRequired`) is
//      enabled on the corridor board so the heaviest stack advances and attacks
//      instead of wandering; the reserve still prices the steps the fog hides.
//   4. Lane discipline. A corridor is a tree: the same edge (or its reverse) is
//      the whole tick. The layer can enable the existing `mazeActionGuard`
//      bookkeeping (`BOT3_FOG_MAZE_LANE=1`) so a column does not walk back up
//      the corridor it just came down unless the move is a real cut, a capture
//      or a defence. Measured verdicts are in BOT3_MAZE.md.
//
// Multi-line corridor rooms get a second, narrower hook: `fogMazeBranches` picks
// up to `count` frontier cells on *different* corridor branches (the visible
// rival frontier first, the belief region second), and the planner rewards a
// neutral capture / rival attack that walks one of those branches while damping
// own merges that do not advance. Sixteen orders all spent merging into the same
// corridor is exactly the 6.32-own-merge trace of the diagnostic above.
//
// Everything is read on every call and off by default: `BOT3_FOG_MAZE_LAYER=0`
// (or the variable unset) leaves the round-4 path byte for byte.
//
// Progress guard (`BOT3_FOG_MAZE_STALL`, `BOT3_FOG_MAZE_LAND_LEAD`, both off by
// default). The layer's column and its advance score outrank every capture, so
// an empire that already leads on land keeps its mass in one corridor and stops
// painting: the traced `anti/maze/fog+single` loss holds 49 land from turn 100 to
// 580 while 60+ neutral cells stay open, then loses the attrition. The guard
// latches the layer off and hands the frame back to the stock planner, which is
// what the baseline does on that board. It does not ship enabled: on the round-6
// matrix every setting that fixes that game also drops `relay/maze/fog+single`
// below its 65% gate (measured verdicts in BOT3_MAZE.md).
//
// Paint cap (`BOT3_MAZEFOG3`, off by default, `BOT3_FOG_MAZE_PAINT` for the
// score). The layer's column advance outranks every capture, so once the goal
// field has any step the lead stack may take, it stops painting: the traced
// regression holds 49 land from turn 100 to 580 with 60+ neutral cells open.
// The cap is local and predicate-shaped instead of a latched stand-down, so the
// relay corridor gain is untouched: only a column move that does *not* take
// land (a merge) is capped, and only while our border still has a neutral cell.

const { fogBeliefTargets } = require('./fog');

const DEFAULT_MAX_BOARD = 800;
// The capture phase starts where the fuzzed opening ends. Early ticks are the
// land race on both sides of a mirror and the plain opening order already
// handles them.
const DEFAULT_START_TURN = 38;
// The layer's expansion is worth less than the stock finisher in the very late
// game: the measured weak-opponent losses are 1000-tick timeouts in games the
// baseline wins at 295-794 ticks, and standing down at 450 turns them back into
// wins without costing a single relay corridor win.
const DEFAULT_END_TURN = 450;
// Objective while no rival crown is remembered. The *visible* rival frontier is
// measured information; the belief anchors of `./fog` are a prior over the tree
// ends and measured *worse* here (13-15/32 against 21/32 on the relay corridor
// fog cell): the anchor sits behind the rival, so the column walks past the
// only enemy it could actually fight. Kept as an opt-in for `BOT3_FOG_MAZE_BELIEF=1`.
const DEFAULT_COUNT = 2;
const DEFAULT_RATIO = 0.7;
const DEFAULT_SPREAD = 3;
const DEFAULT_BELIEF = false;
// Generic expansion is the point of the layer on a corridor: the own-merge
// march term is what the traced frames spend the tick on.
const DEFAULT_DEEP = true;
// Score of a plain attack on the visible rival frontier. It has to beat the
// goal-advance gather term (~285) or the empire keeps merging in front of the
// rival column instead of taking the cell. On the round-4 relay the optimum was
// 240 (21/32 against 19/32 at 0); the round-5 relay keeps the same 21/32 with
// the bonus off and loses a game with it, so it is opt-in.
const DEFAULT_HARASS = 0;
// Corridor lane discipline (the maze layer's bookkeeping, off by default there).
const DEFAULT_LANE = true;
// Stand-down guards. `known` (no rival crown remembered) is the measured one:
// the layer only owns the pre-contact corridor, and the stock path finishes
// better once a crown is known. `landCap` is a wide safety valve for the
// weak-opponent cell where the layer's expansion costs one game.
const DEFAULT_KNOWN = true;
const DEFAULT_LAND_CAP = 300;
// Progress guard (see `fogMazeProgress`). The layer owns the tick while it is
// open and its column / advance scores outrank every capture, so an empire that
// is already ahead on land keeps its mass in one column and stops painting. The
// guard hands the frame back to the stock planner once that happens: `stall`
// turns without a new land record, or a latched land lead over the rival
// (`landLead` percent, 0 = never). Latched, because the round-5 traces show the
// lead re-opens and closes every few ticks and a predicate flaps.
const DEFAULT_STALL = 0;
const DEFAULT_STALL_TURN = 100;
const DEFAULT_LAND_LEAD = 0;
const DEFAULT_LAND_LEAD_TURN = 0;
// Land-drop guard (`BOT3_FOG_MAZE_DROP`, off by default). Hand the frame back
// once our land has fallen this far below its own record. The traced
// `anti/maze/fog+single` loss does not stall on a full frontier, it is eaten: 53
// land at tick 400 down to 19 at 580 while the layer keeps the lead stack in the
// corridor. The stock planner is what concentrated and won that board, so a
// collapse hands the frame back - but it is measured *worse* (anti 28/32 against
// 29/32 without it): the layer's early expansion is what wins the other anti
// games, and standing down mid-game loses more than it saves.
const DEFAULT_MAZEFOG3_DROP = 0;
// Paint before advance (`BOT3_MAZEFOG3`, off by default). The layer's column
// advance is 1000+ and every capture is 150+, so as soon as the goal field has
// a step the lead stack is allowed to take, it stops painting: the traced
// `anti/maze/fog+single` loss holds 49 land from turn 100 to 580 while 60+
// neutral cells stay open, and loses the attrition. The cap only applies to a
// column move that does *not* take land (a merge between our own cells) while
// the frontier still has a neutral cell to paint, so a corridor advance into
// neutral land or an attack is untouched.
const DEFAULT_MAZEFOG3_PAINT = 120;
const DEFAULT_PAINT_FROM = 8;
// Reserve per remaining step toward the objective: a fogged cell can hide any
// number of units and a corridor has no detour.
const DEFAULT_GUESS = 6;
// A forward neutral capture has to beat the own-merge march term (which caps
// near 230), because that term is what the traced frames spend the tick on.
const DEFAULT_CAPTURE = 150;
// Multi-line: how many distinct corridor branches the sixteen orders may spread
// over, and the reward for a move that walks one of them.
const DEFAULT_BRANCHES = 0;
const DEFAULT_BRANCH = 90;

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
function fogMazeConfig(overrides = {}, env = process.env) {
  // `BOT3_MAZEFOG3` is the round-7 bundle: the layer plus the paint cap that
  // removes its one measured regression (see `fogMazePaintCap`).
  const bundle = flag(env.BOT3_MAZEFOG3, false);
  return {
    enabled: overrides.enabled ?? (flag(env.BOT3_FOG_MAZE_LAYER, false) || bundle),
    maxBoard: overrides.maxBoard ?? number(env.BOT3_FOG_MAZE_BOARD, DEFAULT_MAX_BOARD, 1, 100000),
    startTurn: overrides.startTurn ?? number(env.BOT3_FOG_MAZE_TURN, DEFAULT_START_TURN, 0, 100000),
    // Objective while no rival crown is remembered.
    front: overrides.front ?? flag(env.BOT3_FOG_MAZE_FRONT, true),
    belief: overrides.belief ?? flag(env.BOT3_FOG_MAZE_BELIEF, DEFAULT_BELIEF),
    count: overrides.count ?? number(env.BOT3_FOG_MAZE_COUNT, DEFAULT_COUNT, 1, 8),
    ratio: overrides.ratio ?? number(env.BOT3_FOG_MAZE_RATIO, DEFAULT_RATIO, 0.1, 1),
    spread: overrides.spread ?? number(env.BOT3_FOG_MAZE_SPREAD, DEFAULT_SPREAD, 1, 100),
    // Column / expand.
    column: overrides.column ?? flag(env.BOT3_FOG_MAZE_COLUMN, true),
    guess: overrides.guess ?? number(env.BOT3_FOG_MAZE_GUESS, DEFAULT_GUESS, 0, 200),
    capture: overrides.capture ?? number(env.BOT3_FOG_MAZE_CAPTURE, DEFAULT_CAPTURE, 0, 10000),
    // Forward-only expansion stalls on a corridor dead end: the belief anchor is
    // reached, the goal field has a local minimum there and the stack merges
    // back and forth (traced in BOT3_MAZE.md). `deep` also rewards a neutral
    // capture that does not reduce the goal distance, so the empire keeps
    // opening vision from whatever branch it stands on.
    deep: overrides.deep ?? flag(env.BOT3_FOG_MAZE_DEEP, DEFAULT_DEEP),
    // Reward a plain attack on the visible rival frontier. On a corridor board
    // the rival column has to be met somewhere, and fog leaves no objective
    // beyond the frontier; a flat bonus converts contact into land without
    // dragging the whole goal field onto the contact point (which deadlocks the
    // endgame, see BOT3_MAZE.md).
    harass: overrides.harass ?? number(env.BOT3_FOG_MAZE_HARASS, DEFAULT_HARASS, 0, 10000),
    // Lane discipline (the maze layer's bookkeeping, which is off by default).
    lane: overrides.lane ?? flag(env.BOT3_FOG_MAZE_LANE, DEFAULT_LANE),
    // Multi-line branch spread.
    branches: overrides.branches ?? number(env.BOT3_FOG_MAZE_BRANCHES, DEFAULT_BRANCHES, 0, 16),
    branch: overrides.branch ?? number(env.BOT3_FOG_MAZE_BRANCH, DEFAULT_BRANCH, 0, 10000),
    // Stand down once the leaderboard army is this many percent of the rival's
    // (0 = never). The layer is for the even and losing corridor games; on the
    // weak-opponent cells it converts fast wins into 1000-tick timeouts.
    leadCap: overrides.leadCap ?? number(env.BOT3_FOG_MAZE_LEAD_CAP, 0, 0, 1000),
    // Only apply `leadCap` from this turn: the early expansion is worth keeping
    // even with a lead, and it is the *endgame* the layer cannot finish.
    leadTurn: overrides.leadTurn ?? number(env.BOT3_FOG_MAZE_LEAD_TURN, 0, 0, 100000),
    // Stand down as soon as a rival crown is remembered: from there the stock
    // path already has the only objective that ends the game and it finishes
    // better than the corridor expansion does (measured: the layer's losses on
    // the weak-opponent cells are all 1000-tick timeouts in games the baseline
    // wins at 295-794 ticks).
    known: overrides.known ?? flag(env.BOT3_FOG_MAZE_KNOWN, DEFAULT_KNOWN),
    // Stand down once we own this multiple of the rival's land (percent, 0 =
    // never). Land is the map-control measure in a corridor: holding twice the
    // rival's cells means the corridor race is won and the tick is better spent
    // finishing with the stock path than painting another branch.
    landCap: overrides.landCap ?? number(env.BOT3_FOG_MAZE_LAND_CAP, DEFAULT_LAND_CAP, 0, 1000),
    // Progress guard (see `fogMazeProgress`): ticks without a new land record,
    // and the latched land lead that hands the frame back to the stock planner.
    stall: overrides.stall ?? number(env.BOT3_FOG_MAZE_STALL, DEFAULT_STALL, 0, 100000),
    stallTurn: overrides.stallTurn ?? number(env.BOT3_FOG_MAZE_STALL_TURN, DEFAULT_STALL_TURN, 0, 100000),
    landLead: overrides.landLead ?? number(env.BOT3_FOG_MAZE_LAND_LEAD, DEFAULT_LAND_LEAD, 0, 1000),
    landLeadTurn:
      overrides.landLeadTurn ?? number(env.BOT3_FOG_MAZE_LAND_LEAD_TURN, DEFAULT_LAND_LEAD_TURN, 0, 100000),
    // Arm the paint cap only from this many neutral border cells (see
    // `fogMazePaintCap`).
    paintFrom: overrides.paintFrom ?? number(env.BOT3_FOG_MAZE_PAINT_FROM, DEFAULT_PAINT_FROM, 1, 1000),
    // Land-drop guard (see `fogMazeProgress`, 0 = off).
    drop: overrides.drop ?? number(env.BOT3_FOG_MAZE_DROP, bundle ? DEFAULT_MAZEFOG3_DROP : 0, 0, 1000),
    // Paint cap (see `fogMazePaintCap`, 0 = off). Score ceiling for a column
    // advance that does not take land while the frontier still has neutral
    // cells; it has to sit under `capture` (150) so painting wins the tick.
    paint: overrides.paint ?? number(env.BOT3_FOG_MAZE_PAINT, bundle ? DEFAULT_MAZEFOG3_PAINT : 0, 0, 10000),
    // Optional end of the layer's window (0 = until the game ends). The stock
    // path owns the very late game on these cells.
    endTurn: overrides.endTurn ?? number(env.BOT3_FOG_MAZE_END_TURN, DEFAULT_END_TURN, 0, 100000),
    // Hand the branch objective to `multi.js` as its focus route.
    route: overrides.route ?? flag(env.BOT3_FOG_MAZE_ROUTE, false),
  };
}

// Pick up to `count` frontier cells on distinct parts of the board: the visible
// rival frontier is measured information, the belief anchors are the prior over
// the unknown (see ./fog). `fogBeliefTargets` already spreads its anchors.
function fogMazeFront(cols, cells, count, spread) {
  const picks = [];
  for (const i of cells) {
    if (picks.length >= count) break;
    const row = Math.floor(i / cols),
      col = i % cols;
    const tooClose = picks.some(
      (p) => Math.abs(Math.floor(p / cols) - row) + Math.abs((p % cols) - col) < spread,
    );
    if (tooClose) continue;
    picks.push(i);
  }
  return picks;
}

// Objective cells for a fogged corridor board without a remembered crown.
function fogMazeObjective(b, input, config = fogMazeConfig()) {
  const enemies = Array.isArray(input?.enemies) ? input.enemies : [];
  const picks = [];
  if (config.front && enemies.length)
    picks.push(...fogMazeFront(b.cols, enemies, config.count, config.spread));
  if (config.belief) {
    const homes = Array.isArray(input?.homes) ? input.homes : [];
    if (homes.length) {
      const anchors = fogBeliefTargets(b, homes, {
        scoutRatio: config.ratio,
        scoutCount: config.count,
        scoutSpread: config.spread,
      });
      for (const i of anchors) {
        if (picks.length >= config.count * 2) break;
        if (!picks.includes(i)) picks.push(i);
      }
    }
  }
  return { targets: picks, source: picks.length ? (enemies.length ? 'front' : 'belief') : null };
}

// Progress guard. A latched, per-game ledger of how the layer is doing: it keeps
// the tick while it is still taking neutral cells and gives the frame back when
// it is not. `neutralFront` is the number of unowned cells on our own border, so
// a frontier with nothing left to paint latches immediately. `landLead` latches
// as soon as we own this multiple of the rival's land: from there the corridor
// race is won on land and the layer's column only converts the lead into an
// attrition it cannot finish. The latch is deliberate: the planner has no way to
// know whether the next tick would have broken the stall, and the stock path is
// what the baseline does on these boards.
function fogMazeProgress(b, input, config) {
  const turn = Number(input?.turn) || 0;
  const land = Number(input?.land) || 0;
  const enemyLand = Number(input?.enemyLand) || 0;
  const state = (b.fogMazeProgress ??= { best: -1, since: turn, stalled: false });
  if (state.stalled) return state;
  if (land > state.best) {
    state.best = land;
    state.since = turn;
  }
  if (
    config.landLead > 0 &&
    turn >= config.landLeadTurn &&
    enemyLand > 0 &&
    land * 100 > enemyLand * config.landLead
  )
    state.stalled = true;
  else if (turn < config.stallTurn) {
    // The opening is not the guard's business.
  } else if (Number(input?.neutralFront) === 0) state.stalled = true;
  else if (config.drop > 0 && state.best - land >= config.drop) state.stalled = true;
  else if (config.stall > 0 && turn - state.since >= config.stall) state.stalled = true;
  return state;
}

// Paint cap (see `DEFAULT_MAZEFOG3_PAINT`). Returns `Infinity` when the cap is
// off or the frontier has nothing left to paint, so the caller can use it as an
// unconditional `Math.min`. `neutral` is the number of neutral cells on our own
// border: the tick a corridor empire spends merging instead of painting those is
// the tick it stops growing vision, income and land. `paintFrom` is the branch
// count the rule is armed for: the traced regression had 60+ neutral cells open,
// so a handful of neutral cells next to a stack (the measured `anti` shape on
// this engine has 3-5) is not the shape the cap is meant to fix.
function fogMazePaintCap(config, neutral) {
  if (!(Number(config?.paint) > 0)) return Infinity;
  if (!(Number(neutral) >= Number(config.paintFrom ?? 1))) return Infinity;
  return Number(config.paint);
}

// The layer is a predicate, not a latch: a threat still takes the tick.
function fogMazeOpen(b, input, config = fogMazeConfig()) {
  if (!config.enabled) return false;
  if (input?.multi) return false;
  if (!(Number(input?.size) <= config.maxBoard)) return false;
  if ((Number(input?.turn) || 0) < config.startTurn) return false;
  return true;
}

module.exports = {
  fogMazeConfig,
  fogMazeObjective,
  fogMazeFront,
  fogMazeOpen,
  fogMazeProgress,
  fogMazePaintCap,
  DEFAULT_MAX_BOARD,
  DEFAULT_START_TURN,
  DEFAULT_END_TURN,
  DEFAULT_COUNT,
  DEFAULT_RATIO,
  DEFAULT_SPREAD,
  DEFAULT_GUESS,
  DEFAULT_CAPTURE,
  DEFAULT_DEEP,
  DEFAULT_HARASS,
  DEFAULT_LANE,
  DEFAULT_BELIEF,
  DEFAULT_KNOWN,
  DEFAULT_LAND_CAP,
  DEFAULT_STALL,
  DEFAULT_STALL_TURN,
  DEFAULT_LAND_LEAD,
  DEFAULT_LAND_LEAD_TURN,
  DEFAULT_MAZEFOG3_PAINT,
  DEFAULT_PAINT_FROM,
  DEFAULT_MAZEFOG3_DROP,
  DEFAULT_BRANCHES,
  DEFAULT_BRANCH,
};
