'use strict';

// Self-play-tuned multi-line evaluation (round 17, `BOT3_MTUNE`).
//
// Diagnosis. Rounds 15 and 16 each moved 6-12 relay multi wins in sample and
// decayed to zero on the independent seed half. Both rounds changed one rule
// (an order cap, a hop field) and left the *relative price* of the remaining
// multi decisions alone: a neutral capture still scores 32, an outward merge
// `14 + sqrt(send) * 4`, a defence merge 560, a crown march 60-205, and the
// same numbers are used before and after a growth pulse. A single rule that
// perturbs one of those bands inside a knife-edge mirror exchange has no
// reason to survive a different map; a *re-priced* set of bands can only be
// found by measuring them together.
//
// This module is that re-pricing, and nothing else. It adds no candidate, no
// order and no new mechanic: it moves the score of candidates the planner
// already proposes, from one JSON blob, so a search can tune the whole set at
// once against the actual engine. The parameters are exactly the multi-line
// decisions the earlier rounds priced by hand:
//
//   capture  neutral capture price. Land is the only recurring income in a
//            multi room (a plain pays +1 at t=50,100,150..), so this decides
//            how much of the growth pulse becomes land instead of a banked
//            crown or an interior stack.
//   hostile  rival-cell capture price. Taking a rival cell is a two-cell land
//            swing (ours +1, theirs -1) and stops its pulse income.
//   ring     expansion shape: bonus per plain neutral neighbour the captured
//            cell keeps open, i.e. for buying a cell that can fire next tick
//            (the round-15 `ring`/`hole` idea as a weight instead of a rule).
//   cut      articulation price: taking a rival cell that is a cut vertex of
//            the rival territory halves and stops production of the severed
//            pocket (`applyConnectivity`), independent of the cell's garrison.
//   pulse    pulse timing: captures are worth more in the twenty ticks right
//            after a growth pulse, when the army that just landed is spendable
//            and the land it buys still pays at the *next* pulse.
//   merge    interior merge price: a merge whose target is behind the frontier
//            ring buys no land this tick (mshape/mhalf leave it alone).
//   lateral  lateral merge price: a frontier -> frontier merge is what the
//            inherited `frontDist` rule refuses (every frontier cell is at
//            distance 0), so this is the only way the ring can shift mass
//            sideways instead of only outward.
//   march    crown approach price: bonus for a merge that steps down the
//            rival-crown distance field (the gather before the endgame).
//   defence  defence price: additive to every candidate already scoring in the
//            defence/rescue band (>= 500), so the search can trade a defensive
//            tick against the land race instead of inheriting 560.
//   reload   ring reload price (`mhalf.reload`): arming a frontier cell that
//            holds one army and cannot fire this tick.
//   hop      hop decay (`mhalf.hop`): how much a delivery loses per hop of
//            distance behind the ring.
//   retain   rolling garrison (`mhalf.retain`): choose mode 1 (half push) per
//            capture instead of the inherited all-in, so a fork keeps mass.
//   floor    army a capture has to leave behind for `retain` to apply.
//   minFire  army a frontier cell needs before it is worth arming: the price of
//            a capture in army terms (a mode-2 push has to strictly outnumber
//            the garrison, so this is the cheapest cell that can fire).
//   cheap    prefer captures that cost no army (an empty cell) over the rest of
//            the land race.
//   water    price of a swamp capture (`mshape.water`): a swamp pays no pulse
//            income, so on the archipelago cells the land race is a different
//            game.
//   corridor gate: let the two layers run in a corridor (maze) room. `mshape`
//            and `mhalf` skip corridor boards by default because the ring is
//            one cell wide and the round-15 measurement was neutral-negative;
//            with re-priced land capture it is worth re-measuring rather than
//            assuming.
//   start    first tick the multi-line routing layer prices merges (`mhalf`).
//   end      tick the routing layer hands the game back (`0` = never).
//   slots    order cap behaviour (`mshape.slots`): the inherited 16, unlimited
//            (64) or something in between.
//   lead     state gate (`mshape.leadCap` / `mhalf.leadCap`): stand down once
//            our land already leads by this percent of the rival's (0 = off).
//   steal    merge-vs-capture demotion (`mshape.steal`): how far a plain merge
//            is pushed below the capture it would invalidate.
//
// Everything is read from `BOT3_MTUNE_JSON` (a path or an inline JSON object)
// on every planning tick; `BOT3_MTUNE` off means this module returns null and
// the planner is byte-identical to the round-16 base.

