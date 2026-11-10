'use strict';

// Mediterranean crown-economy window (APEX_MED_PLAN=1, on by default;
// APEX_MED_PLAN=0 is the ablation).
//
// Diagnosis (seeds-8 official profile, opponent `apex`, 0.68 rooms, 2400 ticks,
// both seats).  Mediterranean is the only mode below 70% (17W/4D/11L over 32
// games; 7W/4D/5L on the large size, and the four draws are 2400-tick
// timeouts).  Per-tick traces of the losing large seeds show one shape: the
// crown economy stops dead in the mid game while the opponent's keeps
// compounding.
//
//   seed apex-long-2-mediterranean, seat 0 (loss at 1564)
//     tick   own crowns   enemy crowns   own army   enemy army
//      700           7             14       2080         2114
//     1000           6             16       2516         4780
//     1500           7             21       4427        11278
//
//   seed apex-long-3-mediterranean, seat 0 (loss at 747)
//     tick   own crowns   enemy crowns   own army   enemy army
//      100           5              4        664          732
//      300           2              6        984          982
//      700           1              7        619         2382
//
// Production in this engine is +1 army per tick per crown and +1 per 50 ticks
// per land cell, so a crown is 1/tick forever: 7 crowns against 21 is a 10/tick
// income deficit that no land or army ratio can pay back.  That is the army gap
// in the traces, not a supply or connectivity failure.
//
// The reason our crown count freezes is `sustainEconomy` in the planner: it
// abandons the crown project whenever the campaign head is within 24 cells of
// the nearest enemy crown, on the theory that such a head is "already within
// striking distance of the enemy core" and must not spend ticks on economy.
// Twenty-four cells is a large open-map constant.  A mediterranean room is an
// outer ring around a central sea: the 0.68 room is 891 cells with ~380 of them
// water, so the whole land extent is roughly one 30-cell perimeter and the head
// is within 24 cells of an enemy crown from tick ~300 onward, permanently.  From
// then on the bot neither builds crowns nor ever returns to the economy window,
// while the opponent's `enemyCrowns + 2` target keeps running because its own
// head is measured the same way but its army is intact.
//
// This module owns one rule: on mediterranean rooms the "near the core" reach is
// measured with the campaign boundary the rest of the bot already uses for the
// decisive phase (the last-mile range, 6 by default; 12 here for the approach)
// instead of the fixed 24-cell large-map radius.  Economy therefore yields only
// when a column is genuinely about to trade blows on its crown, which is the
// behaviour the guard was written for.
//
// Everything else stays as it is: the crown budget, the per-crown site gates,
// the campaign, defence, the kill-strike layer and the last mile are untouched,
// and the crown/land anchor keeps its random/archipelago scope (copying the
// opponent's crown count is still the right answer on a mirrored map - imposing
// the land anchor here measured -2 wins).
//
// Tuning (seeds 8, official sizes, 2400 ticks, both seats, opponent `apex`,
// mediterranean only - 32 games per row): the two release conditions were
// re-measured after the layer landed, because the remaining med draws were
// 2400-tick stalemates in which both sides held 25-30 crowns and the
// `enemyCrowns + 2` budget could therefore never be met:
//
//   off (main)                     17W/ 4D/11L
//   crownLead 2, dominance 1.35    21W/ 4D/ 7L, 20W/5D/7L, 19W/6D/7L
//   crownLead 2, dominance 1.60    22W/ 3D/ 7L
//   crownLead 2, dominance 1.15    19W/ 7D/ 6L
//   crownLead 1                    18W/ 5D/ 9L (also 16W/5D/11L with the
//                                              income exit below)
//   crownLead 3                    21W/ 4D/ 7L
//   income-parity exit (see below) 19W/ 5D/ 8L
//
// So the hold is worth more than its release, and the release was firing too
// early: 1.35x total army is the ordinary mid-game state on a ring, not a
// decided map.  `DEFAULT_DOMINANCE` is now 1.6 (still released immediately by
// a real finish, by an adjacent column and by the crown budget).  Shortening
// the crown budget (lead 1) or replacing it with an income-parity exit
// (`ownCrowns + ownLand/50 >= enemyCrowns + enemyLand/50`, tried as
// `APEX_MED_PLAN_INCOME`) both measured negative and were dropped.
//
// Full official profile, seeds 8, 2400 ticks, both seats: apex 90W/5D/33L
// against 85W/5D/38L without the layer (mediterranean 21W/4D/7L against
// 17W/4D/11L, 0.68 med 12W/3D/1L against 7W/4D/5L; every other mode within
// +-1 game of the ablation, which is the run-to-run floor on this box); anti
// 62W/32D/34L against 62W/24D/42L (mediterranean 14W/15D/3L against
// 14W/6D/12L - the same med wins, nine 0.68 losses becoming draws).
//
// Known cost, unchanged and documented in training/BASELINE.md: the held tick
// falls through to a full defence pass that the campaign would otherwise skip,
// so on a long 0.68 stalemate against anti p95 goes 38ms -> 76ms and ~2% of
// decisions reach the 80ms budget.  The next step is a cheap precheck for that
// defence pass (enemy stack near an anchor) rather than thinning the hold.

