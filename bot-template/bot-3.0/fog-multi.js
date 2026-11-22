'use strict';

// Fog + multi-line layer for the Bot(3.0) 1v1 planner.
//
// Diagnosis. In a fog multi-line room neither of the two layers that price the
// room is in charge, and what is left is the serial action policy applied
// sixteen times per tick. Two defects, one per phase:
//
//   1. The burst gate is priced on the wrong quantity. `multi.js` sets the
//      burst (ticks 26..50, the land race that fixes the army pool both sides
//      fight the rest of the game with) aside in *every* fog room while the
//      leaderboard army says we are behind (`burstFog`/`burstFogLead`). That
//      gate was measured on one game, `anti/archipelago/fog+multi`, where
//      bursting paints 520 land against 413 while holding 58 army against 108.
//      But the burst is a *land* race: on that board we already own twice the
//      rival's land when the gate fires, so there is nothing left to win and
//      the burst only spends garrisons - while on the relay fog rooms we are
//      level or behind on land and dropping the burst is exactly what loses the
//      pool. Releasing the burst by the land race instead is +6 wins over the
//      four relay fog multi cells (mediterranean +2, random +4, archipelago and
//      maze unchanged) with every other cell of the 2048-game matrix unchanged,
//      including the anti/archipelago cell the old gate protected.
//
//   2. After the burst the focus phase never runs. `multi.js` only builds the
//      crown distance field when the planner hands it a `targets` list, and
//      `targets` is built from *remembered* enemy crowns. Fog vision is
//      Chebyshev radius 1 from owned land, so a crown is only remembered once
//      our land touches its neighbour: `relay/random` seed 4 (seat 0) learns
//      none in 287 ticks, `multiUpdate` returns `focus: false`, no paint penalty
//      applies, and the engine trace of that game is 2657 paint orders against
//      0 merges and 0 attacks - the empire spreads itself one unit per cell
//      while the rival concentrates, and then cannot even attack back
//      (`send <= units[j]` with a one-unit stack).
//
//      The fix is the fog single-line layer's objective: `fogBeliefTargets`
//      (the far region of the *passable* map, which stays known through the fog
//      because mountains block movement and swamp stays visible), used as the
//      focus objective with the priority remembered crowns > visible rival
//      frontier > belief anchors. It is implemented here (`route`, the
//      `fogTargets` hand-off to `multi.js`) but measured *negative* in a multi
//      room: -3 to -5 wins over the four relay cells, the same verdict the
//      single line reached for `SCOUT`/`BELIEF` (see BOT3_FOG.md). Concentrating
//      sixteen stacks into the unknown is worth less than the land and vision
//      the paint buys, because the rival's crowns stay invisible either way.
//      It therefore stays opt-in and off by default; `BOT3_FOG_MULTI_ROUTE=1`
//      turns it on.
//
// Everything is opt-in: `BOT3_FOG_MULTI=1` turns the layer on, and with the
// variable unset the planner never asks for it, so the default path stays
// byte-identical to the round-3 baseline. Measured verdicts are in
// BOT3_FOG.md.

const { fogBeliefTargets } = require('./fog');

const DEFAULT_MAX_BOARD = 800;
// The burst window `multi.js` prices; the layer only overrides its fog gate.
const BURST_START = 25;
const BURST_END = 51;
// The focus phase starts where the burst ends (the multi layer's `focusTurn`).
const DEFAULT_START_TURN = 51;
// Release the burst while we own at most 1.1x the best rival's land. Beyond
// that the land race is won and any further paint is garrison spent for nothing
// (archipelago: swamp pays no income at all). Measured on the four relay fog
// multi cells: 0.3 releases the burst in one more room and nets -1 there
// (`relay/mediterranean` 17/32 against the baseline 18/32), 0.1 is +6 wins with
// no cell below its baseline.
const DEFAULT_LAND_SLACK = 0.1;
// Two or three anchors are enough to cover the far region without flattening
// the distance field into "walk anywhere".
const DEFAULT_COUNT = 2;
const DEFAULT_RATIO = 0.7;
const DEFAULT_SPREAD = 3;

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
function fogMultiConfig(overrides = {}, env = process.env) {
  return {
    enabled: overrides.enabled ?? flag(env.BOT3_FOG_MULTI, false),
    maxBoard: overrides.maxBoard ?? number(env.BOT3_FOG_MULTI_BOARD, DEFAULT_MAX_BOARD, 1, 100000),
    // Burst gate override, read by `multi.js` through `input.fogBurst`.
    burst: overrides.burst ?? flag(env.BOT3_FOG_MULTI_BURST, true),
    // Release the burst while our land is at most `1 + landSlack` times the
    // best rival's. `landSlack = 10` releases it always.
    landSlack:
      overrides.landSlack ?? number(env.BOT3_FOG_MULTI_LAND, DEFAULT_LAND_SLACK, 0, 10),
    // Optional extra army condition (percent of the rival army, 0 = off). The
    // measured default keeps the army gate out of the way: the land race is the
    // one the burst prices.
    armyLead: overrides.armyLead ?? number(env.BOT3_FOG_MULTI_LEAD, 0, 0, 1000),
    // Focus objective while no rival crown is remembered. Measured negative in
    // a multi room (see the header), so it is off by default.
    route: overrides.route ?? flag(env.BOT3_FOG_MULTI_ROUTE, false),
    startTurn: overrides.startTurn ?? number(env.BOT3_FOG_MULTI_TURN, DEFAULT_START_TURN, 0, 5000),
    count: overrides.count ?? number(env.BOT3_FOG_MULTI_COUNT, DEFAULT_COUNT, 1, 8),
    ratio: overrides.ratio ?? number(env.BOT3_FOG_MULTI_RATIO, DEFAULT_RATIO, 0.1, 1),
    spread: overrides.spread ?? number(env.BOT3_FOG_MULTI_SPREAD, DEFAULT_SPREAD, 1, 100),
    // Prefer the visible rival frontier over the unknown region while there is
    // one: it is measured information, the belief anchors are a prior.
    front: overrides.front ?? flag(env.BOT3_FOG_MULTI_FRONT, true),
  };
}

