'use strict';

// Two-tick exact search in multi-line rooms (round 17).
//
// Round 14 built the parts (`./msim` is an exact one-tick model of the engine,
// `./mqueue` predicts relay's in-flight batch with a whole-board verification
// gate) and measured a one-tick search at -1.2pp: the planner already takes
// every capture it can reach, so a single tick has nothing left to price. What
// a single tick cannot see is the *trajectory*: the multi-line queue lets
// several orders feed the same cell in one tick, and a cell that is fed cannot
// fire on that tick, so arming only pays on the tick after. This module
// therefore evaluates two ticks ahead.
//
// Mechanics, all measured in ROUND17-M2PLY.md:
//
//   * tick `turn + 1`: our candidate set against relay's predicted batch;
//   * tick `turn + 2`: our rollout policy (a fixed greedy: every cell that can
//     capture, otherwise feed the frontier) against relay's batch on the
//     *simulated* board, obtained by replaying relay's planner one tick ahead;
//   * the resulting board is scored by army, land weighted by the remaining
//     growth pulses, crown count and crown safety, ring armament and isolation.
//
// The candidate supply is the part round 14 got wrong. The sixteen slots are not
// the bottleneck (our own planner runs up to `mshape` slots and relay averages
// 9.5 orders), so the search does not re-match the planner's candidates; it adds
// the order *shapes* the planner cannot propose in a multi-line room:
//
//   * `base`     - the planner's own set (the baseline);
//   * `feed`     - lateral frontier merges and multi-feed: one to three own cells
//                  push into the same ring cell, which the engine runs in seq
//                  order and which arms that cell for the tick after (the
//                  planner only proposes a merge that strictly reduces
//                  `frontDist`, and `take` allows one order per target);
//   * `fan`      - a halved second front out of a cell that is already
//                  attacking (the engine runs both orders, mshape `fan`);
//   * `react`    - the counter-capture of a cell relay is about to empty and the
//                  reinforcement of a crown relay is about to take;
//   * `trim`     - the planner's set with its weakest orders dropped and the
//                  slots refilled from the candidates they were blocking
//                  (measured negative, off);
//   * `retain`   - a capture re-issued as a halved push so the source can fire
//                  again on the next tick (measured neutral, off).
//
// Adoption is by measured margin only, and the adopted set is emitted verbatim
// (it is a legal, leftover-free batch: no order's source is another order's
// target), never through the planner's greedy matching loop, which cannot
// express a duplicate target.
//
// Round 18 adds a **third tick** and a **compounding value** (switch
// `BOT3_M3PLY`, off by default; `BOT3_M2PLY` keeps the round-17 two-tick shape
// byte for byte). The two-tick search stalled for two documented reasons:
//
//   * land was priced linearly (`min(5, 1 + pulsesLeft)`), while land is an
//     income process -- every plain pays +1 on each 50-tick mark, forever, and
//     the army that buys more land. A two-tick horizon can only see the tick
//     that arms, not the capture it enables, so it cannot price a sacrifice
//     that buys a compound lead;
//   * the supply only fed the current tick's matching (one target per set).
//
// With `plies = 3` the terminal board is `turn + 3`: our candidate set at
// tick + 1, relay's batch at tick + 2 predicted from *that candidate's own*
// board, our rollout at tick + 2, relay's batch at tick + 3 predicted again,
// our rollout at tick + 3, then the value. Land is priced as the remaining
// income stream (`exchange * sum(decay^k)`) plus a `cheap`/`width` pair that
// prices the ring we can arm next tick. The supply grows the split/stage
// families that arm two ring cells at once.
//
// Gate: multi-line, clear rooms, `BOT3_M2PLY=1` or `BOT3_M3PLY=1`, the relay
// predictor armed, and no maze lane discipline (its guard lives inside the
// planner's take loop, so an adopted set would bypass it).

const msim = require('./msim');
const { predictAhead } = require('./mqueue');

function flag(raw, fallback = false) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'off';
}