const DEFAULT_CORE_REACH = 24;
const DEFAULT_MED_REACH = 12;
const DEFAULT_CROWN_LEAD = 2;
const DEFAULT_START_TURN = 60;
const DEFAULT_HOLD_CADENCE = 1;
// The hold used to yield to the attack at 1.35x total army.  On a ring that is
// the ordinary mid-game state, so the race was abandoned exactly while the
// opponent's crown economy was still compounding: seeds 8, 0.68 mediterranean,
// 32 games, 22W/3D/7L at 1.6 against 21W/4D/7L, 20W/5D/7L and 19W/6D/7L at 1.35
// (and 19W/7D/6L at 1.15, 17W/8D/7L when the release was 1.15 with the income
// exit on).  A decisive finish is still released immediately - it now needs a
// 1.6x army instead of 1.35x.
const DEFAULT_DOMINANCE = 1.6;

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
// layer without reloading the planner.
function medPlanConfig(overrides = {}, env = process.env) {
  return {
    enabled: overrides.enabled ?? flag(env.APEX_MED_PLAN, true),
    modes: overrides.modes ??
      String(env.APEX_MED_PLAN_MODES || 'mediterranean').split(',').map((v) => v.trim()).filter(Boolean),
    minBoard: overrides.minBoard ??
      number(env.APEX_MED_PLAN_MIN_BOARD, 800, 1, 100000),
    // The reach below which the crown economy yields.  Defaults to the
    // last-mile approach boundary so economy stops exactly when a column starts
    // trading blows on its crown.
    reach: overrides.reach ??
      number(env.APEX_MED_PLAN_REACH, DEFAULT_MED_REACH, 2, DEFAULT_CORE_REACH),
    // The crown race owns the action budget until the crown economy has met the
    // budget it is itself chasing (`enemyCrowns + 2`).  Zero disables the hold
    // and restores the plain "grind at the nearest crown" behaviour.
    crownLead: overrides.crownLead ??
      number(env.APEX_MED_PLAN_CROWN_LEAD, DEFAULT_CROWN_LEAD, 0, 12),
    // The hold costs a defence pass on every tick it takes, and in the long
    // 0.68 stalemates this layer creates that pass dominates the decision
    // budget (p50 53ms against 7ms).  Holding on one tick in `cadence` keeps
    // the crown economy running while the campaign still advances on the
    // others, which also stops the race from becoming a 2400-tick draw.
    cadence: overrides.cadence ??
      number(env.APEX_MED_PLAN_HOLD_CADENCE, DEFAULT_HOLD_CADENCE, 1, 16),
    startTurn: overrides.startTurn ??
      number(env.APEX_MED_PLAN_TURN, DEFAULT_START_TURN, 0, 100000),
    dominance: overrides.dominance ??
      number(env.APEX_MED_PLAN_DOMINANCE, DEFAULT_DOMINANCE, 0.5, 4),
  };
}