const { teamCuts, rivalTeam } = require('./multi');
const { mhalfField } = require('./mhalf');

const DEFAULT_MAX_BOARD = 800;

// The inherited numbers, spelled out. These are the *base* values the search
// starts from: the additive weights are all 0 and the five layer overrides
// repeat what `data/scratch/base-env.sh` sets (mshape slots 64 / steal 100 /
// lead 110, mhalf reload 60 / hop 6). With this blob the layer is a no-op and
// the 256-game screen must reproduce the base jsonl byte for byte.
const BASE_WEIGHTS = {
  capture: 0,
  hostile: 0,
  ring: 0,
  cut: 0,
  pulse: 0,
  merge: 0,
  lateral: 0,
  march: 0,
  defence: 0,
  reload: 60,
  hop: 6,
  retain: 0,
  floor: 2,
  minFire: 3,
  cheap: 0,
  water: 0,
  corridor: 0,
  start: 0,
  end: 0,
  slots: 64,
  lead: 110,
  steal: 100,
};

// Inclusive bounds. The search clamps here so a stray step cannot turn a score
// band inside out (a capture price below -40 would delete the land race).
const WEIGHT_BOUNDS = {
  capture: [-40, 80],
  hostile: [-40, 160],
  ring: [-8, 24],
  cut: [-4, 20],
  pulse: [-60, 120],
  merge: [-80, 120],
  lateral: [-40, 80],
  march: [-40, 120],
  defence: [-400, 400],
  reload: [0, 200],
  hop: [0, 20],
  retain: [0, 2],
  floor: [2, 8],
  minFire: [2, 8],
  cheap: [0, 60],
  water: [0, 80],
  corridor: [0, 1],
  start: [0, 150],
  end: [0, 600],
  slots: [1, 64],
  lead: [80, 200],
  steal: [0, 600],
};

const WEIGHT_KEYS = Object.keys(BASE_WEIGHTS);

// Defence/rescue/siege candidates start here; the `defence` weight is only
// meant to trade the inherited 560 band against the land race.
const DEFENCE_FLOOR = 500;
// Captures are worth the `pulse` weight right after a growth pulse and lose it
// linearly over this many ticks (a cell taken at t <= 50+k still pays at the
// next pulse only if it holds two army by then).
const PULSE_WINDOW = 20;
// Cap on the expansion-shape bonus so a wide-open capture cannot outrank a
// defence.
const RING_CAP = 4;

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

