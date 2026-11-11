'use strict';

// Small-map crown-race (attrition) phase for the 0.34 room.
// `APEX_SMALL_CROWN_RACE=1`, off by default; `=0` is the ablation.
//
// Diagnosis.  On a compact room (0.34 is 221-255 cells, one or two screens) the
// decisive quantity is production, not a breakthrough: income is +1 army/tick
// per crown and +1 per 50 ticks per land cell, so both terms are income and a
// room where the opponent paints twice our land and keeps adding crowns while
// our columns trade one-for-one ends in a slow army collapse.
//
// Two user replays on 0.34 (same code, opponent Anti-Human) show both shapes,
// crowns/land/army at displayed turn 40/60/80/100 (engine ticks are 2x):
//
//   GM23HTGqA0co (win): own 1/34/416 -> 3/34/611 -> 4/31/517 -> 5/34/400
//                       enemy 1/32/386 -> 1/52/801 -> 1/70/750 -> 1/79/753
//     We kept minting crowns (1 -> 5, income 5 + 34/50 = 5.7) while the
//     opponent's land could not pay for its army (1 + 79/50 = 2.6); the
//     attrition we won was the crown economy.  This layer must not touch it.
//
//   UD+iTGBQG2ZS (loss): own 1/34/416 -> 3/34/611 -> 3/37/658 -> 3+2c/40/613
//                        enemy 1/30/356 -> 1/50/749 -> 2+1c/61/613 -> 3/60/583
//     Our land froze at 34-40 from turn 50 onward while the opponent painted
//     30 -> 60 -> 91 and finished with 7 crowns and 4 cities against a dead
//     bot.  Note the crown counts were level until turn 100: the loss is the
//     land/income race, and the crown count only follows it.
//
// Evaluation harness (0.34, seeds 8, both seats, 64 games per opponent) shows
// the same population shape: from tick 60 on the opponent holds 2x our land and
// our crown count plateaus at ~4.6 while its count keeps climbing
// (1.0 -> 3.4 crowns by tick 240).  In that sample the opponent out-builds us
// in the crown budget the bot itself chases (`ownCrowns < enemyCrowns + 2`) in
// a third of the games, and those games are won 33% of the time against 68% for
// the rest, which is the state this layer is for.
//
// Entry (all of, checked in the tick 40-80 window this phase is bounded to):
//
//   * compact room below 800 cells, and not a maze: corridors already bound how
//     much ground either side can paint, so a land deficit there is not the
//     open-room race (the crown/land anchor uses the same exclusion; gating
//     maze out reverted three corridor wins this phase had flipped);
//   * the crown budget is unmet (`ownCrowns < enemyCrowns + 2`);
//   * the opponent's economy is ahead: income (crowns + land/50) below 90% of
//     the opponent's, and our land below 80% of its land.  Land is production
//     here, and this pair is what separates the anti losses (it paints) from
//     the apex games we win (it builds crowns next to its own core).  Measured
//     on the seeds-8 0.34 sets: 16 anti games (10 losses, 6 wins) and 6 apex
//     games, all of them losses;
//   * the opponent's army is the stronger one.  With an equal or bigger army
//     the map is ours to press, and an economy race only concedes tempo;
//   * our attacks have not converted for 40 ticks (no enemy crown lost) and no
//     campaign column is already inside its crown's reach.
//
// The first cut of this layer only required "crown budget unmet and income
// behind" and entered ~30 games in the opening: anti 42 -> 50 wins but apex
// 46 -> 37.  The army gate and the maze exclusion are what make it selective
// (8 entries in 128 games), and the measured effect of this version is anti
// 42 -> 45 wins with apex unchanged at 46 (seeds 8, 0.34, both seats).
//
// Behaviour while the phase owns the budget:
//
//   * no new campaign claims it (the root/muster state is kept, so the push
//     resumes untouched when the phase ends),
//   * crown construction runs first (rear crown project and the compact
//     cluster, with the budget raised to the crown race),
//   * safe neutral land is painted on the same budget (land is income here),
//   * low-value attack branches (frontier strike, strategic cut) are withheld,
//     while defence, the kill-strike layer and the tactical crown finish stay
//     above the phase, so a real finish is never postponed.
//
// Exit is immediate on any of: crown budget met with army parity (the race is
// won), a column already within striking distance of its crown (pressure may
// resume), the opponent overtaking us in crowns (attacking its crowns is then
// the only route left), or the bounded span expiring.  The phase latches once.

