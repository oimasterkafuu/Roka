'use strict';

// Multi-line (16 orders per tick) layer for the Bot(3.0) 1v1 planner.
//
// Diagnosis. In multi-line rooms the planner keeps the exact serial policy:
// it scores every edge of the empire and emits the best (up to) sixteen
// disjoint ones. That is a *good* action chooser but a *bad* multi-line
// economy, because the value of an action is not the same as in a serial
// room. Two properties of the official rules drive the difference:
//
//   1. Burst economy (ticks 26..50): every normal owned plain cell produces
//      +1 army per tick. Land captured at tick t therefore still pays
//      `51 - t` army before the burst ends, while a 50-army crown built at
//      tick t only pays `51 - t` army *and* deletes the 50. A capture also
//      keeps its stack (the attack moves `units - 1` and the target keeps
//      whatever survives), so during the burst a capture strictly dominates
//      a build, and every stack parked at the back of the map is income that
//      is never converted. The serial policy still prefers a 105-195 build
//      over a 62 capture and only rewards an outward merge with
//      `14 + sqrt(send) * 4`, so the burst is where the land (and therefore
//      the army pool at tick 51) is lost.
//   2. After the burst there is no plain income at all: the army pool of both
//      sides is fixed and only crowns still produce (+1 per tick). The game
//      becomes a race to convert that pool into enemy crowns. Painting a
//      neutral cell then costs the garrison and yields one army per fifty
//      ticks, and a skirmish on a plain cell trades army for land that
//      produces nothing. The serial policy keeps scoring both (capture 32+,
//      skirmish 32-49), which in a sixteen-order tick is up to sixteen
//      wasted stacks per tick.
//
// Behaviour while the layer owns the scores (it never takes the frame over:
// defence, rescue, sieges and crown strikes keep their own, higher scores):
//   * burst: extra score for capturing a neutral cell, scaled by the army that
//     capture still earns before tick 51, and a large penalty on builds, so a
//     player with spare stacks paints instead of banking 50 army into a crown;
//     outward merges (toward our own frontier) are boosted so the next tick
//     still has sixteen stack-bearing captures available;
//   * raid: taking a rival cell during the burst is worth a flat bonus on top
//     of its capture, because that cell is income denied to the rival and
//     income gained for us for every remaining burst tick. This is the largest
//     single knob in the layer;
//   * focus: from `focusTurn` on, neutral captures are removed and a move down
//     the garrison-weighted crown distance field pays `marchBase` minus two per
//     remaining step (capped at eighty), so the empire gathers instead of
//     walking a thin column into the rival line before it can pay for the
//     crown. `marchGain` re-adds a mass-scaled bonus on top, which measured
//     *worse* than the plain distance penalty. Optional `skirmish` penalty
//     removes attacks on plain enemy cells that cannot end the game.
//   * cut: capturing an articulation cell of the rival territory severs it
//     from every rival anchor, which immediately halves the severed army and
//     stops its production (isolation), so those attacks are scored by the
//     army they cut off instead of by the cell they take. This is the cheapest
//     large swing available in a sixteen-order tick and it works during the
//     burst (a severed plain stops paying `51 - t` army) as well as after it.
//
// Fog gate (added in the round-3 combined screen). The burst prices a land race
// that the fog hides the rival half of: on `anti/archipelago/fog+multi` the
// layer painted 520 land against 413 while holding 58 army against 108 and lost
// a game the baseline won. Any single burst knob still loses that game; only
// releasing the burst whole restores the cell to 32/32. `burstFog` therefore
// drops the burst in a fog room while the leaderboard army says we are behind
// (`burstFogLead`, percent of the rival army). Measured on the 1024 multi
// games: the cell goes 31/1 -> 32/0, at the cost of 5 relay fog wins
// (archipelago -1, maze -1, random -4) and no cell below the baseline.
//
// Multi-line rooms no longer have the burst window. The old burst/focus layer
// measured worse than the generic path after the removal, so it is off by
// default; `BOT3_MULTI=1` enables the remaining focus phase for experiments.
// byte for byte. Every mechanism has its own switch; see MULTI.md for
// the measured effect of each one.