// The distance from our campaign head to the nearest enemy crown at which the
// crown economy must yield.  Untouched (24) for every mode/size this layer does
// not own, which keeps the flag-off behaviour byte-identical.
function economyCoreReach(input, config) {
  const size = Number(input?.size);
  if (!config.enabled) return DEFAULT_CORE_REACH;
  if (!(size >= config.minBoard)) return DEFAULT_CORE_REACH;
  const mode = String(input?.mode ?? '');
  if (mode && Array.isArray(config.modes) && !config.modes.includes(mode)) return DEFAULT_CORE_REACH;
  return Math.min(DEFAULT_CORE_REACH, config.reach);
}

// True when the head is close enough to an enemy crown that the crown economy
// must yield to the attack.  `distance` is the head-to-nearest-enemy-crown
// distance; a non-finite distance means no crown is reachable at all, which the
// caller treats as "yield" as well.
function economyYields(input, config) {
  const reach = economyCoreReach(input, config);
  const distance = Number(input?.distance);
  if (!Number.isFinite(distance)) return { yields: true, reach, finite: false };
  return { yields: distance < reach, reach, finite: true };
}

// The mirrored race on a ring is decided by crowns, not by trades: both players
// earn ~1 army/tick/crown, so a column that trades one-for-one with the opponent
// gains nothing, while every crown captured or lost swings a full army/tick for
// the rest of the game.  In the losing large med seeds the bot marches its army
// away from 100 to 400 ticks before it has met the crown budget its own economy
// is chasing (`enemyCrowns + 2`), and ends the mid game at 7 crowns against 21
// with the two arms 4.4k against 11.3k.
//
// This gate keeps the crown race in the action budget until that budget is met:
// no new campaign is launched (and an existing campaign keeps its root and
// muster state untouched) while `ownCrowns < enemyCrowns + crownLead`.  Defence,
// the kill-strike layer and the last mile all stay above it in the planner, and a
// dominant army releases it immediately so a real finish is never postponed.
//
// `campaignDistance` may be a thunk: the live head-to-crown distance needs a
// board-wide field, so the planner defers building it until every cheap
// condition above has already passed.  Measured effect of the eager version was
// p95 43.8ms against 40.5ms for the same seeds.
function crownRaceHold(input, config) {
  if (!config.enabled) return false;
  if (!config.crownLead) return false;
  if (!(Number(input?.size) >= config.minBoard)) return false;
  if (input?.maze) return false;
  const mode = String(input?.mode ?? '');
  if (mode && Array.isArray(config.modes) && !config.modes.includes(mode)) return false;
  if (!(Number(input?.turn) >= config.startTurn)) return false;
  if (config.cadence > 1 && Number(input?.turn) % config.cadence !== 0) return false;
  const ownCrowns = Number(input?.ownCrowns) || 0;
  const enemyCrowns = Number(input?.enemyCrowns) || 0;
  if (enemyCrowns <= 0) return false;
  if (ownCrowns >= enemyCrowns + config.crownLead) return false;
  const ownArmy = Number(input?.ownArmy) || 0;
  const enemyArmy = Number(input?.enemyArmy) || 0;
  // A dominant army means the map is already decided: finish it.
  if (enemyArmy > 0 && ownArmy >= enemyArmy * config.dominance) return false;
  // A column that already stands next to its crown must be allowed to land:
  // holding it there stalemates the game at distance one instead of racing.
  const probe = input?.campaignDistance;
  const campaignDistance = Number(typeof probe === 'function' ? probe() : probe);
  if (Number.isFinite(campaignDistance) && campaignDistance <= config.reach) return false;
  return true;
}

module.exports = {
  medPlanConfig,
  economyCoreReach,
  economyYields,
  crownRaceHold,
  DEFAULT_CORE_REACH,
  DEFAULT_MED_REACH,
};