const DEFAULT_MAX_BOARD = 800;
const DEFAULT_START_TURN = 40;
const DEFAULT_ENTRY_END = 80;
const DEFAULT_SPAN = 120;
const DEFAULT_CROWN_LEAD = 2;
const DEFAULT_RATE = 2;
const DEFAULT_SAMPLE = 40;
const DEFAULT_INCOME = 0.9;
const DEFAULT_LAND = 0.8;
// 1.0: the opponent must not have the smaller army.  At 1.25 the phase entered
// games where our army was already ahead and cost apex two archipelago wins
// (seeds 8, 0.34); the anti gains are unaffected by the tighter gate.
const DEFAULT_DOMINANCE = 1;
const DEFAULT_PARITY = 0.9;
const DEFAULT_STALE = 40;
const DEFAULT_REACH = 6;
// Engine fact (src/game-engine/tick-growth.ts): a land cell is +1 army per
// LAND_INCOME_TICKS ticks, so crowns and land share one income unit.
const LAND_INCOME_TICKS = 50;

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
function smallRaceConfig(overrides = {}, env = process.env) {
  return {
    enabled: overrides.enabled ?? flag(env.APEX_SMALL_CROWN_RACE, false),
    // 0.34 rooms are 221-255 cells; 0.68 is 891-957.  800 is the same boundary
    // the rest of the bot already uses for "compact board".
    maxBoard: overrides.maxBoard ??
      number(env.APEX_SMALL_RACE_BOARD, DEFAULT_MAX_BOARD, 1, 100000),
    startTurn: overrides.startTurn ??
      number(env.APEX_SMALL_RACE_TURN, DEFAULT_START_TURN, 0, 100000),
    // The entry window closes before the mid game: after it the map is either
    // decided or the remaining games need the normal campaign, not a race.
    // Entries after tick 80 flipped games the bot was about to finish.
    entryEnd: overrides.entryEnd ??
      number(env.APEX_SMALL_RACE_ENTRY_END, DEFAULT_ENTRY_END, 0, 100000),
    // Bounded phase length.  A race that cannot restore parity in this window
    // has failed and hands the budget back.
    span: overrides.span ??
      number(env.APEX_SMALL_RACE_SPAN, DEFAULT_SPAN, 20, 600),
    crownLead: overrides.crownLead ??
      number(env.APEX_SMALL_RACE_LEAD, DEFAULT_CROWN_LEAD, 0, 12),
    // Crowns the opponent may build above ours inside one sample window.  This
    // is recorded on the entry and used by the diagnostics, but it does not
    // gate the phase: on 0.34 the opponent out-builds us in crowns in games we
    // still win (it spends the same army on cheap outposts while we strike),
    // and gating on it added three apex wins to the entry set.
    rate: overrides.rate ??
      number(env.APEX_SMALL_RACE_RATE, DEFAULT_RATE, 0, 12),
    sample: overrides.sample ??
      number(env.APEX_SMALL_RACE_SAMPLE, DEFAULT_SAMPLE, 10, 200),
    // Income = crowns + land/50.  Below this fraction of the opponent's income
    // the economy term of the race is lost.
    income: overrides.income ??
      number(env.APEX_SMALL_RACE_INCOME, DEFAULT_INCOME, 0.2, 1.5),
    // Structural land gate: the opponent must hold at least this much more
    // ground than we do (``ownLand < enemyLand * land``).  Land is production
    // here, and this is the term that separates the anti losses (it paints)
    // from the apex games we win (it builds crowns next to its own core): with
    // the gate every apex entry was a game the bot was already losing.
    land: overrides.land ??
      number(env.APEX_SMALL_RACE_LAND, DEFAULT_LAND, 0.2, 2),
    dominance: overrides.dominance ??
      number(env.APEX_SMALL_RACE_DOMINANCE, DEFAULT_DOMINANCE, 0.5, 4),
    parity: overrides.parity ??
      number(env.APEX_SMALL_RACE_PARITY, DEFAULT_PARITY, 0.2, 2),
    stale: overrides.stale ??
      number(env.APEX_SMALL_RACE_STALE, DEFAULT_STALE, 0, 400),
    reach: overrides.reach ??
      number(env.APEX_SMALL_RACE_REACH, DEFAULT_REACH, 2, 24),
    landTicks: overrides.landTicks ?? LAND_INCOME_TICKS,
  };
}