const BURST_END = 50;
const DEFAULT_MAX_BOARD = 800;
const DEFAULT_BURST_TURN = 25;
const DEFAULT_FOCUS_TURN = 51;
const DEFAULT_BURST_GAIN = 2;
const DEFAULT_BUILD_PENALTY = 220;
const DEFAULT_OUTWARD_GAIN = 5;
const DEFAULT_OUTWARD_BASE = 10;
// Measured defaults (see MULTI.md). The burst is where the game is decided:
// in the paired screen the win rate is 15% when our tick-50 army is below 0.9x
// the rival's and 97% when it is above 1.1x, so every knob below is tuned on
// army at tick 50. `marchGain` stays 0 because a mass-scaled march toward the
// rival crown scored *worse* than the plain distance penalty below it (152/256
// against 164/256): the winner of the burst walks in on its own schedule.
const DEFAULT_MERGE_PENALTY = 100;
// Percent of the rival army the burst gate below requires in a fog room.
const DEFAULT_BURST_FOG_LEAD = 100;
const DEFAULT_RAID_BONUS = 400;
const DEFAULT_PAINT_PENALTY = 1000;
const DEFAULT_MARCH_GAIN = 0;
const DEFAULT_MARCH_BASE = 15;
const DEFAULT_SKIRMISH_PENALTY = 0;
const DEFAULT_CROWN_BONUS = 0;
const DEFAULT_CUT_GAIN = 0;
const DEFAULT_CUT_CAP = 600;
const DEFAULT_FOCUS_RAID = 0;
const DEFAULT_MASS_GAIN = 0;

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
function multiConfig(overrides = {}, env = process.env) {
  return {
    enabled: overrides.enabled ?? flag(env.BOT3_MULTI, false),
    maxBoard: overrides.maxBoard ?? number(env.BOT3_MULTI_BOARD, DEFAULT_MAX_BOARD, 1, 100000),
    burst: overrides.burst ?? flag(env.BOT3_MULTI_BURST, false),
    // Fog rooms cannot price the burst: the rival half of the race is invisible,
    // so the capture/raid bonuses buy land that the endgame cannot convert. The
    // measured cost is one game in `anti/archipelago/fog+multi` (31/32 against
    // the recorded 32/32); disabling the burst there restores 32/32.
    burstFog: overrides.burstFog ?? flag(env.BOT3_MULTI_BURST_FOG, true),
    // In a fog room the burst is only kept while the leaderboard army says we
    // are not behind: the land the burst buys is worth the army pool it costs
    // only if the pool itself is not already losing. Percent of the rival army.
    burstFogLead:
      overrides.burstFogLead ?? number(env.BOT3_MULTI_BURST_FOG_LEAD, DEFAULT_BURST_FOG_LEAD, 0, 1000),
    burstTurn: overrides.burstTurn ?? number(env.BOT3_MULTI_BURST_TURN, DEFAULT_BURST_TURN, 0, 1000),
    burstGain: overrides.burstGain ?? number(env.BOT3_MULTI_BURST_GAIN, DEFAULT_BURST_GAIN, 0, 200),
    outwardGain: overrides.outwardGain ?? number(env.BOT3_MULTI_OUTWARD, DEFAULT_OUTWARD_GAIN, 0, 200),
    outwardBase: overrides.outwardBase ?? number(env.BOT3_MULTI_OUTWARD_BASE, DEFAULT_OUTWARD_BASE, 0, 1000),
    mergePenalty: overrides.mergePenalty ?? number(env.BOT3_MULTI_MERGE, DEFAULT_MERGE_PENALTY, 0, 5000),
    raidBonus: overrides.raidBonus ?? number(env.BOT3_MULTI_RAID, DEFAULT_RAID_BONUS, 0, 5000),
    buildPenalty: overrides.buildPenalty ?? number(env.BOT3_MULTI_BUILD, DEFAULT_BUILD_PENALTY, 0, 5000),
    focus: overrides.focus ?? flag(env.BOT3_MULTI_FOCUS, true),
    focusTurn: overrides.focusTurn ?? number(env.BOT3_MULTI_FOCUS_TURN, DEFAULT_FOCUS_TURN, 0, 5000),
    paintPenalty: overrides.paintPenalty ?? number(env.BOT3_MULTI_PAINT, DEFAULT_PAINT_PENALTY, 0, 10000),
    marchGain: overrides.marchGain ?? number(env.BOT3_MULTI_MARCH, DEFAULT_MARCH_GAIN, 0, 200),
    marchBase: overrides.marchBase ?? number(env.BOT3_MULTI_MARCH_BASE, DEFAULT_MARCH_BASE, 0, 2000),
    skirmish: overrides.skirmish ?? number(env.BOT3_MULTI_SKIRMISH, DEFAULT_SKIRMISH_PENALTY, 0, 5000),
    crownBonus: overrides.crownBonus ?? number(env.BOT3_MULTI_CROWN, DEFAULT_CROWN_BONUS, 0, 5000),
    crownTurn: overrides.crownTurn ?? number(env.BOT3_MULTI_CROWN_TURN, DEFAULT_FOCUS_TURN, 0, 5000),
    cut: overrides.cut ?? number(env.BOT3_MULTI_CUT, DEFAULT_CUT_GAIN, 0, 100),
    cutCap: overrides.cutCap ?? number(env.BOT3_MULTI_CUT_CAP, DEFAULT_CUT_CAP, 0, 5000),
    focusRaid: overrides.focusRaid ?? number(env.BOT3_MULTI_FOCUS_RAID, DEFAULT_FOCUS_RAID, 0, 5000),
    massGain: overrides.massGain ?? number(env.BOT3_MULTI_MASS, DEFAULT_MASS_GAIN, 0, 100),
  };
}