function number(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

// Defaults: a value in army units. `land` is worth up to `landCap` army early
// (a cell pays one army on each remaining growth pulse) and one army late;
// `ring` prices a frontier cell that can fire this tick over the same army in
// the interior; `guard` prices a crown that is one push away from falling.
const DEFAULTS = {
  margin: 2,
  sims: 12,
  plies: 2,
  feeds: 3,
  // The trim family (drop the planner's weakest orders, refill the slots) is a
  // measured negative: on 256 clear multi games it costs 6 wins against the rest
  // of the layer, so it is off by default and kept for reproduction.
  keep: 0,
  land: 1,
  landCap: 5,
  horizon: 250,
  crown: 120,
  ring: 1.5,
  mass: 0.5,
  cut: 0.5,
  guard: 0.5,
  feedNeed: 4,
  // Measured neutral on 128 clear multi games (77/128 against 78/128 with the
  // shape off), so the mode-1 capture candidate ships disabled.
  retain: 0,
  fan: 1,
  // Round-18 compounding evaluation (active when `plies >= 3`).
  exchange: 1.5,
  decay: 0.95,
  width: 0.3,
  cheap: 0.5,
  reach: 2,
  split: 2,
  stage: 2,
  minFeed: 2,
};

function configOf(overrides = {}, env = process.env) {
  const three = overrides.three ?? flag(env.BOT3_M3PLY, true);
  const plies = overrides.plies ?? number(env.BOT3_M3PLY_PLIES, three ? 3 : DEFAULTS.plies, 2, 3);
  // The round-18 evaluation and supply follow the horizon, so an explicit
  // `plies: 3` is the same layer as `BOT3_M3PLY=1`.
  const compound = three || plies >= 3;
  return {
    enabled: overrides.enabled ?? (flag(env.BOT3_M2PLY, false) || three),
    // `plies` is the whole horizon: 2 is the round-17 search, 3 adds the tick
    // where the armed ring cell actually fires. The compounding value and the
    // split/stage supply are tied to it so `BOT3_M2PLY=1` alone stays the
    // round-17 layer.
    plies,
    margin: overrides.margin ?? number(env.BOT3_M2PLY_MARGIN, DEFAULTS.margin, 0, 100000),
    sims: overrides.sims ?? number(env.BOT3_M2PLY_SIMS, DEFAULTS.sims, 1, 64),
    feeds: overrides.feeds ?? number(env.BOT3_M2PLY_FEEDS, DEFAULTS.feeds, 0, 16),
    keep: overrides.keep ?? number(env.BOT3_M2PLY_KEEP, DEFAULTS.keep, 0, 16),
    land: overrides.land ?? number(env.BOT3_M2PLY_LAND, DEFAULTS.land, 0, 1000),
    landCap: overrides.landCap ?? number(env.BOT3_M2PLY_LAND_CAP, DEFAULTS.landCap, 1, 100),
    horizon: overrides.horizon ?? number(env.BOT3_M2PLY_HORIZON, DEFAULTS.horizon, 50, 5000),
    // Land as a compounding income stream: `exchange` is how many army one
    // cell's remaining pulses are worth (the measured capture arithmetic is one
    // land per `garrison` army spent, so an exchange rate below one would never
    // pay), `decay` discounts a pulse the later it arrives. `stream` off keeps
    // the round-17 linear `landWeight`.
    stream: overrides.stream ?? flag(env.BOT3_M3PLY_STREAM, compound),
    exchange: overrides.exchange ?? number(env.BOT3_M3PLY_EXCHANGE, DEFAULTS.exchange, 0, 20),
    decay: overrides.decay ?? number(env.BOT3_M3PLY_DECAY, DEFAULTS.decay, 0.01, 1),
    width: overrides.width ?? number(env.BOT3_M3PLY_WIDTH, compound ? DEFAULTS.width : 0, 0, 1000),
    cheap:
      overrides.cheap ?? number(env.BOT3_M3PLY_CHEAP, compound ? DEFAULTS.cheap : 0, 0, 1000),
    reach: overrides.reach ?? number(env.BOT3_M3PLY_REACH, DEFAULTS.reach, 1, 8),
    split: overrides.split ?? number(env.BOT3_M3PLY_SPLIT, compound ? DEFAULTS.split : 0, 0, 8),
    stage: overrides.stage ?? number(env.BOT3_M3PLY_STAGE, compound ? DEFAULTS.stage : 0, 0, 8),
    // Donor mass: a cell with two army pushes one, which is enough to arm a
    // one-army ring cell into an empty plain. The round-17 supply required three
    // (a two-army push) and found only 1.14 donors per target in the census, so
    // the third tick lowers the bar by default.
    minFeed:
      overrides.minFeed ??
      number(env.BOT3_M3PLY_MINFEED, compound ? DEFAULTS.minFeed : 3, 2, 8),
    crown: overrides.crown ?? number(env.BOT3_M2PLY_CROWN, DEFAULTS.crown, 0, 100000),
    ring: overrides.ring ?? number(env.BOT3_M2PLY_RING, DEFAULTS.ring, 0, 1000),
    mass: overrides.mass ?? number(env.BOT3_M2PLY_MASS, DEFAULTS.mass, 0, 1000),
    cut: overrides.cut ?? number(env.BOT3_M2PLY_CUT, DEFAULTS.cut, 0, 1000),
    guard: overrides.guard ?? number(env.BOT3_M2PLY_GUARD, DEFAULTS.guard, 0, 1000),
    feedNeed: overrides.feedNeed ?? number(env.BOT3_M2PLY_NEED, DEFAULTS.feedNeed, 1, 40),
    // A capture that keeps half its stack (mode 1) cannot fire again from the
    // same cell when it goes all-in, so a two-tick search can price the trade the
    // planner never sees: if the halved push still takes the cell, the source can
    // capture again on the next tick. `mhalf` measured the *rule* negative; here it
    // is one candidate per tick, adopted only when the simulation prefers it.
    retain: overrides.retain ?? number(env.BOT3_M2PLY_RETAIN, DEFAULTS.retain, 0, 8),
    fan: overrides.fan ?? number(env.BOT3_M2PLY_FAN, DEFAULTS.fan, 0, 4),
    trace: overrides.trace ?? flag(env.BOT3_M2PLY_TRACE, false),
  };
}

const statsOn = () => flag(process.env.BOT3_M2PLY_STATS, false);

const totals = {
  ticks: 0,
  sims: 0,
  sets: 0,
  adopted: 0,
  lateral: 0,
  feed: 0,
  split: 0,
  stage: 0,
  trim: 0,
  retain: 0,
  fan: 0,
  react: 0,
  gain: 0,
  aheadCalls: 0,
  plans: 0,
  sources: 0,
  ms: 0,
};

if (statsOn()) {
  process.on('exit', () => {
    if (!totals.ticks) return;
    process.stderr.write(`[m2ply] ${JSON.stringify(totals)}\n`);
  });
}

function freshStore(size) {
  return {
    size,
    start: msim.createState(size),
    mid: msim.createState(size),
    sim: msim.createState(size),
    ticks: 0,
    sims: 0,
    adopted: 0,
    gain: 0,
    ring: new Uint8Array(size),
  };
}

// The planner's own selection: greedy over the score-sorted candidate list with
// one order per source and per target, up to `slots` orders. Mirrors the take
// loop in ./planner *without* its side effects and without the maze lane guard
// (the layer stands down when that guard is active).
function collect(candidates, slots = 16, ban = null) {
  const used = new Set();
  const set = [];
  for (const op of candidates) {
    if (ban && ban.has(op)) continue;
    if (used.has(op.from) || used.has(op.to)) continue;
    used.add(op.from);
    used.add(op.to);
    set.push(op);
    if (set.length >= slots) break;
  }
  return set;
}

function asOps(set, me) {
  return set.map((op) => ({
    from: op.from,
    to: op.to,
    mode: op.mode ?? 0,
    build: op.build ?? null,
    send: op.send ?? 0,
    me,
  }));
}

// Drop duplicate edges and, more importantly, every order whose source is
// another order's target: the engine keeps such an order in the queue instead of
// executing it, and `./strategy` stops planning while anything is pending.
function sanitize(orders) {
  const seen = new Set();
  const list = [];
  for (const op of orders) {
    const key = `${op.from}>${op.to}>${op.build ? op.build : 'm'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(op);
  }
  let changed = true;
  while (changed) {
    changed = false;
    const targets = new Set();
    for (const op of list) if (!op.build) targets.add(op.to);
    for (let i = list.length - 1; i >= 0; i--) {
      if (targets.has(list[i].from)) {
        list.splice(i, 1);
        changed = true;
      }
    }
  }
  return list;
}

// A multi-line capture whose source is fully armed fires with `units - 1`.
function canCapture(units, tile, neighbors, me, i, j) {
  if (tile[j] === 201) return false;
  if (msim.ownerOf(tile[j]) === me) return false;
  return units[i] - 1 > units[j];
}

function ringCountOf(tile, teams, neighbors, myTeam, i) {
  let open = 0;
  for (const j of neighbors[i]) if (tile[j] !== 201 && teams[j] !== myTeam) open++;
  return open;
}

// Land a capture of `j` would open: neighbours that are neither walls nor ours.
function openCount(code, neighbors, me, j) {
  let open = 0;
  for (const k of neighbors[j]) if (code[k] !== 201 && msim.ownerOf(code[k]) !== me) open++;
  return open;
}

// Our frontier cells: own cells that touch a cell we do not own (the ring the
// next capture comes from).
function ringMask(tile, teams, neighbors, myTeam, store) {
  const size = tile.length;
  const ring = store && store.ring.length === size ? store.ring.fill(0) : new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    if (teams[i] !== myTeam) continue;
    for (const j of neighbors[i]) {
      if (tile[j] !== 201 && teams[j] !== myTeam) {
        ring[i] = 1;
        break;
      }
    }
  }
  return ring;
}

// Land only pays on the growth marks, so a cell is worth the number of pulses
// that are still ahead of it -- capped, because the game is decided long before
// the horizon and a cell is also simply a cell.
function landWeight(turn, config) {
  const left = Math.max(0, (config.horizon - turn) / msim.PLAIN_GROWTH_INTERVAL);
  return config.land * Math.min(config.landCap, 1 + left);
}

// The remaining income stream of one cell: every plain pays +1 army on each
// 50-tick mark for the rest of the game, and that army buys more land, so a cell
// is worth the discounted sum of its remaining pulses rather than one pulse.
// `exchange` is the land/army exchange rate; the floor of one army keeps a cell
// a cell after the horizon.
function streamWeight(turn, config) {
  const left = Math.max(0, Math.floor((config.horizon - turn) / msim.PLAIN_GROWTH_INTERVAL));
  const pulses = Math.min(config.landCap, left);
  let sum = 0,
    factor = 1;
  for (let k = 1; k <= pulses; k++) {
    factor *= config.decay;
    sum += factor;
  }
  return config.land * Math.max(1, config.exchange * sum);
}

function landValue(turn, config) {
  return config.stream ? streamWeight(turn, config) : landWeight(turn, config);
}

// Value of a simulated board in army units.
function value(st, ctx, me, foe, turn, config) {
  const { size, code, army, iso } = st;
  let myArmy = 0,
    foeArmy = 0,
    myLand = 0,
    foeLand = 0,
    myReady = 0,
    foeReady = 0,
    myRing = 0,
    foeRing = 0,
    myCheap = 0,
    foeCheap = 0,
    myMass = 0,
    foeMass = 0,
    myIso = 0,
    foeIso = 0,
    myCrowns = 0,
    foeCrowns = 0;
  const myCrownCells = [],
    foeCrownCells = [];
  const reach = config.reach;
  const cheapOn = config.cheap > 0;
  for (let i = 0; i < size; i++) {
    const owner = msim.ownerOf(code[i]);
    if (!owner) continue;
    if (owner !== me && owner !== foe) continue;
    const mine = owner === me;
    const mass = army[i];
    if (mine) {
      myArmy += mass;
      myLand += 1;
    } else {
      foeArmy += mass;
      foeLand += 1;
    }
    if (msim.isCrown(code[i])) {
      if (mine) {
        myCrowns += 1;
        myCrownCells.push(i);
      } else {
        foeCrowns += 1;
        foeCrownCells.push(i);
      }
    }
    if (iso[i]) {
      if (mine) myIso += mass;
      else foeIso += mass;
      continue;
    }
    let ring = false;
    // Cheapest gap to a capture next tick: `mass + feed - 1 > garrison`. A gap
    // of one means a single army from a neighbour arms this cell on the tick
    // after, which is the shape the planner never prices.
    let gap = Infinity;
    for (const j of ctx.neighbors[i]) {
      const other = msim.ownerOf(code[j]);
      if (other !== owner) {
        ring = true;
        if (cheapOn && code[j] !== 201) {
          const need = army[j] + 2 - mass;
          if (need < gap) gap = need;
        }
      }
    }
    if (!ring) continue;
    if (mine) myRing += 1;
    else foeRing += 1;
    // A ring cell can only fire with two army (`push = army - 1` must beat the
    // garrison), so armament counts cells that are actually able to act.
    if (mine) {
      if (mass >= 2) myReady += 1;
      if (cheapOn && mass >= 2 && gap >= 1 && gap <= reach) myCheap += 1;
      myMass += Math.min(6, Math.max(0, mass - 1));
    } else {
      if (mass >= 2) foeReady += 1;
      if (cheapOn && mass >= 2 && gap >= 1 && gap <= reach) foeCheap += 1;
      foeMass += Math.min(6, Math.max(0, mass - 1));
    }
  }
  if (foeCrowns === 0) return 1e7;
  if (myCrowns === 0) return -1e7;
  // Crown safety: a crown that is one push short of its strongest neighbour is
  // the loss mode most of these games actually end with.
  let safety = 0;
  for (const i of myCrownCells) {
    let threat = 0;
    for (const j of ctx.neighbors[i])
      if (msim.ownerOf(code[j]) === foe && !iso[j]) threat = Math.max(threat, army[j] - 1);
    safety -= Math.max(0, threat - army[i]);
  }
  for (const i of foeCrownCells) {
    let threat = 0;
    for (const j of ctx.neighbors[i])
      if (msim.ownerOf(code[j]) === me && !iso[j]) threat = Math.max(threat, army[j] - 1);
    safety += Math.max(0, threat - army[i]);
  }
  return (
    myArmy -
    foeArmy +
    landValue(turn, config) * (myLand - foeLand) +
    config.crown * (myCrowns - foeCrowns) +
    config.ring * (myReady - foeReady) +
    (config.width ?? 0) * (myRing - foeRing) +
    (config.cheap ?? 0) * (myCheap - foeCheap) +
    config.mass * (myMass - foeMass) +
    config.cut * (foeIso - myIso) +
    config.guard * safety
  );
}

// The rollout policy for tick + 2: every cell that can capture does (best target
// first, one order per source and target), then every spare cell feeds an
// adjacent frontier cell that is not armed yet. It is deliberately identical for
// the baseline and for every candidate, so the comparison prices the two-tick
// trajectory and not the rollout.
function rollout(st, ctx, me, config) {
  const { size, code, army, iso } = st;
  const captures = [];
  for (let i = 0; i < size; i++) {
    if (msim.ownerOf(code[i]) !== me || iso[i]) continue;
    const total = army[i];
    if (total < 3) continue;
    const push = total - 1;
    let best = -1,
      bestScore = 0;
    for (const j of ctx.neighbors[i]) {
      if (code[j] === 201 || msim.ownerOf(code[j]) === me) continue;
      if (push <= army[j]) continue;
      let score = 10 + (msim.isCrown(code[j]) ? 400 : msim.isCity(code[j]) ? 40 : 0);
      if (msim.ownerOf(code[j]) > 0) score += 20;
      score += 1.5 * openCount(code, ctx.neighbors, me, j);
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
    }
    if (best >= 0) captures.push({ from: i, to: best, score: bestScore });
  }
  captures.sort((a, c) => c.score - a.score);
  const usedFrom = new Set(),
    usedTo = new Set(),
    out = [];
  for (const op of captures) {
    if (usedFrom.has(op.from) || usedTo.has(op.to)) continue;
    usedFrom.add(op.from);
    usedTo.add(op.to);
    out.push({ from: op.from, to: op.to, mode: 2, build: null, send: 0, me });
    if (out.length >= 32) return out;
  }
  for (let i = 0; i < size; i++) {
    if (usedFrom.has(i)) continue;
    if (msim.ownerOf(code[i]) !== me || iso[i] || army[i] < 3) continue;
    let best = -1,
      bestScore = -1;
    for (const j of ctx.neighbors[i]) {
      if (msim.ownerOf(code[j]) !== me || iso[j] || usedTo.has(j)) continue;
      if (army[j] >= 4) continue;
      let ring = false;
      for (const k of ctx.neighbors[j]) {
        if (code[k] !== 201 && msim.ownerOf(code[k]) !== me) {
          ring = true;
          break;
        }
      }
      if (!ring) continue;
      const score = 10 - army[j] * 2;
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
    }
    if (best >= 0) {
      usedFrom.add(i);
      usedTo.add(best);
      out.push({ from: i, to: best, mode: 2, build: null, send: 0, me });
    }
  }
  if (config && config.fan) {
    // A second, halved front out of a cell that already attacked: the engine
    // runs both orders on the same tick because neither source is a target.
    for (const op of captures) {
      if (out.length >= 40) break;
      if (op.mode !== 2) continue;
      const from = op.from;
      if (army[from] < 6) continue;
      let extra = -1;
      for (const j of ctx.neighbors[from]) {
        if (j === op.to || code[j] === 201 || msim.ownerOf(code[j]) === me) continue;
        if (usedTo.has(j)) continue;
        extra = j;
        break;
      }
      if (extra < 0) continue;
      usedTo.add(extra);
      out.push({ from, to: extra, mode: 1, build: null, send: 0, me });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Candidate supply
// ---------------------------------------------------------------------------

// Frontier merges and multi-feed. For every ring cell that cannot take a nearby
// target this tick, feed it from one to three own neighbours. The engine keeps
// the fed cell's own order for the tick after (its source is a target), which is
// exactly the two-tick pattern a one-tick search cannot price.
function feedPlans({ b, units, teams, myTeam, ring, config }) {
  const size = b.size,
    tile = b.grid_type,
    neighbors = b.neighbors,
    me = b.me;
  const plans = [];
  for (let t = 0; t < size; t++) {
    if (teams[t] !== myTeam || b.isolated[t] || !ring[t]) continue;
    const total = Math.max(0, units[t]);
    if (total < 1) continue;
    // Only a cell that cannot take anything this tick is a feed target: if it
    // can capture, that capture is already in the planner's set and feeding the
    // cell only postpones it.
    let busy = false;
    for (const j of neighbors[t]) {
      if (tile[j] === 201 || teams[j] === myTeam) continue;
      if (total - 1 > units[j]) {
        busy = true;
        break;
      }
    }
    if (busy) continue;
    let promise = 0,
      need = Infinity;
    for (const j of neighbors[t]) {
      if (tile[j] === 201 || teams[j] === myTeam) continue;
      const gap = units[j] + 2 - total;
      if (gap > config.feedNeed) continue;
      const worth =
        (msim.isCrown(tile[j]) ? 8 : msim.isCity(tile[j]) ? 3 : 1) + 0.4 * openCount(tile, neighbors, me, j);
      if (gap < need || (gap === need && worth > promise)) {
        need = gap;
        promise = worth;
      }
    }
    if (!(need < Infinity) || promise <= 0) continue;
    const sources = [];
    for (const s of neighbors[t]) {
      if (teams[s] !== myTeam || b.isolated[s] || s === t) continue;
      const mass = Math.max(0, units[s]);
      if (mass < config.minFeed) continue;
      // Prefer cells that cannot capture anything this tick: spending them on a
      // feed costs no capture.
      let captures = 0;
      for (const k of neighbors[s]) if (canCapture(units, tile, neighbors, me, s, k)) captures += 1;
      sources.push({ cell: s, mass, captures });
    }
    if (!sources.length) continue;
    sources.sort((a, c) => a.captures - c.captures || c.mass - a.mass);
    plans.push({ target: t, need, promise, sources });
  }
  plans.sort((a, c) => a.need - c.need || c.promise - a.promise);
  return plans;
}

function feedSets({ b, base, units, teams, myTeam, ring, config }) {
  const out = [];
  // A three-tick horizon also wants the split/stage families inside the same
  // simulation budget, so the feed family contributes two sets per plan there
  // (one source, two sources) instead of three.
  const perPlan = config.plies >= 3 ? 2 : 3;
  for (const plan of feedPlans({ b, units, teams, myTeam, ring, config }).slice(0, config.feeds)) {
    for (let count = 1; count <= perPlan && count <= plan.sources.length; count++) {
      const sources = plan.sources.slice(0, count).map((s) => s.cell);
      const drop = new Set([plan.target, ...sources]);
      // Keep every planner order that neither uses the fed cell as a source (it
      // cannot fire this tick) nor one of the feeding cells.
      const set = base.filter((op) => !drop.has(op.from));
      for (const s of sources)
        set.push({
          from: s,
          to: plan.target,
          mode: 2,
          build: null,
          send: Math.max(1, units[s] - 1),
          score: 0,
        });
      out.push({ kind: count > 1 ? 'feed' : 'lateral', set: sanitize(set) });
      if (out.length >= config.sims) break;
    }
    if (out.length >= config.sims) break;
  }
  return out;
}

// Two (or more) ring cells armed on the same tick. The round-17 supply feeds one
// cell per set, so it can never express "spend this tick on two fronts"; with a
// three-tick horizon both cells fire on tick + 2 and the income compounds from
// there, which is the shape the two-tick search could not price.
function splitSets({ plans, base, units, config }) {
  const limit = config.split;
  if (limit < 2) return [];
  const out = [];
  const targets = [],
    sources = [],
    used = new Set();
  for (const plan of plans) {
    if (targets.length >= limit) break;
    if (used.has(plan.target)) continue;
    const pick = plan.sources.filter(
      (s) => s.captures === 0 && !used.has(s.cell) && s.cell !== plan.target,
    );
    if (!pick.length) continue;
    used.add(plan.target);
    used.add(pick[0].cell);
    targets.push(plan.target);
    sources.push(pick[0].cell);
    if (targets.length < 2) continue;
    const set = base.filter((op) => !used.has(op.from));
    for (let k = 0; k < targets.length; k++)
      set.push({
        from: sources[k],
        to: targets[k],
        mode: 2,
        build: null,
        send: Math.max(1, units[sources[k]] - 1),
        score: 0,
      });
    out.push({ kind: 'split', set: sanitize(set) });
  }
  return out;
}

// Staging: spend this tick to arm two ring cells *deeply* (two feeders each), so
// both capture on tick + 2 and the pair of new cells pays for the rest of the
// game. Only sources that cannot capture this tick are spent, so the family can
// never trade a capture for an arming move (that is the `trim` mistake).
function stageSets({ plans, base, units, config }) {
  const limit = config.stage;
  if (!limit) return [];
  const out = [];
  const targets = [],
    feeders = [],
    used = new Set();
  for (const plan of plans) {
    if (targets.length >= limit) break;
    if (used.has(plan.target)) continue;
    const pick = plan.sources
      .filter((s) => s.captures === 0 && !used.has(s.cell) && s.cell !== plan.target)
      .slice(0, 2)
      .map((s) => s.cell);
    if (!pick.length) continue;
    used.add(plan.target);
    for (const cell of pick) used.add(cell);
    targets.push(plan.target);
    feeders.push(pick);
    if (targets.length < 2) continue;
    const set = base.filter((op) => !used.has(op.from));
    for (let k = 0; k < targets.length; k++)
      for (const from of feeders[k])
        set.push({
          from,
          to: targets[k],
          mode: 2,
          build: null,
          send: Math.max(1, units[from] - 1),
          score: 0,
        });
    out.push({ kind: 'stage', set: sanitize(set) });
  }
  return out;
}

// Drop the planner's weakest orders and refill the slots from the candidates
// they were blocking (the take loop is a matching, so a dropped order can free a
// source *and* a target for two better ones).
function trimSets({ candidates, base, slots, config }) {
  const out = [];
  for (let k = 1; k <= config.keep && k <= base.length; k++) {
    const ban = new Set(base.slice(base.length - k));
    const set = collect(candidates, slots, ban);
    if (set.length) out.push({ kind: 'trim', set });
  }
  return out;
}

// The planner's set with captur(e|es) re-issued as a halved push, so the source
// keeps enough army to fire again on the next tick.
function retainSets({ base, units, config }) {
  if (!config.retain) return [];
  const out = [];
  for (const op of base) {
    if (out.length >= config.retain) break;
    if (op.build || op.mode !== 2) continue;
    if (Math.max(0, units[op.from]) < 5) continue;
    const set = base.map((other) => (other === op ? { ...other, mode: 1 } : other));
    out.push({ kind: 'retain', set });
  }
  return out;
}

// A second halved front out of a cell the planner is already attacking.
function fanSets({ b, candidates, base, units, teams, myTeam, config }) {
  if (!config.fan) return [];
  const out = [];
  for (const op of base) {
    if (out.length >= config.fan) break;
    if (op.build || op.mode !== 2) continue;
    const from = op.from;
    if (Math.max(0, units[from]) < 6) continue;
    for (const j of b.neighbors[from]) {
      if (j === op.to || b.grid_type[j] === 201 || teams[j] === myTeam) continue;
      if (base.some((other) => other.to === j)) continue;
      const set = sanitize([
        ...base,
        { from, to: j, mode: 1, build: null, send: Math.floor((units[from] - 1) / 2), score: 0 },
      ]);
      out.push({ kind: 'fan', set });
      break;
    }
  }
  return out;
}

// Two orders the planner cannot propose in a multi-line room: the
// counter-capture of a cell relay is about to empty (only when relay resolves
// first) and the reinforcement of a cell relay is about to take (only when we
// resolve first).
function reactSets({ b, pred, base, turn, teams, myTeam }) {
  const me = b.me;
  const order = turn + 1;
  // Seat 1 resolves first on even ticks, seat 2 on odd ticks.
  const relaySeatFirst = pred.relayMe === (order % 2 === 1 ? 2 : 1);
  const extras = [];
  for (const op of pred.ops ?? []) {
    if (op.build) continue;
    if (relaySeatFirst) {
      const source = op.from;
      if (msim.ownerOf(b.grid_type[source]) !== pred.relayMe) continue;
      for (const k of b.neighbors[source]) {
        if (teams[k] !== myTeam || b.isolated[k]) continue;
        if (Math.max(0, b.army_cnt[k]) < 2) continue;
        extras.push({ from: k, to: source, mode: 2, build: null, send: 0, score: 0 });
      }
    } else {
      const target = op.to;
      if (msim.ownerOf(b.grid_type[target]) !== me) continue;
      for (const k of b.neighbors[target]) {
        if (teams[k] !== myTeam || b.isolated[k]) continue;
        if (Math.max(0, b.army_cnt[k]) < 3) continue;
        extras.push({ from: k, to: target, mode: 2, build: null, send: 0, score: 0 });
      }
    }
  }
  if (!extras.length) return [];
  return [{ kind: 'react', set: sanitize([...base, ...extras.slice(0, 3)]) }];
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function twoTick(store, ctx, turn, players, me, relayMe, mine, theirs, ahead, config) {
  const queues = new Map([
    [me, mine.map((op) => ({ ...op }))],
    [relayMe, theirs.map((op) => ({ ...op }))],
  ]);
  msim.copyState(store.sim, store.start);
  msim.step(store.sim, ctx, { turn: turn + 1, multi: true, players, queues });
  const roll = rollout(store.sim, ctx, me, config);
  const second = new Map([
    [me, roll],
    [relayMe, ahead.map((op) => ({ ...op }))],
  ]);
  msim.step(store.sim, ctx, { turn: turn + 2, multi: true, players, queues: second });
  store.sims += 1;
  return value(store.sim, ctx, me, relayMe, turn + 2, config);
}

// `plies`-tick search. Every candidate replays tick + 1 from the frame board and,
// for ticks +2..+plies, predicts relay's batch on *that candidate's own* board
// (`predictAhead` replays relay's planner and restores its bookkeeping) and
// answers with the fixed rollout. The terminal board is scored once. Returns
// null when relay's response cannot be reproduced, which stands the whole layer
// down for this frame.
function threeTick(store, ctx, turn, players, me, relayMe, mine, theirs1, pred, config) {
  msim.copyState(store.sim, store.start);
  const first = new Map([
    [me, mine.map((op) => ({ ...op }))],
    [relayMe, theirs1.map((op) => ({ ...op }))],
  ]);
  msim.step(store.sim, ctx, { turn: turn + 1, multi: true, players, queues: first });
  let last = turn + 1;
  for (let k = 2; k <= config.plies; k++) {
    const ahead = predictAhead(pred, store.sim, last, players, me);
    totals.aheadCalls += 1;
    if (!ahead) return null;
    const next = new Map([
      [me, rollout(store.sim, ctx, me, config)],
      [relayMe, ahead.map((op) => ({ ...op }))],
    ]);
    msim.step(store.sim, ctx, { turn: last + 1, multi: true, players, queues: next });
    last += 1;
  }
  store.sims += 1;
  return value(store.sim, ctx, me, relayMe, last, config);
}

// Returns an order list to emit verbatim, or null to keep the planner's own set.
function choose({ b, turn, candidates, pred, slots = 16, config = configOf(), units, teams, myTeam }) {
  if (!pred || !pred.armed || !pred.ops || !candidates.length) return null;
  const me = b.me;
  const relayMe = pred.relayMe;
  if (!Number.isInteger(relayMe) || !Number.isInteger(me) || me === relayMe) return null;
  const started = performance.now();
  const ctx = b.msimCtx ?? (b.msimCtx = msim.contextOf(b));
  const store =
    b.m2plyState && b.m2plyState.size === b.size ? b.m2plyState : (b.m2plyState = freshStore(b.size));
  const players = [me, relayMe].sort((a, c) => a - c);
  msim.loadBoard(store.start, b, pred.ages ?? null);
  const base = collect(candidates, slots);
  if (!base.length) return null;
  const theirs1 = pred.ops;
  let scorer;
  if (config.plies >= 3) {
    // Each candidate needs relay's response at tick + 2, which depends on its own
    // tick + 1 board, so the prediction moves inside the scorer.
    scorer = (set) => threeTick(store, ctx, turn, players, me, relayMe, asOps(set, me), theirs1, pred, config);
  } else {
    // Tick + 1 with the planner's own set: its board is where relay's next batch
    // is predicted from, so every candidate is priced against the same response
    // (the round-17 shape).
    const midQueues = new Map([
      [me, asOps(base, me)],
      [relayMe, theirs1.map((op) => ({ ...op }))],
    ]);
    msim.copyState(store.sim, store.start);
    msim.step(store.sim, ctx, { turn: turn + 1, multi: true, players, queues: midQueues });
    msim.copyState(store.mid, store.sim);
    const ahead = predictAhead(pred, store.mid, turn + 1, players, me);
    totals.aheadCalls += 1;
    if (!ahead) return null;
    scorer = (set) => twoTick(store, ctx, turn, players, me, relayMe, asOps(set, me), theirs1, ahead, config);
  }
  const baseScore = scorer(base);
  if (baseScore === null) return null;
  const ring = ringMask(b.grid_type, teams, b.neighbors, myTeam, store);
  const plans = feedPlans({ b, units, teams, myTeam, ring, config });
  totals.plans += plans.length;
  for (const plan of plans) totals.sources += plan.sources.length;
  const supplied = [
    { kind: 'base', set: base },
    ...feedSets({ b, base, units, teams, myTeam, ring, config }),
    ...splitSets({ plans, base, units, config }),
    ...stageSets({ plans, base, units, config }),
    ...trimSets({ candidates, base, slots, config }),
    ...retainSets({ base, units, config }),
    ...fanSets({ b, candidates, base, units, teams, myTeam, config }),
    ...reactSets({ b, pred, base, turn, teams, myTeam }),
  ];
  let best = base,
    bestScore = baseScore,
    bestKind = 'base',
    sims = 1;
  const seen = new Set();
  for (const variant of supplied) {
    if (sims >= config.sims) break;
    const set = variant.set;
    if (!set.length) continue;
    const key = set
      .map((op) => `${op.from}>${op.to}:${op.mode}:${op.build ?? ''}`)
      .sort()
      .join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    sims += 1;
    const score = scorer(set);
    if (score === null) continue;
    if (score > bestScore) {
      best = set;
      bestScore = score;
      bestKind = variant.kind;
    }
  }
  store.ticks += 1;
  totals.ticks += 1;
  totals.sims += sims;
  totals.sets += supplied.length;
  totals.ms += performance.now() - started;
  if (best === base || bestScore - baseScore < config.margin) return null;
  store.adopted += 1;
  store.gain += bestScore - baseScore;
  totals.adopted += 1;
  totals.gain += bestScore - baseScore;
  if (totals[bestKind] !== undefined) totals[bestKind] += 1;
  if (config.trace)
    process.stderr.write(
      `[m2ply] turn=${turn} adopt=${bestKind} gain=${(bestScore - baseScore).toFixed(1)} ` +
        `base=${base.length} set=${best.length} sims=${sims}\n`,
    );
  return asOps(best, me);
}

module.exports = {
  configOf,
  choose,
  collect,
  sanitize,
  value,
  rollout,
  landWeight,
  streamWeight,
  landValue,
  ringMask,
  feedPlans,
  feedSets,
  splitSets,
  stageSets,
  trimSets,
  retainSets,
  fanSets,
  reactSets,
  twoTick,
  threeTick,
  freshStore,
  totals,
  DEFAULTS,
};
