'use strict';

// City/economy snowball phase for large mediterranean rooms; on by default
// (APEX_CITY_SNOWBALL=0 disables, APEX_CITY_SNOWBALL_MODES overrides scope).
//
// Measurement (seeds 4, 2400 ticks, 0.68 rooms against Anti-Human) shows the
// bot wins the opening army race and then stops converting it: turn 900 is
// 2.20x army with 0.75x land, turn 1200 is 0.66x army with 0.35x land while the
// opponent holds 350-700 cells against our ~130. Branch telemetry for the same
// long games puts ~50% of all decisions in `march` (a 40+ cell convoy loop) and
// only ~6% in any expansion branch, so the land race is lost on action share,
// not on map geometry.
//
// Production in this engine is: crown +1/tick, plain/city +1 per 50 ticks.
// A built city is therefore NOT income - it is a cheap crown site (upgrade
// costs 50 instead of 100 from a plain) and a forward anchor that keeps the
// surrounding territory connected, which is exactly what the opponent uses to
// paint several hundred cells without losing them to a single cut.
//
// This module owns one coherent, bounded phase:
//
//   anchor - when the local rear holds a genuinely spare pool, spend it on a
//            forward city anchor (build the city, then upgrade the same cell)
//            instead of another rear crown floor.
//   paint  - spend the remaining phase ticks on land: neutral cells around our
//            anchors first, then thin enemy cells the opponent cannot defend,
//            so the opponent's land income (the actual production base in this
//            engine) stops compounding.
//   done   - explicit exit once land parity is reached, or as soon as the army
//            that pays for the phase is collapsing, or after a bounded span.
//
// The gate is the land deficit, not an army lead: in the 17 long 0.68 games the
// bot is already behind on army from tick 120 (702 vs 742) and behind on land
// at every checkpoint (turn 1200: 133 cells vs 448), while its crown count is
// level (24 vs 22). There is no army lead to spend in the games this phase
// exists for - what compounds against it is the opponent's land, so the phase
// is triggered by land and ends at land parity.
//
// Defence, immediate kills, the rush hold and the last-mile attack phase all
// stay above this layer: the planner only hands the phase a tick while the
// campaign is marching and is still far from the target crown.
//
// The phase is off by default; APEX_CITY_SNOWBALL=1 enables it.

const DEFAULT_MIN_BOARD = 800;
const DEFAULT_START_TURN = 300;
const DEFAULT_LAND_GAP = 0.8;
const DEFAULT_ARMY_FLOOR = 0.55;
const DEFAULT_EXIT_FLOOR = 0.45;
const DEFAULT_ANCHOR_SURPLUS = 120;
const DEFAULT_CAPTURE_GARRISON = 12;
const DEFAULT_ANCHORS = 2;
const DEFAULT_SPAN = 700;
// One window per tick while the phase is active. The phase is bounded by the
// span, the paint budget, the anchor budget and the army-collapse exit, so it
// cannot own the action budget for the whole game.
const DEFAULT_CADENCE = 1;
const DEFAULT_PAINT_BUDGET = 140;
const DEFAULT_LAND_SHARE = 0.3;
const DEFAULT_MIN_ENEMY_DISTANCE = 4;
const DEFAULT_PRESSURE_LIMIT = 6;
const DEFAULT_LAST_MILE = 12;

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