function freshMulti() {
  return { ticks: 0, burstTicks: 0, focusTicks: 0, entered: null };
}

// Garrison-weighted distance to the nearest enemy crown. Same relaxation as the
// planner's `campaignRoute` (pay two ticks per step plus the defender's army in
// units of one stack), only anchored on the crowns we actually want to end the
// game with instead of on every frontier.
function crownRoute(b, targets, units, teams, myTeam, scale) {
  const INF = 1e6;
  const distance = new Int32Array(b.size).fill(INF);
  const buckets = [[...targets]];
  for (const i of targets) distance[i] = 0;
  for (let cost = 0; cost < buckets.length; cost++) {
    for (const i of buckets[cost] ?? []) {
      if (distance[i] !== cost) continue;
      const resistance = teams[i] === myTeam ? 0 : Math.min(24, Math.floor(units[i] / scale));
      const next = cost + 2 + resistance;
      for (const j of b.neighbors[i]) {
        if (b.grid_type[j] === 201 || next >= distance[j]) continue;
        distance[j] = next;
        (buckets[next] ??= []).push(j);
      }
    }
  }
  return distance;
}

// The rival team is the non-own team that owns the most visible cells (1v1
// rooms have exactly one, FFA rooms get the largest one).
function rivalTeam(input) {
  const teams = input.teams;
  if (!teams) return 0;
  let best = 0,
    bestCount = 0;
  const count = new Map();
  for (let i = 0; i < teams.length; i++) {
    const team = teams[i];
    if (!team || team === input.myTeam) continue;
    const c = (count.get(team) ?? 0) + 1;
    count.set(team, c);
    if (c > bestCount) {
      best = team;
      bestCount = c;
    }
  }
  return best;
}

