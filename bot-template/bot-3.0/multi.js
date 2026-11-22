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
//   * focus: from `focusTurn` on, neutral captures are removed and moves that
//     shorten the garrison-weighted distance to the nearest enemy crown are
//     boosted by their stack mass, so the empire funnels into a column that
//     walks the crown distance field. Optional `skirmish` penalty removes
//     attacks on plain enemy cells that cannot end the game.
//
// The layer is off by default (`BOT3_MULTI=1` enables it) so the baseline path
// stays byte-identical. Every mechanism has its own switch; see MULTI.md for
// the measured effect of each one.

const BURST_END = 50;
const DEFAULT_MAX_BOARD = 800;
const DEFAULT_BURST_TURN = 25;
const DEFAULT_FOCUS_TURN = 51;
const DEFAULT_BURST_GAIN = 5;
const DEFAULT_BUILD_PENALTY = 220;
const DEFAULT_OUTWARD_GAIN = 5;
const DEFAULT_OUTWARD_BASE = 10;
const DEFAULT_MERGE_PENALTY = 0;
const DEFAULT_RAID_BONUS = 0;
const DEFAULT_PAINT_PENALTY = 1000;
const DEFAULT_MARCH_GAIN = 9;
const DEFAULT_MARCH_BASE = 60;
const DEFAULT_SKIRMISH_PENALTY = 0;
const DEFAULT_CROWN_BONUS = 0;

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
    burst: overrides.burst ?? flag(env.BOT3_MULTI_BURST, true),
    burstTurn: overrides.burstTurn ?? number(env.BOT3_MULTI_BURST_TURN, DEFAULT_BURST_TURN, 0, 1000),
    burstGain:
      overrides.burstGain ?? number(env.BOT3_MULTI_BURST_GAIN, DEFAULT_BURST_GAIN, 0, 200),
    outwardGain:
      overrides.outwardGain ?? number(env.BOT3_MULTI_OUTWARD, DEFAULT_OUTWARD_GAIN, 0, 200),
    outwardBase:
      overrides.outwardBase ?? number(env.BOT3_MULTI_OUTWARD_BASE, DEFAULT_OUTWARD_BASE, 0, 1000),
    mergePenalty:
      overrides.mergePenalty ?? number(env.BOT3_MULTI_MERGE, DEFAULT_MERGE_PENALTY, 0, 5000),
    raidBonus: overrides.raidBonus ?? number(env.BOT3_MULTI_RAID, DEFAULT_RAID_BONUS, 0, 5000),
    buildPenalty:
      overrides.buildPenalty ?? number(env.BOT3_MULTI_BUILD, DEFAULT_BUILD_PENALTY, 0, 5000),
    focus: overrides.focus ?? flag(env.BOT3_MULTI_FOCUS, true),
    focusTurn: overrides.focusTurn ?? number(env.BOT3_MULTI_FOCUS_TURN, DEFAULT_FOCUS_TURN, 0, 5000),
    paintPenalty:
      overrides.paintPenalty ?? number(env.BOT3_MULTI_PAINT, DEFAULT_PAINT_PENALTY, 0, 10000),
    marchGain: overrides.marchGain ?? number(env.BOT3_MULTI_MARCH, DEFAULT_MARCH_GAIN, 0, 200),
    marchBase: overrides.marchBase ?? number(env.BOT3_MULTI_MARCH_BASE, DEFAULT_MARCH_BASE, 0, 2000),
    skirmish:
      overrides.skirmish ?? number(env.BOT3_MULTI_SKIRMISH, DEFAULT_SKIRMISH_PENALTY, 0, 5000),
    crownBonus:
      overrides.crownBonus ?? number(env.BOT3_MULTI_CROWN, DEFAULT_CROWN_BONUS, 0, 5000),
    crownTurn: overrides.crownTurn ?? number(env.BOT3_MULTI_CROWN_TURN, DEFAULT_FOCUS_TURN, 0, 5000),
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

// One call per planning tick. Returns null when the layer has nothing to say,
// which keeps the planner on the exact baseline path.
function multiUpdate(b, input, config = multiConfig()) {
  if (!config.enabled) return null;
  if (!input || input.multi !== true) return null;
  if (!(Number(input.size) <= config.maxBoard)) return null;
  const turn = Math.max(0, Number(input.turn) || 0);
  const burst = config.burst && turn >= config.burstTurn && turn < BURST_END;
  const focus = config.focus && turn >= config.focusTurn;
  if (!burst && !focus) return null;
  const worth = burst ? BURST_END - turn : 0;
  let route = null;
  if (focus && Array.isArray(input.targets) && input.targets.length) {
    const scale = Math.max(3, (Number(input.mobileArmy) || 0) / 70);
    route = crownRoute(b, input.targets, input.units, input.teams, input.myTeam, scale);
  }
  const state = (b.multiLine ??= freshMulti());
  if (!state.entered) state.entered = { turn, burst, focus };
  state.ticks += 1;
  if (burst) state.burstTicks += 1;
  if (route) state.focusTicks += 1;
  return { config, turn, burst, worth, focus: route !== null, route, state };
}

// Score adjustments. `ctx` carries the arrays the planner already built, so
// nothing has to be recomputed here.
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
          config.burstGain * (plan.worth - Math.min(plan.worth, garrison)) +
          Math.min(24, opens * 3);
      } else if (to !== myTeam) {
        // Taking a rival cell during the burst is doubly valued: it stops the
        // rival's production on that cell and it earns ours for the rest of
        // the burst.
        if (config.raidBonus) op.score += config.raidBonus;
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
        continue;
      }
      if (route[op.to] < route[op.from]) {
        const mass = Math.max(0, units[op.from]);
        op.score +=
          config.marchBase + config.marchGain * Math.sqrt(mass) - Math.min(80, route[op.to] * 2);
      }
    }
  }
}

module.exports = {
  multiConfig,
  multiUpdate,
  applyMulti,
  crownRoute,
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
  DEFAULT_RAID_BONUS,
  DEFAULT_PAINT_PENALTY,
  DEFAULT_MARCH_GAIN,
  DEFAULT_MARCH_BASE,
  DEFAULT_SKIRMISH_PENALTY,
  DEFAULT_CROWN_BONUS,
};