// Parse a weight blob. Unknown keys throw: the search writes these files, and a
// silently ignored typo would report a tuned cell that was never tuned.
function parseWeights(raw) {
  const weights = { ...BASE_WEIGHTS };
  if (raw === undefined || raw === null || raw === '') return weights;
  const text = typeof raw === 'string' ? raw.trim() : JSON.stringify(raw);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`BOT3_MTUNE_JSON is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('BOT3_MTUNE_JSON must be a JSON object');
  for (const [key, value] of Object.entries(parsed)) {
    if (!Object.hasOwn(BASE_WEIGHTS, key)) throw new Error(`unknown BOT3_MTUNE weight "${key}"`);
    const [min, max] = WEIGHT_BOUNDS[key];
    weights[key] = number(value, BASE_WEIGHTS[key], min, max);
  }
  return weights;
}

// Cache by content: the harness rewrites one file between runs, so the parsed
// blob is keyed on the raw text and a changed file is re-read on the next tick.
let cachedRaw = null;
let cachedWeights = BASE_WEIGHTS;
function loadWeights(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === cachedRaw) return cachedWeights;
  cachedWeights = parseWeights(text);
  cachedRaw = text;
  return cachedWeights;
}

// `BOT3_MTUNE_JSON` is either an inline JSON object or a path to one. The path
// is re-read on every planning tick so a search can rewrite the file between
// games without restarting the shard.
function readSource(raw, env) {
  const source = raw ?? env.BOT3_MTUNE_JSON;
  if (source === undefined || source === null) return null;
  const text = String(source).trim();
  if (!text) return null;
  if (text.startsWith('{')) return text;
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.resolve(text);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// Read on every call so tests and A/B runs can toggle the layer in-process.
function mtuneConfig(overrides = {}, env = process.env) {
  const enabled = overrides.enabled ?? flag(env.BOT3_MTUNE, false);
  const config = {
    enabled,
    maxBoard: overrides.maxBoard ?? number(env.BOT3_MTUNE_BOARD, DEFAULT_MAX_BOARD, 1, 100000),
    weights: overrides.weights ?? BASE_WEIGHTS,
  };
  if (!enabled) return config;
  try {
    config.weights = overrides.weights ?? loadWeights(readSource(overrides.json, env));
  } catch (error) {
    // A broken blob must not take the bot down mid-game: fall back to the base
    // numbers, which is the same policy the switch is tuned against.
    config.weights = BASE_WEIGHTS;
    config.error = error.message;
  }
  return config;
}

// The layer's view of the mshape/mhalf config. Only the five knobs the search
// owns are passed, so every other switch still comes from the environment.
function mshapeOverrides(config) {
  if (!config.enabled) return undefined;
  const { slots, lead, steal, water, corridor } = config.weights;
  return { slots, leadCap: lead, steal, water, corridor: corridor === 1 };
}

function mhalfOverrides(config) {
  if (!config.enabled) return undefined;
  const { reload, hop, lead, retain, floor, minFire, cheap, start, end, corridor } = config.weights;
  return {
    reload,
    hop,
    leadCap: lead,
    retain,
    floor,
    minFire,
    cheap,
    startTurn: start,
    endTurn: end,
    corridor: corridor === 1,
  };
}

function freshMtune() {
  return { ticks: 0 };
}

const ownerOf = (code) => (code < 200 ? code % 50 : 0);

// Plain (non-swamp) neutral neighbours of `i`: the frontier a capture keeps
// open, i.e. the cells that can fire on the next pulse.
function plainFrontier(ctx, i) {
  const { tile, teams, neighbors } = ctx;
  let open = 0;
  for (const j of neighbors[i]) {
    if (tile[j] === 201 || teams[j]) continue;
    if (tile[j] >= 150 && tile[j] !== 200) continue;
    open++;
  }
  return open;
}

// Hop distance to the nearest cell of the rival crown set, over every non-water
// cell: the direction of the endgame. Multi rooms have no `campaignRoute` (that
// field is built for the long single-line front only), so the march price needs
// its own field. Returns null without a remembered crown.
function crownField(ctx, targets) {
  const { tile, neighbors } = ctx;
  if (!Array.isArray(targets) || !targets.length) return null;
  const size = tile.length;
  const dist = new Int32Array(size).fill(-1);
  const queue = [];
  for (const i of targets) {
    if (i < 0 || i >= size || tile[i] === 201 || dist[i] === 0) continue;
    dist[i] = 0;
    queue.push(i);
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    for (const j of neighbors[i]) {
      if (tile[j] === 201 || dist[j] !== -1) continue;
      dist[j] = dist[i] + 1;
      queue.push(j);
    }
  }
  return queue.length ? dist : null;
}

// One call per planning tick. Returns null when the layer has nothing to say,
// which keeps the planner on the exact round-16 path.
function mtuneUpdate(b, input, config = mtuneConfig()) {
  if (!config.enabled) return null;
  if (!input || input.multi !== true) return null;
  if (!(Number(input.size) <= config.maxBoard)) return null;
  const turn = Math.max(0, Number(input.turn) || 0);
  const weights = config.weights;
  const state = (b.mtuneLine ??= freshMtune());
  state.ticks += 1;
  const ctx = {
    tile: input.tile,
    teams: input.teams,
    units: input.units,
    neighbors: input.neighbors,
    myTeam: input.myTeam,
  };
  const cut = weights.cut !== 0 ? teamCuts(input.b, input.teams, input.units, rivalTeam(input)) : null;
  return {
    config,
    weights,
    turn,
    state,
    crownDist: weights.march !== 0 ? crownField(ctx, input.targets) : null,
    enemyCut: cut,
    ctx,
  };
}

// Score adjustments. Everything here is additive: no candidate is created or
// removed, so the order set stays the one the planner and mshape/mhalf propose.
function applyMtune(plan, ctx, candidates) {
  const w = plan.weights;
  // The emissions of the tick after a growth pulse: 1 right at the pulse,
  // falling to 0 after PULSE_WINDOW ticks.
  const sincePulse = plan.turn % 50;
  const pulse = w.pulse ? w.pulse * Math.max(0, 1 - sincePulse / PULSE_WINDOW) : 0;
  // `mhalf` already built the hop field when its route phase is on; when it is
  // gated off (start/end/corridor) the merge prices build their own.
  const hop =
    ctx.hop ??
    (w.merge || w.lateral
      ? mhalfField(ctx.tile, ctx.teams, ctx.neighbors, ctx.myTeam).hop
      : null);
  const crown = plan.crownDist;
  const counts = { capture: 0, hostile: 0, merge: 0, lateral: 0, march: 0, defence: 0 };
  for (const op of candidates) {
    if (op.build) continue;
    const to = ctx.teams[op.to];
    if (!to) {
      if (w.capture) op.score += w.capture;
      if (w.ring) op.score += w.ring * Math.min(RING_CAP, plainFrontier(ctx, op.to));
      if (pulse) op.score += pulse;
      counts.capture += 1;
      continue;
    }
    if (to !== ctx.myTeam) {
      if (w.hostile) op.score += w.hostile;
      if (plan.enemyCut) {
        const value = plan.enemyCut[op.to];
        if (value) op.score += Math.min(600, Math.sqrt(value) * w.cut);
      }
      if (pulse) op.score += pulse;
      counts.hostile += 1;
      continue;
    }
    // Defence/rescue/siege work keeps its own band: the merge prices must never
    // re-rank a defensive tick, only trade its inherited 560 against the land
    // race through the `defence` weight.
    if (op.score >= DEFENCE_FLOOR) {
      if (w.defence) op.score += w.defence;
      counts.defence += 1;
      continue;
    }
    const from = hop ? hop[op.from] : -1;
    const at = hop ? hop[op.to] : -1;
    if (w.merge && at > 0) {
      op.score += w.merge;
      counts.merge += 1;
    }
    if (w.lateral && from === 0 && at === 0) {
      op.score += w.lateral;
      counts.lateral += 1;
    }
    const closer =
      crown && crown[op.to] >= 0 && crown[op.from] >= 0 && crown[op.to] < crown[op.from];
    if (w.march && closer) {
      op.score += w.march;
      counts.march += 1;
    }
  }
  plan.state.last = counts;
  return counts;
}

module.exports = {
  mtuneConfig,
  mtuneUpdate,
  applyMtune,
  mshapeOverrides,
  mhalfOverrides,
  parseWeights,
  loadWeights,
  plainFrontier,
  crownField,
  freshMtune,
  BASE_WEIGHTS,
  WEIGHT_BOUNDS,
  WEIGHT_KEYS,
  DEFENCE_FLOOR,
  PULSE_WINDOW,
  RING_CAP,
  DEFAULT_MAX_BOARD,
};