// Army that the rival loses if we take cell `i`: the same subtree accounting
// as the planner's `supplyCuts`, rooted at the rival anchors and weighted by
// the rival's garrisons plus the two units a plain pays per burst tick.
function teamCuts(b, teams, units, team) {
  const lost = new Float64Array(b.size);
  const order = new Int32Array(b.size),
    low = new Int32Array(b.size);
  const parent = new Int32Array(b.size).fill(-1),
    cursor = new Uint8Array(b.size);
  const weight = new Float64Array(b.size);
  const anchor = (tile) => tile >= 50 && tile < 150;
  let time = 0;
  const roots = [];
  for (let i = 0; i < b.size; i++) if (teams[i] === team && anchor(b.grid_type[i])) roots.push(i);
  if (!roots.length) for (let i = 0; i < b.size; i++) if (teams[i] === team) roots.push(i);
  for (const root of roots) {
    if (order[root]) continue;
    const stack = [root];
    order[root] = ++time;
    while (stack.length) {
      const i = stack.at(-1);
      const adj = b.neighbors[i];
      if (cursor[i] < adj.length) {
        const j = adj[cursor[i]++];
        if (teams[j] !== teams[i] || b.isolated[j] || j === parent[i]) continue;
        if (order[j]) low[i] = Math.min(low[i], order[j]);
        else {
          parent[j] = i;
          order[j] = ++time;
          low[j] = anchor(b.grid_type[j]) ? 0 : order[j];
          stack.push(j);
        }
      } else {
        stack.pop();
        weight[i] += units[i] + 2;
        const p = parent[i];
        if (p >= 0) {
          if (low[i] >= order[p]) lost[p] += weight[i];
          low[p] = Math.min(low[p], low[i]);
          weight[p] += weight[i];
        }
      }
    }
  }
  return lost;
}

// One call per planning tick. Returns null when the layer has nothing to say,
// which keeps the planner on the exact baseline path.
function multiUpdate(b, input, config = multiConfig()) {
  if (!config.enabled) return null;
  if (!input || input.multi !== true) return null;
  if (!(Number(input.size) <= config.maxBoard)) return null;
  const turn = Math.max(0, Number(input.turn) || 0);
  // Whether the burst may spend slots on breadth instead of concentration. A
  // fog room normally drops the burst while the army race is lost; `./fog-multi`
  // prices that trade by the land race instead and passes its verdict as
  // `input.fogBurst` (`undefined` keeps the gate below untouched).
  const army = Math.max(0, Number(input.army) || 0);
  const enemyArmy = Math.max(0, Number(input.enemyArmy) || 0);
  const fogBurst =
    input.fogBurst !== undefined
      ? input.fogBurst !== false
      : !config.burstFog || input.fog !== true
        ? true
        : !config.burstFogLead || enemyArmy <= 0 || army * 100 >= enemyArmy * config.burstFogLead;
  const burst = config.burst && fogBurst && turn >= config.burstTurn && turn < BURST_END;
  const focus = config.focus && turn >= config.focusTurn;
  if (!burst && !focus) return null;
  const worth = burst ? BURST_END - turn : 0;
  // The focus block scores moves against the crown distance field, so it needs a
  // rival crown to anchor on: without one (fog rooms that have not seen a crown
  // yet) the layer falls back to the fog multi objective, which is the visible
  // rival frontier or the belief anchors handed over by ./fog-multi.
  let route = null;
  if (focus) {
    const scale = Math.max(3, (Number(input.mobileArmy) || 0) / 70);
    if (Array.isArray(input.targets) && input.targets.length)
      route = crownRoute(b, input.targets, input.units, input.teams, input.myTeam, scale);
    else if (Array.isArray(input.fogTargets) && input.fogTargets.length)
      route = crownRoute(b, input.fogTargets, input.units, input.teams, input.myTeam, scale);
  }
  const enemyCut =
    config.cut > 0 && (burst || focus) ? teamCuts(b, input.teams, input.units, rivalTeam(input)) : null;
  const state = (b.multiLine ??= freshMulti());
  if (!state.entered) state.entered = { turn, burst, focus };
  state.ticks += 1;
  if (burst) state.burstTicks += 1;
  if (route) state.focusTicks += 1;
  return { config, turn, burst, worth, focus: route !== null, route, enemyCut, state };
}

// Score adjustments. `ctx` carries the arrays the planner already built, so
// nothing has to be recomputed here.
function cutBonus(plan, config, to) {
  const value = plan.enemyCut[to];
  if (!value) return 0;
  return Math.min(config.cutCap, Math.sqrt(value) * config.cut);
}