function freshSmallRace() {
  return {
    active: false,
    done: false,
    started: 0,
    samples: [],
    lastEnemyCrowns: undefined,
    lastCapture: undefined,
    entries: 0,
    entry: null,
    exit: null,
  };
}

function smallRaceIncome(crowns, land, landTicks = LAND_INCOME_TICKS) {
  return Number(crowns) + Number(land) / Math.max(1, Number(landTicks) || LAND_INCOME_TICKS);
}

function readDistance(probe) {
  const value = Number(typeof probe === 'function' ? probe() : probe);
  return Number.isFinite(value) ? value : Infinity;
}

// One call per planning tick.  `state` is the bot's `m.smallRace`; `input`
// carries the observed board and the (lazy) campaign head distance.  Returns the
// decision the planner acts on; the state is mutated in place so the phase
// survives between ticks.
function smallRaceUpdate(state, input, config) {
  // Disabled or out-of-scope boards stay completely out of the way: no samples
  // are recorded, so enabling the flag mid-game cannot replay a stale race.
  if (!config?.enabled) return { active: false, done: Boolean(state?.done), state };
  if (!(Number(input?.size) < config.maxBoard)) return { active: false, done: Boolean(state?.done), state };
  const turn = Number(input?.turn) || 0;
  const ownCrowns = Number(input?.ownCrowns) || 0;
  const enemyCrowns = Number(input?.enemyCrowns) || 0;
  const ownLand = Number(input?.ownLand) || 0;
  const enemyLand = Number(input?.enemyLand) || 0;
  const ownArmy = Number(input?.ownArmy) || 0;
  const enemyArmy = Number(input?.enemyArmy) || 0;

  // Crown captures are the only progress signal that matters in a race: an
  // enemy crown count that drops means one of our columns actually landed.
  if (Number.isFinite(state.lastEnemyCrowns) && enemyCrowns < state.lastEnemyCrowns) {
    state.lastCapture = turn;
  }
  state.lastEnemyCrowns = enemyCrowns;
  state.samples.push({ turn, own: ownCrowns, enemy: enemyCrowns });
  while (state.samples.length && turn - state.samples[0].turn > config.sample) state.samples.shift();
  const baseline = state.samples.length && turn - state.samples[0].turn >= config.sample
    ? state.samples[0]
    : null;
  const ownBuilt = baseline ? ownCrowns - baseline.own : null;
  const enemyBuilt = baseline ? enemyCrowns - baseline.enemy : null;

  const incomeOwn = smallRaceIncome(ownCrowns, ownLand, config.landTicks);
  const incomeEnemy = smallRaceIncome(enemyCrowns, enemyLand, config.landTicks);
  const budgetMet = ownCrowns >= enemyCrowns + config.crownLead;
  const stale = !Number.isFinite(state.lastCapture) || turn - state.lastCapture >= config.stale;
  const dominant = enemyArmy > 0 && ownArmy >= enemyArmy * config.dominance;

  // Cheap conversions outrank the race: a column already inside its crown's
  // reach, or a finish that is about to remove the last enemy crowns, must be
  // allowed to land.  The distance probe is lazy (a board-wide BFS) and only
  // paid for once every cheap condition has passed.
  const cheap = () => readDistance(input?.campaignDistance) <= config.reach;

  if (state.active) {
    let exit = null;
    if (budgetMet && ownArmy >= enemyArmy * config.parity) exit = 'crown-parity';
    else if (cheap()) exit = 'crown-exposed';
    else if (ownCrowns + config.crownLead <= enemyCrowns) exit = 'enemy-lead';
    else if (turn - state.started >= config.span) exit = 'span';
    if (exit) {
      state.active = false;
      state.done = true;
      state.exit = exit;
    }
  } else if (!state.done) {
    const inWindow = turn >= config.startTurn && turn <= config.entryEnd;
    // Corridor maps bound how much ground either side can paint, so a land
    // deficit there is not the open-room economy race this layer is for (the
    // crown/land anchor makes the same exclusion).  Measured: the maze entries
    // flipped three of the anti maze wins the corridor play already earns.
    if (inWindow && !input?.maze && enemyCrowns > 0 && stale && !dominant) {
      const crownDeficit = ownCrowns < enemyCrowns;
      const rateDeficit = Number.isFinite(enemyBuilt) && enemyBuilt - ownBuilt >= config.rate;
      const incomeDeficit = incomeEnemy > 0 && incomeOwn < incomeEnemy * config.income;
      const landDeficit = enemyLand > 0 && ownLand < enemyLand * config.land;
      // Crown budget unmet on its own is the ordinary 0.34 opening (both sides
      // hold one crown, then we build two or three); the phase needs the
      // economy term to be lost as well: income below the opponent and a
      // structural land deficit, i.e. the opponent is out-building the crown
      // economy we are chasing, not just trading stacks with us.
      const deficit = !budgetMet && incomeDeficit && landDeficit;
      if (deficit && !cheap()) {
        state.active = true;
        state.started = turn;
        state.entries += 1;
        state.entry = {
          turn,
          crownDeficit,
          rateDeficit,
          incomeDeficit,
          landDeficit,
          ownBuilt,
          enemyBuilt,
          ownCrowns,
          enemyCrowns,
          ownLand,
          enemyLand,
          ownArmy,
          enemyArmy,
          incomeOwn,
          incomeEnemy,
        };
      }
    }
  }

  return {
    active: state.active,
    done: state.done,
    started: state.started,
    entry: state.entry,
    exit: state.exit,
    incomeOwn,
    incomeEnemy,
    ownBuilt,
    enemyBuilt,
  };
}

// The rear crown project (`sustainEconomy`) yields as soon as the campaign head
// is within the 24-cell large-map radius of an enemy crown.  A 0.34 room is
// smaller than that radius end to end, so the project was permanently frozen
// there.  While the race phase owns the budget the yield boundary becomes the
// last-mile reach instead: economy stops only when a column is about to trade
// blows on its crown.
function smallRaceEconomyRelief(state, distance, config) {
  if (!state?.active) return false;
  const value = Number(distance);
  if (!Number.isFinite(value)) return false;
  return value >= config.reach;
}

module.exports = {
  smallRaceConfig,
  smallRaceUpdate,
  smallRaceIncome,
  smallRaceEconomyRelief,
  freshSmallRace,
  LAND_INCOME_TICKS,
  DEFAULT_MAX_BOARD,
  DEFAULT_START_TURN,
  DEFAULT_ENTRY_END,
  DEFAULT_SPAN,
  DEFAULT_CROWN_LEAD,
  DEFAULT_RATE,
  DEFAULT_SAMPLE,
  DEFAULT_INCOME,
  DEFAULT_LAND,
  DEFAULT_DOMINANCE,
  DEFAULT_PARITY,
  DEFAULT_STALE,
  DEFAULT_REACH,
};