function freshFogMulti() {
  return {
    active: false,
    source: null,
    targets: 0,
    since: -1,
    entries: 0,
    burstTicks: 0,
    released: 0,
    gated: 0,
  };
}

// Objective for the sixteen orders while no rival crown is known. The visible
// rival frontier is measured information, so it wins over the belief prior; the
// prior is `fogBeliefTargets` over the passable map (see ./fog).
function fogMultiTargets(b, input, config = fogMultiConfig()) {
  const enemies = Array.isArray(input?.enemies) ? input.enemies : [];
  if (config.front && enemies.length) {
    const picks = [];
    const cols = b.cols;
    for (const i of enemies) {
      if (picks.length >= config.count) break;
      const row = Math.floor(i / cols),
        col = i % cols;
      const tooClose = picks.some(
        (p) => Math.abs(Math.floor(p / cols) - row) + Math.abs((p % cols) - col) < config.spread,
      );
      if (tooClose) continue;
      picks.push(i);
    }
    if (picks.length) return { targets: picks, source: 'front' };
  }
  const homes = Array.isArray(input?.homes) ? input.homes : [];
  if (!homes.length) return { targets: [], source: null };
  const targets = fogBeliefTargets(b, homes, {
    scoutRatio: config.ratio,
    scoutCount: config.count,
    scoutSpread: config.spread,
  });
  return { targets, source: targets.length ? 'belief' : null };
}

// Burst verdict: release the land race while there is still land to win, and
// only while an optional measured army condition holds. `undefined` outside the
// burst window keeps `multi.js` on its own gate.
function fogMultiBurst(input, config) {
  const turn = Math.max(0, Number(input?.turn) || 0);
  if (turn < BURST_START || turn >= BURST_END) return undefined;
  const land = Math.max(0, Number(input.land) || 0);
  const enemyLand = Math.max(0, Number(input.enemyLand) || 0);
  const army = Math.max(0, Number(input.army) || 0);
  const enemyArmy = Math.max(0, Number(input.enemyArmy) || 0);
  const landRace = !enemyLand || land * 100 <= enemyLand * 100 * (1 + config.landSlack);
  const armyRace = !config.armyLead || !enemyArmy || army * 100 >= enemyArmy * config.armyLead;
  return landRace && armyRace;
}

// One call per planning tick. Returns null whenever the layer has nothing to
// say, which keeps the planner on the exact baseline path.
function fogMultiUpdate(b, input, config = fogMultiConfig()) {
  if (!config.enabled) return null;
  if (!input || input.multi !== true || input.fog !== true) return null;
  if (!(Number(input.size) <= config.maxBoard)) return null;
  const turn = Math.max(0, Number(input.turn) || 0);
  const state = (b.fogMulti ??= freshFogMulti());
  const burst = config.burst ? fogMultiBurst(input, config) : false;
  if (burst !== undefined) {
    state.burstTicks += 1;
    if (burst) state.released += 1;
    else state.gated += 1;
  }
  let targets = [];
  let source = null;
  if (config.route && turn >= config.startTurn && !(input.targets?.length)) {
    ({ targets, source } = fogMultiTargets(b, input, config));
  }
  if (burst === undefined && !targets.length) {
    state.active = false;
    state.source = null;
    state.targets = 0;
    return null;
  }
  if (targets.length && !state.active) {
    state.entries += 1;
    state.since = turn;
  }
  state.active = targets.length > 0;
  state.source = source;
  state.targets = targets.length;
  return { config, burst, targets, source, state };
}

module.exports = {
  fogMultiConfig,
  fogMultiTargets,
  fogMultiBurst,
  fogMultiUpdate,
  freshFogMulti,
  DEFAULT_MAX_BOARD,
  BURST_START,
  BURST_END,
  DEFAULT_START_TURN,
  DEFAULT_LAND_SLACK,
  DEFAULT_COUNT,
  DEFAULT_RATIO,
  DEFAULT_SPREAD,
};