function applyMulti(plan, ctx, candidates) {
  const { config } = plan;
  const { tile, teams, units, neighbors, myTeam, frontDist } = ctx;
  if (plan.burst) {
    for (const op of candidates) {
      if (op.build) {
        op.score -= config.buildPenalty;
        continue;
      }
      const to = teams[op.to];
      if (!to) {
        // A capture still pays `worth` army before the burst ends and costs the
        // target's garrison, so only a garrison cheaper than the remaining
        // burst is worth an order. Expensive cells are left to the late game.
        const garrison = Math.max(0, units[op.to]);
        const opens = neighbors[op.to].filter((k) => tile[k] !== 201 && !teams[k]).length;
        op.score +=
          config.burstGain * (plan.worth - Math.min(plan.worth, garrison)) + Math.min(24, opens * 3);
      } else if (to !== myTeam) {
        // Taking a rival cell during the burst is doubly valued: it stops the
        // rival's production on that cell and it earns ours for the rest of
        // the burst.
        if (config.raidBonus) op.score += config.raidBonus;
        if (plan.enemyCut) op.score += cutBonus(plan, config, op.to);
      } else if (to === myTeam) {
        // Breadth beats depth while the burst is running: one cell can issue a
        // single order per tick, so stacking a frontier cell costs a slot and
        // buys nothing, while an unused neutral neighbour is a cell that never
        // produces again. Defence, rescue and crown work keep their own, much
        // higher scores.
        if (config.mergePenalty) op.score -= config.mergePenalty;
        if (frontDist && frontDist[op.to] < frontDist[op.from]) {
          const mass = Math.max(0, units[op.from]);
          op.score += Math.min(160, config.outwardBase + Math.sqrt(mass) * config.outwardGain);
        }
      }
    }
  }
  if (plan.focus) {
    const route = plan.route;
    for (const op of candidates) {
      if (op.build) {
        if (plan.turn >= config.crownTurn) op.score += config.crownBonus;
        continue;
      }
      const to = teams[op.to];
      if (!to) {
        op.score -= config.paintPenalty;
        continue;
      }
      if (to !== myTeam) {
        if (config.skirmish && !(tile[op.to] >= 100 && tile[op.to] < 150)) {
          op.score -= config.skirmish;
        }
        if (config.focusRaid) op.score += config.focusRaid;
        if (plan.enemyCut) op.score += cutBonus(plan, config, op.to);
        continue;
      }
      if (config.massGain && units[op.to] > units[op.from])
        op.score += Math.min(200, config.massGain * Math.sqrt(units[op.to]));
      if (route[op.to] < route[op.from]) {
        const mass = Math.max(0, units[op.from]);
        op.score += config.marchBase + config.marchGain * Math.sqrt(mass) - Math.min(80, route[op.to] * 2);
      }
    }
  }
}

module.exports = {
  multiConfig,
  multiUpdate,
  applyMulti,
  crownRoute,
  teamCuts,
  rivalTeam,
  freshMulti,
  BURST_END,
  DEFAULT_MAX_BOARD,
  DEFAULT_BURST_TURN,
  DEFAULT_FOCUS_TURN,
  DEFAULT_BURST_GAIN,
  DEFAULT_BUILD_PENALTY,
  DEFAULT_OUTWARD_GAIN,
  DEFAULT_OUTWARD_BASE,
  DEFAULT_MERGE_PENALTY,
  DEFAULT_BURST_FOG_LEAD,
  DEFAULT_RAID_BONUS,
  DEFAULT_PAINT_PENALTY,
  DEFAULT_MARCH_GAIN,
  DEFAULT_MARCH_BASE,
  DEFAULT_SKIRMISH_PENALTY,
  DEFAULT_CROWN_BONUS,
  DEFAULT_CUT_GAIN,
  DEFAULT_CUT_CAP,
  DEFAULT_FOCUS_RAID,
  DEFAULT_MASS_GAIN,
};