// Read from the environment on every call so tests and A/B runs can toggle the
// phase without reloading the planner.
function snowballConfig(overrides = {}, env = process.env) {
  return {
    enabled: overrides.enabled ?? flag(env.APEX_CITY_SNOWBALL, true),
    // The phase paid off on mediterranean (mirrored crown race) and lost a
    // win on anti archipelago when combined with the crown/land anchor, so
    // the default scope is mediterranean only. Comma-separated A/B override.
    modes: overrides.modes ??
      String(env.APEX_CITY_SNOWBALL_MODES || 'mediterranean').split(',').map((v) => v.trim()).filter(Boolean),
    minBoard: overrides.minBoard ??
      number(env.APEX_CITY_SNOWBALL_MIN_BOARD, DEFAULT_MIN_BOARD, 1, 100000),
    startTurn: overrides.startTurn ??
      number(env.APEX_CITY_SNOWBALL_TURN, DEFAULT_START_TURN, 0, 100000),
    // Entry/exit ratios. `landGap` is the own/enemy land share that opens the
    // phase; `armyFloor` and `exitFloor` are the army ratios that keep it
    // alive (below the floor the campaign must keep every tick).
    landGap: overrides.landGap ??
      number(env.APEX_CITY_SNOWBALL_LAND_GAP, DEFAULT_LAND_GAP, 0.1, 2),
    armyFloor: overrides.armyFloor ??
      number(env.APEX_CITY_SNOWBALL_ARMY_FLOOR, DEFAULT_ARMY_FLOOR, 0.1, 4),
    exitFloor: overrides.exitFloor ??
      number(env.APEX_CITY_SNOWBALL_EXIT_FLOOR, DEFAULT_EXIT_FLOOR, 0.1, 4),
    anchorSurplus: overrides.anchorSurplus ??
      number(env.APEX_CITY_SNOWBALL_ANCHOR_SURPLUS, DEFAULT_ANCHOR_SURPLUS, 0, 4000),
    captureGarrison: overrides.captureGarrison ??
      number(env.APEX_CITY_SNOWBALL_CAPTURE, DEFAULT_CAPTURE_GARRISON, 0, 400),
    anchors: overrides.anchors ??
      number(env.APEX_CITY_SNOWBALL_ANCHORS, DEFAULT_ANCHORS, 0, 12),
    span: overrides.span ?? number(env.APEX_CITY_SNOWBALL_SPAN, DEFAULT_SPAN, 20, 5000),
    cadence: overrides.cadence ??
      number(env.APEX_CITY_SNOWBALL_CADENCE, DEFAULT_CADENCE, 1, 12),
    paintBudget: overrides.paintBudget ??
      number(env.APEX_CITY_SNOWBALL_PAINT, DEFAULT_PAINT_BUDGET, 0, 4000),
    landShare: overrides.landShare ??
      number(env.APEX_CITY_SNOWBALL_LAND, DEFAULT_LAND_SHARE, 0.02, 1),
    minEnemyDistance: overrides.minEnemyDistance ??
      number(env.APEX_CITY_SNOWBALL_MIN_DISTANCE, DEFAULT_MIN_ENEMY_DISTANCE, 1, 20),
    pressureLimit: overrides.pressureLimit ??
      number(env.APEX_CITY_SNOWBALL_PRESSURE, DEFAULT_PRESSURE_LIMIT, 0, 400),
    lastMile: overrides.lastMile ??
      number(env.APEX_CITY_SNOWBALL_LAST_MILE, DEFAULT_LAST_MILE, 0, 100),
  };
}

// Entry is a single whole-board test: large, non-maze room, past the opening,
// clearly behind on land, and not already collapsing - below `armyFloor` the
// campaign must keep every tick because the opponent can finish us.
function snowballEntry(input, config) {
  if (!config.enabled) return false;
  if (!input || input.maze) return false;
  if (input.mode && Array.isArray(config.modes) && !config.modes.includes(input.mode)) return false;
  if (!(Number(input.size) >= config.minBoard)) return false;
  if (!(Number(input.turn) >= config.startTurn)) return false;
  const ownArmy = Number(input.ownArmy) || 0;
  const enemyArmy = Number(input.enemyArmy) || 0;
  if (enemyArmy <= 0 || ownArmy < enemyArmy * config.armyFloor) return false;
  const ownLand = Number(input.ownLand) || 0;
  const enemyLand = Number(input.enemyLand) || 0;
  if (enemyLand <= 0 || ownLand >= enemyLand * config.landGap) return false;
  return true;
}

// Explicit exit reasons. Once the phase ends it stays ended for the game: the
// planner latches `done` so a recovered lead cannot restart the same window.
//   lead    - the army that pays for the phase is collapsing.
//   span    - bounded phase length; economy work never owns the whole game.
//   secured - land parity reached, or the land target and paint budget spent.
function snowballExit(input, config) {
  if (!input) return 'state';
  const ownArmy = Number(input.ownArmy) || 0;
  const enemyArmy = Number(input.enemyArmy) || 0;
  if (enemyArmy > 0 && ownArmy < enemyArmy * config.exitFloor) return 'lead';
  if (Number(input.turn) - Number(input.startedTurn) > config.span) return 'span';
  const paints = Number(input.paints) || 0;
  const ownLand = Number(input.ownLand) || 0;
  const enemyLand = Number(input.enemyLand) || 0;
  const size = Number(input.size) || 0;
  const parity = enemyLand > 0 ? ownLand >= enemyLand : size > 0 && ownLand >= size * config.landShare;
  if (parity) return 'secured';
  if (paints >= config.paintBudget) return 'secured';
  return null;
}

// One decision window every `cadence` ticks while the phase is active. The
// campaign keeps the other ticks, so a long march still makes progress.
function snowballTurn(turn, config) {
  return Number(turn) % Math.max(1, config.cadence) === 0;
}

// Score one forward anchor site. Returns null when the cell is unusable, so the
// caller can filter candidates without duplicating the rules.
function anchorScore(input, config) {
  const kind = input?.kind;
  if (kind !== 'plain' && kind !== 'city') return null;
  const pressure = Number(input.pressure) || 0;
  if (pressure > config.pressureLimit) return null;
  const enemyDistance = Number(input.enemyDistance);
  if (!Number.isFinite(enemyDistance) || enemyDistance < config.minEnemyDistance) return null;
  const need = Number(input.need) || 0;
  const funds = Number(input.funds) || 0;
  if (funds < need) return null;
  const front = Number(input.frontDistance);
  const home = Number(input.homeDistance);
  const army = Number(input.army) || 0;
  return (
    (kind === 'city' ? 260 : 0) +
    (Number.isFinite(front) ? Math.max(0, 10 - front) * 26 : -40) +
    // Forward anchors keep the land we are trying to gain connected, so a site
    // closer to the front (down to the safe distance gate above) is worth more.
    (10 - Math.min(enemyDistance, 10)) * 14 +
    // Distance from home is only a weak tie-breaker: the campaign-head
    // distance above is the real "forward" signal when a march exists.
    (Number.isFinite(home) ? Math.min(home, 30) * 1.5 : 0) +
    Math.min(200, army) * 0.5 +
    Math.min(160, funds - need) * 0.15
  );
}

// Score one neutral land cell around a forward anchor. Returns null for cells
// that are not worth the tick: too close to the enemy (it is tapped back for
// free), unreachable from our anchors, or not empty.
function paintScore(input, config) {
  if (input?.owner !== 0) return null;
  if (input?.kind !== 'plain') return null;
  if (input?.isolated) return null;
  const enemyDistance = Number(input.enemyDistance);
  const anchorDistance = Number(input.anchorDistance);
  if (!Number.isFinite(anchorDistance)) return null;
  if (!Number.isFinite(enemyDistance) || enemyDistance < 3) return null;
  const room = Number(input.room) || 0;
  const enemyNeighbours = Number(input.enemyNeighbours) || 0;
  const army = Number(input.army) || 0;
  return (
    Math.max(0, 6 - anchorDistance) * 28 +
    (enemyDistance <= 9 ? (10 - enemyDistance) * 10 : 0) +
    Math.min(room, 4) * 12 +
    Math.min(enemyNeighbours, 3) * 22 +
    Math.min(80, army) * 0.1
  );
}

// The phase only interrupts a march that is still far from the target crown.
// The campaign's own label flips to `attack` for the whole approach, so only
// the distance matters here: a column inside the last mile must never be
// paused for economy work.
function snowballTakesTick(campaign, config) {
  if (!campaign) return true;
  const distance = Number(campaign.bestCrownDistance);
  if (Number.isFinite(distance) && distance <= config.lastMile) return false;
  return true;
}

// Score one thin enemy cell next to our frontier. Capturing it stops the
// opponent's compounding land income, and it is only taken when the source
// stack can pay the garrison twice over, so a failed push cannot eat a column.
function captureScore(input, config) {
  const garrison = Number(input?.garrison);
  if (!Number.isFinite(garrison) || garrison < 0) return null;
  if (garrison > config.captureGarrison) return null;
  const army = Number(input.army) || 0;
  if (army < garrison * 2 + 6) return null;
  const kind = input.kind;
  if (kind !== 'plain' && kind !== 'city') return null;
  return 120 - garrison * 4 + (kind === 'city' ? 90 : 0) + Math.min(60, army) * 0.4;
}

function freshSnowball() {
  return { phase: 'anchor', startedTurn: 0, anchors: 0, paints: 0, site: -1, misses: 0 };
}

module.exports = {
  snowballConfig,
  snowballEntry,
  snowballExit,
  snowballTurn,
  snowballTakesTick,
  anchorScore,
  paintScore,
  captureScore,
  freshSnowball,
  DEFAULT_MIN_BOARD,
  DEFAULT_START_TURN,
  DEFAULT_CADENCE,
};
